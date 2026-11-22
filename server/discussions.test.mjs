/**
 * Run with: node --test "server/*.test.mjs"
 *
 * Unit tests for DiscussionManager. Everything is in-process: a fake hub with
 * an EventEmitter, a fake registry, and an in-memory store. No network, no real
 * agents — a "reply" is just a 'turn' event emitted back into the fake hub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { DiscussionManager } from './discussions.mjs';

/* ── fixtures ──────────────────────────────────────────── */

const PEOPLE = {
  a: { id: 'a', name: '安琪', role: '架构' },
  b: { id: 'b', name: '伯言', role: '评审' },
  c: { id: 'c', name: '晨曦', role: '观察' },
};

function makeRegistry() {
  return { get: (id) => PEOPLE[id] ?? null };
}

function makeStore() {
  const m = new Map();
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    set: (k, v) => { m.set(k, v); return v; },
    all: () => Object.fromEntries(m),
  };
}

/**
 * `replyFor(turnIndex, speaker, sayText)` returns the text that speaker
 * "replies" with, or null to stay silent. By default the turn event is emitted
 * synchronously (the listener is already attached when `say` runs); set
 * replyDelayMs to leave room for the test to intervene, e.g. call stop().
 */
function makeHub(replyFor, { replyDelayMs = 0 } = {}) {
  const events = new EventEmitter();
  const said = [];
  const hub = {
    events,
    said,
    say(msg) {
      said.push(msg);
      if (msg.kind !== 'discussion' || typeof replyFor !== 'function') return;
      const m = /^@(\S+)\s/.exec(String(msg.text || ''));
      if (!m) return;
      const speaker = m[1];
      const turnIndex = said.reduce((n, s) => n + (s.kind === 'discussion' ? 1 : 0), 0) - 1;
      const text = replyFor(turnIndex, speaker, msg.text);
      if (text == null) return; // stay silent → turnTimeoutSec will fire
      const emit = () => events.emit('turn', {
        agentId: speaker,
        message: { room: msg.room, text, id: `msg-${said.length}` },
      });
      if (replyDelayMs > 0) setTimeout(emit, replyDelayMs);
      else emit();
    },
  };
  return hub;
}

function makeManager({ hub, registry, store, config } = {}) {
  return new DiscussionManager({
    hub: hub ?? makeHub(),
    registry: registry ?? makeRegistry(),
    store: store ?? makeStore(),
    sse: { broadcast() {} },
    log: { line() {} },
    config: config ?? {},
  });
}

// Replies that are clearly different from each other, so convergence does not
// fire in tests that are not about convergence.
const DIFFERENT = [
  '从架构角度先拆清模块边界与接口契约。',
  '数据模型我建议按读写分离重新设计。',
  '部署与回滚路径必须提前写清楚。',
  '监控告警和压测指标也要一并补上。',
  '文档结构按实际场景重新组织一遍。',
  '这里的安全边界还需要再确认一下。',
  '上一版的兼容层要不要保留，我倾向保留。',
  '排期上先做核心链路，边角放到后面。',
];
const varying = (i) => DIFFERENT[i % DIFFERENT.length];

