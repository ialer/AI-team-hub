/**
 * Tests for the hand-rolled WebSocket layer.
 *
 * A protocol implementation without tests is a bug waiting for a slow network.
 * These cover the four places errors actually happen: the accept key, the
 * length encodings, masking, and fragmentation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { acceptKey, encodeFrame, encodeText, decodeFrame } from './ws.mjs';

const OP_TEXT = 0x1;
const OP_CONT = 0x0;

/** Build a client→server frame (which must be masked). */
function clientFrame(opcode, payload, { fin = true, mask = crypto.randomBytes(4) } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);

  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/* ── 1. handshake ─────────────────────────────────────── */

test('acceptKey matches the RFC 6455 example', () => {
  // RFC 6455 §1.3: key "dGhlIHNhbXBsZSBub25jZQ==" → "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

/* ── 2. length boundaries ─────────────────────────────── */

test('payload length survives every header form', () => {
  // 125 is the last 7-bit length; 126 and 65536 switch header formats.
  for (const size of [0, 1, 125, 126, 127, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(size, 0x61);
    const frame = encodeText(payload.toString());
    const decoded = decodeFrame(frame);
    assert.ok(decoded, `size ${size} should decode`);
    assert.equal(decoded.payload.length, size, `size ${size} round-trip`);
    assert.equal(decoded.opcode, OP_TEXT);
    assert.equal(decoded.fin, true);
    assert.equal(decoded.consumed, frame.length);
  }
});

/* ── 3. partial frames ────────────────────────────────── */

test('decodeFrame returns null until the whole frame has arrived', () => {
  const frame = clientFrame(OP_TEXT, 'hello world');
  // Feed one byte at a time; only the final byte completes it.
  for (let i = 1; i < frame.length; i++) {
    assert.equal(decodeFrame(frame.subarray(0, i)), null, `prefix of length ${i} must not decode`);
  }
  const full = decodeFrame(frame);
  assert.ok(full);
  assert.equal(full.payload.toString(), 'hello world');
});

test('decodeFrame consumes exactly one frame from a concatenated buffer', () => {
  const a = clientFrame(OP_TEXT, 'first');
  const b = clientFrame(OP_TEXT, 'second');
  const joined = Buffer.concat([a, b]);

  const first = decodeFrame(joined);
  assert.equal(first.payload.toString(), 'first');
  assert.equal(first.consumed, a.length);

  const second = decodeFrame(joined.subarray(first.consumed));
  assert.equal(second.payload.toString(), 'second');
});

/* ── 4. masking ───────────────────────────────────────── */

test('masked client payloads are unmasked correctly', () => {
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  const frame = clientFrame(OP_TEXT, 'Hello', { mask });
  const decoded = decodeFrame(frame);
  assert.equal(decoded.payload.toString(), 'Hello');
});

test('server frames are never masked', () => {
  const frame = encodeText('server->client');
  // The MASK bit is the high bit of byte 1.
  assert.equal(frame[1] & 0x80, 0, 'server frames must not set the mask bit');
});

test('reassembles a message split across continuation frames', () => {
  // One text frame with FIN=0 followed by two continuations, last with FIN=1.
  const p1 = clientFrame(OP_TEXT, 'AAA', { fin: false });
  const p2 = clientFrame(OP_CONT, 'BBB', { fin: false });
  const p3 = clientFrame(OP_CONT, 'CCC', { fin: true });

  let buf = Buffer.concat([p1, p2, p3]);
  const parts = [];
  let opcode = null;

  for (;;) {
    const f = decodeFrame(buf);
    if (!f) break;
    buf = buf.subarray(f.consumed);
    if (f.opcode === OP_TEXT) opcode = f.opcode;
    parts.push(f.payload.toString());
  }
  assert.equal(parts.join(''), 'AAABBBCCC');
  assert.equal(opcode, OP_TEXT);
});

/* ── 5. control frames and limits ─────────────────────── */

test('close and ping frames decode with their opcodes intact', () => {
  const close = clientFrame(0x8, Buffer.from([0x03, 0xe8])); // 1000
  const ping = clientFrame(0x9, Buffer.alloc(0));

  const dc = decodeFrame(close);
  assert.equal(dc.opcode, 0x8);
  assert.equal(dc.payload.readUInt16BE(0), 1000);

  const dp = decodeFrame(ping);
  assert.equal(dp.opcode, 0x9);
});

test('an oversized frame is rejected instead of allocated', () => {
  const huge = Buffer.alloc(2);
  huge[0] = 0x81;
  huge[1] = 0x80 | 127;
  const len = Buffer.alloc(8);
  len.writeBigUInt64BE(BigInt(64 * 1024 * 1024), 0);
  const frame = Buffer.concat([huge, len, Buffer.alloc(4)]);

  const out = decodeFrame(frame, 1024 * 1024);
  assert.ok(out, 'decoder should return a result, not throw');
  assert.equal(out.error, 'frame too large');
});

test('encodeFrame sets FIN on the first bit', () => {
  assert.equal(encodeFrame(OP_TEXT, Buffer.from('x'))[0] & 0x80, 0x80);
  assert.equal(encodeFrame(OP_TEXT, Buffer.from('x'), false)[0] & 0x80, 0x00);
});
