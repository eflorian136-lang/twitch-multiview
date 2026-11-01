import {
  LAYOUTS, MAX_CHANNELS, sanitizeState, parseQuery, toQuery, addChannel, addChannels, parseChannelList, removeChannel,
  moveChannel, layoutRects, spatialNext, pickQuality, QUALITIES, cropBox, cropPreset, adjustCrop, setCrop, CROP_STEP,
} from './core.js';
import { TWITCH_CLIENT_ID } from './config.js';
import { createTwitch } from './twitch.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'multiview.state';
const SYNC_KEY = 'multiview.autosync2'; // auto delay sync is off unless switched on
const stage = $('stage');
// channel -> { el, playerEl, player, iframe, rect, started, playing, quality, pausedByUs, audioOn, cropReady }
const tiles = new Map();

// ---------- state ----------
function loadState() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { stored = null; }
  const fromUrl = parseQuery(location.search);
  // Quality is a per-device setting (Fire TV vs. PC), so it is not part of the shared link.
  if (fromUrl) return stored ? sanitizeState({ ...fromUrl, qMain: stored.qMain, qSide: stored.qSide }) : fromUrl;
  return sanitizeState(stored);
}

let state = loadState();

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
  history.replaceState(null, '', location.pathname + toQuery(state));
}

// Cam crops are remembered per channel, so a streamer added again gets the same cam crop.
const CROPS_KEY = 'multiview.crops';
let savedCrops = (() => { try { return JSON.parse(localStorage.getItem(CROPS_KEY) || '{}') || {}; } catch { return {}; } })();
function rememberCrop(ch, crop) {
  if (crop) savedCrops[ch] = crop;
  else delete savedCrops[ch];
  try { localStorage.setItem(CROPS_KEY, JSON.stringify(savedCrops)); } catch {}
}

function setState(next) {
  for (const ch of next.channels) {
    if (!state.channels.includes(ch) && !next.crops[ch] && savedCrops[ch]) next = setCrop(next, ch, savedCrops[ch]);
  }
  for (const ch of Object.keys(next.crops)) if (next.crops[ch] !== savedCrops[ch]) rememberCrop(ch, next.crops[ch]);
  state = next;
  saveState();
  render();
}

// The main stream (with sound) is always shown whole; only the other cams show their crop.
const cropOf = (ch) => (ch !== state.audio ? state.crops[ch] : null);

// ---------- players ----------
// Twitch only autoplays a player that is visible (not hidden, not covered) and at least 400x300 px.
// So a player is created only once its tile is on screen and not covered by the menu, and nothing
// is placed on top of a player until it plays.
let playerSeq = 0;
const isTwitchApi = () => !!(window.Twitch && window.Twitch.Player);

function startPlayer(ch, t) {
  t.started = true;
  t.playerEl.replaceChildren();
  const muted = ch !== state.audio;
  t.audioOn = !muted;
  if (isTwitchApi()) {
    const id = 'tw-player-' + ++playerSeq;
    t.playerEl.id = id;
    try {
      t.player = new window.Twitch.Player(id, {
        channel: ch, parent: [location.hostname], width: '100%', height: '100%', muted, autoplay: true,
      });
    } catch {
      t.player = null;
    }
    if (t.player) {
      const P = window.Twitch.Player;
      const on = (name, fn) => { try { t.player.addEventListener(name, fn); } catch {} };
      on(P.READY || 'ready', () => {
        t.audioOn = undefined; // re-apply mute/volume now that the player listens
        applyAudioTile(ch, t);
        tunePlayer(ch);
        kickPlayer(ch, t, 0);
      });
      on(P.PLAYING || 'playing', () => {
        t.playing = true;
        t.el.classList.remove('stalled');
        if (!t.cropReady) {
          t.cropReady = true;
          layoutTile(ch);
        }
        tunePlayer(ch);
      });
      // If it does not start (offline, autoplay blocked), show the crop anyway after a while.
      setTimeout(() => {
        if (!t.cropReady && tiles.get(ch) === t) {
          t.cropReady = true;
          layoutTile(ch);
        }
        if (!t.playing && tiles.get(ch) === t) t.el.classList.add('stalled');
      }, 8000);
      // Twitch does not always autoplay (browser rules, its own checks): start it ourselves.
      for (const [i, ms] of [1500, 4000, 8000, 15000].entries()) setTimeout(() => kickPlayer(ch, t, i + 1), ms);
      return;
    }
  }
  // Fallback if the embed script could not load: plain iframe (a mute change reloads it)
  t.iframe = document.createElement('iframe');
  t.iframe.allow = 'autoplay; fullscreen';
  t.iframe.src = iframeSrc(ch, muted);
  t.playerEl.appendChild(t.iframe);
  t.cropReady = true;
  layoutTile(ch);
}

const shouldRun = (t) => !!t.rect && !document.hidden && !appHidden && !t.held;
const playerPaused = (t) => {
  try { return typeof t.player.isPaused === 'function' ? t.player.isPaused() : !t.playing; } catch { return false; }
};

