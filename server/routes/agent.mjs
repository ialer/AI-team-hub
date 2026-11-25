import { sendJson, readBody, authenticateAgent } from '../http.mjs';

export function createAgentRoutes(ctx) {
  const { config, hub, registry, sse, wakeQueue, sessions, log, contract } = ctx;
  return async function agentRoutes(req, res, url, p) {
    if (p === '/api/agent/poll' && req.method === 'GET') {
      const agent = authenticateAgent(registry, url, req);
      registry.addConnection(agent.id);
      registry.markSeen(agent.id, { online: true });
      sse.broadcast('presence', { agents: registry.publicView() });

      let closed = false;
      req.on('close', () => {
        closed = true;
        const remaining = registry.removeConnection(agent.id);
        if (remaining === 0) hub.agentWentOffline(agent.id);
        sse.broadcast('presence', { agents: registry.publicView() });
      });

      const timeoutMs = Math.min(
        Number(url.searchParams.get('timeout') || config.pollTimeout) * 1000,
        config.pollTimeout * 1000,
      );
      const events = await wakeQueue.wait(agent.id, timeoutMs);
      if (closed) return true;
      sendJson(res, 200, { events, sessionId: registry.sessionFor(agent.id) });
      return true;
    }

    if (p === '/api/agent/reply' && req.method === 'POST') {
      const body = await readBody(req);
      const agent = authenticateAgent(registry, new URL(req.url, 'http://x'), req);
      const message = hub.reply({
        agentId: agent.id,
        msgId: body.msgId,
        text: body.text,
        sessionId: body.sessionId,
      });
      if (body.sessionId) sessions.set(agent.id, body.sessionId);
      sendJson(res, 200, { ok: true, message });
      return true;
    }

    if (p === '/api/agent/hello' && req.method === 'POST') {
      const body = await readBody(req);
      const agent = authenticateAgent(registry, new URL(req.url, 'http://x'), req);
      if (body.sessionId) {
        registry.markSeen(agent.id, { online: true, sessionId: body.sessionId });
        sessions.set(agent.id, body.sessionId);
      }
      sendJson(res, 200, {
        ok: true,
        agent: { id: agent.id, name: agent.name, mode: agent.mode },
        sessionId: registry.sessionFor(agent.id),
        contract: contract.current(),
        transports: {
          poll: `/api/agent/poll?agent=${encodeURIComponent(agent.id)}`,
          stream: '/api/agent/stream',
          ws: `/ws?role=agent&agent=${encodeURIComponent(agent.id)}&token=<token>`,
        },
      });
      return true;
    }

    /* ── agent: confirm it has applied a contract version ── */
    if (p === '/api/agent/contract-ack' && req.method === 'POST') {
      const agent = authenticateAgent(registry, url, req);
      const body = await readBody(req);
      contract.ack(agent.id, String(body.version || ''), String(body.sha256 || ''));
      log.line(`contract ack ${agent.id} v${body.version}`);
      sendJson(res, 200, { ok: true });
      return true;
    }

    /* ── agent: streaming turn ──
       POST a body of newline-delimited JSON chunks:
         {"type":"delta","text":"..."}
         {"type":"tool","name":"read_file","detail":"/var/log/app.log"}
         {"type":"final","text":"...","sessionId":"..."}
       Every delta is forwarded to browsers immediately; only the final text is
       written to the log. Works with `curl -N --data-binary @-`. */
    if (p === '/api/agent/stream' && req.method === 'POST') {
      const agent = authenticateAgent(registry, url, req);
      const room = req.headers['x-room'] || url.searchParams.get('room') || config.defaultRoom;
      const msgId = Number(req.headers['x-msg-id'] || url.searchParams.get('msgId') || 0) || null;

      hub.beginStream(agent.id, msgId, room);

      let pending = '';
      let sawFinal = false;
      let finalText = '';
      let finalSession = '';
      let finished = false;

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
        sendJson(res, 200, { ok: true, message });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    return false;
  };
}
