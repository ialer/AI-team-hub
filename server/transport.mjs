/**
 * Transport.
 *
 * Two independent channels, both plain HTTP so any harness can implement them:
 *
 *   • Browser  — Server-Sent Events, one-way hub → page.
 *   • Agent    — long polling, one-way hub → agent. The agent then POSTs back.
 *
 * Long polling was chosen over WebSocket on purpose: `curl` can speak it, every
 * language has HTTP, and it survives corporate proxies and NAT. An agent that
 * cannot do SSE/WebSocket still works.
 */

/** Connected browser pages. */
export class SseHub {
  constructor({ keepAliveMs = 20000 } = {}) {
    this.clients = new Set();
    this.keepAliveMs = keepAliveMs;
  }

  /** Attach an http.ServerResponse as an SSE stream. */
  attach(req, res, initialEvents = []) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const client = { res };
    this.clients.add(client);

    for (const [event, data] of initialEvents) this.sendTo(client, event, data);

    const timer = setInterval(() => {
      try { res.write(': ka\n\n'); } catch { /* closed */ }
    }, this.keepAliveMs);

    const cleanup = () => {
      clearInterval(timer);
      this.clients.delete(client);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  sendTo(client, event, data) {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.res.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  get size() {
    return this.clients.size;
  }
}

/**
 * Agent wake queue with long-poll support.
 *
 * An agent calls `wait(agentId, afterId, timeoutMs)`; if nothing is pending the
 * call parks until a wake arrives, the deadline passes, or the client aborts.
 * Pending wakes are held in memory only — a wake that nobody collects within
 * `retentionMs` is dropped, because replaying a stale "@agent do X" hours later
 * is worse than dropping it (the agent can always read history).
 */
export class WakeQueue {
  constructor({ retentionMs = 5 * 60 * 1000 } = {}) {
    this.pending = new Map(); // agentId -> [{ id, payload }]
    this.waiters = new Map(); // agentId -> Set<waiter>
    this.retentionMs = retentionMs;
    this.seq = 1;
  }

  push(agentId, payload) {
    const item = { id: this.seq++, payload, at: Date.now() };
    // Prune FIRST, then append — calling _prune() after the set would replace
    // the array with a stale copy and silently drop the wake we just queued.
    const list = this._prune(agentId);
    list.push(item);
    this.pending.set(agentId, list);
    this._flush(agentId);
    return item.id;
  }

  _prune(agentId) {
    const cutoff = Date.now() - this.retentionMs;
    return (this.pending.get(agentId) || []).filter((x) => x.at >= cutoff);
  }

  _flush(agentId) {
    const waiters = this.waiters.get(agentId);
    if (!waiters || !waiters.size) return;
    const list = this.pending.get(agentId) || [];
    if (!list.length) return;

    for (const waiter of [...waiters]) {
      waiter.resolve(list.map((x) => x.payload));
      waiters.delete(waiter);
    }
    if (!waiters.size) this.waiters.delete(agentId);
    // Delivered — clear so the same wake is not replayed.
    this.pending.set(agentId, []);
  }

  /**
   * Park until a wake is available or the timeout elapses.
   * @returns {Promise<Array>} zero or more wake payloads
   */
  wait(agentId, timeoutMs) {
    const list = this._prune(agentId);
    this.pending.set(agentId, list);
    if (list.length) {
      this.pending.set(agentId, []);
      return Promise.resolve(list.map((x) => x.payload));
    }

    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const set = this.waiters.get(agentId);
        if (set) { set.delete(waiter); if (!set.size) this.waiters.delete(agentId); }
        resolve(value);
      };
      const waiter = { resolve: finish };
      const set = this.waiters.get(agentId) || new Set();
      set.add(waiter);
      this.waiters.set(agentId, set);
      const timer = setTimeout(() => finish([]), timeoutMs);
    });
  }

  /** Drop any queued wake for an agent (e.g. it went offline). */
  clear(agentId) {
    this.pending.delete(agentId);
  }

  sizeFor(agentId) {
    return (this.pending.get(agentId) || []).length;
  }
}