/** Poll the store until status leaves 'running', with a hard timeout. */
function waitForStatus(mgr, id, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const rec = mgr.get(id);
      if (rec && rec.status !== 'running') return resolve(rec);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(
          `discussion ${id} did not settle within ${timeoutMs}ms ` +
          `(status=${rec?.status}, turns=${rec?.turns?.length})`,
        ));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function waitUntil(pred, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const BASE = { turnTimeoutSec: 2, timeoutSec: 30 };

/* ── 1. validation ─────────────────────────────────────── */

test('create rejects unknown/single participants and empty topics', () => {
  const mgr = makeManager();
  assert.throws(
    () => mgr.create({ topic: 'x', participants: ['a'] }),
    /at least two known agents/,
  );
  assert.throws(
    () => mgr.create({ topic: 'x', participants: ['a', 'ghost'] }),
    /at least two known agents/,
  );
  assert.throws(
    () => mgr.create({ topic: '   ', participants: ['a', 'b'] }),
    /topic is required/,
  );
  assert.throws(
    () => mgr.create({ topic: '', participants: ['a', 'b'] }),
    /topic is required/,
  );
});

/* ── 2. round-robin ────────────────────────────────────── */

test('round-robin rotates in a fixed order and never repeats with allowRepeatSpeaker:false', async () => {
  const hub = makeHub((i) => varying(i));
  const mgr = makeManager({ hub });
  const rec = mgr.create({
    topic: '方案选型', participants: ['a', 'b', 'c'],
    policy: { ...BASE, maxTurns: 3, allowRepeatSpeaker: false },
  });
  const done = await waitForStatus(mgr, rec.id);
  assert.equal(done.status, 'done');
  assert.equal(done.turns.length, 3);
  // _pickSpeaker uses `n % participants.length`; n starts at 1 → b, c, a.
  assert.deepEqual(done.turns.map((t) => t.speaker), ['a', 'b', 'c']);
  for (let i = 1; i < done.turns.length; i++) {
    assert.notEqual(done.turns[i].speaker, done.turns[i - 1].speaker);
  }
});

/* ── 3. maxTurns ───────────────────────────────────────── */

test('maxTurns stops after exactly N turns and reports the count', async () => {
  const hub = makeHub((i) => varying(i));
  const mgr = makeManager({ hub });
  const rec = mgr.create({
    topic: '预算', participants: ['a', 'b'],
    policy: { ...BASE, maxTurns: 2 },
  });
  const done = await waitForStatus(mgr, rec.id);
  assert.equal(done.status, 'done');
  assert.equal(done.turns.length, 2);
  assert.match(done.stopReason, /2 turns/);
});

/* ── 4. stop keyword ───────────────────────────────────── */

test('stopOn keyword ends the discussion immediately with status keyword', async () => {
  const hub = makeHub((i) => (i === 0 ? '我同意，就此收尾 DONE' : varying(i)));
  const mgr = makeManager({ hub });
  const rec = mgr.create({
    topic: '收尾', participants: ['a', 'b'],
    policy: { ...BASE, maxTurns: 6, stopOn: ['DONE'] },
  });
  const done = await waitForStatus(mgr, rec.id);
  assert.equal(done.status, 'keyword');
  assert.equal(done.turns.length, 1);
  assert.match(done.stopReason, /DONE/);
});

/* ── 5. external stop ──────────────────────────────────── */

test('stop() halts a running discussion with status stopped', async () => {
  const hub = makeHub((i) => varying(i), { replyDelayMs: 50 });
  const mgr = makeManager({ hub });
  const rec = mgr.create({
    topic: '中断', participants: ['a', 'b'],
    policy: { ...BASE, maxTurns: 20, turnTimeoutSec: 3 },
  });
  await waitUntil(() => hub.said.some((s) => s.kind === 'discussion'));
  await mgr.stop(rec.id, 'operator halted');
  const done = await waitForStatus(mgr, rec.id);
  assert.equal(done.status, 'stopped');
  assert.match(done.stopReason, /operator halted/);
});

/* ── 6. token budget ───────────────────────────────────── */

test('a tiny maxTokens ends the discussion with status budget after the first turn', async () => {
  const hub = makeHub((i) => varying(i));
  const mgr = makeManager({ hub });
  const rec = mgr.create({
    topic: '预算控制', participants: ['a', 'b'],
    policy: { ...BASE, maxTurns: 10, maxTokens: 1 },
  });
  const done = await waitForStatus(mgr, rec.id);
  assert.equal(done.status, 'budget');
  assert.equal(done.turns.length, 1);
  assert.ok(done.tokens >= 1);
  assert.match(done.stopReason, /budget/);
});

/* ── 7. convergence ────────────────────────────────────── */

test('three near-identical consecutive replies stop early via convergence', async () => {
  const same = '这个方案的思路一致，我们没有新的补充意见，可以定下来了。';
  const hub = makeHub(() => same);
  const mgr = makeManager({ hub });
  const rec = mgr.create({
    topic: '收敛', participants: ['a', 'b', 'c'],
    policy: { ...BASE, maxTurns: 12, convergenceRounds: 3 },
  });
  const done = await waitForStatus(mgr, rec.id);
  // converged keeps its own status, so callers can distinguish it from maxTurns.
  assert.equal(done.status, 'converged');
  assert.equal(done.turns.length, 3);
  assert.equal(done.stopReason, 'contributions stopped changing');
});

/* ── 8. selector fallback ──────────────────────────────── */

test('selector falls back to round-robin when unset or when the request fails', async () => {
  {
    const hub = makeHub((i) => varying(i));
    const mgr = makeManager({ hub });
    const rec = mgr.create({
      topic: '无选择器', participants: ['a', 'b', 'c'],
      policy: { ...BASE, turnTaking: 'selector', maxTurns: 3 },
    });
    const done = await waitForStatus(mgr, rec.id);
    assert.equal(done.status, 'done');
    assert.deepEqual(done.turns.map((t) => t.speaker), ['a', 'b', 'c']);
  }
  {
    const hub = makeHub((i) => varying(i + 3));
    // An invalid URL makes fetch() reject locally — no network is touched.
    const mgr = makeManager({ hub, config: { selector: { url: 'not-a-valid-url', timeoutMs: 200 } } });
    const rec = mgr.create({
      topic: '选择器故障', participants: ['a', 'b', 'c'],
      policy: { ...BASE, turnTaking: 'selector', maxTurns: 3 },
    });
    const done = await waitForStatus(mgr, rec.id);
    assert.equal(done.status, 'done');
    assert.deepEqual(done.turns.map((t) => t.speaker), ['a', 'b', 'c']);
  }
});

/* ── 9. recap ──────────────────────────────────────────── */

test('finishing posts one recap into the default room with topic and names', async () => {
  const hub = makeHub((i) => varying(i));
  const mgr = makeManager({ hub, config: { defaultRoom: 'hq' } });
  const rec = mgr.create({
    topic: '项目复盘', participants: ['a', 'b'],
    policy: { ...BASE, maxTurns: 2 },
  });
  const done = await waitForStatus(mgr, rec.id);
  assert.equal(done.status, 'done');
  const recaps = hub.said.filter((m) => m.kind === 'system');
  assert.equal(recaps.length, 1);
  assert.equal(recaps[0].room, 'hq');
  assert.match(recaps[0].text, /项目复盘/);
  assert.match(recaps[0].text, /安琪/);
  assert.match(recaps[0].text, /伯言/);
  assert.match(recaps[0].text, /讨论结束/);
});

/* ── 10. Listen (declining a turn) ─────────────────────── */

test('LISTEN does not consume a turn and that speaker is skipped', async () => {
  // 'b' declines; the room should still get three real contributions, and b
  // should only be called on once.
  const calls = { a: 0, b: 0, c: 0 };
  const hub = makeHub((i, speaker) => {
    calls[speaker] = (calls[speaker] || 0) + 1;
    if (speaker === 'b' && calls.b === 1) return 'LISTEN';
    return varying(i);
  });
  const mgr = makeManager({ hub });
  const rec = mgr.create({
    topic: 'Listen 测试', participants: ['a', 'b', 'c'],
    policy: { ...BASE, maxTurns: 3, planFirst: false },
  });
  const done = await waitForStatus(mgr, rec.id);

  assert.equal(done.status, 'done');
  assert.equal(done.turns.length, 3, 'a pass must not consume a turn');
  assert.ok(!done.turns.some((t) => t.speaker === 'b' && /listen/i.test(t.text)));
  assert.equal(done.skips.length, 1, 'one pass recorded');
  assert.equal(done.skips[0].speaker, 'b');
});

test('all participants passing ends the discussion as all-passed', async () => {
  const hub = makeHub(() => 'LISTEN');
  const mgr = makeManager({ hub });
  const rec = mgr.create({
    topic: '全都弃权', participants: ['a', 'b', 'c'],
    policy: { ...BASE, maxTurns: 5, planFirst: false },
  });
  const done = await waitForStatus(mgr, rec.id);

  assert.equal(done.status, 'all-passed');
  assert.equal(done.turns.length, 0);
  assert.ok(done.skips.length >= 3, 'everyone should have been asked once');
});

test('the Chinese pass marker is recognised too', async () => {
  const hub = makeHub((i, speaker) => (speaker === 'a' ? '【弃权】' : varying(i)));
  const mgr = makeManager({ hub });
  const rec = mgr.create({
    topic: '中文弃权', participants: ['a', 'b'],
    policy: { ...BASE, maxTurns: 2, planFirst: false },
  });
  const done = await waitForStatus(mgr, rec.id);
  assert.equal(done.status, 'done');
  assert.equal(done.skips.length, 1);
  assert.equal(done.skips[0].speaker, 'a');
});

/* ── 11. planned questions ─────────────────────────────── */

test('without a selector the discussion still runs on the raw topic', async () => {
  // planFirst is on by default; a missing selector must not break anything.
  const hub = makeHub((i) => varying(i));
  const mgr = makeManager({ hub, config: {} });
  const rec = mgr.create({
    topic: '没有拆题器', participants: ['a', 'b'],
    policy: { ...BASE, maxTurns: 2 },
  });
  const done = await waitForStatus(mgr, rec.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.questions, []);
  assert.equal(done.turns.length, 2);
});

test('recap groups contributions under their question', async () => {
  const hub = makeHub((i) => varying(i));
  const store = makeStore();
  const mgr = makeManager({ hub, store });
  const rec = mgr.create({
    topic: '分组纪要', participants: ['a', 'b'],
    policy: { ...BASE, maxTurns: 2, planFirst: false },
  });
  const done = await waitForStatus(mgr, rec.id);

  // Inject questions and tag the existing turns, then re-render the recap.
  done.questions = ['先迁哪一台？', '回滚路径怎么写？'];
  done.turns[0].question = 0;
  done.turns[1].question = 1;
  const text = mgr._recap(done);

  assert.match(text, /1\. 先迁哪一台？/);
  assert.match(text, /2\. 回滚路径怎么写？/);
  assert.match(text, /安琪|伯言/);
});