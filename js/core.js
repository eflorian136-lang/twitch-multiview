// Pure logic: state <-> URL, channel validation, layouts, remote-control navigation.
export const LAYOUTS = ['grid', 'spotlight', 'pip', 'single'];
export const MAX_CHANNELS = 9;
const CHANNEL_RE = /^[a-z0-9_]{1,25}$/;

// Accepts "name", "@name", "twitch.tv/name", "https://www.twitch.tv/name/..." -> "name" or null
export function normalizeChannel(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^(www\.|m\.)?twitch\.tv\//, '').replace(/^@/, '');
  s = s.split(/[/?#]/)[0];
  return CHANNEL_RE.test(s) ? s : null;
}

export function defaultState() {
  return { channels: [], layout: 'grid', audio: null };
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
  return st;
}

// URL format: ?c=chan1,chan2&l=grid&a=chan1
export function parseQuery(search) {
  const p = new URLSearchParams(search);
  if (!p.has('c')) return null;
  return sanitizeState({ channels: (p.get('c') || '').split(','), layout: p.get('l'), audio: p.get('a') });
}

export function toQuery(st) {
  if (!st.channels.length) return '';
  const p = new URLSearchParams();
  p.set('c', st.channels.join(','));
  if (st.layout !== 'grid') p.set('l', st.layout);
  if (st.audio && st.audio !== st.channels[0]) p.set('a', st.audio);
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

export function removeChannel(st, name) {
  const channels = st.channels.filter((c) => c !== name);
  const audio = st.audio === name ? channels[0] || null : st.audio;
  return { ...st, channels, audio };
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
    rects[mainIdx] = { x: 0, y: 0, w: 75, h: 100 };
    const h = 100 / (n - 1);
    let k = 0;
    for (let i = 0; i < n; i++) if (i !== mainIdx) rects[i] = { x: 75, y: k++ * h, w: 25, h };
    return rects;
  }

  if (layout === 'pip') {
    const rects = new Array(n);
    rects[mainIdx] = full;
    const w = 24, h = 24, gap = 1.5;
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
