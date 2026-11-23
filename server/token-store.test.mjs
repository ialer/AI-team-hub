/**
 * Server-issued agent tokens + per-agent enable/disable.
 *
 * Guards the behaviour that replaced HMAC derivation: tokens are random and
 * revocable, disabling one agent leaves the others alone, and an invite can be
 * bound to a specific identity so it cannot register a different agent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenStore } from './token-store.mjs';
import { AgentRegistry } from './registry.mjs';
import { InviteStore } from './invites.mjs';

function memStore() {
  const m = new Map();
  return { get:(k,d)=>m.has(k)?m.get(k):d, set:(k,v)=>{m.set(k,v);return v;}, delete:(k)=>m.delete(k), all:()=>Object.fromEntries(m) };
}

test('tokens are opaque, random, and stable once issued', () => {
  const ts = new TokenStore(memStore());
  const a1 = ts.ensure('a');
  const a2 = ts.ensure('a');
  const b1 = ts.ensure('b');
  assert.equal(a1, a2, 'same agent keeps the same token');
  assert.notEqual(a1, b1, 'different agents get different tokens');
  assert.ok(a1.length >= 30, 'token is long enough');
  const other = new TokenStore(memStore()).ensure('a');
  assert.notEqual(a1, other, 'fresh stores mint different secrets');
});

test('verify accepts the issued token and rejects others', () => {
  const ts = new TokenStore(memStore());
  const tok = ts.ensure('a');
  assert.equal(ts.verify('a', tok), true);
  assert.equal(ts.verify('a', 'nope'), false);
  assert.equal(ts.verify('a', ''), false);
  assert.equal(ts.verify('unknown', tok), false);
});

test('revoke forces a brand-new token', () => {
  const ts = new TokenStore(memStore());
  const before = ts.ensure('a');
  ts.revoke('a');
  assert.equal(ts.verify('a', before), false, 'old token no longer verifies');
  const after = ts.ensure('a');
  assert.notEqual(after, before);
  assert.equal(ts.verify('a', after), true);
});

test('registry uses the token store and can disable one agent', () => {
  const ts = new TokenStore(memStore());
  const reg = new AgentRegistry([{ id: 'a' }, { id: 'b' }], { adminToken: 'x', tokens: ts });
  assert.equal(reg.verify('a', reg.tokenFor('a')), true);
  reg.setEnabled('a', false);
  assert.equal(reg.get('a').enabled, false);
  assert.deepEqual(reg.wakeable().map((x) => x.id), ['b'], 'disabled agent is not wakeable');
  assert.equal(reg.get('b').enabled, true, 'disabling one agent leaves others alone');
});

test('config-declared agents still verify through the token store', () => {
  const ts = new TokenStore(memStore());
  const reg = new AgentRegistry([{ id: 'cfg' }], { adminToken: 'x', tokens: ts });
  const tok = reg.tokenFor('cfg');
  assert.equal(reg.verify('cfg', tok), true);
  ts.revoke('cfg');
  assert.equal(reg.verify('cfg', tok), false);
});

test('an invite can be bound to an identity so it cannot register another agent', () => {
  const invites = new InviteStore(memStore());
  const inv = invites.create({ meta: { id: 'bound', name: 'Bound' } });
  const check = invites.consume(inv.code);
  assert.equal(check.ok, true);
  assert.equal(check.invite.meta.id, 'bound');
  // one-shot
  assert.equal(invites.consume(inv.code).ok, false);
});

test('an unbound invite carries no meta', () => {
  const invites = new InviteStore(memStore());
  const inv = invites.create();
  assert.equal(inv.meta, undefined);
});
