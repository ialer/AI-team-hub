/**
 * Atomic writes must honour an explicit mode where the platform supports it.
 * Windows does not map POSIX modes, so the strict check is posix-only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeJsonAtomic } from './store.mjs';

test('writeJsonAtomic applies mode 0o600 (posix only)', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ath-mode-'));
  const file = path.join(dir, 'tokens.json');
  try {
    writeJsonAtomic(file, { a: 1 }, { mode: 0o600 });
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, 'file must be 0600, got 0o' + mode.toString(8));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
