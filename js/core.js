// Pure logic: state <-> URL, channel validation, layouts, remote-control navigation.
export const LAYOUTS = ['grid', 'spotlight', 'pip', 'single'];
export const MAX_CHANNELS = 9;
// Quality presets: 'auto' = Twitch decides, numbers = max. vertical resolution, 'min' = lowest available.
export const QUALITIES = ['auto', '1080', '720', '480', '360', 'min'];
const DEFAULT_Q_MAIN = 'auto';
const DEFAULT_Q_SIDE = 'min';
const CHANNEL_RE = /^[a-z0-9_]{1,25}$/;

// First path segments on twitch.tv that are pages, not channels.
const RESERVED = new Set([
  'videos', 'video', 'directory', 'search', 'settings', 'p', 'downloads', 'jobs', 'turbo', 'subscriptions',
  'inventory', 'wallet', 'friends', 'messages', 'drops', 'prime', 'store', 'login', 'signup', 'logout',
  'following', 'collections', 'clip', 'clips', 'team', 'activate', 'products', 'bits', 'broadcast', 'help',
]);
const TWITCH_URL_RE = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)*twitch\.tv)(?=$|[/?#])(.*)$/i;

function channelFromUrl(host, rest) {
  const [beforeHash] = rest.split('#');
  const qi = beforeHash.indexOf('?');
  const path = qi < 0 ? beforeHash : beforeHash.slice(0, qi);
  const params = new URLSearchParams(qi < 0 ? '' : beforeHash.slice(qi + 1));
  const parts = path.split('/').filter(Boolean).map((x) => x.toLowerCase());
  let cand = null;
  if (host === 'player.twitch.tv' || host === 'embed.twitch.tv') cand = params.get('channel');
  else if (host === 'dashboard.twitch.tv') cand = parts[0] === 'u' ? parts[1] : null;
  else if (host === 'twitch.tv' || host === 'www.twitch.tv' || host === 'm.twitch.tv' || host === 'go.twitch.tv') {
    if (['popout', 'moderator', 'embed'].includes(parts[0])) cand = parts[1];
    else if (parts[0] && !RESERVED.has(parts[0])) cand = parts[0];
  }
  cand = cand ? cand.toLowerCase() : null;
  return cand && CHANNEL_RE.test(cand) ? cand : null;
}

// Accepts "name", "@name", "twitch.tv/name", "https://www.twitch.tv/name/...", "m.twitch.tv/name?x=1",
// popout/player/dashboard links -> "name" or null
export function normalizeChannel(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  const m = s.replace(/^<(.*)>$/, '$1').match(TWITCH_URL_RE); // <link> as some chat apps copy it
  if (m) return channelFromUrl(m[1].toLowerCase(), m[2]);
  const n = s.toLowerCase().replace(/^@/, '');
  return CHANNEL_RE.test(n) ? n : null;
}

// Splits pasted text into channels. If the text contains Twitch links, only the links count
// (so "schau mal twitch.tv/abc" works). Otherwise every word / comma-separated entry is a name.
export function parseChannelList(text) {
  const channels = [];
  const invalid = [];
  if (typeof text !== 'string') return { channels, invalid };
  const tokens = text.split(/[\s,;|]+/).filter(Boolean);
  const hasLinks = tokens.some((t) => TWITCH_URL_RE.test(t.replace(/^<(.*)>$/, '$1')));
  for (const t of tokens) {
    const isLink = TWITCH_URL_RE.test(t.replace(/^<(.*)>$/, '$1'));
    if (hasLinks && !isLink) continue;
    const n = normalizeChannel(t);
    if (!n) invalid.push(t);
    else if (!channels.includes(n)) channels.push(n);
  }
  return { channels, invalid };
}

// Player qualities (objects {name, group} or strings) -> [{ id, res }] with a real resolution.
function realQualities(qualities) {
  if (!Array.isArray(qualities)) return [];
  const out = [];
  for (const q of qualities) {
    const id = typeof q === 'string' ? q : q && (q.group || q.name);
    if (!id || id === 'auto' || id === 'audio_only') continue;
    // "chunked" is the source quality; its resolution is in the name ("1080p60 (source)")
    const label = id === 'chunked' && q && typeof q === 'object' ? String(q.name || '') : String(id);
    const res = Number.parseInt(label, 10);
    if (Number.isFinite(res)) out.push({ id, res });
  }
  return out;
}

// Lowest real quality id (e.g. "160p30"), or null.
export function lowestQuality(qualities) {
  let best = null;
  for (const q of realQualities(qualities)) if (!best || q.res < best.res) best = q;
  return best ? best.id : null;
}

// Quality id to set for a preset: 'auto', 'min' or max. resolution ('1080', '720', ...).
// Picks the highest available quality not above the limit, else the lowest. null = nothing to set yet.
export function pickQuality(qualities, preset) {
  if (preset === 'auto') return 'auto';
  if (preset === 'min') return lowestQuality(qualities);
  const limit = Number.parseInt(preset, 10);
  const list = realQualities(qualities);
  let best = null;
  for (const q of list) if (q.res <= limit && (!best || q.res > best.res)) best = q;
  return best ? best.id : lowestQuality(qualities);
}

export function defaultState() {
  return { channels: [], layout: 'grid', audio: null, qMain: DEFAULT_Q_MAIN, qSide: DEFAULT_Q_SIDE, crops: {} };
}

// ---------- cam crop ("nur die Kamera zeigen") ----------
// A crop is [x, y, s] in percent of the stream picture: left/top edge and size of the region.
// The region has the picture's own aspect (16:9), so a size of 25 = a quarter of width and height.
export const CROP_MIN = 10;
export const CROP_STEP = 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function sanitizeCrop(c) {
  if (!Array.isArray(c) || c.length !== 3) return null;
  const n = c.map((v) => Math.round(Number(v)));
  if (n.some((v) => !Number.isFinite(v))) return null;
  const s = clamp(n[2], CROP_MIN, 100);
  if (s >= 100) return null; // whole picture = no crop
  return [clamp(n[0], 0, 100 - s), clamp(n[1], 0, 100 - s), s];
}

// corner: 'tl' | 'tr' | 'bl' | 'br' | 'c'
export function cropPreset(corner, s = 30) {
  const far = 100 - s;
  const pos = { tl: [0, 0], tr: [far, 0], bl: [0, far], br: [far, far], c: [far / 2, far / 2] }[corner] || [0, 0];
  return sanitizeCrop([pos[0], pos[1], s]);
}

// Moves (dx, dy) or resizes (ds, around the center) a crop and keeps it inside the picture.
export function adjustCrop(c, { dx = 0, dy = 0, ds = 0 } = {}) {
  const [x, y, s] = c || [35, 35, 30];
  const ns = clamp(s + ds, CROP_MIN, 100);
  return sanitizeCrop([x + dx - (ns - s) / 2, y + dy - (ns - s) / 2, ns]);
}

// Size/position (px) of the 16:9 player inside a tile of tileW x tileH so that the crop region
// covers the tile (centered, never showing anything outside the picture).
export function cropBox(tileW, tileH, crop) {
  const c = sanitizeCrop(crop);
  if (!c || tileW <= 0 || tileH <= 0) return null;
  const [x, y, s] = c.map((v) => v / 100);
  const width = Math.max(tileW / s, ((tileH / s) * 16) / 9);
  const height = (width * 9) / 16;
  const left = clamp(tileW / 2 - (x + s / 2) * width, tileW - width, 0);
  const top = clamp(tileH / 2 - (y + s / 2) * height, tileH - height, 0);
  return { left, top, width, height };
}

function sanitizeCrops(raw, channels) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const ch of channels) {
    const c = sanitizeCrop(raw[ch]);
    if (c) out[ch] = c;
  }
  return out;
}

