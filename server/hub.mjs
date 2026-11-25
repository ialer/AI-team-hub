/**
 * Hub core: message flow, wake routing, presence.
 *
 * This module owns the two things that make the project work:
 *   1. a message is appended once and fanned out to every listener;
 *   2. only the agents actually @-mentioned are woken, each in its own turn.
 *
 * It knows nothing about how an agent runs — that belongs to adapters (push) or
 * to the agent itself (connector / long poll).
 */
import { createMentionResolver, stripMentions } from './mentions.mjs';
import { getAdapter } from './adapters/index.mjs';
import { EventEmitter } from 'node:events';

export class Hub {
  constructor({ config, log, messages, registry, sse, wakeQueue, dialogs }) {
    this.config = config;
    this.log = log;
    this.messages = messages;
    this.registry = registry;
    this.sse = sse;
    this.wakeQueue = wakeQueue;
    this.dialogs = dialogs;

    this.resolveMentions = createMentionResolver(config.agents);
    this.inFlight = new Map(); // agentId -> { msgId, startedAt, timer }
    // Wakes that arrived while the agent was mid-turn. Dropping them silently
    // loses task messages, so they wait here and are delivered one by one.
    this.pending = new Map(); // agentId -> payload[]
    this.streams = new Map();  // agentId -> live stream buffer

    // Anything that needs to react to a finished turn (e.g. a running
    // discussion) subscribes here instead of polling the message log.
    this.events = new EventEmitter();
    this.events.setMaxListeners(50);
  }

  /* ── reads ────────────────────────────────────────────── */

  state() {
    return {
      human: this.config.human,
      agents: this.registry.publicView(),
      rooms: this.messages.rooms(),
      defaultRoom: this.config.defaultRoom,
      adapters: [...new Set(this.config.agents.filter((a) => a.adapter).map((a) => a.adapter))],
      busy: [...this.inFlight.keys()],
      lastId: this.messages.nextId - 1,
    };
  }

  /* ── writes ───────────────────────────────────────────── */

  /**
   * Append a message, broadcast it, and wake whoever was mentioned.
   * @returns the stored message
   */
  say({ room, from, text, refs = [], images = [], kind = 'chat', dialog = null, origin = 'user', taskId = null, threadId = null }) {
    const body = String(text || '').trim();
    if (!body && !dialog) throw new Error('empty message');

    // Mentions are resolved for every kind, not just plain chat: a discussion
    // turn wakes its speaker by mentioning them, and it is not a 'chat' message.
    const mentions = this.resolveMentions(body);
    const message = this.messages.append({
      room: room || this.config.defaultRoom,
      from,
      text: body,
      mentions,
      refs,
      ...(images && images.length ? { images: images.slice(0, 8) } : {}),
      kind,
      origin,
      ...(dialog ? { dialog } : {}),
      // Optional task grouping. Absent fields keep the message exactly as
      // before, so existing clients see no change.
      ...(taskId ? { taskId: String(taskId).slice(0, 64) } : {}),
      ...(threadId ? { threadId: String(threadId).slice(0, 64) } : {}),
    });

    this.sse.broadcast('message', message);

    // Persist a dialog so it survives a reload and can be answered later.
    if (dialog && dialog.id) {
      this.dialogs.set(dialog.id, {
        ...dialog,
        room: message.room,
        messageId: message.id,
        agentId: from,
        status: 'open',
        createdAt: message.ts,
      });
    }

    this.log.line(`say ${from} → [${mentions.join(',') || '—'}] ${stripMentions(body).slice(0, 60)}`);
    // Manual discussions wait for an operator mention; emit before waking so a
    // waiter can claim the turn.
    this.events.emit('said', message);
    this.wake(message);
    return message;
  }

