#!/usr/bin/env node
/**
 * AI Team Hub — HTTP entry point.
 *
 * Routes are deliberately flat and few. Everything a harness needs is one of:
 *   GET  /api/agent/poll   long-poll for mentions        (agent → hub)
 *   POST /api/agent/reply  post an answer                (agent → hub)
 *   POST /api/say          speak as a human              (browser)
 *   GET  /api/stream       SSE feed                      (browser)
 *
 * No framework, no build step: `node server/index.mjs` is the whole deployment.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { MessageLog, JsonStore } from './store.mjs';
import { AgentRegistry } from './registry.mjs';
import { SseHub, WakeQueue } from './transport.mjs';
import { Hub } from './hub.mjs';
import { createSurfaces } from './surfaces.mjs';
import './adapters/builtin.mjs'; // registers the built-in adapters

const config = loadConfig();
const log = createLogger(config);
const messages = new MessageLog(config.dataDir);
const sessions = new JsonStore(config.dataDir, 'sessions.json');
const dialogs = new JsonStore(config.dataDir, 'dialogs.json');
const registry = new AgentRegistry(config.agents, { adminToken: config.adminToken || '' });
const sse = new SseHub({ keepAliveMs: config.sseKeepAliveMs });
const wakeQueue = new WakeQueue();

// Rehydrate persisted session ids so restarts keep conversation continuity.
for (const agent of config.agents) {
  const sid = sessions.get(agent.id, null);
  if (sid) registry.markSeen(agent.id, { online: false, sessionId: sid });
}

const hub = new Hub({ config, log, messages, registry, sse, wakeQueue, dialogs });
const surfaces = createSurfaces({ dataDir: config.dataDir, log });

/* ── helpers ──────────────────────────────────────────── */