// Starts a stream that stays paused. If the browser blocks sound without a click, the main stream
// starts muted; the next key press / click anywhere turns the sound back on.
function kickPlayer(ch, t, attempt) {
  if (tiles.get(ch) !== t || !t.player || !shouldRun(t) || !playerPaused(t)) return;
  try {
    if (attempt >= 2 && ch === state.audio && !t.autoMuted) {
      t.player.setMuted(true);
      t.autoMuted = true;
      t.el.classList.add('needs-sound');
    }
    t.player.play();
  } catch {}
}

// A real key press or click allows sound and playback: resume everything that should run.
function onUserGesture() {
  for (const [ch, t] of tiles) {
    if (!t.player || !t.started) continue;
    try {
      if (t.autoMuted && ch === state.audio) {
        t.player.setMuted(false);
        t.autoMuted = false;
        t.el.classList.remove('needs-sound');
      }
      if (shouldRun(t) && playerPaused(t)) {
        t.player.play();
        t.resumedAt = Date.now();
      }
    } catch {}
  }
}
document.addEventListener('keydown', onUserGesture, true);
document.addEventListener('pointerdown', onUserGesture, true);
window.addEventListener('blur', onUserGesture); // click into a player iframe

function iframeSrc(ch, muted) {
  const q = new URLSearchParams({ channel: ch, parent: location.hostname, muted: String(muted), autoplay: 'true' });
  return 'https://player.twitch.tv/?' + q;
}

const menuEl = $('menu');
function coveredByMenu(t) {
  if (!menuOpen()) return false;
  const m = menuEl.getBoundingClientRect();
  const r = t.el.getBoundingClientRect();
  return r.left < m.right - 1;
}

function startVisiblePlayers() {
  if (document.hidden || appHidden) return;
  for (const [ch, t] of tiles) if (!t.started && t.rect && !coveredByMenu(t)) startPlayer(ch, t);
}

// Saves CPU/bandwidth: main stream gets the main quality, side cams the side quality (cropped cams
// get enough resolution for their zoom), streams that are not visible or a hidden app are paused.
function tunePlayer(ch) {
  const t = tiles.get(ch);
  if (!t || !t.player) return;
  const p = t.player;
  try {
    const isPaused = () => (typeof p.isPaused === 'function' ? p.isPaused() : !!t.pausedByUs);
    if (!t.rect || document.hidden || appHidden) {
      if (!isPaused() || !t.pausedByUs) { p.pause(); t.pausedByUs = true; }
      return;
    }
    if (t.pausedByUs) { p.play(); t.pausedByUs = false; }
    let preset = ch === state.audio ? state.qMain : state.qSide;
    const crop = cropOf(ch);
    if (crop && preset !== 'auto') {
      // a cam crop is zoomed in: pick a quality that matches the zoomed picture height
      const h = (t.playerEl.offsetHeight || 0) * (window.devicePixelRatio || 1);
      const need = Math.min(1080, Math.round(h / 1.5));
      const limit = preset === 'min' ? 0 : Number(preset);
      if (need > limit) preset = String(need);
    }
    const want = pickQuality(p.getQualities && p.getQualities(), preset);
    // only set when our wish changed: setting the quality again makes the player re-buffer
    if (want && t.quality !== want) {
      p.setQuality(want);
      t.quality = want;
    }
  } catch {}
}

function applyAudioTile(ch, t) {
  const on = ch === state.audio;
  t.el.classList.toggle('audio', on);
  if (t.audioOn === on) return;
  t.audioOn = on;
  t.autoMuted = false;
  t.el.classList.remove('needs-sound');
  if (t.player) {
    try {
      t.player.setMuted(!on);
      if (on && !t.volumeSet) {
        t.player.setVolume(1);
        t.volumeSet = true;
      }
    } catch {}
  } else if (t.iframe) t.iframe.src = iframeSrc(ch, !on);
}

function applyAudio() {
  for (const [ch, t] of tiles) {
    if (t.started) applyAudioTile(ch, t);
    else t.el.classList.toggle('audio', ch === state.audio);
    tunePlayer(ch);
  }
}

// Pause everything while the page / Fire TV app is in the background.
let appHidden = false;
const retuneAll = () => {
  for (const ch of tiles.keys()) tunePlayer(ch);
  startVisiblePlayers();
};
document.addEventListener('visibilitychange', retuneAll);
window.setAppHidden = (hidden) => {
  appHidden = !!hidden;
  retuneAll();
};

// ---------- render ----------
function makeTile(channel) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.tabIndex = 0;
  el.dataset.channel = channel;
  const playerEl = document.createElement('div');
  playerEl.className = 'player';
  const wait = document.createElement('div');
  wait.className = 'wait';
  wait.textContent = 'Startet, sobald das Menue zu ist';
  playerEl.appendChild(wait);
  // Small bar (top right): only visible on hover / focus, so it never covers a starting player.
  const bar = document.createElement('div');
  bar.className = 'bar';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = channel;
  const btn = (text, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.tabIndex = -1;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  bar.append(
    label,
    btn('Ton', 'Ton / Hauptbild auf diesen Stream', () => selectAudio(channel)),
    btn('Gross', 'Nur diesen Stream zeigen (nochmal = zurueck)', () => toggleSingle(channel)),
    btn('Cam', 'Ausschnitt waehlen (nur die Kamera zeigen)', () => startCropEdit(channel)),
  );
  el.append(playerEl, bar);
  stage.appendChild(el); // never re-ordered: moving an iframe in the DOM would reload the stream
  return { el, playerEl, player: null, rect: null, started: false };
}

