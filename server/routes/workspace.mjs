import { sendJson, readBody, readBodyRaw } from '../http.mjs';

/** Bodies are small: this is a reference shelf, not an upload service. */
const MAX_DOC_BYTES = 1_000_000;
const MAX_FILE_BYTES = 8_000_000;

/**
 * Writing to a surface is allowed for either an administrator (the panel) or a
 * live agent (so an agent's output can land on the shelf). Everything else is
 * rejected, and the surfaces module owns all path handling.
 */
function authorizeWrite(ctx, req, url) {
  const { registry } = ctx;
  const admin = req.headers['x-admin-token'] || url.searchParams.get('admin') || '';
  if (admin && registry.verifyAdmin(admin)) return 'admin';

  const id = req.headers['x-agent-id'] || '';
  const token = req.headers['x-agent-token'] || '';
  if (id && token) {
    const agent = registry.get(id);
    if (agent && agent.enabled !== false && registry.verify(id, token)) return 'agent';
  }
  return null;
}

export function createWorkspaceRoutes(ctx) {
  const { surfaces, log } = ctx;
  return async function workspaceRoutes(req, res, url, p) {
    if (p === '/api/surfaces' && req.method === 'GET') { sendJson(res, 200, { surfaces: surfaces.list() }); return true; }

    /* ── write ── */
    if (p.startsWith('/api/surface/') && req.method === 'POST') {
      const parts = p.split('/').filter(Boolean); // api, surface, <id>[/<ref>]
      const surfaceId = parts[2];
      const refId = parts[3] ? decodeURIComponent(parts[3]) : null;

      const who = authorizeWrite(ctx, req, url);
      if (!who) { sendJson(res, 401, { error: 'admin token or agent token required' }); return true; }

      try {
        if (surfaceId === 'files') {
          const name = refId || url.searchParams.get('name') || '';
          const raw = await readBodyRaw(req, MAX_FILE_BYTES);
          if (!raw.length) { sendJson(res, 400, { error: 'empty body' }); return true; }
          const item = await surfaces.write('files', { name, buffer: raw });
          log.line(`surface files written by ${who}: ${item.id}`);
          sendJson(res, 200, { ok: true, item });
          return true;
        }

        const body = await readBody(req, MAX_DOC_BYTES);

        if (surfaceId === 'docs') {
          const id = refId || body.id || body.title;
          const item = await surfaces.write('docs', {
            id,
            content: body.content ?? body.text ?? '',
            overwrite: body.overwrite !== false,
          });
          log.line(`surface docs written by ${who}: ${item.id}`);
          sendJson(res, 200, { ok: true, item });
          return true;
        }

        if (surfaceId === 'tasks') {
          const items = await surfaces.write('tasks', {
            upsert: refId ? { ...(body.task || body), id: refId } : (body.upsert || body.task),
            remove: body.remove || null,
          });
          log.line(`surface tasks written by ${who}`);
          sendJson(res, 200, { ok: true, items });
          return true;
        }

        sendJson(res, 400, { error: `surface ${surfaceId} is read-only` });
        return true;
      } catch (e) {
        sendJson(res, e.status || 500, { error: String(e.message || e) });
        return true;
      }
    }

    if (p.startsWith('/api/surface/') && req.method === 'GET') {
      const parts = p.split('/').filter(Boolean); // api, surface, <id>, [<ref>]
      const surfaceId = parts[2];
      const refId = parts[3];
      if (!refId) { sendJson(res, 200, { items: await surfaces.items(surfaceId) }); return true; }
      const doc = await surfaces.resolve(surfaceId, decodeURIComponent(refId));
      const buf = Buffer.from(doc.content);
      res.writeHead(200, { 'Content-Type': doc.mime + '; charset=utf-8', 'Content-Length': buf.length });
      res.end(buf);
      return true;
    }

    return false;
  };
}
