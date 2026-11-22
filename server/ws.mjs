/**
 * A minimal WebSocket server (RFC 6455), no dependencies.
 *
 * Scope is deliberately narrow: text frames, fragmentation, ping/pong and a
 * clean close. No extensions, no compression, no binary API — the protocol this
 * hub speaks is JSON.
 *
 * Why hand-rolled: the whole project runs on a bare Node install. Adding `ws`
 * would mean every user inherits a dependency tree to stream a few hundred
 * tokens. The cost is this file, and the tests in ws.test.mjs that keep it
 * honest.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/* ══════════════════════════════════════════════════════
   Handshake
   ══════════════════════════════════════════════════════ */

/** Compute the Sec-WebSocket-Accept value for a client key. */
export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * Complete the upgrade handshake on an HTTP request.
 * @returns {boolean} false when the request is not a valid upgrade
 */
export function handshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return false;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  return true;
}

/* ══════════════════════════════════════════════════════
   Framing
   ══════════════════════════════════════════════════════ */

/**
 * Encode one frame for a server→client send. Never masked, per RFC 6455 §5.1.
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} [fin]
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), fin = true) {
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  return Buffer.concat([header, payload]);
}

/** Text frame helper. */
export function encodeText(text) {
  return encodeFrame(OP.TEXT, Buffer.from(String(text), 'utf8'));
}

/**
 * Try to read one frame from the front of `buf`.
 *
 * @param {Buffer} buf
 * @param {number} [maxPayload] refuse absurd frames before allocating
 * @returns {null | {opcode:number, fin:boolean, payload:Buffer, consumed:number, error?:string}}
 *          null means "need more bytes"
 */
export function decodeFrame(buf, maxPayload = 8 * 1024 * 1024) {
  if (buf.length < 2) return null;

  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(maxPayload)) {
      return { opcode, fin, payload: Buffer.alloc(0), consumed: buf.length, error: 'frame too large' };
    }
    len = Number(big);
    offset += 8;
  }

  if (len > maxPayload) {
    return { opcode, fin, payload: Buffer.alloc(0), consumed: buf.length, error: 'frame too large' };
  }

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buf.length < offset + len) return null;

  let payload = buf.subarray(offset, offset + len);
  if (mask) {
    payload = Buffer.from(payload); // copy: never mutate the socket buffer
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  } else {
    payload = Buffer.from(payload);
  }

  return { opcode, fin, payload, consumed: offset + len };
}

/* ══════════════════════════════════════════════════════
   Connection
   ══════════════════════════════════════════════════════ */

/**
 * One live socket.
 *
 * Events: 'message' (string), 'close', 'error', 'pong'
 */
export class WsConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.alive = true;
    this.closed = false;

    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.maxPayload = 8 * 1024 * 1024;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', (err) => {
      if (!this.closed) this.emit('error', err);
      this._onClose();
    });

    // Keep intermediaries from reaping an idle connection.
    this.pingTimer = setInterval(() => this.ping(), 30000);
    this.pingTimer.unref?.();
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    for (;;) {
      const frame = decodeFrame(this.buffer, this.maxPayload);
      if (!frame) break;

      if (frame.error) {
        this.close(1009, frame.error);
        return;
      }

      this.buffer = this.buffer.subarray(frame.consumed);
      this._handleFrame(frame);
      if (this.closed) return;
    }
  }

  _handleFrame({ opcode, fin, payload }) {
    switch (opcode) {
      case OP.PING:
        this._write(encodeFrame(OP.PONG, payload));
        break;

      case OP.PONG:
        this.alive = true;
        this.emit('pong');
        break;

      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this._write(encodeFrame(OP.CLOSE, payload.subarray(0, 2)));
        this.close(code, 'peer closed', /* echoOnly */ true);
        break;
      }

      case OP.TEXT:
      case OP.BINARY:
        if (fin) {
          this.emit('message', payload.toString('utf8'));
        } else {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
        }
        break;

      case OP.CONTINUATION: {
        if (!this.fragmentOpcode) {
          this.close(1002, 'continuation without start');
          return;
        }
        this.fragments.push(payload);
        const total = this.fragments.reduce((n, b) => n + b.length, 0);
        if (total > this.maxPayload) {
          this.close(1009, 'message too large');
          return;
        }
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentOpcode = null;
          this.emit('message', whole.toString('utf8'));
        }
        break;
      }

      default:
        this.close(1002, `unknown opcode ${opcode}`);
    }
  }

  _write(buf) {
    if (this.closed || this.socket.destroyed) return false;
    try {
      this.socket.write(buf);
      return true;
    } catch {
      this._onClose();
      return false;
    }
  }

  /** Send a text frame. */
  send(text) {
    return this._write(encodeText(text));
  }

  /** Send a JSON payload. */
  sendJSON(obj) {
    return this.send(JSON.stringify(obj));
  }

  ping() {
    this._write(encodeFrame(OP.PING, Buffer.alloc(0)));
  }

  /**
   * Close politely: send a close frame, then end the socket.
   * @param {number} [code] RFC 6455 status code
   * @param {string} [reason]
   */
  close(code = 1000, reason = '', echoOnly = false) {
    if (this.closed) return;
    if (!echoOnly) {
      const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
      const payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      this._write(encodeFrame(OP.CLOSE, payload));
    }
    this.closed = true;
    clearInterval(this.pingTimer);
    try { this.socket.end(); } catch { /* already gone */ }
    this._onClose();
  }

  _onClose() {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this.closed = true;
    clearInterval(this.pingTimer);
    this.emit('close');
  }
}

/* ══════════════════════════════════════════════════════
   Server
   ══════════════════════════════════════════════════════ */

/**
 * Attach a WebSocket endpoint to an existing http.Server.
 *
 * @param {import('node:http').Server} server
 * @param {object} opts
 * @param {string} [opts.path]        only upgrade requests to this path
 * @param {(req, url) => boolean} [opts.authorize] return false to reject
 * @param {(conn, req, url) => void} opts.onConnection
 */
export function attachWebSocket(server, { path = '/ws', authorize, onConnection }) {
  const handleUpgrade = (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== path) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    if (authorize && !authorize(req, url)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    if (!handshake(req, socket)) return;

    const conn = new WsConnection(socket, req);
    if (head && head.length) conn._onData(head);
    onConnection(conn, req, url);
  };

  server.on('upgrade', handleUpgrade);
  return () => server.off('upgrade', handleUpgrade);
}