// Positions the player inside its tile: whole picture, or zoomed so only the cam region is visible.
function layoutTile(ch) {
  const t = tiles.get(ch);
  if (!t) return;
  const crop = cropOf(ch);
  const editing = cropEdit && cropEdit.ch === ch;
  const box = crop && t.cropReady && !editing ? cropBox(t.el.clientWidth, t.el.clientHeight, crop) : null;
  t.el.classList.toggle('cropped', !!box);
  if (box) {
    Object.assign(t.playerEl.style, {
      left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px',
    });
  } else t.playerEl.removeAttribute('style');
}

function render() {
  const { channels, layout, audio } = state;

  for (const [ch, t] of tiles) {
    if (!channels.includes(ch)) {
      t.el.remove();
      tiles.delete(ch);
    }
  }
  for (const ch of channels) if (!tiles.has(ch)) tiles.set(ch, makeTile(ch));

  const rects = layoutRects(layout, channels.length, channels.indexOf(audio));
  channels.forEach((ch, i) => {
    const t = tiles.get(ch);
    const r = rects[i];
    t.rect = r;
    t.el.classList.toggle('hidden-tile', !r);
    t.el.classList.toggle('pip-small', layout === 'pip' && ch !== audio && channels.length > 1);
    t.el.tabIndex = r ? 0 : -1;
    if (r) Object.assign(t.el.style, { left: r.x + '%', top: r.y + '%', width: r.w + '%', height: r.h + '%' });
  });
  for (const ch of channels) layoutTile(ch);
  if (cropEdit) renderCropEdit();
  applyAudio();
  startVisiblePlayers();

  let welcome = stage.querySelector('.welcome');
  if (!channels.length && !welcome) {
    welcome = document.createElement('div');
    welcome.className = 'welcome';
    welcome.textContent = 'Menue oeffnen und einen Twitch-Link einfuegen.';
    stage.appendChild(welcome);
  } else if (channels.length && welcome) welcome.remove();

  renderMenu();
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const ch of tiles.keys()) layoutTile(ch);
    if (cropEdit) renderCropEdit();
  }, 150);
});

