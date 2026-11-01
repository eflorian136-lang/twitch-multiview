// Pure logic: state <-> URL, channel validation, layouts, remote-control navigation.
export const LAYOUTS = ['grid', 'spotlight', 'pip', 'single'];
export const MAX_CHANNELS = 9;
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

// Lowest real quality id (e.g. "160p30") from player.getQualities() (objects or strings), or null.
export function lowestQuality(qualities) {
  if (!Array.isArray(qualities)) return null;
  let best = null, bestRes = Infinity;
  for (const q of qualities) {
    const name = typeof q === 'string' ? q : q && (q.group || q.name);
    if (!name || name === 'auto' || name === 'chunked' || name === 'audio_only') continue;
    const res = parseInt(String(name), 10);
    if (Number.isFinite(res) && res < bestRes) { bestRes = res; best = name; }
  }
  return best;
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
