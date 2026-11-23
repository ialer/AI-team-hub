import { sendJson, sendText, readBody, bearer } from '../http.mjs';
import { joinInstructions } from '../instructions.mjs';

export function createAdminRoutes(ctx) {
  const { config, hub, registry, invites, persistJoined, persistOverrides, log, tokenStore } = ctx;
  return async function adminRoutes(req, res, url, p) {
    if (p === '/api/adapters' && req.method === 'GET') {
      const { listAdapters } = await import('../adapters/index.mjs');
      sendJson(res, 200, { adapters: listAdapters() });
      return true;
    }

    if (p === '/api/join' && req.method === 'POST') {
      const body = await readBody(req);
      const peek = invites.peek(body.code);
      if (!peek.ok) { sendJson(res, 403, { error: peek.reason }); return true; }
      const meta = peek.invite.meta || {};
      const id = String(meta.id || body.id || '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/i.test(id)) { sendJson(res, 400, { error: 'id must be 2-32 chars: letters, digits, - or _' }); return true; }
      if (registry.get(id)) { sendJson(res, 409, { error: `agent "${id}" already exists` }); return true; }
      const check = invites.consume(body.code);
      if (!check.ok) { sendJson(res, 403, { error: check.reason }); return true; }

      const agent = registry.addAgent({
        id,
        name: String(meta.name || body.name || id).slice(0, 40),
        role: String(meta.role || body.role || '').slice(0, 40),
        avatar: meta.avatar || body.avatar || null,
        color: body.color || '#7f88a8', mode: 'connector', source: 'join',
      });
      persistJoined();
      hub.refreshAgents();
      const token = registry.tokenFor(id);
      log.line(`join ${id} (${agent.name}) via invite ${check.invite.code}`);
      sendJson(res, 200, {
        ok: true, agent: { id, name: agent.name, role: agent.role }, token,
        hub: `http://${req.headers.host}`,
        transports: { poll: '/api/agent/poll', stream: '/api/agent/stream', ws: '/ws?role=agent' },
      });
      return true;
    }

    if (p === '/api/admin/invites' && (req.method === 'GET' || req.method === 'POST')) {
      const token = req.headers['x-admin-token'] || bearer(req) || url.searchParams.get('admin');
      if (!registry.verifyAdmin(token)) { sendJson(res, 401, { error: 'admin token required' }); return true; }
      if (req.method === 'GET') { sendJson(res, 200, { invites: invites.list(), agents: registry.list() }); return true; }
      const body = await readBody(req).catch(() => ({}));
      const invite = invites.create({ ttlSec: body.ttlSec, uses: body.uses, note: body.note });
      log.line(`invite ${invite.code} created (${invite.maxUses} use, ${Math.round((invite.expiresAt - Date.now()) / 60000)}min)`);
      sendJson(res, 200, {
        ok: true, invite,
        // Ready-to-paste command for the new agent's machine.
        command: `curl -fsSL http://${req.headers.host}/connect.mjs -o connect.mjs && node connect.mjs --hub http://${req.headers.host} --code ${invite.code}`,
      });
      return true;
    }

    if (p.startsWith('/api/admin/agents/') && req.method === 'DELETE') {
      const token = req.headers['x-admin-token'] || bearer(req) || url.searchParams.get('admin');
      if (!registry.verifyAdmin(token)) { sendJson(res, 401, { error: 'admin token required' }); return true; }
      const id = decodeURIComponent(p.split('/').pop());
      const agent = registry.get(id);
      if (!agent) { sendJson(res, 404, { error: 'not found' }); return true; }
      if (agent.source !== 'join') { sendJson(res, 409, { error: `"${id}" is declared in config.json — remove it there and restart` }); return true; }
      registry.removeAgent(id);
      tokenStore.revoke(id);
      persistJoined();
      persistOverrides(); // drop its override entry too
      hub.refreshAgents();
      log.line(`agent ${id} removed by admin`);
      sendJson(res, 200, { ok: true, removed: id });
      return true;
    }

    /* ── admin: grant a one-time access bundle ──
       Creates an invite bound to a named agent identity and returns the protocol
       text the operator pastes into the new agent. The code inside is one-shot. */
    if (p === '/api/admin/grant' && req.method === 'POST') {
      const token = req.headers['x-admin-token'] || bearer(req) || url.searchParams.get('admin');
      if (!registry.verifyAdmin(token)) { sendJson(res, 401, { error: 'admin token required' }); return true; }
      const body = await readBody(req).catch(() => ({}));
      const dept = String(body.dept || '').slice(0, 40);
      const name = String(body.name || '').trim().slice(0, 40);
      const id = String(body.id || '').trim();
      const role = String(body.role || '').slice(0, 40);
      const avatar = body.avatar ? String(body.avatar).slice(0, 200) : null;
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/i.test(id)) { sendJson(res, 400, { error: 'id must be 2-32 chars: letters, digits, - or _' }); return true; }
      if (registry.get(id)) { sendJson(res, 409, { error: `agent "${id}" already exists` }); return true; }
      const ttlSec = Number(body.ttlSec) > 0 ? Number(body.ttlSec) : undefined;
      const invite = invites.create({ ttlSec, uses: 1, note: 'grant:' + id, meta: { id, name: name || id, role, avatar } });
      log.line(`grant ${id} (${name || id}) code ${invite.code} ttl ${Math.round((invite.expiresAt - Date.now()) / 60000)}min`);
      const ttlMinutes = Math.round((invite.expiresAt - Date.now()) / 60000);
      const protocol = joinInstructions({ hub: `http://${req.headers.host}`, code: invite.code, ttlMinutes, identity: { dept, id, name: name || id, role, avatar } });
      sendJson(res, 200, { ok: true, invite, ttlMinutes, protocol });
      return true;
    }

    /* ── admin: enable / disable an agent ── */
    if (p.startsWith('/api/admin/agents/') && (p.endsWith('/disable') || p.endsWith('/enable')) && req.method === 'POST') {
      const token = req.headers['x-admin-token'] || bearer(req) || url.searchParams.get('admin');
      if (!registry.verifyAdmin(token)) { sendJson(res, 401, { error: 'admin token required' }); return true; }
      const parts = p.split('/').filter(Boolean); // api, admin, agents, <id>, <action>
      const id = decodeURIComponent(parts[3]);
      const enable = parts[4] === 'enable';
      const agent = registry.setEnabled(id, enable);
      if (!agent) { sendJson(res, 404, { error: 'not found' }); return true; }
      if (agent.source === 'join') persistJoined();
      if (!enable && typeof ctx.closeAgent === 'function') ctx.closeAgent(id);
      persistOverrides();
      hub.refreshAgents();
      log.line(`agent ${id} ${enable ? 'enabled' : 'disabled'} by admin`);
      sendJson(res, 200, { ok: true, agent: { id, enabled: agent.enabled } });
      return true;
    }

    /* ── admin: change an agent's avatar ── */
    if (p.startsWith('/api/admin/agents/') && p.endsWith('/avatar') && req.method === 'POST') {
      const token = req.headers['x-admin-token'] || bearer(req) || url.searchParams.get('admin');
      if (!registry.verifyAdmin(token)) { sendJson(res, 401, { error: 'admin token required' }); return true; }
      const body = await readBody(req);
      const id = decodeURIComponent(p.split('/').filter(Boolean)[3]);
      const agent = registry.setAvatar(id, body.avatar ? String(body.avatar).slice(0, 200) : null);
      if (!agent) { sendJson(res, 404, { error: 'not found' }); return true; }
      if (agent.source === 'join') persistJoined();
      persistOverrides();
      hub.refreshAgents();
      sendJson(res, 200, { ok: true, agent: { id, avatar: agent.avatar } });
      return true;
    }

    if (p === '/api/join/instructions' && req.method === 'GET') {
      const code = url.searchParams.get('code') || undefined;
      const invite = code ? invites.peek(code) : null;
      const ttl = invite && invite.ok ? Math.round((invite.invite.expiresAt - Date.now()) / 60000) : 30;
      const body = joinInstructions({ hub: `http://${req.headers.host}`, code: code || '<加入码>', ttlMinutes: ttl });
      sendText(res, 200, body);
      return true;
    }

    if (p === '/api/hub' && req.method === 'GET') {
      sendJson(res, 200, {
        name: 'AI-team-hub',
        version: config.version || '0.3.0',
        agents: registry.list().length,
        online: Object.values(registry.publicView()).filter((a) => a.online).length,
        joinPolicy: 'invite-code',
      });
      return true;
    }

    return false;
  };
}
