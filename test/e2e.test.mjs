// Browser test: real page in Chromium, Twitch embed script replaced by a stub
// that records muted state per channel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './serve.mjs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {}

const STUB = `
window.__players = {};
window.Twitch = { Player: function (id, o) {
  const el = document.getElementById(id);
  const f = document.createElement('div'); f.className = 'stub'; f.textContent = o.channel; el.appendChild(f);
  const p = { channel: o.channel, muted: o.muted, parent: o.parent, quality: null, paused: false, ev: {},
    setMuted(m) { this.muted = m; }, setVolume() {},
    addEventListener(n, cb) { this.ev[n] = cb; },
    getQualities() { return [{ name: 'Auto', group: 'auto' }, { name: '1080p60', group: 'chunked' }, { name: '480p', group: '480p30' }, { name: '160p', group: '160p30' }]; },
    setQuality(q) { this.quality = q; }, getQuality() { return this.quality; }, isPaused() { return this.paused; },
    pause() { this.paused = true; }, play() { this.paused = false; } };
  window.__players[o.channel] = p;
  return p;
} };
window.Twitch.Player.READY = 'ready';
window.Twitch.Player.PLAYING = 'playing';
`;

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

async function open(path = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://player.twitch.tv/**', (r) =>
    r.request().url().includes('embed/v1.js') ? r.fulfill({ contentType: 'text/javascript', body: STUB }) : r.fulfill({ body: '' }),
  );
  await page.goto(base + path);
  return { page, errors };
}

const muted = (page) => page.evaluate(() => Object.fromEntries(Object.entries(window.__players).map(([k, v]) => [k, v.muted])));

test('empty start opens menu, adding channels updates URL and players', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open();
  assert.ok(await page.evaluate(() => document.body.classList.contains('menu-open')));
  for (const c of ['alpha', 'https://www.twitch.tv/Beta', 'gamma']) {
    await page.fill('#channelInput', c);
    await page.press('#channelInput', 'Enter');
  }
  assert.equal(await page.locator('.tile').count(), 3);
  assert.match(page.url(), /\?c=alpha,beta,gamma$/);
  // players under the open menu are not started yet (Twitch does not autoplay covered players)
  const started = await page.evaluate(() => Object.keys(window.__players));
  assert.ok(!started.includes('alpha'), 'alpha is covered by the menu: ' + started);
  await page.keyboard.press('Escape');
  assert.deepEqual(await muted(page), { alpha: false, beta: true, gamma: true });
  await page.keyboard.press('m');
  const parent = await page.evaluate(() => window.__players.alpha.parent);
  assert.deepEqual(parent, ['localhost']);

  await page.fill('#channelInput', 'not-valid!');
  await page.press('#channelInput', 'Enter');
  assert.match(await page.textContent('#msg'), /Kein Twitch-Kanal: not-valid!/);
  assert.equal(await page.locator('.tile').count(), 3);
  assert.deepEqual(errors, []);
});

test('remote control: arrows move focus, OK switches audio, OK again = fullscreen', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open('?c=a1,b2,c3,d4');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.channel), 'a1');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.channel), 'b2');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.channel), 'd4');
  await page.keyboard.press('Enter');
  assert.deepEqual(await muted(page), { a1: true, b2: true, c3: true, d4: false });
  assert.match(page.url(), /a=d4/);

  await page.keyboard.press('Enter'); // second OK -> single layout
  assert.match(page.url(), /l=single/);
  const hidden = await page.locator('.tile.hidden-tile').count();
  assert.equal(hidden, 3);
  await page.keyboard.press('Enter'); // back to grid
  assert.doesNotMatch(page.url(), /l=single/);

  // ArrowUp from top row opens the menu, ArrowRight at the edge closes it again
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.ok(await page.evaluate(() => document.body.classList.contains('menu-open')));
  await page.keyboard.press('Escape');
  assert.ok(!(await page.evaluate(() => document.body.classList.contains('menu-open'))));
  assert.deepEqual(errors, []);
});

test('layouts and persistence across reload', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open('?c=x1,x2,x3&l=spotlight&a=x2');
  const box = await page.locator('.tile[data-channel="x2"]').boundingBox();
  assert.ok(Math.abs(box.width - 960) < 2, 'spotlight main tile is 75% wide: ' + box.width);

  await page.keyboard.press('m');
  await page.click('#layouts [data-layout="pip"]');
  const small = await page.locator('.tile[data-channel="x1"]').boundingBox();
  assert.ok(small.width < 400);

  await page.click('#list li:first-child button:has-text("Entfernen")');
  assert.equal(await page.locator('.tile').count(), 2);

  await page.goto(base); // no query -> restore from localStorage
  assert.match(page.url(), /\?c=x2,x3&l=pip$/);
  assert.equal(await page.locator('.tile').count(), 2);
  assert.deepEqual(errors, []);
});

