// App-Log: sammelt Konsole, JS-Fehler, Stream-Startfehler, Diagnose und (in der Fire-TV-App)
// Absturzberichte und schickt sie automatisch an ntfy.sh. Ein GitHub-Workflow (app-logs.yml)
// holt sie von dort ab und legt sie im Branch "app-logs" ab, wo sie dauerhaft lesbar sind.
// Kein Schluessel noetig: ntfy-Themen sind offen, darum nie Zugangsdaten loggen (siehe scrub).

export const LOG_TOPIC = 'mv-applog-yk23bxfv09r4mzq1';
export const LOG_URL = 'https://ntfy.sh/' + LOG_TOPIC;
export const MAX_MSG = 3800; // ntfy nimmt bis 4096 Bytes als Text, groesser wird Anhang
const STORE_KEY = 'multiview-log-queue';
const DAY_KEY = 'multiview-log-day';
const MAX_QUEUE = 400; // Zeilen; aelteste fliegen raus
const MAX_LINE = 1200;
const DAILY_LIMIT = 180; // ntfy.sh erlaubt ohne Konto ca. 250 Nachrichten pro Tag und Anschluss
const FLUSH_MS = 60000;
const ERROR_FLUSH_MS = 4000;

// Zugangsdaten aus Text entfernen (Twitch-Tokens in URLs oder JSON).
export function scrub(text) {
  return String(text)
    .replace(/(access_token|refresh_token|id_token|client_secret|device_code|auth-token|auth_token|accessToken|refreshToken)(["']?\s*[=:]\s*["']?)[^&\s"',}]+/gi, '$1$2***')
    .replace(/(Bearer|OAuth)\s+[A-Za-z0-9._-]+/g, '$1 ***');
}

// Bytes eines Strings in UTF-8
const bytes = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length);

// Zeilen in Nachrichten <= max Bytes packen, jede mit Kopfzeile. Zu lange Zeilen werden gekuerzt.
export function chunk(header, lines, max = MAX_MSG) {
  const out = [];
  let cur = header;
  for (const raw of lines) {
    const line = bytes(header + '\n' + raw) > max ? raw.slice(0, Math.max(50, max - bytes(header) - 20)) + ' [gekuerzt]' : raw;
    if (cur !== header && bytes(cur + '\n' + line) > max) {
      out.push(cur);
      cur = header;
    }
    cur += '\n' + line;
  }
  if (cur !== header) out.push(cur);
  return out;
}

