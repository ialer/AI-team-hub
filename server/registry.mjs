/**
 * Agent registry: who exists, who is connected, and how they authenticate.
 *
 * Agent tokens are opaque random secrets stored server-side (TokenStore), so the
 * hub can verify, revoke, and disable them per agent. The admin token stays a
 * shared secret used only to gate admin endpoints. If no TokenStore is supplied
 * (e.g. some unit tests), verification falls back to HMAC derivation.
 */
import crypto from 'node:crypto';

export class AgentRegistry {
  constructor(agents, { adminToken = '', tokens = null } = {}) {
    // Normalise at load so config-declared agents behave like joined ones:
    // enabled defaults to true and avatar/presence fields always exist.
    this.agents = new Map(agents.map((a) => [a.id, { ...a, enabled: a.enabled !== false, avatar: a.avatar || null }]));
    this.adminToken = adminToken;
    this.tokens = tokens;
    this.presence = new Map(); // id -> { online, since, lastSeen, sessionId }
    this.connections = new Map(); // id -> count of live pollers
  }

  get(id) {
    return this.agents.get(id) || null;
  }

  /**
   * Register an agent at runtime.
   *
   * This is what makes onboarding possible without editing config.json or
   * restarting the hub: a joined agent exists immediately, and the caller
   * persists it so it survives a restart.
   */
  addAgent(agent) {
    if (!agent || !agent.id) throw new Error('agent needs an id');
    const normalised = {
      id: String(agent.id),
      name: agent.name || agent.id,
      role: agent.role || '',
      color: agent.color || '#7f8fa8',
      avatar: agent.avatar || null,
      mode: agent.mode === 'push' ? 'push' : 'connector',
      adapter: agent.adapter || null,
      adapterConfig: agent.config || {},
      sessionId: agent.sessionId || null,
      enabled: agent.enabled !== false,
      // Where it came from, so an operator can tell config-declared agents from
      // ones that joined with an invite code.
      source: agent.source || 'config',
    };
    this.agents.set(normalised.id, normalised);
    return normalised;
  }

  removeAgent(id) {
    this.presence.delete(id);
    this.connections.delete(id);
    return this.agents.delete(id);
  }

  /** Agents that were added at runtime (not declared in config.json). */
  joined() {
    return this.list().filter((a) => a.source === 'join');
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
      // A push agent holds no connection, so it has no presence of its own. It
      // is reachable until a call proves otherwise — that is what the operator
      // needs to know, and it beats showing a working agent as offline forever.
      const online = a.mode === 'push'
        ? (a.enabled !== false && p.reachable !== false)
        : p.online === true;
      view[a.id] = {
        id: a.id,
        name: a.name,
        role: a.role,
        color: a.color,
        avatar: a.avatar || null,
        mode: a.mode,
        enabled: a.enabled,
        online,
        lastSeen: p.lastSeen || null,
      };
    }
    return view;
  }

  /** Record whether a push agent answered the last time the hub called it. */
  markReachable(agentId, ok) {
    const prev = this.presence.get(agentId) || {};
    this.presence.set(agentId, { ...prev, reachable: ok, lastSeen: Date.now() });
  }

  /* ── tokens ───────────────────────────────────────────── */

  /** The agent's token. With a TokenStore this mints one on first use. */
  tokenFor(agentId) {
    if (this.tokens) return this.tokens.ensure(agentId);
    if (!this.adminToken) return '';
    return crypto
      .createHmac('sha256', this.adminToken)
      .update(`agent:${agentId}`)
      .digest('base64url')
      .slice(0, 32);
  }

  /** Constant-time comparison against the expected token for this agent. */
  verify(agentId, token) {
    if (this.tokens) return this.tokens.verify(agentId, token);
    const expected = this.tokenFor(agentId);
    if (!expected || !token) return false;
    const a = Buffer.from(String(token));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /** Enable or disable an agent. Disabled agents cannot authenticate or be woken. */
  setEnabled(agentId, enabled) {
    const a = this.agents.get(agentId);
    if (!a) return null;
    a.enabled = Boolean(enabled);
    return a;
  }

  /** Change an agent's avatar (emoji or image URL). */
  setAvatar(agentId, avatar) {
    const a = this.agents.get(agentId);
    if (!a) return null;
    a.avatar = avatar || null;
    return a;
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
