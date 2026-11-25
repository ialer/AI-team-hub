/**
 * Wake routing when an agent is already mid-turn.
 *
 * Dropping the second mention was a real bug: the agent answered the first
 * message and the second one vanished with only a log line. These tests pin the
 * queue-and-drain behaviour instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Hub } from './hub.mjs';

function makeHub({ deliver = true, limit } = {}) {
  const delivered = [];
  const queued = [];
  const messages = {
    items: [],
    tail: () => [],
    append: (m) => ({ id: m.id ?? 1, ...m }),
  };
  const hub = new Hub({
    config: {
      defaultRoom: 'team',
      contextWindow: 5,
      wakeTimeout: 180,
      ...(limit ? { pendingWakeLimit: limit } : {}),
      agents: [],
    },
    log: { line() {} },
    messages,
    registry: {
      get: (id) => ({ id, name: id, enabled: true, mode: 'connector' }),
      publicView: () => ({}),
      list: () => [],
      sessionFor: () => null,
    },
    sse: { broadcast() {} },
    wakeQueue: { push: (id, payload) => queued.push({ id, payload }), clear() {} },
    dialogs: { get: () => null, set() {} },
  });
  hub.setWsSender((id, payload) => { delivered.push({ id, payload }); return deliver; });
  return { hub, delivered, queued };
}

const msg = (id) => ({ id, room: 'team', from: 'human', text: `@a m${id}`, mentions: ['a'], ts: Date.now() });

test('a mention that arrives mid-turn is queued, not dropped', () => {
  const { hub, delivered } = makeHub();
  hub.wake(msg(1));
  assert.equal(hub.inFlight.get('a').msgId, 1);

  hub.wake(msg(2));
  assert.equal(hub.pending.get('a').length, 1, 'second wake waited instead of vanishing');
  assert.equal(delivered.length, 1, 'only the first went out so far');
});

test('finishing a turn delivers the queued wake', () => {
  const { hub, delivered } = makeHub();
  hub.wake(msg(1));
  hub.wake(msg(2));
  hub.clearInFlight('a', 'replied');

  assert.equal(delivered.length, 2, 'queued wake was handed over');
  assert.equal(delivered[1].payload.msgId, 2);
  assert.equal(hub.inFlight.get('a').msgId, 2, 'agent is busy with the queued one');
  assert.equal(hub.pending.has('a'), false, 'queue drained');
});

test('the queue is bounded so a flood cannot pile up', () => {
  const { hub, delivered } = makeHub({ limit: 2 });
  hub.wake(msg(1));
  hub.wake(msg(2));
  hub.wake(msg(3));
  hub.wake(msg(4)); // over the limit → dropped by design
  assert.equal(hub.pending.get('a').length, 2);
  assert.equal(delivered.length, 1);
});

test('a poll-mode agent gets the queued wake through the poll queue', () => {
  const { hub, queued } = makeHub({ deliver: false });
  hub.wake(msg(1));
  hub.wake(msg(2));
  hub.clearInFlight('a', 'replied');
  assert.equal(queued.length, 2, 'both travelled via the poll queue');
  assert.deepEqual(queued.map((q) => q.payload.msgId), [1, 2]);
});
