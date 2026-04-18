/* ═══════════════════════════════════════════
   wallets.js — Wallet Manager
   Essor Studios / Solana Dev Tools
   Axiom-style: clean cards, groups, drag & drop,
   inline rename, copy address, SOL balance
═══════════════════════════════════════════ */

'use strict';

const WALLET_EMOJIS = [
  '💼','💎','🔥','🚀','⚡','🐋','🦊','🎯','🌙','💰',
  '🏆','🦁','🦅','🔮','🛡️','⭐','🌊','🎪','🐯','🤖'
];

// ── Helpers ────────────────────────────────
function wShort(addr) {
  if (!addr || addr.length < 10) return '—';
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

function wDeriveAddress(privKey) {
  if (!privKey) return null;
  try {
    const bytes = bs58decode(privKey.trim());
    if (bytes.length === 64) return bs58encode(bytes.slice(32, 64));
    return null;
  } catch { return null; }
}

async function wFetchSol(address) {
  if (!address) return null;
  try {
    const rpc = (typeof S !== 'undefined' && S.settings?.rpcEndpoint) || 'https://api.mainnet-beta.solana.com';
    const r = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] })
    });
    const j = await r.json();
    if (j.result?.value != null) return (j.result.value / 1e9).toFixed(4);
    return null;
  } catch { return null; }
}

// ── State helpers ──────────────────────────
function wState() {
  if (!S.wallets) S.wallets = { editingId: null, confirmDeleteId: null, scroll: 0, dragId: null };
  if (!S.savedWallets) S.savedWallets = [];
  if (!S.walletGroups) S.walletGroups = [];
  if (!S.walletSelection) S.walletSelection = new Set();
  return S.wallets;
}

function wIsSelected(id) {
  return S.walletSelection?.has(id) || false;
}

