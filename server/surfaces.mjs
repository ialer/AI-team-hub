/**
 * Workspace surfaces.
 *
 * A surface is a small, read-mostly data source the panel can list, and whose
 * items a human can attach to the next message as a *reference*.
 *
 * Deliberately shallow: the hub stores and hands out references, it does not try
 * to become an editor. Items are resolved on demand, so a reference always points
 * at the current version of the thing.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Turn a caller-supplied name into a safe, single path segment.
 * Rejects anything that could escape the surface directory.
 */
function safeName(input, ext = '') {
  const raw = String(input || '').trim();
  if (!raw) throw Object.assign(new Error('name required'), { status: 400 });
  const base = path.basename(raw).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 120);
  if (!base || base === '.' || base === '..') throw Object.assign(new Error('bad name'), { status: 400 });
  return ext && !base.toLowerCase().endsWith(ext) ? base + ext : base;
}

export function createSurfaces({ dataDir, log }) {
  /* Who put each item on the shelf. Kept beside the data (not inside it) so
     markdown stays clean and binary files can be attributed at all. */
  const authorsFile = path.join(dataDir, 'surface-authors.json');
  let authors = {};
  try { authors = JSON.parse(fs.readFileSync(authorsFile, 'utf8')) || {}; } catch { /* first run */ }

  function rememberAuthor(surface, id, author) {
    if (!author || !id) return;
    authors[`${surface}:${id}`] = {
      by: String(author.id || 'admin'),
      name: String(author.name || author.id || 'admin'),
      at: Date.now(),
    };
    try {
      const tmp = `${authorsFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(authors, null, 2), 'utf8');
      fs.renameSync(tmp, authorsFile);
    } catch { /* attribution is best-effort, never blocks a write */ }
  }

  /** Attach the recorded author to a listed item (absent = unknown). */
  function withAuthor(surface, item) {
    const a = authors[`${surface}:${item.id}`];
    return a ? { ...item, by: a.by, byName: a.name, byAt: a.at } : item;
  }

  const docsDir = path.join(dataDir, 'docs');
  const filesDir = path.join(dataDir, 'files');
  const tasksFile = path.join(dataDir, 'tasks.json');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(filesDir, { recursive: true });

  /* ── docs: one Markdown file per document ─────────────── */
  const docs = {
    id: 'docs',
    label: '文档',
    async list() {
      if (!fs.existsSync(docsDir)) return [];
      return fs.readdirSync(docsDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const st = fs.statSync(path.join(docsDir, f));
          return {
            id: f,
            title: f.replace(/\.md$/, ''),
            meta: `${Math.round(st.size / 1024)} KB · ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}`,
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title));
    },
    async fetch(id) {
      const file = path.join(docsDir, path.basename(id));
      if (!fs.existsSync(file)) throw new Error('not found');
      return { mime: 'text/markdown', content: fs.readFileSync(file, 'utf8') };
    },
    /** Create or overwrite one Markdown document. */
    async write({ id, content, overwrite = true }) {
      const name = safeName(id, '.md');
      const file = path.join(docsDir, name);
      if (!overwrite && fs.existsSync(file)) throw Object.assign(new Error('exists'), { status: 409 });
      fs.writeFileSync(file, String(content ?? ''), 'utf8');
      const st = fs.statSync(file);
      log.line(`surface docs write ${name} (${st.size}B)`);
      return { id: name, title: name.replace(/\.md$/, ''), meta: `${Math.round(st.size / 1024)} KB · ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}` };
    },
  };

  /* ── tasks: one JSON array ───────────────────────────── */
  const tasks = {
    id: 'tasks',
    label: '任务',
    async list() {
      let all = [];
      try { all = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch { /* empty */ }
      return (Array.isArray(all) ? all : []).map((t) => ({
        id: t.id,
        title: t.title || t.id,
        meta: [t.status || 'todo', t.owner ? '@' + t.owner : null].filter(Boolean).join(' · '),
      }));
    },
    async fetch(id) {
      let all = [];
      try { all = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch { /* empty */ }
      const t = (all || []).find((x) => x.id === id);
      if (!t) throw new Error('not found');
      return { mime: 'application/json', content: JSON.stringify(t, null, 2) };
    },
    /** Upsert or delete one task; the whole array is rewritten atomically. */
    async write({ upsert, remove }) {
      let all = [];
      try { all = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch { /* empty */ }
      if (!Array.isArray(all)) all = [];

      if (remove) {
        const before = all.length;
        all = all.filter((x) => x && x.id !== remove);
        if (all.length === before) throw Object.assign(new Error('not found'), { status: 404 });
      } else {
        const t = upsert || {};
        const id = String(t.id || '').trim();
        if (!id) throw Object.assign(new Error('task needs an id'), { status: 400 });
        const clean = {
          id,
          title: String(t.title || id).slice(0, 200),
          status: String(t.status || 'todo').slice(0, 32),
          ...(t.owner ? { owner: String(t.owner).slice(0, 64) } : {}),
        };
        const i = all.findIndex((x) => x && x.id === id);
        if (i >= 0) all[i] = { ...all[i], ...clean };
        else all.push(clean);
      }

      const tmp = `${tasksFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
      fs.renameSync(tmp, tasksFile);
      log.line(`surface tasks write (${all.length} total)`);
      return (remove ? all : all.filter((x) => x.id === (upsert && upsert.id))).map((x) => ({
        id: x.id, title: x.title || x.id,
        meta: [x.status || 'todo', x.owner ? '@' + x.owner : null].filter(Boolean).join(' · '),
      }));
    },
  };

  /* ── files: anything dropped into data/files ─────────── */
  const files = {
    id: 'files',
    label: '文件',
    async list() {
      if (!fs.existsSync(filesDir)) return [];
      return fs.readdirSync(filesDir)
        .map((f) => {
          const st = fs.statSync(path.join(filesDir, f));
          if (!st.isFile()) return null;
          return {
            id: f,
            title: f,
            meta: `${Math.round(st.size / 1024)} KB`,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.title.localeCompare(b.title));
    },
    async fetch(id) {
      const file = path.join(filesDir, path.basename(id));
      if (!fs.existsSync(file)) throw new Error('not found');
      return { mime: 'application/octet-stream', content: fs.readFileSync(file, 'utf8') };
    },
    /** Drop one file into data/files (binary safe). */
    async write({ name, buffer, overwrite = true }) {
      const safe = safeName(name, '');
      const file = path.join(filesDir, safe);
      if (!overwrite && fs.existsSync(file)) throw Object.assign(new Error('exists'), { status: 409 });
      fs.writeFileSync(file, buffer);
      const st = fs.statSync(file);
      log.line(`surface files write ${safe} (${st.size}B)`);
      return { id: safe, title: safe, meta: `${Math.round(st.size / 1024)} KB` };
    },
  };

  const byId = new Map([docs, tasks, files].map((s) => [s.id, s]));

  return {
    list() { return [...byId.values()].map(({ id, label }) => ({ id, label })); },
    get(id) { return byId.get(id) || null; },
    async items(id) {
      const s = byId.get(id);
      if (!s) throw new Error(`unknown surface ${id}`);
      const list = await s.list();
      return list.map((x) => withAuthor(id, x));
    },
    async resolve(id, refId) {
      const s = byId.get(id);
      if (!s) throw new Error(`unknown surface ${id}`);
      return s.fetch(refId);
    },
    async write(id, payload) {
      const s = byId.get(id);
      if (!s || !s.write) throw Object.assign(new Error(`surface ${id} is read-only`), { status: 400 });
      const { author, ...rest } = payload || {};
      const out = await s.write(rest);
      // A removal has no new item to attribute.
      if (!rest.remove) {
        for (const it of Array.isArray(out) ? out : [out]) {
          if (it && it.id) rememberAuthor(id, it.id, author);
        }
      }
      return Array.isArray(out) ? out.map((x) => withAuthor(id, x)) : withAuthor(id, out);
    },
  };
}
