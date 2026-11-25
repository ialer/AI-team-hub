/**
 * AI Team Hub — browser client.
 *
 * Plain ES modules, no framework, no build. Three concerns kept apart:
 *   renderMarkdown()  text → safe HTML
 *   MessageView       one message → DOM
 *   store / stream    fetch + SSE, the only places that talk to the network
 */

/* ══════════════════════════════════════════════════════
   State
   ══════════════════════════════════════════════════════ */

import { mountMembersPanel, mountSurfaceActions } from './admin.js';
import { createStore } from './store.mjs';

const store = createStore({
  me: localStorage.getItem('hub.identity') || 'human',
  room: 'team',
  agents: {},
  human: { id: 'human', name: '我', role: '操作者', color: '#e2e8f0' },
  busy: new Set(),
  lastId: 0,
  pendingRefs: [],
  pendingImages: [],
  dialogs: {},
  panelOpen: localStorage.getItem('hub.panel') === '1',
  surface: 'docs',
});
const state = store.data; // reads stay plain; writes go through store.set()

const $ = (sel) => document.querySelector(sel);
const el = {
  app: $('.app'),
  list: $('#list'),
  scroller: $('#scroller'),
  input: $('#input'),
  send: $('#send'),
  members: $('#members'),
  conn: $('#conn'),
  sub: $('#sub'),
  toBottom: $('#toBottom'),
  toastSlot: $('#toastSlot'),
  pop: $('#mentionPop'),
  asWho: $('#asWho'),
  panel: $('#panel'),
  panelTabs: $('#panelTabs'),
  panelBody: $('#panelBody'),
  panelFoot: $('#panelFoot'),
  panelToggle: $('#panelToggle'),
  pendingRefs: $('#pendingRefs'),
  pendingImages: $('#pendingImages'),
  attach: $('#attach'),
  filePicker: $('#filePicker'),
  discussBar: $('#discussBar'),
  discussBtn: $('#discussBtn'),
};

/* ══════════════════════════════════════════════════════
   Emoji
   A small curated set — a full Unicode table is ~30 KB and buys
   nothing but rare glyphs nobody types.
   ══════════════════════════════════════════════════════ */

const EMOJI = {
  smile: '😄', grin: '😁', joy: '😂', rofl: '🤣', wink: '😉', blush: '😊',
  heart_eyes: '😍', thinking: '🤔', neutral: '😐', confused: '😕', worried: '😟',
  cry: '😢', sob: '😭', angry: '😠', rage: '😡', scream: '😱', sleepy: '😴',
  sunglasses: '😎', nerd: '🤓', shush: '🤫', shrug: '🤷', facepalm: '🤦',
  wink2: '😜', party_face: '🥳', cool: '😏', upside_down: '🙃', robot: '🤖',
  thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', ok_hand: '👌',
  clap: '👏', pray: '🙏', wave: '👋', point_right: '👉', point_left: '👈',
  muscle: '💪', handshake: '🤝', writing: '✍️', eyes: '👀', brain: '🧠',
  heart: '❤️', broken_heart: '💔', sparkling_heart: '💖', fire: '🔥',
  star: '⭐', sparkles: '✨', zap: '⚡', boom: '💥', '100': '💯',
  rocket: '🚀', tada: '🎉', gift: '🎁', trophy: '🏆', medal: '🏅',
  bell: '🔔', bulb: '💡', wrench: '🔧', hammer: '🔨', gear: '⚙️',
  hammer_and_wrench: '🛠️', package: '📦', link: '🔗', lock: '🔒', unlock: '🔓',
  key: '🔑', shield: '🛡️', bug: '🐛', worm: '🪱', sparkle: '✨',
  check: '✅', white_check_mark: '✅', x: '❌', warning: '⚠️', no_entry: '⛔',
  question: '❓', exclamation: '❗', plus: '➕', minus: '➖', arrow_right: '➡️',
  arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️', recycle: '♻️', infinity: '♾️',
  clock: '🕐', hourglass: '⏳', calendar: '📅', alarm_clock: '⏰', stopwatch: '⏱️',
  chart: '📊', chart_up: '📈', chart_down: '📉', clipboard: '📋', memo: '📝',
  book: '📖', books: '📚', notebook: '📓', page: '📄', folder: '📁',
  file_folder: '📂', pushpin: '📌', paperclip: '📎', scissors: '✂️', ruler: '📏',
  computer: '💻', desktop: '🖥️', keyboard: '⌨️', mouse: '🖱️', printer: '🖨️',
  phone: '📱', battery: '🔋', plug: '🔌', satellite: '📡', wifi: '📶',
  cloud: '☁️', database: '🗄️', floppy: '💾', cd: '💿', dvd: '📀',
  terminal: '💻', gear2: '⚙️', robot2: '🤖', alien: '👽', ghost: '👻',
  cat: '🐱', dog: '🐶', fox: '🦊', wolf: '🐺', bear: '🐻', panda: '🐼',
  penguin: '🐧', bird: '🐦', fish: '🐟', whale: '🐳', dolphin: '🐬', crab: '🦀',
  coffee: '☕', tea: '🍵', beer: '🍺', pizza: '🍕', cake: '🍰', cookie: '🍪',
  apple: '🍎', lemon: '🍋', avocado: '🥑', bread: '🍞', ramen: '🍜',
  sun: '☀️', moon: '🌙', cloud_rain: '🌧️', snowflake: '❄️', rainbow: '🌈',
  earth: '🌍', globe: '🌐', map: '🗺️', compass: '🧭', anchor: '⚓',
  hourglass_done: '⌛', magic: '🪄', crystal_ball: '🔮', dice: '🎲', puzzle: '🧩',
  speech: '💬', thought: '💭', mail: '📧', envelope: '✉️', inbox: '📥', outbox: '📤',
  megaphone: '📢', loudspeaker: '📣', mute: '🔇', sound: '🔊', music: '🎵',
  camera: '📷', video: '📹', film: '🎬', art: '🎨', palette: '🎨',
  pencil: '✏️', pen: '🖊️', crayon: '🖍️', paintbrush: '🖌️', magnet: '🧲',
  flask: '🧪', dna: '🧬', microbe: '🦠', microscope: '🔬', telescope: '🔭',
  atom: '⚛️', radioactive: '☢️', battery_low: '🪫', candle: '🕯️', lantern: '🏮',
  house: '🏠', office: '🏢', factory: '🏭', tent: '⛺', bridge: '🌉',
  car: '🚗', bus: '🚌', train: '🚆', plane: '✈️', ship: '🚢', bike: '🚲',
  hourglass2: '⏳', flag: '🏁', checkered_flag: '🏁', construction: '🚧',
  sos: '🆘', info: 'ℹ️', new: '🆕', free: '🆓', cool2: '🆒', up: '🆙',
};

