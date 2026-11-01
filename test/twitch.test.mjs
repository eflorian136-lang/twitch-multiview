import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTwitch } from '../js/twitch.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}
const res = (status, body) => ({ ok: status < 400, status, json: async () => body });

function fakeTwitch(routes) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [re, fn] of routes) if (re.test(url)) return fn(url, opts);
    return res(404, {});
  };
  return { calls, fetchFn };
}

test('disabled without client id', () => {
  assert.equal(createTwitch({ clientId: '', storage: mem() }).enabled, false);
});

test('device login: pending, then done, user loaded and stored', async () => {
  let polls = 0;
  const { fetchFn, calls } = fakeTwitch([
    [/oauth2\/device$/, () => res(200, { device_code: 'dc', user_code: 'ABCD1234', verification_uri: 'https://www.twitch.tv/activate?public=true', interval: 5, expires_in: 1800 })],
    [/oauth2\/token$/, () => (++polls === 1 ? res(400, { status: 400, message: 'authorization_pending' }) : res(200, { access_token: 'at', refresh_token: 'rt', expires_in: 14000 }))],
    [/helix\/users/, () => res(200, { data: [{ id: '42', login: 'me' }] })],
  ]);
  const storage = mem();
  const tw = createTwitch({ clientId: 'cid', fetchFn, storage });
  const d = await tw.startDeviceLogin();
  assert.equal(d.userCode, 'ABCD1234');
  assert.match(calls[0].opts.body, /client_id=cid/);
  assert.equal(await tw.pollDeviceLogin('dc'), 'pending');
  assert.equal(await tw.pollDeviceLogin('dc'), 'done');
  assert.ok(tw.loggedIn);
  assert.equal(tw.login, 'me');
  const usersCall = calls.find((c) => c.url.includes('/helix/users'));
  assert.equal(usersCall.opts.headers['Client-Id'], 'cid');
  assert.equal(usersCall.opts.headers.Authorization, 'Bearer at');
  // persisted
  assert.ok(createTwitch({ clientId: 'cid', fetchFn, storage }).loggedIn);
});

test('device login: denied -> expired', async () => {
  const { fetchFn } = fakeTwitch([[/oauth2\/token$/, () => res(400, { message: 'access_denied' })]]);
  assert.equal(await createTwitch({ clientId: 'c', fetchFn, storage: mem() }).pollDeviceLogin('x'), 'expired');
});

test('401 triggers refresh and retry', async () => {
  const storage = mem();
  storage.setItem('multiview.twitch', JSON.stringify({ accessToken: 'old', refreshToken: 'rt', userId: '1' }));
  let first = true;
  const { fetchFn, calls } = fakeTwitch([
    [/oauth2\/token$/, () => res(200, { access_token: 'new', refresh_token: 'rt2', expires_in: 100 })],
    [/helix\/streams\?/, (u, o) => {
      if (first) { first = false; return res(401, {}); }
      assert.equal(o.headers.Authorization, 'Bearer new');
      return res(200, { data: [{ user_login: 'abc', user_name: 'Abc', title: 't', game_name: 'g', viewer_count: 5, thumbnail_url: 'x-{width}x{height}.jpg' }] });
    }],
  ]);
  const tw = createTwitch({ clientId: 'c', fetchFn, storage });
  const list = await tw.topLive('de');
  assert.deepEqual(list[0], { login: 'abc', name: 'Abc', title: 't', game: 'g', viewers: 5, thumb: 'x-320x180.jpg', live: true });
  assert.ok(calls.some((c) => c.url.includes('language=de')));
});

test('failed refresh logs out', async () => {
  const storage = mem();
  storage.setItem('multiview.twitch', JSON.stringify({ accessToken: 'old', refreshToken: 'rt', userId: '1' }));
  const { fetchFn } = fakeTwitch([[/oauth2\/token$/, () => res(400, {})], [/helix/, () => res(401, {})]]);
  const tw = createTwitch({ clientId: 'c', fetchFn, storage });
  await assert.rejects(tw.followedLive(), /abgelaufen/);
  assert.equal(tw.loggedIn, false);
});

test('implicit login from URL hash', async () => {
  const { fetchFn } = fakeTwitch([[/helix\/users/, () => res(200, { data: [{ id: '7', login: 'tv' }] })]]);
  const tw = createTwitch({ clientId: 'c', fetchFn, storage: mem() });
  assert.match(tw.implicitLoginUrl('https://x.github.io/a/'), /response_type=token.*scope=user%3Aread%3Afollows/);
  assert.equal(await tw.finishImplicitLogin('#access_token=tok&scope=x'), true);
  assert.equal(tw.login, 'tv');
});

test('search maps channels', async () => {
  const storage = mem();
  storage.setItem('multiview.twitch', JSON.stringify({ accessToken: 'a', userId: '1' }));
  const { fetchFn } = fakeTwitch([[/search\/channels/, () => res(200, { data: [{ broadcaster_login: 'x', display_name: 'X', title: 'T', game_name: 'G', thumbnail_url: 'u', is_live: true }] })]]);
  const list = await createTwitch({ clientId: 'c', fetchFn, storage }).search('x');
  assert.equal(list[0].login, 'x');
});