  /** An agent posts a reply (connector path). */
  reply({ agentId, msgId, text, sessionId }) {
    if (!this.registry.get(agentId)) throw new Error(`unknown agent ${agentId}`);
    if (sessionId) this.registry.markSeen(agentId, { online: true, sessionId });

    this.clearInFlight(agentId, 'replied');

    // Reply belongs to the room of the message that woke us; fall back to the
    // agent's most recent room, then the default room.
    const source = this.messages.find(msgId);
    const room = source ? source.room : this.notificationRoom(agentId);

    const message = this.messages.append({
      room,
      from: agentId,
      text: String(text || ''),
      mentions: this.resolveMentions(text),
      replyTo: msgId || null,
      kind: 'chat',
      origin: 'agent',
    });
    this.sse.broadcast('message', message);
    this.log.line(`reply ${agentId} (${String(text || '').length} chars)`);
    // Let whoever is waiting (a discussion turn) know this agent has spoken.
    this.events.emit('turn', { agentId, message, room });

    // A reply can itself mention someone — let it start the next turn.
    this.wake(message);
    return message;
  }

  /** Last room an agent spoke in; falls back to the default room. */
  notificationRoom(agentId) {
    const recent = this.messages.items.filter((m) => m.from === agentId).pop();
    return recent ? recent.room : this.config.defaultRoom;
  }

  /* ── wake routing ─────────────────────────────────────── */

  wake(message) {
    const targets = (message.mentions || []).filter((id) => id !== message.from && id !== 'human');
    for (const agentId of targets) {
      const agent = this.registry.get(agentId);
      if (!agent || !agent.enabled) continue;
      if (this.inFlight.has(agentId)) {
        this.queueWhileBusy(agent, message);
        continue;
      }
      if (agent.mode === 'push') this.wakeViaAdapter(agent, message);
      else this.wakeViaQueue(agent, message);
    }
  }

  /** Connector path: hand the payload to a live WebSocket, else queue it. */
  wakeViaQueue(agent, message) {
    this.deliverWake(agent.id, this.buildWakePayload(agent, message), message.id);
  }

  /**
   * Deliver one wake: live socket first, poll queue as the HTTP fallback.
   * Shared by the direct path and the busy-queue drain so both behave the same.
   */
  deliverWake(agentId, payload, msgId) {
    const delivered = typeof this.wsSender === 'function' && this.wsSender(agentId, payload);
    if (!delivered) this.wakeQueue.push(agentId, payload);
    this.markInFlight(agentId, msgId, delivered ? 'pushed-ws' : 'queued');
    this.sse.broadcast('typing', { who: agentId, on: true });
  }

  /** Keep a wake instead of dropping it when the agent is still working. */
  queueWhileBusy(agent, message) {
    const limit = this.config.pendingWakeLimit || 5;
    const q = this.pending.get(agent.id) || [];
    if (q.length >= limit) {
      this.log.line(`drop ${agent.id}: ${limit} wakes already waiting`);
      return;
    }
    q.push(this.buildWakePayload(agent, message));
    this.pending.set(agent.id, q);
    this.log.line(`queued ${agent.id}: busy, ${q.length} waiting`);
  }

  /** After a turn ends, start the next queued wake (if any). */
  drainPending(agentId) {
    const q = this.pending.get(agentId);
    if (!q || !q.length) return;
    const next = q.shift();
    if (!q.length) this.pending.delete(agentId);
    this.log.line(`dequeued ${agentId}: ${q.length} still waiting`);
    this.deliverWake(agentId, next, next.msgId);
  }

  /** Register the WebSocket delivery hook. Returns true when the agent is connected. */
  setWsSender(fn) {
    this.wsSender = fn;
  }

  /**
   * Rebuild the @ mention resolver.
   *
   * Must be called whenever the agent roster changes at runtime — otherwise a
   * freshly joined agent is invisible to @ parsing and never wakes.
   */
  refreshAgents() {
    this.resolveMentions = createMentionResolver(this.registry.list());
    this.sse.broadcast('presence', { agents: this.registry.publicView() });
    this.sse.broadcast('roster', this.state());
  }

