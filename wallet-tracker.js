/* ═══════════════════════════════════════════
   wallet-tracker.js — Wallet Tracker Tool
   Essor Studios / Ultimate Dev Tools
═══════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────
// RPC helpers (local to this file)
// ─────────────────────────────────────────
async function trackerRpc(method, params) {
  try {
    const endpoint = (typeof S !== 'undefined' && S.settings?.rpcEndpoint) || 'https://api.mainnet-beta.solana.com';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const j = await res.json();
    return j.result ?? null;
  } catch { return null; }
}

// ─────────────────────────────────────────
// DATA FETCHING
// ─────────────────────────────────────────
async function fetchWalletData(address, monitorCA) {
  const data = { sol: null, tokens: {}, recentTxs: [], lastFetch: Date.now() };

  // SOL balance
  const balRes = await trackerRpc('getBalance', [address]);
  if (balRes != null) data.sol = (balRes.value / 1e9).toFixed(4);

  // Token balance for monitored CA
  if (monitorCA) {
    const tokRes = await trackerRpc('getTokenAccountsByOwner', [
      address, { mint: monitorCA }, { encoding: 'jsonParsed' }
    ]);
    if (tokRes?.value?.length > 0) {
      const info = tokRes.value[0]?.account?.data?.parsed?.info?.tokenAmount;
      data.tokens[monitorCA] = info ? parseFloat(info.uiAmount || 0).toLocaleString() : '0';
    } else {
      data.tokens[monitorCA] = '0';
    }
  }

  // All token accounts (top holdings)
  const allToks = await trackerRpc('getTokenAccountsByOwner', [
    address, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }
  ]);
  if (allToks?.value) {
    const holdings = allToks.value
      .map(a => ({
        mint: a.account.data.parsed.info.mint,
        amount: parseFloat(a.account.data.parsed.info.tokenAmount.uiAmount || 0)
      }))
      .filter(h => h.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);
    data.holdings = holdings;
  }

  // Recent transactions
  const sigs = await trackerRpc('getSignaturesForAddress', [address, { limit: 8 }]);
  if (sigs) {
    data.recentTxs = sigs.map(s => ({
      sig: s.signature,
      slot: s.slot,
      time: s.blockTime ? new Date(s.blockTime * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '?',
      err: !!s.err,
      memo: s.memo || null,
    }));
  }

  return data;
}

async function refreshAllTracked() {
  const wallets = S.tracker.wallets;
  if (!wallets.length) return;

  const btn = document.getElementById('tracker-refresh-btn');
  if (btn) btn.classList.add('spinning');

  for (const w of wallets) {
    const data = await fetchWalletData(w.address, S.tracker.monitorCA);
    Object.assign(w, data);
  }

  await saveState();
  render();
}

async function refreshSingleWallet(id) {
  const w = S.tracker.wallets.find(x => x.id === id);
  if (!w) return;
  const data = await fetchWalletData(w.address, S.tracker.monitorCA);
  Object.assign(w, data);
  await saveState();
  render();
}

// ─────────────────────────────────────────
// PAGE BUILDER
// ─────────────────────────────────────────
function buildTrackerPage() {
  const t = S.tracker;
  const count = t.wallets.length;

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Wallet Tracker</span>
        <div style="display:flex;gap:5px;align-items:center">
          <button class="btn btn-sm ${t.autoRefresh ? 'btn-primary' : 'btn-secondary'}"
            data-action="tracker-toggle-auto" title="${t.autoRefresh ? 'Disable auto-refresh' : 'Enable auto-refresh (60s)'}">
            ${t.autoRefresh ? '⏸ Live' : '▶ Live'}
          </button>
          <button class="refresh-btn" id="tracker-refresh-btn" data-action="tracker-refresh-all" title="Refresh all wallets">↻</button>
        </div>
      </div>
      <div class="tool-sub-row">
        <span class="tool-subtitle">${count} wallet${count !== 1 ? 's' : ''} tracked</span>
        ${t.autoRefresh ? '<span class="live-badge">● LIVE</span>' : ''}
      </div>
    </div>

    <div class="scroll-area" id="scroll-area">

      <!-- Monitor CA filter -->
      <div class="field">
        <div class="field-label">Monitor Token CA <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-muted)">(optional — shows balance across all wallets)</span></div>
        <div style="display:flex;gap:6px">
          <input type="text" id="tracker-ca" value="${t.monitorCA}" placeholder="Token mint address to track…" style="flex:1"/>
          <button class="btn btn-ghost btn-sm" data-action="tracker-set-ca">Set</button>
          ${t.monitorCA ? `<button class="btn btn-secondary btn-sm" data-action="tracker-clear-ca">✕</button>` : ''}
        </div>
      </div>

      <div class="section-divider"></div>

      <!-- Wallet list -->
      ${count === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">◎</div>
          <div class="empty-text">No wallets being tracked.<br>Add a wallet below or import from Saved Wallets.</div>
        </div>
      ` : t.wallets.map(w => buildTrackerWalletCard(w)).join('')}

      <!-- Add wallet -->
      <div class="add-tracker-section">
        <div class="section-hdr" style="margin-bottom:8px">Add Wallet</div>
        <div class="field">
          <div class="field-label">Label</div>
          <input type="text" id="tracker-new-label" placeholder="e.g. Dev Wallet, Whale…" maxlength="30"/>
        </div>
        <div class="field">
          <div class="field-label">Address</div>
          <input type="text" id="tracker-new-addr" placeholder="Solana wallet address…"/>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-primary btn-sm" style="flex:1" data-action="tracker-add-wallet">+ Add Wallet</button>
          ${S.savedWallets.length > 0 ? `<button class="btn btn-secondary btn-sm" data-action="tracker-import-saved">Import Saved</button>` : ''}
        </div>
      </div>

    </div>
  `;
}

function buildTrackerWalletCard(w) {
  const expanded = S.tracker.expanded[w.id];
  const staleMins = w.lastFetch ? Math.floor((Date.now() - w.lastFetch) / 60000) : null;
  const staleStr = staleMins === null ? 'Never fetched' : staleMins === 0 ? 'Just now' : `${staleMins}m ago`;
  const hasSol = w.sol != null;
  const hasToken = S.tracker.monitorCA && w.tokens?.[S.tracker.monitorCA] != null;

  return `
    <div class="tracker-card" id="tc-${w.id}">
      <div class="tracker-card-header" data-action="tracker-toggle-expand" data-wallet-id="${w.id}">
        <div class="tracker-card-left">
          <span class="tracker-emoji">${w.emoji || '💼'}</span>
          <div class="tracker-info">
            <div class="tracker-name">${w.name || 'Unnamed Wallet'}</div>
            <div class="tracker-addr" data-action="copy" data-copy="${w.address}">${shortAddr(w.address)}</div>
          </div>
        </div>
        <div class="tracker-card-right">
          ${hasSol ? `<span class="bal-pill sol-pill">${w.sol} SOL</span>` : ''}
          ${hasToken ? `<span class="bal-pill tok-pill">${w.tokens[S.tracker.monitorCA]}</span>` : ''}
          <button class="icon-btn" data-action="tracker-refresh-one" data-wallet-id="${w.id}" title="Refresh">↻</button>
          <span class="expand-chevron ${expanded ? 'open' : ''}">›</span>
        </div>
      </div>

      ${expanded ? buildTrackerCardBody(w) : ''}
    </div>
  `;
}

function buildTrackerCardBody(w) {
  const hasHoldings = w.holdings && w.holdings.length > 0;
  const hasTxs = w.recentTxs && w.recentTxs.length > 0;

  return `
    <div class="tracker-card-body">
      <!-- Full address -->
      <div class="tracker-full-addr" data-action="copy" data-copy="${w.address}">${w.address}</div>

      <!-- Holdings -->
      ${hasHoldings ? `
        <div class="tracker-section-label">TOP HOLDINGS</div>
        <div class="tracker-holdings">
          ${w.holdings.map(h => `
            <div class="holding-row">
              <span class="holding-mint" data-action="copy" data-copy="${h.mint}" title="${h.mint}">${shortAddr(h.mint)}</span>
              <span class="holding-amt">${h.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <!-- Recent Transactions -->
      ${hasTxs ? `
        <div class="tracker-section-label" style="margin-top:8px">RECENT TXS</div>
        ${w.recentTxs.map(tx => `
          <div class="tx-row ${tx.err ? 'tx-err' : ''}">
            <span class="tx-time">${tx.time}</span>
            <span class="tx-sig" data-action="copy" data-copy="${tx.sig}" title="${tx.sig}">${shortAddr(tx.sig)}</span>
            <span class="tx-status">${tx.err ? '✕' : '✓'}</span>
          </div>
        `).join('')}
      ` : '<div style="font-size:10px;color:var(--text-muted);padding:6px 0">No transactions loaded. Hit refresh.</div>'}

      <!-- Controls -->
      <div class="tracker-card-actions">
        <label class="alert-toggle-row">
          <span class="toggle-label" style="font-size:10px">Alert on buy</span>
          <div class="toggle ${w.alertOnBuy ? 'on' : ''}" data-action="tracker-toggle-alert" data-wallet-id="${w.id}"></div>
        </label>
        <button class="btn btn-danger btn-sm" data-action="tracker-remove-wallet" data-wallet-id="${w.id}">Remove</button>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────
// EVENT HANDLERS (called from popup.js dispatcher)
// ─────────────────────────────────────────
async function handleTrackerAction(a, el) {

  if (a === 'tracker-refresh-all') {
    await refreshAllTracked();

  } else if (a === 'tracker-refresh-one') {
    await refreshSingleWallet(el.dataset.walletId);

  } else if (a === 'tracker-toggle-auto') {
    S.tracker.autoRefresh = !S.tracker.autoRefresh;
    if (S.tracker.autoRefresh) {
      chrome.runtime.sendMessage({ action: 'startTrackerRefresh' });
    } else {
      chrome.runtime.sendMessage({ action: 'stopTrackerRefresh' });
    }
    await saveState(); render();

  } else if (a === 'tracker-set-ca') {
    const val = document.getElementById('tracker-ca')?.value?.trim();
    S.tracker.monitorCA = val || '';
    await saveState(); render();

  } else if (a === 'tracker-clear-ca') {
    S.tracker.monitorCA = '';
    await saveState(); render();

  } else if (a === 'tracker-toggle-expand') {
    const id = el.dataset.walletId;
    S.tracker.expanded[id] = !S.tracker.expanded[id];
    // Auto-fetch on first expand
    const w = S.tracker.wallets.find(x => x.id === id);
    if (w && !w.lastFetch && S.tracker.expanded[id]) {
      await refreshSingleWallet(id);
    } else {
      await saveState(); render();
    }

  } else if (a === 'tracker-toggle-alert') {
    const id = el.dataset.walletId;
    const w = S.tracker.wallets.find(x => x.id === id);
    if (w) { w.alertOnBuy = !w.alertOnBuy; await saveState(); render(); }

  } else if (a === 'tracker-add-wallet') {
    const addr = document.getElementById('tracker-new-addr')?.value?.trim();
    const name = document.getElementById('tracker-new-label')?.value?.trim() || 'Wallet';
    if (!addr || addr.length < 32) { showToast('Enter a valid Solana address'); return; }
    if (S.tracker.wallets.find(w => w.address === addr)) { showToast('Already tracking this wallet'); return; }
    S.tracker.wallets.push({
      id: uid(),
      name,
      emoji: '💼',
      address: addr,
      sol: null,
      tokens: {},
      holdings: [],
      recentTxs: [],
      lastFetch: null,
      alertOnBuy: false,
    });
    await saveState(); render();
    showToast(`✓ Tracking ${name}`);

  } else if (a === 'tracker-import-saved') {
    // Import saved wallets not already tracked
    const tracked = new Set(S.tracker.wallets.map(w => w.address));
    const imported = S.savedWallets.filter(w => w.publicKey && !tracked.has(w.publicKey));
    if (!imported.length) { showToast('All saved wallets already tracked'); return; }
    imported.forEach(w => {
      S.tracker.wallets.push({
        id: uid(), name: w.name || 'Saved Wallet', emoji: w.emoji || '💼',
        address: w.publicKey, sol: null, tokens: {}, holdings: [],
        recentTxs: [], lastFetch: null, alertOnBuy: false,
      });
    });
    await saveState(); render();
    showToast(`✓ Imported ${imported.length} wallet${imported.length > 1 ? 's' : ''}`);

  } else if (a === 'tracker-remove-wallet') {
    const id = el.dataset.walletId;
    S.tracker.wallets = S.tracker.wallets.filter(w => w.id !== id);
    delete S.tracker.expanded[id];
    await saveState(); render();
  }
}
