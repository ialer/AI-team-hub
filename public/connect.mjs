#!/usr/bin/env node
/**
 * AI Team Hub — connector (single file, no dependencies).
 *
 * This file is SERVED BY THE HUB ITSELF, so an agent machine never needs npm,
 * a registry, or internet access beyond the hub it is joining:
 *
 *     curl -fsSL http://hub:8899/connect.mjs -o connect.mjs
 *     node connect.mjs --hub http://hub:8899 --code ABC123
 *
 * It has no imports other than Node builtins, on purpose: if it needed a
 * package, getting the package would be the hard part again.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const VERSION = '0.4.0';
const CONFIG_DIR = path.join(os.homedir(), '.ath');
const AGENT_FILE = path.join(CONFIG_DIR, 'agent.json');

/* ══════════════════════════════════════════════════════
   args / logging
   ══════════════════════════════════════════════════════ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const tty = process.stdout.isTTY;
const col = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = col(2), bold = col(1), green = col(32), red = col(31), cyan = col(36), yellow = col(33);

const log = (s) => console.log(`${dim(new Date().toISOString())} ${s}`);
const say = (s) => console.log(s);
const ok = (s) => say(`${green('✔')} ${s}`);
const bad = (s) => say(`${red('✖')} ${s}`);
const info = (s) => say(`  ${s}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════
   http
   ══════════════════════════════════════════════════════ */

async function api(base, pathname, { method = 'GET', body, headers = {}, timeoutMs = 30000 } = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(base.replace(/\/+$/, '') + pathname, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status} ${text.slice(0, 120)}`);
  return json;
}

/* ══════════════════════════════════════════════════════
   drivers — how to call the local agent
   ══════════════════════════════════════════════════════ */

function runProcess(command, args, { timeoutMs = 180000, cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Turn "--resume {sessionId}" into two argv tokens (see the hub's adapters). */
function sessionArgs(template, sessionId) {
  if (!sessionId || !template) return [];
  const fill = (s) => String(s).replace(/\{sessionId\}/g, sessionId);
  if (Array.isArray(template)) return template.map(fill);
  return fill(template).split(/\s+/).filter(Boolean);
}

const fillVars = (v, vars) => String(v).replace(/\{(text|sessionId)\}/g, (_, k) => vars[k] ?? '');

function parseNdjson(raw) {
  let text = '';
  let sessionId = '';
  let error = '';
  for (const line of String(raw || '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.type === 'session' && o.sessionId) sessionId = o.sessionId;
    if (o.type === 'final') {
      if (o.sessionId) sessionId = o.sessionId;
      if (typeof o.text === 'string') text = o.text;
      if (o.reason && o.reason.kind === 'error') error = o.reason.error && o.reason.error.message;
    }
  }
  return { text, sessionId, error };
}

const DRIVERS = {
  async 'cli-once'({ text, sessionId, config }) {
    const vars = { text, sessionId: sessionId || '' };
    const argv = (config.args || []).map((a) => fillVars(a, vars));
    argv.push(...sessionArgs(config.sessionFlag, sessionId));
    const r = await runProcess(fillVars(config.command, vars), argv, {
      timeoutMs: config.timeoutMs, cwd: config.cwd, env: config.env,
    });
    const out = r.stdout.trim();
    if (r.code !== 0 && !out) throw new Error((r.stderr || `exit ${r.code}`).trim().slice(0, 400));
    let sid = '';
    if (config.sessionPattern) {
      const m = new RegExp(config.sessionPattern).exec(`${r.stdout}\n${r.stderr}`);
      if (m) sid = m[1] || m[0];
    }
    return { text: out, sessionId: sid || sessionId || '' };
  },

  async 'cli-json'({ text, sessionId, config }) {
    const vars = { text, sessionId: sessionId || '' };
    const argv = (config.args || []).map((a) => fillVars(a, vars));
    argv.push(...sessionArgs(config.sessionFlag, sessionId));
    const r = await runProcess(fillVars(config.command, vars), argv, {
      timeoutMs: config.timeoutMs, cwd: config.cwd, env: config.env,
    });
    const p = parseNdjson(r.stdout);
    if (p.error) throw new Error(p.error.slice(0, 400));
    if (r.code !== 0 && !p.text) throw new Error((r.stderr || `exit ${r.code}`).trim().slice(0, 400));
    return { text: p.text, sessionId: p.sessionId || sessionId || '' };
  },

  async 'openai-compat'({ text, sessionId, config }) {
    const headers = { 'Content-Type': 'application/json' };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    const body = { ...(config.extraBody || {}), messages: [{ role: 'user', content: text }] };
    if (sessionId && config.sessionField) body[config.sessionField] = sessionId;
    const r = await fetch(config.url, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs || 180000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return { text: j?.choices?.[0]?.message?.content || '', sessionId: sessionId || '' };
  },

  async 'http-webhook'({ text, sessionId, config }) {
    const r = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
      body: JSON.stringify({ text, sessionId: sessionId || null }),
      signal: AbortSignal.timeout(config.timeoutMs || 180000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.text();
    try {
      const j = JSON.parse(raw);
      return { text: j.text ?? j.reply ?? raw, sessionId: j.sessionId || sessionId || '' };
    } catch { return { text: raw, sessionId: sessionId || '' }; }
  },

  async command({ text, sessionId, config }) {
    const isWin = process.platform === 'win32';
    const shell = config.shell || (isWin ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh');
    const flag = config.shellFlag || (isWin ? '/c' : '-c');
    const r = await runProcess(shell, [flag, fillVars(config.command, { text, sessionId: sessionId || '' })], {
      timeoutMs: config.timeoutMs, cwd: config.cwd, env: config.env,
    });
    if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim().slice(0, 400));
    return { text: r.stdout.trim(), sessionId: sessionId || '' };
  },
};

/* ══════════════════════════════════════════════════════
   transports
   ══════════════════════════════════════════════════════ */

async function pollLoop({ hub, id, token, onWake, stopping }) {
  const headers = { 'X-Agent-Id': id, 'X-Agent-Token': token };
  while (!stopping.value) {
    let payload;
    try {
      payload = await api(hub, `/api/agent/poll?agent=${encodeURIComponent(id)}`, { headers, timeoutMs: 90000 });
    } catch (e) {
      log(`poll error: ${e.message}`);
      await sleep(3000);
      continue;
    }
    for (const ev of payload.events || []) {
      if (stopping.value) break;
      await onWake(ev, payload.sessionId);
    }
  }
}

function wsLoop({ hub, id, token, onWake, stopping }) {
  if (typeof WebSocket !== 'function') return null;
  const url = hub.replace(/^http/, 'ws')
    + `/ws?role=agent&agent=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  let ready = false;
  const connect = () => {
    if (stopping.value) return;
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => { ready = true; log('ws connected'); });
    ws.addEventListener('message', async (e) => {
      let f;
      try { f = JSON.parse(e.data); } catch { return; }
      if (f.event !== 'wake') return;
      try { await onWake(f.data, f.data.sessionId); } catch (err) { log(`wake error: ${err.message}`); }
    });
    ws.addEventListener('close', () => {
      ready = false;
      if (stopping.value) return;
      log('ws closed, reconnecting in 3s');
      setTimeout(connect, 3000);
    });
    ws.addEventListener('error', () => { /* close follows */ });
  };
  connect();
  return { isReady: () => ready };
}

