import { sendJson } from '../http.mjs';

export function createWorkspaceRoutes(ctx) {
  const { surfaces } = ctx;
  return async function workspaceRoutes(req, res, url, p) {
    if (p === '/api/surfaces' && req.method === 'GET') { sendJson(res, 200, { surfaces: surfaces.list() }); return true; }

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