const EMOJI_NAMES = Object.keys(EMOJI);
const EMOJI_CODES = new Set(EMOJI_NAMES);

/** Replace :shortcode: with its glyph. Unknown codes are left untouched. */
function applyEmoji(text) {
  return String(text).replace(/:([a-z0-9_+\-]{2,32}):/gi, (whole, code) => {
    const key = code.toLowerCase();
    return EMOJI_CODES.has(key) ? EMOJI[key] : whole;
  });
}

/* ══════════════════════════════════════════════════════
   Markdown (escape first, then a small subset)
   ══════════════════════════════════════════════════════ */

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderMarkdown(raw) {
  const src = String(raw || '').replace(/\r\n/g, '\n');

  // Protect fenced code blocks from inline rules.
  const blocks = [];
  const stripped = src.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang: lang || '', code });
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  const inline = (s) => escapeHtml(applyEmoji(s))
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    // Images before links, so ![alt](url) is not eaten by the link rule.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) =>
      /^https?:\/\/|^\/api\/file\//.test(src)
        ? `<img class="inline-img" src="${src}" alt="${alt}" loading="lazy" decoding="async">`
        : alt)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/@([\p{L}\p{N}_-]+)/gu, '<span class="mention">@$1</span>');

  const out = [];
  let list = null;
  let quote = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushQuote = () => {
    if (quote.length) { out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`); quote = []; }
  };

  for (const line of stripped.split('\n')) {
    const ref = line.match(/^\u0000B(\d+)\u0000$/);

    if (ref) {
      closeList(); flushQuote();
      const b = blocks[Number(ref[1])];
      const cls = b.lang ? ` class="lang-${escapeHtml(b.lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(b.code)}</code></pre>`);
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); flushQuote(); const lv = Math.min(h[1].length + 3, 6); out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }

    if (/^\s*>\s?/.test(line)) { closeList(); quote.push(line.replace(/^\s*>\s?/, '')); continue; }
    flushQuote();

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if (!line.trim()) { closeList(); continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); flushQuote();
  return out.join('');
}

/* ══════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════ */

const timeOf = (ts) =>
  new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

function whoOf(id) {
  if (id === 'human') return state.human;
  if (id === 'system') return { name: '系统', role: '', color: '#f87171' };
  return state.agents[id] || { name: id, role: '', color: '#7f8fa8' };
}

function toast(text) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.setAttribute('popover', 'manual');
  node.textContent = text;
  el.toastSlot.appendChild(node);
  try { node.showPopover(); } catch { /* older browsers */ }
  setTimeout(() => { try { node.hidePopover(); } catch {} node.remove(); }, 4200);
}

function scrollIfNearBottom() {
  const gap = el.scroller.scrollHeight - el.scroller.scrollTop - el.scroller.clientHeight;
  if (gap < 220) el.scroller.scrollTop = el.scroller.scrollHeight;
}

/* ══════════════════════════════════════════════════════
   Message rendering
   ══════════════════════════════════════════════════════ */

function messageEl(m) {
  const who = whoOf(m.from);
  const nm = String(who.name || '?').trim();
  // Same rule as the member panel: for 宁-prefixed names use the next character
  // so 薇/汐/瑶/莺 are distinguishable at a glance.
  const initial = (nm.length > 1 && nm.charAt(0) === '宁' ? nm.charAt(1) : nm.charAt(0)).toUpperCase();
  // Agents may set a custom avatar (emoji or image URL); fall back to the
  // name's first character. This is what makes participants distinguishable.
  const av = String(who.avatar || '').trim();
  const isImg = /^https?:\/\//.test(av) || /^data:/.test(av);
  const avHtml = isImg
    ? `<div class="av-lg" style="--c:${who.color}" aria-hidden="true"><img src="${escapeHtml(av)}" alt=""></div>`
    : `<div class="av-lg" style="--c:${who.color}" aria-hidden="true">${escapeHtml(av || initial)}</div>`;

  // Right-alignment means "a human typed this here". The hub tags every message
  // with its origin (user vs agent), so switching the speaking identity to an
  // agent does not silently move agent output to the right.
  const isSelf = (m.origin || (m.from === 'human' ? 'user' : 'agent')) === 'user'
    && m.from === state.me;

  const article = document.createElement('article');
  article.className = 'msg'
    + (isSelf ? ' self' : '')
    + (m.from === 'human' ? ' from-human' : '')
    + (m.from === 'system' ? ' from-system' : '');
  article.id = 'm' + m.id;
  if (m.truncated) article.dataset.truncated = '1';
  if (m.kind && m.kind !== 'chat') article.dataset.kind = m.kind;

  article.innerHTML = `
    ${avHtml}
    <div class="body">
      <div class="meta">
        <span class="who" style="--c:${who.color}">${escapeHtml(who.name)}</span>
        <span class="role">${escapeHtml(who.role || '')}</span>
        ${m.question == null ? '' : `<span class="role q-tag">Q${Number(m.question) + 1}</span>`}
        <time class="time" datetime="${new Date(m.ts).toISOString()}">${timeOf(m.ts)}</time>
      </div>
      <div class="bubble">${renderMarkdown(m.text)}</div>
      ${renderImages(m.images)}
      ${m.refs && m.refs.length ? `<div class="refs">${m.refs.map(refChip).join('')}</div>` : ''}
    </div>`;

  if (m.dialog) {
    const live = state.dialogs[m.dialog.id] || m.dialog;
    article.querySelector('.body').appendChild(dialogCard(live));
  }
  return article;
}

const refChip = (r) => `<span class="ref">📎 ${escapeHtml(r.title || r.id || '')}</span>`;

