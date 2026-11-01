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
  const p = { channel: o.channel, muted: o.muted, parent: o.parent,
    setMuted(m) { this.muted = m; }, setVolume() {} };
  window.__players[o.channel] = p;
  return p;
} };
window.Twitch.Player.READY = 'ready';
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
  assert.deepEqual(await muted(page), { alpha: false, beta: true, gamma: true });
  const parent = await page.evaluate(() => window.__players.alpha.parent);
  assert.deepEqual(parent, ['localhost']);

  await page.fill('#channelInput', 'not valid!');
  await page.press('#channelInput', 'Enter');
  assert.match(await page.textContent('#msg'), /Ungueltig/);
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
  await page.waitForTimeout(400); // CSS transition
  const small = await page.locator('.tile[data-channel="x1"]').boundingBox();
  assert.ok(small.width < 400);

  await page.click('#list li:first-child button:has-text("Weg")');
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