export function setCrop(st, ch, crop) {
  const crops = { ...st.crops };
  const c = sanitizeCrop(crop);
  if (c) crops[ch] = c;
  else delete crops[ch];
  return { ...st, crops };
}

export function sanitizeState(raw) {
  const st = defaultState();
  if (!raw || typeof raw !== 'object') return st;
  const list = Array.isArray(raw.channels) ? raw.channels : [];
  for (const c of list) {
    const n = normalizeChannel(String(c));
    if (n && !st.channels.includes(n) && st.channels.length < MAX_CHANNELS) st.channels.push(n);
  }
  st.layout = LAYOUTS.includes(raw.layout) ? raw.layout : 'grid';
  st.audio = st.channels.includes(raw.audio) ? raw.audio : st.channels[0] || null;
  st.qMain = QUALITIES.includes(raw.qMain) ? raw.qMain : DEFAULT_Q_MAIN;
  st.qSide = QUALITIES.includes(raw.qSide) ? raw.qSide : DEFAULT_Q_SIDE;
  st.crops = sanitizeCrops(raw.crops, st.channels);
  return st;
}

// URL format: ?c=chan1,chan2&l=grid&a=chan1&k=chan2.70.0.30 (k = cam crops: name.x.y.size)
export function parseQuery(search) {
  const p = new URLSearchParams(search);
  const channels = (p.get('c') || '').split(',').filter(Boolean);
  if (!channels.length) return null;
  const crops = {};
  for (const part of (p.get('k') || '').split(',')) {
    const [ch, ...nums] = part.split('.');
    if (ch) crops[ch.toLowerCase()] = nums;
  }
  return sanitizeState({ channels, layout: p.get('l'), audio: p.get('a'), crops });
}

export function toQuery(st) {
  if (!st.channels.length) return '';
  const p = new URLSearchParams();
  p.set('c', st.channels.join(','));
  if (st.layout !== 'grid') p.set('l', st.layout);
  if (st.audio && st.audio !== st.channels[0]) p.set('a', st.audio);
  const k = st.channels.filter((c) => st.crops && st.crops[c]).map((c) => [c, ...st.crops[c]].join('.'));
  if (k.length) p.set('k', k.join(','));
  return '?' + p.toString().replace(/%2C/g, ',');
}

