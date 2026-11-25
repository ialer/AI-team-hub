#!/usr/bin/env node
/**
 * AI Team Hub — agent connector.
 *
 * Runs ON THE AGENT'S MACHINE. It holds one long-poll against the hub; when a
 * mention arrives it invokes the local agent through a driver and posts the
 * answer back. The hub never needs credentials to this machine.
 *
 * Drivers are the *same modules* the hub uses for push mode, so there is one
 * implementation per integration, not two: `driver` is an adapter id.
 *
 * Usage:
 *   node connectors/connector.mjs --config connectors/dave.json
 *   node connectors/connector.mjs --config ... --once     # one poll, for tests
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Register the built-in drivers (shared with the hub's push mode).
import '../server/adapters/builtin.mjs';
import { getAdapter, listAdapters } from '../server/adapters/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Persist the hub contract to a fixed, read-only location on this machine. */
function writeContractFile(contract) {
  try {
    const dir = path.join(os.homedir(), '.ath', 'contracts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'team-contract.md');
    const body = '---\nversion: ' + contract.version + '\nsha256: ' + contract.sha256 + '\n---\n\n' + contract.text + '\n';
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}

/* ── argv ─────────────────────────────────────────────── */
function parseArgv(argv) {
  const out = { once: false, verbose: false, config: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') out.config = argv[++i];
    else if (a === '--once') out.once = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!out.config && !a.startsWith('-')) out.config = a;
  }
  return out;
}

function usage() {
  console.log(`AI Team Hub connector

  node connectors/connector.mjs --config <file.json> [--once] [--verbose]

Config:
{
  "hub": "http://127.0.0.1:8899",
  "id": "my-agent",
  "token": "<token issued by the hub>",
  "driver": "cli-once | cli-json | openai-compat | http-webhook | command",
  "config": { /* driver specific */ }
}

Available drivers: ${listAdapters().map((a) => a.id).join(', ')}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLog(verbose) {
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (verbose || !/^poll ok/.test(msg)) console.log(line);
  };
}

/* ══════════════════════════════════════════════════════
   Transports
   Two ways to receive a wake. Both hand the same payload to `onWake`, so the
   driver code below never knows which one is in use.
   ══════════════════════════════════════════════════════ */

/** Long poll: works anywhere, including a shell with curl. */
function startPollTransport({ hubBase, agentId, auth, onWake, log, stopFlag, once = false }) {
  return (async () => {
    while (!stopFlag.stopping) {
      let payload;
      try {
        const res = await fetch(
          `${hubBase}/api/agent/poll?agent=${encodeURIComponent(agentId)}`,
          { headers: auth, signal: AbortSignal.timeout(90_000) },
        );
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
        payload = JSON.parse(text);
      } catch (e) {
        log(`poll error: ${e.message}`);
        await sleep(3000);
        continue;
      }

      for (const ev of payload.events || []) {
        if (stopFlag.stopping) break;
        await onWake(ev, { sessionId: payload.sessionId });
      }

      if (once) return;
    }
  })();
}

/**
 * WebSocket: lower latency and lets the agent stream deltas on the same socket.
 * Requires a global WebSocket (Node 22+). Returns null when unavailable so the
 * caller can silently fall back to polling.
 */
function startWsTransport({ hubBase, agentId, token, onWake, log, stopFlag, onOpen }) {
  if (typeof WebSocket !== 'function') return null;

  const wsUrl = hubBase.replace(/^http/, 'ws')
    + `/ws?role=agent&agent=${encodeURIComponent(agentId)}&token=${encodeURIComponent(token)}`;

  const state = { ws: null, ready: false, stopped: false };
  let firstOpen = true;

  const connect = () => {
    if (stopFlag.stopping) return;
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.ready = true;
      log('ws connected');
      // The first open is covered by the startup hello; every later one means the
      // hub restarted or dropped us, so re-read the contract instead of running
      // on the values this process was started with.
      if (!onOpen) return;
      if (firstOpen) { firstOpen = false; return; }
      void onOpen();
    });

    ws.addEventListener('message', async (e) => {
      let frame;
      try { frame = JSON.parse(e.data); } catch { return; }
      if (frame.event === 'hello') return;
      if (frame.event !== 'wake') return;
      try {
        await onWake(frame.data, { sessionId: frame.data.sessionId });
      } catch (err) {
        log(`wake handler error: ${err.message}`);
      }
    });

    ws.addEventListener('close', () => {
      state.ready = false;
      if (stopFlag.stopping) return;
      log('ws closed, reconnecting in 3s');
      setTimeout(connect, 3000);
    });

    ws.addEventListener('error', () => {
      // 'close' fires next and drives the reconnect.
    });
  };

  connect();

  return {
    state,
    stop() { state.stopped = true; try { state.ws?.close(); } catch { /* gone */ } },
    isReady: () => state.ready,
  };
}

/* ── main ─────────────────────────────────────────────── */
async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) { usage(); return; }

  const configPath = args.config || path.join(HERE, 'connector.json');
  if (!fs.existsSync(configPath)) {
    console.error(`config not found: ${configPath}\nrun with --help for the format`);
    process.exit(2);
  }

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const hubBase = (cfg.hub || 'http://127.0.0.1:8899').replace(/\/+$/, '');
  const agentId = cfg.id;
  const token = cfg.token;
  const driverId = cfg.driver || 'cli-once';
  const driverConfig = cfg.config || {};

  if (!agentId) throw new Error('config.id is required');
  if (!token) throw new Error('config.token is required');
  const driver = getAdapter(driverId);
  if (!driver) throw new Error(`unknown driver "${driverId}" — available: ${listAdapters().map((a) => a.id).join(', ')}`);

  const log = makeLog(args.verbose);
  log(`connector up — agent=${agentId} driver=${driverId} hub=${hubBase}`);

  const auth = { 'X-Agent-Id': agentId, 'X-Agent-Token': token };
  let sessionId = cfg.sessionId || '';

  const api = async (pathname, init = {}, timeoutMs = 30_000) => {
    const res = await fetch(hubBase + pathname, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return {}; }
  };

  /* Announce presence + session so the hub can route and persist it. */
  const hello = await api('/api/agent/hello', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (hello.sessionId) sessionId = hello.sessionId;
  log(`hello ok (session=${sessionId || 'none'})`);

  /* Team contract: the hub hands it over on connect; this agent persists it
     locally and confirms the version it is now running on. */
  let contract = hello.contract || null;

  /** Persist the contract locally and report the version we now run on. */
  const applyContract = async (c) => {
    if (!c) return;
    const f = writeContractFile(c);
    log(`contract v${c.version} (${c.sha256.slice(0, 12)})${f ? ' -> ' + f : ' (not persisted)'}`);
    try {
      await api('/api/agent/contract-ack', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: c.version, sha256: c.sha256 }),
      }, 10_000);
    } catch (e) {
      log(`contract ack failed: ${e.message}`);
    }
  };

  await applyContract(contract);

  /** Re-read the contract after a reconnect; no-op when nothing changed. */
  const refreshContract = async () => {
    try {
      const h = await api('/api/agent/hello', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }, 15_000);
      if (h.sessionId) sessionId = h.sessionId;
      if (h.contract && (!contract || h.contract.sha256 !== contract.sha256)) {
        contract = h.contract;
        await applyContract(contract);
        log('contract refreshed after reconnect');
      }
    } catch (e) {
      log(`contract refresh failed: ${e.message}`);
    }
  };

  let stopping = false;
  const stopFlag = { get stopping() { return stopping; } };
  const stop = () => { stopping = true; log('stopping…'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  /* Pick a transport.
     `transport: "ws"` in the config forces WebSocket; otherwise the connector
     uses it when the runtime has a global WebSocket, and silently falls back to
     long polling when it does not (Node < 22, or a blocked upgrade). */
  const wantWs = cfg.transport === 'ws' || cfg.transport === undefined;
  let wsTransport = null;
  if (wantWs) wsTransport = startWsTransport({
    hubBase, agentId, token,
    log,
    stopFlag,
    onWake: (ev, meta) => handleWake(ev, meta),
    onOpen: refreshContract,
  });

  if (wsTransport && !args.once) {
    log('transport: websocket');
    await new Promise((resolve) => {
      const tick = setInterval(() => {
        if (stopping) { clearInterval(tick); wsTransport.stop(); resolve(); }
      }, 200);
      tick.unref?.();
    });
  } else {
    wsTransport?.stop();
    log('transport: long-poll');
    await startPollTransport({
      hubBase, agentId, auth, log, stopFlag, once: args.once,
      onWake: (ev, meta) => handleWake(ev, meta),
    });
  }

  log('connector stopped');

  /* ── one wake → one reply ───────────────────────────── */
  async function handleWake(ev, meta = {}) {
    const started = Date.now();
    log(`wake #${ev.msgId} from ${ev.from}: ${String(ev.text || '').slice(0, 60)}`);
    try {
      const contractPrefix = contract
        ? `【团队契约 v${contract.version}】\n${contract.text}\n\n`
        : '';
      const result = await driver.wake({
        text: contractPrefix + ev.text,
        sessionId: ev.sessionId || sessionId,
        config: driverConfig,
      });
      if (result.sessionId) sessionId = result.sessionId;

      await api('/api/agent/reply', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgId: ev.msgId, text: result.text, sessionId }),
      });
      log(`reply #${ev.msgId} sent (${String(result.text || '').length} chars, ${Date.now() - started}ms)`);
    } catch (e) {
      log(`driver error on #${ev.msgId}: ${e.message}`);
      await api('/api/agent/reply', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgId: ev.msgId,
          text: `⚠️ 处理失败：${String(e.message).slice(0, 300)}`,
          sessionId,
        }),
      }).catch(() => { /* the hub already knows */ });
    }
  }
}

main().catch((e) => {
  console.error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
