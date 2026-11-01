import {
  LAYOUTS, sanitizeState, parseQuery, toQuery, addChannel, removeChannel, moveChannel, layoutRects, spatialNext,
} from './core.js';
import { TWITCH_CLIENT_ID } from './config.js';
import { createTwitch } from './twitch.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'multiview.state';
const stage = $('stage');
const tiles = new Map(); // channel -> { el, player, playerEl, rect }

// ---------- state ----------
function loadState() {
  const fromUrl = parseQuery(location.search);
  if (fromUrl) return fromUrl;
  try {
    return sanitizeState(JSON.parse(localStorage.getItem(STORE_KEY) || 'null'));
  } catch {
    return sanitizeState(null);
  }
}

let state = loadState();

function setState(next) {
  state = next;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
  history.replaceState(null, '', location.pathname + toQuery(state));
  render();
}

// ---------- players ----------
let playerSeq = 0;
function createPlayer(channel, container) {
  const muted = channel !== state.audio;
  if (window.Twitch && window.Twitch.Player) {
    const id = 'tw-player-' + ++playerSeq;
    container.id = id;
    const player = new window.Twitch.Player(id, {
      channel, parent: [location.hostname], width: '100%', height: '100%', muted, autoplay: true,
    });
    return player;
  }
  // Fallback if the embed script could not load: plain iframe (mute changes reload it)
  const f = document.createElement('iframe');
  const q = new URLSearchParams({ channel, parent: location.hostname, muted: String(muted), autoplay: 'true' });
  f.src = 'https://player.twitch.tv/?' + q;
  f.allow = 'autoplay; fullscreen';
  container.appendChild(f);
  return null;
}

function applyAudio() {
  for (const [ch, t] of tiles) {
    const on = ch === state.audio;
    t.el.classList.toggle('audio', on);
    if (t.player) {
      try {
        t.player.setMuted(!on);
        if (on) t.player.setVolume(1);
      } catch {}
    }
  }
}

// ---------- render ----------
function makeTile(channel) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.tabIndex = 0;
  el.dataset.channel = channel;
  const playerEl = document.createElement('div');
  playerEl.className = 'player';
  const cover = document.createElement('div');
  cover.className = 'cover';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = channel;
  el.append(playerEl, cover, label);
  cover.addEventListener('click', () => {
    el.focus();
    selectAudio(channel);
  });
  cover.addEventListener('dblclick', () => toggleSingle(channel));
  stage.appendChild(el); // never re-ordered: moving an iframe in the DOM would reload the stream
  return { el, playerEl, player: createPlayer(channel, playerEl), rect: null };
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
  applyAudio();

  let welcome = stage.querySelector('.welcome');
  if (!channels.length && !welcome) {
    welcome = document.createElement('div');
    welcome.className = 'welcome';
    welcome.textContent = 'Fuege im Menue Twitch-Kanaele hinzu.';
    stage.appendChild(welcome);
  } else if (channels.length && welcome) welcome.remove();

  renderMenu();
}

function renderMenu() {
  document.querySelectorAll('#layouts [data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === state.layout));
  const list = $('list');
  list.replaceChildren();
  $('empty').hidden = state.channels.length > 0;
  for (const ch of state.channels) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = ch;
    const mk = (text, fn, cls = '') => {
      const b = document.createElement('button');
      b.className = 'nav ' + cls;
      b.textContent = text;
      b.onclick = fn;
      return b;
    };
    li.append(
      name,
      mk(ch === state.audio ? 'Ton an' : 'Ton', () => selectAudio(ch), ch === state.audio ? 'active' : ''),
      mk('Hoch', () => setState(moveChannel(state, ch, -1))),
      mk('Runter', () => setState(moveChannel(state, ch, 1))),
      mk('Weg', () => setState(removeChannel(state, ch))),
    );
    list.appendChild(li);
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
  if (state.layout === 'single' && state.audio === ch) setState({ ...state, layout: layoutBeforeSingle });
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

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('channelInput');
  const { state: next, error } = addChannel(state, input.value);
  if (error) return msg(error);
  input.value = '';
  msg(`${next.channels[next.channels.length - 1]} hinzugefuegt`, true);
  setState(next);
});

