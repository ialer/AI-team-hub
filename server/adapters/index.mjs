/**
 * Adapter contract.
 *
 * An adapter is the *push* path: the hub reaches out to an agent instead of the
 * agent dialing in. It exists for agents that cannot hold a connection and for
 * one-shot CLIs.
 *
 * Every adapter exports:
 *   id                                  unique string
 *   label                               human name for docs/UI
 *   async probe(config) -> { ok, detail }
 *   async wake({ text, sessionId, config }) -> { text, sessionId }
 *
 * Keep adapters tiny: they translate, they do not decide.
 */

const registry = new Map();

export function registerAdapter(adapter) {
  if (!adapter || !adapter.id) throw new Error('adapter needs an id');
  if (typeof adapter.wake !== 'function') throw new Error(`adapter ${adapter.id} needs wake()`);
  registry.set(adapter.id, adapter);
  return adapter;
}

export function getAdapter(id) {
  return registry.get(id) || null;
}

export function listAdapters() {
  return [...registry.values()].map((a) => ({ id: a.id, label: a.label || a.id }));
}
