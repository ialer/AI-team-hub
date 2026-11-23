import { sendJson, readBody } from '../http.mjs';

export function createDiscussionRoutes(ctx) {
  const { discussions } = ctx;
  return async function discussionRoutes(req, res, url, p) {
    if (p === '/api/discussions' && req.method === 'GET') { sendJson(res, 200, { discussions: discussions.list() }); return true; }

    if (p === '/api/discussions' && req.method === 'POST') {
      const body = await readBody(req);
      const record = discussions.create({ topic: body.topic, participants: body.participants, policy: body.policy || {}, room: body.room });
      sendJson(res, 200, { ok: true, discussion: record });
      return true;
    }

    if (p.startsWith('/api/discussions/') && p.endsWith('/stop') && req.method === 'POST') {
      const id = p.split('/')[3];
      const record = discussions.stop(id, 'stopped by operator');
      if (!record) { sendJson(res, 404, { error: 'not found' }); return true; }
      sendJson(res, 200, { ok: true, discussion: record });
      return true;
    }

    if (p.startsWith('/api/discussions/') && req.method === 'GET') {
      const id = p.split('/')[3];
      const record = discussions.get(id);
      if (!record) { sendJson(res, 404, { error: 'not found' }); return true; }
      sendJson(res, 200, { discussion: record });
      return true;
    }

    return false;
  };
}
