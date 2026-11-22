/**
 * Invite codes.
 *
 * These guard the only public way into the hub, so the failure modes matter:
 * a code that never expires, one that works twice when it should not, or one
 * that rejects a legitimately pasted code with a space in it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { InviteStore, normalizeCode } from './invites.mjs';

function makeStore() {
  const m = new Map();
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    set: (k, v) => { m.set(k, v); return v; },
    delete: (k) => m.delete(k),
    all: () => Object.fromEntries(m),
  };
}

test('a fresh code can be used once by default', () => {
  const invites = new InviteStore(makeStore());
  const inv = invites.create();
  assert.equal(inv.code.length, 8);
  assert.equal(inv.maxUses, 1);
  assert.ok(inv.expiresAt > Date.now());

  const first = invites.consume(inv.code);
  assert.equal(first.ok, true);
  const second = invites.consume(inv.code);
  assert.equal(second.ok, false);
  assert.match(second.reason, /used/);
});

test('multi-use codes accept exactly maxUses', () => {
  const invites = new InviteStore(makeStore());
  const inv = invites.create({ uses: 3 });
  for (let i = 1; i <= 3; i++) {
    assert.equal(invites.consume(inv.code).ok, true, `use ${i}`);
  }
  assert.equal(invites.consume(inv.code).ok, false);
});

test('an expired code is refused', () => {
  const invites = new InviteStore(makeStore());
  const inv = invites.create({ ttlSec: -1 }); // already past
  const r = invites.consume(inv.code);
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired/);
});

test('unknown codes are refused without leaking which codes exist', () => {
  const invites = new InviteStore(makeStore());
  const r = invites.consume('ZZZZZZZZ');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown code');
});

test('pasted codes with spaces, dashes or lower case still work', () => {
  const invites = new InviteStore(makeStore());
  const inv = invites.create();
  const messy = ` ${inv.code.toLowerCase().slice(0, 4)}-${inv.code.toLowerCase().slice(4)} `;
  assert.equal(invites.consume(messy).ok, true);
});

test('normalizeCode strips everything outside the alphabet', () => {
  assert.equal(normalizeCode(' ab-12 cd '), 'AB12CD');
  assert.equal(normalizeCode(''), '');
  assert.equal(normalizeCode(null), '');
});

test('codes avoid characters that get misread', () => {
  const invites = new InviteStore(makeStore());
  for (let i = 0; i < 40; i++) {
    const { code } = invites.create();
    assert.doesNotMatch(code, /[01OIL]/, `code ${code} must avoid 0/1/O/I/L`);
  }
});

test('prune drops finished codes and keeps live ones', () => {
  const store = makeStore();
  const invites = new InviteStore(store);
  const dead = invites.create({ ttlSec: -1 });
  const live = invites.create({ ttlSec: 600 });
  invites.prune();
  assert.equal(store.get(dead.code, null), null);
  assert.ok(store.get(live.code, null));
});

test('list only returns usable codes', () => {
  const invites = new InviteStore(makeStore());
  invites.create({ ttlSec: -1 });
  const good = invites.create({ ttlSec: 600 });
  const list = invites.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].code, good.code);
});
