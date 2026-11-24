/**
 * Integration guard for the "disable a connected agent" path.
 *
 * The HTTP surface is unit-tested in disable.test.mjs, but the original bug was
 * that an ALREADY-connected WebSocket kept working after disable. That can only
 * be caught end-to-end, so this test boots a real hub on an ephemeral port.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A global WebSocket client only exists in Node >=22. On older runtimes this
// end-to-end guard is skipped rather than failing the whole suite.
const hasWebSocket = typeof WebSocket === 'function';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ADMIN = 'test-admin-token';

function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a disabled agent is cut off mid-connection and cannot write', { skip: !hasWebSocket && 'global WebSocket requires Node >=22' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ath-ws-'));
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port, defaultRoom: 'team', adminToken: ADMIN,
    storage: { driver: 'local' }, agents: [],
  }));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: { ...process.env, HUB_CONFIG: path.join(dir, 'config.json'), HUB_DATA_DIR: dir },
    stdio: 'ignore',
  });
  const base = 'http://127.0.0.1:' + port;
  try {
    for (let i = 0; i < 50; i++) { try { const r = await fetch(base + '/api/hub'); if (r.ok) break; } catch {} await sleep(100); }

    const g = await (await fetch(base + '/api/admin/grant', {
      method: 'POST', headers: { 'x-admin-token': ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'W', id: 'w1' }),
    })).json();
    const j = await (await fetch(base + '/api/join', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: g.invite.code }),
    })).json();

    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?role=agent&agent=w1&token=' + encodeURIComponent(j.token));
    let closed = false;
    ws.onclose = () => { closed = true; };
    await new Promise((res) => { ws.onmessage = (e) => { if (JSON.parse(e.data).event === 'hello') res(); }; setTimeout(res, 1500); });

    const d = await fetch(base + '/api/admin/agents/w1/disable', { method: 'POST', headers: { 'x-admin-token': ADMIN } });
    assert.equal(d.status, 200);
    await sleep(400);
    assert.equal(closed, true, 'socket must close as soon as the agent is disabled');

    try { ws.send(JSON.stringify({ type: 'reply', msgId: null, text: 'SHOULD_NOT_SAVE' })); } catch { /* closed already */ }
    await sleep(500);

    const msgs = await (await fetch(base + '/api/messages?room=team&after=0')).json();
    assert.equal(JSON.stringify(msgs).includes('SHOULD_NOT_SAVE'), false, 'disabled agent must not write');
  } finally {
    child.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
