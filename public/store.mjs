/**
 * Tiny observable store — the whole "state management library" this app needs.
 *
 * Reads are plain property access (state.agents); writes go through set(), which
 * notifies subscribers with the changed keys. Views subscribe once at boot and
 * re-render only what they own. No framework, no dependency, no virtual DOM.
 */
export function createStore(initial) {
  const data = { ...initial };
  const listeners = new Set();
  let queued = null;

  function flush() {
    const keys = queued;
    queued = null;
    if (!keys || !keys.size) return;
    for (const fn of [...listeners]) {
      try { fn(data, keys); } catch (e) { console.error('store listener', e); }
    }
  }

  return {
    data,
    /** Merge a patch. Notifications are coalesced into one microtask. */
    set(patch) {
      const keys = new Set();
      for (const [k, v] of Object.entries(patch || {})) {
        if (data[k] === v) continue;
        data[k] = v;
        keys.add(k);
      }
      if (!keys.size) return;
      if (!queued) {
        queued = keys;
        queueMicrotask(flush);
      } else {
        for (const k of keys) queued.add(k);
      }
    },
    /** Subscribe to changes. Returns an unsubscribe function. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
