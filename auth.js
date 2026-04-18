/* ═══════════════════════════════════════════
   auth.js — Authentication & Crypto
   Essor Studios / Ultimate Dev Tools

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
<<<<<<< HEAD
        const data = await apiReq('POST', '/api/auth/google', { access_token: token });
=======
        const data = await apiReq('POST', '/auth/google', { access_token: token });
>>>>>>> parent of 285dc77 (Update)
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

// ── AUTH SCREEN ───────────────────────────────
function buildAuthScreen() {
  const isReg  = S.authScreen?.mode === 'register';
  const err    = S.authScreen?.error || '';
  const loading = !!S.authScreen?.loading;

  return `
    <div class="auth-shell">
      <div class="auth-card">

        <div class="auth-logo-row">
          <div class="brand-logo-slot" style="width:44px;height:44px;border-radius:10px;box-shadow:0 4px 16px rgba(13,31,74,0.25)">
            <svg width="44" height="44" viewBox="0 0 28 28" fill="none">
              <rect width="28" height="28" rx="6" fill="#0d1f4a"/>
              <path d="M7 9.5h14M7 14h9M7 18.5h12" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </div>
          <div>
            <div class="auth-brand">Ultimate Dev Tools</div>
            <div class="auth-studio">by Essor Studios</div>
          </div>
        </div>

        <div class="auth-toggle">
          <button class="auth-tab ${!isReg ? 'active' : ''}" data-action="auth-tab" data-tab="login">Sign In</button>
          <button class="auth-tab ${isReg ? 'active' : ''}" data-action="auth-tab" data-tab="register">Create Account</button>
        </div>

        ${err ? `<div class="auth-error">${err}</div>` : ''}

        <div class="field">
          <div class="field-label">Email</div>
          <input type="text" id="auth-email" placeholder="you@example.com" value="${S.authScreen?.email || ''}"/>
        </div>

        <div class="field">
          <div class="field-label">Password</div>
          <input type="password" id="auth-pass" placeholder="${isReg ? 'Min. 8 characters' : 'Your password'}"/>
        </div>

        ${isReg ? `
          <div class="field">
            <div class="field-label">Confirm Password</div>
            <input type="password" id="auth-pass2" placeholder="Repeat password"/>
          </div>
        ` : ''}

        <button class="btn btn-primary btn-full" style="margin-top:10px;border-radius:var(--radius)"
          data-action="${isReg ? 'auth-register' : 'auth-login'}" ${loading ? 'disabled' : ''}>
          ${loading ? '<span class="spinner"></span>&nbsp; Working…' : isReg ? 'Create Account' : 'Sign In'}
        </button>

        <div class="auth-divider"><span>or</span></div>

        <button class="btn btn-google btn-full" data-action="auth-google" ${loading ? 'disabled' : ''}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="flex-shrink:0">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </button>

        <div class="auth-note">
          🔒 Private keys are encrypted on your device before upload. We store only ciphertext and can never read your keys.
        </div>


      </div>
    </div>
  `;
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