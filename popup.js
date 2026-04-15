/* ═══════════════════════════════════════════
   popup.js — Main App
   Essor Studios / Ultimate Dev Tools
═══════════════════════════════════════════ */

'use strict';

const RPC = 'https://mainnet.helius-rpc.com/?api-key=9f6bffea-73da-4936-adab-429746a1b007';

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
let S = {
  activeTool: 'token-splitting',
  // Tool order & colors (persisted, synced to account)
  toolOrder:  ['token-splitting', 'bundle-checker', 'volume-bot', 'wallets'],
  toolColors: {}, // { toolId: '#hex' }  — empty = use default navy
  navEditMode: false,

  split: {
    tab: 'split',
    mode: 'existing',
    sourceWallet: '',
    tokenCA: '',
    sourceTokens: [],
    tokensLoading: false,
    targetWallets: [],
    deviation: 0,
    keepSource: false,
    newWalletCount: 5,
    history: [],
    historyExpanded: {},
    keyVisible: {},
    genWallets: [],
    auto: {
      enabled: false,
      sourceWallet: '',
      mode: 'existing',
      targetWallets: [],
      deviation: 0,
      caFilter: '',
      newWalletCount: 5,
      keepSource: false,
      oneTime: false,
      history: [],
    },
    autoTriggers: [],
    scroll: 0,
  },

  bundle: {
    // Landing inputs
    ca: '',
    walletAddresses: [],          // addresses for wallet checker
    _walletPickerOpen: false,
    _pastedWallet: '',
    // View: 'landing' | 'token-result' | 'wallet-result'
    view: 'landing',
    // Token analysis
    result: null,
    loading: false,
    progress: { step: '', pct: 0 },
    error: '',
    // Wallet check
    walletResult: null,
    walletLoading: false,
    walletProgress: { step: '', pct: 0 },
    walletError: '',
    scroll: 0,
  },

  settings: { rpcEndpoint: 'https://mainnet.helius-rpc.com/?api-key=9f6bffea-73da-4936-adab-429746a1b007', wsEndpoint: 'wss://mainnet.helius-rpc.com/?api-key=9f6bffea-73da-4936-adab-429746a1b007', scroll: 0, editingWalletId: null },

  // Auth state (set by auth.js)
  auth: { loggedIn: false, token: null, email: null, userId: null, cryptoKey: null },
  authScreen: { mode: 'login', error: '', loading: false, email: '' },

  // Saved wallets — { id, name, emoji, publicKey, privateKey, solBalance, groupId }
  savedWallets: [],

  // Wallet groups — { id, name, emoji, collapsed }
  walletGroups: [],

  // Wallet UI state (walletSelection is a Set, not persisted)
  wallets: { editingId: null, confirmDeleteId: null, scroll: 0 },

  google: { token: null, profile: null, syncing: false, lastSync: null },

  walletPicker: { open: false, targetField: null },

  // ── Sniper Bot ──
  sniper: {
    enabled: false,
    activeTab: 'config',
    mode: 'pumpfun',          // 'pumpfun' | 'ca'
    targetCA: '',
    keywordFilter: '',
    maxMarketCapSOL: 0,
    buyAmountSOL: 0.1,
    slippageBps: 1000,        // 10%
    priorityFeeSOL: 0.001,
    sourceWalletId: '',
    history: [],
    log: [],
    scroll: 0,
  },

   // ── Volume Bot ──
  volumeBot: {
    active:            false,
    targetCA:          '',
    intervalSeconds:   0,
    minSOL:            0,
    maxSOL:            0,
    walletMode:        'existing',
    newWalletCount:    5,
    sourceWalletId:    '',
    selectedWalletIds: [],
    generatedWallets:  [],
    log:               [],
    stats:             { cycles: 0, volumeAdded: 0, feesPaid: 0, bundlesFailed: 0 },
    lastCycleTs:       null,
    nextCycleIn:       null,
    _curveInfo:        null,
    _fundAmountPerWallet: 0.5,
    ai: { lastMarketCap: null, lastLiquidity: null, successStreak: 0, failStreak: 0 },
  },
};

let syncDebounceTimer = null;

// ─────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────
async function saveState() {
  try { await chrome.storage.local.set({ udt_v3: S }); } catch {}
  scheduleDriveSync();
}

async function loadState() {
  try {
    const { udt_v3 } = await chrome.storage.local.get('udt_v3');
    if (udt_v3) S = deepMerge(S, udt_v3);
  } catch {}
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// ─────────────────────────────────────────
// GOOGLE AUTH
// ─────────────────────────────────────────
async function handleGoogleSignIn() {
  try {
    showToast('Signing in…');
    const token = await googleSignIn();
    const profile = await fetchGoogleProfile(token);
    if (!profile) throw new Error('Could not fetch profile');
    S.google.token = token;
    S.google.profile = profile;

    showToast('Loading your settings…');
    // Pass profile.sub as the encryption key seed
    const cloud = await driveLoadSettings(token, profile.sub);
    if (cloud) {
      if (cloud.savedWallets) {
        // Merge: keep any local private keys not in cloud
        const localMap = {};
        S.savedWallets.forEach(w => { if (w.privateKey) localMap[w.id] = w.privateKey; });
        S.savedWallets = cloud.savedWallets.map(w => ({
          ...w,
          privateKey: w.privateKey || localMap[w.id] || ''
        }));
      }
      if (cloud.split) S.split = deepMerge(S.split, cloud.split);
      if (cloud.settings) S.settings = deepMerge(S.settings, cloud.settings);
      S.google.lastSync = Date.now();
      showToast('✓ Settings synced from Google');
    } else {
      showToast('✓ Signed in — no existing cloud data');
    }
    await saveState();
    render();
  } catch (e) {
    showToast('Sign-in failed: ' + (e.message || 'Unknown error'));
  }
}

async function handleGoogleSignOut() {
  await googleSignOut();
  S.google.token = null;
  S.google.profile = null;
  await saveState();
  render();
  showToast('Signed out');
}

function scheduleDriveSync() {
  if (!S.google.token || !S.google.profile) return;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(async () => {
    S.google.syncing = true;
    await driveSaveSettings(S.google.token, { savedWallets: S.savedWallets, split: S.split, settings: S.settings }, S.google.profile.sub);
    S.google.syncing = false;
    S.google.lastSync = Date.now();
    await chrome.storage.local.set({ udt_v3: S });
  }, 2000);
}

// ─────────────────────────────────────────
// SOLANA HELPERS
// ─────────────────────────────────────────
async function rpc(method, params) {
  try {
    const res = await fetch(S.settings.rpcEndpoint || RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return (await res.json()).result ?? null;
  } catch { return null; }
}

async function checkRpc() {
  const r = await rpc('getHealth', []);
  const online = r === 'ok' || r != null;
  const dot = document.getElementById('rpc-dot');
  const lbl = document.getElementById('rpc-label');
  if (dot) dot.className = 'status-dot ' + (online ? 'online' : 'offline');
  if (lbl) lbl.textContent = online ? 'RPC Online' : 'RPC Offline';
  return online;
}

async function getSolBalance(addr) {
  if (!addr || addr.length < 32) return null;
  const r = await rpc('getBalance', [addr]);
  return r?.value != null ? (r.value / 1e9).toFixed(4) : null;
}

async function getTokenBalance(walletAddr, mint) {
  if (!walletAddr || !mint) return null;
  const r = await rpc('getTokenAccountsByOwner', [walletAddr, { mint }, { encoding: 'jsonParsed' }]);
  if (!r?.value?.length) return '0';
  return parseFloat(r.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0).toLocaleString();
}

let balanceCache = {};
async function refreshBalances(addresses) {
  const btn = document.getElementById('refresh-spin');
  if (btn) btn.classList.add('spinning');
  for (const addr of addresses.filter(Boolean)) {
    const sol = await getSolBalance(addr);
    const tok = S.split.tokenCA ? await getTokenBalance(addr, S.split.tokenCA) : null;
    balanceCache[addr] = { sol, tok };
  }
  render();
  if (btn) btn.classList.remove('spinning');
}

// ─────────────────────────────────────────
// KEYPAIR
// ─────────────────────────────────────────
async function generateKeypair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const seed = privPkcs8.slice(16, 48);
  const fullPriv = new Uint8Array(64);
  fullPriv.set(seed); fullPriv.set(pubRaw, 32);
  return { publicKey: bs58encode(pubRaw), privateKey: bs58encode(fullPriv) };
}

// ─────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2, 10); }
function short(addr) { if (!addr || addr.length < 10) return addr || '—'; return addr.slice(0, 6) + '…' + addr.slice(-4); }
function fmtNum(n) { return parseFloat(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function solscanUrl(addr) { return `https://solscan.io/account/${addr}`; }

function splitWithDeviation(total, n, deviation) {
  if (n === 0) return [];
  if (deviation === 0) return Array(n).fill(total / n);
  const amounts = Array.from({ length: n }, () => (total / n) * (1 + (Math.random() * 2 - 1) * deviation / 100));
  const sum = amounts.reduce((a, b) => a + b, 0);
  return amounts.map(a => (a / sum) * total);
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied!'));
}

function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'toast show';
  clearTimeout(t._t);
  t._t = setTimeout(() => t.className = 'toast', 2200);
}

// ─────────────────────────────────────────
// WALLET PICKER MODAL
// ─────────────────────────────────────────
function openWalletPicker(targetField) {
  S.walletPicker = { open: true, targetField };
  const modal = document.getElementById('wallet-picker-modal');
  const box = document.getElementById('wallet-picker-box');
  if (!modal || !box) return;

  box.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">Select Wallet</span>
      <button class="modal-close" id="close-picker">✕</button>
    </div>
    ${S.savedWallets.length === 0 ? `
      <div class="modal-empty">No saved wallets yet.<br>Add wallets in Settings.</div>
      <button class="btn btn-ghost btn-full" style="margin-top:8px" id="picker-goto-settings">Go to Settings →</button>
    ` : S.savedWallets.map(w => `
      <button class="wallet-pick-row" data-pick-id="${w.id}">
        <span class="wallet-pick-emoji">${w.emoji || '💼'}</span>
        <div class="wallet-pick-info">
          <span class="wallet-pick-name">${w.name || 'Unnamed'}</span>
          <span class="wallet-pick-sub">${w.privateKey ? '🔑 Private key saved' : 'No private key'}</span>
        </div>
        <span class="wallet-pick-arrow">→</span>
      </button>
    `).join('')}
    <button class="btn btn-ghost btn-full" style="margin-top:10px;font-size:10px" id="picker-manage">
      Manage Wallets in Settings →
    </button>
  `;

  modal.style.display = 'flex';

  document.getElementById('close-picker').onclick = () => modal.style.display = 'none';
  const pmBtn = document.getElementById('picker-manage');
  if (pmBtn) pmBtn.onclick = () => { modal.style.display = 'none'; S.activeTool = 'settings'; render(); };
  const pgBtn = document.getElementById('picker-goto-settings');
  if (pgBtn) pgBtn.onclick = () => { modal.style.display = 'none'; S.activeTool = 'settings'; render(); };
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };

  box.querySelectorAll('[data-pick-id]').forEach(btn => {
    btn.onclick = () => {
      const w = S.savedWallets.find(x => x.id === btn.dataset.pickId);
      if (!w) return;
      if (targetField === 'split-source') S.split.sourceWallet = w.privateKey;
      else if (targetField === 'auto-source') S.split.auto.sourceWallet = w.privateKey;
      modal.style.display = 'none';
      saveState();
      render();
      showToast(`✓ ${w.emoji || ''} ${w.name} selected`);
    };
  });
}

// ─────────────────────────────────────────
// EMOJI PICKER
// ─────────────────────────────────────────
// EMOJIS defined in wallets.js

function openEmojiPicker(walletId) {
  const modal = document.getElementById('emoji-modal');
  const box = document.getElementById('emoji-modal-box');
  if (!modal || !box) return;
  box.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">Choose Emoji</span>
      <button class="modal-close" id="close-emoji">✕</button>
    </div>
    <div class="emoji-grid">
      ${EMOJIS.map(e => `<button class="emoji-btn" data-e="${e}">${e}</button>`).join('')}
    </div>
  `;
  modal.style.display = 'flex';
  document.getElementById('close-emoji').onclick = () => modal.style.display = 'none';
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
  box.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.onclick = () => {
      const w = S.savedWallets.find(x => x.id === walletId);
      if (w) { w.emoji = btn.dataset.e; saveState(); }
      modal.style.display = 'none';
      render();
    };
  });
}

// ─────────────────────────────────────────
// RENDER ROUTER

