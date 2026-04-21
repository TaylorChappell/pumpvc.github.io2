/* ═══════════════════════════════════════════
   auth.js — Authentication & Crypto
   Essor Studios / Solana Dev Tools

   Flow:
   1. First open → show login/register screen
   2. Login → server returns JWT, client derives
      AES-GCM key from password+userId via PBKDF2
   3. JWT + derived key stored in chrome.storage.local
   4. Subsequent opens → verify JWT silently, auto-login
   5. Wallet data encrypted client-side before upload
   6. Server stores only ciphertext — can never read keys
═══════════════════════════════════════════ */

'use strict';

const AUTH_STORAGE_KEY = 'udt_auth_v2';
const ENC_SALT_TEXT    = 'udt-essor-studios-wallet-enc-v2';

// ── SERVER URL ──────────────────────────────
function getServerUrl() {
  return 'https://ultimatedevtools-production.up.railway.app';
}

// ── PRIVATE KEY → WALLET ADDRESS ────────────
function deriveAddress(base58PrivKey) {
  if (!base58PrivKey) return null;
  try {
    const bytes = bs58decode(base58PrivKey);
    // Solana standard: 64-byte key = seed(32) + pubkey(32)
    if (bytes.length === 64) return bs58encode(bytes.slice(32, 64));
    return null; // 32-byte seed only — can't derive without libsodium
  } catch { return null; }
}

// ── CRYPTO ──────────────────────────────────
async function deriveEncKey(password, userId) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey(
    'raw', enc.encode(password + userId), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(ENC_SALT_TEXT + userId), iterations: 150000, hash: 'SHA-256' },
    km,
    { name: 'AES-GCM', length: 256 },
    true, ['encrypt', 'decrypt']
  );
}

async function exportKeyB64(k) {
  const raw = await crypto.subtle.exportKey('raw', k);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

async function importKeyB64(b64) {
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptWallets(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(obj))
  );
  return {
    encrypted_blob: btoa(String.fromCharCode(...new Uint8Array(ct))),
    iv: btoa(String.fromCharCode(...iv)),
  };
}

async function decryptWallets(blob, iv, key) {
  const ct  = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
  const ivB = Uint8Array.from(atob(iv),   c => c.charCodeAt(0));
  const pt  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivB }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

// ── HTTP ────────────────────────────────────
async function apiReq(method, path, body, token) {
  const url = getServerUrl() + path;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ── AUTH STORAGE ─────────────────────────────
async function saveAuthLocally(token, email, userId, encKeyB64) {
  await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: { token, email, userId, encKeyB64, ts: Date.now() } });
}

async function loadAuthLocally() {
  const d = await chrome.storage.local.get(AUTH_STORAGE_KEY);
  return d[AUTH_STORAGE_KEY] || null;
}

async function clearAuthLocally() {
  await chrome.storage.local.remove(AUTH_STORAGE_KEY);
}

// ── LOGIN ────────────────────────────────────
async function authLogin(email, password) {
  const data = await apiReq('POST', '/auth/login', { email, password });
  const cryptoKey = await deriveEncKey(password, String(data.userId));
  const encKeyB64 = await exportKeyB64(cryptoKey);
  await saveAuthLocally(data.token, data.email, data.userId, encKeyB64);
  S.auth = { loggedIn: true, token: data.token, email: data.email, userId: data.userId, cryptoKey };
  await syncWalletsFromServer();
}

// ── REGISTER ─────────────────────────────────
async function authRegister(email, password) {
  const data = await apiReq('POST', '/auth/register', { email, password });
  const cryptoKey = await deriveEncKey(password, String(data.userId));
  const encKeyB64 = await exportKeyB64(cryptoKey);
  await saveAuthLocally(data.token, data.email, data.userId, encKeyB64);
  S.auth = { loggedIn: true, token: data.token, email: data.email, userId: data.userId, cryptoKey };
}

// ── GOOGLE SIGN-IN ───────────────────────────
async function authGoogleSignIn() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'Google sign-in was cancelled'));
        return;
      }
      try {
        const data = await apiReq('POST', '/auth/google', { access_token: token });
        // For Google users: derive enc key from googleSub+userId (no password)
        const cryptoKey = await deriveEncKey(data.googleSub, String(data.userId));
        const encKeyB64 = await exportKeyB64(cryptoKey);
        await saveAuthLocally(data.token, data.email, data.userId, encKeyB64);
        S.auth = { loggedIn: true, token: data.token, email: data.email, userId: data.userId, cryptoKey, isGoogle: true };
        await syncWalletsFromServer();
        resolve(data);
      } catch (e) {
        chrome.identity.removeCachedAuthToken({ token }, () => {});
        reject(e);
      }
    });
  });
}

