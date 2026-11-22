/**
 * Agent registry: who exists, who is connected, and how they authenticate.
 *
 * Tokens are derived from the admin token plus the agent id (HMAC), so there is
 * no token table to keep in sync: rotate the admin token and every agent token
 * rotates with it. The hub only compares digests.
 */
import crypto from 'node:crypto';

export class AgentRegistry {
  constructor(agents, { adminToken = '' } = {}) {
    this.agents = new Map(agents.map((a) => [a.id, { ...a }]));
    this.adminToken = adminToken;
    this.presence = new Map(); // id -> { online, since, lastSeen, sessionId }
    this.connections = new Map(); // id -> count of live pollers
  }

  get(id) {
    return this.agents.get(id) || null;
  }

  list() {
    return [...this.agents.values()];
  }

  /** Enabled agents only — the ones allowed to be woken. */
  wakeable() {
    return this.list().filter((a) => a.enabled);
  }

  publicView() {
    const view = {};
    for (const a of this.agents.values()) {
      const p = this.presence.get(a.id) || {};
      view[a.id] = {
        id: a.id,
        name: a.name,
        role: a.role,
        color: a.color,
        mode: a.mode,
        enabled: a.enabled,
        online: p.online === true,
        lastSeen: p.lastSeen || null,
      };
    }
    return view;
  }

  /* ── tokens ───────────────────────────────────────────── */

  tokenFor(agentId) {
    if (!this.adminToken) return '';
    return crypto
      .createHmac('sha256', this.adminToken)
      .update(`agent:${agentId}`)
      .digest('base64url')
      .slice(0, 32);
  }

  /** Constant-time comparison against the expected token for this agent. */
  verify(agentId, token) {
    const expected = this.tokenFor(agentId);
    if (!expected || !token) return false;
    const a = Buffer.from(String(token));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  verifyAdmin(token) {
    if (!this.adminToken) return true; // no admin token configured = open (dev)
    const a = Buffer.from(String(token || ''));
    const b = Buffer.from(this.adminToken);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /* ── presence ─────────────────────────────────────────── */

  markSeen(agentId, { online = true, sessionId } = {}) {
    const prev = this.presence.get(agentId) || {};
    const next = {
      online,
      since: prev.online === online ? prev.since : Date.now(),
      lastSeen: Date.now(),
      sessionId: sessionId || prev.sessionId || null,
    };
    this.presence.set(agentId, next);
    if (sessionId) {
      const agent = this.agents.get(agentId);
      if (agent) agent.sessionId = sessionId;
    }
    return next;
  }

  markOffline(agentId) {
    const prev = this.presence.get(agentId);
    if (!prev) return;
    this.presence.set(agentId, { ...prev, online: false });
  }

  sessionFor(agentId) {
    const agent = this.agents.get(agentId);
    const p = this.presence.get(agentId) || {};
    return p.sessionId || (agent && agent.sessionId) || null;
  }

  /** Track concurrent pollers so a single disconnect does not flip presence. */
  addConnection(agentId) {
    const n = (this.connections.get(agentId) || 0) + 1;
    this.connections.set(agentId, n);
    return n;
  }

  removeConnection(agentId) {
    const n = Math.max(0, (this.connections.get(agentId) || 0) - 1);
    this.connections.set(agentId, n);
    if (n === 0) this.markOffline(agentId);
    return n;
  }

  connectionCount(agentId) {
    return this.connections.get(agentId) || 0;
  }
}
