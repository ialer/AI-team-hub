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

export function createSurfaces({ dataDir, log }) {
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
  };

  const byId = new Map([docs, tasks, files].map((s) => [s.id, s]));

  return {
    list() { return [...byId.values()].map(({ id, label }) => ({ id, label })); },
    get(id) { return byId.get(id) || null; },
    async items(id) {
      const s = byId.get(id);
      if (!s) throw new Error(`unknown surface ${id}`);
      return s.list();
    },
    async resolve(id, refId) {
      const s = byId.get(id);
      if (!s) throw new Error(`unknown surface ${id}`);
      return s.fetch(refId);
    },
  };
}