function createLogger(cfg) {
  const file = path.join(cfg.dataDir, 'hub.log');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return {
    line(text) {
      const entry = `[${new Date().toISOString()}] ${text}`;
      console.log(entry);
      try { fs.appendFileSync(file, entry + '\n'); } catch { /* best effort */ }
    },
  };
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

async function readBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

/** Resolve and authorise the calling agent from id + token. */
function authenticateAgent(url, req) {
  const id = url.searchParams.get('agent') || req.headers['x-agent-id'] || '';
  const token = url.searchParams.get('token') || req.headers['x-agent-token'] || bearer(req);
  if (!id) throw Object.assign(new Error('missing agent id'), { status: 400 });
  const agent = registry.get(id);
  if (!agent) throw Object.assign(new Error(`unknown agent ${id}`), { status: 404 });
  if (!registry.verify(id, token)) throw Object.assign(new Error('bad token'), { status: 401 });
  return agent;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(config.publicDir, safe);
  if (!file.startsWith(config.publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

/* ── router ───────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    /* ── static ── */
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(req, res, p);

    /* ── browser: state + history ── */
    if (p === '/api/state' && req.method === 'GET') return sendJson(res, 200, hub.state());

    if (p === '/api/messages' && req.method === 'GET') {
      const room = url.searchParams.get('room') || config.defaultRoom;
      const after = Number(url.searchParams.get('after') || 0);
      return sendJson(res, 200, { messages: messages.since({ room, after }) });
    }

    /* ── browser: speak ── */
    if (p === '/api/say' && req.method === 'POST') {
      const body = await readBody(req);
      const from = body.from === 'human' || registry.get(body.from) ? body.from : 'human';
      const message = hub.say({
        room: body.room || config.defaultRoom,
        from,
        text: body.text,
        refs: Array.isArray(body.refs) ? body.refs : [],
        dialog: body.dialog || null,
      });
      return sendJson(res, 200, { ok: true, message });
    }

    /* ── browser: SSE ── */
    if (p === '/api/stream' && req.method === 'GET') {
      sse.attach(req, res, [['presence', { agents: registry.publicView() }]]);
      return;
    }

    /* ── agent: long poll ── */
    if (p === '/api/agent/poll' && req.method === 'GET') {
      const agent = authenticateAgent(url, req);
      registry.addConnection(agent.id);
      registry.markSeen(agent.id, { online: true });
      sse.broadcast('presence', { agents: registry.publicView() });

      let closed = false;
      req.on('close', () => {
        closed = true;
        const remaining = registry.removeConnection(agent.id);
        // Last poller gone → the agent is not processing anything we can see.
        if (remaining === 0) hub.agentWentOffline(agent.id);
        sse.broadcast('presence', { agents: registry.publicView() });
      });

      const timeoutMs = Math.min(
        Number(url.searchParams.get('timeout') || config.pollTimeout) * 1000,
        config.pollTimeout * 1000,
      );
      const events = await wakeQueue.wait(agent.id, timeoutMs);
      if (closed) return;
      return sendJson(res, 200, { events, sessionId: registry.sessionFor(agent.id) });
    }

    /* ── agent: reply ── */
    if (p === '/api/agent/reply' && req.method === 'POST') {
      const body = await readBody(req);
      const agent = authenticateAgent(new URL(req.url, `http://x`), req);
      const message = hub.reply({
        agentId: agent.id,
        msgId: body.msgId,
        text: body.text,
        sessionId: body.sessionId,
      });
      if (body.sessionId) sessions.set(agent.id, body.sessionId);
      return sendJson(res, 200, { ok: true, message });
    }

    /* ── agent: heartbeat / session update ── */
    if (p === '/api/agent/hello' && req.method === 'POST') {
      const body = await readBody(req);
      const agent = authenticateAgent(new URL(req.url, `http://x`), req);
      if (body.sessionId) {
        registry.markSeen(agent.id, { online: true, sessionId: body.sessionId });
        sessions.set(agent.id, body.sessionId);
      }
      return sendJson(res, 200, {
        ok: true,
        agent: { id: agent.id, name: agent.name, mode: agent.mode },
        sessionId: registry.sessionFor(agent.id),
      });
    }

    /* ── dialogs ── */
    if (p === '/api/dialogs' && req.method === 'GET') return sendJson(res, 200, { dialogs: dialogs.all() });

    if (p.startsWith('/api/dialogs/') && req.method === 'POST') {
      const [, , , id, action] = p.split('/');
      const body = await readBody(req);
      if (action === 'submit') return sendJson(res, 200, hub.submitDialog({ dialogId: id, values: body.values || {} }));
      if (action === 'cancel') return sendJson(res, 200, hub.cancelDialog({ dialogId: id }));
      return sendJson(res, 404, { error: 'unknown action' });
    }

    /* ── admin: adapter catalogue (for the config UI / docs) ── */
    if (p === '/api/adapters' && req.method === 'GET') {
      const { listAdapters } = await import('./adapters/index.mjs');
      return sendJson(res, 200, { adapters: listAdapters() });
    }

    /* ── workspace surfaces ── */
    if (p === '/api/surfaces' && req.method === 'GET') {
      return sendJson(res, 200, { surfaces: surfaces.list() });
    }

    if (p.startsWith('/api/surface/') && req.method === 'GET') {
      const parts = p.split('/').filter(Boolean); // api, surface, <id>, [<ref>]
      const surfaceId = parts[2];
      const refId = parts[3];
      if (!refId) return sendJson(res, 200, { items: await surfaces.items(surfaceId) });
      const doc = await surfaces.resolve(surfaceId, decodeURIComponent(refId));
      const buf = Buffer.from(doc.content);
      res.writeHead(200, { 'Content-Type': doc.mime + '; charset=utf-8', 'Content-Length': buf.length });
      return res.end(buf);
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) log.line(`error ${req.method} ${p}: ${e.stack || e.message}`);
    return sendJson(res, status, { error: String(e.message || e) });
  }
});

server.listen(config.port, config.host, () => {
  log.line(`AI Team Hub listening on http://${config.host}:${config.port}`);
  log.line(`agents: ${config.agents.map((a) => `${a.id}(${a.mode})`).join(', ') || 'none configured'}`);
  if (!config.adminToken) log.line('WARNING: no adminToken set — agent tokens cannot be verified');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.line(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
