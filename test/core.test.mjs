import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeChannel, parseChannelList, addChannels, lowestQuality, sanitizeState, parseQuery, toQuery, addChannel, removeChannel, moveChannel,
  layoutRects, spatialNext, MAX_CHANNELS,
} from '../js/core.js';

test('normalizeChannel accepts names and URLs', () => {
  assert.equal(normalizeChannel('Papaplatte'), 'papaplatte');
  assert.equal(normalizeChannel(' @monte '), 'monte');
  assert.equal(normalizeChannel('https://www.twitch.tv/Trymacs/videos'), 'trymacs');
  assert.equal(normalizeChannel('twitch.tv/gronkh?x=1'), 'gronkh');
  assert.equal(normalizeChannel('m.twitch.tv/abc_1'), 'abc_1');
});

test('normalizeChannel understands all kinds of Twitch links', () => {
  assert.equal(normalizeChannel('https://www.twitch.tv/Papaplatte?sr=a'), 'papaplatte');
  assert.equal(normalizeChannel('HTTPS://M.TWITCH.TV/abc/home'), 'abc');
  assert.equal(normalizeChannel('http://twitch.tv/abc/'), 'abc');
  assert.equal(normalizeChannel('https://player.twitch.tv/?channel=Foo&parent=x'), 'foo');
  assert.equal(normalizeChannel('https://www.twitch.tv/popout/bar/chat?popout='), 'bar');
  assert.equal(normalizeChannel('https://dashboard.twitch.tv/u/baz/stream-manager'), 'baz');
  assert.equal(normalizeChannel('https://www.twitch.tv/moderator/modme'), 'modme');
  assert.equal(normalizeChannel('<https://twitch.tv/abc>'), 'abc');
  assert.equal(normalizeChannel('twitch.tv/abc#chat'), 'abc');
  for (const bad of ['twitch.tv', 'https://www.twitch.tv/', 'twitch.tv/videos/123', 'https://clips.twitch.tv/Xyz', 'twitch.tv/directory/category/x', 'eviltwitch.tv/x', 'https://example.com/abc'])
    assert.equal(normalizeChannel(bad), null, bad);
});

test('parseChannelList splits names and links', () => {
  assert.deepEqual(parseChannelList('a, b\nc d;a'), { channels: ['a', 'b', 'c', 'd'], invalid: [] });
  assert.deepEqual(parseChannelList('schau mal https://twitch.tv/x und twitch.tv/y'), { channels: ['x', 'y'], invalid: [] });
  assert.deepEqual(parseChannelList('ok bad-name'), { channels: ['ok'], invalid: ['bad-name'] });
  assert.deepEqual(parseChannelList('  '), { channels: [], invalid: [] });
});

test('addChannels adds all valid, reports the rest', () => {
  let r = addChannels(sanitizeState({ channels: ['a'] }), 'b a x-y c');
  assert.deepEqual(r.added, ['b', 'c']);
  assert.deepEqual(r.state.channels, ['a', 'b', 'c']);
  assert.equal(r.state.audio, 'a');
  assert.match(r.errors.join('|'), /Kein Twitch-Kanal: x-y/);
  assert.match(r.errors.join('|'), /a ist schon drin/);
  r = addChannels(sanitizeState({}), Array.from({ length: 12 }, (_, i) => 'k' + i).join(' '));
  assert.equal(r.added.length, MAX_CHANNELS);
  assert.deepEqual(r.errors, [`Maximal ${MAX_CHANNELS} Kanaele`]);
  assert.equal(addChannels(sanitizeState({}), '').errors.length, 1);
});

test('lowestQuality picks smallest real resolution', () => {
  assert.equal(lowestQuality([{ group: 'auto' }, { group: 'chunked' }, { group: '720p60' }, { group: '360p30' }, { group: '160p30' }]), '160p30');
  assert.equal(lowestQuality(['auto', '480p30', '720p30']), '480p30');
  assert.equal(lowestQuality([{ group: 'auto' }]), null);
  assert.equal(lowestQuality(undefined), null);
});

