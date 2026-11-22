/**
 * Built-in adapters (the push path).
 *
 * Each one is intentionally small. Add a new integration by dropping a file
 * here and importing it in ./index.mjs — no hub changes required.
 *
 * Template substitution supported in `args`, `command`, and `url`:
 *   {text}       the message text
 *   {sessionId}  the agent's persisted session id ('' when unknown)
 */
import { spawn } from 'node:child_process';
import { registerAdapter } from './index.mjs';

/* ── helpers ──────────────────────────────────────────── */

function fill(value, vars) {
  return String(value).replace(/\{(text|sessionId)\}/g, (_, k) => vars[k] ?? '');
}

function runProcess(command, args, { timeoutMs = 180000, cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Extract a value from text using a user-supplied regex (first capture group). */
function extract(text, pattern) {
  if (!pattern) return null;
  try {
    const m = new RegExp(pattern).exec(text || '');
    return m ? (m[1] ?? m[0]) : null;
  } catch {
    return null;
  }
}

/** Parse newline-delimited JSON and pull the fields we care about. */
function parseNdjson(raw, { textField = 'text', sessionField = 'sessionId' } = {}) {
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
    if (o[textField] && !text) text = o[textField];
    if (o[sessionField] && !sessionId) sessionId = o[sessionField];
  }
  return { text, sessionId, error };
}

/* ── cli-once ─────────────────────────────────────────── */

/**
 * Run a CLI that prints the answer to stdout and exits.
 * Optional session support via a flag plus a regex over stdout/stderr.
 */
export const cliOnce = {
  id: 'cli-once',
  label: 'CLI (one shot, plain text output)',
  async probe(config) {
    const r = await runProcess(config.command || 'true', ['--version'], { timeoutMs: 8000 });
    return { ok: r.code === 0, detail: (r.stdout || r.stderr).trim().slice(0, 200) };
  },
  async wake({ text, sessionId, config }) {
    const vars = { text, sessionId: sessionId || '' };
    const args = (config.args || []).map((a) => fill(a, vars));
    if (sessionId && config.sessionFlag) args.push(fill(config.sessionFlag, vars));
    const r = await runProcess(fill(config.command, vars), args, {
      timeoutMs: config.timeoutMs,
      env: config.env,
      cwd: config.cwd,
    });
    const out = r.stdout.trim();
    if (r.code !== 0 && !out) {
      throw new Error((r.stderr || `exit ${r.code}`).trim().slice(0, 500));
    }
    // Some CLIs print the session id on stderr, some on stdout — search both.
    const found = extract(`${r.stdout}\n${r.stderr}`, config.sessionPattern);
    let reply = out;
    if (config.stripPattern) reply = reply.replace(new RegExp(config.stripPattern, 'gm'), '').trim();
    return { text: reply, sessionId: found || sessionId || '' };
  },
};

/* ── cli-json ─────────────────────────────────────────── */

/**
 * Run a CLI that streams newline-delimited JSON events (dsh --json style).
 */
export const cliJson = {
  id: 'cli-json',
  label: 'CLI (NDJSON event stream)',
  async probe(config) {
    const r = await runProcess(config.command || 'true', ['--version'], { timeoutMs: 8000 });
    return { ok: r.code === 0, detail: (r.stdout || r.stderr).trim().slice(0, 200) };
  },
  async wake({ text, sessionId, config }) {
    const vars = { text, sessionId: sessionId || '' };
    const args = (config.args || []).map((a) => fill(a, vars));
    if (sessionId && config.sessionFlag) args.push(fill(config.sessionFlag, vars));
    const r = await runProcess(fill(config.command, vars), args, {
      timeoutMs: config.timeoutMs,
      env: config.env,
      cwd: config.cwd,
    });
    const parsed = parseNdjson(r.stdout, config.fields || {});
    if (parsed.error) throw new Error(parsed.error.slice(0, 500));
    if (r.code !== 0 && !parsed.text) {
      throw new Error((r.stderr || `exit ${r.code}`).trim().slice(0, 500));
    }
    return { text: parsed.text, sessionId: parsed.sessionId || sessionId || '' };
  },
};

/* ── openai-compat ────────────────────────────────────── */

/**
 * POST to any OpenAI-compatible /v1/chat/completions endpoint.
 * Works with CowAgent, LiteLLM, Ollama, vLLM, and friends.
 */
export const openaiCompat = {
  id: 'openai-compat',
  label: 'OpenAI-compatible chat completions',
  async probe(config) {
    try {
      const url = fill(config.url, { text: '', sessionId: '' });
      const r = await fetch(url.replace(/\/chat\/completions.*$/, '/models'), {
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
        signal: AbortSignal.timeout(6000),
      });
      return { ok: r.ok, detail: `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, detail: String(e.message).slice(0, 200) };
    }
  },
  async wake({ text, sessionId, config }) {
    const headers = { 'Content-Type': 'application/json' };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    const body = {
      ...(config.extraBody || {}),
      messages: [{ role: 'user', content: text }],
    };
    if (sessionId && config.sessionField) body[config.sessionField] = sessionId;
    const r = await fetch(fill(config.url, { text, sessionId: sessionId || '' }), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs || 180000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return {
      text: j?.choices?.[0]?.message?.content || '',
      sessionId: j?.[config.responseSessionField || 'session_id'] || sessionId || '',
    };
  },
};

/* ── http-webhook ─────────────────────────────────────── */

/**
 * POST the message to an arbitrary URL; the response body is the reply.
 * The simplest possible integration for a custom agent.
 */
export const httpWebhook = {
  id: 'http-webhook',
  label: 'HTTP webhook (POST in, reply out)',
  async probe(config) {
    return { ok: Boolean(config.url), detail: config.url || 'no url configured' };
  },
  async wake({ text, sessionId, config }) {
    const r = await fetch(fill(config.url, { text, sessionId: sessionId || '' }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
      body: JSON.stringify({ text, sessionId: sessionId || null, ...(config.extraBody || {}) }),
      signal: AbortSignal.timeout(config.timeoutMs || 180000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.text();
    try {
      const j = JSON.parse(raw);
      return { text: j.text ?? j.reply ?? raw, sessionId: j.sessionId || sessionId || '' };
    } catch {
      return { text: raw, sessionId: sessionId || '' };
    }
  },
};

/* ── command ──────────────────────────────────────────── */

/**
 * Escape hatch: run any shell command; stdout becomes the reply.
 * `{text}` is substituted into args (never into a shell string) so quoting is
 * the caller's job — no shell interpolation, no injection surface.
 */
export const command = {
  id: 'command',
  label: 'Arbitrary command (stdout = reply)',
  async probe(config) {
    return { ok: Boolean(config.command), detail: config.command || 'no command configured' };
  },
  async wake({ text, sessionId, config }) {
    const vars = { text, sessionId: sessionId || '' };
    // Pick the platform shell unless the operator pinned one.
    const isWin = process.platform === 'win32';
    const shell = config.shell || (isWin ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh');
    const flag = config.shellFlag || (isWin ? '/c' : '-c');
    const r = await runProcess(shell, [flag, fill(config.command, vars)], {
      timeoutMs: config.timeoutMs,
      env: config.env,
      cwd: config.cwd,
    });
    if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim().slice(0, 500));
    return { text: r.stdout.trim(), sessionId: sessionId || '' };
  },
};

/* Self-register so importing this module is all a host needs to do. */
for (const adapter of [cliOnce, cliJson, openaiCompat, httpWebhook, command]) {
  registerAdapter(adapter);
}