test('stream finder: device login, pick main stream and add cams', { skip: !chromium && 'playwright missing' }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "export const TWITCH_CLIENT_ID = 'testid';" }));
  await page.route('https://player.twitch.tv/**', (r) =>
    r.request().url().includes('embed/v1.js') ? r.fulfill({ contentType: 'text/javascript', body: STUB }) : r.fulfill({ body: '' }),
  );
  const json = (b, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
  await page.route('https://id.twitch.tv/oauth2/device', (r) => r.fulfill(json({ device_code: 'dc', user_code: 'TVCODE12', verification_uri: 'https://www.twitch.tv/activate', interval: 1, expires_in: 60 })));
  await page.route('https://id.twitch.tv/oauth2/token', (r) => r.fulfill(json({ access_token: 'at', refresh_token: 'rt', expires_in: 9999 })));
  await page.route('https://api.twitch.tv/helix/**', (r) => {
    const u = r.request().url();
    if (u.includes('/users')) return r.fulfill(json({ data: [{ id: '1', login: 'viewer' }] }));
    const s = (l) => ({ user_login: l, user_name: l.toUpperCase(), title: 'Titel ' + l, game_name: 'Just Chatting', viewer_count: 1234, thumbnail_url: '' });
    if (u.includes('/streams/followed')) return r.fulfill(json({ data: [s('freund1'), s('freund2')] }));
    if (u.includes('/streams')) return r.fulfill(json({ data: [s('topde1'), s('topde2'), s('topde3')] }));
    return r.fulfill(json({ data: [] }));
  });
  await page.route('https://static-cdn.jtvnw.net/**', (r) => r.fulfill({ body: '' }));
  await page.goto(base);

  await page.click('#loginBtn');
  await page.waitForSelector('#deviceCode:has-text("TVCODE12")');
  await page.waitForSelector('#results li', { timeout: 5000 });
  assert.equal(await page.locator('#results li').count(), 2);

  await page.click('#tabs [data-tab="top"]');
  await page.waitForSelector('#results li:has-text("TOPDE3")');
  await page.click('#results li:has-text("TOPDE2") button:has-text("Hauptbild")');
  await page.click('#results li:has-text("TOPDE1") button:has-text("Als Cam dazu")');
  await page.click('#results li:has-text("TOPDE3") button:has-text("Als Cam dazu")');
  assert.match(page.url(), /c=topde2,topde1,topde3/);
  await page.click('#closeMenu');
  await page.keyboard.press('m');
  // main stream keeps sound
  assert.deepEqual(await muted(page), { topde2: false, topde1: true, topde3: true });

  // switching main to a cam that is already in -> spotlight on it
  await page.click('#results li:has-text("TOPDE3") button:has-text("Hauptbild")');
  assert.match(page.url(), /l=spotlight&a=topde3/);
  await page.waitForFunction(() => Math.abs(document.querySelector('.tile[data-channel="topde3"]').getBoundingClientRect().width - 960) < 2, null, { timeout: 2000 });

  // remote: from the search field, down arrow reaches result buttons
  await page.focus('#searchInput');
  await page.keyboard.press('ArrowDown');
  const tag = await page.evaluate(() => document.activeElement.closest('#results, #searchForm') && document.activeElement.textContent);
  assert.ok(tag, 'focus moved within finder');
  assert.deepEqual(errors, []);
});

test('app bridge: update button only inside the Fire TV app', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open('?c=a1');
  assert.equal(await page.locator('#appBox').isHidden(), true);
  await page.addInitScript(() => { window.__checks = 0; window.MultiViewApp = { version: () => 7, checkUpdate: () => window.__checks++ }; });
  await page.reload();
  await page.keyboard.press('m');
  assert.match(await page.textContent('#appVersion'), /7/);
  await page.click('#appUpdate');
  assert.equal(await page.evaluate(() => window.__checks), 1);
  assert.deepEqual(errors, []);
});