/**
 * Structured image attachments on a message.
 *
 * Width/height are set when the upload told us the pixel size, so the browser
 * reserves the box before the bytes arrive and the thread does not jump.
 */
function renderImages(images) {
  if (!Array.isArray(images) || !images.length) return '';
  const cells = images.slice(0, 8).map((img) => {
    const url = String(img.url || '');
    if (!/^https?:\/\/|^\/api\/file\//.test(url)) return '';
    const dims = img.w && img.h ? ` width="${img.w}" height="${img.h}"` : '';
    const ratio = img.w && img.h ? ` style="aspect-ratio:${img.w}/${img.h}"` : '';
    return `<button type="button" class="img-cell" data-full="${escapeHtml(url)}"
              aria-label="查看大图：${escapeHtml(img.alt || '')}">
      <img src="${escapeHtml(url)}" alt="${escapeHtml(img.alt || '')}"
           loading="lazy" decoding="async"${dims}${ratio}>
    </button>`;
  }).join('');
  return `<div class="msg-images">${cells}</div>`;
}

/* Click to enlarge — native <dialog>, no lightbox library. */
let zoomDialog = null;

function ensureZoomDialog() {
  if (zoomDialog) return zoomDialog;
  zoomDialog = document.createElement('dialog');
  zoomDialog.className = 'zoom-dialog';
  zoomDialog.innerHTML = '<img alt=""><form method="dialog"><button class="btn">关闭</button></form>';
  zoomDialog.addEventListener('click', (e) => {
    if (e.target === zoomDialog) zoomDialog.close();
  });
  document.body.appendChild(zoomDialog);
  return zoomDialog;
}

document.addEventListener('click', (e) => {
  const cell = e.target.closest('.img-cell');
  if (!cell) return;
  const dlg = ensureZoomDialog();
  dlg.querySelector('img').src = cell.dataset.full;
  dlg.showModal();
});

/* ── dialog card ─────────────────────────────────────── */

function dialogCard(dialog) {
  const card = document.createElement('div');
  const status = dialog.status || 'open';
  card.className = 'dialog-card' + (status !== 'open' ? ' done' : '');
  card.dataset.dialogId = dialog.id;

  const steps = dialog.steps || [];
  let index = 0;
  const values = { ...(dialog.values || {}) };

  const head = document.createElement('div');
  head.className = 'dialog-head';
  head.innerHTML = `<span>${escapeHtml(dialog.title || '请填写')}</span>
    <span class="dialog-step-no"></span>`;
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'dialog-body';
  card.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'dialog-foot';
  card.appendChild(foot);

  if (status !== 'open') {
    body.innerHTML = `<div class="hint">${
      status === 'submitted' ? '✅ 已提交' : '已取消'
    }</div>`;
    return card;
  }

  const stepNo = head.querySelector('.dialog-step-no');

  function renderStep() {
    const step = steps[index];
    stepNo.textContent = `${index + 1}/${steps.length}`;
    body.innerHTML = '';
    body.appendChild(fieldFor(step, values[step.id]));
    foot.innerHTML = '';

    if (index > 0) {
      foot.appendChild(button('上一步', () => { index--; renderStep(); }));
    }
    foot.appendChild(button('取消', submitCancel, 'ghost'));

    const isLast = index === steps.length - 1;
    const next = button(isLast ? '提交' : '下一步', () => {
      if (!collect(step)) return;
      if (isLast) submitDialog();
      else { index++; renderStep(); }
    }, 'primary');
    foot.appendChild(next);
    body.querySelector('input, textarea, select')?.focus({ preventScroll: true });
  }

  function collect(step) {
    const input = body.querySelector(`[data-field="${step.id}"]`);
    if (!input) return true;
    let v;
    if (step.type === 'checkbox') v = input.checked;
    else v = input.value.trim();

    const err = body.querySelector('.err');
    if (err) err.remove();

    if (step.required && (v === '' || v === false || v === undefined)) {
      const p = document.createElement('div');
      p.className = 'err';
      p.textContent = '此项必填';
      input.closest('.field').appendChild(p);
      input.focus();
      return false;
    }
    if (step.type === 'number' && v !== '') {
      const n = Number(v);
      if (Number.isNaN(n)) {
        const p = document.createElement('div');
        p.className = 'err';
        p.textContent = '请填数字';
        input.closest('.field').appendChild(p);
        return false;
      }
      v = n;
    }
    values[step.id] = v;
    return true;
  }

  async function submitDialog() {
    try {
      const r = await fetch(`/api/dialogs/${encodeURIComponent(dialog.id)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      if (!r.ok) throw new Error((await r.json()).error || r.status);
    } catch (e) {
      toast('提交失败：' + e.message);
    }
  }

  async function submitCancel() {
    try {
      await fetch(`/api/dialogs/${encodeURIComponent(dialog.id)}/cancel`, { method: 'POST' });
    } catch { /* the stream will tell us */ }
  }

  renderStep();
  return card;
}

function fieldFor(step, value) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const id = `f-${step.id}`;
  const label = `<label for="${id}">${escapeHtml(step.label || step.id)}${step.required ? ' <span class="req">*</span>' : ''}</label>`;

  if (step.type === 'select') {
    const opts = (step.options || []).map((o) => {
      const v = typeof o === 'string' ? o : o.value;
      const t = typeof o === 'string' ? o : o.label;
      return `<option value="${escapeHtml(v)}"${String(value) === String(v) ? ' selected' : ''}>${escapeHtml(t)}</option>`;
    }).join('');
    wrap.innerHTML = `${label}<select id="${id}" data-field="${escapeHtml(step.id)}">${opts}</select>`;
  } else if (step.type === 'checkbox') {
    wrap.innerHTML = `<label class="check"><input type="checkbox" id="${id}" data-field="${escapeHtml(step.id)}"${value ? ' checked' : ''}> ${escapeHtml(step.label || step.id)}${step.required ? ' <span class="req">*</span>' : ''}</label>`;
  } else if (step.type === 'textarea') {
    wrap.innerHTML = `${label}<textarea id="${id}" data-field="${escapeHtml(step.id)}" rows="3">${escapeHtml(value || '')}</textarea>`;
  } else {
    const type = step.type === 'number' ? 'number' : 'text';
    wrap.innerHTML = `${label}<input type="${type}" id="${id}" data-field="${escapeHtml(step.id)}" value="${escapeHtml(value ?? step.default ?? '')}" placeholder="${escapeHtml(step.placeholder || '')}">`;
  }
  if (step.hint) wrap.insertAdjacentHTML('beforeend', `<div class="hint">${escapeHtml(step.hint)}</div>`);
  return wrap;
}

function button(text, onClick, kind) {
  const b = document.createElement('button');
  b.className = 'btn' + (kind ? ' ' + kind : '');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/* ══════════════════════════════════════════════════════
   Members / presence
   ══════════════════════════════════════════════════════ */

function renderMembers() {
  const order = Object.keys(state.agents);
  el.members.innerHTML = order.map((id) => {
    const a = state.agents[id];
    const cls = a.online === true ? 'on' : a.online === false ? 'off' : 'unknown';
    const busy = state.busy.has(id) ? ' busy' : '';
    const title = `${a.name} · ${a.online ? '在线' : a.online === false ? '离线' : '未知'}${a.mode === 'push' ? ' · push' : ''}`;
    return `<span class="chip ${cls}${busy}" style="--c:${a.color}" title="${escapeHtml(title)}">
      <span class="av"></span>${escapeHtml(a.name)}
    </span>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   Composer autocomplete — two modes, one popover
     @  → mention an agent
     :  → pick an emoji
   ══════════════════════════════════════════════════════ */

let pop = { open: false, items: [], index: 0, mode: null, trigger: '@' };

function mentionCandidates(query) {
  const all = [{ id: 'all', name: '全体成员', role: '唤醒所有人', color: '#22d3ee', isAll: true }];
  for (const [id, a] of Object.entries(state.agents)) {
    if (a.enabled === false) continue;
    all.push({ id, name: a.name, role: a.role || '', color: a.color, isAll: false });
  }
  const q = query.toLowerCase();
  return all.filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
}

function emojiCandidates(query) {
  const q = query.toLowerCase();
  return EMOJI_NAMES
    .filter((name) => !q || name.includes(q))
    .slice(0, 60)
    .map((name) => ({ id: name, name: EMOJI[name], role: `:${name}:`, isEmoji: true }));
}

function showPop(query, mode) {
  pop.mode = mode;
  pop.trigger = mode === 'emoji' ? ':' : '@';
  pop.items = mode === 'emoji' ? emojiCandidates(query) : mentionCandidates(query);
  if (!pop.items.length) return hidePop();
  pop.open = true;
  pop.index = 0;
  renderPop();
  el.pop.classList.add('show');
  el.input.setAttribute('aria-expanded', 'true');
}

function hidePop() {
  pop.open = false;
  pop.items = [];
  pop.mode = null;
  el.pop.classList.remove('show');
  el.input.setAttribute('aria-expanded', 'false');
}

function renderPop() {
  if (pop.mode === 'emoji') {
    el.pop.classList.add('emoji-grid');
    el.pop.innerHTML = pop.items.map((c, i) => `
      <button type="button" class="emoji-cell" role="option" data-i="${i}"
              aria-selected="${i === pop.index}" title="${escapeHtml(c.role)}">
        <span class="glyph" aria-hidden="true">${c.name}</span>
      </button>`).join('');
  } else {
    el.pop.classList.remove('emoji-grid');
    el.pop.innerHTML = pop.items.map((c, i) => `
      <div class="mention-item" role="option" data-i="${i}" aria-selected="${i === pop.index}" style="--c:${c.color}">
        <span class="av" aria-hidden="true">${escapeHtml(c.isAll ? '全' : c.name.slice(0, 1))}</span>
        <span class="nm">${escapeHtml(c.name)}</span>
        <span class="rl">${escapeHtml(c.role)}</span>
      </div>`).join('');
  }
  el.pop.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

/** Replace the text from the trigger character to the caret with `insert`. */
function applyPick(candidate) {
  const v = el.input.value;
  const caret = el.input.selectionStart;
  const before = v.slice(0, caret);
  const at = before.lastIndexOf(pop.trigger);
  if (at < 0) return hidePop();

  const insert = pop.mode === 'emoji'
    ? `${candidate.name} `
    : `@${candidate.name} `;

  el.input.value = before.slice(0, at) + insert + v.slice(caret);
  const pos = at + insert.length;
  el.input.setSelectionRange(pos, pos);
  hidePop();
  el.input.focus();
}

/**
 * Decide which popover (if any) the caret is in.
 * The trigger must be preceded by start/whitespace so that emails and
 * "http://" do not open the emoji picker.
 */
function detectTrigger() {
  const caret = el.input.selectionStart;
  const before = el.input.value.slice(0, caret);

  for (const [ch, mode] of [['@', 'mention'], [':', 'emoji']]) {
    const at = before.lastIndexOf(ch);
    if (at < 0) continue;
    if (at > 0 && !/[\s\n(]/.test(before[at - 1])) continue;
    const seg = before.slice(at + 1);
    if (/[\s\n]/.test(seg)) continue;
    if (seg.length > (mode === 'emoji' ? 20 : 12)) continue;
    // Bare ":" opens the full picker; a word means filtering.
    return showPop(seg, mode);
  }
  return hidePop();
}

el.pop.addEventListener('pointerdown', (e) => {
  const item = e.target.closest('.mention-item, .emoji-cell');
  if (!item) return;
  e.preventDefault();
  applyPick(pop.items[Number(item.dataset.i)]);
});

/* ══════════════════════════════════════════════════════
   Network
   ══════════════════════════════════════════════════════ */

async function loadDialogs() {
  try {
    const r = await fetch('/api/dialogs');
    const j = await r.json();
    store.set({ dialogs: j.dialogs || {} });
  } catch { /* panel still works */ }
}

async function loadState() {
  const r = await fetch('/api/state');
  const j = await r.json();
  store.set({ agents: j.agents || {} });
  store.set({ human: j.human || state.human });
  store.set({ room: j.defaultRoom || 'team' });
  store.set({ busy: new Set(j.busy || []) });
  store.set({ lastId: j.lastId || 0 });
  await loadDialogs();
  renderMembers();
}

async function loadHistory() {
  const r = await fetch(`/api/messages?room=${encodeURIComponent(state.room)}&after=0`);
  const j = await r.json();
  el.list.innerHTML = '';
  if (!j.messages.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '// 还没有消息，说第一句话试试';
    el.list.appendChild(e);
  } else {
    for (const m of j.messages) {
      el.list.appendChild(messageEl(m));
      if (m.id > state.lastId) store.set({ lastId: m.id });
    }
  }
  requestAnimationFrame(() => { el.scroller.scrollTop = el.scroller.scrollHeight; });
}

function appendMessage(m) {
  if (document.getElementById('m' + m.id)) return;
  el.list.querySelector('.empty')?.remove();
  if (m.id > state.lastId) store.set({ lastId: m.id });
  el.list.appendChild(messageEl(m));
  scrollIfNearBottom();
}

async function backfillMessages() {
  // EventSource reconnects on its own but events sent while offline are gone.
  // Replay the durable message log from the last id we rendered (dedup is in
  // appendMessage), so a brief network blip never leaves a hole in the room.
  try {
    const r = await fetch(`/api/messages?room=${encodeURIComponent(state.room)}&after=${state.lastId}`);
    if (!r.ok) return;
    const j = await r.json();
    for (const m of (j.messages || [])) appendMessage(m);
  } catch { /* next reconnect will try again */ }
}

function connectStream() {
  const es = new EventSource('/api/stream');
  let openedOnce = false;

  es.addEventListener('open', async () => {
    el.conn.classList.remove('off');
    el.sub.textContent = '已连接 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (openedOnce) await backfillMessages();
    openedOnce = true;
  });
  es.addEventListener('error', () => {
    el.conn.classList.add('off');
    el.sub.textContent = '连接断开，重连中…';
  });

  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.from && streams.has(m.from)) onStreamEnd({ from: m.from });
    appendMessage(m);
  });

  es.addEventListener('stream_start', (e) => onStreamStart(JSON.parse(e.data)));
  es.addEventListener('delta', (e) => onDelta(JSON.parse(e.data)));
  es.addEventListener('tool', (e) => onTool(JSON.parse(e.data)));
  es.addEventListener('stream_end', (e) => onStreamEnd(JSON.parse(e.data)));
  es.addEventListener('discussion', (e) => {
    const d = JSON.parse(e.data);
    // Only surface it when the operator is looking at that discussion.
    if (d && d.room === state.room) renderDiscussionBar(d);
  });

  es.addEventListener('presence', (e) => {
    const { agents } = JSON.parse(e.data);
    if (agents) store.set({ agents });
  });

  es.addEventListener('typing', (e) => {
    const { who, on } = JSON.parse(e.data);
    if (on) state.busy.add(who); else state.busy.delete(who);
    renderMembers();

    let node = document.getElementById('typing-' + who);
    if (on) {
      if (!node) {
        const a = whoOf(who);
        node = document.createElement('div');
        node.className = 'typing on';
        node.id = 'typing-' + who;
        node.innerHTML = `<span style="--c:${a.color}">${escapeHtml(a.name)}</span> 正在处理
          <span class="wave" aria-hidden="true"><i></i><i></i><i></i></span>`;
        el.list.appendChild(node);
        scrollIfNearBottom();
      }
    } else {
      node?.remove();
    }
  });

  es.addEventListener('dialog', (e) => {
    const d = JSON.parse(e.data);
    state.dialogs[d.id] = d;
    const card = document.querySelector(`.dialog-card[data-dialog-id="${d.id}"]`);
    if (!card) return;
    const fresh = dialogCard(d);
    card.replaceWith(fresh);
  });
}

/* ══════════════════════════════════════════════════════
   Image upload — paste, drag & drop, or the attach button
   ══════════════════════════════════════════════════════ */

const MAX_IMAGES_PER_MESSAGE = 8;

async function uploadImage(file) {
  if (!file || !file.type.startsWith('image/')) {
    toast('只能上传图片');
    return;
  }
  if (state.pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
    toast(`一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图`);
    return;
  }

  const form = new FormData();
  form.append('file', file, file.name || 'image');

  try {
    const r = await fetch('/api/upload', { method: 'POST', body: form });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    state.pendingImages.push({ url: j.url, alt: file.name || '', w: j.w, h: j.h });
    renderPendingImages();
  } catch (e) {
    toast('上传失败：' + e.message);
  }
}

function renderPendingImages() {
  el.pendingImages.innerHTML = state.pendingImages.map((img, i) => `
    <div class="pending-img" title="${escapeHtml(img.alt || '')}">
      <img src="${escapeHtml(img.url)}" alt="" loading="lazy" decoding="async">
      <button type="button" data-i="${i}" aria-label="移除图片">×</button>
    </div>`).join('');
}

el.pendingImages.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-i]');
  if (!btn) return;
  state.pendingImages.splice(Number(btn.dataset.i), 1);
  renderPendingImages();
});

/* Paste a screenshot straight into the composer. */
el.input.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const files = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) uploadImage(f);
});

