/**
 * Config loading: secret injection and normalisation.
 *
 * The reason this matters: config.example.json is committed and refers to
 * `${R2_SECRET_ACCESS_KEY}`. If expansion silently did nothing, the hub would
 * start with a literal placeholder as the credential and only fail later, at
 * upload time, with a signature error that points nowhere useful.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expandEnv, loadConfig } from './config.mjs';

test('expandEnv substitutes simple references', () => {
  const out = expandEnv('${A}-${B}', { A: 'one', B: 'two' });
  assert.equal(out, 'one-two');
});

test('expandEnv walks nested objects and arrays', () => {
  const cfg = {
    storage: { r2: { accountId: '${ACC}', key: '${KEY}' } },
    list: ['${ACC}', 'plain'],
    n: 42,
    b: true,
  };
  const out = expandEnv(cfg, { ACC: 'a1', KEY: 'k1' });
  assert.deepEqual(out, {
    storage: { r2: { accountId: 'a1', key: 'k1' } },
    list: ['a1', 'plain'],
    n: 42,
    b: true,
  });
});

test('a missing variable expands to empty, so the feature disables itself', () => {
  // storage.mjs treats an empty credential as "not configured" and falls back to
  // local disk; a literal "${MISSING}" would instead be sent to R2 and fail.
  assert.equal(expandEnv('${MISSING}', {}), '');
  assert.equal(expandEnv('${MISSING}', { MISSING: '' }), '');
});

test('expandEnv leaves non-references alone', () => {
  assert.equal(expandEnv('plain text', {}), 'plain text');
  assert.equal(expandEnv('$NOT_A_REF', {}), '$NOT_A_REF');
  assert.equal(expandEnv('${lower_case}', { lower_case: 'x' }), '${lower_case}');
});

test('loadConfig expands ${VAR} from the environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    adminToken: '${TEST_ADMIN_TOKEN}',
    storage: {
      driver: 'r2',
      r2: { accountId: '${TEST_ACC}', bucket: 'b', accessKeyId: 'a', secretAccessKey: '${TEST_SECRET}' },
    },
    agents: [{ id: 'x', name: 'X' }],
  }));

  const prev = {
    TEST_ADMIN_TOKEN: process.env.TEST_ADMIN_TOKEN,
    TEST_ACC: process.env.TEST_ACC,
    TEST_SECRET: process.env.TEST_SECRET,
  };
  process.env.TEST_ADMIN_TOKEN = 'admin-xyz';
  process.env.TEST_ACC = 'acc-1';
  process.env.TEST_SECRET = 'shh-1';

  try {
    const cfg = loadConfig(file);
    assert.equal(cfg.adminToken, 'admin-xyz');
    assert.equal(cfg.storage.r2.accountId, 'acc-1');
    assert.equal(cfg.storage.r2.secretAccessKey, 'shh-1');
    assert.equal(cfg.storage.r2.bucket, 'b');
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig normalises the agent list and defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    agents: [
      { id: 'a', name: 'A', mode: 'push', adapter: 'cli-once' },
      { id: 'b' },
      { id: 'off', enabled: false },
    ],
  }));

  try {
    const cfg = loadConfig(file);
    assert.equal(cfg.agents.length, 3);
    assert.equal(cfg.agents[0].mode, 'push');
    assert.equal(cfg.agents[1].mode, 'connector', 'connector is the default mode');
    assert.equal(cfg.agents[2].enabled, false);
    assert.equal(cfg.human.id, 'human');
    assert.ok(cfg.contextWindow > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