function renderMenu() {
  document.querySelectorAll('#layouts [data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.layout));
  document.querySelectorAll('[data-qmain]').forEach((b) => b.classList.toggle('active', b.dataset.qmain === state.qMain));
  document.querySelectorAll('[data-qside]').forEach((b) => b.classList.toggle('active', b.dataset.qside === state.qSide));
  const list = $('list');
  // Remember which list button had focus so the remote does not lose its place after re-render.
  const act = document.activeElement;
  const prev = act && list.contains(act) ? { ch: act.closest('li').dataset.ch, act: act.dataset.act, idx: [...list.children].indexOf(act.closest('li')) } : null;
  list.replaceChildren();
  const n = state.channels.length;
  $('empty').hidden = n > 0;
  $('listHint').hidden = n < 1;
  $('camCount').textContent = n ? `${n} / ${MAX_CHANNELS}` : '';
  state.channels.forEach((ch, i) => {
    const main = ch === state.audio;
    const li = document.createElement('li');
    li.dataset.ch = ch;
    li.classList.toggle('main', main);
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i + 1;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = ch;
    const tags = [];
    if (main) tags.push('Hauptbild');
    if (state.crops[ch]) tags.push('nur Cam');
    for (const tg of tags) {
      const tag = document.createElement('small');
      tag.textContent = tg;
      name.appendChild(tag);
    }
    const mk = (text, actName, fn, { cls = '', disabled = false, label } = {}) => {
      const b = document.createElement('button');
      b.className = 'nav ' + cls;
      b.textContent = text;
      b.dataset.act = actName;
      b.disabled = disabled;
      if (label) b.setAttribute('aria-label', label);
      b.onclick = fn;
      return b;
    };
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.append(
      mk(main ? 'Hauptbild' : 'Als Hauptbild', 'main', () => selectAudio(ch), { cls: main ? 'active' : '', label: `${ch} als Hauptbild` }),
      mk('Nur Cam', 'crop', () => startCropEdit(ch), { cls: state.crops[ch] ? 'active' : '', label: `${ch}: Ausschnitt waehlen` }),
      mk('Hoch', 'up', () => setState(moveChannel(state, ch, -1)), { disabled: i === 0, label: `${ch} nach oben` }),
      mk('Runter', 'down', () => setState(moveChannel(state, ch, 1)), { disabled: i === n - 1, label: `${ch} nach unten` }),
      mk('Entfernen', 'remove', () => {
        setState(removeChannel(state, ch));
        msg(`${ch} entfernt`, true);
      }, { cls: 'danger', label: `${ch} entfernen` }),
    );
    li.append(num, name, acts);
    list.appendChild(li);
  });
  if (prev) {
    const items = [...list.children];
    const li = items.find((x) => x.dataset.ch === prev.ch) || items[Math.min(prev.idx, items.length - 1)];
    let target = li && li.querySelector(`[data-act="${prev.act}"]:not(:disabled)`);
    if (!target && li) target = li.querySelector('button:not(:disabled)');
    (target || $('channelInput')).focus();
  }
  $('shareLink').value = location.origin + location.pathname + toQuery(state);
}

// ---------- actions ----------
function selectAudio(ch) {
  if (!state.channels.includes(ch)) return;
  setState({ ...state, audio: ch });
}

let layoutBeforeSingle = 'grid';
function toggleSingle(ch) {
  if (state.layout === 'single' && state.audio === ch) setState({ ...state, layout: layoutBeforeSingle === 'single' ? 'grid' : layoutBeforeSingle });
  else {
    if (state.layout !== 'single') layoutBeforeSingle = state.layout;
    setState({ ...state, audio: ch, layout: 'single' });
  }
}

function msg(text, ok = false) {
  const m = $('msg');
  m.textContent = text;
  m.classList.toggle('ok', ok);
}

function addFromText(text) {
  const { state: next, added, errors } = addChannels(state, text);
  const parts = [];
  if (added.length) parts.push(`${added.join(', ')} hinzugefuegt`);
  parts.push(...errors);
  msg(parts.join('. '), added.length > 0 && !errors.length);
  if (added.length) {
    $('channelInput').value = '';
    updatePreview();
    setState(next);
  }
  return added.length > 0;
}

const PREVIEW_DEFAULT = $('preview').textContent;
function updatePreview() {
  const v = $('channelInput').value;
  const p = $('preview');
  if (!v.trim()) {
    p.textContent = PREVIEW_DEFAULT;
    p.className = 'hint';
    return;
  }
  const { channels, invalid } = parseChannelList(v);
  const t = [];
  if (channels.length) t.push('Erkannt: ' + channels.join(', '));
  if (invalid.length) t.push('Nicht erkannt: ' + invalid.join(', '));
  p.textContent = t.join(' | ');
  p.className = 'hint ' + (invalid.length || !channels.length ? 'bad' : 'good');
}

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  addFromText($('channelInput').value);
});
$('channelInput').addEventListener('input', updatePreview);
// Pasting a clean link into the empty field adds it right away.
$('channelInput').addEventListener('paste', (e) => {
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (!text || $('channelInput').value.trim()) return;
  const { channels, invalid } = parseChannelList(text);
  if (channels.length && !invalid.length) {
    e.preventDefault();
    addFromText(text);
  }
});
async function pasteFromClipboard() {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    msg('Zwischenablage nicht lesbar. Link ins Feld einfuegen.');
    return;
  }
  if (!addFromText(text)) {
    $('channelInput').value = text.trim();
    updatePreview();
  }
}
if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) {
  $('pasteBtn').hidden = false;
  $('pasteBtn').addEventListener('click', () => {
    pasteFromClipboard().catch(() => msg('Einfuegen fehlgeschlagen'));
  });
}

document.querySelectorAll('#layouts [data-layout]').forEach((b) => {
  b.addEventListener('click', () => {
    if (LAYOUTS.includes(b.dataset.layout)) setState({ ...state, layout: b.dataset.layout });
  });
});

document.querySelectorAll('[data-qmain]').forEach((b) => {
  b.addEventListener('click', () => {
    if (QUALITIES.includes(b.dataset.qmain)) setState({ ...state, qMain: b.dataset.qmain });
  });
});
document.querySelectorAll('[data-qside]').forEach((b) => {
  b.addEventListener('click', () => {
    if (QUALITIES.includes(b.dataset.qside)) setState({ ...state, qSide: b.dataset.qside });
  });
});

$('copyLink').addEventListener('click', async () => {
  const input = $('shareLink');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    try { document.execCommand('copy'); } catch {}
  }
  msg('Link kopiert', true);
});

// ---------- menu ----------
function openMenu() {
  if (cropEdit) finishCropEdit();
  document.body.classList.add('menu-open');
  const first = state.channels.length ? document.querySelector('#layouts .active') : $('channelInput');
  (first || $('channelInput')).focus();
  updateDelayInfo();
}
function closeMenu() {
  document.body.classList.remove('menu-open');
  startVisiblePlayers();
  focusTile(state.audio);
}
const menuOpen = () => document.body.classList.contains('menu-open');
$('openMenu').addEventListener('click', openMenu);
$('closeMenu').addEventListener('click', closeMenu);

function focusTile(ch) {
  const t = tiles.get(ch) || [...tiles.values()].find((x) => x.rect);
  if (t && t.rect) t.el.focus();
  else $('openMenu').focus();
}

// ---------- cam crop editor ----------
// Shows the whole stream of one cam big, with a frame for the region to keep.
// Remote: arrows move the frame, OK switches between moving and resizing, Back/Menu = done.
let cropEdit = null; // { ch, mode: 'move' | 'size', overlay }
const cropUi = $('cropEdit');

