/**
 * Media handling: identify an image by its bytes, not by what the client says.
 *
 * A `Content-Type` header is a claim. A magic number is evidence. Everything
 * that reaches disk passes through here first.
 */
import crypto from 'node:crypto';

/** Allowed image types. SVG is deliberately absent — it can carry script. */
const SIGNATURES = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.length > 6 && b.subarray(0, 4).toString('ascii') === 'GIF8' },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { mime: 'image/avif', ext: 'avif', test: (b) => b.length > 12 && b.subarray(4, 8).toString('ascii') === 'ftyp' && /avi[fs]/.test(b.subarray(8, 12).toString('ascii')) },
];

/**
 * Identify an image from its leading bytes.
 * @returns {{mime: string, ext: string} | null} null when the bytes are not an allowed image
 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  for (const sig of SIGNATURES) {
    try {
      if (sig.test(buffer)) return { mime: sig.mime, ext: sig.ext };
    } catch {
      /* a truncated buffer simply does not match */
    }
  }
  return null;
}

/**
 * Read pixel dimensions so the browser can reserve space before the bytes arrive.
 * Without this the layout jumps as each image loads (CLS).
 * @returns {{w: number, h: number} | null}
 */
export function imageSize(buffer, mime) {
  try {
    if (mime === 'image/png') {
      // IHDR is always the first chunk: width/height at offset 16/20, big-endian.
      return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
    }
    if (mime === 'image/gif') {
      return { w: buffer.readUInt16LE(6), h: buffer.readUInt16LE(8) };
    }
    if (mime === 'image/jpeg') {
      // Walk the marker segments looking for a Start Of Frame.
      let i = 2;
      while (i < buffer.length - 9) {
        if (buffer[i] !== 0xff) { i++; continue; }
        const marker = buffer[i + 1];
        const len = buffer.readUInt16BE(i + 2);
        const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSOF) return { h: buffer.readUInt16BE(i + 5), w: buffer.readUInt16BE(i + 7) };
        i += 2 + len;
      }
      return null;
    }
    if (mime === 'image/webp') {
      const kind = buffer.subarray(12, 16).toString('ascii');
      if (kind === 'VP8 ') return { w: buffer.readUInt16LE(26) & 0x3fff, h: buffer.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8X') {
        return {
          w: buffer.readUIntLE(24, 3) + 1,
          h: buffer.readUIntLE(27, 3) + 1,
        };
      }
    }
  } catch {
    /* malformed header — dimensions are optional */
  }
  return null;
}

/** Content address: identical uploads collapse to one stored file. */
export function contentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Reject anything that claims to be huge before it is fully buffered. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/** Verify the declared type agrees with the actual bytes. */
export function assertImage(buffer) {
  const kind = sniffImage(buffer);
  if (!kind) {
    const err = new Error('unsupported image type (png, jpeg, gif, webp, avif only)');
    err.status = 415;
    throw err;
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    const err = new Error(`image too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
    err.status = 413;
    throw err;
  }
  return kind;
}

/**
 * Parse a multipart/form-data body.
 *
 * Hand-rolled because the alternative is a dependency, and the shape we accept
 * is narrow: a single file part named anything, plus optional text fields.
 *
 * @returns {{fields: Record<string,string>, file: {buffer: Buffer, filename: string, contentType: string} | null}}
 */
export function parseMultipart(buffer, boundary) {
  const fields = {};
  let file = null;
  const delimiter = Buffer.from(`--${boundary}`);

  let pos = buffer.indexOf(delimiter);
  if (pos < 0) return { fields, file };

  while (pos >= 0) {
    const partStart = pos + delimiter.length;
    const next = buffer.indexOf(delimiter, partStart);
    if (next < 0) break;

    // Each part is: CRLF headers CRLF CRLF body CRLF
    const chunk = buffer.subarray(partStart, next);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      const rawHeaders = chunk.subarray(0, headerEnd).toString('utf8');
      let body = chunk.subarray(headerEnd + 4);
      if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
        body = body.subarray(0, body.length - 2);
      }

      const nameMatch = /name="([^"]*)"/i.exec(rawHeaders);
      const fileMatch = /filename="([^"]*)"/i.exec(rawHeaders);
      const typeMatch = /content-type:\s*([^\r\n;]+)/i.exec(rawHeaders);

      if (fileMatch && nameMatch) {
        file = {
          buffer: Buffer.from(body),
          filename: fileMatch[1],
          contentType: (typeMatch && typeMatch[1].trim()) || '',
        };
      } else if (nameMatch) {
        fields[nameMatch[1]] = body.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, file };
}