/* Drag & drop onto the composer. */
const composer = document.querySelector('.composer');
['dragenter', 'dragover'].forEach((evt) =>
  composer.addEventListener(evt, (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    composer.classList.add('dropping');
  }));
['dragleave', 'drop'].forEach((evt) =>
  composer.addEventListener(evt, (e) => {
    if (evt === 'dragleave' && composer.contains(e.relatedTarget)) return;
    composer.classList.remove('dropping');
  }));
composer.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) uploadImage(f);
});

el.attach.addEventListener('click', () => el.filePicker.click());
el.filePicker.addEventListener('change', () => {
  for (const f of [...el.filePicker.files]) uploadImage(f);
  el.filePicker.value = '';
});

/* ══════════════════════════════════════════════════════
   Streaming turns
   A live agent reply is rendered as a normal message that grows. Nothing is
   persisted until the stream ends, so an interrupted turn is not frozen into
   history as a half sentence.
   ══════════════════════════════════════════════════════ */

const streams = new Map(); // agentId -> { el, bubble, buffer, tools }

function streamEl(agentId, name, color) {
  const who = whoOf(agentId);
  const initial = (who.name || '?').slice(0, 1).toUpperCase();

  const article = document.createElement('article');
  article.className = 'msg streaming';
  article.innerHTML = `
    <div class="av-lg" style="--c:${who.color}" aria-hidden="true">${escapeHtml(initial)}</div>
    <div class="body">
      <div class="meta">
        <span class="who" style="--c:${who.color}">${escapeHtml(who.name)}</span>
        <span class="role">${escapeHtml(who.role || '')}</span>
        <span class="role stream-badge">生成中</span>
      </div>
      <div class="bubble"><span class="stream-text"></span><span class="caret" aria-hidden="true"></span></div>
      <div class="stream-tools"></div>
    </div>`;
  return article;
}