function startCropEdit(ch) {
  if (!state.channels.includes(ch)) return;
  document.body.classList.remove('menu-open');
  let next = state;
  if (!next.crops[ch]) next = setCrop(next, ch, cropPreset('bl', 30));
  if (!layoutRects(next.layout, next.channels.length, next.channels.indexOf(next.audio))[next.channels.indexOf(ch)]) {
    next = { ...next, layout: 'grid' }; // the cam must be visible to be edited
  }
  cropEdit = { ch, mode: 'move' };
  document.body.classList.add('crop-editing');
  tiles.get(ch) && tiles.get(ch).el.classList.add('editing');
  setState(next);
  cropUi.hidden = false;
  $('cropDone').focus();
}

function finishCropEdit() {
  if (!cropEdit) return;
  const { ch } = cropEdit;
  cropEdit = null;
  document.body.classList.remove('crop-editing');
  cropUi.hidden = true;
  const t = tiles.get(ch);
  if (t) t.el.classList.remove('editing');
  render();
  focusTile(ch);
  msg(state.crops[ch] ? `${ch}: nur Cam-Ausschnitt` : `${ch}: ganzes Bild`, true);
}

function renderCropEdit() {
  const t = tiles.get(cropEdit.ch);
  if (!t) {
    finishCropEdit();
    return;
  }
  t.el.classList.add('editing');
  const crop = state.crops[cropEdit.ch];
  const frame = $('cropFrame');
  // the editing tile fills the stage; the 16:9 picture is letterboxed inside
  const W = stage.clientWidth, H = stage.clientHeight;
  const vw = Math.min(W, (H * 16) / 9), vh = (vw * 9) / 16;
  const vx = (W - vw) / 2, vy = (H - vh) / 2;
  frame.hidden = !crop;
  if (crop) {
    Object.assign(frame.style, {
      left: vx + (crop[0] / 100) * vw + 'px', top: vy + (crop[1] / 100) * vh + 'px',
      width: (crop[2] / 100) * vw + 'px', height: (crop[2] / 100) * vh + 'px',
    });
  }
  $('cropMode').textContent = cropEdit.mode === 'move' ? 'Verschieben' : 'Groesse';
  cropEdit.video = { vx, vy, vw, vh };
}

function nudgeCrop(dir) {
  const step = CROP_STEP;
  const d = cropEdit.mode === 'move'
    ? { left: { dx: -step }, right: { dx: step }, up: { dy: -step }, down: { dy: step } }[dir]
    : { up: { ds: step }, right: { ds: step }, down: { ds: -step }, left: { ds: -step } }[dir];
  setState(setCrop(state, cropEdit.ch, adjustCrop(state.crops[cropEdit.ch], d)));
}

function toggleCropMode() {
  cropEdit.mode = cropEdit.mode === 'move' ? 'size' : 'move';
  renderCropEdit();
}

document.querySelectorAll('[data-corner]').forEach((b) => b.addEventListener('click', () => {
  if (!cropEdit) return;
  const cur = state.crops[cropEdit.ch];
  setState(setCrop(state, cropEdit.ch, cropPreset(b.dataset.corner, cur ? cur[2] : 30)));
}));
const resizeCrop = (ds) => {
  if (cropEdit) setState(setCrop(state, cropEdit.ch, adjustCrop(state.crops[cropEdit.ch], { ds })));
};
$('cropBigger').addEventListener('click', () => resizeCrop(CROP_STEP * 2));
$('cropSmaller').addEventListener('click', () => resizeCrop(-CROP_STEP * 2));
$('cropMode').addEventListener('click', () => {
  if (cropEdit) toggleCropMode();
});
$('cropWhole').addEventListener('click', () => {
  if (!cropEdit) return;
  rememberCrop(cropEdit.ch, null);
  state = setCrop(state, cropEdit.ch, null);
  saveState();
  finishCropEdit();
});
$('cropDone').addEventListener('click', finishCropEdit);

// mouse / touch: drag the frame, wheel = size
let drag = null;
const cropLayer = $('cropLayer');
cropLayer.addEventListener('pointerdown', (e) => {
  if (!cropEdit || !cropEdit.video || !state.crops[cropEdit.ch]) return;
  drag = { x: e.clientX, y: e.clientY, crop: state.crops[cropEdit.ch] };
  cropLayer.setPointerCapture(e.pointerId);
});
cropLayer.addEventListener('pointermove', (e) => {
  if (!drag || !cropEdit) return;
  const { vw, vh } = cropEdit.video;
  const dx = ((e.clientX - drag.x) / vw) * 100, dy = ((e.clientY - drag.y) / vh) * 100;
  state = setCrop(state, cropEdit.ch, adjustCrop(drag.crop, { dx, dy }));
  renderCropEdit();
});
const endDrag = () => {
  if (!drag) return;
  drag = null;
  setState(state);
};
cropLayer.addEventListener('pointerup', endDrag);
cropLayer.addEventListener('pointercancel', endDrag);
cropLayer.addEventListener('wheel', (e) => {
  if (!cropEdit) return;
  e.preventDefault();
  setState(setCrop(state, cropEdit.ch, adjustCrop(state.crops[cropEdit.ch], { ds: e.deltaY < 0 ? CROP_STEP : -CROP_STEP })));
}, { passive: false });

