/**
 * Storage: local disk by default, Cloudflare R2 when configured.
 *
 * Both drivers expose the same three calls, so nothing above this layer knows
 * which one is in use. R2 speaks the S3 API; the signing below is a small
 * implementation of AWS Signature V4 verified against the official test vector
 * (see server/media.test.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ══════════════════════════════════════════════════════
   AWS Signature V4 (S3 flavour) — no SDK
   ══════════════════════════════════════════════════════ */

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * Build the headers needed to authenticate a single S3 request.
 *
 * @param {object} o
 * @param {string} o.method      GET | PUT | DELETE | HEAD
 * @param {string} o.host        e.g. <account>.r2.cloudflarestorage.com
 * @param {string} o.path        already URL-encoded, starts with '/'
 * @param {string} [o.query]     canonical query string (sorted, encoded)
 * @param {Buffer|string} [o.body]
 * @param {string} o.accessKeyId
 * @param {string} o.secretAccessKey
 * @param {string} [o.region]    'auto' for R2
 * @param {string} [o.service]   's3'
 * @param {Date}   [o.date]
 * @param {Record<string,string>} [o.extraHeaders] additional signed headers
 * @returns {Record<string,string>} headers to attach to the request
 */
export function signV4({
  method, host, path: reqPath, query = '', body = '', accessKeyId, secretAccessKey,
  region = 'auto', service = 's3', date = new Date(), extraHeaders = {},
}) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extraHeaders,
  };

  // Canonical headers must be sorted by lowercase name.
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lower[n]).trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [method, reqPath, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/* ══════════════════════════════════════════════════════
   Drivers
   ══════════════════════════════════════════════════════ */

/** Local disk, sharded two levels so one directory never holds 100k files. */
function createLocal(root) {
  const dir = path.join(root, 'files');
  fs.mkdirSync(dir, { recursive: true });

  const fullPath = (key) => path.join(dir, key);

  return {
    driver: 'local',

    async put(key, buffer) {
      const dest = fullPath(key);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, buffer);
      return { url: `/api/file/${key}` };
    },

    async get(key) {
      const dest = fullPath(key);
      if (!fs.existsSync(dest)) return null;
      const st = fs.statSync(dest);
      return { stream: fs.createReadStream(dest), size: st.size };
    },

    async delete(key) {
      try { fs.unlinkSync(fullPath(key)); } catch { /* already gone */ }
    },

    /** Bytes currently used, for the "disk is filling up" warning. */
    usage() {
      let total = 0;
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) walk(p);
          else total += fs.statSync(p).size;
        }
      };
      try { walk(dir); } catch { /* ignore */ }
      return total;
    },
  };
}

/** Cloudflare R2 over the S3 API. */
function createR2(cfg) {
  const endpoint = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const bucket = cfg.bucket;

  const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');
  const objectPath = (key) => `/${bucket}/${encodeKey(key)}`;

  const sign = (method, key, body = '', extraHeaders = {}) => signV4({
    method,
    host: endpoint,
    path: objectPath(key),
    body,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: 'auto',
    service: 's3',
    extraHeaders,
  });

  return {
    driver: 'r2',

    async put(key, buffer, mime) {
      const headers = sign('PUT', key, buffer, {
        'content-type': mime || 'application/octet-stream',
        'content-length': String(buffer.length),
      });
      const res = await fetch(`https://${endpoint}${objectPath(key)}`, {
        method: 'PUT',
        headers,
        body: buffer,
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`R2 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);

      const url = cfg.publicBaseUrl
        ? `${cfg.publicBaseUrl.replace(/\/+$/, '')}/${encodeKey(key)}`
        : `/api/file/${key}`;
      return { url };
    },

    async get(key) {
      const headers = sign('GET', key);
      const res = await fetch(`https://${endpoint}${objectPath(key)}`, {
        headers,
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${res.status}`);
      return {
        stream: res.body,
        size: Number(res.headers.get('content-length') || 0),
      };
    },

    async delete(key) {
      const headers = sign('DELETE', key);
      await fetch(`https://${endpoint}${objectPath(key)}`, {
        method: 'DELETE', headers, signal: AbortSignal.timeout(30000),
      }).catch(() => {});
    },

    usage() {
      return null; // R2 quotas live in the dashboard, not in the API
    },
  };
}

/**
 * Pick a driver from config.
 * Falls back to local when R2 is requested but not fully configured, rather
 * than refusing to start — an upload endpoint that 500s is worse than one that
 * writes to disk and logs a warning.
 */
export function createStorage({ dataDir, storage, log }) {
  const r2 = storage && storage.r2;
  if (storage && storage.driver === 'r2') {
    const missing = ['accountId', 'bucket', 'accessKeyId', 'secretAccessKey']
      .filter((k) => !r2 || !r2[k]);
    if (missing.length) {
      (log || console.warn)(`storage: r2 selected but missing ${missing.join(', ')} — falling back to local`);
      return createLocal(dataDir);
    }
    (log || console.log)('storage: Cloudflare R2');
    return createR2(r2);
  }
  return createLocal(dataDir);
}
