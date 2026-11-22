/**
 * Invite codes.
 *
 * The problem this solves: before, onboarding an agent meant editing the hub's
 * config.json, figuring out its derived token, and restarting the hub — which
 * drops every existing agent's connection. That is not onboarding, that is
 * surgery on the hub.
 *
 * Now the hub mints a short-lived code, the new agent trades it for its own
 * token, and it is registered at runtime. No config edit, no restart.
 */
import crypto from 'node:crypto';

/** Unambiguous alphabet: no 0/O, 1/I/L. Codes get read aloud and retyped. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function randomCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Accept lower case, spaces and dashes so a pasted code still works. */
export function normalizeCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

export class InviteStore {
  constructor(store, { defaultTtlSec = 1800, defaultUses = 1 } = {}) {
    this.store = store; // JsonStore (data/invites.json)
    this.defaultTtlSec = defaultTtlSec;
    this.defaultUses = defaultUses;
  }

  /**
   * Mint a code.
   * @param {{ttlSec?: number, uses?: number, note?: string}} opts
   */
  create({ ttlSec, uses, note } = {}) {
    const code = randomCode(8);
    const invite = {
      code,
      createdAt: Date.now(),
      expiresAt: Date.now() + (ttlSec || this.defaultTtlSec) * 1000,
      maxUses: Math.max(1, Number(uses || this.defaultUses)),
      uses: 0,
      note: note || '',
    };
    this.store.set(code, invite);
    return invite;
  }

  list() {
    return Object.values(this.store.all())
      .filter((i) => !this.isExpired(i))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  isExpired(invite) {
    return invite.expiresAt < Date.now() || invite.uses >= invite.maxUses;
  }

  /** Validate without consuming — used for a "does this code look right" check. */
  peek(code) {
    const key = normalizeCode(code);
    if (!key) return { ok: false, reason: 'empty code' };
    const invite = this.store.get(key, null);
    if (!invite) return { ok: false, reason: 'unknown code' };
    if (invite.expiresAt < Date.now()) return { ok: false, reason: 'code expired' };
    if (invite.uses >= invite.maxUses) return { ok: false, reason: 'code already used' };
    return { ok: true, invite };
  }

  /** Validate and consume one use. Returns the invite or a reason. */
  consume(code) {
    const check = this.peek(code);
    if (!check.ok) return check;
    const invite = { ...check.invite, uses: check.invite.uses + 1, lastUsedAt: Date.now() };
    // Keep the exhausted code around instead of deleting it: a person typing a
    // code they already used deserves "already used", not "unknown code".
    // prune() clears these out later.
    this.store.set(invite.code, invite);
    return { ok: true, invite };
  }

  /** Drop expired entries so the file does not grow forever. */
  prune() {
    for (const inv of Object.values(this.store.all())) {
      if (this.isExpired(inv)) this.store.delete(inv.code);
    }
  }
}