/* ══════════════════════════════════════════════════════
   main
   ══════════════════════════════════════════════════════ */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (has(args, 'version')) { say(`connect.mjs ${VERSION}`); return 0; }
  if (has(args, 'help')) {
    say(`${bold('AI Team Hub connector')}  ${dim('single file, no dependencies')}

${bold('拿到这个文件')}（由 Hub 自己提供，不需要 npm）:
  curl -fsSL ${args.hub || 'http://hub:8899'}/connect.mjs -o connect.mjs

${bold('首次接入')}（用加入码换身份并保存配置）:
  node connect.mjs --hub http://hub:8899 --code ABC123 --id my-agent --name "我的助手"

${bold('之后启动')}:
  node connect.mjs                    ${dim('# 读 ~/.ath/agent.json')}
  node connect.mjs --config ./c.json  ${dim('# 指定配置')}

${bold('常用参数')}
  --hub <url>         Hub 地址
  --code <码>         加入码（首次接入用）
  --id <id>           成员 id（默认本机 hostname）
  --name <名字>       显示名
  --role <角色>       职责说明
  --driver <name>     cli-once | cli-json | openai-compat | http-webhook | command
  --command <cmd>     本地调用命令（--args 指定参数模板，默认 {text}）
  --args "<a> {text}" 命令参数，空格分隔
  --session-flag <f>  会话恢复参数模板，如 "--resume {sessionId}"
  --once              只取一次唤醒就退出（用于测试）
  --verbose           打印每次唤醒`);
    return 0;
  }

  // Where config comes from: explicit flag, or the saved agent file.
  const file = args.config || AGENT_FILE;
  let cfg = null;
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      bad(`${file} 无法解析：${e.message}`);
      return 1;
    }
  }

  const hub = (args.hub || (cfg && cfg.hub) || '').replace(/\/+$/, '');
  if (!hub) {
    bad('缺少 Hub 地址。用 --hub http://host:port 指定');
    return 2;
  }

  let token = args.token || (cfg && cfg.token) || '';
  let id = args.id || (cfg && cfg.id) || '';

  /* ── first contact: trade the code for a token ── */
  if (args.code) {
    const wantId = String(args.id || id || (os.hostname() || 'agent'))
      .toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
    let joined;
    try {
      joined = await api(hub, '/api/join', {
        method: 'POST',
        body: { code: args.code, id: wantId, name: args.name || wantId, role: args.role || '' },
      });
    } catch (e) {
      bad(`加入失败：${e.message}`);
      return 1;
    }
    token = joined.token;
    id = joined.agent.id;
    ok(`已加入：${bold(joined.agent.name)} ${dim(`(${id})`)}`);

    const saved = {
      hub,
      id,
      token,
      driver: args.driver || (cfg && cfg.driver) || 'cli-once',
      config: has(args, 'command')
        ? {
          command: args.command,
          args: args.args ? String(args.args).split(' ').filter(Boolean) : ['{text}'],
          ...(args['session-flag'] ? { sessionFlag: args['session-flag'] } : {}),
        }
      : (cfg && cfg.config) || { command: 'echo', args: ['{text}'] },
    };
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(AGENT_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
    ok(`配置已写入 ${AGENT_FILE} ${dim('(600)')}`);
    cfg = saved;
    say('');
  }

  if (!token || !id) {
    bad('没有身份。首次接入请带 --code，或用 --token 指定');
    info(`加入码在 Hub 上生成：node bin/ath.mjs invite`);
    return 2;
  }

  const driverName = args.driver || (cfg && cfg.driver) || 'cli-once';
  const driverConfig = (cfg && cfg.config) || {};
  const driver = DRIVERS[driverName];
  if (!driver) {
    bad(`未知 driver：${driverName}`);
    info(`可选：${Object.keys(DRIVERS).join(', ')}`);
    return 2;
  }

  /* ── announce presence ── */
  let sessionId = '';
  try {
    const hello = await api(hub, '/api/agent/hello', {
      method: 'POST',
      headers: { 'X-Agent-Id': id, 'X-Agent-Token': token },
      body: {},
    });
    sessionId = hello.sessionId || '';
  } catch (e) {
    bad(`握手失败：${e.message}`);
    return 1;
  }
  log(`connector up — agent=${id} driver=${driverName} hub=${hub}`);

  const stopping = { value: false };
  const stop = () => { stopping.value = true; log('stopping…'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const onWake = async (ev, hintSession) => {
    const started = Date.now();
    log(`wake #${ev.msgId} from ${ev.from}: ${String(ev.text || '').slice(0, 60)}`);
    const useSession = ev.sessionId || hintSession || sessionId;
    try {
      const r = await driver({ text: ev.text, sessionId: useSession, config: driverConfig });
      if (r.sessionId) sessionId = r.sessionId;
      await api(hub, '/api/agent/reply', {
        method: 'POST',
        headers: { 'X-Agent-Id': id, 'X-Agent-Token': token },
        body: { msgId: ev.msgId, text: r.text, sessionId },
      });
      log(`reply #${ev.msgId} (${String(r.text || '').length} chars, ${Date.now() - started}ms)`);
    } catch (e) {
      log(`driver error on #${ev.msgId}: ${e.message}`);
      await api(hub, '/api/agent/reply', {
        method: 'POST',
        headers: { 'X-Agent-Id': id, 'X-Agent-Token': token },
        body: { msgId: ev.msgId, text: `⚠️ 处理失败：${String(e.message).slice(0, 300)}`, sessionId },
      }).catch(() => {});
    }
  };

  if (args.once) {
    const p = await api(hub, `/api/agent/poll?agent=${encodeURIComponent(id)}&timeout=10`, {
      headers: { 'X-Agent-Id': id, 'X-Agent-Token': token },
    });
    for (const ev of p.events || []) await onWake(ev, p.sessionId);
    ok('--once 完成');
    return 0;
  }

  const ws = wsLoop({ hub, id, token, onWake, stopping });
  if (ws) {
    log('transport: websocket (falls back to polling if the socket fails)');
    // Give the socket a moment; if it never opens, poll instead.
    await sleep(1500);
    if (!ws.isReady()) {
      log('ws unavailable, using long-poll');
      await pollLoop({ hub, id, token, onWake, stopping });
    } else {
      await new Promise((resolve) => {
        const t = setInterval(() => { if (stopping.value) { clearInterval(t); resolve(); } }, 300);
        t.unref?.();
      });
    }
  } else {
    log('transport: long-poll');
    await pollLoop({ hub, id, token, onWake, stopping });
  }

  log('connector stopped');
  return 0;
}

main().then((code) => { process.exitCode = code || 0; }).catch((e) => {
  console.error(red(`fatal: ${e.stack || e.message}`));
  process.exitCode = 1;
});