// ---------- delay sync ----------
// Every stream has its own delay (mostly set by the streamer's setup). Streams that are ahead are
// held back briefly so all run as late as the slowest one. Works only where the Twitch player
// reports its delay.
let autoSync = (() => { try { return localStorage.getItem(SYNC_KEY) === '1'; } catch { return false; } })();
let syncing = false;
let syncUnsupported = false;

function latencies() {
  const out = [];
  for (const [ch, t] of tiles) {
    if (!t.player || !t.playing || !t.rect || t.pausedByUs) continue;
    try {
      const s = typeof t.player.getPlaybackStats === 'function' && t.player.getPlaybackStats();
      const v = s && Number(s.hlsLatencyBroadcaster);
      if (Number.isFinite(v) && v > 0) out.push({ ch, t, lat: v });
    } catch {}
  }
  return out;
}

const spreadOf = (l) => (l.length < 2 ? 0 : Math.max(...l.map((x) => x.lat)) - Math.min(...l.map((x) => x.lat)));

function updateDelayInfo(extra = '') {
  const l = latencies();
  const txt = l.length
    ? l.map((x) => `${x.ch} ${x.lat.toFixed(1)} s`).join(', ') + (l.length > 1 ? ` | Unterschied ${spreadOf(l).toFixed(1)} s` : '')
    : 'Noch keine Werte (Streams muessen laufen).';
  $('delayInfo').textContent = txt + (extra ? ' | ' + extra : '');
  $('autoSync').classList.toggle('active', autoSync);
  $('autoSync').textContent = autoSync ? 'Automatisch: an' : 'Automatisch: aus';
}

async function syncDelays(manual) {
  if (syncing) return;
  const l = latencies();
  if (l.length < 2) {
    if (manual) updateDelayInfo('Angleichen geht erst, wenn mindestens zwei Streams laufen');
    return;
  }
  const before = spreadOf(l);
  if (before < 1 && manual) {
    updateDelayInfo('Schon gleich');
    return;
  }
  if (before < 1) return;
  syncing = true;
  const target = Math.max(...l.map((x) => x.lat));
  let longest = 0;
  for (const x of l) {
    const hold = target - x.lat;
    if (hold < 0.5) continue;
    longest = Math.max(longest, hold);
    x.t.held = true;
    try { x.t.player.pause(); } catch {}
    setTimeout(() => {
      x.t.held = false;
      try { if (!x.t.pausedByUs) x.t.player.play(); } catch {}
    }, hold * 1000);
  }
  await new Promise((r) => setTimeout(r, longest * 1000 + 5000));
  syncing = false;
  const after = spreadOf(latencies());
  if (after > before * 0.7 && after > 1) {
    // player jumped back to live instead of keeping the delay: do not try automatically again
    syncUnsupported = true;
    updateDelayInfo('Twitch-Player laesst sich hier nicht verzoegern');
  } else updateDelayInfo(`angeglichen (vorher ${before.toFixed(1)} s)`);
}

$('syncNow').addEventListener('click', () => {
  syncDelays(true).catch(() => {});
});
$('autoSync').addEventListener('click', () => {
  autoSync = !autoSync;
  try { localStorage.setItem(SYNC_KEY, autoSync ? '1' : '0'); } catch {}
  updateDelayInfo();
});
setInterval(() => {
  if (menuOpen()) updateDelayInfo();
  if (autoSync && !syncUnsupported && !document.hidden && !appHidden && !cropEdit) syncDelays(false).catch(() => {});
}, 20000);

// ---------- remote control / keyboard ----------
const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
// keyCode 82 is the Android menu key in some browsers, but also the letter R: only count it without a letter
const isMenuKey = (e) => e.key === 'ContextMenu' || e.key === 'Menu' || e.keyCode === 93
  || (e.keyCode === 82 && (!e.key || e.key.length !== 1));
const typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
};

function navInMenu(dir) {
  const els = [...document.querySelectorAll('.menu .nav')].filter((el) => el.offsetParent !== null && !el.disabled);
  const rects = els.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const from = els.indexOf(document.activeElement);
  if (from < 0) {
    if (els[0]) els[0].focus();
    return;
  }
  const next = spatialNext(rects, from, dir);
  if (next >= 0) {
    els[next].focus();
    els[next].scrollIntoView({ block: 'nearest' });
  } else if (dir === 'right' && state.channels.length) closeMenu();
}

function navInStage(dir) {
  const chans = state.channels.filter((c) => tiles.get(c).rect);
  const current = chans.indexOf(document.activeElement && document.activeElement.dataset.channel);
  if (current < 0) {
    focusTile(state.audio);
    return;
  }
  const next = spatialNext(chans.map((c) => tiles.get(c).rect), current, dir);
  if (next >= 0) tiles.get(chans[next]).el.focus();
  else if (dir === 'up' || dir === 'left') openMenu();
}

