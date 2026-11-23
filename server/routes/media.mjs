import path from 'node:path';
import { sendJson, readBody, readBodyRaw } from '../http.mjs';
import { assertImage, imageSize, contentHash, parseMultipart, MAX_UPLOAD_BYTES } from '../media.mjs';

export function createMediaRoutes(ctx) {
  const { log, storage } = ctx;
  return async function mediaRoutes(req, res, url, p) {
    if (p === '/api/upload' && req.method === 'POST') {
      const ctype = String(req.headers['content-type'] || '');
      let buffer;
      if (ctype.startsWith('multipart/form-data')) {
        const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
        const boundary = m && (m[1] || m[2]);
        if (!boundary) { sendJson(res, 400, { error: 'missing multipart boundary' }); return true; }
        const raw = await readBodyRaw(req, MAX_UPLOAD_BYTES + 1_000_000);
        const parsed = parseMultipart(raw, boundary);
        if (!parsed.file) { sendJson(res, 400, { error: 'no file part' }); return true; }
        buffer = parsed.file.buffer;
      } else {
        const body = await readBody(req, Math.ceil(MAX_UPLOAD_BYTES * 1.4));
        const dataUrl = body.dataUrl || body.data;
        if (!dataUrl) { sendJson(res, 400, { error: 'expected dataUrl' }); return true; }
        const comma = String(dataUrl).indexOf(',');
        if (comma < 0) { sendJson(res, 400, { error: 'malformed dataUrl' }); return true; }
        buffer = Buffer.from(String(dataUrl).slice(comma + 1), 'base64');
      }

      const kind = assertImage(buffer);
      const hash = contentHash(buffer);
      const key = `${hash.slice(0, 2)}/${hash}.${kind.ext}`;
      const { url } = await storage.put(key, buffer, kind.mime);
      const size = imageSize(buffer, kind.mime);

      log.line(`upload ${key} ${Math.round(buffer.length / 1024)}KB via ${storage.driver}`);
      sendJson(res, 200, {
        ok: true, url, key, hash, mime: kind.mime, bytes: buffer.length,
        ...(size ? { w: size.w, h: size.h } : {}),
      });
      return true;
    }

    if (p.startsWith('/api/file/') && req.method === 'GET') {
      const key = decodeURIComponent(p.slice('/api/file/'.length));
      if (!key || key.includes('..') || key.startsWith('/')) { sendJson(res, 400, { error: 'bad key' }); return true; }
      const obj = await storage.get(key);
      if (!obj) { sendJson(res, 404, { error: 'not found' }); return true; }

      const ext = path.extname(key).slice(1).toLowerCase();
      const MIME_BY_EXT = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
      };
      const headers = {
        'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream',
        // Content-addressed keys never change, so this is safe forever.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      };
      if (obj.size) headers['Content-Length'] = obj.size;
      res.writeHead(200, headers);
      obj.stream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
      obj.stream.pipe(res);
      return true;
    }

    return false;
  };
}
