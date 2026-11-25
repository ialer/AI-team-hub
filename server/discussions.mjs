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
  // Split a fuzzy topic into concrete questions before anyone speaks, so the
  // discussion has something to answer instead of drifting.
  planFirst: true,
  maxQuestions: 4,
  turnsPerQuestion: 2,
  // 'serial'  — one speaker per turn, each sees the previous answers (default).
  // 'parallel'— every participant answers each question concurrently, then one
  //             synthesis turn pulls the answers together. Same quality intent,
  //             far less wall-clock time when members are independent.
  strategy: 'serial',
  synthesize: true,
};

/**
 * An agent may explicitly decline a turn instead of padding it.
 * Borrowed from AgentVerse's classroom scenario, where every turn is one of
 * Speak / CallOn / Listen / GroupDiscuss — "I have nothing to add" is a
 * first-class move, not an empty paragraph.
 */
const LISTEN_RE = /^\s*[\[(【]?\s*listen\s*[\])】]?\s*$|^\s*[\[(【]?\s*(弃权|跳过)\s*[\])】]?\s*$/i;

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
    const ids = [...new Set(participants || [])].filter((id) => { const a = this.registry.get(id); return a && a.enabled !== false; });
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
      skips: [],
      questions: [],
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
    const state = {
      stopped: false,
      timer: null,
      waiters: new Set(),
      lastSpeaker: null,
      recent: [],
      questionIndex: 0,
      listened: new Set(),   // who declined for the current question
      turnsInQuestion: 0,
    };
    this.running.set(record.id, state);

    // Task specification first: a topic like "要不要迁移" has no answerable
    // shape. Splitting it into questions is what stops the third turn from
    // wandering off, which is exactly what happened before this existed.
    if (record.policy.planFirst !== false) {
      const questions = await this._planQuestions(record);
      if (questions && questions.length) {
        record.questions = questions;
        this.store.set(record.id, record);
        this.sse.broadcast('discussion', record);
        this.log.line(`discussion ${record.id} planned ${questions.length} questions`);
      }
    }

    if (record.policy.strategy === 'parallel') {
      return this._runParallel(record, state);
    }

    const deadline = Date.now() + record.policy.timeoutSec * 1000;

    // `n` counts accepted contributions; listens do not consume a turn, so a
    // separate attempt counter keeps the loop bounded.
    const maxAttempts = record.policy.maxTurns * Math.max(record.participants.length, 2) * 2;
    let attempts = 0;
    let n = 0;

    while (n < record.policy.maxTurns) {
      if (state.stopped) break;
      if (++attempts > maxAttempts) { this._finish(record.id, 'no-progress', 'too many declined turns'); return; }

      // Gate 1: wall clock
      if (Date.now() > deadline) { this._finish(record.id, 'timeout', 'discussion timeout'); return; }

      // Gate 2: token budget
      if (record.tokens >= record.policy.maxTokens) {
        this._finish(record.id, 'budget', 'token budget exhausted'); return;
      }

      const speaker = await this._pickSpeaker(record, state, n + 1);
      if (state.stopped) break;
      if (!speaker) { this._finish(record.id, 'no-speaker', 'no eligible speaker left'); return; }

      const ctx = this._buildPrompt(record, speaker, n + 1, state);
      this.log.line(`discussion ${record.id} turn ${n + 1} → ${speaker}`);

      const reply = await this._ask(record, speaker, ctx, state);
      if (state.stopped) break;
      if (!reply) { this._finish(record.id, 'silent', `${speaker} did not answer`); return; }

      /* ── declined the turn ── */
      if (reply.listen) {
        state.listened.add(speaker);
        record.skips = record.skips || [];
        record.skips.push({ speaker, question: state.questionIndex, at: Date.now() });
        this.store.set(record.id, record);
        this.sse.broadcast('discussion', record);
        this.log.line(`discussion ${record.id} ${speaker} passed`);

        if (state.listened.size >= record.participants.length) {
          // Everyone passed. Move to the next question if there is one,
          // otherwise the room genuinely has nothing left to say.
          if (this._advanceQuestion(record, state)) continue;
          this._finish(record.id, 'all-passed', 'every participant declined');
          return;
        }
        continue; // does not consume a turn
      }

      /* ── accepted the turn ── */
      n += 1;
      state.turnsInQuestion += 1;
      record.turns.push({
        n,
        speaker,
        at: Date.now(),
        text: reply.text,
        tokens: estimateTokens(reply.text),
        question: record.questions && record.questions.length ? state.questionIndex : undefined,
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

      // Gate 5: the current question has had its share of turns
      const perQ = record.policy.turnsPerQuestion || 2;
      if (record.questions && record.questions.length && state.turnsInQuestion >= perQ) {
        this._advanceQuestion(record, state);
      }
    }

    if (!state.stopped) this._finish(record.id, 'max-turns', `reached ${record.policy.maxTurns} turns`);
  }

  /**
   * Parallel strategy: for each question, wake every participant at once, then
   * take one synthesis turn. Answers are independent (nobody sees the others'
   * text while answering), which is what makes the round concurrent.
   */
  async _runParallel(record, state) {
    const P = record.policy;
    const deadline = Date.now() + P.timeoutSec * 1000;
    const parts = record.participants.slice();
    const questions = record.questions && record.questions.length ? record.questions : [null];
    let accepted = 0;

    for (let qi = 0; qi < questions.length; qi++) {
      if (state.stopped) break;
      if (Date.now() > deadline) { this._finish(record.id, 'timeout', 'discussion timeout'); return; }
      if (record.tokens >= P.maxTokens) { this._finish(record.id, 'budget', 'token budget exhausted'); return; }
      if (accepted >= P.maxTurns) break;

      state.questionIndex = qi;
      const question = questions[qi];
      this.log.line(`discussion ${record.id} round ${qi + 1}/${questions.length} → ${parts.join(',')} (parallel)`);

      // Concurrent dispatch: each _ask only resolves on its own agent's reply,
      // so N in-flight waits do not interfere with each other.
      const results = await Promise.all(parts.map(async (speaker) => {
        const prompt = this._buildParallelPrompt(record, speaker, qi, question);
        const reply = await this._ask(record, speaker, prompt, state);
        return { speaker, reply };
      }));
      if (state.stopped) break;

      const roundTurns = [];
      for (const { speaker, reply } of results) {
        if (!reply) continue;
        if (reply.listen) {
          record.skips = record.skips || [];
          record.skips.push({ speaker, question: qi, at: Date.now() });
          continue;
        }
        accepted += 1;
        const turn = {
          n: record.turns.length + 1,
          speaker,
          at: Date.now(),
          text: reply.text,
          tokens: estimateTokens(reply.text),
          question: question === null ? undefined : qi,
        };
        record.turns.push(turn);
        record.tokens += turn.tokens;
        record.lastSpeaker = speaker;
        roundTurns.push(turn);
      }
      this.store.set(record.id, record);
      this.sse.broadcast('discussion', record);

      if (!roundTurns.length) continue; // everyone passed this question

      // Gate: convergence — the independent answers ended up identical.
      if (roundTurns.length >= 2) {
        const sims = [];
        for (let i = 1; i < roundTurns.length; i++) sims.push(similarity(roundTurns[i - 1].text, roundTurns[i].text));
        if (sims.every((s) => s > 0.9)) { this._finish(record.id, 'converged', 'contributions stopped changing'); return; }
      }

      // Gate: stop keywords.
      const hit = (P.stopOn || []).find((k) => k && roundTurns.some((x) => x.text.includes(k)));
      if (hit) { this._finish(record.id, 'keyword', `stop keyword "${hit}"`); return; }

      // Synthesis: one speaker reconciles the parallel answers before moving on.
      if (P.synthesize !== false && questions.length > 1) {
        if (Date.now() > deadline) { this._finish(record.id, 'timeout', 'discussion timeout'); return; }
        const speaker = parts[qi % parts.length];
        this.log.line(`discussion ${record.id} round ${qi + 1} synthesis → ${speaker}`);
        const prompt = this._buildPrompt(record, speaker, record.turns.length + 1, state);
        const reply = await this._ask(record, speaker, prompt, state);
        if (state.stopped) break;
        if (reply && !reply.listen) {
          const turn = {
            n: record.turns.length + 1,
            speaker,
            at: Date.now(),
            text: reply.text,
            tokens: estimateTokens(reply.text),
            question: qi,
          };
          record.turns.push(turn);
          record.tokens += turn.tokens;
          this.store.set(record.id, record);
          this.sse.broadcast('discussion', record);
        }
      }
    }

    if (!state.stopped) {
      this._finish(record.id, 'max-rounds', `${questions.length} round(s), ${record.turns.length} contribution(s)`);
    }
  }

  /** Prompt for a parallel turn: no peer answers, so the opinion stays independent. */
  _buildParallelPrompt(record, speaker, qi, question) {
    const agent = this.registry.get(speaker);
    return [
      `【团队讨论】你是${agent.name}${agent.role ? `（${agent.role}）` : ''}。`,
      `话题：${record.topic}`,
      question ? `\n本轮要回答的问题（${qi + 1}/${record.questions.length}）：${question}` : '',
      '',
      '现在是并行发言：其他成员也在同时作答，你暂时看不到他们的回答，请给出你自己独立、明确的判断。',
      '不要复述任务，不要使用 @ 提及，控制在 200 字以内。',
      '如果你对这个问题确实没有新的补充，只回复 LISTEN（不要解释，不要客套）。',
    ].filter(Boolean).join('\n');
  }

  /**
   * Move to the next question. Returns false when there is none left, which is
   * the caller's signal to stop rather than loop on the last one.
   */
  _advanceQuestion(record, state) {
    if (!record.questions || !record.questions.length) return false;
    if (state.questionIndex >= record.questions.length - 1) return false;
    state.questionIndex += 1;
    state.listened.clear();
    state.turnsInQuestion = 0;
    this.log.line(`discussion ${record.id} → question ${state.questionIndex + 1}/${record.questions.length}`);
    return true;
  }

  /* ── task specification ───────────────────────────────── */

  /**
   * Turn the topic into a short list of answerable questions.
   * One small-model call; failure is non-fatal — the discussion just runs on
   * the raw topic as before.
   */
  async _planQuestions(record) {
    const sel = (this.config && this.config.selector) || null;
    if (!sel || !sel.url) return null;

    const people = record.participants
      .map((id) => {
        const a = this.registry.get(id);
        return `- ${a.name}${a.role ? '（' + a.role + '）' : ''}`;
      })
      .join('\n');

    const prompt = [
      '你要主持一场团队讨论。请把话题拆成 2–4 个必须回答的具体问题。',
      '要求：每个问题都能被明确回答，不要是"怎么看"这种开放题。',
      '只输出问题本身，一行一个，不要编号，不要任何解释。',
      '',
      `话题：${record.topic}`,
      '',
      '参与者：',
      people,
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
          max_tokens: 300,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(sel.timeoutMs || 20000),
      });
      if (!res.ok) return null;
      const j = await res.json();
      const raw = String(j?.choices?.[0]?.message?.content || '');

      const lines = raw
        .split('\n')
        .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
        .filter((l) => l.length >= 4 && l.length <= 120 && /[?？]$|。$/.test(l) || (l.length >= 6 && l.length <= 120));

      const questions = [...new Set(lines)].slice(0, record.policy.maxQuestions || 4);
      return questions.length >= 1 ? questions : null;
    } catch {
      return null;
    }
  }

  /* ── speaker selection ────────────────────────────────── */

  async _pickSpeaker(record, state, n) {
    const { policy, participants } = record;

    // Anyone who already declined on this question is out of the pool: calling
    // on them again just to hear "nothing to add" wastes a turn and tokens.
    const pool = participants.filter((id) => !state.listened.has(id));
    if (!pool.length) return null;

    if (policy.turnTaking === 'mention') {
      // Manual mode: the operator @-mentions someone in the room; we wait for
      // that mention instead of choosing.
      const picked = await this._waitForMention(record, state, pool);
      return picked && pool.includes(picked) ? picked : null;
    }

    if (policy.turnTaking === 'selector') {
      const picked = await this._selectWithModel(record, n, pool);
      if (picked) return picked;
      // fall through to round-robin on any failure
    }

    // round-robin (also the selector fallback).
    // n is 1-based, so (n-1) makes the *first* speaker participants[0] — with
    // n % len the rotation started one seat off.
    let idx = (n - 1) % pool.length;
    let candidate = pool[idx];
    if (!policy.allowRepeatSpeaker && candidate === state.lastSpeaker && pool.length > 1) {
      idx = (idx + 1) % pool.length;
      candidate = pool[idx];
    }
    return candidate;
  }

  /** Ask a small model who should speak. Returns null on any problem. */
  async _selectWithModel(record, n, pool = record.participants) {
    const sel = (this.config && this.config.selector) || null;
    if (!sel || !sel.url) return null;

    const people = pool
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
      const id = pool.find((p) => text.toLowerCase().includes(p.toLowerCase()));
      if (!id) return null;
      if (id === record.lastSpeaker && !record.policy.allowRepeatSpeaker && pool.length > 1) {
        return null; // let round-robin pick someone else
      }
      return id;
    } catch {
      return null; // silent fallback; a selector outage must not kill the room
    }
  }

  /** Manual mode: park until the operator mentions a participant. */
  _waitForMention(record, state, pool = record.participants) {
    return new Promise((resolve) => {
      const onSay = (msg) => {
        if (msg.room !== record.room) return;
        const hit = pool.find((p) => (msg.mentions || []).includes(p));
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

  _buildPrompt(record, speaker, n, state) {
    const agent = this.registry.get(speaker);
    const others = record.participants
      .filter((id) => id !== speaker)
      .map((id) => this.registry.get(id)?.name || id)
      .join('、');

    const qIndex = state ? state.questionIndex : 0;
    const question = record.questions && record.questions.length
      ? record.questions[Math.min(qIndex, record.questions.length - 1)]
      : null;

    const history = record.turns
      .filter((t) => !question || t.question === undefined || t.question === qIndex)
      .map((t) => {
        const who = this.registry.get(t.speaker)?.name || t.speaker;
        return `${who}：${t.text}`;
      })
      .join('\n');

    return [
      `【团队讨论】你是${agent.name}${agent.role ? `（${agent.role}）` : ''}。`,
      `话题：${record.topic}`,
      question ? `\n本轮要回答的问题（${qIndex + 1}/${record.questions.length}）：${question}` : '',
      `其他参与者：${others || '无'}`,
      history ? `\n本轮已有发言：\n${history}` : '',
      '',
      '请直接说出你的判断，不要复述任务，不要使用 @ 提及，控制在 200 字以内。',
      // Give the agent an honest way out instead of making it pad a turn.
      '如果你对这个问题确实没有新的补充，只回复 LISTEN（不要解释，不要客套）。',
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
        const text = String(message.text || '').trim();
        // An explicit pass is a valid answer: the agent has nothing to add.
        if (LISTEN_RE.test(text)) return finish({ listen: true, id: message.id });
        finish({ text, id: message.id });
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

    const nameOf = (id) => this.registry.get(id)?.name || id;
    const brief = (t) => {
      const one = t.text.replace(/\s+/g, ' ');
      return `${nameOf(t.speaker)}：${one.length > 90 ? one.slice(0, 90) + '…' : one}`;
    };

    // With questions, group the recap by question — that is the shape the
    // reader needs ("what did we decide about X"), not a flat transcript.
    if (record.questions && record.questions.length) {
      const blocks = record.questions.map((q, i) => {
        const inQ = record.turns.filter((t) => t.question === i);
        const body = inQ.length
          ? inQ.map((t) => `· ${brief(t)}`).join('\n')
          : '· （本轮无人补充）';
        return `**${i + 1}. ${q}**\n${body}`;
      });
      const passed = (record.skips || []).length
        ? `\n\n（另有 ${record.skips.length} 次主动弃权）`
        : '';
      return `${head}\n\n${blocks.join('\n\n')}${passed}\n\n完整记录见房间 ${record.room}`;
    }

    const lines = record.turns.map((t) => `· ${brief(t)}`);
    return `${head}\n\n${lines.join('\n')}\n\n完整记录见房间 ${record.room}`;
  }
}