function onStreamStart(data) {
  const { from, msgId, name } = data || {};
  if (!from) return;
  streams.get(from)?.el.remove();
  const node = streamEl(from, name);
  node.dataset.agent = from;
  el.list.querySelector('.empty')?.remove();
  el.list.appendChild(node);
  streams.set(from, { el: node, bubble: node.querySelector('.stream-text'), tools: node.querySelector('.stream-tools'), buffer: '' });
  scrollIfNearBottom();
}

function onDelta(data) {
  const { from, text } = data || {};
  if (!from || typeof text !== 'string') return;
  let s = streams.get(from);
  if (!s) {
    onStreamStart({ from });
    s = streams.get(from);
  }
  if (!s) return;
  s.buffer += text;
  // Render the accumulated text so markdown (code fences, bold) keeps working
  // while streaming instead of flashing raw asterisks at the reader.
  s.bubble.innerHTML = renderMarkdown(s.buffer);
  scrollIfNearBottom();
}

function onTool(data) {
  const { from, name, detail } = data || {};
  const s = streams.get(from);
  if (!s) return;
  const chip = document.createElement('div');
  chip.className = 'tool-chip';
  chip.innerHTML = `<span class="tool-name">🔧 ${escapeHtml(name || 'tool')}</span>
    <span class="tool-detail">${escapeHtml(String(detail || '').slice(0, 120))}</span>`;
  s.tools.appendChild(chip);
  scrollIfNearBottom();
}