export function addChannel(st, input) {
  const n = normalizeChannel(input);
  if (!n) return { state: st, error: 'Ungueltiger Kanalname' };
  if (st.channels.includes(n)) return { state: st, error: `${n} ist schon drin` };
  if (st.channels.length >= MAX_CHANNELS) return { state: st, error: `Maximal ${MAX_CHANNELS} Kanaele` };
  const channels = [...st.channels, n];
  return { state: { ...st, channels, audio: st.audio || n }, error: null };
}

// Adds every channel found in text. Returns added names and readable problems.
export function addChannels(st, text) {
  const { channels, invalid } = parseChannelList(text);
  const added = [];
  const errors = [];
  if (!channels.length && !invalid.length) return { state: st, added, errors: ['Bitte Twitch-Link oder Kanalnamen eingeben'] };
  if (invalid.length) errors.push('Kein Twitch-Kanal: ' + invalid.join(', '));
  let next = st;
  for (const c of channels) {
    const r = addChannel(next, c);
    if (r.error) { if (!errors.includes(r.error)) errors.push(r.error); }
    else { next = r.state; added.push(c); }
  }
  return { state: next, added, errors };
}

export function removeChannel(st, name) {
  const channels = st.channels.filter((c) => c !== name);
  const audio = st.audio === name ? channels[0] || null : st.audio;
  const crops = { ...st.crops };
  delete crops[name];
  return { ...st, channels, audio, crops };
}

export function moveChannel(st, name, delta) {
  const i = st.channels.indexOf(name);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= st.channels.length) return st;
  const channels = [...st.channels];
  [channels[i], channels[j]] = [channels[j], channels[i]];
  return { ...st, channels };
}

// Tile rectangles in percent of the viewport. mainIdx = channel with sound.
export function layoutRects(layout, n, mainIdx = 0) {
  if (n <= 0) return [];
  if (mainIdx < 0 || mainIdx >= n) mainIdx = 0;
  const full = { x: 0, y: 0, w: 100, h: 100 };
  if (n === 1) return [full];

  if (layout === 'single') {
    return Array.from({ length: n }, (_, i) => (i === mainIdx ? full : null));
  }

  if (layout === 'spotlight') {
    const rects = new Array(n);
    const sides = [];
    for (let i = 0; i < n; i++) if (i !== mainIdx) sides.push(i);
    if (sides.length <= 3) {
      // main left, cams in one column on the right
      rects[mainIdx] = { x: 0, y: 0, w: 75, h: 100 };
      const h = 100 / sides.length;
      sides.forEach((i, k) => { rects[i] = { x: 75, y: k * h, w: 25, h }; });
      return rects;
    }
    // 4+ cams: main top left (2/3), 3 cams in the right column, the rest in a row below
    // (keeps cams big enough for Twitch, which needs at least 400x300 px to start a stream)
    const t = 100 / 3;
    rects[mainIdx] = { x: 0, y: 0, w: 2 * t, h: 2 * t };
    sides.slice(0, 3).forEach((i, k) => { rects[i] = { x: 2 * t, y: k * t, w: t, h: t }; });
    const rest = sides.slice(3);
    const w = (2 * t) / rest.length;
    rest.forEach((i, k) => { rects[i] = { x: k * w, y: 2 * t, w, h: t }; });
    return rects;
  }

  if (layout === 'pip') {
    const rects = new Array(n);
    rects[mainIdx] = full;
    const w = 25, h = 28, gap = 1.5; // 480x302 px on a 1920x1080 screen (Twitch minimum 400x300)
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (i === mainIdx) continue;
      // stack up from bottom-right, wrap into a second column if needed
      const col = Math.floor(k / 3), row = k % 3;
      rects[i] = { x: 100 - (col + 1) * (w + gap), y: 100 - (row + 1) * (h + gap), w, h };
      k++;
    }
    return rects;
  }

  // grid
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = 100 / cols, h = 100 / rows;
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const offset = ((cols - inRow) * w) / 2; // center the last row
    return { x: offset + (i % cols) * w, y: r * h, w, h };
  });
}

// Spatial navigation for TV remotes. rects: [{x,y,w,h}|null], from: index, dir: up|down|left|right.
// Returns index of the best candidate or -1.
export function spatialNext(rects, from, dir) {
  const a = rects[from];
  if (!a) return -1;
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  let best = -1, bestScore = Infinity;
  rects.forEach((b, i) => {
    if (!b || i === from) return;
    const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const dx = bc.x - ac.x, dy = bc.y - ac.y;
    let main, cross;
    if (dir === 'left') { main = -dx; cross = Math.abs(dy); }
    else if (dir === 'right') { main = dx; cross = Math.abs(dy); }
    else if (dir === 'up') { main = -dy; cross = Math.abs(dx); }
    else { main = dy; cross = Math.abs(dx); }
    if (main <= 0.5) return;
    const score = main + cross * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}
