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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Register the built-in drivers (shared with the hub's push mode).
import '../server/adapters/builtin.mjs';
import { getAdapter, listAdapters } from '../server/adapters/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

  let stopping = false;
  const stop = () => { stopping = true; log('stopping…'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    let payload;
    try {
      payload = await api(
        `/api/agent/poll?agent=${encodeURIComponent(agentId)}`,
        { headers: auth },
        90_000,
      );
    } catch (e) {
      log(`poll error: ${e.message}`);
      await sleep(3000);
      continue;
    }

    if (payload.sessionId && payload.sessionId !== sessionId) sessionId = payload.sessionId;

    for (const ev of payload.events || []) {
      if (stopping) break;
      await handleWake(ev);
    }

    if (args.once) break;
  }

  log('connector stopped');

  /* ── one wake → one reply ───────────────────────────── */
  async function handleWake(ev) {
    const started = Date.now();
    log(`wake #${ev.msgId} from ${ev.from}: ${String(ev.text || '').slice(0, 60)}`);
    try {
      const result = await driver.wake({
        text: ev.text,
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