// ─────────────────────────────────────────
// TOOL DEFINITIONS (used by nav builder)
// ─────────────────────────────────────────
const TOOL_DEFS = {
  'token-splitting': {
    label: 'Token Splitting',
    svg: `<svg class="nav-svg" width="13" height="13" viewBox="0 0 13 13" fill="none">
      <circle cx="3" cy="6.5" r="2" stroke="currentColor" stroke-width="1.3"/>
      <circle cx="10" cy="3" r="2" stroke="currentColor" stroke-width="1.3"/>
      <circle cx="10" cy="10" r="2" stroke="currentColor" stroke-width="1.3"/>
      <path d="M5 6.5h2l1.5-3.5M7 6.5l1.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`,
  },
  'bundle-checker': {
    label: 'Bundle Checker',
    svg: `<svg class="nav-svg" width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path d="M2 9.5L6.5 2 11 9.5H2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M6.5 6v2M6.5 9.3v.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>`,
  },
  'volume-bot': {
    label: 'AI Volume Bot',
    svg: `<svg class="nav-svg" width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="2" y="4" width="9" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
      <line x1="6.5" y1="1.5" x2="6.5" y2="4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <circle cx="6.5" cy="1.2" r="0.7" fill="currentColor"/>
      <circle cx="4.5" cy="7" r="0.85" fill="currentColor"/>
      <circle cx="8.5" cy="7" r="0.85" fill="currentColor"/>
      <path d="M4.8 9h3.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
    </svg>`,
  },
  'wallets': {
    label: 'Wallets',
    svg: `<svg class="nav-svg" width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1" y="3" width="11" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
      <path d="M1 6h11" stroke="currentColor" stroke-width="1.2"/>
      <path d="M4 2v2M9 2v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <circle cx="9.5" cy="8.5" r="1.2" fill="currentColor"/>
    </svg>`,
  },
};

// ─────────────────────────────────────────
// NAV LIST BUILDER
// ─────────────────────────────────────────
let _navDragId = null;

function buildNavList() {
  const navList = document.getElementById('nav-list');
  if (!navList) return;

  // Ensure toolOrder only contains valid tool ids (no sniper)
  const validTools = Object.keys(TOOL_DEFS);
  S.toolOrder = (S.toolOrder || validTools).filter(id => validTools.includes(id));
  // Add any missing tools at end
  validTools.forEach(id => { if (!S.toolOrder.includes(id)) S.toolOrder.push(id); });

  const editing = S.navEditMode;

  navList.innerHTML = S.toolOrder.map(toolId => {
    const def    = TOOL_DEFS[toolId];
    if (!def) return '';
    const active = S.activeTool === toolId;
    const color  = S.toolColors?.[toolId];
    const style  = color ? `style="background:${color}20;border-left:2px solid ${color}"` : '';
    const dotStyle = color ? `style="background:${color}"` : '';

    if (editing) {
      return `<li class="nav-item nav-item-edit" data-tool="${toolId}" draggable="true" ${style}>
        <span class="nav-drag-handle">⠿</span>
        ${def.svg}
        <span class="nav-label">${def.label}</span>
        <button class="nav-color-dot" data-tool="${toolId}" data-action="nav-pick-color" title="Pick colour" ${dotStyle}></button>
      </li>`;
    }

    return `<li class="nav-item${active ? ' active' : ''}" data-tool="${toolId}" ${style}>
      ${color ? `<span class="nav-color-indicator" ${dotStyle}></span>` : ''}
      ${def.svg}
      <span class="nav-label">${def.label}</span>
    </li>`;
  }).join('');

  // Update the TOOLS section header edit button
  const hdr = document.querySelector('.nav-section-label');
  if (hdr) {
    hdr.innerHTML = `TOOLS <button class="nav-edit-btn" id="nav-edit-btn">${editing ? '✓ Done' : 'Edit'}</button>`;
    document.getElementById('nav-edit-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      S.navEditMode = !S.navEditMode;
      saveState();
      buildNavList();
      attachNavHandlers();
    });
  }

  attachNavHandlers();
}

function attachNavHandlers() {
  const navList = document.getElementById('nav-list');
  if (!navList) return;

  // Tool click (non-edit mode)
  if (!S.navEditMode) {
    navList.querySelectorAll('.nav-item[data-tool]').forEach(el => {
      el.onclick = () => { S.activeTool = el.dataset.tool; saveState(); render(); };
    });
    return;
  }

  // ── Edit mode: drag-to-reorder ─────────────────
  navList.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.nav-item-edit');
    if (!li) return;
    _navDragId = li.dataset.tool;
    li.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
  }, { once: false });

  navList.addEventListener('dragend', (e) => {
    const li = e.target.closest('.nav-item-edit');
    if (li) li.style.opacity = '';
    _navDragId = null;
    navList.querySelectorAll('.nav-item-edit').forEach(x => x.classList.remove('nav-drag-over'));
  });

  navList.addEventListener('dragover', (e) => {
    e.preventDefault();
    const li = e.target.closest('.nav-item-edit');
    navList.querySelectorAll('.nav-item-edit').forEach(x => x.classList.remove('nav-drag-over'));
    if (li && li.dataset.tool !== _navDragId) li.classList.add('nav-drag-over');
  });

  navList.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!_navDragId) return;
    const li = e.target.closest('.nav-item-edit');
    if (!li || li.dataset.tool === _navDragId) return;
    navList.querySelectorAll('.nav-item-edit').forEach(x => x.classList.remove('nav-drag-over'));

    const from = S.toolOrder.indexOf(_navDragId);
    const to   = S.toolOrder.indexOf(li.dataset.tool);
    if (from === -1 || to === -1) return;

    S.toolOrder.splice(from, 1);
    S.toolOrder.splice(to, 0, _navDragId);
    _navDragId = null;
    await saveState();
    buildNavList();
    attachNavHandlers();
  });
}

// ─────────────────────────────────────────
// COLOUR PICKER OVERLAY
// ─────────────────────────────────────────
function openNavColorPicker(toolId, anchorEl) {
  // Remove existing picker if any
  document.getElementById('nav-color-overlay')?.remove();

  const PRESETS = [
    '#0d1f4a', '#3b82f6', '#22c55e', '#f59e0b',
    '#ef4444', '#a855f7', '#ec4899', '#14b8a6',
    '#f97316', '#6366f1', '#84cc16', '#e879f9',
  ];

  const overlay = document.createElement('div');
  overlay.id = 'nav-color-overlay';
  overlay.className = 'nav-color-overlay';
  overlay.innerHTML = `
    <div class="nav-color-box" id="nav-color-box">
      <div class="nav-color-title">Pick colour for ${TOOL_DEFS[toolId]?.label || toolId}</div>
      <div class="nav-color-presets">
        ${PRESETS.map(c => `<button class="nav-color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
        <button class="nav-color-swatch nav-color-swatch-clear" data-color="" title="Reset to default">✕</button>
      </div>
      <div class="nav-color-custom-row">
        <input type="color" id="nav-custom-color" value="${S.toolColors?.[toolId] || '#3b82f6'}" class="nav-custom-color-input"/>
        <button class="btn btn-ghost btn-sm" id="nav-custom-apply">Apply</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  const box  = overlay.querySelector('#nav-color-box');
  box.style.left = Math.min(rect.right + 6, window.innerWidth - 180) + 'px';
  box.style.top  = Math.max(rect.top - 10, 4) + 'px';

  // Swatch clicks
  overlay.querySelectorAll('.nav-color-swatch').forEach(sw => {
    sw.onclick = async (e) => {
      e.stopPropagation();
      const color = sw.dataset.color;
      if (!S.toolColors) S.toolColors = {};
      if (color) S.toolColors[toolId] = color;
      else delete S.toolColors[toolId];
      await saveState();
      overlay.remove();
      buildNavList();
      attachNavHandlers();
    };
  });

  // Custom colour apply
  document.getElementById('nav-custom-apply')?.addEventListener('click', async () => {
    const color = document.getElementById('nav-custom-color')?.value;
    if (!color) return;
    if (!S.toolColors) S.toolColors = {};
    S.toolColors[toolId] = color;
    await saveState();
    overlay.remove();
    buildNavList();
    attachNavHandlers();
  });

  // Dismiss on outside click
  setTimeout(() => {
    document.addEventListener('click', function dismiss(e) {
      if (!overlay.contains(e.target)) {
        overlay.remove();
        document.removeEventListener('click', dismiss);
      }
    });
  }, 50);
}

// ─────────────────────────────────────────
function render() {
  const main = document.getElementById('main');
  if (!main) return;

  // ── Auth gate — nothing works without being logged in ──
  const sidebar = document.getElementById('sidebar');
  if (!S.auth?.loggedIn) {
    main.innerHTML = buildAuthScreen();
    // Dim and disable entire sidebar — no tool is accessible
    if (sidebar) {
      sidebar.style.pointerEvents = 'none';
      sidebar.style.opacity = '0.35';
      sidebar.style.filter = 'grayscale(0.5)';
    }
    attachHandlers();
    return;
  }

  // Logged in — restore sidebar fully
  if (sidebar) {
    sidebar.style.pointerEvents = '';
    sidebar.style.opacity = '';
    sidebar.style.filter = '';
  }

  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tool === S.activeTool));
  document.getElementById('settings-nav-btn')?.classList.toggle('active', S.activeTool === 'settings');

  if (S.activeTool === 'token-splitting')  main.innerHTML = buildSplitPage();
  else if (S.activeTool === 'bundle-checker') main.innerHTML = buildBundlePage();
  else if (S.activeTool === 'volume-bot')    main.innerHTML = buildVolumeBotPage();
  else if (S.activeTool === 'wallets') main.innerHTML = buildWalletsPage();
  else if (S.activeTool === 'settings') main.innerHTML = buildSettingsPage();

  attachHandlers();

  // Wallet page handlers
  if (S.activeTool === 'wallets') attachWalletHandlers();

  // Volume bot handlers
  if (S.activeTool === 'volume-bot') attachVolumeBotHandlers();

  const sa = document.getElementById('scroll-area');
  const scrollVal = S.activeTool === 'token-splitting' ? S.split.scroll
                  : S.activeTool === 'bundle-checker'  ? S.bundle.scroll
                  : S.activeTool === 'volume-bot'       ? 0
                  : S.activeTool === 'wallets'           ? (S.wallets?.scroll || 0)
                  : S.settings.scroll;
  if (sa && scrollVal) sa.scrollTop = scrollVal;
}

// ─────────────────────────────────────────
// TOKEN SPLITTING
// ─────────────────────────────────────────
// ═══════════════════════════════════════════
// TOKEN SPLITTING
// ═══════════════════════════════════════════