function onStreamEnd(data) {
  const { from } = data || {};
  const s = streams.get(from);
  if (!s) return;
  // The authoritative message arrives separately; drop the live node so the
  // persisted one (with timestamp, id, refs) takes its place.
  s.el.remove();
  streams.delete(from);
}

/* ══════════════════════════════════════════════════════
   Discussions
   A discussion is its own room plus a status bar. Speakers answer in turn, so
   the thread reads top to bottom like a meeting minute rather than a pile of
   simultaneous replies.
   ══════════════════════════════════════════════════════ */

const discussion = {
  active: null,   // the record being watched
};

function renderDiscussionBar(record) {
  const bar = el.discussBar;
  if (!record) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  discussion.active = record;
  const running = record.status === 'running';
  const names = record.participants.map((id) => state.agents[id]?.name || id).join(' · ');
  const turns = record.turns ? record.turns.length : 0;
  const skips = record.skips ? record.skips.length : 0;

  // Which planned question are we on, and what is it? This is the single most
  // useful piece of context while a discussion runs — without it the bar says
  // "turn 3/12" and nothing about what is being decided.
  const qs = record.questions || [];
  const answered = qs.length
    ? Math.min(qs.reduce((max, _, i) => (
      (record.turns || []).some((t) => t.question === i) ? i + 1 : max
    ), 0), qs.length)
    : 0;
  const currentQ = qs.length ? qs[Math.min(answered, qs.length - 1)] : null;

  bar.hidden = false;
  bar.className = 'discuss-bar' + (running ? ' running' : ' done');
  bar.innerHTML = `
    <span class="discuss-icon" aria-hidden="true">${running ? '💬' : '📋'}</span>
    <div class="discuss-main">
      <div class="discuss-topic">${escapeHtml(record.topic)}</div>
      ${qs.length && running
        ? `<div class="discuss-question">
             <span class="q-badge">第 ${Math.min(answered + 1, qs.length)}/${qs.length} 题</span>
             ${escapeHtml(currentQ || '')}
           </div>`
        : qs.length
          ? `<div class="discuss-meta">已答 ${answered}/${qs.length} 题</div>`
          : ''}
      <div class="discuss-meta">
        ${escapeHtml(names)} · ${turns}/${record.policy.maxTurns} 轮 · ${escapeHtml(record.policy.turnTaking)}
        ${skips ? ` · ${skips} 次弃权` : ''}
        ${record.stopReason ? ' · ' + escapeHtml(record.stopReason) : ''}
      </div>
    </div>
    ${running
      ? '<button type="button" class="btn" id="discussStop">结束</button>'
      : '<button type="button" class="btn" id="discussClose">收起</button>'}
  `;

  bar.querySelector('#discussStop')?.addEventListener('click', async () => {
    try {
      await fetch(`/api/discussions/${encodeURIComponent(record.id)}/stop`, { method: 'POST' });
    } catch (e) { toast('结束失败：' + e.message); }
  });
  bar.querySelector('#discussClose')?.addEventListener('click', () => {
    discussion.active = null;
    renderDiscussionBar(null);
  });
}

/** Switch the visible room. Discussions live in their own room. */
async function enterRoom(room) {
  store.set({ room });
  el.list.innerHTML = '';
  store.set({ lastId: 0 });
  await loadHistory();
}

