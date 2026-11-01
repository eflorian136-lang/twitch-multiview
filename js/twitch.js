// Twitch login (Device Code Flow, made for TVs; implicit flow as fallback) and Helix API calls.
const ID = 'https://id.twitch.tv/oauth2';
const API = 'https://api.twitch.tv/helix';
const SCOPES = 'user:read:follows';
const TOKEN_KEY = 'multiview.twitch';

export function createTwitch({ clientId, fetchFn = (...a) => fetch(...a), storage = safeStorage(), now = () => Date.now() }) {
  let auth = load();

  function load() {
    try {
      return JSON.parse(storage.getItem(TOKEN_KEY) || 'null');
    } catch {
      return null;
    }
  }
  function save(a) {
    auth = a;
    try {
      if (a) storage.setItem(TOKEN_KEY, JSON.stringify(a));
      else storage.removeItem(TOKEN_KEY);
    } catch {}
  }

  async function form(url, params) {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    let data = {};
    try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data };
  }

  function storeToken(d) {
    save({
      accessToken: d.access_token,
      refreshToken: d.refresh_token || null,
      expiresAt: d.expires_in ? now() + d.expires_in * 1000 : null,
      userId: auth && auth.userId,
      login: auth && auth.login,
    });
  }

  async function refresh() {
    if (!auth || !auth.refreshToken) return false;
    const r = await form(`${ID}/token`, { client_id: clientId, grant_type: 'refresh_token', refresh_token: auth.refreshToken });
    if (!r.ok) {
      save(null);
      return false;
    }
    storeToken(r.data);
    return true;
  }

  async function api(path, params = {}) {
    const expired = () => new Error('Anmeldung abgelaufen, bitte neu anmelden');
    if (!auth) throw expired();
    if (auth.expiresAt && auth.expiresAt - now() < 60_000) await refresh();
    if (!auth) throw expired(); // refresh failed and logged out
    const url = `${API}/${path}?${new URLSearchParams(params)}`;
    const call = () => fetchFn(url, { headers: { 'Client-Id': clientId, Authorization: `Bearer ${auth.accessToken}` } });
    let r = await call();
    if (r.status === 401 && (await refresh())) r = await call();
    if (r.status === 401 || !auth) {
      save(null);
      throw expired();
    }
    if (!r.ok) throw new Error('Twitch API Fehler ' + r.status);
    return r.json();
  }

  async function loadUser() {
    const d = await api('users');
    const u = d.data && d.data[0];
    if (u) save({ ...auth, userId: u.id, login: u.login });
    return u;
  }

  return {
    get enabled() { return !!clientId; },
    get loggedIn() { return !!(auth && auth.accessToken); },
    get login() { return auth && auth.login; },
    logout() { save(null); },

    // Step 1: returns { userCode, verificationUri, deviceCode, interval, expiresIn }
    async startDeviceLogin() {
      const r = await form(`${ID}/device`, { client_id: clientId, scopes: SCOPES });
      if (!r.ok) throw new Error('Login-Start fehlgeschlagen (' + r.status + ')');
      const d = r.data;
      return { userCode: d.user_code, verificationUri: d.verification_uri, deviceCode: d.device_code, interval: d.interval || 5, expiresIn: d.expires_in };
    },

    // Step 2: one poll. Returns 'pending' | 'done' | 'expired' | 'slow_down'
    async pollDeviceLogin(deviceCode) {
      const r = await form(`${ID}/token`, {
        client_id: clientId, scopes: SCOPES, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (r.ok && r.data.access_token) {
        storeToken(r.data);
        await loadUser();
        return 'done';
      }
      const msg = String(r.data.message || '');
      if (msg.includes('slow_down')) return 'slow_down';
      if (msg.includes('authorization_pending')) return 'pending';
      return 'expired';
    },

    // Fallback login via redirect (works without CORS on id.twitch.tv)
    implicitLoginUrl(redirectUri) {
      const p = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'token', scope: SCOPES });
      return `${ID}/authorize?${p}`;
    },
    async finishImplicitLogin(hash) {
      const p = new URLSearchParams(hash.replace(/^#/, ''));
      const token = p.get('access_token');
      if (!token) return false;
      save({ accessToken: token, refreshToken: null, expiresAt: null });
      await loadUser();
      return true;
    },

    async followedLive() {
      if (!auth) throw new Error('Anmeldung abgelaufen, bitte neu anmelden');
      if (!auth.userId) await loadUser();
      const d = await api('streams/followed', { user_id: auth.userId, first: 50 });
      return d.data.map(mapStream);
    },
    async topLive(language) {
      const params = { first: 40 };
      if (language) params.language = language;
      const d = await api('streams', params);
      return d.data.map(mapStream);
    },
    async search(query) {
      const d = await api('search/channels', { query, live_only: 'true', first: 30 });
      return d.data.map((c) => ({
        login: c.broadcaster_login, name: c.display_name, title: c.title, game: c.game_name,
        viewers: null, thumb: c.thumbnail_url, live: c.is_live,
      }));
    },
  };
}

function mapStream(s) {
  return {
    login: s.user_login, name: s.user_name, title: s.title, game: s.game_name, viewers: s.viewer_count,
    thumb: (s.thumbnail_url || '').replace('{width}', '320').replace('{height}', '180'), live: true,
  };
}

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  }
}