test('paste several Twitch links at once, preview and clean cam list', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open();
  await page.fill('#channelInput', 'https://m.twitch.tv/Eins?sr=a twitch.tv/popout/zwei/chat');
  assert.match(await page.textContent('#preview'), /Erkannt: eins, zwei/);
  await page.press('#channelInput', 'Enter');
  assert.match(page.url(), /\?c=eins,zwei$/);
  assert.equal(await page.inputValue('#channelInput'), '');
  assert.match(await page.textContent('#msg'), /eins, zwei hinzugefuegt/);

  // pasting a clean link into the empty field adds it immediately
  await page.focus('#channelInput');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'https://www.twitch.tv/drei/videos');
    document.getElementById('channelInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  assert.match(page.url(), /\?c=eins,zwei,drei$/);
  assert.equal(await page.textContent('#camCount'), '3 / 9');
  assert.match(await page.textContent('#list li.main'), /eins/);

  // list: first "Hoch" and last "Runter" are disabled; set main; focus stays in list after remove
  assert.ok(await page.locator('#list li:nth-child(1) [data-act="up"]').isDisabled());
  assert.ok(await page.locator('#list li:nth-child(3) [data-act="down"]').isDisabled());
  await page.click('#list li:nth-child(3) [data-act="main"]');
  assert.match(page.url(), /a=drei/);
  await page.focus('#list li:nth-child(1) [data-act="remove"]');
  await page.keyboard.press('Enter');
  assert.match(page.url(), /\?c=zwei,drei/);
  assert.equal(await page.evaluate(() => document.activeElement.closest('li') && document.activeElement.closest('li').dataset.ch), 'zwei');
  assert.deepEqual(errors, []);
});

test('performance: side cams lowest quality, hidden streams paused', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open('?c=p1,p2,p3');
  await page.evaluate(() => Object.values(window.__players).forEach((p) => p.ev.playing && p.ev.playing()));
  const q = () => page.evaluate(() => Object.fromEntries(Object.entries(window.__players).map(([k, v]) => [k, [v.quality, v.paused]])));
  assert.deepEqual(await q(), { p1: ['auto', false], p2: ['160p30', false], p3: ['160p30', false] });

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter'); // p2 main
  assert.deepEqual(await q(), { p1: ['160p30', false], p2: ['auto', false], p3: ['160p30', false] });

  await page.keyboard.press('Enter'); // single -> others paused
  assert.deepEqual(await q(), { p1: ['160p30', true], p2: ['auto', false], p3: ['160p30', true] });
  await page.keyboard.press('Enter'); // back -> resumed
  assert.deepEqual(await q(), { p1: ['160p30', false], p2: ['auto', false], p3: ['160p30', false] });
  assert.deepEqual(errors, []);
});

test('quality can be chosen per main stream and side cams, kept on this device', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open('?c=q1,q2');
  const fire = () => page.evaluate(() => Object.values(window.__players).forEach((p) => p.ev.playing && p.ev.playing()));
  const q = () => page.evaluate(() => Object.fromEntries(Object.entries(window.__players).map(([k, v]) => [k, v.quality])));
  await fire();
  assert.deepEqual(await q(), { q1: 'auto', q2: '160p30' });
  await page.keyboard.press('m');
  await page.click('[data-qmain="1080"]');
  await page.click('[data-qside="480"]');
  assert.deepEqual(await q(), { q1: 'chunked', q2: '480p30' });
  assert.ok(await page.locator('[data-qmain="1080"]').evaluate((b) => b.classList.contains('active')));
  assert.doesNotMatch(page.url(), /qMain|qSide/);

  // a shared link opened on this device keeps the device quality
  await page.goto(base + '?c=q3');
  await fire();
  assert.deepEqual(await q(), { q3: 'chunked' });
  assert.deepEqual(errors, []);
});

test('app in background pauses all streams, resumes when back', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open('?c=h1,h2');
  const paused = () => page.evaluate(() => Object.fromEntries(Object.entries(window.__players).map(([k, v]) => [k, v.paused])));
  await page.evaluate(() => window.setAppHidden(true));
  assert.deepEqual(await paused(), { h1: true, h2: true });
  await page.evaluate(() => window.setAppHidden(false));
  assert.deepEqual(await paused(), { h1: false, h2: false });
  assert.deepEqual(errors, []);
});

test('typing r or m into the channel field does not close the menu', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open();
  await page.click('#channelInput');
  await page.keyboard.type('marcrr');
  assert.equal(await page.inputValue('#channelInput'), 'marcrr');
  assert.ok(await page.evaluate(() => document.body.classList.contains('menu-open')));
  assert.deepEqual(errors, []);
});

test('hidden streams stay paused even when the player becomes ready later', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open('?c=s1,s2,s3');
  await page.keyboard.press('Enter'); // s1 already main -> single
  await page.evaluate(() => {
    for (const p of Object.values(window.__players)) { p.paused = false; p.ev.ready && p.ev.ready(); p.ev.playing && p.ev.playing(); }
  });
  const paused = await page.evaluate(() => Object.fromEntries(Object.entries(window.__players).map(([k, v]) => [k, v.paused])));
  assert.deepEqual(paused, { s1: false, s2: true, s3: true });
  // not visible at start = not started at all
  const p2 = await open('?c=t1,t2&l=single');
  assert.deepEqual(await p2.page.evaluate(() => Object.keys(window.__players)), ['t1']);
  assert.deepEqual(errors, []);
  assert.deepEqual(p2.errors, []);
});

