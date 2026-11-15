// App-Log: Unit-Tests fuer js/logger.js und ein Browser-Test, dass Fehler automatisch gesendet werden.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { scrub, chunk, createLogger } from '../js/logger.js';
import { startServer } from './serve.mjs';

const memStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

test('scrub removes tokens', () => {
  const s = scrub('https://x/#access_token=abc123&scope=x {"refresh_token":"zzz"} Authorization: Bearer qwe.rty');
  assert.ok(!s.includes('abc123') && !s.includes('zzz') && !s.includes('qwe.rty'), s);
  assert.ok(s.includes('scope=x'));
});

test('chunk keeps messages under the limit, each with header', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ` + 'x'.repeat(100));
  const parts = chunk('## head', lines, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.startsWith('## head\n'));
    assert.ok(new TextEncoder().encode(p).length <= 1000);
  }
  assert.equal(parts.join('\n').split('\n').filter((l) => l.startsWith('line ')).length, 50);
  const long = chunk('## h', ['y'.repeat(5000)], 1000);
  assert.ok(long[0].length <= 1000 && long[0].endsWith('[gekuerzt]'));
});

test('logger queues, dedupes, sends and keeps unsent lines', async () => {
  const sent = [];
  let fail = true;
  const timers = [];
  const storage = memStore();
  const log = createLogger({
    storage, header: () => '## dev',
    send: async (b) => { if (fail) throw new Error('offline'); sent.push(b); },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
  });
  log.add('info', 'hallo');
  const boom = new Error('boom');
  log.add('error', 'kaputt', boom);
  log.add('error', 'kaputt', boom);
  assert.equal(log.pending, 2);
  assert.equal(await log.flush(), false);
  assert.equal(log.pending, 2, 'nichts verloren wenn offline');
  // nach Neustart noch da
  const again = createLogger({ storage, header: () => '## dev', send: async (b) => sent.push(b), setTimer: () => 0 });
  assert.equal(again.pending, 2);
  fail = false;
  assert.equal(await log.flush(), true);
  assert.equal(log.pending, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^## dev\n.* INFO hallo\n.* ERROR kaputt Error: boom/);
  assert.match(sent[0], /\(x2\)/);
});

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
let server, browser, base;
before(async () => {
  server = await startServer(0);
  base = `http://localhost:${server.address().port}/`;
  if (chromium) browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  server.close();
});

test('page sends JS errors and a stuck stream automatically', { skip: !chromium && 'playwright missing' }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const posts = [];
  await page.addInitScript(() => { window.mvLogForce = 'https://ntfy.sh/test-topic'; localStorage.clear(); });
  await page.route('https://ntfy.sh/**', (r) => {
    posts.push(r.request().postData());
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  // Twitch-Player, der nie spielt
  await page.route('https://player.twitch.tv/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `
    window.Twitch = { Player: function (id, o) { const ev = {};
      return { addEventListener(n, cb) { ev[n] = cb; setTimeout(() => n === 'ready' && cb(), 10); }, setMuted() {}, setVolume() {},
        getMuted() { return o.muted; }, isPaused() { return true; }, play() {}, pause() {}, getQualities() { return []; },
        setQuality() {}, getQuality() { return 'auto'; } }; } };
    window.Twitch.Player.READY = 'ready'; window.Twitch.Player.PLAYING = 'playing';` }));
  await page.clock.install();
  await page.goto(base + '?c=alpha');
  await page.evaluate(() => setTimeout(() => { throw new Error('Testfehler 42'); }, 0));
  for (let i = 0; i < 40 && !posts.join('\n').includes('STREAM'); i++) {
    await page.clock.runFor(2000);
    await page.waitForTimeout(20);
  }
  const all = posts.join('\n');
  assert.match(all, /^## .* \| Browser \| Sitzung/m);
  assert.match(all, /ERROR .*Testfehler 42/);
  assert.match(all, /STREAM alpha spielt nach 12s nicht. Ereignisse: .*ready/);
  assert.match(all, /PLAYER alpha erstellt/);
  // Tasten und Zustand (Streamer) werden mitgeschrieben
  posts.length = 0;
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => history.replaceState(null, '', '?c=alpha,beta&a=beta'));
  await page.clock.runFor(70000);
  for (let i = 0; i < 20 && !posts.join('\n').includes('STATE'); i++) {
    await page.clock.runFor(2000);
    await page.waitForTimeout(20);
  }
  assert.match(posts.join('\n'), /KEY ArrowRight ->/);
  assert.match(posts.join('\n'), /STATE \?c=alpha,beta&a=beta/);
  // Knopf im Menue sendet Diagnose
  posts.length = 0;
  await page.evaluate(() => document.getElementById('sendLog').click());
  await page.clock.runFor(1000);
  await page.waitForFunction(() => /Zuletzt gesendet/.test(document.getElementById('logInfo').textContent));
  assert.match(posts.join('\n'), /DIAG Von Hand gesendet\nGeraet:/);
  await page.close();
});
