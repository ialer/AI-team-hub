/**
 * Build every long-lived hub instance in one place, then hand them to the
 * route modules and the realtime layer. index.mjs stays a thin bootstrap.
 */
import { loadConfig } from './config.mjs';
import { MessageLog, JsonStore } from './store.mjs';
import { AgentRegistry } from './registry.mjs';
import { SseHub, WakeQueue } from './transport.mjs';
import { Hub } from './hub.mjs';
import { createSurfaces } from './surfaces.mjs';
import { createContract } from './contract.mjs';
import { createStorage } from './storage.mjs';
import { DiscussionManager } from './discussions.mjs';
import { InviteStore } from './invites.mjs';
import { TokenStore } from './token-store.mjs';
import { createLogger } from './http.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import './adapters/builtin.mjs'; // registers the built-in adapters

export function createContext() {
  const config = loadConfig();
  const log = createLogger(config);
  const messages = new MessageLog(config.dataDir);
  const sessions = new JsonStore(config.dataDir, 'sessions.json');
  const dialogs = new JsonStore(config.dataDir, 'dialogs.json');
  const tokenStore = new TokenStore(new JsonStore(config.dataDir, 'tokens.json', {}, { mode: 0o600 }));
  // Migrate an already-deployed tokens.json to 0600 even if no write happens.
  try { fs.chmodSync(path.join(config.dataDir, 'tokens.json'), 0o600); } catch { /* not created yet / non-posix */ }
  const registry = new AgentRegistry(config.agents, { adminToken: config.adminToken || '', tokens: tokenStore });
  const sse = new SseHub({ keepAliveMs: config.sseKeepAliveMs });
  const wakeQueue = new WakeQueue();

  // Rehydrate persisted session ids so restarts keep conversation continuity.
  for (const agent of config.agents) {
    const sid = sessions.get(agent.id, null);
    if (sid) registry.markSeen(agent.id, { online: false, sessionId: sid });
  }

  // Migration: agents that existed before tokens were stored get their legacy
  // HMAC value as their initial stored token, so live connectors keep working.
  // From then on the token is revocable (delete the entry) like any other.
  const legacyToken = (id) => crypto.createHmac('sha256', config.adminToken || '')
    .update(`agent:${id}`).digest('base64url').slice(0, 32);
  for (const agent of config.agents) {
    if (config.adminToken && !tokenStore.peek(agent.id)) tokenStore.seed(agent.id, legacyToken(agent.id));
    tokenStore.ensure(agent.id);
  }
  const hub = new Hub({ config, log, messages, registry, sse, wakeQueue, dialogs });
  const surfaces = createSurfaces({ dataDir: config.dataDir, log });
  const contract = createContract({ contractFile: config.contractFile, dataDir: config.dataDir, log });
  const storage = createStorage({ dataDir: config.dataDir, storage: config.storage, log });

  /* ── runtime-joined agents ──
     Agents that arrived with an invite code live here, not in config.json, so
     onboarding never requires editing the hub's config or restarting it. */
  const joinedStore = new JsonStore(config.dataDir, 'agents.json');
  const invites = new InviteStore(new JsonStore(config.dataDir, 'invites.json'));
  const joinedAgents = Object.values(joinedStore.all());
  for (const a of joinedAgents) {
    try {
      registry.addAgent({ ...a, source: 'join' });
      const sid = sessions.get(a.id, null);
      if (sid) registry.markSeen(a.id, { online: false, sessionId: sid });
    } catch (e) {
      log.line(`skipped bad joined agent ${a && a.id}: ${e.message}`);
    }
  }
  if (joinedAgents.length) log.line(`restored ${joinedAgents.length} joined agent(s) from data/agents.json`);
  // Seed tokens for restored joined agents now that they exist in the registry.
  for (const agent of registry.joined()) {
    if (config.adminToken && !tokenStore.peek(agent.id)) tokenStore.seed(agent.id, legacyToken(agent.id));
    tokenStore.ensure(agent.id);
  }
  invites.prune();

  function persistJoined() {
    const map = {};
    for (const a of registry.joined()) {
      const { source, ...rest } = a;
      map[a.id] = rest;
    }
    joinedStore.data = map;
    joinedStore.save();
  }

  /* ── operator overrides ──
     config.json is only a seed. Runtime state (enabled / avatar / deleted) is
     stored in overrides.json, so the operator can disable or remove even a
     config-declared agent from the UI without editing the config or restarting.
     Removal is a tombstone, not a config edit: it is reversible at runtime. */
  const overridesStore = new JsonStore(config.dataDir, 'overrides.json');
  const overrides = overridesStore.all();
  const tombstoned = new Set();
  for (const [id, ov] of Object.entries(overrides)) {
    if (!registry.get(id)) continue;
    if (ov.deleted === true) { tombstoned.add(id); registry.removeAgent(id); continue; }
    if (Object.prototype.hasOwnProperty.call(ov, 'enabled')) registry.setEnabled(id, ov.enabled);
    if (Object.prototype.hasOwnProperty.call(ov, 'avatar')) registry.setAvatar(id, ov.avatar);
  }
  function persistOverrides() {
    // Joined agents keep their own record in agents.json; only config-declared
    // ones plus tombstones live here, so there is one source of truth each.
    const map = {};
    for (const a of registry.list()) {
      if (a.source === 'join') continue;
      map[a.id] = { enabled: a.enabled !== false, avatar: a.avatar || null };
    }
    for (const id of tombstoned) map[id] = { deleted: true };
    overridesStore.data = map;
    overridesStore.save();
  }
  /** Remove any agent. config-declared ones get a tombstone so it sticks. */
  function removeAgent(id) {
    const a = registry.get(id);
    if (!a) return null;
    if (a.source === 'config') tombstoned.add(id);
    registry.removeAgent(id);
    tokenStore.revoke(id);
    if (a.source === 'join') persistJoined();
    persistOverrides();
    return a;
  }
  /** Undo a removal of a config-declared agent (joined ones need a new grant). */
  function restoreAgent(id) {
    const seed = config.agents.find((x) => x.id === id);
    if (!seed) return null;
    tombstoned.delete(id);
    const a = registry.addAgent({ ...seed, source: 'config' });
    persistOverrides();
    return a;
  }

  const discussions = new DiscussionManager({
    hub, registry, sse, log,
    store: new JsonStore(config.dataDir, 'discussions.json'),
    config: { defaultRoom: config.defaultRoom, selector: config.discussion && config.discussion.selector },
  });

  return {
    config, log, messages, sessions, dialogs, registry, sse, wakeQueue,
    hub, surfaces, storage, invites, discussions, contract, persistJoined, persistOverrides, tokenStore,
    removeAgent, restoreAgent, deletedIds: () => [...tombstoned],
  };
}
