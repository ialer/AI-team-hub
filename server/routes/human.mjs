import { sendJson, readBody } from '../http.mjs';

export function createHumanRoutes(ctx) {
  const { config, hub, messages, sse, dialogs, registry } = ctx;
  return async function humanRoutes(req, res, url, p) {
    if (p === '/api/state' && req.method === 'GET') { sendJson(res, 200, hub.state()); return true; }

    if (p === '/api/messages' && req.method === 'GET') {
      const room = url.searchParams.get('room') || config.defaultRoom;
      const after = Number(url.searchParams.get('after') || 0);
      sendJson(res, 200, { messages: messages.since({ room, after }) });
      return true;
    }

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
      sendJson(res, 200, { ok: true, message });
      return true;
    }

    if (p === '/api/stream' && req.method === 'GET') {
      sse.attach(req, res, [['presence', { agents: registry.publicView() }]]);
      return true;
    }

    if (p === '/api/dialogs' && req.method === 'GET') { sendJson(res, 200, { dialogs: dialogs.all() }); return true; }

    if (p.startsWith('/api/dialogs/') && req.method === 'POST') {
      const [, , , id, action] = p.split('/');
      const body = await readBody(req);
      if (action === 'submit') { sendJson(res, 200, hub.submitDialog({ dialogId: id, values: body.values || {} })); return true; }
      if (action === 'cancel') { sendJson(res, 200, hub.cancelDialog({ dialogId: id })); return true; }
      sendJson(res, 404, { error: 'unknown action' });
      return true;
    }

    return false;
  };
}
