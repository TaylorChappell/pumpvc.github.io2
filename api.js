/**
 * Solana Dev Tools Shared API Client
 * Essor Studios
 *
 * Used by: website pages + Chrome extension
 * All calls go to your Railway backend.
 */

'use strict';

// Security: HTML escaping helper for all innerHTML interpolations
function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Config ────────────────────────────────────────────────────────────────────
const UDT_API_BASE = 'https://ultimatedevtools-production.up.railway.app/api';
// Replace above with your actual Railway URL. Can also be set in env / manifest.

// ── Storage Helpers (works in both browser and extension contexts) ─────────────
const Storage = {
  get(key) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        return new Promise(res => chrome.storage.local.get(key, d => res(d[key])));
      }
      return Promise.resolve(localStorage.getItem(key));
    } catch { return Promise.resolve(null); }
  },

  set(key, val) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        return new Promise(res => chrome.storage.local.set({ [key]: val }, res));
      }
      localStorage.setItem(key, val);
      return Promise.resolve();
    } catch { return Promise.resolve(); }
  },

  remove(key) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        return new Promise(res => chrome.storage.local.remove(key, res));
      }
      localStorage.removeItem(key);
      return Promise.resolve();
    } catch { return Promise.resolve(); }
  }
};

// ── Token Management ──────────────────────────────────────────────────────────
const Auth = {
  TOKEN_KEY: 'udt_token',
  USER_KEY:  'udt_user',

  async getToken() {
    return await Storage.get(this.TOKEN_KEY);
  },

  async setToken(token) {
    await Storage.set(this.TOKEN_KEY, token);
  },

  async getUser() {
    const raw = await Storage.get(this.USER_KEY);
    try { return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  },

  async setUser(user) {
    await Storage.set(this.USER_KEY, JSON.stringify(user));
  },

  async clearSession() {
    await Storage.remove(this.TOKEN_KEY);
    await Storage.remove(this.USER_KEY);
    await Storage.remove('udt_sub_cache');
  },

  async isLoggedIn() {
    const token = await this.getToken();
    return !!token;
  }
};

// ── Core API Fetch Wrapper ────────────────────────────────────────────────────
async function udtFetch(path, options = {}) {
  const token = await Auth.getToken();

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const res = await fetch(`${UDT_API_BASE}${path}`, {
    ...options,
    headers
  });

  // Handle 401 globally
  if (res.status === 401) {
    await Auth.clearSession();
    if (typeof window !== 'undefined') {
      window.location.href = '/auth.html';
    }
    throw new Error('Unauthorized');
  }

  let data;
  try { data = await res.json(); }
  catch { data = {}; }

  if (!res.ok) {
    throw new Error(data.error || data.message || `HTTP ${res.status}`);
  }

  return data;
}

// ── Auth API ──────────────────────────────────────────────────────────────────
const AuthAPI = {
  async register({ email, password, name }) {
    return udtFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name })
    });
  },

  async login({ email, password }) {
    const data = await udtFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (data.token) {
      await Auth.setToken(data.token);
      await Auth.setUser(data.user);
    }
    return data;
  },

  async googleAuth(googleIdToken) {
    const data = await udtFetch('/auth/google', {
      method: 'POST',
      body: JSON.stringify({ id_token: googleIdToken })
    });
    if (data.token) {
      await Auth.setToken(data.token);
      await Auth.setUser(data.user);
    }
    return data;
  },

  async logout() {
    try { await udtFetch('/auth/logout', { method: 'POST' }); } catch {}
    await Auth.clearSession();
  },

  async me() {
    return udtFetch('/auth/me');
  }
};

// ── Subscription API ──────────────────────────────────────────────────────────
const SubAPI = {
  // SUB_CACHE_TTL: 3 minutes (reduce server load while still being fresh)
  CACHE_TTL: 3 * 60 * 1000,

  async getStatus(forceRefresh = false) {
    // Return cached status if fresh enough
    if (!forceRefresh) {
      const raw = await Storage.get('udt_sub_cache');
      if (raw) {
        try {
          const { status, ts } = JSON.parse(raw);
          if (Date.now() - ts < this.CACHE_TTL) return status;
        } catch {}
      }
    }

    const data = await udtFetch('/subscription/status');
    await Storage.set('udt_sub_cache', JSON.stringify({ status: data, ts: Date.now() }));
    return data;
  },

  async isActive() {
    try {
      const status = await this.getStatus();
      return status.active === true;
    } catch {
      return false;
    }
  },

  // Returns { active, plan, expires_at, trial, days_remaining }
  async verify() {
    // Always hits server — used before running tools
    const data = await udtFetch('/subscription/verify');
    await Storage.set('udt_sub_cache', JSON.stringify({ status: data, ts: Date.now() }));
    return data;
  },

  async redeemPromo(code) {
    return udtFetch('/subscription/redeem-promo', {
      method: 'POST',
      body: JSON.stringify({ code: code.trim().toUpperCase() })
    });
  },

  async getPaymentAddress(method) {
    // method: 'solana' | 'paypal'
    return udtFetch('/subscription/payment/init', {
      method: 'POST',
      body: JSON.stringify({ method })
    });
  },

  async checkPayment(paymentId) {
    return udtFetch(`/subscription/payment/check/${paymentId}`);
  }
};