const fmt = (v) => {
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? '\n' + v.stack : ''}`;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};

export function createLogger({ storage, send, now = () => Date.now(), header = () => '', setTimer = setTimeout } = {}) {
  let queue = [];
  try { queue = JSON.parse(storage?.getItem(STORE_KEY) || '[]') || []; } catch { queue = []; }
  let dropped = 0;
  let timer = null;
  let timerAt = 0;
  let sending = false;
  let lastSent = 0;
  let lastError = '';
  let lastKey = '';
  let repeat = 1;
  let urgentPending = false;
  const save = () => {
    try { storage?.setItem(STORE_KEY, JSON.stringify(queue)); } catch {}
  };
  const daily = () => {
    const day = new Date(now()).toISOString().slice(0, 10);
    let d;
    try { d = JSON.parse(storage?.getItem(DAY_KEY) || 'null'); } catch {}
    if (!d || d.day !== day) d = { day, n: 0 };
    return d;
  };
  const schedule = (ms) => {
    const at = now() + ms;
    if (timer && timerAt <= at) return;
    if (timer) clearTimeout(timer);
    timerAt = at;
    timer = setTimer(() => {
      timer = null;
      flush();
    }, ms);
  };

  function add(type, ...args) {
    const t = new Date(now()).toISOString().slice(11, 23);
    let text = scrub(args.map(fmt).join(' '));
    if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE) + ' [gekuerzt]';
    const line = `${t} ${type.toUpperCase()} ${text}`;
    // gleiche Meldung in Schleife nicht 100x
    const key = type + ' ' + text;
    if (key === lastKey && queue.length) {
      repeat++;
      queue[queue.length - 1] = queue[queue.length - 1].replace(/ \(x\d+\)$/, '') + ` (x${repeat})`;
    } else {
      lastKey = key;
      repeat = 1;
      queue.push(line);
    }
    if (queue.length > MAX_QUEUE) {
      dropped += queue.length - MAX_QUEUE;
      queue = queue.slice(-MAX_QUEUE);
    }
    save();
    const urgent = type === 'error' || type === 'crash' || type === 'stream';
    if (urgent) {
      lastError = line;
      urgentPending = true;
    }
    schedule(urgent ? ERROR_FLUSH_MS : FLUSH_MS);
  }

  async function flush() {
    if (sending || !queue.length) return false;
    const d = daily();
    if (d.n >= DAILY_LIMIT) return false;
    sending = true;
    urgentPending = false;
    const lines = queue.slice();
    if (dropped) lines.unshift(`(${dropped} aeltere Zeilen verworfen)`);
    const parts = chunk(header(), lines).slice(0, Math.min(3, DAILY_LIMIT - d.n));
    let sentLines = 0;
    try {
      for (const p of parts) {
        await send(p);
        d.n++;
        sentLines += p.split('\n').length - 1;
      }
    } catch {
      // offline o.ae.: spaeter nochmal
    } finally {
      sending = false;
      try { storage?.setItem(DAY_KEY, JSON.stringify(d)); } catch {}
    }
    if (sentLines) {
      if (dropped) {
        dropped = 0;
        sentLines--;
      }
      queue = queue.slice(sentLines);
      lastKey = '';
      save();
      lastSent = now();
    }
    if (queue.length) schedule(urgentPending ? ERROR_FLUSH_MS : FLUSH_MS);
    return sentLines > 0;
  }

  return {
    add,
    flush,
    get pending() { return queue.length; },
    get lastSent() { return lastSent; },
    get lastError() { return lastError; },
  };
}

// ---------- im Browser: alles anschliessen ----------
function install() {
  const session = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  const call = (obj, name) => {
    try { return obj && typeof obj[name] === 'function' ? obj[name]() : ''; } catch { return ''; }
  };
  const device = call(window.MultiViewLog, 'device');
  const header = () => {
    const v = call(window.MultiViewApp, 'version');
    return `## ${device || navigator.userAgent} | ${v ? 'App ' + v : 'Browser'} | Sitzung ${session} | ${location.host}`;
  };
  // lokal (Entwicklung/Tests) nichts verschicken, ausser ein Test verlangt es
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && !window.mvLogForce;
  const send = (body) =>
    local ? Promise.reject(new Error('lokal')) : fetch(window.mvLogForce || LOG_URL, { method: 'POST', body, keepalive: body.length < 60000, mode: 'cors' }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
    });
  let storage = null;
  try { storage = window.localStorage; } catch {}
  const log = createLogger({ storage, send, header });
  window.mvLog = (type, ...args) => log.add(type, ...args);
  window.mvLogger = log;

  // Konsole mitschneiden (Original bleibt erhalten)
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level];
    console[level] = (...a) => {
      try { log.add(level === 'log' ? 'info' : level, ...a); } catch {}
      return orig.apply(console, a);
    };
  }
  window.addEventListener('error', (e) => {
    if (e.error || e.message) {
      log.add('error', e.error || e.message, e.filename ? `(${e.filename}:${e.lineno}:${e.colno})` : '');
    } else if (e.target && e.target !== window) {
      // Datei (Skript, Bild) konnte nicht laden
      log.add('error', 'Laden fehlgeschlagen:', e.target.src || e.target.href || e.target.tagName);
    }
  }, true);
  // Bedienung: jede Taste und jeder Klick mit dem, was gerade ausgewaehlt ist (Kachel = Streamer)
  const describe = (el) => {
    if (!el || el === document.body) return 'nichts ausgewaehlt';
    const tile = el.closest && el.closest('[data-channel]');
    if (tile) return 'Kachel ' + tile.dataset.channel;
    const txt = (el.textContent || el.value || '').trim().slice(0, 30);
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${txt ? ' "' + txt + '"' : ''}`;
  };
  document.addEventListener('keydown', (e) => log.add('key', e.key, '->', describe(document.activeElement)), true);
  document.addEventListener('click', (e) => log.add('click', describe(e.target)), true);
  // Zustand (Streamer-Liste, Hauptbild/Ton, Layout) steht im Link: jede Aenderung mitschreiben
  let lastQuery = location.search;
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...a) {
      const r = orig.apply(this, a);
      if (location.search !== lastQuery) {
        lastQuery = location.search;
        log.add('state', decodeURIComponent(location.search));
      }
      return r;
    };
  }
  window.addEventListener('unhandledrejection', (e) => log.add('error', 'Unbehandelt:', e.reason));
  window.addEventListener('online', () => log.add('info', 'Internet wieder da'));
  window.addEventListener('offline', () => log.add('warn', 'Internet weg'));
  // beim Verlassen schnell noch senden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) log.flush().catch(() => {});
  });

  // Absturz der Fire-TV-App beim letzten Mal (Java schreibt ihn in eine Datei)
  const crash = call(window.MultiViewLog, 'takeCrash');
  if (crash) log.add('crash', crash);
  log.add('info', 'Start', location.pathname + location.search);

  watchPlayers(log);
  // Diagnose-Werte (wie im Menue) alle 5 Minuten, solange die Seite sichtbar ist
  setInterval(() => {
    if (!document.hidden && typeof window.mvDiag === 'function') {
      try { log.add('diag', '\n' + window.mvDiag()); } catch {}
    }
  }, 5 * 60000);
}

// Jeder Twitch-Player meldet seine Ereignisse ins Log; spielt er nach 12 s nicht, ist das ein
// Stream-Startfehler (mit Diagnose). Haengt sich um window.Twitch.Player, app.js bleibt unveraendert.
function watchPlayers(log) {
  const T = window.Twitch;
  if (!T || typeof T.Player !== 'function') {
    log.add('warn', 'Twitch-Player-Skript nicht geladen');
    return;
  }
  const Orig = T.Player;
  const Wrapped = function (id, opts) {
    const p = new Orig(id, opts);
    try {
      const ch = (opts && opts.channel) || '?';
      const start = Date.now();
      const events = [];
      let playing = false;
      const sec = () => ((Date.now() - start) / 1000).toFixed(1) + 's';
      for (const key of ['READY', 'PLAY', 'PLAYING', 'PAUSE', 'ENDED', 'ONLINE', 'OFFLINE', 'PLAYBACK_BLOCKED']) {
        if (!Orig[key]) continue;
        p.addEventListener(Orig[key], () => {
          const name = key.toLowerCase();
          if (key === 'PLAYING') playing = true;
          events.push(sec() + ' ' + name);
          log.add(key === 'PLAYBACK_BLOCKED' ? 'warn' : 'player', ch, name, sec());
        });
      }
      log.add('player', ch, 'erstellt', opts && opts.muted ? 'stumm' : 'mit Ton');
      setTimeout(() => {
        if (playing || !document.getElementById(id)) return;
        if (document.hidden) return;
        let diag = '';
        try { diag = typeof window.mvDiag === 'function' ? '\n' + window.mvDiag() : ''; } catch {}
        log.add('stream', `${ch} spielt nach 12s nicht. Ereignisse: ${events.join(', ') || 'keine'}${diag}`);
      }, 12000);
    } catch {}
    return p;
  };
  for (const k of Object.getOwnPropertyNames(Orig)) {
    if (k === 'prototype' || k === 'length' || k === 'name' || k === 'caller' || k === 'arguments') continue;
    try { Wrapped[k] = Orig[k]; } catch {}
  }
  Wrapped.prototype = Orig.prototype;
  T.Player = Wrapped;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try { install(); } catch {}
}
