/**
 * Server-issued agent tokens.
 *
 * Unlike the old HMAC derivation, a token here is a random opaque secret the
 * hub stores and can revoke per agent. That is what makes three things possible
 * that HMAC could not:
 *   - disabling one agent (its token stops verifying) without touching others
 *   - "delete local state → must be re-issued" (the secret cannot be recomputed)
 *   - revocation without rotating the admin token for everyone
 *
 * Stored as a plain JSON map { agentId: token } in data/tokens.json.
 */
import crypto from 'node:crypto';

export class TokenStore {
  constructor(store) {
    this.store = store; // JsonStore(dataDir, 'tokens.json', {}, { mode: 0o600 })
  }

  /** Return the agent's token, minting a random one on first use. */
  ensure(agentId) {
    const existing = this.store.get(agentId, null);
    if (existing) return existing;
    const token = crypto.randomBytes(24).toString('base64url');
    this.store.set(agentId, token);
    return token;
  }

  /** The agent's token if it has one, else ''. */
  peek(agentId) {
    return this.store.get(agentId, '') || '';
  }

  /** Constant-time check of a presented token against the stored one. */
  verify(agentId, token) {
    const expected = this.peek(agentId);
    if (!expected || !token) return false;
    const a = Buffer.from(String(token));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /** Forget an agent's token (used when removing an agent). */
  revoke(agentId) {
    this.store.delete(agentId);
  }

  all() {
    return this.store.all();
  }
}
