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
import { createStorage } from './storage.mjs';
import { attachWebSocket } from './ws.mjs';
import { DiscussionManager } from './discussions.mjs';
import { assertImage, imageSize, contentHash, parseMultipart, MAX_UPLOAD_BYTES } from './media.mjs';
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
const storage = createStorage({ dataDir: config.dataDir, storage: config.storage, log });

const discussions = new DiscussionManager({
  hub, registry, sse, log,
  store: new JsonStore(config.dataDir, 'discussions.json'),
  config: { defaultRoom: config.defaultRoom, selector: config.discussion && config.discussion.selector },
});

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
    if (size > limit) {
      const err = new Error('payload too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

/** Read a request body as raw bytes (multipart cannot be JSON-parsed). */
async function readBodyRaw(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('payload too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
        images: Array.isArray(body.images) ? body.images : [],
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
        // Capability advertisement: an agent may switch to the socket and gain
        // push delivery plus delta streaming on the same connection.
        transports: {
          poll: `/api/agent/poll?agent=${encodeURIComponent(agent.id)}`,
          stream: '/api/agent/stream',
          ws: `/ws?role=agent&agent=${encodeURIComponent(agent.id)}&token=<token>`,
        },
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

    /* ── media: upload ──
       Accepts either multipart/form-data (a file part) or JSON { dataUrl }.
       The declared type is ignored: the bytes decide. */
    if (p === '/api/upload' && req.method === 'POST') {
      const ctype = String(req.headers['content-type'] || '');

      let buffer;
      if (ctype.startsWith('multipart/form-data')) {
        const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
        const boundary = m && (m[1] || m[2]);
        if (!boundary) return sendJson(res, 400, { error: 'missing multipart boundary' });
        const raw = await readBodyRaw(req, MAX_UPLOAD_BYTES + 1_000_000);
        const parsed = parseMultipart(raw, boundary);
        if (!parsed.file) return sendJson(res, 400, { error: 'no file part' });
        buffer = parsed.file.buffer;
      } else {
        const body = await readBody(req, Math.ceil(MAX_UPLOAD_BYTES * 1.4));
        const dataUrl = body.dataUrl || body.data;
        if (!dataUrl) return sendJson(res, 400, { error: 'expected dataUrl' });
        const comma = String(dataUrl).indexOf(',');
        if (comma < 0) return sendJson(res, 400, { error: 'malformed dataUrl' });
        buffer = Buffer.from(String(dataUrl).slice(comma + 1), 'base64');
      }

      const kind = assertImage(buffer);
      const hash = contentHash(buffer);
      const key = `${hash.slice(0, 2)}/${hash}.${kind.ext}`;
      const { url } = await storage.put(key, buffer, kind.mime);
      const size = imageSize(buffer, kind.mime);

      log.line(`upload ${key} ${Math.round(buffer.length / 1024)}KB via ${storage.driver}`);
      return sendJson(res, 200, {
        ok: true,
        url,
        key,
        hash,
        mime: kind.mime,
        bytes: buffer.length,
        ...(size ? { w: size.w, h: size.h } : {}),
      });
    }

    /* ── media: read ── */
    if (p.startsWith('/api/file/') && req.method === 'GET') {
      const key = decodeURIComponent(p.slice('/api/file/'.length));
      // Never let a key escape the storage root.
      if (!key || key.includes('..') || key.startsWith('/')) {
        return sendJson(res, 400, { error: 'bad key' });
      }
      const obj = await storage.get(key);
      if (!obj) return sendJson(res, 404, { error: 'not found' });

      const ext = path.extname(key).slice(1).toLowerCase();
      const MIME_BY_EXT = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
      };
      const headers = {
        'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream',
        // Content-addressed keys never change, so this is safe forever.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      };
      if (obj.size) headers['Content-Length'] = obj.size;
      res.writeHead(200, headers);
      obj.stream.pipe(res);
      obj.stream.on('error', () => res.destroy());
      return;
    }

    /* ── agent: streaming turn ──
       POST a body of newline-delimited JSON chunks:
         {"type":"delta","text":"..."}
         {"type":"tool","name":"read_file","detail":"/var/log/app.log"}
         {"type":"final","text":"...","sessionId":"..."}
       Every delta is forwarded to browsers immediately; only the final text is
       written to the log. Works with `curl -N --data-binary @-`. */
    if (p === '/api/agent/stream' && req.method === 'POST') {
      const agent = authenticateAgent(url, req);
      const room = req.headers['x-room'] || url.searchParams.get('room') || config.defaultRoom;
      const msgId = Number(req.headers['x-msg-id'] || url.searchParams.get('msgId') || 0) || null;

      hub.beginStream(agent.id, msgId, room);

      let pending = '';
      let sawFinal = false;
      let finalText = '';
      let finalSession = '';
      let finished = false;

      // A stream that stalls must not leave the agent marked busy forever.
      let idleTimer = null;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (finished) return;
          finished = true;
          hub.endStream(agent.id, { text: hub.streamText(agent.id), truncated: true });
          log.line(`stream ${agent.id} idle timeout`);
        }, (config.streamIdleTimeout || 60) * 1000);
        idleTimer.unref?.();
      };
      armIdle();

      try {
        for await (const chunk of req) {
          pending += chunk.toString('utf8');
          let nl;
          while ((nl = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, nl).trim();
            pending = pending.slice(nl + 1);
            if (!line) continue;

            let evt;
            try { evt = JSON.parse(line); } catch { continue; }
            armIdle();

            if (evt.type === 'delta') {
              hub.appendDelta(agent.id, String(evt.text || ''));
            } else if (evt.type === 'tool') {
              hub.appendTool(agent.id, evt.name, evt.detail || evt.arg || '');
            } else if (evt.type === 'final') {
              sawFinal = true;
              finalText = String(evt.text ?? hub.streamText(agent.id));
              finalSession = evt.sessionId || '';
            }
          }
        }
      } catch (e) {
        log.line(`stream ${agent.id} read error: ${e.message}`);
      }

      // A trailing chunk without a newline still counts.
      const tail = pending.trim();
      if (tail) {
        try {
          const evt = JSON.parse(tail);
          if (evt.type === 'delta') hub.appendDelta(agent.id, String(evt.text || ''));
          if (evt.type === 'final') {
            sawFinal = true;
            finalText = String(evt.text ?? hub.streamText(agent.id));
            finalSession = evt.sessionId || '';
          }
        } catch { /* ignore a torn tail */ }
      }

      clearTimeout(idleTimer);
      if (!finished) {
        finished = true;
        const message = hub.endStream(agent.id, {
          text: sawFinal ? finalText : hub.streamText(agent.id),
          sessionId: finalSession,
          truncated: !sawFinal,
        });
        if (finalSession) sessions.set(agent.id, finalSession);
        return sendJson(res, 200, { ok: true, message });
      }
      return sendJson(res, 200, { ok: true });
    }

    /* ── discussions ── */
    if (p === '/api/discussions' && req.method === 'GET') {
      return sendJson(res, 200, { discussions: discussions.list() });
    }

    if (p === '/api/discussions' && req.method === 'POST') {
      const body = await readBody(req);
      const record = discussions.create({
        topic: body.topic,
        participants: body.participants,
        policy: body.policy || {},
        room: body.room,
      });
      return sendJson(res, 200, { ok: true, discussion: record });
    }

    if (p.startsWith('/api/discussions/') && req.method === 'GET') {
      const id = p.split('/')[3];
      const record = discussions.get(id);
      if (!record) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, { discussion: record });
    }

    if (p.startsWith('/api/discussions/') && p.endsWith('/stop') && req.method === 'POST') {
      const id = p.split('/')[3];
      const record = discussions.stop(id, 'stopped by operator');
      if (!record) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, { ok: true, discussion: record });
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

