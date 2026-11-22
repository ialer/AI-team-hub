# Contributing

Thanks for considering it. This project is intentionally small; the best
contributions keep it that way.

---

## Ground rules

1. **Zero runtime dependencies.** The hub must run on a bare Node install. CI
   fails the build if `dependencies` in `package.json` is non-empty. Dev-only
   tooling is fine but should not be required to run or test.
2. **No build step.** `node server/index.mjs` is the deployment. Do not add a
   bundler, transpiler, or `dist/` directory.
3. **One file per integration.** A new adapter is one export in
   `server/adapters/builtin.mjs` (~30 lines). If your change needs more than
   that, it probably belongs in the agent, not the hub.
4. **Additive API changes only** within `/api/agent/*`. Breaking changes get a
   new path prefix.

---

## Adding a driver / adapter

An adapter is the only extension point most people need.

```js
// server/adapters/builtin.mjs
import { registerAdapter } from './index.mjs';

export const myThing = {
  id: 'my-thing',
  label: 'Human readable name',

  // Return { ok, detail }. Used by /api/adapters and diagnostics.
  async probe(config) {
    return { ok: true, detail: 'always fine' };
  },

  // Throw on failure; return { text, sessionId } on success.
  async wake({ text, sessionId, config }) {
    const reply = await doSomething(config, text, sessionId);
    return { text: reply, sessionId: sessionId || '' };
  },
};

registerAdapter(myThing);
```

Then it is available in **both** modes automatically:

```json
{ "mode": "push", "adapter": "my-thing", "config": { } }
```

```json
{ "connector": true, "driver": "my-thing", "config": { } }
```

That shared-implementation property is the reason the connector imports from
`server/adapters/` — please keep it that way.

---

## Adding a surface (workspace tab)

```js
// server/surfaces.mjs
const links = {
  id: 'links',
  label: 'Links',
  async list() {
    return [{ id: 'l1', title: 'Homepage', meta: 'example.com' }];
  },
  async fetch(id) {
    return { mime: 'text/plain', content: 'https://example.com' };
  },
};

const byId = new Map([docs, tasks, files, links].map((s) => [s.id, s]));
```

The panel reads `/api/surfaces`, so no frontend change is needed.

---

## Testing

There is no test framework. `npm run lint` runs `node --check` on every module;
CI additionally boots the hub and asserts a full push-adapter round trip. If you
add behaviour worth protecting, extend that smoke test rather than introducing
a test runner.

Manual check before opening a PR:

```bash
cp config.example.json config.json   # set adminToken
node server/index.mjs &
curl -s localhost:8899/api/state | head -c 200
```

---

## Style

- ES modules, `.mjs`, no semicolon-only lines that confuse ASI.
- Prefer a small named function over a clever one-liner.
- Comments explain **why**, not what. If a line needs a "what" comment, rename
  things instead.
- Keep `server/hub.mjs` free of any knowledge about specific agents.

---

## What we will probably decline

- A database backend (JSONL is a feature, not a limitation).
- User accounts / multi-tenancy.
- A rich text editor.
- Anything that makes `node server/index.mjs` stop being the whole deployment.
