/**
 * Shared HTTP helpers — no state of their own.
 */
import fs from 'node:fs';
import path from 'node:path';

export function createLogger(cfg) {
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

export function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

export function sendText(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function readBody(req, limit = 1_000_000) {
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

export async function readBodyRaw(req, limit) {
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

export function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}

export function authenticateAgent(registry, url, req) {
  const id = url.searchParams.get('agent') || req.headers['x-agent-id'] || '';
  const token = url.searchParams.get('token') || req.headers['x-agent-token'] || bearer(req);
  if (!id) throw Object.assign(new Error('missing agent id'), { status: 400 });
  const agent = registry.get(id);
  if (!agent) throw Object.assign(new Error(`unknown agent ${id}`), { status: 404 });
  if (!registry.verify(id, token)) throw Object.assign(new Error('bad token'), { status: 401 });
  if (agent.enabled === false) throw Object.assign(new Error('agent disabled'), { status: 403 });
  return agent;
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

export function serveStatic(publicDir, req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(publicDir, safe);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
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