// Help tooltip system
function showHelp(id, title, body) {
  let el = document.getElementById('split-help-popup');
  if (!el) {
    el = document.createElement('div');
    el.id = 'split-help-popup';
    el.className = 'split-help-popup';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="split-help-title">${title}</div>
    <div class="split-help-body">${body}</div>
  `;
  el.style.display = 'block';

  const btn = document.getElementById(id);
  if (btn) {
    const r = btn.getBoundingClientRect();
    el.style.left  = Math.min(r.left, 340) + 'px';
    el.style.top   = (r.bottom + 4) + 'px';
  }

  const dismiss = (e) => {
    if (!el.contains(e.target) && e.target.id !== id) {
      el.style.display = 'none';
      document.removeEventListener('click', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss), 50);
}

// ═══════════════════════════════════════════
// TOKEN SPLITTING — compact unified layout
// ═══════════════════════════════════════════

function showHelp(id, title, body) {
  let el = document.getElementById('split-help-popup');
  if (!el) { el = document.createElement('div'); el.id='split-help-popup'; el.className='help-popup'; document.body.appendChild(el); }
  el.innerHTML = `<div class="help-popup-title">${title}</div><div class="help-popup-body">${body}</div>`;
  el.style.display = 'block';
  const btn = document.getElementById(id);
  if (btn) { const r=btn.getBoundingClientRect(); el.style.left=Math.min(r.left,window.innerWidth-230)+'px'; el.style.top=(r.bottom+4)+'px'; }
  const dismiss = e => { if(!el.contains(e.target)&&e.target.id!==id){el.style.display='none';document.removeEventListener('click',dismiss);}};
  setTimeout(()=>document.addEventListener('click',dismiss),50);
}

function buildSplitPage() {
  const sp = S.split;
  const autoHist   = (sp.auto.history || []).map(h => ({...h, _source: 'auto'}));
  const manualHist = (sp.history || []).map(h => ({...h, _source: 'manual'}));
  const allHistory = [...manualHist, ...autoHist].sort((a,b) => b.timestamp - a.timestamp);
  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Token Splitting</span>
      </div>
      <div class="tabs">
        <button class="tab ${sp.tab==='split'?'active':''}" data-action="split-tab" data-tab="split">Split</button>
        <button class="tab ${sp.tab==='auto'?'active':''}" data-action="split-tab" data-tab="auto">Auto</button>
        <button class="tab ${sp.tab==='history'?'active':''}" data-action="split-tab" data-tab="history">History${allHistory.length>0?` (${allHistory.length})`:''}</button>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">
      ${sp.tab==='split'   ? buildSplitTab()          : ''}
      ${sp.tab==='auto'    ? buildAutoTab()           : ''}
      ${sp.tab==='history' ? buildHistoryTab(allHistory) : ''}
    </div>`;
}

// ── Compact source wallet picker ─────────────
function buildSourcePicker(stateKey, privKeyVal) {
  const wallets = (S.savedWallets||[]).filter(w=>w.privateKey);
  const matched = wallets.find(w=>w.privateKey===privKeyVal);
  const open    = S.split._srcOpen?.[stateKey];

  return `
    <div class="cpicker-wrap">
      <div class="cpicker-btn ${matched?'cpicker-selected':''}" data-action="sp-src-toggle" data-key="${stateKey}">
        ${matched
          ? `<span>${matched.emoji||'💼'}</span><span class="cpicker-name">${matched.name||'Wallet'}</span><span class="cpicker-addr">${wShort(matched.publicKey)}</span>`
          : `<span style="color:var(--text-muted);font-size:11px">Select wallet…</span>`
        }
        <span class="cpicker-chevron ${open?'open':''}">›</span>
      </div>
      ${open ? `
        <div class="cpicker-dropdown">
          ${wallets.length===0
            ? `<div class="cpicker-empty">No saved wallets with private keys.<br>Add one in the Wallets tab.</div>`
            : wallets.map(w=>`
              <div class="cpicker-row ${privKeyVal===w.privateKey?'active':''}" data-action="sp-src-pick" data-key="${stateKey}" data-priv="${encodeURIComponent(w.privateKey)}">
                <span>${w.emoji||'💼'}</span>
                <div class="cpicker-row-info">
                  <span class="cpicker-name">${w.name||'Wallet'}</span>
                  <span class="cpicker-addr">${wShort(w.publicKey)}</span>
                </div>
                ${w.solBalance!=null?`<span class="cpicker-bal">${w.solBalance} SOL</span>`:''}
              </div>`).join('')
          }
          <div class="cpicker-divider"></div>
          <div class="cpicker-paste-label">Or paste private key</div>
          <div style="display:flex;gap:5px;padding:0 8px 8px">
            <input type="password" id="sp-paste-${stateKey}" placeholder="Base58 private key…" style="flex:1;font-size:10.5px"/>
            <button class="btn btn-ghost btn-sm" data-action="sp-src-paste" data-key="${stateKey}">Use</button>
          </div>
        </div>
      ` : ''}
    </div>`;
}

// ── Compact target wallet selector ───────────
function buildTargetPicker(selectedAddrs, stateKey) {
  const wallets = S.savedWallets||[];
  const groups  = S.walletGroups||[];
  const sel     = new Set((selectedAddrs||[]).filter(Boolean));
  const count   = sel.size;
  const open    = S.split._tgtOpen?.[stateKey];

  // All wallets with addresses
  const allWallets = wallets.filter(w=>w.publicKey);
  const ungrouped  = allWallets.filter(w=>!w.groupId);

  return `
    <div class="cpicker-wrap">
      <div class="cpicker-btn ${count>0?'cpicker-selected':''}" data-action="sp-tgt-toggle" data-key="${stateKey}">
        <span style="font-size:11px;color:${count>0?'var(--navy)':'var(--text-muted)'}">${count>0?`${count} wallet${count!==1?'s':''} selected`:'Select wallets…'}</span>
        <span class="cpicker-chevron ${open?'open':''}">›</span>
      </div>
      ${open ? `
        <div class="cpicker-dropdown cpicker-targets">
          ${groups.map(g=>{
            const gW = allWallets.filter(w=>w.groupId===g.id);
            const allSel = gW.length>0 && gW.every(w=>sel.has(w.publicKey));
            const someSel = gW.some(w=>sel.has(w.publicKey));
            return `
              <div class="tpicker-group-hdr" data-action="sp-tgt-group" data-key="${stateKey}" data-gid="${g.id}">
                <div class="tpicker-check ${allSel?'checked':someSel?'partial':''}"></div>
                <span>${g.emoji||'📁'}</span>
                <span class="tpicker-group-name">${g.name}</span>
                <span class="tpicker-count">${gW.length}</span>
              </div>
              ${gW.map(w=>`
                <div class="tpicker-wallet-row ${sel.has(w.publicKey)?'selected':''}" data-action="sp-tgt-wallet" data-key="${stateKey}" data-pub="${w.publicKey}">
                  <div class="tpicker-check ${sel.has(w.publicKey)?'checked':''}"></div>
                  <span>${w.emoji||'💼'}</span>
                  <div class="tpicker-info">
                    <span class="tpicker-name">${w.name||'Wallet'}</span>
                    <span class="tpicker-addr">${wShort(w.publicKey)}</span>
                  </div>
                </div>`).join('')}`;
          }).join('')}
          ${ungrouped.map(w=>`
            <div class="tpicker-wallet-row ${sel.has(w.publicKey)?'selected':''}" data-action="sp-tgt-wallet" data-key="${stateKey}" data-pub="${w.publicKey}">
              <div class="tpicker-check ${sel.has(w.publicKey)?'checked':''}"></div>
              <span>${w.emoji||'💼'}</span>
              <div class="tpicker-info">
                <span class="tpicker-name">${w.name||'Wallet'}</span>
                <span class="tpicker-addr">${wShort(w.publicKey)}</span>
              </div>
            </div>`).join('')}
          ${allWallets.length===0?`<div class="cpicker-empty">No wallets yet. Add some in the Wallets tab.</div>`:''}
          <div class="cpicker-divider"></div>
          <div class="cpicker-paste-label">Or paste address</div>
          <div style="display:flex;gap:5px;padding:0 8px 8px">
            <input type="text" id="sp-tgt-paste-${stateKey}" placeholder="Wallet address…" style="flex:1;font-size:10.5px"/>
            <button class="btn btn-ghost btn-sm" data-action="sp-tgt-paste" data-key="${stateKey}">Add</button>
          </div>
        </div>
      ` : ''}
    </div>`;
}

// ── Token picker ────────────────────────────
function buildTokenPicker(sp) {
  if (!sp.sourceWallet) {
    return `<div class="token-picker-empty">Select a source wallet above first.</div>`;
  }
  if (sp.tokensLoading) {
    return `<div class="token-picker-empty"><span class="spinner" style="width:12px;height:12px;border-width:2px"></span>&nbsp; Loading tokens…</div>`;
  }
  const tokens = sp.sourceTokens || [];
  if (tokens.length === 0) {
    return `<div class="token-picker-empty">No tokens found. Hit ↻ Refresh to load.</div>`;
  }
  return `
    <div class="token-picker-list">
      ${tokens.map(t => {
        const selected = sp.tokenCA === t.mint;
        const shortMint = t.mint.slice(0,4)+'…'+t.mint.slice(-4);
        const name = t.name || shortMint;
        const amt = t.uiAmount.toLocaleString(undefined, {maximumFractionDigits: 2});
        return `
          <div class="token-picker-row ${selected?'selected':''}" data-action="split-pick-token" data-mint="${t.mint}">
            <div class="tprow-check ${selected?'checked':''}"></div>
            <div class="tprow-info">
              <span class="tprow-name">${name}</span>
              <span class="tprow-mint" data-action="copy" data-copy="${t.mint}" onclick="event.stopPropagation()">${shortMint} ⧉</span>
            </div>
            <span class="tprow-amount">${amt}</span>
          </div>`;
      }).join('')}
    </div>`;
}

// ── Split tab ────────────────────────────────
function buildSplitTab() {
  const sp = S.split;
  return `
    <div class="split-form">

      <div class="sf-row">
        <div class="sf-label">Source Wallet <button class="help-q" id="h-src" data-action="show-help" data-title="Source Wallet" data-body="The wallet holding the tokens. Its private key signs the transfer transactions on-chain.">?</button></div>
        ${buildSourcePicker('split', sp.sourceWallet)}
      </div>

      <div class="sf-row">
        <div class="sf-label">
          Token to Split
          <span style="margin-left:auto;display:flex;gap:4px;align-items:center">
            ${sp.sourceWallet ? `<button class="help-q" id="tk-refresh" data-action="split-refresh-tokens" title="Refresh token balances" style="font-size:11px;width:auto;border-radius:4px;padding:1px 6px">↻ Refresh</button>` : ''}
          </span>
        </div>
        ${buildTokenPicker(sp)}
      </div>

      <div class="sf-row">
        <div class="sf-label">Send to</div>
        <div class="mode-toggle" style="margin-bottom:6px">
          <button class="mode-btn ${sp.mode==='existing'?'active':''}" data-action="split-mode" data-mode="existing">Existing Wallets</button>
          <button class="mode-btn ${sp.mode==='new'?'active':''}" data-action="split-mode" data-mode="new">Generate New</button>
        </div>
        ${sp.mode==='existing'
          ? buildTargetPicker((sp.targetWallets||[]).map(t=>t.address), 'split')
          : `<input type="number" id="split-new-count" value="${sp.newWalletCount||5}" min="1" max="100" style="max-width:80px"/> <span style="font-size:10px;color:var(--text-muted);margin-left:6px">wallets to generate</span>`
        }
      </div>

      <div class="sf-row">
        <div class="sf-label">Deviation <span style="color:var(--navy);font-weight:700">±${sp.deviation}%</span> <button class="help-q" id="h-dev" data-action="show-help" data-title="Deviation" data-body="Randomises each wallet's share slightly. 0% = equal. Higher = more random-looking on-chain.">?</button></div>
        <div class="slider-row">
          <input type="range" id="deviation-slider" min="0" max="50" value="${sp.deviation}" data-action="dev-slider"/>
          <span class="slider-value" id="dev-val">±${sp.deviation}%</span>
        </div>
      </div>

      <div class="sf-row sf-toggle-row">
        <div class="sf-toggle-left">
          <span class="sf-label" style="margin-bottom:0">Keep in Source Wallet</span>
          <span class="sf-toggle-hint">${sp.keepSource ? 'Source keeps its share' : 'Source sends everything'}</span>
        </div>
        <div class="sf-toggle-right">
          <div class="toggle ${sp.keepSource?'on':''}" data-action="split-toggle-keep"></div>
          <button class="help-q" id="h-keep" data-action="show-help" data-title="Keep in Source Wallet" data-body="When ON, the source wallet keeps its share of the tokens — only the remainder is split between targets. When OFF, 100% of the balance is distributed and the source wallet ends up with zero of this token.">?</button>
        </div>
      </div>

      ${sp.progress ? `
        <div class="split-progress">
          <div class="split-progress-bar" id="split-prog-bar" style="width:${sp.progress.pct}%"></div>
          <div class="split-progress-msg" id="split-prog-msg">${sp.progress.msg}</div>
        </div>` : ''}

      ${sp.lastResult ? `
        <div class="split-result-banner ${sp.lastResult.failed>0?'has-errors':''}">
          ${sp.lastResult.success>0?`✓ ${sp.lastResult.success} tx sent`:''}
          ${sp.lastResult.failed>0?` · ${sp.lastResult.failed} failed`:''}
          ${sp.lastResult.error?`✕ ${sp.lastResult.error}`:''}
          <button class="btn btn-secondary btn-sm" style="margin-left:auto;padding:3px 8px" data-action="split-clear-result">✕</button>
        </div>` : ''}

      <button class="btn btn-primary btn-full" id="split-btn" data-action="execute-split"
        ${sp.executing?'disabled':''} style="margin-top:4px">
        ${sp.executing?'<span class="spinner"></span>&nbsp;Splitting…':'◈ Execute Split'}
      </button>

      ${sp.mode==='new'&&sp.genWallets?.length>0 ? buildGenWalletsResult() : ''}
    </div>`;
}

function buildGenWalletsResult() {
  return `
    <hr class="section-divider"/>
    <div class="section-hdr" style="color:var(--blue)">↳ ${S.split.genWallets.length} Generated Wallets</div>
    ${S.split.genWallets.map((w,i)=>`
      <div class="result-wallet-card">
        <div class="result-wallet-num">WALLET ${i+1}</div>
        <div class="result-wallet-pub" data-action="copy" data-copy="${w.publicKey}">${w.publicKey}</div>
        <button class="reveal-key-btn" data-action="toggle-gen-key" data-key-id="gk-${i}">⚠ Show Private Key</button>
        <div class="key-reveal-box hidden" id="gk-${i}" data-action="copy" data-copy="${w.privateKey}">${w.privateKey}</div>
      </div>`).join('')}
    <div class="warn-notice">⚠ Back up private keys — they are saved in History.</div>`;
}

// ── History tab ──────────────────────────────
function buildHistoryTab(allHistory) {
  allHistory = allHistory || [];
  if (!allHistory.length) return `<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">No splits yet.</div></div>`;
  return allHistory.map(h=>{
    const expanded = S.split.historyExpanded[h.id];
    const date = new Date(h.timestamp).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const isAuto    = h._source === 'auto';
    const typeLabel = isAuto ? 'Auto' : (h.type==='new' ? 'Generate' : 'Existing');
    const typeCls   = isAuto ? 'badge-purple' : (h.type==='new' ? 'badge-blue' : 'badge-green');
    const walletCount = h.wallets?.length ?? 0;
    return `
      <div class="hist-card ${expanded?'expanded':''}">
        <div class="hist-header" data-action="toggle-history" data-hist-id="${h.id}">
          <div class="hist-left">
            <span class="verdict-badge ${typeCls}">${typeLabel}</span>
            <span class="hist-time">${date}</span>
          </div>
          <div class="hist-right">
            <span class="hist-summary">${fmtNum(h.totalAmount)} · ${walletCount}w</span>
            <span class="hist-chevron">▶</span>
          </div>
        </div>
        ${expanded ? buildHistoryBody(h) : ''}
      </div>`;
  }).join('');
}

function buildHistoryBody(h) {
  return `
    <div class="hist-body">
      <div class="hist-meta-row">
        <span class="hist-meta-label">CA:</span><span class="hist-meta-val link" data-action="copy" data-copy="${h.tokenCA}">${short(h.tokenCA)}</span>
        ${h.sourcePubkey?`<span class="hist-meta-label" style="margin-left:8px">From:</span><span class="hist-meta-val link" data-action="copy" data-copy="${h.sourcePubkey}">${short(h.sourcePubkey)}</span>`:''}
      </div>
      ${(h.txResults||[]).map(r=>`<div style="font-size:9px;padding:2px 0;color:${r.ok?'var(--green-dim)':'var(--danger)'}">
        ${r.ok?`✓ Tx ${r.batch}: <span style="font-family:var(--mono);cursor:pointer" data-action="copy" data-copy="${r.sig}">${r.sig?.slice(0,10)}…</span>`:`✕ Tx ${r.batch}: ${r.error}`}
      </div>`).join('')}
      ${h.wallets.map((w,i)=>`
        <div class="hist-wallet-row">
          <div>
            <div class="hist-wallet-addr link" data-action="copy" data-copy="${w.address}">${short(w.address)}</div>
            ${w.privateKey?`
              <button class="reveal-key-btn sm" data-action="toggle-hist-key" data-key-id="hk-${h.id}-${i}">⚠ Key</button>
              <div class="key-reveal-box hidden" id="hk-${h.id}-${i}" data-action="copy" data-copy="${w.privateKey}">${w.privateKey}</div>`:''}</div>
          <span class="hist-wallet-amt">${fmtNum(w.amount)} (${w.pct}%)</span>
        </div>`).join('')}
      <div class="hist-actions">
        <button class="btn btn-secondary btn-sm" data-action="export-history" data-hist-id="${h.id}">⬇ Export</button>
        <button class="btn btn-danger btn-sm" data-action="delete-history" data-hist-id="${h.id}">Delete</button>
      </div>
    </div>`;
}

// ── Auto tab — same layout as Split ─────────
function buildAutoTab() {
  const a = S.split.auto;
  const running = isAutoSplitRunning();
  return `
    <div class="split-form">

      <div class="auto-status-card" style="margin-bottom:10px">
        <div class="auto-status-left">
          <div class="auto-dot ${running?'running':'stopped'}"></div>
          <div>
            <div class="auto-status-label" style="font-size:11px">
              ${running
                ? (a.wsStatus==='polling'
                  ? '⏱ Running — Polling (3s)'
                  : '⚡ Running — WebSocket')
                : 'Stopped'}
            </div>
            ${a.lastResult?`<div class="auto-sub">Last: ${fmtNum(a.lastResult.totalAmount)} tokens</div>`:
              running?`<div class="auto-sub" style="color:var(--text-muted);font-size:9px">Watching for token buys…</div>`:''}
          </div>
        </div>
        <button class="btn ${running?'btn-danger':'btn-primary'} btn-sm" data-action="toggle-auto">
          ${running?'■ Stop':'▶ Start'}
        </button>
      </div>

      <div class="sf-row">
        <div class="sf-label">Buying Wallet <button class="help-q" id="h-auto-src" data-action="show-help" data-title="Buying Wallet" data-body="The wallet you buy tokens with. Auto-split watches it via WebSocket and fires instantly when a buy is detected.">?</button></div>
        ${buildSourcePicker('auto', a.sourcePrivKey||'')}
      </div>

      <div class="sf-row">
        <div class="sf-label">Token Filter <button class="help-q" id="h-auto-ca" data-action="show-help" data-title="Token Filter" data-body="Optional. Leave blank to split any token bought. Enter a mint address to only trigger on that specific token.">?</button></div>
        <input type="text" id="auto-ca-filter" value="${a.caFilter||''}" placeholder="Leave blank for any token…" style="font-size:11px"/>
      </div>

      <div class="sf-row">
        <div class="sf-label">Send to</div>
        <div class="mode-toggle" style="margin-bottom:6px">
          <button class="mode-btn ${a.mode==='existing'?'active':''}" data-action="auto-mode" data-mode="existing">Existing Wallets</button>
          <button class="mode-btn ${a.mode==='new'?'active':''}" data-action="auto-mode" data-mode="new">Generate New</button>
        </div>
        ${a.mode==='existing'
          ? buildTargetPicker(a.targetWallets||[], 'auto')
          : `<input type="number" id="auto-new-count" value="${a.newWalletCount||5}" min="1" max="50" style="max-width:80px"/> <span style="font-size:10px;color:var(--text-muted);margin-left:6px">wallets to generate</span>`
        }
      </div>

      <div class="sf-row">
        <div class="sf-label">Deviation <span style="color:var(--navy);font-weight:700">±${a.deviation||0}%</span></div>
        <div class="slider-row">
          <input type="range" id="auto-dev-slider" min="0" max="50" value="${a.deviation||0}" data-action="auto-dev-slider"/>
          <span class="slider-value" id="auto-dev-val">±${a.deviation||0}%</span>
        </div>
      </div>

      <div class="sf-row sf-toggle-row">
        <div class="sf-toggle-left">
          <span class="sf-label" style="margin-bottom:0">Keep in Source Wallet</span>
          <span class="sf-toggle-hint">${a.keepSource ? 'Source keeps its share' : 'Source sends everything'}</span>
        </div>
        <div class="sf-toggle-right">
          <div class="toggle ${a.keepSource?'on':''}" data-action="auto-toggle-keep"></div>
          <button class="help-q" id="h-auto-keep" data-action="show-help" data-title="Keep in Source Wallet" data-body="When ON, the source wallet keeps its share of the tokens — only the remainder is split between targets. When OFF, 100% of the balance is distributed and the source wallet ends up with zero of this token.">?</button>
        </div>
      </div>

      <div class="sf-row sf-toggle-row">
        <div class="sf-toggle-left">
          <span class="sf-label" style="margin-bottom:0">One-Time Mode</span>
          <span class="sf-toggle-hint">${a.oneTime ? 'Stops after first split' : 'Runs until manually stopped'}</span>
        </div>
        <div class="sf-toggle-right">
          <div class="toggle ${a.oneTime?'on':''}" data-action="auto-toggle-onetime"></div>
          <button class="help-q" id="h-auto-onetime" data-action="show-help" data-title="One-Time Mode" data-body="When ON, auto-split will fire once after detecting a buy, then automatically stop. Useful when you only want to split a single buy without leaving the watcher running indefinitely.">?</button>
        </div>
      </div>

    </div>`;
}

// ── executeSplit ─────────────────────────────
async function executeSplit() {
  const sp = S.split;
  const cntEl = document.getElementById('split-new-count');
  // Always read count fresh from the input — don't rely on stale state
  const freshCount = parseInt(cntEl?.value);
  if (!isNaN(freshCount) && freshCount > 0) sp.newWalletCount = freshCount;

  if (!sp.sourceWallet) { showToast('Select a source wallet first'); return; }
  if (!sp.tokenCA)      { showToast('Select a token from the list (hit Refresh if empty)'); return; }

  let targets = [];
  if (sp.mode==='existing') {
    targets = (sp.targetWallets||[]).map(t=>({address:t.address}));
    if (!targets.length) { showToast('Select at least one target wallet'); return; }
  } else {
    const n = sp.newWalletCount||5;
    const generated = [];
    for (let i=0;i<n;i++) { const kp=await generateKeypair(); generated.push(kp); targets.push({address:kp.publicKey}); }
    sp.genWallets = generated;
  }

  sp.executing=true; sp.progress={msg:'Starting…',pct:0}; sp.lastResult=null;
  await saveState(); render();

  try {
    const result = await executeSplitOnChain({
      sourcePrivKey: sp.sourceWallet, mint: sp.tokenCA, targets, deviation: sp.deviation, keepSource: sp.keepSource
    }, p => {
      sp.progress=p;
      const bar=document.getElementById('split-prog-bar'), msg=document.getElementById('split-prog-msg');
      if(bar) bar.style.width=p.pct+'%';
      if(msg) msg.textContent=p.msg;
    });

    const record = {
      id:uid(), timestamp:Date.now(), type:sp.mode,
      sourceWallet:sp.sourceWallet, sourcePubkey:result.sourcePubkey,
      tokenCA:sp.tokenCA, deviation:sp.deviation, totalAmount:result.totalAmount,
      txResults:result.results,
      wallets: targets.map((t,i)=>({
        address:t.address, privateKey:sp.mode==='new'?sp.genWallets[i]?.privateKey:null,
        amount:result.totalAmount/targets.length, pct:(100/targets.length).toFixed(1)
      }))
    };
    sp.history.unshift(record); if(sp.history.length>50) sp.history=sp.history.slice(0,50);
    sp.lastResult={success:result.success,failed:result.failed,totalAmount:result.totalAmount};
    sp.progress=null; sp.executing=false;
    await saveState(); render();
    showToast(result.success>0?`✓ ${result.success} tx sent!`:'All transactions failed');
  } catch(e) {
    sp.executing=false; sp.progress=null;
    sp.lastResult={success:0,failed:1,error:e.message};
    await saveState(); render();
    showToast('Split failed: '+(e.message||'unknown error'));
  }
}

function buildBundlePage() {
  const b = S.bundle;
  if (b.view === 'token-result') return buildBundleTokenResult();
  if (b.view === 'wallet-result') return buildBundleWalletResult();
  return buildBundleLanding();
}

// ── Landing ───────────────────────────────────────────────────────────────
function buildBundleLanding() {
  const b = S.bundle;
  const walletCount = (b.walletAddresses || []).length;
  const open = b._walletPickerOpen;

  // Build wallet rows for the checker picker
  const allWallets  = (S.savedWallets || []).filter(w => w.publicKey);
  const allGroups   = S.walletGroups || [];
  const selSet      = new Set(b.walletAddresses || []);
  const ungrouped   = allWallets.filter(w => !w.groupId);

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Bundle Checker</span>
      </div>

    </div>

    <div class="scroll-area" id="scroll-area">

      <!-- ── Token CA analysis ─────────────────── -->
      <div class="field">
        <div class="field-label">Token Contract Address <button class="help-q" id="h-bc-token" data-action="show-help" data-title="Token Bundle Analysis" data-body="Scans the first buyers of a token for: shared funding sources (same wallet funded multiple buyers), same-block buys (bundled transactions), and full-port purchases (a wallet bought ≥50% of visible supply — a strong dev/team signal).">?</button></div>
        <div class="add-row">
          <input type="text" id="bundle-ca" value="${b.ca}" placeholder="Paste token mint address…"/>
          <button class="btn btn-primary btn-sm" data-action="run-bundle"
            ${b.loading ? 'disabled' : ''}>
            ${b.loading
              ? '<span class="spinner-dark"></span>'
              : 'Analyze'}
          </button>
        </div>
      </div>
      ${b.loading ? buildBundleLoading(b.progress) : ''}
      ${b.error   ? `<div class="error-card">⚠ ${b.error}</div>` : ''}

      <div class="bc-divider"></div>

      <!-- ── Wallet connection checker ────────────── -->
      <!-- Wallet multi-picker (same style as split target picker) -->
      <div class="field">
        <div class="field-label">Check Connected Wallets <button class="help-q" id="h-bc-wallets" data-action="show-help" data-title="Check Connected Wallets" data-body="Select 2 or more wallets to check if they are linked. Detects: direct SOL transfers between them, wallets funded from the same source address, and wallets that received their first SOL within the same 2-slot window (common with CEX batch withdrawals).">?</button></div>
        <div class="cpicker-wrap">
          <div class="cpicker-btn ${walletCount > 0 ? 'cpicker-selected' : ''}" data-action="bc-wallet-toggle">
            <span style="font-size:11px;color:${walletCount > 0 ? 'var(--navy)' : 'var(--text-muted)'}">
              ${walletCount > 0 ? `${walletCount} wallet${walletCount !== 1 ? 's' : ''} selected` : 'Select wallets…'}
            </span>
            <span class="cpicker-chevron ${open ? 'open' : ''}">›</span>
          </div>
          ${open ? `
            <div class="cpicker-dropdown cpicker-targets">
              ${allGroups.map(g => {
                const gW = allWallets.filter(w => w.groupId === g.id);
                const allSel  = gW.length > 0 && gW.every(w => selSet.has(w.publicKey));
                const someSel = gW.some(w => selSet.has(w.publicKey));
                return `
                  <div class="tpicker-group-hdr" data-action="bc-wallet-group" data-gid="${g.id}">
                    <div class="tpicker-check ${allSel ? 'checked' : someSel ? 'partial' : ''}"></div>
                    <span>${g.emoji || '📁'}</span>
                    <span class="tpicker-group-name">${g.name}</span>
                    <span class="tpicker-count">${gW.length}</span>
                  </div>
                  ${gW.map(w => `
                    <div class="tpicker-wallet-row ${selSet.has(w.publicKey) ? 'selected' : ''}"
                      data-action="bc-wallet-pick" data-pub="${w.publicKey}">
                      <div class="tpicker-check ${selSet.has(w.publicKey) ? 'checked' : ''}"></div>
                      <span>${w.emoji || '💼'}</span>
                      <div class="tpicker-info">
                        <span class="tpicker-name">${w.name || 'Wallet'}</span>
                        <span class="tpicker-addr">${wShort(w.publicKey)}</span>
                      </div>
                    </div>`).join('')}`;
              }).join('')}
              ${ungrouped.map(w => `
                <div class="tpicker-wallet-row ${selSet.has(w.publicKey) ? 'selected' : ''}"
                  data-action="bc-wallet-pick" data-pub="${w.publicKey}">
                  <div class="tpicker-check ${selSet.has(w.publicKey) ? 'checked' : ''}"></div>
                  <span>${w.emoji || '💼'}</span>
                  <div class="tpicker-info">
                    <span class="tpicker-name">${w.name || 'Wallet'}</span>
                    <span class="tpicker-addr">${wShort(w.publicKey)}</span>
                  </div>
                </div>`).join('')}
              ${allWallets.length === 0
                ? `<div class="cpicker-empty">No saved wallets. Add some in the Wallets tab.</div>`
                : ''}
              <div class="cpicker-divider"></div>
              <div class="cpicker-paste-label">Or paste address</div>
              <div style="display:flex;gap:5px;padding:0 8px 8px">
                <input type="text" id="bc-paste-addr" placeholder="Wallet address…" style="flex:1;font-size:10.5px"/>
                <button class="btn btn-ghost btn-sm" data-action="bc-wallet-paste">Add</button>
              </div>
            </div>
          ` : ''}
        </div>
      </div>

      ${walletCount > 0 ? `
        <div class="bc-selected-list">
          ${[...(b.walletAddresses || [])].map((addr, i) => {
            const saved = (S.savedWallets || []).find(w => w.publicKey === addr);
            return `
              <div class="bc-sel-row">
                <span>${saved ? saved.emoji || '💼' : '🔑'}</span>
                <div style="flex:1;min-width:0">
                  <div style="font-size:10.5px;font-weight:600;color:var(--navy)">${saved ? saved.name : 'Custom'}</div>
                  <div class="hist-wallet-addr link" data-action="copy" data-copy="${addr}">${short(addr)}</div>
                </div>
                <button class="icon-btn" data-action="bc-wallet-remove" data-idx="${i}" title="Remove">✕</button>
              </div>`;
          }).join('')}
        </div>` : ''}

      ${b.walletLoading ? buildBundleLoading(b.walletProgress) : ''}
      ${b.walletError   ? `<div class="error-card">⚠ ${b.walletError}</div>` : ''}

      <button class="btn btn-primary btn-full" data-action="run-wallet-check"
        style="margin-top:8px" ${b.walletLoading || walletCount < 2 ? 'disabled' : ''}>
        ${b.walletLoading
          ? '<span class="spinner"></span>&nbsp;Checking…'
          : walletCount < 2
            ? `Check Connections ${walletCount === 1 ? '(select 2+ wallets)' : '(select wallets above)'}`
            : `◈ Check ${walletCount} Wallets for Connections`}
      </button>

    </div>`;
}

// ── Shared loading bar ─────────────────────────────────────────────────────
function buildBundleLoading(p) {
  p = p || { step: 'Starting…', pct: 0 };
  return `
    <div class="loading-card">
      <div class="loading-bar-wrap"><div class="loading-bar" style="width:${p.pct}%"></div></div>
      <div class="loading-step">${p.step || 'Starting…'}</div>
      <div class="loading-pct">${p.pct}%</div>
    </div>`;
}

// ── Token analysis result view ─────────────────────────────────────────────
function buildBundleTokenResult() {
  const b = S.bundle;
  const r = b.result;
  if (!r) return '';
  const s = r.stats;
  const riskColor = s.bundled === 0 ? 'var(--green-dim)' : parseFloat(s.bundledPct) > 30 ? 'var(--danger)' : 'var(--warn)';
  const riskLabel = s.bundled === 0 ? 'Looks Clean' : parseFloat(s.bundledPct) > 30 ? 'High Risk' : parseFloat(s.bundledPct) > 10 ? 'Medium Risk' : 'Low Risk';

  const groups = {
    BUNDLE:     r.buyers.filter(x => x.verdict === 'BUNDLE'),
    SUSPICIOUS: r.buyers.filter(x => x.verdict === 'SUSPICIOUS'),
    EARLY:      r.buyers.filter(x => x.verdict === 'EARLY'),
    FULLPORT:   r.buyers.filter(x => x.verdict === 'FULLPORT'),
    CLEAN:      r.buyers.filter(x => x.verdict === 'CLEAN'),
  };

  const bundleGroups = {};
  for (const w of groups.BUNDLE) {
    const g = w.bundleGroup || 'Group ?';
    if (!bundleGroups[g]) bundleGroups[g] = [];
    bundleGroups[g].push(w);
  }

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <button class="btn btn-ghost btn-sm" data-action="bundle-back">← Back</button>
        <span class="tool-title" style="font-size:13px">Token Analysis</span>
        <button class="btn btn-ghost btn-sm" data-action="bundle-clear-result">Clear</button>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">

      <div class="bundle-summary">
        <div class="bundle-score" style="color:${riskColor}">${riskLabel}</div>
        <div class="bundle-stats">
          <div class="bundle-stat"><div class="bundle-stat-val">${s.total}</div><div class="bundle-stat-label">Scanned</div></div>
          <div class="bundle-stat-divider"></div>
          <div class="bundle-stat"><div class="bundle-stat-val" style="color:var(--danger)">${s.bundled}</div><div class="bundle-stat-label">Bundled</div></div>
          <div class="bundle-stat-divider"></div>
          <div class="bundle-stat"><div class="bundle-stat-val" style="color:var(--danger)">${s.bundledPct}%</div><div class="bundle-stat-label">Supply</div></div>
          <div class="bundle-stat-divider"></div>
          <div class="bundle-stat"><div class="bundle-stat-val" style="color:var(--warn)">${s.suspicious}</div><div class="bundle-stat-label">Suspicious</div></div>
          ${s.fullPort > 0 ? `<div class="bundle-stat-divider"></div>
          <div class="bundle-stat"><div class="bundle-stat-val" style="color:var(--danger)">${s.fullPort}</div><div class="bundle-stat-label">Full Port</div></div>` : ''}
        </div>
        <div class="bundle-mint link" data-action="copy" data-copy="${r.mint}">CA: ${short(r.mint)}</div>
      </div>

      ${groups.BUNDLE.length > 0 ? `
        <div class="section-hdr" style="color:var(--danger);margin-top:14px">🔴 Confirmed Bundles — ${s.bundleGroups} group${s.bundleGroups !== 1 ? 's' : ''} · ${s.bundledPct}% of supply</div>
        ${Object.entries(bundleGroups).map(([gName, wallets]) => `
          <div class="bundle-group-card">
            <div class="bundle-group-header">
              <span class="bundle-group-title">${gName}</span>
              <span class="bundle-group-meta">${wallets.length} wallets · Funder:
                <a href="${solscanUrl(wallets[0].fundingSource)}" target="_blank" class="solscan-link">${short(wallets[0].fundingSource)} ↗</a>
              </span>
            </div>
            ${wallets.map(w => buildBundleWalletRow(w, r.totalSupply)).join('')}
          </div>
        `).join('')}
      ` : ''}

      ${groups.FULLPORT.length > 0 ? `
        <div class="section-hdr" style="color:var(--danger);margin-top:12px">🔴 Full-Port Buyers — bought ≥50% of visible supply at launch</div>
        ${groups.FULLPORT.map(w => buildBundleWalletRow(w, r.totalSupply)).join('')}
      ` : ''}

      ${groups.SUSPICIOUS.length > 0 ? `
        <div class="section-hdr" style="color:var(--warn);margin-top:12px">🟡 Suspicious — Same funder, slightly later (${s.suspiciousPct}%)</div>
        ${groups.SUSPICIOUS.map(w => buildBundleWalletRow(w, r.totalSupply)).join('')}
      ` : ''}

      ${groups.EARLY.length > 0 ? `
        <div class="section-hdr" style="color:var(--text-dim);margin-top:12px">⚪ Early Buyers — First few blocks, independent</div>
        ${groups.EARLY.map(w => buildBundleWalletRow(w, r.totalSupply)).join('')}
      ` : ''}

      ${groups.CLEAN.length > 0 ? `
        <details style="margin-top:12px">
          <summary class="section-hdr" style="cursor:pointer;list-style:none;color:var(--green-dim)">✅ Clean Buyers (${groups.CLEAN.length}) — click to expand</summary>
          ${groups.CLEAN.map(w => buildBundleWalletRow(w, r.totalSupply)).join('')}
        </details>
      ` : ''}

    </div>`;
}

// ── Wallet connection result view ──────────────────────────────────────────
function buildBundleWalletResult() {
  const b = S.bundle;
  const r = b.walletResult;
  if (!r) return '';

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <button class="btn btn-ghost btn-sm" data-action="bundle-back">← Back</button>
        <span class="tool-title" style="font-size:13px">Wallet Connections</span>
        <button class="btn btn-ghost btn-sm" data-action="bundle-clear-wallet">Clear</button>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">

      <!-- Summary bar -->
      <div class="bundle-summary" style="margin-bottom:12px">
        <div class="bundle-score" style="color:${r.connectionCount > 0 ? 'var(--danger)' : 'var(--green-dim)'}">
          ${r.connectionCount > 0 ? `${r.connectionCount} Connection${r.connectionCount !== 1 ? 's' : ''} Found` : 'No Connections Found'}
        </div>
        <div class="bundle-stats">
          <div class="bundle-stat"><div class="bundle-stat-val">${r.wallets.length}</div><div class="bundle-stat-label">Checked</div></div>
          <div class="bundle-stat-divider"></div>
          <div class="bundle-stat"><div class="bundle-stat-val" style="color:${r.directTransfers > 0 ? 'var(--danger)' : 'var(--text-dim)'}">
            ${r.directTransfers}</div><div class="bundle-stat-label">Direct Txs</div></div>
          <div class="bundle-stat-divider"></div>
          <div class="bundle-stat"><div class="bundle-stat-val" style="color:${r.sharedFunders > 0 ? 'var(--danger)' : 'var(--text-dim)'}">
            ${r.sharedFunders}</div><div class="bundle-stat-label">Shared Funders</div></div>
          <div class="bundle-stat-divider"></div>
          <div class="bundle-stat"><div class="bundle-stat-val" style="color:${r.sameFundingTime > 0 ? 'var(--warn)' : 'var(--text-dim)'}">
            ${r.sameFundingTime}</div><div class="bundle-stat-label">Same-Time Fund</div></div>
        </div>
      </div>

      <!-- Direct transfers between checked wallets -->
      ${r.directTxList?.length > 0 ? `
        <div class="section-hdr" style="color:var(--danger);margin-top:0">🔴 Direct Transfers Between These Wallets</div>
        ${r.directTxList.map(tx => `
          <div class="bc-conn-card">
            <div class="bc-conn-row">
              <span class="verdict-pill verdict-bundle">Direct Tx</span>
              <span class="bc-conn-amt">${tx.solAmt > 0 ? (tx.solAmt / 1e9).toFixed(4) + ' SOL' : 'Token transfer'}</span>
            </div>
            <div class="bc-conn-detail">
              <span class="link" data-action="copy" data-copy="${tx.from}">${labelWallet(tx.from, b.walletAddresses)} →</span>
              <span class="link" data-action="copy" data-copy="${tx.to}">${labelWallet(tx.to, b.walletAddresses)}</span>
            </div>
            <a href="${solscanUrl(tx.sig)}" target="_blank" class="solscan-link" style="font-size:9px">${tx.sig.slice(0,12)}… ↗</a>
          </div>
        `).join('')}
      ` : ''}

      <!-- Shared funders -->
      ${r.sharedFunderGroups?.length > 0 ? `
        <div class="section-hdr" style="color:var(--danger);margin-top:12px">🔴 Funded From Same Wallet</div>
        ${r.sharedFunderGroups.map(grp => `
          <div class="bc-conn-card">
            <div class="bc-conn-row">
              <span class="verdict-pill verdict-bundle">Shared Funder</span>
              <span class="bc-conn-amt">${grp.wallets.length} wallets</span>
            </div>
            <div class="bc-conn-detail" style="margin-bottom:4px">
              Funder: <span class="link" data-action="copy" data-copy="${grp.funder}">${short(grp.funder)}</span>
              <a href="${solscanUrl(grp.funder)}" target="_blank" class="solscan-link" style="margin-left:4px">↗</a>
            </div>
            ${grp.wallets.map(w => `
              <div style="font-size:10px;padding:2px 0;color:var(--text-dim)">
                → <span class="link" data-action="copy" data-copy="${w.addr}">${labelWallet(w.addr, b.walletAddresses)}</span>
                ${w.amt > 0 ? `<span style="color:var(--text-muted);margin-left:4px">(${(w.amt/1e9).toFixed(4)} SOL)</span>` : ''}
              </div>`).join('')}
          </div>
        `).join('')}
      ` : ''}

      <!-- Same-time funding (within 2 slots of each other) -->
      ${r.sameFundingGroups?.length > 0 ? `
        <div class="section-hdr" style="color:var(--warn);margin-top:12px">🟡 Funded at the Same Time</div>
        ${r.sameFundingGroups.map(grp => `
          <div class="bc-conn-card">
            <div class="bc-conn-row">
              <span class="verdict-pill verdict-suspicious">Same-Time</span>
              <span class="bc-conn-amt">${grp.wallets.length} wallets · Slot ${grp.slot}</span>
            </div>
            ${grp.wallets.map(w => `
              <div style="font-size:10px;padding:2px 0;color:var(--text-dim)">
                <span class="link" data-action="copy" data-copy="${w.addr}">${labelWallet(w.addr, b.walletAddresses)}</span>
                ${w.funder ? `<span style="color:var(--text-muted);margin-left:4px">← ${short(w.funder)}</span>` : ''}
              </div>`).join('')}
          </div>
        `).join('')}
      ` : ''}

      <!-- Wallet summary table -->
      <div class="section-hdr" style="margin-top:12px">All Checked Wallets</div>
      ${r.wallets.map(w => {
        const saved = (S.savedWallets || []).find(s => s.publicKey === w.addr);
        const hasFunding = w.fundingSource;
        const isConnected = w.connectedTo?.length > 0;
        return `
          <div class="bc-wallet-summary">
            <div class="bc-ws-top">
              <span>${saved ? saved.emoji || '💼' : '🔑'}</span>
              <div style="flex:1;min-width:0">
                <div style="font-size:10.5px;font-weight:600;color:var(--navy)">${saved ? saved.name : 'Custom Wallet'}</div>
                <div class="link" style="font-size:9.5px;color:var(--text-muted)" data-action="copy" data-copy="${w.addr}">${short(w.addr)}</div>
              </div>
              <a href="${solscanUrl(w.addr)}" target="_blank" class="solscan-btn">↗</a>
            </div>
            ${hasFunding ? `<div class="bc-ws-detail">Funded by: <span class="link" data-action="copy" data-copy="${w.fundingSource}">${short(w.fundingSource)}</span>
              <a href="${solscanUrl(w.fundingSource)}" target="_blank" class="solscan-link" style="margin-left:3px">↗</a></div>` : ''}
            ${w.fundingSlot ? `<div class="bc-ws-detail" style="color:var(--text-muted)">Funded at slot ${w.fundingSlot}</div>` : ''}
            ${isConnected ? `<div class="bc-ws-detail" style="color:var(--danger)">Connected to: ${w.connectedTo.map(a => labelWallet(a, b.walletAddresses)).join(', ')}</div>` : ''}
          </div>`;
      }).join('')}

    </div>`;
}

function labelWallet(addr, addrList) {
  const saved = (S.savedWallets || []).find(w => w.publicKey === addr);
  if (saved) return `${saved.emoji || '💼'} ${saved.name}`;
  const idx = (addrList || []).indexOf(addr);
  if (idx >= 0) return `Wallet ${idx + 1} (${short(addr)})`;
  return short(addr);
}

function buildBundleWalletRow(w, totalSupply) {
  const pct = totalSupply > 0 ? ((w.amount / totalSupply) * 100).toFixed(2) : '?';
  const isFullPort = parseFloat(pct) >= 50;
  const vc = {
    BUNDLE:     { label: '🔴 BUNDLE',     cls: 'verdict-bundle' },
    SUSPICIOUS: { label: '🟡 SUSPICIOUS', cls: 'verdict-suspicious' },
    EARLY:      { label: '⚪ EARLY',       cls: 'verdict-early' },
    FULLPORT:   { label: '🔴 FULL PORT',  cls: 'verdict-bundle' },
    CLEAN:      { label: '✅ CLEAN',       cls: 'verdict-clean' },
  }[w.verdict] || { label: w.verdict, cls: 'verdict-early' };
  return `
    <div class="wallet-row">
      <div class="wallet-row-left">
        <span class="verdict-pill ${vc.cls}">${vc.label}</span>
        <div class="wallet-row-info">
          <span class="wallet-row-addr link" data-action="copy" data-copy="${w.wallet}">${short(w.wallet)}</span>
          <span class="wallet-row-meta">${fmtNum(w.amount)} tokens · ${pct}%${w.slotDiff !== undefined ? ` · Slot +${w.slotDiff}` : ''}${isFullPort && w.verdict !== 'FULLPORT' ? ' · ⚠ full port' : ''}</span>
        </div>
      </div>
      <a href="${solscanUrl(w.wallet)}" target="_blank" class="solscan-btn">Solscan ↗</a>
    </div>`;
}

// ─────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────
function buildSettingsPage() {
  const a = S.auth;
  const showClear = S.settings.showClearConfirm;

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Settings</span>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">

      <!-- Account -->
      <div class="settings-section">
        <div class="settings-section-title">Account</div>
        <div class="account-card">
          <div class="account-avatar">${a.email?.charAt(0)?.toUpperCase() || '?'}</div>
          <div class="account-info">
            <div class="account-email">${a.email || '—'}</div>
            <div class="account-note">🔒 Keys encrypted on-device · server sees only ciphertext</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-secondary btn-sm" style="flex:1" data-action="logout">Sign Out</button>
          <button class="btn btn-danger btn-sm" style="flex:1" data-action="clear-account-prompt">Clear Account</button>
        </div>

        ${showClear ? `
          <div class="danger-confirm-box" style="margin-top:12px">
            <div style="font-size:11px;font-weight:600;color:var(--danger);margin-bottom:4px">⚠ Are you sure?</div>
            <div style="font-size:10.5px;color:var(--text-dim);margin-bottom:10px;line-height:1.5">
              This permanently deletes your account and all encrypted wallet data from the server. Your wallets will be unrecoverable. This cannot be undone.
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-danger btn-sm" style="flex:1" data-action="clear-account-confirm">Yes, Delete Everything</button>
              <button class="btn btn-secondary btn-sm" data-action="clear-account-cancel">Cancel</button>
            </div>
          </div>
        ` : ''}
      </div>

      <!-- RPC -->
      <div class="settings-section">
        <div class="settings-section-title">RPC Endpoint</div>
        <p style="font-size:10px;color:var(--text-muted);margin-bottom:8px;line-height:1.5">
          HTTP RPC for balance checks and transactions. Helius/QuickNode free tiers work well.
        </p>
        <input type="text" id="rpc-input" value="${S.settings.rpcEndpoint}" placeholder="https://api.mainnet-beta.solana.com"/>
        <button class="btn btn-ghost btn-sm" style="margin-top:6px" data-action="save-rpc">Save RPC</button>
      </div>

      <!-- WebSocket -->
      <div class="settings-section">
        <div class="settings-section-title">WebSocket Endpoint <span style="font-size:9px;font-weight:400;color:var(--text-muted)">(for Auto-Split)</span></div>
        <p style="font-size:10px;color:var(--text-muted);margin-bottom:8px;line-height:1.5">
          For real-time buy detection. Helius/QuickNode free tier doesn't support this — use public endpoint or upgrade. Leave blank to auto-derive from RPC URL.
        </p>
        <div style="background:var(--surface2);border:1px solid var(--border-md);border-radius:var(--radius-sm);padding:7px 9px;font-size:9.5px;color:var(--text-dim);margin-bottom:6px;line-height:1.5">
          Free options:<br>
          <code style="color:var(--navy);font-size:9px">wss://api.mainnet-beta.solana.com</code> (public, can be slow)<br>
          <code style="color:var(--navy);font-size:9px">wss://YOUR-QUICKNODE-ENDPOINT.solana-mainnet.quiknode.pro/</code>
        </div>
        <input type="text" id="ws-input" value="${S.settings.wsEndpoint||'wss://mainnet.helius-rpc.com/?api-key=9f6bffea-73da-4936-adab-429746a1b007'}" placeholder="wss://mainnet.helius-rpc.com/?api-key=…"/>
        <div style="font-size:9px;color:var(--text-muted);margin-top:3px">If WebSocket fails, auto-split automatically falls back to 3-second polling.</div>
        <button class="btn btn-ghost btn-sm" style="margin-top:6px" data-action="save-ws">Save WS</button>
      </div>


    </div>
  `;
}

function buildSavedWalletCard(w, isEditing) {
  if (isEditing) {
    return `
      <div class="saved-wallet-card editing" id="edit-${w.id}">
        <div class="saved-wallet-edit-top">
          <button class="emoji-pick-btn" data-action="open-emoji" data-wallet-id="${w.id}">${w.emoji || '💼'}</button>
          <input type="text" id="sw-name-${w.id}" value="${w.name || ''}" placeholder="Wallet name…" style="flex:1"/>
        </div>
        <div class="field" style="margin:8px 0 10px">
          <div class="field-label">Private Key</div>
          <input type="password" id="sw-priv-${w.id}" value="${w.privateKey || ''}" placeholder="Paste base58 private key…"/>
        </div>
        <div class="saved-wallet-edit-actions">
          <button class="btn btn-primary btn-sm" data-action="save-wallet-edit" data-wallet-id="${w.id}">Save</button>
          <button class="btn btn-secondary btn-sm" data-action="cancel-wallet-edit">Cancel</button>
          <button class="btn btn-danger btn-sm" data-action="delete-saved-wallet" data-wallet-id="${w.id}">Delete</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="saved-wallet-card">
      <div class="saved-wallet-left">
        <span class="saved-wallet-emoji">${w.emoji || '💼'}</span>
        <div class="saved-wallet-info">
          <div class="saved-wallet-name">${w.name || 'Unnamed'}</div>
          <div class="saved-wallet-key-status">${w.privateKey ? '🔑 Private key saved' : '⚠ No private key'}</div>
        </div>
      </div>
      <div class="saved-wallet-actions">
        <button class="btn btn-secondary btn-sm" data-action="edit-saved-wallet" data-wallet-id="${w.id}">Edit</button>
        <button class="btn btn-danger btn-sm" data-action="delete-saved-wallet" data-wallet-id="${w.id}">Delete</button>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────
// EVENT HANDLING
// ─────────────────────────────────────────
function attachHandlers() {
  const main = document.getElementById('main');
  if (!main) return;

  const sa = document.getElementById('scroll-area');
  if (sa) sa.addEventListener('scroll', () => {
    if (S.activeTool === 'token-splitting') S.split.scroll = sa.scrollTop;
    else if (S.activeTool === 'bundle-checker') S.bundle.scroll = sa.scrollTop;
    else if (S.activeTool === 'wallets') { S.wallets = S.wallets || {}; S.wallets.scroll = sa.scrollTop; }
    else S.settings.scroll = sa.scrollTop;
  });

  main.querySelectorAll('[data-bind-split]').forEach(el => {
    el.addEventListener('input', () => {
      S.split[el.dataset.bindSplit] = el.type === 'number' ? parseFloat(el.value) || 0 : el.value;
      saveState();
    });
  });

  main.querySelectorAll('[data-bind-auto]').forEach(el => {
    el.addEventListener('input', () => {
      S.split.auto[el.dataset.bindAuto] = el.type === 'number' ? parseFloat(el.value) || 0 : el.value;
      saveState();
    });
  });

  main.querySelectorAll('[data-action="wallet-addr-edit"]').forEach(el => {
    el.addEventListener('input', () => {
      const w = S.split.targetWallets.find(x => x.id === el.dataset.walletId);
      if (w) { w.address = el.value; saveState(); }
    });
  });

  const splitCount = document.getElementById('split-new-count');
  if (splitCount) splitCount.addEventListener('input', (e) => {
    const v = parseInt(e.target.value);
    if (!isNaN(v) && v > 0) { S.split.newWalletCount = v; saveState(); }
  });
  const autoCount = document.getElementById('auto-new-count');
  if (autoCount) autoCount.addEventListener('input', (e) => {
    const v = parseInt(e.target.value);
    if (!isNaN(v) && v > 0) { S.split.auto.newWalletCount = v; saveState(); }
  });

  const devSlider = document.getElementById('deviation-slider');
  if (devSlider) devSlider.addEventListener('input', (e) => {
    S.split.deviation = parseInt(e.target.value);
    const lbl = document.getElementById('dev-val');
    if (lbl) lbl.textContent = '±' + S.split.deviation + '%';
    const hint = document.getElementById('dev-hint');
    if (hint) hint.textContent = S.split.deviation === 0 ? 'Every wallet gets an equal share' : `Amounts vary by up to ±${S.split.deviation}% from equal`;
    saveState();
  });

  const autoSlider = document.getElementById('auto-dev-slider');
  if (autoSlider) autoSlider.addEventListener('input', (e) => {
    S.split.auto.deviation = parseInt(e.target.value);
    const lbl = document.getElementById('auto-dev-val');
    if (lbl) lbl.textContent = '±' + S.split.auto.deviation + '%';
    saveState();
  });

  main.addEventListener('click', handleClick);

  // Close all cpicker dropdowns when clicking outside them
  document.addEventListener('click', function closePickers(e) {
    const inside = e.target.closest('.cpicker-wrap');
    if (!inside) {
      let changed = false;
      if (S.bundle._walletPickerOpen) { S.bundle._walletPickerOpen = false; changed = true; }
      if (S.split._srcOpen && Object.keys(S.split._srcOpen).some(k=>S.split._srcOpen[k])) {
        S.split._srcOpen = {}; changed = true;
      }
      if (S.split._tgtOpen && Object.keys(S.split._tgtOpen).some(k=>S.split._tgtOpen[k])) {
        S.split._tgtOpen = {}; changed = true;
      }
      if (changed) render();
    }
  }, { once: false, capture: false });

  // ── Dynamic nav rendering ─────────────────────────────────────────
  buildNavList();

  document.querySelectorAll('.nav-item').forEach(el => {
    if (el.dataset.tool) {
      el.onclick = () => { S.activeTool = el.dataset.tool; saveState(); render(); };
    }
  });

  // Pin / Unpin sidebar — toggles between popup and side panel mode
  const pinBtn = document.getElementById('pin-btn');
  if (pinBtn) {
    // Update label based on current mode
    chrome.storage.local.get('udt_sidebar_mode', (d) => {
      const pinned = !!d.udt_sidebar_mode;
      const label = pinBtn.querySelector('.pin-btn-label');
      if (label) label.textContent = pinned ? 'Unpin Sidebar' : 'Pin Sidebar';
    });

    pinBtn.onclick = async () => {
      const d = await chrome.storage.local.get('udt_sidebar_mode');
      const currentlyPinned = !!d.udt_sidebar_mode;

      if (currentlyPinned) {
        // Unpin: switch back to popup mode
        await chrome.storage.local.set({ udt_sidebar_mode: false });
        try { await chrome.runtime.sendMessage({ action: 'setPopupMode' }); } catch {}
        showToast('✓ Unpinned — use the extension icon to open');
        const label = pinBtn.querySelector('.pin-btn-label');
        if (label) label.textContent = 'Pin Sidebar';
      } else {
        // Pin: open as side panel
        if (!chrome?.sidePanel?.open) { showToast('Requires Chrome 116+'); return; }
        try {
          await chrome.storage.local.set({ udt_sidebar_mode: true });
          const wins = await chrome.windows.getCurrent();
          await chrome.sidePanel.open({ windowId: wins.id });
          window.close();
        } catch (e) {
          await chrome.storage.local.set({ udt_sidebar_mode: false });
          showToast('Could not open sidebar: ' + (e.message || 'unknown error'));
        }
      }
    };
  }
  const sBtn = document.getElementById('settings-nav-btn');
  if (sBtn) sBtn.onclick = () => { S.activeTool = 'settings'; saveState(); render(); };

  // Unpin / restore popup mode
  const unpinBtn = document.getElementById('unpin-btn');
  if (unpinBtn) unpinBtn.onclick = async () => {
    await chrome.runtime.sendMessage({ action: 'setPopupMode' });
    await chrome.storage.local.set({ udt_sidebar_mode: false });
    showToast('✓ Switched back to popup mode');
  };

  // Show sidebar mode status in settings
  const sidebarStatusEl = document.getElementById('sidebar-mode-status');
  if (sidebarStatusEl) {
    chrome.storage.local.get('udt_sidebar_mode', (d) => {
      const on = !!d.udt_sidebar_mode;
      sidebarStatusEl.innerHTML = on
        ? '<div style="font-size:10px;color:var(--green-dim);padding:4px 0">● Currently pinned to sidebar — click extension icon to open</div>'
        : '<div style="font-size:10px;color:var(--text-muted);padding:4px 0">○ Currently using popup mode</div>';
    });
  }
}

async function handleClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;

  if (a === 'split-tab') {
    S.split.tab = el.dataset.tab; S.split.scroll = 0; await saveState(); render();

  } else if (a === 'split-mode') {
    S.split.mode = el.dataset.mode; S.split.genWallets = []; S.split.lastResult = null; await saveState(); render();

  } else if (a === 'add-target-wallet') {
    const inp = document.getElementById('new-wallet-input');
    const addr = inp?.value?.trim();
    if (addr?.length >= 32) {
      S.split.targetWallets.push({ id: uid(), address: addr, label: `Wallet ${S.split.targetWallets.length + 1}` });
      inp.value = '';
      await saveState(); render();
    } else showToast('Enter a valid Solana address');

  } else if (a === 'remove-target-wallet') {
    S.split.targetWallets = S.split.targetWallets.filter(w => w.id !== el.dataset.walletId);
    await saveState(); render();

  } else if (a === 'execute-split') {
    await executeSplit();

  } else if (a === 'refresh-balances') {
    const addrs = [S.split.sourceWallet, ...S.split.targetWallets.map(w => w.address)].filter(Boolean);
    await refreshBalances(addrs);

  } else if (a === 'toggle-history') {
    const id = el.dataset.histId;
    S.split.historyExpanded[id] = !S.split.historyExpanded[id];
    await saveState(); render();

  } else if (a === 'toggle-hist-key') {
    const box = document.getElementById(el.dataset.keyId);
    if (box) { box.classList.toggle('hidden'); el.textContent = box.classList.contains('hidden') ? '⚠ Private Key' : '▲ Hide'; }

  } else if (a === 'toggle-gen-key') {
    const box = document.getElementById(el.dataset.keyId);
    if (box) { box.classList.toggle('hidden'); el.textContent = box.classList.contains('hidden') ? '⚠ Show Private Key' : '▲ Hide'; }

  } else if (a === 'export-history') {
    const _eid = el.dataset.histId;
    const rec = S.split.history.find(h => h.id === _eid) || (S.split.auto.history||[]).find(h => h.id === _eid);
    if (rec) {
      const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: `split-${rec.id}.json` }).click();
      URL.revokeObjectURL(url);
    }

  } else if (a === 'delete-history') {
    const _did = el.dataset.histId;
    S.split.history = S.split.history.filter(h => h.id !== _did);
    if (S.split.auto.history) S.split.auto.history = S.split.auto.history.filter(h => h.id !== _did);
    delete S.split.historyExpanded[_did];
    await saveState(); render();

  } else if (a === 'auto-mode') {
    const caEl=document.getElementById('auto-ca-filter'), cntEl=document.getElementById('auto-new-count');
    if (caEl) S.split.auto.caFilter=caEl.value.trim();
    if (cntEl) S.split.auto.newWalletCount=parseInt(cntEl.value)||5;
    S.split.auto.mode=el.dataset.mode;
    await saveState(); render();

  } else if (a === 'toggle-auto') {
    const caEl=document.getElementById('auto-ca-filter'), cntEl=document.getElementById('auto-new-count');
    if (caEl) S.split.auto.caFilter=caEl.value.trim();
    if (cntEl) S.split.auto.newWalletCount=parseInt(cntEl.value)||5;
    if (isAutoSplitRunning()) {
      stopAutoSplitWS();
      S.split.auto.wsStatus = null;
      await saveState();
      render();
      showToast('■ Auto-split stopped');
    } else {
      if (!S.split.auto.sourcePrivKey) { showToast('Select a buying wallet first'); return; }
      startAutoSplitWS({
        sourcePrivKey:  S.split.auto.sourcePrivKey,
        caFilter:       S.split.auto.caFilter || '',
        mode:           S.split.auto.mode,
        targetWallets:  S.split.auto.targetWallets || [],
        newWalletCount: S.split.auto.newWalletCount || 5,
        deviation:      S.split.auto.deviation || 0,
        keepSource:     S.split.auto.keepSource || false,
        oneTime:        S.split.auto.oneTime    || false,
      });
      // Render immediately — isAutoSplitRunning() is now true
      await saveState();
      render();
      showToast('▶ Auto-split started');
    }

  // ── Compact source picker ──
  } else if (a === 'sp-src-toggle') {
    const key = el.dataset.key;
    if (!S.split._srcOpen) S.split._srcOpen = {};
    S.split._srcOpen[key] = !S.split._srcOpen[key];
    render();

  } else if (a === 'sp-src-pick') {
    const key = el.dataset.key;
    const priv = decodeURIComponent(el.dataset.priv||'');
    if (key==='split') { S.split.sourceWallet = priv; S.split.sourceTokens = []; S.split.tokenCA = ''; }
    else S.split.auto.sourcePrivKey = priv;
    if (!S.split._srcOpen) S.split._srcOpen={};
    S.split._srcOpen[key] = false;
    await saveState(); render();

  } else if (a === 'sp-src-paste') {
    const key = el.dataset.key;
    const inp = document.getElementById('sp-paste-'+key);
    const val = inp?.value?.trim();
    if (!val) { showToast('Paste a private key'); return; }
    if (key==='split') { S.split.sourceWallet=val; S.split.sourceTokens=[]; S.split.tokenCA=''; }
    else S.split.auto.sourcePrivKey=val;
    if (!S.split._srcOpen) S.split._srcOpen={};
    S.split._srcOpen[key]=false;
    await saveState(); render();

  // ── Compact target picker ──
  } else if (a === 'sp-tgt-toggle') {
    const key = el.dataset.key;
    if (!S.split._tgtOpen) S.split._tgtOpen={};
    S.split._tgtOpen[key] = !S.split._tgtOpen[key];
    render();

  } else if (a === 'sp-tgt-wallet') {
    const key=el.dataset.key, pub=el.dataset.pub;
    if (key==='split') {
      const idx = (S.split.targetWallets||[]).findIndex(t=>t.address===pub);
      if (idx>=0) S.split.targetWallets.splice(idx,1); else { S.split.targetWallets=S.split.targetWallets||[]; S.split.targetWallets.push({address:pub}); }
    } else {
      S.split.auto.targetWallets=S.split.auto.targetWallets||[];
      const idx=S.split.auto.targetWallets.indexOf(pub);
      if (idx>=0) S.split.auto.targetWallets.splice(idx,1); else S.split.auto.targetWallets.push(pub);
    }
    await saveState(); render();

  } else if (a === 'sp-tgt-group') {
    const key=el.dataset.key, gid=el.dataset.gid;
    const gW=(S.savedWallets||[]).filter(w=>w.groupId===gid&&w.publicKey);
    if (key==='split') {
      const allSel=gW.every(w=>(S.split.targetWallets||[]).find(t=>t.address===w.publicKey));
      if (allSel) S.split.targetWallets=(S.split.targetWallets||[]).filter(t=>!gW.find(w=>w.publicKey===t.address));
      else { S.split.targetWallets=S.split.targetWallets||[]; gW.forEach(w=>{if(!S.split.targetWallets.find(t=>t.address===w.publicKey))S.split.targetWallets.push({address:w.publicKey});}); }
    } else {
      S.split.auto.targetWallets=S.split.auto.targetWallets||[];
      const allSel=gW.every(w=>S.split.auto.targetWallets.includes(w.publicKey));
      if (allSel) S.split.auto.targetWallets=S.split.auto.targetWallets.filter(a=>!gW.find(w=>w.publicKey===a));
      else gW.forEach(w=>{if(!S.split.auto.targetWallets.includes(w.publicKey))S.split.auto.targetWallets.push(w.publicKey);});
    }
    await saveState(); render();

  } else if (a === 'sp-tgt-paste') {
    const key=el.dataset.key;
    const inp=document.getElementById('sp-tgt-paste-'+key);
    const addr=inp?.value?.trim();
    if (!addr||addr.length<32) { showToast('Enter a valid address'); return; }
    if (key==='split') { S.split.targetWallets=S.split.targetWallets||[]; if(!S.split.targetWallets.find(t=>t.address===addr))S.split.targetWallets.push({address:addr}); }
    else { S.split.auto.targetWallets=S.split.auto.targetWallets||[]; if(!S.split.auto.targetWallets.includes(addr))S.split.auto.targetWallets.push(addr); }
    inp.value=''; await saveState(); render();

  } else if (a === 'split-toggle-keep') {
    S.split.keepSource = !S.split.keepSource;
    await saveState(); render();

  } else if (a === 'auto-toggle-keep') {
    S.split.auto.keepSource = !S.split.auto.keepSource;
    await saveState(); render();

  } else if (a === 'auto-toggle-onetime') {
    S.split.auto.oneTime = !S.split.auto.oneTime;
    await saveState(); render();

  } else if (a === 'split-clear-result') {
    S.split.lastResult=null; await saveState(); render();

  } else if (a === 'split-refresh-tokens') {
    const sp = S.split;
    if (!sp.sourceWallet) { showToast('Select a source wallet first'); return; }
    sp.tokensLoading = true; sp.sourceTokens = []; render();
    try {
      const privBytes = bs58decode(sp.sourceWallet.trim());
      const pubkey    = bs58encode(privBytes.slice(32, 64));
      const tokens    = await fetchWalletTokens(pubkey);
      sp.sourceTokens  = tokens;
      sp.tokensLoading = false;
      if (tokens.length === 0) showToast('No tokens found in this wallet');
    } catch (e) {
      sp.tokensLoading = false;
      showToast('Could not load tokens: ' + e.message);
    }
    await saveState(); render();

  } else if (a === 'split-pick-token') {
    S.split.tokenCA = el.dataset.mint;
    await saveState(); render();

  } else if (a === 'show-help') {
    showHelp(el.id, el.dataset.title||'Info', el.dataset.body||'');

  } else if (a === 'run-bundle') {
    const ca = document.getElementById('bundle-ca')?.value?.trim();
    if (!ca || ca.length < 32) { showToast('Enter a valid token CA'); return; }
    S.bundle.ca = ca; S.bundle.loading = true; S.bundle.error = ''; S.bundle.result = null;
    render();
    try {
      const result = await analyzeBundles(ca, (p) => {
        S.bundle.progress = p;
        const bar = document.querySelector('.loading-bar');
        const step = document.querySelector('.loading-step');
        const pct = document.querySelector('.loading-pct');
        if (bar) bar.style.width = p.pct + '%';
        if (step) step.textContent = p.step;
        if (pct) pct.textContent = p.pct + '%';
      });
      S.bundle.result = result;
      S.bundle.loading = false;
      S.bundle.view = 'token-result';
    } catch (err) {
      S.bundle.error = err.message || 'Analysis failed';
      S.bundle.loading = false;
    }
    await saveState(); render();

  } else if (a === 'bundle-back') {
    S.bundle.view = 'landing';
    await saveState(); render();

  } else if (a === 'bundle-clear-result') {
    S.bundle.result = null; S.bundle.error = ''; S.bundle.view = 'landing';
    await saveState(); render();

  } else if (a === 'bundle-clear-wallet') {
    S.bundle.walletResult = null; S.bundle.walletError = ''; S.bundle.view = 'landing';
    await saveState(); render();

  } else if (a === 'bundle-clear') {
    S.bundle.result = null; S.bundle.walletResult = null; S.bundle.error = '';
    S.bundle.walletError = ''; S.bundle.ca = ''; S.bundle.view = 'landing';
    await saveState(); render();

  // ── Wallet checker picker ──
  } else if (a === 'bc-wallet-toggle') {
    S.bundle._walletPickerOpen = !S.bundle._walletPickerOpen;
    render();

  } else if (a === 'bc-wallet-pick') {
    const pub = el.dataset.pub;
    if (!S.bundle.walletAddresses) S.bundle.walletAddresses = [];
    const idx = S.bundle.walletAddresses.indexOf(pub);
    if (idx >= 0) S.bundle.walletAddresses.splice(idx, 1);
    else S.bundle.walletAddresses.push(pub);
    await saveState(); render();

  } else if (a === 'bc-wallet-group') {
    const gid = el.dataset.gid;
    const gW = (S.savedWallets || []).filter(w => w.groupId === gid && w.publicKey);
    if (!S.bundle.walletAddresses) S.bundle.walletAddresses = [];
    const allSel = gW.every(w => S.bundle.walletAddresses.includes(w.publicKey));
    if (allSel) S.bundle.walletAddresses = S.bundle.walletAddresses.filter(a => !gW.find(w => w.publicKey === a));
    else gW.forEach(w => { if (!S.bundle.walletAddresses.includes(w.publicKey)) S.bundle.walletAddresses.push(w.publicKey); });
    await saveState(); render();

  } else if (a === 'bc-wallet-paste') {
    const inp = document.getElementById('bc-paste-addr');
    const addr = inp?.value?.trim();
    if (!addr || addr.length < 32) { showToast('Enter a valid address'); return; }
    if (!S.bundle.walletAddresses) S.bundle.walletAddresses = [];
    if (!S.bundle.walletAddresses.includes(addr)) S.bundle.walletAddresses.push(addr);
    inp.value = '';
    await saveState(); render();

  } else if (a === 'bc-wallet-remove') {
    const idx = parseInt(el.dataset.idx);
    if (!isNaN(idx)) S.bundle.walletAddresses.splice(idx, 1);
    await saveState(); render();

  } else if (a === 'run-wallet-check') {
    const addrs = S.bundle.walletAddresses || [];
    if (addrs.length < 2) { showToast('Select at least 2 wallets'); return; }
    S.bundle.walletLoading = true; S.bundle.walletError = ''; S.bundle.walletResult = null;
    render();
    try {
      const result = await analyzeWalletConnections(addrs, (p) => {
        S.bundle.walletProgress = p;
        const bar = document.querySelector('.loading-bar');
        const step = document.querySelector('.loading-step');
        const pct = document.querySelector('.loading-pct');
        if (bar) bar.style.width = p.pct + '%';
        if (step) step.textContent = p.step;
        if (pct) pct.textContent = p.pct + '%';
      });
      S.bundle.walletResult = result;
      S.bundle.walletLoading = false;
      S.bundle.view = 'wallet-result';
    } catch (err) {
      S.bundle.walletError = err.message || 'Check failed';
      S.bundle.walletLoading = false;
    }
    await saveState(); render();

  } else if (a === 'nav-pick-color') {
    openNavColorPicker(el.dataset.tool, el);

  } else if (a === 'copy') {
    copyText(el.dataset.copy || el.textContent.trim());

  } else if (a === 'open-picker') {
    openWalletPicker(el.dataset.field);

  } else if (a === 'google-signin') {
    await handleGoogleSignIn();

  } else if (a === 'google-signout') {
    await handleGoogleSignOut();

  } else if (a === 'add-saved-wallet') {
    const newW = { id: uid(), name: '', emoji: '💼', privateKey: '' };
    S.savedWallets.push(newW);
    S.settings.editingWalletId = newW.id;
    await saveState(); render();

  } else if (a === 'edit-saved-wallet') {
    S.settings.editingWalletId = el.dataset.walletId; render();

  } else if (a === 'cancel-wallet-edit') {
    S.savedWallets = S.savedWallets.filter(w => w.name || w.privateKey);
    S.settings.editingWalletId = null;
    await saveState(); render();

  } else if (a === 'save-wallet-edit') {
    const id = el.dataset.walletId;
    const w = S.savedWallets.find(x => x.id === id);
    if (w) {
      const name = document.getElementById(`sw-name-${id}`)?.value?.trim();
      const priv = document.getElementById(`sw-priv-${id}`)?.value?.trim();
      if (!name && !priv) { showToast('Add a name or private key'); return; }
      w.name = name || w.name;
      w.privateKey = priv !== undefined ? priv : w.privateKey;
      S.settings.editingWalletId = null;
      await saveState(); render();
      showToast(`✓ ${w.emoji} ${w.name || 'Wallet'} saved`);
    }

  } else if (a === 'delete-saved-wallet') {
    const id = el.dataset.walletId;
    const w = S.savedWallets.find(x => x.id === id);
    S.savedWallets = S.savedWallets.filter(x => x.id !== id);
    if (S.settings.editingWalletId === id) S.settings.editingWalletId = null;
    await saveState(); render();
    showToast(`Deleted ${w?.name || 'wallet'}`);

  } else if (a === 'open-emoji') {
    openEmojiPicker(el.dataset.walletId);

  } else if (a === 'save-rpc') {
    const val = document.getElementById('rpc-input')?.value?.trim();
    if (val) { S.settings.rpcEndpoint = val; await saveState(); checkRpc(); showToast('✓ RPC saved'); }

  } else if (a === 'save-ws') {
    const val = document.getElementById('ws-input')?.value?.trim();
    S.settings.wsEndpoint = val || '';
    await saveState();
    showToast(val ? '✓ WebSocket endpoint saved' : '✓ WS cleared (deriving from RPC URL)');



  } else if (a.startsWith('vb-')) {
    await handleVolumeBotAction(a, el);


  } else if (a.startsWith('w-') || a.startsWith('wallets-')) {
    await handleWalletAction(a, el);

  } else if (a.startsWith('auth-')) {
    await handleAuthAction(a, el);

  } else if (a === 'logout') {
    await authLogout();

  } else if (a === 'clear-account-prompt') {
    S.settings.showClearConfirm = true; render();

  } else if (a === 'clear-account-cancel') {
    S.settings.showClearConfirm = false; render();

  } else if (a === 'clear-account-confirm') {
    await authClearAccount();
  }
}

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Show loading state immediately so popup doesn't flash blank
  const main = document.getElementById('main');
  if (main) main.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:var(--text-muted)">
      <div class="spinner" style="width:20px;height:20px;border-color:rgba(13,31,74,0.15);border-top-color:var(--navy)"></div>
      <div style="font-size:10px;letter-spacing:0.06em">Loading…</div>
    </div>
  `;

  // Load any locally cached state first (settings, last tool, etc.)
  await loadState();

  // walletSelection is a Set — not JSON-serialisable, always reconstruct
  S.walletSelection = new Set();

  // Try silent auto-login with stored JWT
  // This also calls syncWalletsFromServer() which pulls down all
  // wallets, private keys (encrypted), groups, and settings
  await tryAutoLogin();

  // First render — if not logged in shows login screen,
  // if logged in shows last active tool with all data loaded
  render();
  checkRpc();
  setInterval(checkRpc, 30000);

  // Poll for auto-split triggers from background worker
  setInterval(() => {
    chrome.storage.local.get('udt_v3', ({ udt_v3 }) => {
      if (!udt_v3) return;
      const triggers = udt_v3.split?.autoTriggers || [];
      if (JSON.stringify(triggers) !== JSON.stringify(S.split.autoTriggers)) {
        S.split.autoTriggers = triggers; render();
      }
    });
  }, 5000);
});