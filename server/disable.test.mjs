/**
 * Disabling an agent must stop it everywhere: HTTP auth, wakeability, and it
 * must be distinguishable from "unknown" so operators get a clear reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRegistry } from './registry.mjs';
import { TokenStore } from './token-store.mjs';
import { authenticateAgent } from './http.mjs';
import { joinInstructions } from './instructions.mjs';

function memStore() {
  const m = new Map();
  return { get:(k,d)=>m.has(k)?m.get(k):d, set:(k,v)=>{m.set(k,v);return v;}, delete:(k)=>m.delete(k), all:()=>Object.fromEntries(m) };
}
function req(token) { return { headers: { 'x-agent-id': 'a', 'x-agent-token': token } }; }
function url() { return new URL('http://x/api/agent/poll'); }

test('disabled agent is refused by authenticateAgent with 403', () => {
  const ts = new TokenStore(memStore());
  const reg = new AgentRegistry([{ id: 'a' }], { adminToken: 'x', tokens: ts });
  const tok = reg.tokenFor('a');
  assert.equal(authenticateAgent(reg, url(), req(tok)).id, 'a');
  reg.setEnabled('a', false);
  assert.throws(() => authenticateAgent(reg, url(), req(tok)), (e) => e.status === 403 && /disabled/.test(e.message));
  reg.setEnabled('a', true);
  assert.equal(authenticateAgent(reg, url(), req(tok)).id, 'a');
});

test('a disabled agent is excluded from wakeable and mention resolution input', () => {
  const ts = new TokenStore(memStore());
  const reg = new AgentRegistry([{ id: 'a' }, { id: 'b' }], { adminToken: 'x', tokens: ts });
  reg.setEnabled('a', false);
  assert.deepEqual(reg.wakeable().map((x) => x.id), ['b']);
});

test('identity fields with quotes/newlines produce a valid JSON example', () => {
  const text = joinInstructions({ hub: 'http://h', code: 'C', identity: { name: 'A"B\nC', role: 'r"x', dept: 'd' } });
  const m = text.match(/\{[\s\S]*?"code"[\s\S]*?\}/);
  assert.ok(m, 'example body present');
  assert.doesNotThrow(() => JSON.parse(m[0]), 'example body must be valid JSON');
});