/** Small composer dialog for starting a discussion. */
function openDiscussForm() {
  const ids = Object.entries(state.agents).filter(([, a]) => a.enabled !== false).map(([id]) => id);
  if (ids.length < 2) {
    toast('至少需要两个 agent 才能发起讨论');
    return;
  }

  const dlg = document.createElement('dialog');
  dlg.className = 'form-dialog';
  dlg.innerHTML = `
    <form method="dialog" class="form-body">
      <h3>发起分组讨论</h3>
      <div class="field">
        <label for="dtopic">话题 <span class="req">*</span></label>
        <input type="text" id="dtopic" placeholder="要讨论什么？" required>
      </div>
      <div class="field">
        <label>参与者</label>
        <div class="check-list">
          ${ids.map((id) => `
            <label class="check">
              <input type="checkbox" value="${escapeHtml(id)}" ${ids.length <= 3 ? 'checked' : ''}>
              <span>${escapeHtml(state.agents[id]?.name || id)}</span>
              <span class="hint">${escapeHtml(state.agents[id]?.role || '')}</span>
            </label>`).join('')}
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="dpolicy">发言策略</label>
          <select id="dpolicy">
            <option value="round-robin">轮流（成本可预测）</option>
            <option value="selector">LLM 选（更贴合内容，多一次调用）</option>
            <option value="mention">人工点名（我 @ 谁谁说话）</option>
          </select>
          <div class="hint">谁都可以回 LISTEN 弃权，弃权不消耗轮次</div>
        </div>
        <div class="field">
          <label for="dturns">最大轮次</label>
          <input type="number" id="dturns" value="6" min="1" max="50">
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label class="check" style="margin-top:4px">
            <input type="checkbox" id="dplan" checked>
            <span>先拆成具体问题再讨论</span>
          </label>
          <div class="hint">避免话题漂移，纪要也按问题分组</div>
        </div>
        <div class="field">
          <label for="dperq">每题轮次</label>
          <input type="number" id="dperq" value="2" min="1" max="6">
        </div>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" data-act="cancel">取消</button>
        <button type="button" class="btn primary" data-act="start">开始</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);

  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.querySelector('[data-act="cancel"]').addEventListener('click', close);

  dlg.querySelector('[data-act="start"]').addEventListener('click', async () => {
    const topic = dlg.querySelector('#dtopic').value.trim();
    const participants = [...dlg.querySelectorAll('.check-list input:checked')].map((i) => i.value);
    if (!topic) { dlg.querySelector('#dtopic').focus(); return; }
    if (participants.length < 2) { toast('至少选两个参与者'); return; }

    const btn = dlg.querySelector('[data-act="start"]');
    btn.disabled = true;
    try {
      const r = await fetch('/api/discussions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          participants,
          policy: {
            turnTaking: dlg.querySelector('#dpolicy').value,
            maxTurns: Number(dlg.querySelector('#dturns').value) || 6,
            planFirst: dlg.querySelector('#dplan').checked,
            turnsPerQuestion: Number(dlg.querySelector('#dperq').value) || 2,
          },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      close();
      await enterRoom(j.discussion.room);
      renderDiscussionBar(j.discussion);
    } catch (e) {
      toast('发起失败：' + e.message);
      btn.disabled = false;
    }
  });

  dlg.showModal();
  dlg.querySelector('#dtopic').focus();
}

el.discussBtn?.addEventListener('click', openDiscussForm);

/* ══════════════════════════════════════════════════════
   Send
   ══════════════════════════════════════════════════════ */

function autosize() {
  if (!CSS.supports('field-sizing', 'content')) {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 140) + 'px';
  }
}

async function send() {
  const text = el.input.value.trim();
  if (!text) return;
  el.send.disabled = true;
  try {
    const r = await fetch('/api/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: state.room, from: state.me, text,
        refs: state.pendingRefs,
        images: state.pendingImages,
      }),
    });
    if (!r.ok) {
      toast('发送失败：' + ((await r.json()).error || r.status));
      return;
    }
    el.input.value = '';
    clearPendingRefs();
    store.set({ pendingImages: [] });
    renderPendingImages();
    autosize();
    el.input.focus();
  } catch (e) {
    toast('网络错误：' + e.message);
  } finally {
    el.send.disabled = false;
  }
}

function clearPendingRefs() {
  store.set({ pendingRefs: [] });
  el.pendingRefs.innerHTML = '';
}

function addPendingRef(ref) {
  if (state.pendingRefs.some((r) => r.id === ref.id && r.surface === ref.surface)) return;
  state.pendingRefs.push(ref);
  const chip = document.createElement('span');
  chip.className = 'pending-ref';
  chip.innerHTML = `📎 ${escapeHtml(ref.title || ref.id)} <button type="button" title="移除">×</button>`;
  chip.querySelector('button').addEventListener('click', () => {
    store.set({ pendingRefs: state.pendingRefs.filter((r) => r !== ref) });
    chip.remove();
  });
  el.pendingRefs.appendChild(chip);
  el.input.focus();
}

/* ══════════════════════════════════════════════════════
   Workspace panel
   ══════════════════════════════════════════════════════ */

const SURFACES = [
  { id: 'docs', label: '文档' },
  { id: 'tasks', label: '任务' },
  { id: 'files', label: '文件' },
  { id: 'members', label: '成员' },
];

async function renderPanel() {
  el.panelTabs.innerHTML = SURFACES.map((s) =>
    `<button class="panel-tab" role="tab" data-surface="${s.id}" aria-selected="${s.id === state.surface}" tabindex="${s.id === state.surface ? '0' : '-1'}">${s.label}</button>`
  ).join('') + '<button class="panel-tab panel-back" id="panelBack" type="button" aria-label="返回对话">‹ 返回</button>';

  // Snapshot the requested surface: a fast tab switch bumps state.surface, and
  // any in-flight render must not overwrite the panel the user is now looking at.
  const want = state.surface;
  const stale = () => state.surface !== want;

  if (want === 'members') {
    el.panelFoot.textContent = '';
    await mountMembersPanel(el.panelBody, el.panelFoot);
    return;
  }

  el.panelBody.innerHTML = '<div class="empty" style="padding:24px">加载中…</div>';
  mountSurfaceActions(el.panelFoot, want, () => { if (state.surface === want) renderPanel(); });

  try {
    const r = await fetch(`/api/surface/${want}`);
    if (stale()) return;
    if (!r.ok) throw new Error(r.status);
    const { items } = await r.json();
    if (stale()) return;
    if (!items || !items.length) {
      el.panelBody.innerHTML = `<div class="empty" style="padding:24px">// ${want} 还没有内容</div>`;
      return;
    }
    el.panelBody.innerHTML = items.map((it) => `
      <div class="surface-item" data-id="${escapeHtml(it.id)}" data-title="${escapeHtml(it.title || it.id)}" role="button" tabindex="0">
        <span class="t">${escapeHtml(it.title || it.id)}${it.byName ? `<span class="by" title="写入者">${escapeHtml(it.byName)}</span>` : ''}</span>
        <span class="m">${escapeHtml(it.meta || '')}</span>
      </div>`).join('');
  } catch {
    if (stale()) return;
    el.panelBody.innerHTML = `<div class="empty" style="padding:24px">// 该 surface 暂不可用</div>`;
  }
}