/* ── WebSocket transport ──
   Optional. An agent that connects here gets wakes pushed instead of polled and
   can stream deltas over the same socket. Agents that only speak HTTP are
   unaffected — the poll queue remains the fallback. */
const wsAgents = new Map(); // agentId -> WsConnection

attachWebSocket(server, {
  path: '/ws',
  authorize(req, url) {
    const role = url.searchParams.get('role') || 'agent';
    if (role !== 'agent') return true; // browser sockets need no token
    const id = url.searchParams.get('agent') || '';
    const token = url.searchParams.get('token') || '';
    return Boolean(registry.get(id)) && registry.verify(id, token);
  },
  onConnection(conn, req, url) {
    const role = url.searchParams.get('role') || 'agent';

    if (role !== 'agent') {
      // Browser socket: identical event feed to SSE, for clients that prefer WS.
      const unsubscribe = sse.subscribe((event, data) => conn.sendJSON({ event, data }));
      conn.sendJSON({ event: 'hello', data: { transport: 'ws', role: 'browser' } });
      conn.on('close', unsubscribe);
      return;
    }

    /* ── agent role ── */
    const agentId = url.searchParams.get('agent');
    const agent = registry.get(agentId);
    if (!agent) { conn.close(1008, 'unknown agent'); return; }

    wsAgents.set(agentId, conn);
    registry.markSeen(agentId, { online: true });
    sse.broadcast('presence', { agents: registry.publicView() });
    log.line(`ws connect ${agentId}`);

    conn.sendJSON({ event: 'hello', data: { transport: 'ws', agent: agentId } });

    let streamRoom = null;

    conn.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const type = msg.type;

      try {
        if (type === 'ack') {
          registry.markSeen(agentId, { online: true });
          return;
        }
        if (type === 'session') {
          if (msg.sessionId) {
            registry.markSeen(agentId, { online: true, sessionId: msg.sessionId });
            sessions.set(agentId, msg.sessionId);
          }
          return;
        }
        if (type === 'begin') {
          streamRoom = msg.room || config.defaultRoom;
          hub.beginStream(agentId, msg.msgId || null, streamRoom);
          return;
        }
        if (type === 'delta') {
          if (!hub.streams.has(agentId)) hub.beginStream(agentId, msg.msgId || null, streamRoom);
          hub.appendDelta(agentId, String(msg.text || ''));
          return;
        }
        if (type === 'tool') {
          if (!hub.streams.has(agentId)) hub.beginStream(agentId, msg.msgId || null, streamRoom);
          hub.appendTool(agentId, msg.name, msg.detail || '');
          return;
        }
        if (type === 'final') {
          const message = hub.endStream(agentId, {
            text: String(msg.text ?? hub.streamText(agentId)),
            sessionId: msg.sessionId || '',
          });
          if (msg.sessionId) sessions.set(agentId, msg.sessionId);
          conn.sendJSON({ event: 'saved', data: { id: message && message.id } });
          streamRoom = null;
          return;
        }
        if (type === 'reply') {
          hub.reply({ agentId, msgId: msg.msgId, text: String(msg.text || ''), sessionId: msg.sessionId });
          return;
        }
      } catch (e) {
        conn.sendJSON({ event: 'error', data: { message: String(e.message) } });
      }
    });

    conn.on('close', () => {
      if (wsAgents.get(agentId) === conn) wsAgents.delete(agentId);
      const remaining = registry.removeConnection(agentId);
      if (remaining <= 0) hub.agentWentOffline(agentId);
      sse.broadcast('presence', { agents: registry.publicView() });
      log.line(`ws disconnect ${agentId}`);
    });
  },
});

// Deliver wakes over WS when the agent is connected.
hub.setWsSender((agentId, payload) => {
  const conn = wsAgents.get(agentId);
  if (!conn || conn.closed) return false;
  return conn.sendJSON({ event: 'wake', data: payload });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.line(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
