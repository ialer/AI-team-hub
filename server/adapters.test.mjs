/**
 * Adapter helpers.
 *
 * The session flag split is the one that bit in production: it looked like a
 * CLI usage error, not like a quoting bug, and only appeared on the *second*
 * message to an agent (the first has no session to resume).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sessionArgs } from './adapters/builtin.mjs';

test('a flag with a placeholder becomes two argv tokens', () => {
  // The bug: pushing "--resume local-abc" as ONE argument makes argparse read a
  // single unknown flag and print usage instead of resuming.
  assert.deepEqual(
    sessionArgs('--resume {sessionId}', 'local-abc'),
    ['--resume', 'local-abc'],
  );
  assert.deepEqual(
    sessionArgs('--session-id {sessionId}', 'session-1'),
    ['--session-id', 'session-1'],
  );
});

test('a bare placeholder stays one token (positional session argument)', () => {
  // The dsh wrapper script takes the session id as a positional argument.
  assert.deepEqual(sessionArgs('{sessionId}', 'session-1'), ['session-1']);
});

test('an array template is passed through unchanged', () => {
  assert.deepEqual(
    sessionArgs(['--session-id', '{sessionId}'], 's9'),
    ['--session-id', 's9'],
  );
});

test('no session means no extra arguments', () => {
  assert.deepEqual(sessionArgs('--resume {sessionId}', ''), []);
  assert.deepEqual(sessionArgs('--resume {sessionId}', null), []);
  assert.deepEqual(sessionArgs('', 'sid'), []);
  assert.deepEqual(sessionArgs(undefined, 'sid'), []);
});

test('extra internal whitespace does not produce empty tokens', () => {
  assert.deepEqual(
    sessionArgs('  --resume   {sessionId}  ', 'sid'),
    ['--resume', 'sid'],
  );
});
