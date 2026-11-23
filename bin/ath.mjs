#!/usr/bin/env node
/**
 * ath — AI-team-hub CLI.
 *
 * The point of this file: onboarding an agent should be one command, not a
 * config edit plus a hub restart.
 *
 *   ath invite                      mint a join code (on the hub machine)
 *   ath join <url> --code ABC123    join from the agent's machine
 *   ath up                          run the hub
 *   ath connect                     run this machine's connector
 *   ath doctor                      check connectivity and config
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = path.join(os.homedir(), '.ath');
const AGENT_FILE = path.join(CONFIG_DIR, 'agent.json');

/* ══════════════════════════════════════════════════════
   tiny arg parser — no dependency
   ══════════════════════════════════════════════════════ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* ══════════════════════════════════════════════════════
   colour (no chalk)
   ══════════════════════════════════════════════════════ */

const tty = process.stdout.isTTY;
const c = {
  dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s) => (tty ? `\x1b[36m${s}\x1b[0m` : s),
  yellow: (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
};

const ok = (s) => console.log(`${c.green('✔')} ${s}`);
const bad = (s) => console.log(`${c.red('✖')} ${s}`);
const info = (s) => console.log(`  ${s}`);

/* ══════════════════════════════════════════════════════
   http helper
   ══════════════════════════════════════════════════════ */

async function api(base, pathname, { method = 'GET', body, token, admin, timeoutMs = 15000 } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Agent-Token'] = token;
  if (admin) headers['X-Admin-Token'] = admin;
  const res = await fetch(base.replace(/\/+$/, '') + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status} ${text.slice(0, 120)}`);
  return json;
}

/**
 * Work out which hub to talk to.
 *
 * Order matters: an explicit flag beats the environment, the environment beats
 * a saved agent config, and a saved config beats guessing. The last resort is
 * the hub's own config.json — on the hub machine the hub often binds a specific
 * address (not 127.0.0.1), so "localhost" would fail for no visible reason.
 */
function resolveHub(explicit) {
  if (explicit) return explicit;
  if (process.env.ATH_HUB) return process.env.ATH_HUB;

  try {
    const cfg = JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8'));
    if (cfg.hub) return cfg.hub;
  } catch { /* no saved agent on this machine */ }

  try {
    const hubCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const host = hubCfg.host && hubCfg.host !== '0.0.0.0' ? hubCfg.host : '127.0.0.1';
    const port = hubCfg.port || 8899;
    return `http://${host}:${port}`;
  } catch { /* not the hub machine */ }

  return 'http://127.0.0.1:8899';
}
/* ══════════════════════════════════════════════════════
   commands
   ══════════════════════════════════════════════════════ */

async function cmdInvite(args) {
  const hub = resolveHub(args.hub);
  const admin =
    args.admin ||
    process.env.ATH_ADMIN_TOKEN ||
    readEnvToken(path.join(ROOT, '.env'), 'HUB_ADMIN_TOKEN') ||
    readEnvToken(path.join(process.cwd(), '.env'), 'HUB_ADMIN_TOKEN');

  if (!admin) {
    bad('需要管理员 token');
    info('来源：--admin <token> / 环境变量 ATH_ADMIN_TOKEN / 当前目录或安装目录的 .env');
    process.exit(2);
  }

  try {
    const r = await api(hub, '/api/admin/invites', {
      method: 'POST',
      admin,
      body: {
        ttlSec: args.ttl ? Number(args.ttl) * 60 : undefined,
        uses: args.uses ? Number(args.uses) : undefined,
        note: args.note,
      },
    });
    ok(`加入码已生成：${c.bold(c.cyan(r.invite.code))}`);
    info(c.dim(`有效期 ${Math.round((r.invite.expiresAt - Date.now()) / 60000)} 分钟 · 可用 ${r.invite.maxUses} 次`));
    console.log('');
    console.log(c.dim('在新 agent 的机器上执行：'));
    console.log(`  ${c.bold(r.command)}`);
    return 0;
  } catch (e) {
    bad(`生成失败：${e.message}`);
    return 1;
  }
}

