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
  say({ room, from, text, refs = [], images = [], kind = 'chat', dialog = null, origin = 'user' }) {
    const body = String(text || '').trim();
    if (!body && !dialog) throw new Error('empty message');

    const mentions = kind === 'chat' ? this.resolveMentions(body) : [];
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
        this.log.line(`skip ${agentId}: already running`);
        continue;
      }
      if (agent.mode === 'push') this.wakeViaAdapter(agent, message);
      else this.wakeViaQueue(agent, message);
    }
  }

  /** Connector path: park a payload the agent will collect on its next poll. */
  wakeViaQueue(agent, message) {
    const payload = this.buildWakePayload(agent, message);
    this.wakeQueue.push(agent.id, payload);
    this.markInFlight(agent.id, message.id, 'queued');
    this.sse.broadcast('typing', { who: agent.id, on: true });
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
      this.wake(reply);
    } catch (e) {
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
    if (entry && entry.phase === 'queued') {
      clearTimeout(entry.timer);
      this.inFlight.delete(agentId);
      this.sse.broadcast('typing', { who: agentId, on: false });
      this.log.line(`${agentId} went offline with a queued wake; kept for reconnect`);
    }
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