  /** Push path: call the adapter and post its reply back as a normal message. */
  async wakeViaAdapter(agent, message) {
    const adapter = getAdapter(agent.adapter);
    if (!adapter) {
      this.log.line(`skip ${agent.id}: unknown adapter ${agent.adapter}`);
      return;
    }

    this.markInFlight(agent.id, message.id, 'pushing');
    this.sse.broadcast('typing', { who: agent.id, on: true });

    try {
      const sessionId = this.registry.sessionFor(agent.id);
      const result = await adapter.wake({
        text: message.text,
        sessionId,
        config: agent.adapterConfig || {},
      });
      if (result.sessionId) this.registry.markSeen(agent.id, { online: true, sessionId: result.sessionId });
      this.registry.markReachable(agent.id, true);

      const reply = this.messages.append({
        room: message.room,
        from: agent.id,
        text: result.text || '',
        mentions: this.resolveMentions(result.text),
        replyTo: message.id,
        kind: 'chat',
        origin: 'agent',
      });
      this.sse.broadcast('message', reply);
      this.log.line(`reply ${agent.id} (${(result.text || '').length} chars)`);
      // Same signal the connector path emits, so a discussion waiting on this
      // agent is released regardless of how the agent was woken.
      this.events.emit('turn', { agentId: agent.id, message: reply, room: message.room });
      this.wake(reply);
    } catch (e) {
      // Remember the failure so the UI can show this push agent as unreachable
      // instead of pretending nothing happened.
      this.registry.markReachable(agent.id, false);
      this.sse.broadcast('presence', { agents: this.registry.publicView() });
      this.systemNotice(message.room, `${this.displayName(agent.id)} 唤醒失败：${String(e.message).slice(0, 300)}`);
    } finally {
      this.clearInFlight(agent.id, 'done');
      this.sse.broadcast('typing', { who: agent.id, on: false });
    }
  }

  /** Context an agent receives alongside the mention. */
  buildWakePayload(agent, message) {
    const context = this.messages.tail(message.room, this.config.contextWindow);
    return {
      msgId: message.id,
      room: message.room,
      from: message.from,
      text: message.text,
      ts: message.ts,
      mentions: message.mentions,
      refs: message.refs || [],
      sessionId: this.registry.sessionFor(agent.id),
      context: context.map((m) => ({
        id: m.id,
        from: m.from,
        text: m.text,
        ts: m.ts,
      })),
    };
  }

  /* ── in-flight bookkeeping ────────────────────────────── */

  markInFlight(agentId, msgId, phase) {
    const entry = { msgId, startedAt: Date.now(), phase };
    entry.timer = setTimeout(() => {
      this.inFlight.delete(agentId);
      this.wakeQueue.clear(agentId);
      this.sse.broadcast('typing', { who: agentId, on: false });
      // Timeout is not a reason to lose the next task message: try it.
      this.drainPending(agentId);
      this.systemNotice(
        this.notificationRoom(agentId),
        `${this.displayName(agentId)} 超时未响应（${this.config.wakeTimeout}s）`,
      );
    }, this.config.wakeTimeout * 1000);
    entry.timer.unref?.();
    this.inFlight.set(agentId, entry);
  }