test('nothing covers a player: no overlay element on top of the stream', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open('?c=o1,o2&l=spotlight');
  const covered = await page.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => {
    const r = t.querySelector('.player').getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return t.querySelector('.player').contains(el);
  }));
  assert.deepEqual(covered, [true, true]);
  assert.deepEqual(errors, []);
});

test('cam crop: side cam shows only the cam, main stream always whole', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open('?c=main1,cam1&l=spotlight');
  await page.evaluate(() => Object.values(window.__players).forEach((p) => p.ev.playing && p.ev.playing()));
  await page.keyboard.press('m');
  await page.click('#list li[data-ch="cam1"] [data-act="crop"]');
  assert.ok(await page.isVisible('#cropEdit'));
  assert.ok(!(await page.evaluate(() => document.body.classList.contains('menu-open'))));
  // editing shows the whole picture full screen
  const full = await page.locator('.tile[data-channel="cam1"]').boundingBox();
  assert.equal(Math.round(full.width), 1280);
  await page.click('[data-corner="tr"]');
  await page.click('#cropDone');
  assert.match(page.url(), /k=cam1\.70\.0\.30/);
  const tile = await page.locator('.tile[data-channel="cam1"]').boundingBox();
  const pl = await page.locator('.tile[data-channel="cam1"] .player').boundingBox();
  assert.ok(pl.width > tile.width * 3, 'player zoomed: ' + pl.width);
  // center of the crop region (85% across, 15% down the picture) sits in the middle of the tile
  assert.ok(Math.abs(pl.x + pl.width * 0.85 - (tile.x + tile.width / 2)) < 2, 'crop centered horizontally');
  assert.ok(pl.y <= tile.y + 1, 'top aligned');
  // cropped side cam gets a higher quality than "Minimal"
  await page.evaluate(() => Object.values(window.__players).forEach((p) => p.ev.playing && p.ev.playing()));
  assert.notEqual(await page.evaluate(() => window.__players.cam1.quality), '160p30');

  // making the cam the main stream shows it whole
  await page.keyboard.press('Escape');
  await page.focus('.tile[data-channel="cam1"]');
  await page.keyboard.press('Enter');
  const mainBox = await page.locator('.tile[data-channel="cam1"] .player').boundingBox();
  const mainTile = await page.locator('.tile[data-channel="cam1"]').boundingBox();
  assert.ok(Math.abs(mainBox.width - mainTile.width) < 2);
  // crop is remembered for this channel after remove + add
  await page.keyboard.press('m');
  await page.click('#list li[data-ch="cam1"] [data-act="remove"]');
  await page.fill('#channelInput', 'cam1');
  await page.press('#channelInput', 'Enter');
  assert.match(page.url(), /k=cam1\.70\.0\.30/);
  assert.deepEqual(errors, []);
});

test('crop editor works with the remote: arrows move, OK = size, Back = done', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open('?c=r1,r2');
  await page.keyboard.press('m');
  await page.click('#list li[data-ch="r2"] [data-act="crop"]');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  assert.match(page.url(), /k=r2\.2\.68\.30/);
  await page.keyboard.press('Enter'); // size mode
  await page.keyboard.press('ArrowUp');
  assert.match(page.url(), /k=r2\.1\.67\.32/);
  assert.equal(await page.evaluate(() => window.handleBack()), 'handled');
  assert.ok(await page.isHidden('#cropEdit'));
  assert.deepEqual(errors, []);
});

test('paused streams are started by the page; main falls back to muted, a key press brings sound back', { skip: !chromium && 'playwright missing' }, async () => {
  const { page, errors } = await open('?c=k1,k2');
  // simulate blocked autoplay: players stay paused, and the main stream refuses to play with sound
  await page.evaluate(() => {
    for (const p of Object.values(window.__players)) {
      p.paused = true;
      p.play = function () { if (!this.muted && this.channel === 'k1') return; this.paused = false; };
    }
  });
  await page.waitForFunction(() => !window.__players.k2.paused, null, { timeout: 3000 });
  assert.equal(await page.evaluate(() => window.__players.k1.paused), true);
  await page.waitForFunction(() => !window.__players.k1.paused, null, { timeout: 6000 });
  assert.equal(await page.evaluate(() => window.__players.k1.muted), true, 'main started muted');
  assert.ok(await page.locator('.tile[data-channel="k1"].needs-sound').count());
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => window.__players.k1.muted), false, 'sound back after key press');
  assert.equal(await page.locator('.tile.needs-sound').count(), 0);
  assert.deepEqual(errors, []);
});
