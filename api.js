'use strict';

window.UDT_CONFIG = Object.assign(
  {
    apiBase: 'ultimatedevtools-production.up.railway.app/api',
  },
  window.UDT_CONFIG || {}
);

const SessionStore = {
  ACCESS_KEY: 'udt_access_token',
  USER_KEY: 'udt_user',
  getAccessToken() {
    return sessionStorage.getItem(this.ACCESS_KEY);
  },
  setAccessToken(token) {
    if (token) sessionStorage.setItem(this.ACCESS_KEY, token);
    else sessionStorage.removeItem(this.ACCESS_KEY);
  },
  getUser() {
    const raw = sessionStorage.getItem(this.USER_KEY);
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  },
  setUser(user) {
    if (user) sessionStorage.setItem(this.USER_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(this.USER_KEY);
  },
  clear() {
    sessionStorage.removeItem(this.ACCESS_KEY);
    sessionStorage.removeItem(this.USER_KEY);
  }
};

async function refreshAccessToken() {
  const response = await fetch(`${UDT_CONFIG.apiBase}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) throw new Error('Refresh failed');
  const data = await response.json();
  SessionStore.setAccessToken(data.accessToken);
  SessionStore.setUser(data.user);
  return data.accessToken;
}

async function apiFetch(path, options = {}, allowRetry = true) {
  let accessToken = SessionStore.getAccessToken();
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    options.headers || {},
    accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  );

  let response = await fetch(`${UDT_CONFIG.apiBase}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (response.status === 401 && allowRetry) {
    try {
      accessToken = await refreshAccessToken();
      return apiFetch(path, options, false);
    } catch (_error) {
      SessionStore.clear();
      throw new Error('Unauthorized');
    }
  }

  let data = {};
  try { data = await response.json(); } catch (_error) {}
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const AuthAPI = {
  async register(payload) {
    const data = await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(payload) }, false);
    SessionStore.setAccessToken(data.accessToken);
    SessionStore.setUser(data.user);
    return data;
  },
  async login(payload) {
    const data = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify(payload) }, false);
    SessionStore.setAccessToken(data.accessToken);
    SessionStore.setUser(data.user);
    return data;
  },
  async me() {
    const data = await apiFetch('/auth/me');
    SessionStore.setUser(data.user);
    return data.user;
  },
  async restore() {
    try {
      if (!SessionStore.getAccessToken()) {
        await refreshAccessToken();
      }
      return await this.me();
    } catch (_error) {
      SessionStore.clear();
      return null;
    }
  },
  async logout() {
    try {
      await apiFetch('/auth/logout', { method: 'POST' }, false);
    } finally {
      SessionStore.clear();
    }
  }
};

const SubAPI = {
  status() { return apiFetch('/subscription/status'); },
  verify() { return apiFetch('/subscription/verify'); },
  redeemPromo(code) {
    return apiFetch('/subscription/redeem-promo', {
      method: 'POST',
      body: JSON.stringify({ code })
    });
  }
};

const WalletAPI = {
  list() { return apiFetch('/wallets/watchlist'); },
  add(payload) { return apiFetch('/wallets/watchlist', { method: 'POST', body: JSON.stringify(payload) }); },
  remove(id) { return apiFetch(`/wallets/watchlist/${id}`, { method: 'DELETE' }); },
  loadVault() { return apiFetch('/wallets/vault'); },
  saveVault(payload) { return apiFetch('/wallets/vault', { method: 'PUT', body: JSON.stringify(payload) }); }
};

const StateAPI = {
  load() { return apiFetch('/state'); },
  save(state) { return apiFetch('/state', { method: 'PUT', body: JSON.stringify({ state }) }); }
};

const ToolsAPI = {
  listJobs() { return apiFetch('/tools/jobs'); },
  getJob(jobId) { return apiFetch(`/tools/jobs/${jobId}`); },
  createJob(tool, payload) {
    return apiFetch('/tools/jobs', {
      method: 'POST',
      body: JSON.stringify({ tool, payload })
    });
  }
};

const AdminAPI = {
  users(page = 1, search = '') { return apiFetch(`/admin/users?page=${page}&search=${encodeURIComponent(search)}`); },
  extendSubscription(userId, days, trial = false) {
    return apiFetch('/admin/subscriptions/extend', {
      method: 'POST',
      body: JSON.stringify({ userId, days, trial })
    });
  },
  revokeSubscription(userId) {
    return apiFetch('/admin/subscriptions/revoke', {
      method: 'POST',
      body: JSON.stringify({ userId })
    });
  },
  createPromo(code, days, label = '') {
    return apiFetch('/admin/promo', {
      method: 'POST',
      body: JSON.stringify({ code, days, label })
    });
  },
  promo() { return apiFetch('/admin/promo'); },
  whitelist(email) {
    return apiFetch('/admin/whitelist', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
  }
};

window.UDT = { SessionStore, AuthAPI, SubAPI, WalletAPI, StateAPI, ToolsAPI, AdminAPI };
