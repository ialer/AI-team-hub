/**
 * Run with: node --test server/
 *
 * These cover the parts that are easy to get subtly wrong and impossible to
 * eyeball: byte sniffing, image header parsing, multipart splitting, and the
 * AWS signature (checked against the published test vector).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

import { sniffImage, imageSize, contentHash, assertImage, parseMultipart, MAX_UPLOAD_BYTES } from './media.mjs';
import { signV4 } from './storage.mjs';

/* ── helpers: build real image bytes ──────────────────── */

function png(w, h) {
  const raw = Buffer.concat(
    Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x22)])),
  );
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function gif(w, h) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

/* ── sniffing ─────────────────────────────────────────── */

test('sniffImage identifies the allowed formats', () => {
  assert.equal(sniffImage(png(2, 2)).mime, 'image/png');
  assert.equal(sniffImage(gif(5, 7)).mime, 'image/gif');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])).mime, 'image/jpeg');
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(8),
  ]);
  assert.equal(sniffImage(webp).mime, 'image/webp');
});

test('sniffImage rejects SVG even when it looks like markup', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(sniffImage(svg), null);
});

test('sniffImage rejects plain text and short buffers', () => {
  assert.equal(sniffImage(Buffer.from('not an image at all')), null);
  assert.equal(sniffImage(Buffer.from([0x89, 0x50])), null);
  assert.equal(sniffImage(null), null);
  assert.equal(sniffImage(undefined), null);
});

test('assertImage throws 415 for a non-image and 413 for oversize', () => {
  assert.throws(() => assertImage(Buffer.from('hello world, not an image')), (e) => e.status === 415);
  const big = Buffer.concat([png(2, 2), Buffer.alloc(MAX_UPLOAD_BYTES + 1)]);
  assert.throws(() => assertImage(big), (e) => e.status === 413);
});

/* ── dimension parsing ────────────────────────────────── */

test('imageSize reads PNG dimensions', () => {
  assert.deepEqual(imageSize(png(1920, 1080), 'image/png'), { w: 1920, h: 1080 });
});

test('imageSize reads GIF dimensions', () => {
  assert.deepEqual(imageSize(gif(320, 240), 'image/gif'), { w: 320, h: 240 });
});

test('imageSize returns null rather than throwing on garbage', () => {
  assert.equal(imageSize(Buffer.from('nope'), 'image/png'), null);
});

/* ── content addressing ───────────────────────────────── */

test('contentHash is deterministic and differs per content', () => {
  const a = png(2, 2);
  assert.equal(contentHash(a), contentHash(Buffer.from(a)));
  assert.notEqual(contentHash(a), contentHash(png(3, 3)));
  assert.match(contentHash(a), /^[0-9a-f]{64}$/);
});

/* ── multipart ────────────────────────────────────────── */

test('parseMultipart extracts a file part and a text field', () => {
  const boundary = '----testboundary123';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n`),
    Buffer.from(`Content-Type: image/png\r\n\r\n`),
    png(2, 2),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const { fields, file } = parseMultipart(body, boundary);
  assert.equal(fields.note, 'hello');
  assert.equal(file.filename, 'x.png');
  assert.equal(file.contentType, 'image/png');
  assert.equal(sniffImage(file.buffer).mime, 'image/png');
});

test('parseMultipart survives a body with no parts', () => {
  const { fields, file } = parseMultipart(Buffer.from('garbage'), 'nope');
  assert.deepEqual(fields, {});
  assert.equal(file, null);
});

/* ── AWS signature ────────────────────────────────────── */

test('signV4 matches the published AWS S3 test vector', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  // GET Object with a Range header, 2013-05-24T00:00:00Z.
  const headers = signV4({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    body: '',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    date: new Date('2013-05-24T00:00:00Z'),
    extraHeaders: { range: 'bytes=0-9' },
  });

  assert.match(
    headers.authorization,
    /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
    'signature must match the AWS documented value',
  );
});

test('signV4 produces a different signature per payload', () => {
  const base = {
    method: 'PUT',
    host: 'acc.r2.cloudflarestorage.com',
    path: '/bucket/a.png',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    date: new Date('2026-01-01T00:00:00Z'),
  };
  const a = signV4({ ...base, body: 'one' });
  const b = signV4({ ...base, body: 'two' });
  assert.notEqual(a.authorization, b.authorization);
  assert.match(a['x-amz-content-sha256'], /^[0-9a-f]{64}$/);
});

test('signV4 signs custom headers into SignedHeaders', () => {
  const h = signV4({
    method: 'PUT',
    host: 'acc.r2.cloudflarestorage.com',
    path: '/b/k.png',
    body: 'x',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    date: new Date('2026-01-01T00:00:00Z'),
    extraHeaders: { 'content-type': 'image/png' },
  });
  assert.match(h.authorization, /SignedHeaders=[^,]*(content-type)/);
});
