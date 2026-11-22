#!/usr/bin/env node
/**
 * Print the derived token for every configured agent.
 *
 * Tokens are HMAC(adminToken, "agent:<id>") — deterministic, so there is no
 * token table to rotate. Change the admin token and every agent token changes.
 *
 *   node server/tokens.mjs              # all agents
 *   node server/tokens.mjs dave     # one agent
 *   node server/tokens.mjs --json       # machine-readable (for scripts)
 */
import { loadConfig } from './config.mjs';
import { AgentRegistry } from './registry.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const only = args.find((a) => !a.startsWith('-'));

const config = loadConfig();
if (!config.adminToken) {
  console.error('adminToken is not configured — set "adminToken" in config.json or HUB_ADMIN_TOKEN');
  process.exit(1);
}

const registry = new AgentRegistry(config.agents, { adminToken: config.adminToken });
const rows = config.agents
  .filter((a) => !only || a.id === only)
  .map((a) => ({ id: a.id, name: a.name, mode: a.mode, token: registry.tokenFor(a.id) }));

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
