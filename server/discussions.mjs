/**
 * Group discussions.
 *
 * A discussion is a room plus two decisions made on every turn:
 *
 *   who speaks next   — round-robin, selector (an LLM picks), or manual mention
 *   when to stop      — turns, tokens, wall clock, a keyword, or a human
 *
 * That is the whole idea; the rest is bookkeeping. Speakers are strictly serial:
 * a discussion is people listening to each other, not five agents talking at
 * once.
 */
import crypto from 'node:crypto';

/** Cheap, dependency-free estimate. Fine for budgeting, not for accounting. */
function estimateTokens(text) {
  const s = String(text || '');
  // CJK is roughly one token per character; Latin is roughly one per four.
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

/** Jaccard similarity over character bigrams — a crude "did anyone say anything new" check. */
function similarity(a, b) {
  const grams = (s) => {
    const g = new Set();
    const t = String(s || '').replace(/\s+/g, '');
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

const DEFAULTS = {
  turnTaking: 'round-robin',
  maxTurns: 12,
  maxTokens: 200_000,
  timeoutSec: 600,
  stopOn: [],
  allowRepeatSpeaker: false,
  turnTimeoutSec: 180,
  convergenceRounds: 3,
};

export class DiscussionManager {
  constructor({ hub, registry, store, sse, log, config }) {
    this.hub = hub;
    this.registry = registry;
    this.store = store;          // JsonStore for persistence
    this.sse = sse;
    this.log = log;
    this.config = config || {};
    this.running = new Map();    // id -> { stopped, timer, waiters }
  }

  /* ── public API ───────────────────────────────────────── */

  list() {
    return Object.values(this.store.all());
  }

  get(id) {
    return this.store.get(id, null);
  }

  /**
   * Create and start a discussion.
   * @returns the initial record (the loop keeps running in the background)
   */
  create({ topic, participants, policy = {}, room }) {
    const ids = [...new Set(participants || [])].filter((id) => this.registry.get(id));
    if (ids.length < 2) throw new Error('a discussion needs at least two known agents');
    if (!String(topic || '').trim()) throw new Error('topic is required');

    const id = 'disc_' + crypto.randomBytes(4).toString('hex');
    const record = {
      id,
      room: room || id,
      topic: String(topic).trim(),
      participants: ids,
      policy: { ...DEFAULTS, ...policy },
      status: 'running',
      createdAt: Date.now(),
      turns: [],
      tokens: 0,
      summary: null,
      stopReason: null,
    };

    this.store.set(id, record);
    this.sse.broadcast('discussion', record);
    this.log.line(`discussion ${id} started: ${record.topic} [${ids.join(',')}]`);

    this._run(record).catch((e) => {
      this.log.line(`discussion ${id} crashed: ${e.message}`);
      this._finish(id, 'error', e.message);
    });

    return record;
  }

  /** Ask a running discussion to stop after the current turn. */
  stop(id, reason = 'requested by operator') {
    const run = this.running.get(id);
    if (run) {
      run.stopped = true;
      clearTimeout(run.timer);
      for (const w of run.waiters) w.resolve(null);
      run.waiters.clear();
    }
    return this._finish(id, 'stopped', reason);
  }

  /* ── the loop ─────────────────────────────────────────── */

  async _run(record) {
    const state = { stopped: false, timer: null, waiters: new Set(), lastSpeaker: null, repeat: 0, recent: [] };
    this.running.set(record.id, state);

    const deadline = Date.now() + record.policy.timeoutSec * 1000;

    for (let n = 1; n <= record.policy.maxTurns; n++) {
      if (state.stopped) break;

      // Gate 1: wall clock
      if (Date.now() > deadline) { this._finish(record.id, 'timeout', 'discussion timeout'); return; }

      // Gate 2: token budget
      if (record.tokens >= record.policy.maxTokens) {
        this._finish(record.id, 'budget', 'token budget exhausted'); return;
      }

      const speaker = await this._pickSpeaker(record, state, n);
      if (state.stopped) break;
      if (!speaker) { this._finish(record.id, 'no-speaker', 'no eligible speaker'); return; }

      const ctx = this._buildPrompt(record, speaker, n);
      this.log.line(`discussion ${record.id} turn ${n} → ${speaker}`);

      const reply = await this._ask(record, speaker, ctx, state);
      if (state.stopped) break;
      if (!reply) {
        this._finish(record.id, 'silent', `${speaker} did not answer`);
        return;
      }

      record.turns.push({
        n, speaker, at: Date.now(),
        text: reply.text,
        tokens: estimateTokens(reply.text),
      });
      record.tokens += estimateTokens(reply.text);
      record.lastSpeaker = speaker;
      this.store.set(record.id, record);
      this.sse.broadcast('discussion', record);

      // Gate 3: stop keywords
      const hit = (record.policy.stopOn || []).find((k) => k && reply.text.includes(k));
      if (hit) { this._finish(record.id, 'keyword', `stop keyword "${hit}"`); return; }

      // Gate 4: convergence — nobody is adding anything new
      state.recent.push(reply.text);
      if (state.recent.length > record.policy.convergenceRounds) state.recent.shift();
      if (state.recent.length === record.policy.convergenceRounds) {
        const sims = [];
        for (let i = 1; i < state.recent.length; i++) {
          sims.push(similarity(state.recent[i - 1], state.recent[i]));
        }
        if (sims.length && sims.every((s) => s > 0.9)) {
          this._finish(record.id, 'converged', 'contributions stopped changing');
          return;
        }
      }
    }

    if (!state.stopped) this._finish(record.id, 'max-turns', `reached ${record.policy.maxTurns} turns`);
  }

  /* ── speaker selection ────────────────────────────────── */

  async _pickSpeaker(record, state, n) {
    const { policy, participants } = record;

    if (policy.turnTaking === 'mention') {
      // Manual mode: the operator @-mentions someone in the room; we wait for
      // that mention instead of choosing.
      return this._waitForMention(record, state);
    }

    if (policy.turnTaking === 'selector') {
      const picked = await this._selectWithModel(record, n);
      if (picked) return picked;
      // fall through to round-robin on any failure
    }

    // round-robin (also the selector fallback).
    // n is 1-based, so (n-1) makes the *first* speaker participants[0] — with
    // n % len the rotation started one seat off.
    let idx = (n - 1) % participants.length;
    let candidate = participants[idx];
    if (!policy.allowRepeatSpeaker && candidate === state.lastSpeaker && participants.length > 1) {
      idx = (idx + 1) % participants.length;
      candidate = participants[idx];
    }
    return candidate;
  }

  /** Ask a small model who should speak. Returns null on any problem. */
  async _selectWithModel(record, n) {
    const sel = (this.config && this.config.selector) || null;
    if (!sel || !sel.url) return null;

    const people = record.participants
      .map((id) => {
        const a = this.registry.get(id);
        return `- ${id}（${a.name}${a.role ? ' · ' + a.role : ''}）`;
      })
      .join('\n');

    const history = record.turns.slice(-8)
      .map((t) => `[${t.n}] ${this.registry.get(t.speaker)?.name || t.speaker}：${t.text.slice(0, 300)}`)
      .join('\n') || '(还没有人发言)';

    const prompt = [
      '你是讨论主持人。根据话题和已有发言，选出最该说话的参与者。',
      '只输出参与者 id，不要任何其他内容。如果讨论已经充分，输出 DONE。',
      '',
      `话题：${record.topic}`,
      '',
      '参与者：',
      people,
      '',
      '已发言：',
      history,
      '',
      '请选择下一个发言者 id：',
    ].join('\n');

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (sel.token) headers.Authorization = `Bearer ${sel.token}`;
      const res = await fetch(sel.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: sel.model || undefined,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 20,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(sel.timeoutMs || 20000),
      });
      if (!res.ok) return null;
      const j = await res.json();
      const text = String(j?.choices?.[0]?.message?.content || '').trim();

      if (/^done$/i.test(text)) return null; // caller falls back, then gates end it
      const id = record.participants.find((p) => text.toLowerCase().includes(p.toLowerCase()));
      if (!id) return null;
      if (id === record.lastSpeaker && !record.policy.allowRepeatSpeaker && record.participants.length > 1) {
        return null; // let round-robin pick someone else
      }
      return id;
    } catch {
      return null; // silent fallback; a selector outage must not kill the room
    }
  }

  /** Manual mode: park until the operator mentions a participant. */
  _waitForMention(record, state) {
    return new Promise((resolve) => {
      const onSay = (msg) => {
        if (msg.room !== record.room) return;
        const hit = record.participants.find((p) => (msg.mentions || []).includes(p));
        if (!hit) return;
        cleanup();
        resolve(hit);
      };
      const timer = setTimeout(() => { cleanup(); resolve(null); }, record.policy.turnTimeoutSec * 1000);
      const cleanup = () => {
        clearTimeout(timer);
        this.hub.events.off('said', onSay);
        state.waiters.delete(waiter);
      };
      const waiter = { resolve: (v) => { cleanup(); resolve(v); } };
      state.waiters.add(waiter);
      this.hub.events.on('said', onSay);
    });
  }

  /* ── one turn ─────────────────────────────────────────── */

  _buildPrompt(record, speaker, n) {
    const agent = this.registry.get(speaker);
    const others = record.participants
      .filter((id) => id !== speaker)
      .map((id) => this.registry.get(id)?.name || id)
      .join('、');

    const history = record.turns
      .map((t) => {
        const who = this.registry.get(t.speaker)?.name || t.speaker;
        return `${who}：${t.text}`;
      })
      .join('\n');

    return [
      `【团队讨论】你是${agent.name}${agent.role ? `（${agent.role}）` : ''}。`,
      `话题：${record.topic}`,
      `其他参与者：${others || '无'}`,
      history ? `\n已有发言：\n${history}` : '',
      `\n请从你的角度发表意见，直接说话，不要复述任务，不要使用 @ 提及。控制在 200 字以内。`,
    ].filter(Boolean).join('\n');
  }

  /** Wake an agent for one turn and wait for its reply. */
  _ask(record, speaker, prompt, state) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.hub.events.off('turn', onTurn);
        state.waiters.delete(waiter);
        resolve(value);
      };

      const onTurn = ({ agentId, message }) => {
        if (agentId !== speaker) return;
        if (message.room !== record.room) return;
        finish({ text: message.text, id: message.id });
      };

      const timer = setTimeout(() => finish(null), record.policy.turnTimeoutSec * 1000);
      const waiter = { resolve: (v) => finish(v) };
      state.waiters.add(waiter);
      state.timer = timer;

      this.hub.events.on('turn', onTurn);

      // Speak into the discussion room; the mention is what wakes this agent.
      try {
        this.hub.say({
          room: record.room,
          from: 'system',
          text: `@${speaker} ${prompt}`,
          kind: 'discussion',
        });
      } catch (e) {
        finish(null);
      }
    });
  }

  /* ── finishing ────────────────────────────────────────── */

  async _finish(id, status, reason) {
    const record = this.store.get(id, null);
    if (!record) return null;
    if (record.status !== 'running') return record;

    this.running.delete(id);
    // Reaching the turn cap is a normal finish; everything else keeps its own
    // name so a caller can tell "converged" from "ran out of turns".
    record.status = status === 'max-turns' ? 'done' : status;
    record.stopReason = reason;
    record.endedAt = Date.now();

    this.store.set(id, record);
    this.sse.broadcast('discussion', record);
    this.log.line(`discussion ${id} ${record.status} (${reason}) after ${record.turns.length} turns`);

    // Post a short recap into the main room so the discussion is discoverable.
    try {
      this.hub.say({
        room: this.config.defaultRoom || 'team',
        from: 'system',
        text: this._recap(record),
        kind: 'system',
      });
    } catch { /* the room may not exist yet */ }

    return record;
  }

  _recap(record) {
    const who = record.participants.map((p) => this.registry.get(p)?.name || p).join('、');
    const head = `📋 讨论结束：${record.topic}\n参与：${who} · ${record.turns.length} 轮 · ${record.stopReason}`;
    if (!record.turns.length) return head;

    const lines = record.turns.map((t) => {
      const name = this.registry.get(t.speaker)?.name || t.speaker;
      const one = t.text.replace(/\s+/g, ' ').slice(0, 90);
      return `· ${name}：${one}${t.text.length > 90 ? '…' : ''}`;
    });
    return `${head}\n\n${lines.join('\n')}\n\n完整记录见房间 ${record.room}`;
  }
}
