/**
 * Workspace surfaces: read-only shelf plus the write path added for
 * "agent output lands on the shelf". The write side is where a path traversal
 * would live, so that gets explicit coverage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSurfaces } from './surfaces.mjs';

function makeSurfaces() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ath-surf-'));
  const lines = [];
  const s = createSurfaces({ dataDir: dir, log: { line: (t) => lines.push(t) } });
  return { s, dir, lines };
}

test('docs: write, list and fetch round-trip', async () => {
  const { s, dir } = makeSurfaces();
  try {
    const item = await s.write('docs', { id: 'plan', content: '# 计划\nhello' });
    assert.equal(item.id, 'plan.md');
    assert.equal(item.title, 'plan');

    const list = await s.items('docs');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'plan.md');

    const doc = await s.resolve('docs', 'plan.md');
    assert.equal(doc.content, '# 计划\nhello');
    assert.ok(fs.existsSync(path.join(dir, 'docs', 'plan.md')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('docs: a traversal name stays inside the docs directory', async () => {
  const { s, dir } = makeSurfaces();
  try {
    const item = await s.write('docs', { id: '../../escape', content: 'x' });
    assert.equal(item.id, 'escape.md');
    assert.ok(fs.existsSync(path.join(dir, 'docs', 'escape.md')), 'written inside docs/');
    assert.equal(fs.existsSync(path.join(dir, 'escape.md')), false, 'did not escape');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('docs: overwrite=false refuses to clobber', async () => {
  const { s, dir } = makeSurfaces();
  try {
    await s.write('docs', { id: 'a', content: 'one' });
    await assert.rejects(
      () => s.write('docs', { id: 'a', content: 'two', overwrite: false }),
      (e) => e.status === 409,
    );
    assert.equal((await s.resolve('docs', 'a.md')).content, 'one');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tasks: upsert adds, updates and removes', async () => {
  const { s, dir } = makeSurfaces();
  try {
    await s.write('tasks', { upsert: { id: 't1', title: '迁 Hub', status: 'doing', owner: 'bob' } });
    let list = await s.items('tasks');
    assert.equal(list.length, 1);
    assert.equal(list[0].meta, 'doing · @bob');

    await s.write('tasks', { upsert: { id: 't1', title: '迁 Hub', status: 'done', owner: 'bob' } });
    list = await s.items('tasks');
    assert.equal(list.length, 1, 'upsert did not duplicate');
    assert.equal(list[0].meta, 'done · @bob');

    await s.write('tasks', { upsert: { id: 't2', title: '补 README' } });
    assert.equal((await s.items('tasks')).length, 2);

    await s.write('tasks', { remove: 't1' });
    list = await s.items('tasks');
    assert.deepEqual(list.map((x) => x.id), ['t2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tasks: removing an unknown id is a 404, not a silent success', async () => {
  const { s, dir } = makeSurfaces();
  try {
    await assert.rejects(() => s.write('tasks', { remove: 'nope' }), (e) => e.status === 404);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('files: binary content survives the round-trip', async () => {
  const { s, dir } = makeSurfaces();
  try {
    const buf = Buffer.from([0x00, 0x01, 0xff, 0x41]);
    const item = await s.write('files', { name: 'blob.bin', buffer: buf });
    assert.equal(item.id, 'blob.bin');
    assert.ok(fs.readFileSync(path.join(dir, 'files', 'blob.bin')).equals(buf));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown surface cannot be written', async () => {
  const { s, dir } = makeSurfaces();
  try {
    await assert.rejects(() => s.write('nope', {}), (e) => e.status === 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('items remember who wrote them', async () => {
  const { s, dir } = makeSurfaces();
  try {
    await s.write('docs', { id: 'a', content: 'x', author: { id: 'bob', name: 'Bob' } });
    await s.write('files', { name: 'b.txt', buffer: Buffer.from('y'), author: { id: 'human', name: '我' } });
    await s.write('tasks', { upsert: { id: 't1', title: 'z' }, author: { id: 'carol', name: 'Carol' } });

    const docs = await s.items('docs');
    assert.equal(docs[0].by, 'bob');
    assert.equal(docs[0].byName, 'Bob');

    const files = await s.items('files');
    assert.equal(files[0].byName, '我');

    const tasks = await s.items('tasks');
    assert.equal(tasks[0].byName, 'Carol');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an item written without an author has no badge data', async () => {
  const { s, dir } = makeSurfaces();
  try {
    await s.write('docs', { id: 'anon', content: 'x' });
    const [it] = await s.items('docs');
    assert.equal(it.by, undefined);
    assert.equal(it.byName, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing a task does not re-attribute the survivors', async () => {
  const { s, dir } = makeSurfaces();
  try {
    await s.write('tasks', { upsert: { id: 't1', title: 'one' }, author: { id: 'a', name: '甲' } });
    await s.write('tasks', { upsert: { id: 't2', title: 'two' }, author: { id: 'b', name: '乙' } });
    await s.write('tasks', { remove: 't1', author: { id: 'c', name: '丙' } });
    const left = await s.items('tasks');
    assert.deepEqual(left.map((x) => x.id), ['t2']);
    assert.equal(left[0].byName, '乙', 'survivor keeps its own author');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