async function cmdJoin(args) {
  const positional = args._.slice(1);
  const hub = positional[0] || args.hub;
  if (!hub) {
    bad('缺少 Hub 地址');
    info('用法：ath join <hub-url> --code <加入码> [--id <id>] [--name <名字>] [--role <角色>]');
    return 2;
  }

  const code = args.code || process.env.ATH_JOIN_CODE;
  if (!code) {
    bad('缺少加入码');
    info('向 Hub 管理员要一个：ath invite');
    return 2;
  }

  // Default the id to this machine's hostname: an agent usually lives on one box.
  const defaultId = (args.id || os.hostname() || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, 32);

  const body = {
    code,
    id: args.id || defaultId,
    name: args.name || defaultId,
    role: args.role || '',
  };

  let result;
  try {
    result = await api(hub, '/api/join', { method: 'POST', body });
  } catch (e) {
    bad(`加入失败：${e.message}`);
    return 1;
  }

  ok(`已加入：${c.bold(result.agent.name)} (${result.agent.id})`);
  info(c.dim(`Hub: ${result.hub}`));

  // Persist the agent config where `ath connect` will find it.
  const cfg = {
    hub: result.hub,
    id: result.agent.id,
    token: result.token,
    driver: args.driver || 'cli-json',
    config: buildDriverConfig(args),
  };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(AGENT_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  ok(`配置已写入 ${AGENT_FILE} ${c.dim('(权限 600)')}`);

  console.log('');
  console.log(c.dim('要让这个 agent 能被唤醒，还需要告诉 connector 怎么调用它：'));
  console.log(`  ${c.dim('编辑')} ${AGENT_FILE} ${c.dim('里的 config.command / config.args')}`);
  console.log('');
  console.log(c.dim('然后启动连接：'));
  console.log(`  ${c.bold('ath connect')}`);
  console.log('');

  if (args.connect) return runConnect(AGENT_FILE);
  return 0;
}

/** Only fill what the operator actually passed; never invent a command. */
function buildDriverConfig(args) {
  if (args.command) {
    const out = { command: args.command };
    if (args.args) out.args = String(args.args).split('space');
    else out.args = ['{text}'];
    if (args.sessionFlag) out.sessionFlag = args.sessionFlag;
    return out;
  }
  return { command: 'echo', args: ['{text}'], timeoutMs: 30000 };
}

async function cmdConnect(args) {
  const file = args.config || (has(args, 'file') ? args.file : null) || AGENT_FILE;
  if (!fs.existsSync(file)) {
    bad(`找不到配置：${file}`);
    info('先加入：ath join <hub-url> --code <加入码>');
    return 2;
  }
  return runConnect(file, args);
}

async function runConnect(file, args = {}) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const connector = path.join(ROOT, 'connectors', 'connector.mjs');
  if (!fs.existsSync(connector)) {
    bad(`找不到 connector：${connector}`);
    info('ath 需要在完整的仓库目录里运行（git clone 后再用）');
    return 2;
  }
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [connector, '--config', file, '--verbose'], {
    stdio: 'inherit',
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    const stop = () => child.kill('SIGTERM');
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

async function cmdUp(args) {
  const entry = path.join(ROOT, 'server', 'index.mjs');
  if (!fs.existsSync(entry)) {
    bad(`找不到 server/index.mjs（当前目录 ${ROOT}）`);
    return 2;
  }

  // First run from npm has no config.json — the package ships an example, but a
  // fresh `npx ath up` in an empty directory should just work. Seed one and say
  // what needs changing, rather than starting with no admin token and failing
  // later at invite time.
  const cfgPath = path.join(ROOT, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    const example = path.join(ROOT, 'config.example.json');
    const admin = crypto.randomBytes(32).toString('base64url');
    if (fs.existsSync(example)) {
      const cfg = JSON.parse(fs.readFileSync(example, 'utf8'));
      cfg.adminToken = admin;
      cfg.agents = [];
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      ok(`已生成 config.json ${c.dim('(随机 adminToken)')}`);
      info(c.dim(`管理员 token：${admin}`));
      info(c.dim('把 agent 加进 agents[]，或直接用 `ath invite` 让它们自己加入'));
    } else {
      bad('既没有 config.json 也没有 config.example.json');
      return 2;
    }
    // Make the token available to `ath invite` in this same shell session.
    process.env.ATH_ADMIN_TOKEN = process.env.ATH_ADMIN_TOKEN || admin;
  }

  if (args.port) process.env.HUB_PORT = String(args.port);
  if (args.host) process.env.HUB_HOST = String(args.host);

  console.log('');
  ok('启动 Hub…');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [entry], { stdio: 'inherit' });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    const stop = () => child.kill('SIGTERM');
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

async function cmdTokens(args) {
  const mod = await import(path.join(ROOT, 'server', 'tokens.mjs')).catch(() => null);
  if (!mod) {
    bad('找不到 server/tokens.mjs');
    return 2;
  }
  // tokens.mjs runs on import; nothing more to do here.
  return 0;
}

async function cmdRemove(args) {
  const id = args._[1] || args.id;
  if (!id) { bad('用法：ath rm <agent-id>'); return 2; }
  const hub = resolveHub(args.hub);
  const admin = args.admin || process.env.ATH_ADMIN_TOKEN || readEnvToken(path.join(ROOT, '.env'), 'HUB_ADMIN_TOKEN');
  if (!admin) { bad('需要管理员 token（--admin 或 ATH_ADMIN_TOKEN）'); return 2; }
  try {
    await api(hub, '/api/admin/agents/' + encodeURIComponent(id), { method: 'DELETE', admin });
    ok('已移除 ' + id);
    return 0;
  } catch (e) { bad('移除失败：' + e.message); return 1; }
}

async function cmdDoctor(args) {
  const file = args.config || AGENT_FILE;
  let cfg = null;
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      bad(`配置无法解析：${e.message}`);
      return 1;
    }
    ok(`配置：${file}`);
    info(`id=${cfg.id} hub=${cfg.hub}`);
  } else {
    info(c.dim(`没有找到 agent 配置（${file}），只检查 Hub 连通性`));
  }

  const hub = args.hub || cfg?.hub || resolveHub();
  let failures = 0;

  // 1) hub reachable
  try {
    const h = await api(hub, '/api/hub');
    ok(`Hub 可达：${h.name} v${h.version} · ${h.online}/${h.agents} 在线`);
  } catch (e) {
    bad(`Hub 不可达：${e.message}`);
    failures++;
  }

  // 2) token accepted (if we have one)
  if (cfg?.token) {
    try {
      await api(hub, `/api/agent/poll?agent=${encodeURIComponent(cfg.id)}&timeout=1`, { token: cfg.token });
      ok('token 有效');
    } catch (e) {
      bad(`token 校验失败：${e.message}`);
      failures++;
    }
  } else if (cfg) {
    bad('配置里没有 token');
    failures++;
  }

  // 3) the local command the driver will run
  if (cfg?.config?.command) {
    const cmd = cfg.config.command;
    info(c.dim(`driver: ${cfg.driver} → ${cmd} ${(cfg.config.args || []).join(' ')}`));
    try {
      const { spawnSync } = await import('node:child_process');
      const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 8000 });
      if (probe.status === 0) ok(`命令可执行：${cmd}`);
      else {
        // Many agent CLIs do not support --version; not fatal.
        info(c.yellow(`⚠ ${cmd} --version 返回 ${probe.status}（有的 CLI 不支持，可忽略）`));
      }
    } catch (e) {
      bad(`命令无法执行：${e.message}`);
      failures++;
    }
  }

  console.log('');
  if (failures) bad(`${failures} 项检查未通过`);
  else ok('全部检查通过');
  return failures ? 1 : 0;
}