// ── Page builder ───────────────────────────
function buildWalletsPage() {
  wState();
  const wallets = S.savedWallets;
  const groups  = S.walletGroups;
  const selCount = S.walletSelection?.size || 0;

  const ungrouped = wallets.filter(w => !w.groupId);

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Wallets</span>
        <div style="display:flex;align-items:center;gap:6px">
          ${selCount > 0 ? `<span class="sel-count-badge">${selCount} selected</span>` : ''}
          <button class="refresh-btn" id="w-refresh-btn" title="Refresh SOL balances">↻</button>
        </div>
      </div>
      <div class="tool-sub-row">
        <span class="tool-subtitle">${wallets.length} wallet${wallets.length !== 1 ? 's' : ''}</span>
      </div>
    </div>

    <div class="scroll-area" id="scroll-area">

      ${wallets.length === 0 && groups.length === 0 ? `
        <div class="empty-state" style="padding:30px 20px">
          <div class="empty-icon">💼</div>
          <div class="empty-text">No wallets yet.<br>Generate one or add a private key below.</div>
        </div>
      ` : ''}

      <!-- Ungrouped wallets -->
      <div id="w-ungrouped-list"
        class="w-drop-zone"
        data-group-id="none">
        ${ungrouped.map(w => buildWCard(w)).join('')}
        ${ungrouped.length === 0 && groups.length > 0 ? '' : ''}
      </div>

      <!-- Groups -->
      ${groups.map(g => buildWGroup(g, wallets.filter(w => w.groupId === g.id))).join('')}

      <div class="section-divider" style="margin:12px 0 10px"></div>

      <!-- Add wallet -->
      <div class="w-add-panel">
        <div class="section-hdr">Add Wallet</div>

        <div class="grid-2" style="margin-bottom:8px">
          <div class="field">
            <div class="field-label">Name</div>
            <input type="text" id="w-new-name" placeholder="e.g. Main, Dev…" maxlength="24"/>
          </div>
          <div class="field">
            <div class="field-label">Emoji</div>
            <div class="w-emoji-pick-row">
              <span class="w-emoji-btn" id="w-new-emoji-display" data-action="w-pick-emoji" data-target="w-new-emoji-val">💼</span>
              <input type="hidden" id="w-new-emoji-val" value="💼"/>
            </div>
          </div>
        </div>

        <div class="field">
          <div class="field-label">Private Key <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-muted)">(base58)</span></div>
          <input type="password" id="w-new-priv" placeholder="Paste private key to import…" autocomplete="off"/>
        </div>

        <div class="w-add-btns">
          <button class="btn btn-primary btn-sm" style="flex:1" id="w-add-btn">+ Import Key</button>
          <button class="btn btn-ghost btn-sm" id="w-gen-btn">⚡ Generate</button>
        </div>
      </div>

      <!-- New group -->
      <button class="btn btn-secondary btn-sm btn-full" style="margin-top:8px" id="w-new-group-btn">
        📁 New Group
      </button>

    </div>

    <!-- Emoji picker overlay -->
    <div id="w-emoji-overlay" style="display:none;position:fixed;inset:0;z-index:200;background:rgba(13,31,74,0.3);display:none;align-items:center;justify-content:center">
      <div style="background:var(--surface);border:1px solid var(--border-md);border-radius:10px;padding:12px;box-shadow:0 8px 32px rgba(13,31,74,0.2)">
        <div style="font-size:10px;font-weight:600;color:var(--navy);margin-bottom:8px;letter-spacing:0.04em">PICK EMOJI</div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px">
          ${WALLET_EMOJIS.map(e => `<button class="w-emoji-grid-btn" data-emoji="${e}">${e}</button>`).join('')}
        </div>
        <button style="margin-top:8px;width:100%;font-size:10px;background:none;border:1px solid var(--border-md);border-radius:4px;padding:4px;cursor:pointer;color:var(--text-muted)" id="w-emoji-close">Cancel</button>
      </div>
    </div>
  `;
}

function buildWGroup(group, wallets) {
  const ws   = S.wallets;
  const open = !group.collapsed;
  const allSel = wallets.length > 0 && wallets.every(w => wIsSelected(w.id));
  const someSel = !allSel && wallets.some(w => wIsSelected(w.id));

  return `
    <div class="w-group" id="wg-${group.id}" data-group-id="${group.id}">
      <div class="w-group-header">
        <button class="w-group-chevron ${open ? 'open' : ''}" data-action="w-toggle-group" data-group-id="${group.id}">›</button>
        <div class="w-group-sel ${allSel ? 'checked' : someSel ? 'partial' : ''}"
          data-action="w-select-group" data-group-id="${group.id}"></div>
        <span class="w-group-emoji" data-action="w-group-emoji" data-group-id="${group.id}">${group.emoji || '📁'}</span>
        <input class="w-group-name-input" type="text" value="${group.name || 'Group'}"
          data-action="w-rename-group" data-group-id="${group.id}" maxlength="30"/>
        <span class="w-group-count">${wallets.length}</span>
        <button class="w-group-delete" data-action="w-delete-group" data-group-id="${group.id}" title="Delete group">✕</button>
      </div>
      ${open ? `
        <div class="w-group-body w-drop-zone" data-group-id="${group.id}" id="wgb-${group.id}">
          ${wallets.length === 0
            ? `<div class="w-group-empty">Drop wallets here</div>`
            : wallets.map(w => buildWCard(w, true)).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function buildWCard(w, inGroup = false) {
  const ws      = S.wallets;
  const sel     = wIsSelected(w.id);
  const editing = ws?.editingId === w.id;
  const confirmDel = ws?.confirmDeleteId === w.id;
  const addr    = w.publicKey || '';
  const short   = addr ? wShort(addr) : '—';
  const sol     = (w.solBalance !== null && w.solBalance !== undefined) ? w.solBalance + ' SOL' : '···';

  return `
    <div class="w-card ${sel ? 'w-card-sel' : ''} ${inGroup ? 'w-card-ingroup' : ''} ${confirmDel ? 'w-card-deleting' : ''}"
      id="wc-${w.id}"
      draggable="true"
      data-wallet-id="${w.id}">

      <div class="w-card-drag">⠿</div>

      <div class="w-card-check ${sel ? 'checked' : ''}"
        data-action="w-toggle-sel" data-wallet-id="${w.id}"></div>

      <div class="w-card-emoji" data-action="w-change-emoji" data-wallet-id="${w.id}">${w.emoji || '💼'}</div>

      <div class="w-card-body">
        ${editing
          ? `<input class="w-card-name-input" id="w-edit-name-${w.id}"
               type="text" value="${(w.name || '').replace(/"/g, '&quot;')}"
               placeholder="Wallet name…" maxlength="24"
               data-wallet-id="${w.id}"/>`
          : `<div class="w-card-name" data-action="w-start-edit" data-wallet-id="${w.id}">${w.name || 'Wallet'}</div>`
        }
        <div class="w-card-addr-row">
          ${addr
            ? `<span class="w-card-addr">${short}</span>
               <button class="w-card-copy" data-action="w-copy-addr" data-copy="${addr}" title="Copy address">⧉</button>`
            : `<span class="w-card-addr" style="color:var(--danger);font-size:9px">No address</span>`
          }
          <span class="w-card-sol">${sol}</span>
        </div>
      </div>

      <div class="w-card-actions">
        ${editing ? `
          <button class="w-action-btn w-save-btn" data-action="w-save-edit" data-wallet-id="${w.id}">✓</button>
          <button class="w-action-btn" data-action="w-cancel-edit" data-wallet-id="${w.id}">✕</button>
        ` : confirmDel ? `
          <span style="font-size:9px;color:var(--danger);font-weight:700;white-space:nowrap">Delete?</span>
          <button class="w-action-btn w-save-btn" data-action="w-confirm-del" data-wallet-id="${w.id}" title="Yes, delete">✓</button>
          <button class="w-action-btn" data-action="w-cancel-del" data-wallet-id="${w.id}" title="Cancel">✕</button>
        ` : `
          <button class="w-action-btn w-key-btn" data-action="w-copy-key" data-wallet-id="${w.id}" title="Copy private key">🔑</button>
          <button class="w-action-btn w-del-btn" data-action="w-delete" data-wallet-id="${w.id}" title="Delete">🗑</button>
        `}
      </div>
    </div>
  `;
}

// ── Event handler (called from popup.js dispatch) ──
async function handleWalletAction(a, el) {
  wState();

  // ── Add by private key ──
  if (a === 'w-add' || el?.id === 'w-add-btn') {
    const nameEl  = document.getElementById('w-new-name');
    const privEl  = document.getElementById('w-new-priv');
    const emojiEl = document.getElementById('w-new-emoji-val');

    const name  = (nameEl?.value || '').trim() || 'Wallet';
    const priv  = (privEl?.value || '').trim();
    const emoji = emojiEl?.value || '💼';

    if (!priv) { showToast('Paste a private key first'); return; }

    const pub = wDeriveAddress(priv);
    if (!pub) { showToast('Invalid key — needs a 64-byte base58 Solana private key'); return; }
    if (S.savedWallets.find(w => w.publicKey === pub)) { showToast('Wallet already saved'); return; }

    const w = { id: uid(), name, emoji, privateKey: priv, publicKey: pub, solBalance: null, groupId: null };
    S.savedWallets.push(w);
    if (privEl) privEl.value = '';
    if (nameEl) nameEl.value = '';
    await saveState();
    render();
    showToast(`✓ ${emoji} ${name} added`);
    syncWalletsToServer().catch(() => {});
    wFetchSol(pub).then(bal => {
      const fw = S.savedWallets.find(x => x.id === w.id);
      if (fw && bal !== null) { fw.solBalance = bal; saveState(); render(); }
    }).catch(() => {});
    return;
  }

  // ── Generate new wallet ──
  if (a === 'w-gen' || el?.id === 'w-gen-btn') {
    const nameEl  = document.getElementById('w-new-name');
    const emojiEl = document.getElementById('w-new-emoji-val');
    const name  = (nameEl?.value || '').trim() || 'Wallet';
    const emoji = emojiEl?.value || '💼';
    try {
      const kp = await generateKeypair();
      const w  = { id: uid(), name, emoji, privateKey: kp.privateKey, publicKey: kp.publicKey, solBalance: null, groupId: null };
      S.savedWallets.push(w);
      if (nameEl) nameEl.value = '';
      await saveState();
      render();
      showToast(`✓ ${emoji} ${name} generated`);
      syncWalletsToServer().catch(() => {});
    } catch (e) { showToast('Key generation failed: ' + e.message); }
    return;
  }

  // ── Refresh all SOL balances ──
  if (a === 'w-refresh' || el?.id === 'w-refresh-btn') {
    const btn = document.getElementById('w-refresh-btn');
    if (btn) btn.classList.add('spinning');
    for (const w of S.savedWallets) {
      if (w.publicKey) {
        const bal = await wFetchSol(w.publicKey);
        if (bal !== null) w.solBalance = bal;
      }
    }
    await saveState();
    if (btn) btn.classList.remove('spinning');
    render();
    return;
  }

  // ── Copy address ──
  if (a === 'w-copy-addr') {
    const addr = el.dataset.copy;
    if (addr) { navigator.clipboard.writeText(addr).then(() => showToast('Address copied!')); }
    return;
  }

  // ── Copy private key ──
  if (a === 'w-copy-key') {
    const w = S.savedWallets.find(x => x.id === el.dataset.walletId);
    if (!w?.privateKey) { showToast('No private key stored'); return; }
    navigator.clipboard.writeText(w.privateKey).then(() => showToast('🔑 Private key copied!'));
    return;
  }

  // ── Select wallet ──
  if (a === 'w-toggle-sel') {
    const id = el.dataset.walletId;
    if (!S.walletSelection) S.walletSelection = new Set();
    if (S.walletSelection.has(id)) S.walletSelection.delete(id);
    else S.walletSelection.add(id);
    render(); return;
  }

  // ── Select entire group ──
  if (a === 'w-select-group') {
    if (!S.walletSelection) S.walletSelection = new Set();
    const gid = el.dataset.groupId;
    const gWallets = S.savedWallets.filter(w => w.groupId === gid);
    const allSel   = gWallets.every(w => S.walletSelection.has(w.id));
    gWallets.forEach(w => allSel ? S.walletSelection.delete(w.id) : S.walletSelection.add(w.id));
    render(); return;
  }

  // ── Inline rename ──
  if (a === 'w-start-edit') {
    S.wallets.editingId = el.dataset.walletId;
    S.wallets.confirmDeleteId = null;
    render();
    // Focus the input after render
    setTimeout(() => {
      const inp = document.getElementById(`w-edit-name-${el.dataset.walletId}`);
      if (inp) { inp.focus(); inp.select(); }
    }, 30);
    return;
  }

  if (a === 'w-save-edit') {
    const id  = el.dataset.walletId;
    const inp = document.getElementById(`w-edit-name-${id}`);
    const w   = S.savedWallets.find(x => x.id === id);
    if (w && inp) w.name = inp.value.trim() || w.name || 'Wallet';
    S.wallets.editingId = null;
    await saveState();
    syncWalletsToServer().catch(() => {});
    render(); return;
  }

  if (a === 'w-cancel-edit') {
    S.wallets.editingId = null;
    render(); return;
  }

  // ── Delete ──
  if (a === 'w-delete') {
    S.wallets.confirmDeleteId = el.dataset.walletId;
    S.wallets.editingId = null;
    render(); return;
  }

  if (a === 'w-confirm-del') {
    const id = el.dataset.walletId;
    S.savedWallets = S.savedWallets.filter(w => w.id !== id);
    S.walletSelection?.delete(id);
    S.wallets.confirmDeleteId = null;
    await saveState();
    syncWalletsToServer().catch(() => {});
    render();
    showToast('Wallet deleted'); return;
  }

  if (a === 'w-cancel-del') {
    S.wallets.confirmDeleteId = null;
    render(); return;
  }

  // ── Change emoji ──
  if (a === 'w-change-emoji' || a === 'w-pick-emoji') {
    const walletId  = el.dataset.walletId || null;
    const groupId   = el.dataset.groupId  || null;
    const targetId  = el.dataset.target   || null;
    wOpenEmojiPicker(walletId, groupId, targetId);
    return;
  }

  // ── Groups ──
  if (a === 'w-new-group' || el?.id === 'w-new-group-btn') {
    S.walletGroups.push({ id: uid(), name: 'New Group', emoji: '📁', collapsed: false });
    await saveState();
    syncWalletsToServer().catch(() => {});
    render(); return;
  }

  if (a === 'w-toggle-group') {
    const g = S.walletGroups.find(x => x.id === el.dataset.groupId);
    if (g) { g.collapsed = !g.collapsed; await saveState(); render(); }
    return;
  }

  if (a === 'w-rename-group') {
    const g = S.walletGroups.find(x => x.id === el.dataset.groupId);
    if (g) { g.name = el.value || 'Group'; saveState(); syncWalletsToServer().catch(() => {}); }
    return;
  }

  if (a === 'w-delete-group') {
    const gid = el.dataset.groupId;
    S.savedWallets.forEach(w => { if (w.groupId === gid) w.groupId = null; });
    S.walletGroups = S.walletGroups.filter(g => g.id !== gid);
    await saveState();
    syncWalletsToServer().catch(() => {});
    render(); return;
  }

  if (a === 'w-group-emoji') {
    wOpenEmojiPicker(null, el.dataset.groupId, null);
    return;
  }
}

// ── Emoji picker ───────────────────────────
let _emojiTarget = null;

function wOpenEmojiPicker(walletId, groupId, targetInputId) {
  _emojiTarget = { walletId, groupId, targetInputId };
  const overlay = document.getElementById('w-emoji-overlay');
  if (overlay) overlay.style.display = 'flex';

  // Attach click handlers to emoji buttons
  document.querySelectorAll('.w-emoji-grid-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const emoji = btn.dataset.emoji;
      await wApplyEmoji(emoji);
    };
  });

  const closeBtn = document.getElementById('w-emoji-close');
  if (closeBtn) closeBtn.onclick = () => {
    const overlay = document.getElementById('w-emoji-overlay');
    if (overlay) overlay.style.display = 'none';
  };

  const overlay2 = document.getElementById('w-emoji-overlay');
  if (overlay2) overlay2.onclick = (e) => {
    if (e.target === overlay2) overlay2.style.display = 'none';
  };
}

async function wApplyEmoji(emoji) {
  const overlay = document.getElementById('w-emoji-overlay');
  if (overlay) overlay.style.display = 'none';

  if (!_emojiTarget) return;
  const { walletId, groupId, targetInputId } = _emojiTarget;

  if (walletId) {
    const w = S.savedWallets.find(x => x.id === walletId);
    if (w) { w.emoji = emoji; await saveState(); syncWalletsToServer().catch(() => {}); render(); }
  } else if (groupId) {
    const g = S.walletGroups.find(x => x.id === groupId);
    if (g) { g.emoji = emoji; await saveState(); syncWalletsToServer().catch(() => {}); render(); }
  } else if (targetInputId) {
    const inp  = document.getElementById(targetInputId);
    const disp = document.getElementById(targetInputId.replace('-val', '-display'));
    if (inp)  inp.value = emoji;
    if (disp) disp.textContent = emoji;
  }
  _emojiTarget = null;
}

// ── Drag & Drop ────────────────────────────
let _dragId = null;

function initWalletDragDrop() {
  const sa = document.getElementById('scroll-area');
  if (!sa) return;

  sa.addEventListener('dragstart', e => {
    const card = e.target.closest('[data-wallet-id][draggable]');
    if (!card) return;
    _dragId = card.dataset.walletId;
    card.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
    // Show all drop zones
    document.querySelectorAll('.w-drop-zone').forEach(z => z.classList.add('w-drop-active'));
  });

  sa.addEventListener('dragend', e => {
    const card = e.target.closest('[data-wallet-id][draggable]');
    if (card) card.style.opacity = '';
    _dragId = null;
    document.querySelectorAll('.w-drop-zone').forEach(z => {
      z.classList.remove('w-drop-active', 'w-drop-over');
    });
  });

  sa.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const zone = e.target.closest('.w-drop-zone');
    document.querySelectorAll('.w-drop-zone').forEach(z => z.classList.remove('w-drop-over'));
    if (zone) zone.classList.add('w-drop-over');
  });

  sa.addEventListener('drop', async e => {
    e.preventDefault();
    if (!_dragId) return;
    const zone = e.target.closest('.w-drop-zone');
    if (!zone) return;

    const targetGroupId = zone.dataset.groupId;
    const w = S.savedWallets.find(x => x.id === _dragId);
    if (!w) return;

    w.groupId = (targetGroupId === 'none') ? null : targetGroupId;
    _dragId = null;

    document.querySelectorAll('.w-drop-zone').forEach(z => z.classList.remove('w-drop-active', 'w-drop-over'));
    await saveState();
    syncWalletsToServer().catch(() => {});
    render();
  });
}

// ── Attach wallet page handlers ────────────
function attachWalletHandlers() {
  // Button IDs → actions
  const btnMap = {
    'w-add-btn':       'w-add',
    'w-gen-btn':       'w-gen',
    'w-refresh-btn':   'w-refresh',
    'w-new-group-btn': 'w-new-group',
  };

  Object.entries(btnMap).forEach(([id, action]) => {
    const btn = document.getElementById(id);
    if (btn) btn.onclick = async (e) => {
      e.stopPropagation();
      await handleWalletAction(action, btn);
    };
  });

  // Group rename inputs — save on blur/enter
  document.querySelectorAll('[data-action="w-rename-group"]').forEach(inp => {
    inp.onclick = e => e.stopPropagation();
    inp.onblur  = async () => await handleWalletAction('w-rename-group', inp);
    inp.onkeydown = async (e) => { if (e.key === 'Enter') { inp.blur(); } };
  });

  // Inline name edit — save on Enter, cancel on Escape
  const editId = S.wallets?.editingId;
  if (editId) {
    const inp = document.getElementById(`w-edit-name-${editId}`);
    if (inp) {
      inp.onkeydown = async (e) => {
        if (e.key === 'Enter')  { await handleWalletAction('w-save-edit',   { dataset: { walletId: editId } }); }
        if (e.key === 'Escape') { await handleWalletAction('w-cancel-edit', { dataset: { walletId: editId } }); }
      };
      inp.onblur = async () => {
        // small delay so save button click registers first
        setTimeout(async () => {
          if (S.wallets?.editingId === editId) {
            await handleWalletAction('w-save-edit', { dataset: { walletId: editId } });
          }
        }, 150);
      };
    }
  }

  // Init drag & drop
  initWalletDragDrop();
}

// ── Wallet picker modal (for use in other tools) ──
function buildWalletPickerModal(onSelect, opts = {}) {
  const wallets = S.savedWallets || [];
  const groups  = S.walletGroups || [];

  const modal = document.getElementById('wallet-picker-modal');
  const box   = document.getElementById('wallet-picker-box');
  if (!modal || !box) return;

  const ungrouped = wallets.filter(w => !w.groupId);

  const renderSection = (label, wList) => {
    if (!wList.length) return '';
    return `
      ${label ? `<div class="section-hdr" style="margin:8px 0 4px">${label}</div>` : ''}
      ${wList.map(w => `
        <div class="picker-wallet-row" data-wallet-id="${w.id}" style="cursor:pointer">
          <span style="font-size:16px">${w.emoji || '💼'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:11px;font-weight:600;color:var(--navy)">${w.name || 'Wallet'}</div>
            <div style="font-family:var(--mono);font-size:9px;color:var(--text-dim)">${wShort(w.publicKey)}</div>
          </div>
          ${w.solBalance != null ? `<span style="font-size:9.5px;color:var(--blue);font-weight:600">${w.solBalance} SOL</span>` : ''}
        </div>
      `).join('')}
    `;
  };

  box.innerHTML = `
    <div style="padding:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <span style="font-size:12px;font-weight:700;color:var(--navy)">${opts.title || 'Select Wallet'}</span>
        <button style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:15px" id="picker-close-btn">✕</button>
      </div>

      ${wallets.length === 0 ? `
        <div style="text-align:center;padding:20px;color:var(--text-muted);font-size:11px">
          No saved wallets. Add some in the Wallets tab first.
        </div>
      ` : `
        ${opts.allowPaste !== false ? `
          <div class="field" style="margin-bottom:10px">
            <div class="field-label">Or paste address directly</div>
            <div style="display:flex;gap:6px">
              <input type="text" id="picker-paste-addr" placeholder="Solana wallet address…" style="flex:1"/>
              <button class="btn btn-ghost btn-sm" id="picker-paste-btn">Use</button>
            </div>
          </div>
        ` : ''}
        ${renderSection('', ungrouped)}
        ${groups.map(g => renderSection(
          `${g.emoji || '📁'} ${g.name}`,
          wallets.filter(w => w.groupId === g.id)
        )).join('')}
      `}
    </div>
  `;

  modal.style.display = 'flex';

  // Close
  document.getElementById('picker-close-btn').onclick = () => modal.style.display = 'none';
  modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };

  // Paste address
  const pasteBtn = document.getElementById('picker-paste-btn');
  if (pasteBtn) pasteBtn.onclick = () => {
    const val = document.getElementById('picker-paste-addr')?.value?.trim();
    if (val && val.length >= 32) { modal.style.display = 'none'; onSelect({ address: val }); }
    else showToast('Enter a valid Solana address');
  };

  // Select wallet
  box.querySelectorAll('.picker-wallet-row').forEach(row => {
    row.onclick = () => {
      const w = S.savedWallets.find(x => x.id === row.dataset.walletId);
      if (w) { modal.style.display = 'none'; onSelect(w); }
    };
  });
}