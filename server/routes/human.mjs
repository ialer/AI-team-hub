import { sendJson, readBody } from '../http.mjs';

export function createHumanRoutes(ctx) {
  const { config, hub, messages, sse, dialogs, registry, discussions } = ctx;
  return async function humanRoutes(req, res, url, p) {
    if (p === '/api/state' && req.method === 'GET') { sendJson(res, 200, hub.state()); return true; }

    /* Aggregate activity metrics — counts only, never message content. */
    if (p === '/api/metrics' && req.method === 'GET') {
      const all = typeof messages.all === 'function' ? messages.all() : [];
      const bySender = {};
      for (const m of all) bySender[m.from] = (bySender[m.from] || 0) + 1;

      const discs = discussions ? discussions.list() : [];
      const strategies = {};
      const gaps = [];
      let turns = 0;
      for (const d of discs) {
        const s = (d.policy && d.policy.strategy) || 'serial';
        strategies[s] = (strategies[s] || 0) + 1;
        if (!Array.isArray(d.turns) || d.turns.length < 2) { turns += (d.turns || []).length; continue; }
        turns += d.turns.length;
        for (let i = 1; i < d.turns.length; i++) {
          const g = (d.turns[i].at - d.turns[i - 1].at) / 1000;
          if (g > 0 && g < 600) gaps.push(g);
        }
      }
      gaps.sort((x, y) => x - y);
      const pick = (q) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))] : null);

      const view = registry.publicView();
      const list = Object.values(view);
      sendJson(res, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        agents: { total: list.length, online: list.filter((a) => a.online).length },
        messages: { total: all.length, rooms: messages.rooms().length, bySender },
        discussions: {
          total: discs.length,
          running: discs.filter((d) => d.status === 'running').length,
          turns,
          strategies,
          turnGapSec: gaps.length
            ? { median: Number(pick(0.5).toFixed(1)), p90: Number(pick(0.9).toFixed(1)) }
            : null,
        },
      });
      return true;
    }

    if (p === '/api/messages' && req.method === 'GET') {
      const room = url.searchParams.get('room') || config.defaultRoom;
      const after = Number(url.searchParams.get('after') || 0);
      const taskId = url.searchParams.get('taskId') || null;
      sendJson(res, 200, { messages: messages.since({ room, after, taskId }) });
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
        taskId: body.taskId || null,
        threadId: body.threadId || null,
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