document.querySelectorAll('#layouts [data-layout]').forEach((b) => {
  b.addEventListener('click', () => LAYOUTS.includes(b.dataset.layout) && setState({ ...state, layout: b.dataset.layout }));
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
  document.body.classList.add('menu-open');
  const first = state.channels.length ? document.querySelector('#layouts .active') : $('channelInput');
  (first || $('channelInput')).focus();
}
function closeMenu() {
  document.body.classList.remove('menu-open');
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

// ---------- remote control / keyboard ----------
const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const isMenuKey = (e) => e.key === 'ContextMenu' || e.key === 'Menu' || e.keyCode === 82 || e.keyCode === 93;

function navInMenu(dir) {
  const els = [...document.querySelectorAll('.menu .nav')].filter((el) => el.offsetParent !== null);
  const rects = els.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const from = els.indexOf(document.activeElement);
  if (from < 0) return els[0] && els[0].focus();
  const next = spatialNext(rects, from, dir);
  if (next >= 0) {
    els[next].focus();
    els[next].scrollIntoView({ block: 'nearest' });
  } else if (dir === 'right' && state.channels.length) closeMenu();
}

function navInStage(dir) {
  const chans = state.channels.filter((c) => tiles.get(c).rect);
  const current = chans.indexOf(document.activeElement && document.activeElement.dataset.channel);
  if (current < 0) return focusTile(state.audio);
  const next = spatialNext(chans.map((c) => tiles.get(c).rect), current, dir);
  if (next >= 0) tiles.get(chans[next]).el.focus();
  else if (dir === 'up' || dir === 'left') openMenu();
}

document.addEventListener('keydown', (e) => {
  if (isMenuKey(e) || (e.key === 'm' && document.activeElement.tagName !== 'INPUT')) {
    e.preventDefault();
    return menuOpen() ? closeMenu() : openMenu();
  }
  if (e.key === 'Escape' && menuOpen()) {
    e.preventDefault();
    return closeMenu();
  }
  const dir = DIRS[e.key];
  if (menuOpen()) {
    // inside the text field, left/right move the cursor
    if (dir && !(document.activeElement.tagName === 'INPUT' && (dir === 'left' || dir === 'right') && document.activeElement.value)) {
      e.preventDefault();
      navInMenu(dir);
    }
    return;
  }
  if (dir) {
    e.preventDefault();
    return navInStage(dir);
  }
  if (e.key === 'Enter' || e.key === ' ') {
    const ch = document.activeElement && document.activeElement.dataset.channel;
    if (ch) {
      e.preventDefault();
      if (state.audio === ch) toggleSingle(ch);
      else selectAudio(ch);
    }
  }
});

let mouseTimer;
const showPointerUi = () => {
  document.body.classList.add('mouse-active');
  clearTimeout(mouseTimer);
  mouseTimer = setTimeout(() => document.body.classList.remove('mouse-active'), 4000);
};
document.addEventListener('mousemove', showPointerUi);
document.addEventListener('touchstart', showPointerUi, { passive: true });

// ---------- live stream finder ----------
const twitch = createTwitch({ clientId: TWITCH_CLIENT_ID });
let currentTab = 'followed';
let devicePoll = null;

function setMain(ch) {
  let next = state;
  if (!next.channels.includes(ch)) {
    const r = addChannel(next, ch);
    if (r.error) return msg(r.error);
    next = r.state;
  }
  const layout = next.layout === 'grid' && next.channels.length > 1 ? 'spotlight' : next.layout;
  setState({ ...next, audio: ch, layout });
  msg(`${ch} ist jetzt das Hauptbild`, true);
}

function addCam(ch) {
  const r = addChannel(state, ch);
  if (r.error) return msg(r.error);
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

async function loadTab(tab) {
  currentTab = tab;
  renderFinder();
  $('finderMsg').textContent = 'Lade...';
  $('results').replaceChildren();
  try {
    if (tab === 'followed') renderResults(await twitch.followedLive(), 'Keiner deiner gefolgten Kanaele ist gerade live.');
    else if (tab === 'top') renderResults(await twitch.topLive('de'), 'Keine Streams gefunden.');
    else renderResults(await twitch.topLive(), 'Keine Streams gefunden.');
  } catch (e) {
    $('finderMsg').textContent = e.message;
    renderFinder();
  }
}

async function startLogin() {
  clearTimeout(devicePoll);
  try {
    const d = await twitch.startDeviceLogin();
    $('deviceBox').hidden = false;
    $('deviceCode').textContent = d.userCode;
    $('deviceUrl').textContent = (d.verificationUri || 'https://www.twitch.tv/activate').replace(/^https?:\/\/(www\.)?/, '').replace(/\?.*$/, '');
    let interval = d.interval * 1000;
    const deadline = Date.now() + (d.expiresIn || 1800) * 1000;
    const poll = async () => {
      if (Date.now() > deadline) {
        $('deviceBox').hidden = true;
        return msg('Code abgelaufen, bitte neu anmelden');
      }
      let res;
      try { res = await twitch.pollDeviceLogin(d.deviceCode); } catch { res = 'pending'; }
      if (res === 'done') {
        $('deviceBox').hidden = true;
        msg('Angemeldet' + (twitch.login ? ' als ' + twitch.login : ''), true);
        renderFinder();
        return loadTab('followed');
      }
      if (res === 'expired') {
        $('deviceBox').hidden = true;
        return msg('Anmeldung abgebrochen oder abgelaufen');
      }
      if (res === 'slow_down') interval += 5000;
      devicePoll = setTimeout(poll, interval);
    };
    devicePoll = setTimeout(poll, interval);
  } catch {
    // Device flow not reachable from this browser: fall back to normal Twitch login page
    location.href = twitch.implicitLoginUrl(location.origin + location.pathname);
  }
}

if (twitch.enabled) {
  $('loginBtn').addEventListener('click', startLogin);
  $('logoutBtn').addEventListener('click', () => {
    twitch.logout();
    renderResults([], '');
    renderFinder();
  });
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.addEventListener('click', () => loadTab(b.dataset.tab)));
  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('searchInput').value.trim();
    if (!q) return;
    currentTab = 'search';
    renderFinder();
    $('finderMsg').textContent = 'Suche...';
    try {
      renderResults(await twitch.search(q), 'Kein Live-Kanal gefunden.');
    } catch (e2) {
      $('finderMsg').textContent = e2.message;
      renderFinder();
    }
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

// Hooks for the Fire TV app (Android WebView calls these for the Menu and Back keys)
window.toggleMenu = () => (menuOpen() ? closeMenu() : openMenu());
window.handleBack = () => {
  if (menuOpen() && state.channels.length) {
    closeMenu();
    return 'handled';
  }
  if (state.layout === 'single') {
    setState({ ...state, layout: layoutBeforeSingle });
    return 'handled';
  }
  return 'exit';
};
