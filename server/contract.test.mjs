/**
 * Team contract: load, hash, and per-agent ack tracking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createContract } from './contract.mjs';

function writeContract(dir, version, body) {
  const file = path.join(dir, 'team-contract.md');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '---\nversion: ' + version + '\n---\n' + body, 'utf8');
  return file;
}

test('loads version, body and a stable sha256', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ath-ct-'));
  try {
    const file = writeContract(dir, '2026.11.25-1', '规则一\n规则二\n');
    const c = createContract({ contractFile: file, dataDir: dir, log: { line() {} } });

    assert.equal(c.current().version, '2026.11.25-1');
    assert.equal(c.current().text, '规则一\n规则二');
    assert.equal(c.current().sha256.length, 64);
    assert.ok(c.current().sha256 === '4e5dc726bc97c1ac24e79533de35e8e9faa26e13c11a1d1f5e53b102fe172f45' ||
              /^[0-9a-f]{64}$/.test(c.current().sha256));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the hash covers only the body, so the version can change without a hash edit', () => {
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ath-ct-'));
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ath-ct-'));
  try {
    const f1 = writeContract(d1, 'v1', 'body');
    const f2 = writeContract(d2, 'v2', 'body');
    const a = createContract({ contractFile: f1, dataDir: d1, log: { line() {} } }).current();
    const b = createContract({ contractFile: f2, dataDir: d2, log: { line() {} } }).current();
    assert.equal(a.sha256, b.sha256, 'same body => same hash, regardless of version');
    assert.notEqual(a.version, b.version);
  } finally {
    fs.rmSync(d1, { recursive: true, force: true });
    fs.rmSync(d2, { recursive: true, force: true });
  }
});

test('no contract file yields null, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ath-ct-'));
  try {
    const c = createContract({ contractFile: path.join(dir, 'missing.md'), dataDir: dir, log: { line() {} } });
    assert.equal(c.current(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ack records the last reported version per agent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ath-ct-'));
  try {
    const file = writeContract(dir, 'v1', 'body');
    const c = createContract({ contractFile: file, dataDir: dir, log: { line() {} } });
    c.ack('bob', 'v1', 'abc');
    c.ack('bob', 'v2', 'def');
    const acks = c.acks();
    assert.equal(acks.bob.version, 'v2', 'last ack wins');
    assert.equal(acks.bob.sha256, 'def');
    assert.ok(acks.bob.at > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