// ── AUTO-LOGIN ────────────────────────────────
async function tryAutoLogin() {
  const stored = await loadAuthLocally();
  if (!stored?.token || !stored?.encKeyB64) return false;
  try {
    await apiReq('GET', '/auth/verify', null, stored.token);
    const cryptoKey = await importKeyB64(stored.encKeyB64);
    S.auth = { loggedIn: true, token: stored.token, email: stored.email, userId: stored.userId, cryptoKey };
    await syncWalletsFromServer();
    return true;
  } catch {
    await clearAuthLocally();
    return false;
  }
}

// ── LOGOUT ───────────────────────────────────
async function authLogout() {
  await clearAuthLocally();
  S.auth = { loggedIn: false, token: null, email: null, userId: null, cryptoKey: null };
  S.savedWallets = [];
  S.walletGroups = [];
  S.walletSelection = new Set();
  await saveState();
  render();
}

// ── CLEAR ACCOUNT ─────────────────────────────
async function authClearAccount() {
  try {
    if (S.auth?.token) await apiReq('DELETE', '/account', null, S.auth.token);
  } catch (e) { console.warn('Server delete error:', e.message); }
  await clearAuthLocally();
  // Wipe ALL local extension storage
  await chrome.storage.local.clear();
  S.auth = { loggedIn: false };
  S.savedWallets = [];
  S.walletGroups = [];
  render();
}

// ── SYNC: SERVER → LOCAL ──────────────────────
async function syncWalletsFromServer() {
  if (!S.auth?.token || !S.auth?.cryptoKey) return;
  try {
    const res = await apiReq('GET', '/wallets', null, S.auth.token);
    if (res.data?.encrypted_blob) {
      const parsed = await decryptWallets(res.data.encrypted_blob, res.data.iv, S.auth.cryptoKey);
      S.savedWallets = parsed.savedWallets || [];
      S.walletGroups = parsed.walletGroups || [];
      // Ensure all wallets have derived addresses
      S.savedWallets.forEach(w => {
        if (!w.publicKey && w.privateKey) w.publicKey = deriveAddress(w.privateKey);
      });
      await saveState();
    }
  } catch (e) { console.warn('Sync from server failed:', e.message); }
}

// ── SYNC: LOCAL → SERVER ──────────────────────
async function syncWalletsToServer() {
  if (!S.auth?.token || !S.auth?.cryptoKey) return;
  try {
    const { encrypted_blob, iv } = await encryptWallets(
      { savedWallets: S.savedWallets, walletGroups: S.walletGroups },
      S.auth.cryptoKey
    );
    await apiReq('PUT', '/wallets', { encrypted_blob, iv }, S.auth.token);
  } catch (e) { console.warn('Sync to server failed:', e.message); }
}

// ── AUTH EVENT HANDLERS ───────────────────────
async function handleAuthAction(a, el) {
  if (a === 'auth-tab') {
    S.authScreen = { ...(S.authScreen||{}), mode: el.dataset.tab, error: '' };
    render(); return;
  }

  if (a === 'auth-login') {
    const email = document.getElementById('auth-email')?.value?.trim();
    const pass  = document.getElementById('auth-pass')?.value;
    if (!email || !pass) { S.authScreen = {...S.authScreen, error: 'Email and password required'}; render(); return; }
    S.authScreen = {...S.authScreen, loading: true, error: '', email}; render();
    try {
      await authLogin(email, pass);
      S.authScreen = { mode: 'login', error: '', loading: false };
      await saveState(); render();
    } catch (e) {
      S.authScreen = {...S.authScreen, loading: false, error: e.message};
      render();
    }
    return;
  }

  if (a === 'auth-google') {
    S.authScreen = {...S.authScreen, loading: true, error: ''}; render();
    try {
      await authGoogleSignIn();
      S.authScreen = { mode: 'login', error: '', loading: false };
      await saveState(); render();
    } catch (e) {
      S.authScreen = {...S.authScreen, loading: false, error: e.message};
      render();
    }
    return;
  }

  if (a === 'auth-register') {
    const email = document.getElementById('auth-email')?.value?.trim();
    const pass  = document.getElementById('auth-pass')?.value;
    const pass2 = document.getElementById('auth-pass2')?.value;
    if (!email || !pass) { S.authScreen = {...S.authScreen, error: 'All fields required'}; render(); return; }
    if (pass !== pass2)  { S.authScreen = {...S.authScreen, error: 'Passwords do not match'}; render(); return; }
    if (pass.length < 8) { S.authScreen = {...S.authScreen, error: 'Password must be at least 8 characters'}; render(); return; }
    S.authScreen = {...S.authScreen, loading: true, error: '', email}; render();
    try {
      await authRegister(email, pass);
      S.authScreen = { mode: 'login', error: '', loading: false };
      await saveState(); render();
    } catch (e) {
      S.authScreen = {...S.authScreen, loading: false, error: e.message};
      render();
    }
    return;
  }
}