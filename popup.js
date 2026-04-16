/* ═══════════════════════════════════════════
   popup.js — Main App
   Essor Studios / Ultimate Dev Tools
═══════════════════════════════════════════ */

'use strict';

const RPC         = 'https://api.mainnet-beta.solana.com';
const DEFAULT_RPC = 'https://mainnet.helius-rpc.com/?api-key=9f6bffea-73da-4936-adab-429746a1b007';
const DEFAULT_WS  = 'wss://mainnet.helius-rpc.com/?api-key=9f6bffea-73da-4936-adab-429746a1b007';

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
    // tab: 'check' | 'create' | 'history'
    createTab: 'check',
    ca: '',
    walletAddresses: [],
    _walletPickerOpen: false,
    _pastedWallet: '',
    view: 'landing',
    result: null,
    loading: false,
    progress: { step: '', pct: 0 },
    error: '',
    walletResult: null,
    walletLoading: false,
    walletProgress: { step: '', pct: 0 },
    walletError: '',
    scroll: 0,
    // Create bundle sub-state
    create: {
      sourceWalletId: '',
      walletCount: 5,
      totalSol: '',
      maxSolPerWallet: '',
      distribMode: 'equal',
      addToGroup: false,
      groupName: '',
      running: false,
      runStep: '',
      runPct: 0,
      error: '',
    },
    createResult: null,
    createHistory: [],
    historyExpanded: {},
    historyKeyVis: {},
    createKeyVis: {},
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
// STORAGE  (website — uses localStorage)
// ─────────────────────────────────────────
async function saveState() {
  try { localStorage.setItem('udt_v3', JSON.stringify(S)); } catch {}
  // Server sync is handled by dashboard.html's saveState wrapper
}