  clearInFlight(agentId, reason) {
    const entry = this.inFlight.get(agentId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.inFlight.delete(agentId);
    if (reason === 'replied') this.sse.broadcast('typing', { who: agentId, on: false });
    // A turn just finished: hand the next waiting wake over instead of leaving
    // it stranded until someone mentions the agent again.
    this.drainPending(agentId);
  }

  /**
   * The agent's last poller went away.
   *
   * If it was mid-turn the wake is still in the queue, so drop the in-flight
   * marker (but keep the queued wake) — otherwise the agent stays "busy" until
   * the timeout and every new mention is silently skipped.
   */
  agentWentOffline(agentId) {
    const entry = this.inFlight.get(agentId);
    if (entry && (entry.phase === 'queued' || entry.phase === 'pushed-ws')) {
      clearTimeout(entry.timer);
      this.inFlight.delete(agentId);
      this.sse.broadcast('typing', { who: agentId, on: false });
      this.log.line(`${agentId} went offline mid-turn; turns kept for reconnect`);
    }
  }

  /* ── streaming ────────────────────────────────────────── */

  /**
   * A streaming turn started. The partial text lives in memory and is pushed to
   * browsers on every delta; nothing is written to the log until it ends, so a
   * dropped stream never leaves a half sentence in history.
   */
  beginStream(agentId, msgId, room) {
    if (!this.registry.get(agentId)) throw new Error(`unknown agent ${agentId}`);
    this.clearInFlight(agentId, 'stream');
    this.markInFlight(agentId, msgId, 'streaming');

    const stream = {
      agentId,
      msgId,
      room: room || this.notificationRoom(agentId),
      text: '',
      startedAt: Date.now(),
      tools: [],
    };
    this.streams.set(agentId, stream);
    this.sse.broadcast('typing', { who: agentId, on: true });
    this.sse.broadcast('stream_start', {
      from: agentId, msgId, room: stream.room,
      name: this.displayName(agentId),
    });
    return stream;
  }

  /** Push one incremental chunk to every browser watching. */
  appendDelta(agentId, text) {
    const stream = this.streams.get(agentId);
    if (!stream) return null;
    stream.text += text;
    this.sse.broadcast('delta', { from: agentId, msgId: stream.msgId, text });
    return stream;
  }

  /** Record a tool call so the UI can show what the agent is doing. */
  appendTool(agentId, name, detail) {
    const stream = this.streams.get(agentId);
    if (!stream) return null;
    stream.tools.push({ name, detail });
    this.sse.broadcast('tool', {
      from: agentId, msgId: stream.msgId, name: String(name || ''), detail: String(detail || ''),
    });
    return stream;
  }

  /**
   * Finish a streaming turn: persist one message with the full text.
   * If the agent never sent a final block, whatever arrived is used and the
   * message is flagged `truncated` so the reader knows it was cut short.
   */
  endStream(agentId, { text, sessionId, truncated = false } = {}) {
    const stream = this.streams.get(agentId);
    this.streams.delete(agentId);
    this.clearInFlight(agentId, 'stream');
    this.sse.broadcast('typing', { who: agentId, on: false });

    if (!stream) return null;
    const body = (typeof text === 'string' && text) || stream.text;
    if (sessionId) this.registry.markSeen(agentId, { online: true, sessionId });

    const message = this.messages.append({
      room: stream.room,
      from: agentId,
      text: body,
      mentions: this.resolveMentions(body),
      replyTo: stream.msgId || null,
      kind: 'chat',
      origin: 'agent',
      ...(truncated ? { truncated: true } : {}),
    });
    this.sse.broadcast('message', message);
    this.sse.broadcast('stream_end', { from: agentId, msgId: message.id });
    this.log.line(`stream ${agentId} → ${body.length} chars${truncated ? ' (truncated)' : ''}`);
    this.events.emit('turn', { agentId, message, room: stream.room });

    this.wake(message);
    return message;
  }

  /** Read the accumulated text of a live stream (used by the HTTP handler). */
  streamText(agentId) {
    const s = this.streams.get(agentId);
    return s ? s.text : '';
  }

  /** A hub-authored notice (failures, timeouts). Never wakes anyone. */
  systemNotice(room, text) {
    const m = this.messages.append({ room: room || this.config.defaultRoom, from: 'system', text, mentions: [], kind: 'system' });
    this.sse.broadcast('message', m);
    return m;
  }

  displayName(agentId) {
    const a = this.registry.get(agentId);
    return a ? a.name : agentId;
  }

  /* ── dialogs ──────────────────────────────────────────── */

  /** Record a dialog answer and hand it back to the proposing agent. */
  submitDialog({ dialogId, values, from = 'human' }) {
    const dialog = this.dialogs.get(dialogId);
    if (!dialog) throw new Error('dialog not found');
    if (dialog.status !== 'open') throw new Error(`dialog is ${dialog.status}`);

    const updated = this.dialogs.set(dialogId, {
      ...dialog,
      status: 'submitted',
      values,
      answeredAt: Date.now(),
      answeredBy: from,
    });

    this.sse.broadcast('dialog', updated);

    const lines = Object.entries(values)
      .map(([k, v]) => `· ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\n');
    this.say({
      room: dialog.room,
      from,
      text: `@${dialog.agentId} 表单「${dialog.title}」已提交\n${lines}`,
    });
    return updated;
  }

  cancelDialog({ dialogId, from = 'human' }) {
    const dialog = this.dialogs.get(dialogId);
    if (!dialog) throw new Error('dialog not found');
    const updated = this.dialogs.set(dialogId, { ...dialog, status: 'cancelled', answeredAt: Date.now() });
    this.sse.broadcast('dialog', updated);
    this.say({ room: dialog.room, from, text: `@${dialog.agentId} 表单「${dialog.title}」已取消` });
    return updated;
  }
}
