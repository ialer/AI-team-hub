/**
 * Team contract: a single authoritative document the hub hands to every agent
 * on connect. Agents render it into their context; the hub tracks who is on
 * which version, so a stale or failed sync is visible instead of silent.
 *
 * File format: plain Markdown with a tiny header:
 *   ---
 *   version: 2026.11.25-1
 *   ---
 *   ...contract body...
 * `version` is a human bump; `sha256` is computed over the body at load time.
 * Publishing = edit the file, bump the version, restart the hub.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { JsonStore } from './store.mjs';

const HEADER_RE = /^---\s*\nversion:\s*(.+?)\s*\n---\s*\n?/;

export function createContract({ contractFile, dataDir, log }) {
  const acks = new JsonStore(dataDir, 'contract-acks.json', {});

  function load() {
    if (!contractFile || !fs.existsSync(contractFile)) {
      if (log) log.line('contract: no file at ' + contractFile);
      return null;
    }
    const raw = fs.readFileSync(contractFile, 'utf8');
    const m = HEADER_RE.exec(raw);
    const version = m ? m[1].trim() : 'unversioned';
    const text = m ? raw.slice(m[0].length).trim() : raw.trim();
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    return { version, sha256, text };
  }

  let current = load();
  if (current && log) log.line('contract v' + current.version + ' (' + current.sha256.slice(0, 12) + ')');

  return {
    current() { return current; },
    reload() { current = load(); return current; },
    ack(agentId, version, sha256) { acks.set(agentId, { version, sha256, at: Date.now() }); },
    acks() { return acks.all(); },
  };
}