async function loadState() {
  try {
    const raw = localStorage.getItem('udt_v3');
    if (raw) S = deepMerge(S, JSON.parse(raw));
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
  if (!window.isSecureContext) {
    throw new Error('Key generation requires HTTPS or localhost.');
  }

  if (!crypto?.subtle?.generateKey) {
    throw new Error('Web Crypto API is not available in this browser.');
  }

  const kp = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  );

  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const seed = privPkcs8.slice(16, 48);

  const fullPriv = new Uint8Array(64);
  fullPriv.set(seed);
  fullPriv.set(pubRaw, 32);

  return {
    publicKey: bs58encode(pubRaw),
    privateKey: bs58encode(fullPriv),
  };
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

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast('Copied!');
  } catch (err) {
    console.error('Copy failed:', err);
    showToast('Copy failed');
  }
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
      else if (targetField === 'bundle-source-wallet') {
        if (!S.bundle.create) S.bundle.create = {};
        S.bundle.create.sourceWalletId = w.id;
      }
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
    label: 'Bundle',
    svg: `<svg class="nav-svg" width="13" height="13" viewBox="0 0 13 13" fill="none">
      <rect x="1" y="4.5" width="11" height="7" rx="1.3" stroke="currentColor" stroke-width="1.2"/>
      <path d="M1 7h11" stroke="currentColor" stroke-width="1.1" opacity="0.5"/>
      <path d="M4.5 4.5V3a2 2 0 0 1 4 0v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      <path d="M5 7l1 1.5 2-2.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
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
          HTTP RPC for balance checks and transactions. Leave blank to use the default.
        </p>
        <input type="text" id="rpc-input" value="${S.settings.rpcEndpoint === DEFAULT_RPC ? '' : S.settings.rpcEndpoint}" placeholder="Default"/>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn btn-ghost btn-sm" data-action="save-rpc">Save</button>
          <button class="btn btn-secondary btn-sm" data-action="reset-rpc">Reset to Default</button>
        </div>
      </div>

      <!-- WebSocket -->
      <div class="settings-section">
        <div class="settings-section-title">WebSocket Endpoint <span style="font-size:9px;font-weight:400;color:var(--text-muted)">(for Auto-Split)</span></div>
        <p style="font-size:10px;color:var(--text-muted);margin-bottom:8px;line-height:1.5">
          For real-time buy detection. Leave blank to use the default. Falls back to polling on failure.
        </p>
        <input type="text" id="ws-input" value="${(S.settings.wsEndpoint && S.settings.wsEndpoint !== DEFAULT_WS) ? S.settings.wsEndpoint : ''}" placeholder="Default"/>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn btn-ghost btn-sm" data-action="save-ws">Save</button>
          <button class="btn btn-secondary btn-sm" data-action="reset-ws">Reset to Default</button>
        </div>
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

  const sBtn = document.getElementById('settings-nav-btn');
  if (sBtn) sBtn.onclick = () => { S.activeTool = 'settings'; saveState(); render(); };


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
    S.settings.rpcEndpoint = val || DEFAULT_RPC;
    await saveState(); checkRpc(); showToast('✓ RPC saved');

  } else if (a === 'reset-rpc') {
    S.settings.rpcEndpoint = DEFAULT_RPC;
    await saveState(); checkRpc(); showToast('✓ RPC reset to default'); render();

  } else if (a === 'save-ws') {
    const val = document.getElementById('ws-input')?.value?.trim();
    S.settings.wsEndpoint = val || DEFAULT_WS;
    await saveState();
    showToast(val ? '✓ WebSocket endpoint saved' : '✓ WS reset to default');

  } else if (a === 'reset-ws') {
    S.settings.wsEndpoint = DEFAULT_WS;
    await saveState(); showToast('✓ WebSocket reset to default'); render();



  } else if (a === 'bundle-tab') {
    S.bundle.createTab = el.dataset.tab;
    await saveState(); render();

  // ── Create Bundle controls ──
  } else if (a === 'cb-set-distrib') {
    if (!S.bundle.create) S.bundle.create = {};
    S.bundle.create.distribMode = el.dataset.mode;
    await saveState(); render();

  } else if (a === 'cb-toggle-group') {
    if (!S.bundle.create) S.bundle.create = {};
    S.bundle.create.addToGroup = !S.bundle.create.addToGroup;
    await saveState(); render();

  } else if (a === 'cb-run') {
    if (!S.bundle.create) S.bundle.create = {};
    // Snapshot current field values before re-render
    const cnt  = document.getElementById('cb-wallet-count')?.value;
    const sol  = document.getElementById('cb-total-sol')?.value;
    const mxs  = document.getElementById('cb-max-sol')?.value;
    const grpN = document.getElementById('cb-group-name')?.value;
    if (cnt)  S.bundle.create.walletCount      = parseInt(cnt);
    if (sol)  S.bundle.create.totalSol         = sol;
    if (mxs !== undefined) S.bundle.create.maxSolPerWallet = mxs;
    if (grpN !== undefined) S.bundle.create.groupName = grpN;
    S.bundle.create.running = true;
    S.bundle.create.error   = '';
    S.bundle.create.runStep = 'Starting…';
    S.bundle.create.runPct  = 0;
    render();
    try {
      const result = await runCreateBundle();
      S.bundle.create.running  = false;
      S.bundle.createResult    = result;
      S.bundle.createKeyVis    = {};
      S.bundle.view            = 'create-result';
    } catch (err) {
      S.bundle.create.running = false;
      S.bundle.create.error   = err.message || 'Bundle creation failed';
    }
    await saveState(); render();

  } else if (a === 'cb-copy-all-keys') {
    const r = S.bundle.createResult;
    if (r?.wallets) {
      copyText(r.wallets.map(w => w.privateKey).join('\n'));
      showToast('✓ All private keys copied');
    }

  } else if (a === 'cb-copy-all-addrs') {
    const r = S.bundle.createResult;
    if (r?.wallets) {
      copyText(r.wallets.map(w => w.publicKey).join('\n'));
      showToast('✓ All addresses copied');
    }

  } else if (a === 'cr-toggle-key') {
    const idx = parseInt(el.dataset.idx);
    if (!S.bundle.createKeyVis) S.bundle.createKeyVis = {};
    S.bundle.createKeyVis[idx] = !S.bundle.createKeyVis[idx];
    render();

  // ── History ──
  } else if (a === 'bh-toggle') {
    if (!S.bundle.historyExpanded) S.bundle.historyExpanded = {};
    const id = el.dataset.id;
    S.bundle.historyExpanded[id] = !S.bundle.historyExpanded[id];
    await saveState(); render();

  } else if (a === 'bh-toggle-key') {
    const key = `${el.dataset.id}-${el.dataset.idx}`;
    if (!S.bundle.historyKeyVis) S.bundle.historyKeyVis = {};
    S.bundle.historyKeyVis[key] = !S.bundle.historyKeyVis[key];
    render();

  } else if (a === 'bh-copy-all-keys') {
    const entry = (S.bundle.createHistory||[]).find(e => e.id === el.dataset.id);
    if (entry?.wallets) { copyText(entry.wallets.map(w => w.privateKey).join('\n')); showToast('✓ All private keys copied'); }

  } else if (a === 'bh-copy-all-addrs') {
    const entry = (S.bundle.createHistory||[]).find(e => e.id === el.dataset.id);
    if (entry?.wallets) { copyText(entry.wallets.map(w => w.publicKey).join('\n')); showToast('✓ All addresses copied'); }

  } else if (a === 'bh-delete') {
    S.bundle.createHistory = (S.bundle.createHistory||[]).filter(e => e.id !== el.dataset.id);
    await saveState(); render(); showToast('Bundle deleted');

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
async function bootApp() {
  const main = document.getElementById('main');
  if (main) {
    main.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:var(--text-muted)">
        <div class="spinner" style="width:20px;height:20px;border-color:rgba(13,31,74,0.15);border-top-color:var(--navy)"></div>
        <div style="font-size:10px;letter-spacing:0.06em">Loading…</div>
      </div>
    `;
  }

  await loadState();

  // Set is not JSON-serialisable
  S.walletSelection = new Set();

  await tryAutoLogin();

  render();
  checkRpc();
  setInterval(checkRpc, 30000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootApp);
} else {
  bootApp();
}