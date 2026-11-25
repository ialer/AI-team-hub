/**
 * Persistence.
 *
 * Messages are an append-only JSONL log: no rewrite, no lost writes, and any
 * process can tail it. Everything else (session ids, agent registry, dialogs)
 * lives in small JSON files written atomically.
 *
 * Nothing here assumes a database: the whole point is that a single directory
 * copy is a complete backup.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Write a file atomically (tmp + rename) so a crash never leaves half a file. */
export function writeJsonAtomic(file, value, opts = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  const mode = opts.mode || 0o644;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode });
  // writeFileSync's mode is masked by umask and ignored on Windows; chmod makes
  // the intent explicit where the platform honours it (Linux/NAS).
  try { fs.chmodSync(tmp, mode); } catch { /* non-posix: ignore */ }
  fs.renameSync(tmp, file);
}

export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Append-only message log with an in-memory window.
 *
 * `id` is monotonic per hub instance and also serves as the long-poll cursor
 * for agents, so a reconnecting agent asks "give me everything after N".
 */
export class MessageLog {
  constructor(dataDir, { maxMemory = 5000 } = {}) {
    ensureDir(dataDir);
    this.file = path.join(dataDir, 'messages.jsonl');
    this.maxMemory = maxMemory;
    this.items = [];
    this.nextId = 1;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        this.items.push(m);
        if (m.id >= this.nextId) this.nextId = m.id + 1;
      } catch {
        /* skip a torn line rather than refusing to start */
      }
    }
    if (this.items.length > this.maxMemory) this.items = this.items.slice(-this.maxMemory);
  }

  append(message) {
    const m = { id: this.nextId++, ts: Date.now(), ...message };
    this.items.push(m);
    if (this.items.length > this.maxMemory) this.items = this.items.slice(-this.maxMemory);
    fs.appendFileSync(this.file, JSON.stringify(m) + '\n');
    return m;
  }

  /** Messages in a room with id > after, capped at `limit` (newest kept). */
  since({ room, after = 0, limit = 200, taskId = null }) {
    return this.items
      .filter((m) => m.room === room && m.id > after && (!taskId || m.taskId === taskId))
      .slice(-limit);
  }

  /** Look up a message by id (in-memory window only). */
  find(id) {
    if (!id) return null;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].id === id) return this.items[i];
    }
    return null;
  }

  /** Last `n` messages in a room, oldest first. */
  tail(room, n) {
    const list = this.items.filter((m) => m.room === room);
    return list.slice(-n);
  }

  rooms() {
    return [...new Set(this.items.map((m) => m.room))];
  }

  /** The whole in-memory window (oldest first). Used for aggregate metrics. */
  all() {
    return this.items.slice();
  }
}

/** Small JSON document store for session ids and dialogs. */
export class JsonStore {
  constructor(dataDir, name, fallback = {}, opts = {}) {
    ensureDir(dataDir);
    this.file = path.join(dataDir, name);
    this.mode = opts.mode || 0;
    this.data = readJsonFile(this.file, fallback);
  }

  get(key, dflt) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : dflt;
  }

  set(key, value) {
    if (value === undefined || value === null) delete this.data[key];
    else this.data[key] = value;
    this.save();
    return value;
  }

  delete(key) {
    delete this.data[key];
    this.save();
  }

  all() {
    return { ...this.data };
  }

  save() {
    writeJsonAtomic(this.file, this.data, { mode: this.mode });
  }
}