document.addEventListener('keydown', (e) => {
  const dir = DIRS[e.key];
  if (cropEdit) {
    const inBar = cropUi.contains(document.activeElement);
    if (dir && !inBar) {
      e.preventDefault();
      nudgeCrop(dir);
      return;
    }
    if (dir && inBar && (dir === 'up' || dir === 'down')) {
      // up/down leaves the button bar and edits the frame again
      e.preventDefault();
      document.activeElement.blur();
      nudgeCrop(dir);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && !inBar) {
      e.preventDefault();
      toggleCropMode();
      return;
    }
    if (e.key === 'Escape' || isMenuKey(e)) {
      e.preventDefault();
      finishCropEdit();
      return;
    }
    return;
  }
  if (isMenuKey(e) || (e.key === 'm' && !typing())) {
    e.preventDefault();
    if (menuOpen()) closeMenu();
    else openMenu();
    return;
  }
  if (e.key === 'Escape' && menuOpen()) {
    e.preventDefault();
    closeMenu();
    return;
  }
  if (menuOpen()) {
    // inside the text field, left/right move the cursor
    if (dir && !(typing() && (dir === 'left' || dir === 'right') && document.activeElement.value)) {
      e.preventDefault();
      navInMenu(dir);
    }
    return;
  }
  if (dir) {
    e.preventDefault();
    navInStage(dir);
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    const ch = document.activeElement && document.activeElement.dataset.channel;
    if (ch) {
      e.preventDefault();
      const t = tiles.get(ch);
      if (t && t.resumedAt && Date.now() - t.resumedAt < 300) return; // this OK just started the paused stream
      if (state.audio === ch) toggleSingle(ch);
      else selectAudio(ch);
    }
  }
});

// Clicking into a Twitch player moves focus into its iframe: mark that tile as the current one.
window.addEventListener('blur', () => {
  setTimeout(() => {
    const a = document.activeElement;
    if (a && a.tagName === 'IFRAME') {
      const tile = a.closest('.tile');
      document.querySelectorAll('.tile.active-frame').forEach((x) => x !== tile && x.classList.remove('active-frame'));
      if (tile) tile.classList.add('active-frame');
    }
  }, 0);
});
window.addEventListener('focus', () => document.querySelectorAll('.tile.active-frame').forEach((x) => x.classList.remove('active-frame')));

let mouseTimer;
let lastPointer = 0;
const showPointerUi = () => {
  const now = Date.now();
  if (now - lastPointer < 500) return; // mousemove fires very often; once per 0.5 s is enough
  lastPointer = now;
  document.body.classList.add('mouse-active');
  clearTimeout(mouseTimer);
  mouseTimer = setTimeout(() => document.body.classList.remove('mouse-active'), 4000);
};
document.addEventListener('mousemove', showPointerUi);
document.addEventListener('touchstart', showPointerUi, { passive: true });
// Mouse over a player does not reach this page; entering a tile still shows the menu button.
stage.addEventListener('mouseover', showPointerUi);

// ---------- live stream finder ----------
const twitch = createTwitch({ clientId: TWITCH_CLIENT_ID });
let currentTab = 'followed';
let devicePoll = null;
let loginRun = 0;
let finderRun = 0;

function setMain(ch) {
  let next = state;
  if (!next.channels.includes(ch)) {
    const r = addChannel(next, ch);
    if (r.error) {
      msg(r.error);
      return;
    }
    next = r.state;
  }
  const layout = next.layout === 'grid' && next.channels.length > 1 ? 'spotlight' : next.layout;
  setState({ ...next, audio: ch, layout });
  msg(`${ch} ist jetzt das Hauptbild`, true);
}

function addCam(ch) {
  const r = addChannel(state, ch);
  if (r.error) {
    msg(r.error);
    return;
  }
  setState({ ...r.state, audio: state.audio || ch });
  msg(`${ch} dazugefuegt`, true);
}

function renderFinder() {
  $('finder').hidden = !twitch.enabled;
  if (!twitch.enabled) return;
  $('loginBox').hidden = twitch.loggedIn;
  $('finderBox').hidden = !twitch.loggedIn;
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
}

function renderResults(list, emptyText) {
  const ul = $('results');
  ul.replaceChildren();
  $('finderMsg').textContent = list.length ? '' : emptyText;
  for (const s of list) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    if (s.thumb) img.src = s.thumb;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = s.name;
    const g = document.createElement('span');
    g.textContent = [s.game, s.viewers != null ? `${s.viewers.toLocaleString('de-DE')} Zuschauer` : ''].filter(Boolean).join(' - ');
    const t = document.createElement('span');
    t.textContent = s.title || '';
    meta.append(b, g, t);
    const acts = document.createElement('div');
    acts.className = 'acts';
    const main = document.createElement('button');
    main.className = 'nav primary';
    main.textContent = 'Hauptbild';
    main.onclick = () => setMain(s.login);
    const add = document.createElement('button');
    add.className = 'nav';
    add.textContent = 'Als Cam dazu';
    add.onclick = () => addCam(s.login);
    acts.append(main, add);
    li.append(img, meta, acts);
    ul.appendChild(li);
  }
}

