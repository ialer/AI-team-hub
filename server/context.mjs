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
import { createStorage } from './storage.mjs';
import { DiscussionManager } from './discussions.mjs';
import { InviteStore } from './invites.mjs';
import { TokenStore } from './token-store.mjs';
import { createLogger } from './http.mjs';
import fs from 'node:fs';
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

  // Config-declared agents also get a stored token so verification is uniform.
  for (const agent of config.agents) tokenStore.ensure(agent.id);

  const hub = new Hub({ config, log, messages, registry, sse, wakeQueue, dialogs });
  const surfaces = createSurfaces({ dataDir: config.dataDir, log });
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
     enabled/avatar chosen at runtime must survive a restart even for agents
     declared in config.json (those are otherwise reset from config on boot). */
  const overridesStore = new JsonStore(config.dataDir, 'overrides.json');
  const overrides = overridesStore.all();
  for (const [id, ov] of Object.entries(overrides)) {
    if (!registry.get(id)) continue;
    if (Object.prototype.hasOwnProperty.call(ov, 'enabled')) registry.setEnabled(id, ov.enabled);
    if (Object.prototype.hasOwnProperty.call(ov, 'avatar')) registry.setAvatar(id, ov.avatar);
  }
  function persistOverrides() {
    // Only config-declared agents need an override: joined agents persist their
    // own enabled/avatar in agents.json via persistJoined, so writing them here
    // too would create two sources of truth.
    const map = {};
    for (const a of registry.list()) {
      if (a.source === 'join') continue;
      map[a.id] = { enabled: a.enabled !== false, avatar: a.avatar || null };
    }
    overridesStore.data = map;
    overridesStore.save();
  }

  const discussions = new DiscussionManager({
    hub, registry, sse, log,
    store: new JsonStore(config.dataDir, 'discussions.json'),
    config: { defaultRoom: config.defaultRoom, selector: config.discussion && config.discussion.selector },
  });

  return {
    config, log, messages, sessions, dialogs, registry, sse, wakeQueue,
    hub, surfaces, storage, invites, discussions, persistJoined, persistOverrides, tokenStore,
  };
}
