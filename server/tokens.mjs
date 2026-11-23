#!/usr/bin/env node
/**
 * Print the stored token for every configured agent.
 *
 * Tokens are opaque random secrets issued and stored by the hub (data/tokens.json).
 * They can be revoked per agent; deleting an agent's local state requires a new
 * grant from the hub — the secret cannot be recomputed.
 *
 *   node server/tokens.mjs              # all agents
 *   node server/tokens.mjs dave     # one agent
 *   node server/tokens.mjs --json       # machine-readable (for scripts)
 */
import { loadConfig } from './config.mjs';
import { AgentRegistry } from './registry.mjs';
import { TokenStore } from './token-store.mjs';
import { JsonStore } from './store.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const only = args.find((a) => !a.startsWith('-'));

const config = loadConfig();

const tokenStore = new TokenStore(new JsonStore(config.dataDir, 'tokens.json'));
const registry = new AgentRegistry(config.agents, { adminToken: config.adminToken, tokens: tokenStore });
const all = tokenStore.all();
const rows = Object.keys(all)
  .filter((id) => !only || id === only)
  .map((id) => ({ id, name: (registry.get(id) && registry.get(id).name) || id, token: all[id] }));

if (!rows.length) {
  console.error(only ? `no agent with id "${only}"` : 'no agents configured');
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const width = Math.max(...rows.map((r) => r.id.length), 2);
  for (const r of rows) {
    console.log(`${r.id.padEnd(width)}  ${r.token}`);
  }
}