// Shows an API error; if the login expired, the login box comes back with the message.
function finderError(e) {
  renderFinder();
  if (twitch.loggedIn) $('finderMsg').textContent = e.message;
  else msg(e.message);
}

async function loadTab(tab) {
  const run = ++finderRun; // a slower older request must not overwrite a newer tab
  currentTab = tab;
  renderFinder();
  $('finderMsg').textContent = 'Lade...';
  $('results').replaceChildren();
  try {
    let list, empty = 'Keine Streams gefunden.';
    if (tab === 'followed') {
      list = await twitch.followedLive();
      empty = 'Keiner deiner gefolgten Kanaele ist gerade live.';
    } else list = await twitch.topLive(tab === 'top' ? 'de' : undefined);
    if (run === finderRun) renderResults(list, empty);
  } catch (e) {
    if (run === finderRun) finderError(e);
  }
}

async function startLogin() {
  clearTimeout(devicePoll);
  const run = ++loginRun; // a second click stops the first polling loop
  try {
    const d = await twitch.startDeviceLogin();
    if (run !== loginRun) return;
    $('deviceBox').hidden = false;
    $('deviceCode').textContent = d.userCode;
    $('deviceUrl').textContent = (d.verificationUri || 'https://www.twitch.tv/activate').replace(/^https?:\/\/(www\.)?/, '').replace(/\?.*$/, '');
    let interval = d.interval * 1000;
    const deadline = Date.now() + (d.expiresIn || 1800) * 1000;
    const poll = async () => {
      if (run !== loginRun) return;
      if (Date.now() > deadline) {
        $('deviceBox').hidden = true;
        msg('Code abgelaufen, bitte neu anmelden');
        return;
      }
      let res;
      try { res = await twitch.pollDeviceLogin(d.deviceCode); } catch { res = 'pending'; }
      if (run !== loginRun) return;
      if (res === 'done') {
        $('deviceBox').hidden = true;
        msg('Angemeldet' + (twitch.login ? ' als ' + twitch.login : ''), true);
        renderFinder();
        return loadTab('followed');
      }
      if (res === 'expired') {
        $('deviceBox').hidden = true;
        msg('Anmeldung abgebrochen oder abgelaufen');
        return;
      }
      if (res === 'slow_down') interval += 5000;
      devicePoll = setTimeout(poll, interval);
    };
    devicePoll = setTimeout(poll, interval);
  } catch {
    if (run !== loginRun) return;
    // Device flow not reachable from this browser: fall back to normal Twitch login page
    location.href = twitch.implicitLoginUrl(location.origin + location.pathname);
  }
}

if (twitch.enabled) {
  $('loginBtn').addEventListener('click', () => {
    startLogin().catch(() => {});
  });
  $('logoutBtn').addEventListener('click', () => {
    loginRun++;
    clearTimeout(devicePoll);
    twitch.logout();
    renderResults([], '');
    renderFinder();
  });
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
    loadTab(b.dataset.tab).catch(() => {});
  }));
  const search = async (q) => {
    const run = ++finderRun;
    currentTab = 'search';
    renderFinder();
    $('finderMsg').textContent = 'Suche...';
    try {
      const list = await twitch.search(q);
      if (run === finderRun) renderResults(list, 'Kein Live-Kanal gefunden.');
    } catch (e2) {
      if (run === finderRun) finderError(e2);
    }
  };
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('searchInput').value.trim();
    if (q) search(q).catch(() => {});
  });
  if (location.hash.includes('access_token=')) {
    twitch.finishImplicitLogin(location.hash).then(() => {
      history.replaceState(null, '', location.pathname + toQuery(state));
      renderFinder();
      loadTab('followed');
      openMenu();
    }).catch((e) => msg(e.message));
  } else if (twitch.loggedIn) loadTab('followed');
}
renderFinder();

// ---------- Fire TV app bridge ----------
if (window.MultiViewApp) {
  $('appBox').hidden = false;
  try { $('appVersion').textContent = 'App-Version ' + window.MultiViewApp.version(); } catch {}
  $('appUpdate').addEventListener('click', () => window.MultiViewApp.checkUpdate());
}

// ---------- start ----------
history.replaceState(null, '', location.pathname + toQuery(state));
render();
if (!state.channels.length) openMenu();
else focusTile(state.audio);
updateDelayInfo();

// Hooks for the Fire TV app (Android WebView calls these for the Menu and Back keys)
window.toggleMenu = () => {
  if (cropEdit) {
    finishCropEdit();
    return;
  }
  if (menuOpen()) closeMenu();
  else openMenu();
};
window.handleBack = () => {
  if (cropEdit) {
    finishCropEdit();
    return 'handled';
  }
  if (menuOpen() && state.channels.length) {
    closeMenu();
    return 'handled';
  }
  if (state.layout === 'single' && state.channels.length > 1) {
    setState({ ...state, layout: layoutBeforeSingle === 'single' ? 'grid' : layoutBeforeSingle });
    return 'handled';
  }
  return 'exit';
};