function readEnvToken(file, key) {
  try {
    const m = new RegExp(`^${key}=(.+)$`, 'm').exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════
   help
   ══════════════════════════════════════════════════════ */

function usage() {
  console.log(`${c.bold('ath')} — AI-team-hub CLI

${c.bold('在 Hub 机器上')}
  ath up [--port 8899]              启动 Hub
  ath invite [--ttl 30] [--uses 1]  生成加入码
  ath tokens [<id>]                 查看 agent token
  ath rm <id>                       移除用加入码加入的 agent

${c.bold('在新 agent 机器上')}
  ath join <hub-url> --code <码> [--id <id>] [--name <名字>] [--role <角色>]
                                    用加入码接入（自动写配置）
  ath connect [--config <file>]     启动连接
  ath doctor                        自检连通性 / token / 本地命令

${c.bold('环境变量')}
  ATH_HUB             默认 Hub 地址
  ATH_ADMIN_TOKEN     管理员 token（ath invite 用）
  ATH_JOIN_CODE       加入码（可代替 --code）
`);
}

/* ══════════════════════════════════════════════════════
   main
   ══════════════════════════════════════════════════════ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || has(args, 'help') || cmd === 'help') { usage(); return 0; }

  switch (cmd) {
    case 'invite': return cmdInvite(args);
    case 'join': return cmdJoin(args);
    case 'connect': return cmdConnect(args);
    case 'up': return cmdUp(args);
    case 'tokens': return cmdTokens(args);
    case 'rm': case 'remove': return cmdRemove(args);
    case 'doctor': return cmdDoctor(args);
case 'version': case '-v': {
      // Read the real version from package.json. A hardcoded string here once
      // printed 0.3.0 for three releases in a row and made it look like npm
      // was serving a stale build.
      let v = 'unknown';
      try {
        v = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
      } catch { /* keep the fallback */ }
      console.log(`ai-team-hub ${v}`);
      return 0;
    }
    default:
      bad(`未知命令：${cmd}`);
      usage();
      return 2;
  }
}

// Set the exit code and let Node drain on its own. Calling process.exit() here
// races with handles that fetch/child_process are still closing and trips a
// libuv assertion on Windows ("UV_HANDLE_CLOSING").
main().then((code) => {
  process.exitCode = code || 0;
}).catch((e) => {
  console.error(c.red(`fatal: ${e.stack || e.message}`));
  process.exitCode = 1;
});
