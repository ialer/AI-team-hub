/**
 * @-mention parsing.
 *
 * Two forms are recognised:
 *   @name   — matches an agent's display name or id (case-insensitive for ids)
 *   @all    — every enabled agent in the room
 *
 * Unknown mentions are ignored rather than waking nobody silently: the caller
 * can compare the returned list against what it expected.
 */

/** Build a resolver from the agent list. Called once per message. */
export function createMentionResolver(agents) {
  const byAlias = new Map();
  for (const a of agents) {
    if (!a.enabled) continue;
    byAlias.set(a.id.toLowerCase(), a.id);
    if (a.name) byAlias.set(a.name.toLowerCase(), a.id);
  }

  return function resolve(text) {
    const found = new Set();
    const re = /@([\p{L}\p{N}_-]+)/gu;
    let m;
    while ((m = re.exec(String(text || '')))) {
      const token = m[1].toLowerCase();
      if (token === 'all' || token === 'everyone' || token === '全体') {
        for (const a of agents) if (a.enabled) found.add(a.id);
        continue;
      }
      const id = byAlias.get(token);
      if (id) found.add(id);
    }
    return [...found];
  };
}

/** Strip mentions from text, e.g. for titles. */
export function stripMentions(text) {
  return String(text || '').replace(/@[\p{L}\p{N}_-]+/gu, '').trim();
}