test('normalizeChannel rejects junk', () => {
  for (const bad of ['', '   ', 'a-b', '<script>', 'x'.repeat(26), 'two words', null, 42]) assert.equal(normalizeChannel(bad), null);
});

test('query roundtrip', () => {
  const st = { channels: ['a', 'b', 'c'], layout: 'spotlight', audio: 'b' };
  const q = toQuery(st);
  assert.equal(q, '?c=a,b,c&l=spotlight&a=b');
  assert.deepEqual(parseQuery(q), st);
});

test('parseQuery defaults and sanitizes', () => {
  assert.equal(parseQuery(''), null);
  assert.deepEqual(parseQuery('?c=A,a,bad-name,b&l=nope&a=zzz'), { channels: ['a', 'b'], layout: 'grid', audio: 'a' });
});

test('sanitizeState caps channel count', () => {
  const many = Array.from({ length: 20 }, (_, i) => 'c' + i);
  assert.equal(sanitizeState({ channels: many }).channels.length, MAX_CHANNELS);
});

test('add / remove / move channels', () => {
  let st = sanitizeState({});
  let r = addChannel(st, 'twitch.tv/One');
  assert.equal(r.error, null);
  st = r.state;
  assert.equal(st.audio, 'one');
  assert.match(addChannel(st, 'one').error, /schon/);
  assert.match(addChannel(st, '!!').error, /Ungueltig/);
  st = addChannel(st, 'two').state;
  st = moveChannel(st, 'two', -1);
  assert.deepEqual(st.channels, ['two', 'one']);
  assert.equal(moveChannel(st, 'two', -1), st);
  st = removeChannel(st, 'one');
  assert.deepEqual(st, { channels: ['two'], layout: 'grid', audio: 'two' });
});

const inside = (r) => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 100 + 1e-9 && r.y + r.h <= 100 + 1e-9;

test('layouts stay inside viewport for 1..9 channels', () => {
  for (const l of ['grid', 'spotlight', 'pip', 'single']) {
    for (let n = 1; n <= 9; n++) {
      const rects = layoutRects(l, n, n - 1);
      assert.equal(rects.length, n);
      for (const r of rects) if (r) assert.ok(inside(r), `${l} n=${n} ${JSON.stringify(r)}`);
    }
  }
});

test('grid tiles do not overlap', () => {
  for (let n = 2; n <= 9; n++) {
    const rs = layoutRects('grid', n);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const a = rs[i], b = rs[j];
        const overlap = a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
        assert.ok(!overlap, `n=${n} ${i}/${j}`);
      }
  }
});

test('spotlight puts main channel big', () => {
  const rs = layoutRects('spotlight', 3, 2);
  assert.deepEqual(rs[2], { x: 0, y: 0, w: 75, h: 100 });
  assert.equal(rs[0].x, 75);
});

test('single shows only main channel', () => {
  const rs = layoutRects('single', 3, 1);
  assert.equal(rs[0], null);
  assert.deepEqual(rs[1], { x: 0, y: 0, w: 100, h: 100 });
});

test('spatialNext on 2x2 grid', () => {
  const rs = layoutRects('grid', 4); // 0 1 / 2 3
  assert.equal(spatialNext(rs, 0, 'right'), 1);
  assert.equal(spatialNext(rs, 0, 'down'), 2);
  assert.equal(spatialNext(rs, 3, 'up'), 1);
  assert.equal(spatialNext(rs, 3, 'left'), 2);
  assert.equal(spatialNext(rs, 0, 'up'), -1);
  assert.equal(spatialNext(rs, 0, 'left'), -1);
});

test('spatialNext skips hidden tiles', () => {
  assert.equal(spatialNext([{ x: 0, y: 0, w: 50, h: 100 }, null, { x: 50, y: 0, w: 50, h: 100 }], 0, 'right'), 2);
});