// ── Admin API ─────────────────────────────────────────────────────────────────
const AdminAPI = {
  async generatePromoCode({ days = 5, label = '' }) {
    return udtFetch('/admin/promo/generate', {
      method: 'POST',
      body: JSON.stringify({ days, label })
    });
  },

  async listPromoCodes() {
    return udtFetch('/admin/promo/list');
  },

  async disablePromoCode(code) {
    return udtFetch('/admin/promo/disable', {
      method: 'POST',
      body: JSON.stringify({ code })
    });
  },

  async listUsers(page = 1, search = '') {
    return udtFetch(`/admin/users?page=${page}&search=${encodeURIComponent(search)}`);
  },

  async whitelistEmail(email) {
    return udtFetch('/admin/whitelist', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
  },

  async removeWhitelist(email) {
    return udtFetch('/admin/whitelist/remove', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
  },

  async listWhitelist() {
    return udtFetch('/admin/whitelist/list');
  },

  async addAdmin(email) {
    return udtFetch('/admin/admins/add', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
  },

  async removeAdmin(email) {
    return udtFetch('/admin/admins/remove', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
  },

  async listAdmins() {
    return udtFetch('/admin/admins/list');
  },

  async revokeUserSub(userId) {
    return udtFetch('/admin/users/revoke-sub', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId })
    });
  }
};

// ── UI Helpers ─────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const colors = { success: 'var(--accent-green)', error: 'var(--accent-red)', warning: 'var(--accent-amber)', info: 'var(--accent)' };

  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const safeMessage = escapeHTML(String(message));
  toast.innerHTML = `
    <span style="color:${colors[type]};font-weight:700;">${icons[type]}</span>
    <span>${safeMessage}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function setButtonLoading(btn, loading) {
  if (loading) {
    btn.dataset.originalText = btn.innerHTML;
    btn.classList.add('btn-loading');
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
    btn.classList.remove('btn-loading');
    btn.disabled = false;
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDaysLeft(iso) {
  if (!iso) return null;
  const ms = new Date(iso) - Date.now();
  const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'Expired';
  if (days === 1) return '1 day left';
  return `${days} days left`;
}

function initials(name, email) {
  if (name) return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  if (email) return email.slice(0, 2).toUpperCase();
  return 'U';
}

// ── Subscription Gate (use on any page that requires active sub) ───────────────
async function requireAuth(redirectTo = '/auth.html') {
  const loggedIn = await Auth.isLoggedIn();
  if (!loggedIn) {
    window.location.href = redirectTo;
    return false;
  }
  return true;
}

async function requireActiveSub(gate = true) {
  const loggedIn = await Auth.isLoggedIn();
  if (!loggedIn) { window.location.href = '/auth.html'; return false; }

  const sub = await SubAPI.getStatus();
  if (!sub.active) {
    if (gate) showSubGate(sub);
    return false;
  }
  return true;
}

function showSubGate(sub) {
  const main = document.getElementById('main-content') || document.querySelector('.page-content');
  if (!main) return;

  const isExpired  = sub?.expires_at && new Date(sub.expires_at) < new Date();
  const neverHad   = !sub?.expires_at;

  main.innerHTML = `
    <div class="gate-screen animate-fade-in">
      <div class="gate-icon">${isExpired ? '⏱' : '🔒'}</div>
      <div class="gate-title">${isExpired ? 'Subscription Expired' : 'Subscription Required'}</div>
      <p class="gate-desc">
        ${isExpired
          ? 'Your subscription has expired. Renew to continue using Solana Dev Tools.'
          : 'You need an active subscription to access these tools.'}
      </p>
      <div class="flex gap-8">
        <a href="/pricing.html" class="btn btn-primary">View Plans</a>
        <button class="btn btn-secondary" onclick="window.location.reload()">Refresh</button>
      </div>
    </div>
  `;
}

// ── Export for module contexts (extension SW, etc.) ───────────────────────────
if (typeof module !== 'undefined') {
  module.exports = { Auth, AuthAPI, SubAPI, AdminAPI, Storage, showToast, setButtonLoading, formatDate, formatDaysLeft, initials, requireAuth, requireActiveSub, escapeHTML };
}