el.panelTabs.addEventListener('keydown', (e) => {
  const tabs = [...el.panelTabs.querySelectorAll('.panel-tab[data-surface]')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  let n = -1;
  if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') n = 0;
  else if (e.key === 'End') n = tabs.length - 1;
  if (n < 0) return;
  e.preventDefault();
  const surface = tabs[n].dataset.surface;
  tabs[n].click();
  // renderPanel() rebuilds the tab DOM; restore focus to the new active tab
  // so keyboard users stay on the tablist (roving tabindex).
  el.panelTabs.querySelector(`.panel-tab[data-surface="${surface}"]`)?.focus();
});

el.panelTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.panel-tab');
  if (!btn) return;
  if (btn.id === 'panelBack') { togglePanel(false); return; } // mobile: back to chat
  store.set({ surface: btn.dataset.surface });
  renderPanel();
});

el.panelBody.addEventListener('click', (e) => {
  if (state.surface === 'members') return;
  const item = e.target.closest('.surface-item');
  if (!item) return;
  addPendingRef({ surface: state.surface, id: item.dataset.id, title: item.dataset.title });
});

// The workspace panel is a full-screen drawer on narrow screens. Keep the
// browser's Back gesture in sync with it: opening pushes one history entry,
// Back / Swipe / Esc close it, and focus returns to the toggle button.
const drawerMQ = window.matchMedia('(max-width: 900px)');
let panelHistoryEntry = false;

function setPanelDom(next) {
  store.set({ panelOpen: next });
  el.app.classList.toggle('with-panel', next);
  el.panelToggle.classList.toggle('active', next);
  localStorage.setItem('hub.panel', next ? '1' : '0');
  // While the drawer covers the chat, make the covered regions inert so
  // keyboard and screen-reader focus stays in the drawer.
  const covered = [el.app.querySelector('main'), document.querySelector('footer')];
  for (const node of covered) {
    if (!node) continue;
    if (next && drawerMQ.matches) node.setAttribute('inert', '');
    else node.removeAttribute('inert');
  }
  if (next) renderPanel();
}

function togglePanel(force, opts = {}) {
  const prev = state.panelOpen;
  const next = force !== undefined ? force : !prev;
  setPanelDom(next);

  if (!opts.fromPop && drawerMQ.matches) {
    if (next && !prev) {
      history.pushState({ athPanel: true }, '');
      panelHistoryEntry = true;
    } else if (!next && prev && panelHistoryEntry) {
      panelHistoryEntry = false;
      history.back();
    }
  }

  if (next && !prev) el.panelTabs.querySelector('.panel-tab')?.focus();
  else if (!next && prev) el.panelToggle.focus();
}

window.addEventListener('popstate', (e) => {
  panelHistoryEntry = false;
  // Only the drawer owns a history entry; in the desktop side-bar layout a
  // browser Back must not dismiss the panel.
  if (drawerMQ.matches && state.panelOpen && !(e.state && e.state.athPanel)) {
    togglePanel(false, { fromPop: true });
  }
});

// If the viewport grows out of drawer mode while it is open, drop inert.
drawerMQ.addEventListener('change', () => {
  if (!drawerMQ.matches) {
    const covered = [el.app.querySelector('main'), document.querySelector('footer')];
    for (const node of covered) node?.removeAttribute('inert');
    panelHistoryEntry = false;
  }
});

/* ══════════════════════════════════════════════════════
   Wiring
   ══════════════════════════════════════════════════════ */

el.send.addEventListener('click', send);

el.input.addEventListener('keydown', (e) => {
  if (pop.open && pop.items.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); pop.index = (pop.index + 1) % pop.items.length; renderPop(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); pop.index = (pop.index - 1 + pop.items.length) % pop.items.length; renderPop(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyPick(pop.items[pop.index]); return; }
    if (e.key === 'Escape') { e.preventDefault(); hidePop(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

el.input.addEventListener('input', () => { detectTrigger(); autosize(); });
el.input.addEventListener('click', detectTrigger);
el.input.addEventListener('blur', () => setTimeout(hidePop, 120));

el.asWho.value = state.me;
el.asWho.addEventListener('change', () => {
  store.set({ me: el.asWho.value });
  localStorage.setItem('hub.identity', state.me);
});

el.panelToggle.addEventListener('click', () => togglePanel());

el.toBottom.addEventListener('click', () => el.scroller.scrollTo({ top: el.scroller.scrollHeight, behavior: 'smooth' }));

if (!CSS.supports('container-type', 'scroll-state')) {
  el.scroller.addEventListener('scroll', () => {
    const away = el.scroller.scrollTop < el.scroller.scrollHeight - el.scroller.clientHeight - 120;
    el.toBottom.classList.toggle('show', away);
  }, { passive: true });
}

/* Debug hook — handy when a live stream misbehaves and the console is the
   only window into module scope. Read-only by convention. */
window.__hub = { state, streams, el };

/* One subscription drives the member strip and mention list. Views no longer
   have to remember to call renderMembers() after every write. */
store.subscribe((_s, keys) => {
  if (keys.has('agents') || keys.has('busy') || keys.has('dialogs')) renderMembers();
});

/* ── boot ── */
(async () => {
  await loadState();
  await loadHistory();
  connectStream();
  // Initial render from localStorage: paint without pushing a history entry.
  if (state.panelOpen) setPanelDom(true);
  el.input.focus();

  // Slow refresh: presence is pushed via SSE, but a poll also covers a missed event.
  setInterval(async () => {
    try {
      const r = await fetch('/api/state');
      const j = await r.json();
      store.set({ agents: j.agents || state.agents });
      store.set({ busy: new Set(j.busy || []) });
      renderMembers();
    } catch { /* offline */ }
  }, 15000);
})();
