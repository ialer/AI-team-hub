/**
 * WebSocket transport (optional). An agent that connects here gets wakes pushed
 * instead of polled and can stream deltas over the same socket. Agents that only
 * speak HTTP are unaffected — the poll queue remains the fallback.
 */
import { attachWebSocket } from './ws.mjs';

export function attachRealtime(server, ctx) {
  const { config, hub, registry, sse, sessions, log } = ctx;
  const wsAgents = new Map(); // agentId -> WsConnection

  attachWebSocket(server, {
    path: '/ws',
    authorize(req, url) {
      const role = url.searchParams.get('role') || 'agent';
      if (role !== 'agent') return true; // browser sockets need no token
      const id = url.searchParams.get('agent') || '';
      const token = url.searchParams.get('token') || '';
      const agent = registry.get(id);
      return Boolean(agent) && agent.enabled !== false && registry.verify(id, token);
    },
    onConnection(conn, req, url) {
      const role = url.searchParams.get('role') || 'agent';

      if (role !== 'agent') {
        const unsubscribe = sse.subscribe((event, data) => conn.sendJSON({ event, data }));
        conn.sendJSON({ event: 'hello', data: { transport: 'ws', role: 'browser' } });
        conn.on('close', unsubscribe);
        return;
      }

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
        // A long-lived socket must re-check authorisation: disabling an agent
        // has to stop an ALREADY connected socket, not just new handshakes.
        const me = registry.get(agentId);
        if (!me || me.enabled === false) { conn.close(1008, 'disabled'); return; }
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const type = msg.type;
        try {
          if (type === 'ack') { registry.markSeen(agentId, { online: true }); return; }
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
            const message = hub.endStream(agentId, { text: String(msg.text ?? hub.streamText(agentId)), sessionId: msg.sessionId || '' });
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

  // Deliver wakes over WS when the agent is connected and still enabled.
  hub.setWsSender((agentId, payload) => {
    const agent = registry.get(agentId);
    if (!agent || agent.enabled === false) return false;
    const conn = wsAgents.get(agentId);
    if (!conn || conn.closed) return false;
    return conn.sendJSON({ event: 'wake', data: payload });
  });

  /** Drop an agent's live socket (used when it is disabled). */
  ctx.closeAgent = (agentId) => {
    const conn = wsAgents.get(agentId);
    if (!conn) return false;
    wsAgents.delete(agentId);
    try { conn.close(1008, 'disabled'); } catch { /* already gone */ }
    return true;
  };
}
