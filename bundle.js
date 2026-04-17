/* ═══════════════════════════════════════════
   bundle.js — Bundle Engine + Create Bundle
   Essor Studios / Ultimate Dev Tools
   SplitNOW flow:
   1) Generate wallets
   2) Build splits from generated wallet addresses
   3) Send to backend proxy
   4) Poll order
   5) Save/show generated wallets
════════════════════════════════════════════ */

'use strict';

const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymMDer';
const RAYDIUM_AMM     = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

function getBundleRpc() {
  return (typeof S !== 'undefined' && S.settings?.rpcEndpoint)
    || 'https://api.mainnet-beta.solana.com';
}

async function bundleRpc(method, params) {
  try {
    const res = await fetch(getBundleRpc(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const j = await res.json();
    return j.result ?? null;
  } catch {
    return null;
  }
}

function bundleSleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function splitNowReq(method, path, body) {
  const token = localStorage.getItem('udt_token') || S.auth?.token;
  if (!token) throw new Error('Not logged in');

  let url = '';
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
  };

  if (method === 'POST' && path === '/create-bundle') {
    url = BACKEND + '/api/proxy/splitnow/create-bundle';
    opts.body = JSON.stringify(body || {});
  } else if (method === 'GET' && path.startsWith('/order/')) {
    const id = path.split('/order/')[1];
    url = BACKEND + '/api/proxy/splitnow/order/' + encodeURIComponent(id);
  } else {
    throw new Error(`Unsupported SplitNow proxy route: ${method} ${path}`);
  }

  const res = await fetch(url, opts);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text || `HTTP ${res.status}` };
  }

  if (!res.ok) {
    throw new Error(data?.error || data?.message || `Proxy error ${res.status}`);
  }

  return data;
}

// ══════════════════════════════════════════
// PAGE ROUTER
// ══════════════════════════════════════════
function buildBundlePage() {
  const b = S.bundle || {};
  if (b.view === 'token-result')  return buildBundleTokenResult();
  if (b.view === 'wallet-result') return buildBundleWalletResult();
  if (b.view === 'create-result') return buildCreateBundleResult();
  return buildBundleLanding();
}

// ══════════════════════════════════════════
// LANDING — tabs: Check / Create / History
// ══════════════════════════════════════════
function buildBundleLanding() {
  const b = S.bundle || {};
  const tab = b.createTab || 'check';

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Bundle</span>
      </div>
      <div style="display:flex;border-bottom:1px solid var(--border-md);margin:0 -14px;padding:0 14px">
        <button class="tab ${tab === 'check' ? 'active' : ''}" data-action="bundle-tab" data-tab="check">Check</button>
        <button class="tab ${tab === 'create' ? 'active' : ''}" data-action="bundle-tab" data-tab="create">Create</button>
        <button class="tab ${tab === 'history' ? 'active' : ''}" data-action="bundle-tab" data-tab="history">
          History${(b.createHistory || []).length ? `<span style="margin-left:4px;background:var(--navy-ghost2);color:var(--navy);font-size:8px;font-weight:700;padding:1px 5px;border-radius:20px">${(b.createHistory || []).length}</span>` : ''}
        </button>
      </div>
    </div>

    <div class="scroll-area" id="scroll-area">
      ${tab === 'check' ? buildBundleCheckTab() : ''}
      ${tab === 'create' ? buildBundleCreateTab() : ''}
      ${tab === 'history' ? buildBundleHistoryTab() : ''}
    </div>
  `;
}

// ══════════════════════════════════════════
// CHECK TAB — wallet picker like volume bot
// ══════════════════════════════════════════
function buildBundleCheckWalletPicker() {
  const b = S.bundle || {};
  const open = !!b._walletPickerOpen;
  const selectedList = b.walletAddresses || [];
  const selected = new Set(selectedList);
  const allWallets = (S.savedWallets || []).filter(w => w.publicKey);
  const groups = S.walletGroups || [];
  const ungrouped = allWallets.filter(w => !w.groupId);
  const count = selected.size;

  const chips = selectedList.map((addr, i) => {
    const w = allWallets.find(x => x.publicKey === addr);
    return `
      <span style="display:inline-flex;align-items:center;gap:4px;background:var(--navy-ghost);color:var(--navy);border-radius:999px;padding:3px 8px;font-size:9px;font-family:var(--mono)">
        ${w ? `${w.emoji || '💼'} ${w.name}` : short(addr)}
        <span data-action="bc-wallet-remove" data-idx="${i}" style="cursor:pointer;opacity:.55">✕</span>
      </span>
    `;
  }).join('');

  return `
    <div class="field" style="margin-bottom:0">
      ${count > 0 ? `
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
          ${chips}
        </div>
      ` : ''}

      <div class="cpicker-wrap">
        <div class="cpicker-btn ${count > 0 ? 'cpicker-selected' : ''}" data-action="bundle-check-wallet-toggle">
          <span style="font-size:11px;font-weight:600;flex:1;color:${count > 0 ? 'var(--navy)' : 'var(--text-muted)'}">
            ${count > 0 ? `${count} wallet${count !== 1 ? 's' : ''} selected` : 'Select wallet, group, or paste address…'}
          </span>
          <span class="cpicker-chevron ${open ? 'open' : ''}">›</span>
        </div>

        ${open ? `
          <div class="cpicker-dropdown">
            ${groups.map(g => {
              const groupWallets = allWallets.filter(w => w.groupId === g.id && w.publicKey);
              if (!groupWallets.length) return '';

              const selectedCount = groupWallets.filter(w => selected.has(w.publicKey)).length;
              const allSelected = selectedCount === groupWallets.length;
              const partial = selectedCount > 0 && !allSelected;

              return `
                <div class="tpicker-group-row ${allSelected ? 'selected' : ''} ${partial ? 'partial' : ''}"
                     data-action="bundle-check-wallet-group"
                     data-gid="${g.id}">
                  <div class="tpicker-check ${allSelected ? 'checked' : ''} ${partial ? 'partial' : ''}"></div>
                  <span>${g.emoji || '📁'}</span>
                  <span class="tpicker-group-name">${g.name}</span>
                  <span class="tpicker-count">${groupWallets.length}</span>
                </div>

                ${groupWallets.map(w => `
                  <div class="tpicker-wallet-row ${selected.has(w.publicKey) ? 'selected' : ''}"
                       data-action="bundle-check-wallet-pick"
                       data-pub="${w.publicKey}">
                    <div class="tpicker-check ${selected.has(w.publicKey) ? 'checked' : ''}"></div>
                    <span>${w.emoji || '💼'}</span>
                    <div class="tpicker-info">
                      <span class="tpicker-name">${w.name || 'Wallet'}</span>
                      <span class="tpicker-addr">${short(w.publicKey)}</span>
                    </div>
                  </div>
                `).join('')}
              `;
            }).join('')}

            ${ungrouped.map(w => `
              <div class="tpicker-wallet-row ${selected.has(w.publicKey) ? 'selected' : ''}"
                   data-action="bundle-check-wallet-pick"
                   data-pub="${w.publicKey}">
                <div class="tpicker-check ${selected.has(w.publicKey) ? 'checked' : ''}"></div>
                <span>${w.emoji || '💼'}</span>
                <div class="tpicker-info">
                  <span class="tpicker-name">${w.name || 'Wallet'}</span>
                  <span class="tpicker-addr">${short(w.publicKey)}</span>
                </div>
              </div>
            `).join('')}

            ${!allWallets.length ? `<div class="cpicker-empty">No saved wallets yet.</div>` : ''}

            <div class="cpicker-divider"></div>
            <div class="cpicker-paste-label">Or paste wallet address</div>
            <div style="display:flex;gap:5px;padding:0 8px 8px">
              <input type="text" id="bundle-check-paste" placeholder="Wallet address…" style="flex:1;font-size:10.5px"/>
              <button class="btn btn-ghost btn-sm" data-action="bundle-check-wallet-paste">Add</button>
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════
// CHECK TAB
// ══════════════════════════════════════════
function buildBundleCheckTab() {
  const b = S.bundle || {};
  const walletCount = (b.walletAddresses || []).length;

  return `
    <div class="field">
      <div class="field-label">
        <span>Token Contract Address</span>
        <button
          class="help-q"
          data-action="show-help"
          data-title="Token Contract Address"
          data-body="Paste a token mint address here to scan early buyers and detect bundle patterns, shared funders, and suspicious allocations.">?</button>
      </div>

      <div class="add-row">
        <input type="text" id="bundle-ca" value="${b.ca || ''}" placeholder="Paste token mint address…"/>
        <button class="btn btn-primary btn-sm" data-action="run-bundle" ${b.loading ? 'disabled' : ''}>
          ${b.loading ? '<span class="spinner-dark"></span>' : 'Analyze'}
        </button>
      </div>
    </div>

    ${b.loading ? buildBundleLoading(b.progress) : ''}
    ${b.error ? `<div class="error-card">⚠ ${b.error}</div>` : ''}

    <div class="bc-divider"></div>

    <div class="settings-section" style="padding-bottom:12px;margin-bottom:0">
      <div class="settings-section-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span style="display:flex;align-items:center;gap:6px">
          <span>Wallet Connection Check</span>
          <button
            class="help-q"
            data-action="show-help"
            data-title="Wallet Connection Check"
            data-body="Select 2 or more wallets, a whole wallet group, or paste raw wallet addresses. This checks whether they appear to share the same funding source.">?</button>
        </span>
        <span style="font-size:9px;font-weight:400;color:var(--text-muted)">${walletCount} selected</span>
      </div>

      ${buildBundleCheckWalletPicker()}

      <button
        class="btn btn-primary btn-sm btn-full"
        data-action="run-wallet-check"
        style="margin-top:8px"
        ${b.walletLoading || walletCount < 2 ? 'disabled' : ''}>
        ${b.walletLoading ? '<span class="spinner-dark"></span> Checking…' : `Check ${walletCount >= 2 ? `${walletCount} Wallets` : 'Wallets (need 2+)'}`}
      </button>

      ${b.walletLoading ? buildBundleLoading(b.walletProgress) : ''}
      ${b.walletError ? `<div class="error-card" style="margin-top:8px">⚠ ${b.walletError}</div>` : ''}
    </div>
  `;
}

// ══════════════════════════════════════════
// CREATE TAB
// ══════════════════════════════════════════
function buildBundleCreateTab() {
  const c = S.bundle.create || {};
  const allWallets = (S.savedWallets || []).filter(w => w.publicKey && w.privateKey);
  const selSource =
    allWallets.find(w => w.privateKey === c.sourceWalletPrivKey) ||
    allWallets.find(w => w.id === c.sourceWalletId);

  const distrib = c.distribMode || 'equal';
  const count = parseInt(c.walletCount, 10) || 5;
  const running = !!c.running;
  const open = !!S.bundle._createSourceOpen;
  const staggerFunding = !!c.staggerFunding;
  const staggerMinSec = parseInt(c.staggerMinSec) || 30;
  const staggerMaxSec = parseInt(c.staggerMaxSec) || 60;

  return `
    <div class="settings-section" style="padding-bottom:12px;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="settings-section-title" style="margin-bottom:0;display:flex;align-items:center;gap:6px">
          <span>Stagger Wallet Funding</span>
          <button class="help-q" data-action="show-help"
            data-title="Stagger Wallet Funding"
            data-body="When enabled, SplitNow will wait a random amount of time between funding each wallet. Times below are in seconds.">
            ?
          </button>
        </div>
        <button class="toggle ${staggerFunding ? 'on' : ''}" data-action="cb-toggle-stagger"></button>
      </div>

      ${staggerFunding ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div class="field" style="margin-bottom:0">
            <div class="field-label">Min Delay (sec)</div>
            <input
              type="number"
              id="cb-stagger-min"
              value="${staggerMinSec}"
              min="1"
              step="1"
              data-bind-bundle-create="staggerMinSec"
            />
          </div>
          <div class="field" style="margin-bottom:0">
            <div class="field-label">Max Delay (sec)</div>
            <input
              type="number"
              id="cb-stagger-max"
              value="${staggerMaxSec}"
              min="1"
              step="1"
              data-bind-bundle-create="staggerMaxSec"
            />
          </div>
        </div>
      ` : `
        <p style="font-size:10px;color:var(--text-muted);line-height:1.5;margin:0">
          Off = wallets are funded as fast as SplitNow processes them.
        </p>
      `}
    </div>

      <p style="font-size:10px;color:var(--text-muted);margin-bottom:8px;line-height:1.5">
        Route: Source → SplitNow exchange → fresh wallets. Zero direct on-chain link from source to outputs.
      </p>

      <div class="cpicker-wrap">
        <div class="cpicker-btn ${selSource || c.sourceWalletPrivKey ? 'cpicker-selected' : ''}" data-action="bundle-src-toggle">
          ${
            selSource
              ? `
                <span>${selSource.emoji || '💼'}</span>
                <span class="cpicker-name">${selSource.name || 'Wallet'}</span>
                <span class="cpicker-addr">${short(selSource.publicKey)}</span>
              `
              : c.sourceWalletPrivKey
                ? `
                  <span>🔑</span>
                  <span class="cpicker-name">Custom Private Key</span>
                  <span class="cpicker-addr">Saved in form</span>
                `
                : `<span style="color:var(--text-muted);font-size:11px">Select wallet…</span>`
          }
          <span class="cpicker-chevron ${open ? 'open' : ''}">›</span>
        </div>

        ${open ? `
          <div class="cpicker-dropdown">
            ${
              allWallets.length === 0
                ? `<div class="cpicker-empty">No saved wallets with private keys.<br>Add one in the Wallets tab.</div>`
                : allWallets.map(w => `
                  <div class="cpicker-row ${(c.sourceWalletPrivKey === w.privateKey) ? 'active' : ''}"
                       data-action="bundle-src-pick"
                       data-wallet-id="${w.id}"
                       data-priv="${encodeURIComponent(w.privateKey)}">
                    <span>${w.emoji || '💼'}</span>
                    <div class="cpicker-row-info">
                      <span class="cpicker-name">${w.name || 'Wallet'}</span>
                      <span class="cpicker-addr">${short(w.publicKey)}</span>
                    </div>
                    ${w.solBalance != null ? `<span class="cpicker-bal">${w.solBalance} SOL</span>` : ''}
                  </div>
                `).join('')
            }

            <div class="cpicker-divider"></div>
            <div class="cpicker-paste-label">Or paste private key</div>
            <div style="display:flex;gap:5px;padding:0 8px 8px">
              <input
                type="password"
                id="bundle-source-priv"
                value="${c.sourceWalletPrivKey || ''}"
                placeholder="Base58 private key…"
                style="flex:1;font-size:10.5px"
              />
              <button class="btn btn-ghost btn-sm" data-action="bundle-src-paste">Use</button>
            </div>
          </div>
        ` : ''}
      </div>
    </div>

    <div class="settings-section" style="padding-bottom:12px;margin-bottom:12px">
      <div class="settings-section-title" style="display:flex;align-items:center;gap:6px">
        <span>Wallet Count</span>
        <button class="help-q"
          data-action="show-help"
          data-title="Wallet Count"
          data-body="How many fresh wallets to generate for this bundle. One brand new private key is created for each wallet.">
          ?
        </button>
      </div>

      <div class="add-row" style="align-items:center">
        <input
          type="number"
          id="cb-wallet-count"
          value="${count}"
          min="1"
          max="50"
          style="width:72px"
          data-bind-bundle-create="walletCount"
        />
        <span style="font-size:10px;color:var(--text-muted)">wallets will be generated (max 50)</span>
      </div>
    </div>

    <div class="settings-section" style="padding-bottom:12px;margin-bottom:12px">
      <div class="settings-section-title" style="display:flex;align-items:center;gap:6px">
        <span>Total SOL to Distribute</span>
        <button class="help-q"
          data-action="show-help"
          data-title="Total SOL to Distribute"
          data-body="This is the total SOL sent into the SplitNow flow and then spread across the generated wallets.">
          ?
        </button>
      </div>

      <div class="add-row" style="align-items:center">
        <input
          type="number"
          id="cb-total-sol"
          value="${c.totalSol || ''}"
          min="0.01"
          step="0.01"
          placeholder="e.g. 5.0"
          style="width:100px"
          data-bind-bundle-create="totalSol"
        />
        <span style="font-size:10px;color:var(--text-muted)">SOL across all wallets</span>
      </div>
    </div>

    <div class="settings-section" style="padding-bottom:12px;margin-bottom:12px">
      <div class="settings-section-title" style="display:flex;align-items:center;gap:6px">
        <span>Max SOL Per Wallet</span>
        <button class="help-q"
          data-action="show-help"
          data-title="Max SOL Per Wallet"
          data-body="Optional cap for any single output wallet. Leave blank for no cap.">
          ?
        </button>
        <span style="font-size:9px;font-weight:400;color:var(--text-muted)">(optional)</span>
      </div>

      <div class="add-row" style="align-items:center">
        <input
          type="number"
          id="cb-max-sol"
          value="${c.maxSolPerWallet || ''}"
          min="0"
          step="0.01"
          placeholder="No limit"
          style="width:100px"
          data-bind-bundle-create="maxSolPerWallet"
        />
        <span style="font-size:10px;color:var(--text-muted)">SOL max per wallet</span>
      </div>
    </div>

    <div class="settings-section" style="padding-bottom:12px;margin-bottom:12px">
      <div class="settings-section-title" style="display:flex;align-items:center;gap:6px">
        <span>Min SOL Per Wallet</span>
        <button class="help-q"
          data-action="show-help"
          data-title="Min SOL Per Wallet"
          data-body="Optional minimum for every generated wallet. Leave blank or 0 for no minimum.">
          ?
        </button>
        <span style="font-size:9px;font-weight:400;color:var(--text-muted)">(optional)</span>
      </div>

      <div class="add-row" style="align-items:center">
        <input
          type="number"
          id="cb-min-sol"
          value="${c.minSolPerWallet || ''}"
          min="0"
          step="0.01"
          placeholder="No minimum"
          style="width:100px"
          data-bind-bundle-create="minSolPerWallet"
        />
        <span style="font-size:10px;color:var(--text-muted)">SOL minimum per wallet</span>
      </div>
    </div>

    <div class="settings-section" style="padding-bottom:12px;margin-bottom:12px">
      <div class="settings-section-title" style="display:flex;align-items:center;gap:6px">
        <span>Distribution</span>
        <button class="help-q"
          data-action="show-help"
          data-title="Distribution"
          data-body="Equal split sends the same SOL to every generated wallet. Random creates a more uneven, natural-looking spread.">
          ?
        </button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        <div
          data-action="cb-set-distrib"
          data-mode="equal"
          style="padding:9px 10px;border:1.5px solid ${distrib === 'equal' ? 'var(--navy)' : 'var(--border-md)'};border-radius:var(--r-sm);cursor:pointer;background:${distrib === 'equal' ? 'var(--navy-ghost)' : 'var(--surface)'}">
          <div style="font-size:10.5px;font-weight:600;color:${distrib === 'equal' ? 'var(--navy)' : 'var(--text-dim)'}">Equal split</div>
          <div style="font-size:9px;color:var(--text-muted);margin-top:2px">Each wallet gets the same amount</div>
        </div>

        <div
          data-action="cb-set-distrib"
          data-mode="random"
          style="padding:9px 10px;border:1.5px solid ${distrib === 'random' ? 'var(--navy)' : 'var(--border-md)'};border-radius:var(--r-sm);cursor:pointer;background:${distrib === 'random' ? 'var(--navy-ghost)' : 'var(--surface)'}">
          <div style="font-size:10.5px;font-weight:600;color:${distrib === 'random' ? 'var(--navy)' : 'var(--text-dim)'}">Random</div>
          <div style="font-size:9px;color:var(--text-muted);margin-top:2px">Random spread per wallet</div>
        </div>
      </div>
    </div>

    <div class="settings-section" style="padding-bottom:12px;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="settings-section-title" style="margin-bottom:0;display:flex;align-items:center;gap:6px">
          <span>Stagger Wallet Funding</span>
          <button class="help-q"
            data-action="show-help"
            data-title="Stagger Wallet Funding"
            data-body="If enabled, SplitNow waits a random amount of time between output wallet funding. This slows the route down and makes timing less uniform.">
            ?
          </button>
        </div>
        <div class="toggle ${staggerOn ? 'on' : ''}" data-action="cb-toggle-stagger"></div>
      </div>

      ${staggerOn ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div class="field" style="margin-bottom:0">
            <div class="field-label" style="display:flex;align-items:center;gap:6px">
              <span>Min Delay (sec)</span>
              <button class="help-q"
                data-action="show-help"
                data-title="Minimum Delay"
                data-body="Minimum number of seconds SplitNow waits before funding the next wallet.">
                ?
              </button>
            </div>
            <input
              type="number"
              id="cb-stagger-min"
              value="${c.staggerMinSec || 30}"
              min="1"
              step="1"
              placeholder="30"
              data-bind-bundle-create="staggerMinSec"
            />
          </div>

          <div class="field" style="margin-bottom:0">
            <div class="field-label" style="display:flex;align-items:center;gap:6px">
              <span>Max Delay (sec)</span>
              <button class="help-q"
                data-action="show-help"
                data-title="Maximum Delay"
                data-body="Maximum number of seconds SplitNow waits before funding the next wallet. A random value between min and max is used each time.">
                ?
              </button>
            </div>
            <input
              type="number"
              id="cb-stagger-max"
              value="${c.staggerMaxSec || 60}"
              min="1"
              step="1"
              placeholder="60"
              data-bind-bundle-create="staggerMaxSec"
            />
          </div>
        </div>

        <p style="font-size:10px;color:var(--text-muted);line-height:1.5;margin:8px 0 0 0">
          SplitNow will fund each generated wallet one after another with a random delay between these values.
        </p>
      ` : `
        <p style="font-size:10px;color:var(--text-muted);line-height:1.5;margin:0">
          Toggle this on if you want output wallets funded one-by-one instead of as quickly as possible.
        </p>
      `}
    </div>

    <div class="settings-section" style="padding-bottom:12px;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="settings-section-title" style="margin-bottom:0;display:flex;align-items:center;gap:6px">
          <span>Add to Wallet Group</span>
          <button class="help-q"
            data-action="show-help"
            data-title="Add to Wallet Group"
            data-body="If enabled, the generated wallets will be saved into a reusable wallet group after the bundle completes.">
            ?
          </button>
        </div>
        <div class="toggle ${c.addToGroup ? 'on' : ''}" data-action="cb-toggle-group"></div>
      </div>

      ${c.addToGroup ? `
        <div class="field" style="margin-bottom:0">
          <div class="field-label" style="display:flex;align-items:center;gap:6px">
            <span>Group Name</span>
            <button class="help-q"
              data-action="show-help"
              data-title="Group Name"
              data-body="This name is used for the saved wallet group and each generated wallet label.">
              ?
            </button>
          </div>
          <input
            type="text"
            id="cb-group-name"
            value="${c.groupName || ''}"
            placeholder="e.g. Bundle Jan 2025…"
            maxlength="30"
            data-bind-bundle-create="groupName"
          />
        </div>
      ` : `
        <p style="font-size:10px;color:var(--text-muted);line-height:1.5;margin:0">
          Keys are shown once after creation. Toggle this on to save wallets into a reusable group.
        </p>
      `}
    </div>

    ${c.error ? `<div class="error-card">${c.error}</div>` : ''}
    ${running ? buildBundleLoading({ step: c.runStep || 'Working…', pct: c.runPct || 0 }) : ''}

    <button class="btn btn-primary btn-full" data-action="cb-run" ${running ? 'disabled' : ''}>
      ${running ? '<span class="spinner-dark"></span>&nbsp; Creating…' : '⚡ Create Bundle'}
    </button>

    <p style="font-size:9px;color:var(--text-muted);text-align:center;margin-top:7px;line-height:1.5">
      SOL is routed through SplitNow's exchange network. No direct on-chain link between source and destination wallets.
    </p>
  `;
}

// ══════════════════════════════════════════
// HISTORY TAB
// ══════════════════════════════════════════
function buildBundleHistoryTab() {
  const history = S.bundle.createHistory || [];
  if (!history.length) {
    return `
      <div class="empty-state">
        <div class="empty-icon">📦</div>
        <div class="empty-text">No bundles created yet.<br>Switch to the Create tab to get started.</div>
      </div>
    `;
  }

  return history.slice().reverse().map(entry => {
    const expanded = (S.bundle.historyExpanded || {})[entry.id];
    const date = new Date(entry.ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
      + ' ' + new Date(entry.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    return `
      <div style="background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r);margin-bottom:8px;overflow:hidden">
        <div data-action="bh-toggle" data-id="${entry.id}" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;cursor:pointer">
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--navy)">${entry.groupName || 'Bundle'} <span style="font-weight:400;color:var(--text-muted)">· ${entry.wallets?.length || 0} wallets · ${entry.totalSol} SOL</span></div>
            <div style="font-size:9.5px;color:var(--text-muted);margin-top:2px">${date} · ${entry.distribMode === 'random' ? 'Random dist.' : 'Equal dist.'}</div>
          </div>
          <span style="font-size:13px;color:var(--text-muted);transform:rotate(${expanded ? '90' : '0'}deg);display:inline-block;transition:transform 0.15s">›</span>
        </div>

        ${expanded ? `
          <div style="border-top:1px solid var(--border-md);padding:10px 12px">
            <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">
              <button class="btn btn-ghost btn-sm" data-action="bh-copy-all-keys" data-id="${entry.id}">Copy All Keys</button>
              <button class="btn btn-ghost btn-sm" data-action="bh-copy-all-addrs" data-id="${entry.id}">Copy All Addresses</button>
              <button class="btn btn-danger btn-sm" data-action="bh-delete" data-id="${entry.id}">Delete</button>
            </div>
            ${(entry.wallets || []).map((w, i) => {
              const visKey = `${entry.id}-${i}`;
              const shown = (S.bundle.historyKeyVis || {})[visKey];
              return `
                <div style="background:var(--surface2);border:1px solid var(--border-md);border-radius:var(--r-sm);padding:8px 10px;margin-bottom:6px">
                  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                    <span style="font-size:10px;font-weight:600;color:var(--navy)">Wallet ${i + 1}${w.sol ? `<span style="font-weight:400;color:var(--text-muted)"> · ${w.sol} SOL</span>` : ''}</span>
                    <span style="font-size:9px;color:var(--green-dim);background:var(--green-bg);padding:1px 6px;border-radius:20px">Funded</span>
                  </div>
                  <div style="margin-bottom:5px">
                    <div style="font-size:8.5px;font-weight:700;letter-spacing:0.05em;color:var(--text-muted);text-transform:uppercase;margin-bottom:2px">Address</div>
                    <div style="display:flex;align-items:center;gap:4px">
                      <span style="font-family:var(--mono);font-size:9px;color:var(--text-dim);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${w.publicKey}</span>
                      <button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="copy" data-copy="${w.publicKey}">Copy</button>
                    </div>
                  </div>
                  <div>
                    <div style="font-size:8.5px;font-weight:700;letter-spacing:0.05em;color:var(--text-muted);text-transform:uppercase;margin-bottom:2px">Private Key</div>
                    <div style="display:flex;align-items:center;gap:4px">
                      <span style="font-family:var(--mono);font-size:9px;color:var(--text-dim);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                        ${shown ? w.privateKey : '•'.repeat(Math.min(w.privateKey?.length || 32, 32))}
                      </span>
                      <button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="bh-toggle-key" data-id="${entry.id}" data-idx="${i}">${shown ? 'Hide' : 'Show'}</button>
                      <button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="copy" data-copy="${w.privateKey}">Copy</button>
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// ══════════════════════════════════════════
// CREATE RESULT VIEW
// ══════════════════════════════════════════
function buildCreateBundleResult() {
  const r = S.bundle.createResult;
  if (!r) {
    S.bundle.view = 'landing';
    return buildBundleLanding();
  }

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Bundle Created</span>
        <button class="btn btn-ghost btn-sm" data-action="bundle-back">← Back</button>
      </div>
    </div>

    <div class="scroll-area" id="scroll-area">
      <div style="background:var(--green-bg);border:1px solid rgba(34,197,94,0.25);border-radius:var(--r);padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
        <span style="font-size:20px">🎉</span>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--green-dim)">Bundle funded successfully!</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:2px">${r.wallets.length} wallets · ${r.totalSol} SOL · ${r.distribMode === 'random' ? 'Random' : 'Equal'} distribution</div>
        </div>
      </div>

      <div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" data-action="cb-copy-all-keys">Copy All Private Keys</button>
        <button class="btn btn-ghost btn-sm" data-action="cb-copy-all-addrs">Copy All Addresses</button>
      </div>

      ${r.wallets.map((w, i) => {
        const shown = (S.bundle.createKeyVis || {})[i];
        return `
          <div style="background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r);padding:10px 12px;margin-bottom:7px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span style="font-size:10.5px;font-weight:700;color:var(--navy)">Wallet ${i + 1}</span>
              <span style="font-size:10px;font-family:var(--mono);font-weight:600;color:var(--navy)">${w.sol} SOL</span>
            </div>
            <div style="margin-bottom:5px">
              <div style="font-size:8.5px;font-weight:700;letter-spacing:0.05em;color:var(--text-muted);text-transform:uppercase;margin-bottom:2px">Address</div>
              <div style="display:flex;align-items:center;gap:4px">
                <span style="font-family:var(--mono);font-size:9px;color:var(--text-dim);flex:1;word-break:break-all">${w.publicKey}</span>
                <button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="copy" data-copy="${w.publicKey}">Copy</button>
              </div>
            </div>
            <div>
              <div style="font-size:8.5px;font-weight:700;letter-spacing:0.05em;color:var(--text-muted);text-transform:uppercase;margin-bottom:2px">Private Key</div>
              <div style="display:flex;align-items:center;gap:4px">
                <span style="font-family:var(--mono);font-size:9px;color:var(--text-dim);flex:1;word-break:break-all">
                  ${shown ? w.privateKey : '•'.repeat(Math.min(w.privateKey?.length || 32, 32))}
                </span>
                <button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="cr-toggle-key" data-idx="${i}">${shown ? 'Hide' : 'Show'}</button>
                <button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="copy" data-copy="${w.privateKey}">Copy</button>
              </div>
            </div>
          </div>
        `;
      }).join('')}

      <button class="btn btn-primary btn-full" data-action="bundle-back" style="margin-top:4px">Done</button>
    </div>
  `;
}

// ══════════════════════════════════════════
// LOADING CARD
// ══════════════════════════════════════════
function buildBundleLoading(p) {
  return `
    <div class="loading-card" style="margin:10px 0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
        <span class="loading-step" style="font-size:10px;color:var(--text-dim)">${p?.step || 'Working…'}</span>
        <span class="loading-pct" style="font-size:10px;font-weight:600;color:var(--navy);font-family:var(--mono)">${p?.pct || 0}%</span>
      </div>
      <div style="background:var(--border-md);border-radius:3px;height:3px;overflow:hidden">
        <div class="loading-bar" style="background:var(--navy);height:100%;width:${p?.pct || 0}%;transition:width 0.3s ease;border-radius:3px"></div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════
// CREATE BUNDLE LOGIC
// ══════════════════════════════════════════
function bundleDistributeSOL(totalSol, walletCount, distribMode, minPerWallet, maxPerWallet) {
  const total = parseFloat(totalSol);
  const min = parseFloat(minPerWallet) > 0 ? parseFloat(minPerWallet) : 0;
  const max = parseFloat(maxPerWallet) > 0 ? parseFloat(maxPerWallet) : Infinity;

  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('Invalid total SOL');
  }

  if (!Number.isFinite(walletCount) || walletCount < 1) {
    throw new Error('Invalid wallet count');
  }

  if (min > max) {
    throw new Error('Min SOL per wallet cannot be greater than max SOL per wallet');
  }

  if ((min * walletCount) > total) {
    throw new Error(`Total SOL is too low. You need at least ${(min * walletCount).toFixed(6)} SOL for ${walletCount} wallets with a minimum of ${min} SOL each.`);
  }

  if (Number.isFinite(max) && (max * walletCount) < total) {
    throw new Error(`Total SOL is too high for the current max cap. Maximum distributable is ${(max * walletCount).toFixed(6)} SOL.`);
  }

  const amounts = Array(walletCount).fill(min);
  let remaining = total - (min * walletCount);

  if (remaining <= 0) {
    return amounts.map(v => parseFloat(v.toFixed(6)));
  }

  if (distribMode === 'equal') {
    const extraEach = remaining / walletCount;

    for (let i = 0; i < walletCount; i++) {
      amounts[i] += extraEach;
      if (amounts[i] > max) {
        throw new Error('Equal distribution exceeds the max SOL per wallet cap');
      }
    }

    return amounts.map(v => parseFloat(v.toFixed(6)));
  }

  let safety = 0;
  while (remaining > 0.000001 && safety < 1000) {
    safety++;

    const openIndexes = amounts
      .map((v, i) => ({ i, room: max - v }))
      .filter(x => x.room > 0.000001);

    if (!openIndexes.length) break;

    const weights = openIndexes.map(() => Math.random());
    const weightSum = weights.reduce((a, b) => a + b, 0);

    let distributedThisPass = 0;

    for (let n = 0; n < openIndexes.length; n++) {
      const { i, room } = openIndexes[n];
      const share = (weights[n] / weightSum) * remaining;
      const add = Math.min(room, share);

      amounts[i] += add;
      distributedThisPass += add;
    }

    remaining -= distributedThisPass;

    if (distributedThisPass <= 0.000001) break;
  }

  if (remaining > 0.000001) {
    for (let i = 0; i < amounts.length && remaining > 0.000001; i++) {
      const room = max - amounts[i];
      if (room <= 0) continue;

      const add = Math.min(room, remaining);
      amounts[i] += add;
      remaining -= add;
    }
  }

  if (remaining > 0.00001) {
    throw new Error('Could not distribute SOL within the min/max wallet constraints');
  }

  const rounded = amounts.map(v => parseFloat(v.toFixed(6)));
  let roundedTotal = rounded.reduce((a, b) => a + b, 0);
  let diff = parseFloat((total - roundedTotal).toFixed(6));

  for (let i = 0; Math.abs(diff) >= 0.000001 && i < rounded.length * 10; i++) {
    const idx = i % rounded.length;

    if (diff > 0) {
      if (rounded[idx] + 0.000001 <= max) {
        rounded[idx] = parseFloat((rounded[idx] + 0.000001).toFixed(6));
        diff = parseFloat((diff - 0.000001).toFixed(6));
      }
    } else {
      if (rounded[idx] - 0.000001 >= min) {
        rounded[idx] = parseFloat((rounded[idx] - 0.000001).toFixed(6));
        diff = parseFloat((diff + 0.000001).toFixed(6));
      }
    }
  }

  return rounded;
}

function bundleGenerateKeypair() {
  if (!window.solanaWeb3?.Keypair) {
    throw new Error('Solana web3 SDK not loaded — cannot generate keypairs');
  }

  const kp = window.solanaWeb3.Keypair.generate();

  if (!kp?.publicKey?.toBase58 || !kp?.secretKey) {
    throw new Error('Generated keypair is missing expected fields');
  }

  return {
    publicKey: kp.publicKey.toBase58(),
    privateKey: bs58encode(kp.secretKey),
  };
}

function bundleBuildGeneratedWallets(walletCount) {
  const wallets = [];

  for (let i = 0; i < walletCount; i++) {
    const kp = bundleGenerateKeypair();

    if (!kp.publicKey || !kp.privateKey) {
      throw new Error(`Generated wallet ${i + 1} is invalid`);
    }

    wallets.push(kp);
  }

  return wallets;
}

async function runCreateBundle() {
  const c = S.bundle.create || {};
  const sourceWallet = (S.savedWallets || []).find(w => w.id === c.sourceWalletId);
  const sourcePriv = (c.sourceWalletPrivKey || sourceWallet?.privateKey || '').trim();
  const walletCount = Math.max(1, Math.min(50, parseInt(c.walletCount, 10) || 5));
  const totalSol = parseFloat(c.totalSol);
  const minPerWallet = parseFloat(c.minSolPerWallet) || 0;
  const maxPerWallet = parseFloat(c.maxSolPerWallet) || 0;
  const distrib = c.distribMode || 'equal';

  const staggerFunding = !!c.staggerFunding;
  const staggerMinSec = Math.max(1, parseInt(c.staggerMinSec, 10) || 30);
  const staggerMaxSec = Math.max(staggerMinSec, parseInt(c.staggerMaxSec, 10) || 60);

  if (!sourcePriv) throw new Error('Select a source wallet with a private key');
  if (!totalSol || totalSol <= 0) throw new Error('Enter a valid SOL amount');
  if (staggerFunding && staggerMinSec > staggerMaxSec) {
    throw new Error('Stagger min delay cannot be greater than stagger max delay');
  }

  const setStep = (step, pct) => {
    if (!S.bundle.create) S.bundle.create = {};
    S.bundle.create.runStep = step;
    S.bundle.create.runPct = pct;

    const stepEl = document.querySelector('.loading-step');
    const barEl = document.querySelector('.loading-bar');
    const pctEl = document.querySelector('.loading-pct');

    if (stepEl) stepEl.textContent = step;
    if (barEl) barEl.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
  };

  setStep('Generating fresh wallets…', 10);
  await bundleSleep(150);

  const generatedWallets = bundleBuildGeneratedWallets(walletCount);
  console.log('[bundle] generated wallets', generatedWallets);

  setStep('Calculating distribution…', 18);
  const amounts = bundleDistributeSOL(
    totalSol,
    walletCount,
    distrib,
    minPerWallet,
    maxPerWallet
  );

  const splits = generatedWallets.map((wallet, i) => {
    if (!wallet?.publicKey) {
      throw new Error(`Generated wallet ${i + 1} is missing a publicKey`);
    }

    return {
      address: wallet.publicKey,
      amount: amounts[i],
    };
  });

  console.log('[bundle] splits payload', splits);

  setStep('Creating SplitNow quote/order…', 25);
  const staggerFunding = !!c.staggerFunding;
  const staggerMinSec = Math.max(1, parseInt(c.staggerMinSec) || 30);
  const staggerMaxSec = Math.max(staggerMinSec, parseInt(c.staggerMaxSec) || 60);

  const createRes = await splitNowReq('POST', '/create-bundle', {
    source_private_key: sourcePriv,
    splits,
    exchanger_id: 'binance',
    stagger_funding: staggerFunding,
    stagger_min_sec: staggerMinSec,
    stagger_max_sec: staggerMaxSec,
  });

  const data = createRes?.data || {};
  const orderId = data.orderId || data.shortId;
  if (!orderId) throw new Error('SplitNow did not return an order ID');

  setStep('Deposit sent — waiting for SplitNow…', 45);

  let latestOrder = data.fetchedOrder || null;
  let completed = false;

  const POLL_INTERVAL_MS = 5000;
  const estimatedStaggerMs = staggerFunding
    ? Math.max(0, walletCount - 1) * (staggerMaxSec * 1000)
    : 0;
  const extraProcessingMs = 5 * 60 * 1000;
  const minimumWaitMs = 20 * 60 * 1000;
  const totalWaitMs = Math.max(minimumWaitMs, estimatedStaggerMs + extraProcessingMs);
  const MAX_POLLS = Math.ceil(totalWaitMs / POLL_INTERVAL_MS);

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await bundleSleep(POLL_INTERVAL_MS);

    const orderRes = await splitNowReq('GET', `/order/${orderId}`);
    latestOrder = orderRes;
    const orderData = orderRes?.data || orderRes;

    const statusShort = String(orderData?.statusShort || '').toLowerCase();
    const statusText = String(orderData?.statusText || '').toLowerCase();
    const rawStatus = String(orderData?.status || '').toLowerCase();

    console.log('[bundle] polled order status', {
      attempt: attempt + 1,
      status: rawStatus,
      statusShort,
      statusText,
      orderData
    });

    const pct = Math.min(95, 45 + Math.floor(((attempt + 1) / MAX_POLLS) * 45));
    setStep(
      `Processing order… ${orderData?.statusText || orderData?.statusShort || orderData?.status || 'pending'}`,
      pct
    );

    if (
      rawStatus === 'completed' ||
      statusShort === 'completed' ||
      statusText === 'completed'
    ) {
      completed = true;
      break;
    }

    if (
      rawStatus === 'failed' ||
      rawStatus === 'cancelled' ||
      statusShort === 'failed' ||
      statusShort === 'cancelled' ||
      statusText === 'failed' ||
      statusText === 'cancelled'
    ) {
      throw new Error(`SplitNow order failed: ${orderData?.statusText || orderData?.status || 'unknown status'}`);
    }
  }

  if (!completed) {
    const last = latestOrder?.data || latestOrder || {};
    throw new Error(
      `SplitNow order timed out. Last status: ${last.statusText || last.statusShort || last.status || 'unknown'}`
    );
  }

  setStep('Finalising…', 98);
  await bundleSleep(250);

  const wallets = generatedWallets.map((wallet, i) => ({
    publicKey: wallet.publicKey,
    privateKey: wallet.privateKey,
    sol: amounts[i],
  }));

  const result = {
    id: uid(),
    ts: Date.now(),
    wallets,
    totalSol: parseFloat(totalSol.toFixed(6)),
    distribMode: distrib,
    groupName: c.groupName?.trim() || `Bundle ${new Date().toLocaleDateString('en-GB')}`,
    addToGroup: !!c.addToGroup,
    orderId: data.orderId || null,
    shortId: data.shortId || null,
    depositTxSig: data.depositTxSig || null,
    depositAddress: data.depositAddress || null,
    depositAmount: data.depositAmount || null,
    staggerFunding,
    staggerMinSec: staggerFunding ? staggerMinSec : null,
    staggerMaxSec: staggerFunding ? staggerMaxSec : null,
    orderData: latestOrder,
  };

  if (!S.bundle.createHistory) S.bundle.createHistory = [];
  S.bundle.createHistory.push(result);
  if (S.bundle.createHistory.length > 20) {
    S.bundle.createHistory = S.bundle.createHistory.slice(-20);
  }

  if (c.addToGroup) {
    const groupName = result.groupName;
    const groupId = uid();

    S.walletGroups = S.walletGroups || [];
    S.walletGroups.push({
      id: groupId,
      name: groupName,
      emoji: '📦',
      collapsed: false,
    });

    wallets.forEach((wallet, i) => {
      S.savedWallets.push({
        id: uid(),
        name: `${groupName} W${i + 1}`,
        emoji: '💼',
        publicKey: wallet.publicKey,
        privateKey: wallet.privateKey,
        groupId,
      });
    });

    if (typeof syncWalletsToServer === 'function') {
      await syncWalletsToServer();
    }

    showToast(`✓ ${wallets.length} wallets saved to "${groupName}"`);
  }

  return result;
}

// ══════════════════════════════════════════
// BUNDLE CHECK LOGIC
// ══════════════════════════════════════════
function isPumpFunBuy(tx, mintAddress) {
  if (!tx?.transaction?.message) return false;
  const accounts = tx.transaction.message.accountKeys || [];
  const addrs = accounts.map(a => typeof a === 'string' ? a : a.pubkey);
  return addrs.includes(PUMPFUN_PROGRAM);
}

function extractBuyer(tx, mintAddress) {
  if (!tx?.meta) return null;
  const postBals = tx.meta.postTokenBalances || [];
  const preBals = tx.meta.preTokenBalances || [];
  const accounts = tx.transaction?.message?.accountKeys || [];
  const sig = tx.transaction?.signatures?.[0] || '';

  for (const post of postBals) {
    if (post.mint !== mintAddress) continue;
    if (!post.owner) continue;
    const pre = preBals.find(p => p.accountIndex === post.accountIndex);
    const preAmt = Number(pre?.uiTokenAmount?.uiAmount || 0);
    const postAmt = Number(post.uiTokenAmount?.uiAmount || 0);
    if (postAmt > preAmt) {
      return {
        wallet: post.owner,
        amount: postAmt - preAmt,
        slot: tx.slot,
        timestamp: tx.blockTime,
        signature: sig,
        isPump: isPumpFunBuy(tx, mintAddress),
        verdict: 'UNKNOWN',
        fundingSource: null,
        bundleGroup: null,
      };
    }
  }

  const solPre = tx.meta.preBalances || [];
  const solPost = tx.meta.postBalances || [];
  const acctKeys = accounts.map(a => typeof a === 'string' ? a : a.pubkey);
  const prog = acctKeys.indexOf(PUMPFUN_PROGRAM);
  if (prog === -1) return null;

  let maxSpent = 0;
  let buyerIdx = -1;
  for (let i = 0; i < acctKeys.length; i++) {
    const spent = (solPre[i] || 0) - (solPost[i] || 0);
    if (spent > maxSpent) {
      maxSpent = spent;
      buyerIdx = i;
    }
  }
  if (buyerIdx === -1) return null;

  return {
    wallet: acctKeys[buyerIdx],
    amount: 0,
    slot: tx.slot,
    timestamp: tx.blockTime,
    signature: sig,
    isPump: true,
    verdict: 'UNKNOWN',
    fundingSource: null,
    bundleGroup: null,
    solSpent: maxSpent / 1e9,
  };
}

async function getTokenSupply(mintAddress) {
  const r = await bundleRpc('getTokenSupply', [mintAddress]);
  return r?.value?.uiAmount || null;
}

async function analyzeBundles(mintAddress, onProgress) {
  const prog = (step, pct) => onProgress?.({ step, pct });
  prog('Fetching token transactions…', 5);

  const sigs = await bundleRpc('getSignaturesForAddress', [mintAddress, { limit: 100 }]);
  if (!sigs?.length) throw new Error('No transactions found for this token');

  prog('Fetching transaction details…', 15);
  const totalSupply = await getTokenSupply(mintAddress);
  const buyers = [];
  const batchSize = 10;

  for (let i = 0; i < Math.min(sigs.length, 80); i += batchSize) {
    const batch = sigs.slice(i, i + batchSize);
    const txs = await Promise.all(batch.map(s =>
      bundleRpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
    ));

    for (const tx of txs) {
      if (!tx) continue;
      const buyer = extractBuyer(tx, mintAddress);
      if (buyer) buyers.push(buyer);
    }

    prog(`Analysing transactions… (${Math.min(i + batchSize, sigs.length)}/${Math.min(sigs.length, 80)})`, 15 + Math.floor((i / 80) * 45));
    await bundleSleep(150);
  }

  if (!buyers.length) throw new Error('No buy transactions found');

  prog('Tracing funding sources…', 62);
  const uniqueWallets = [...new Set(buyers.map(b => b.wallet))];
  const fundingMap = {};

  for (let i = 0; i < uniqueWallets.length; i++) {
    fundingMap[uniqueWallets[i]] = await traceFundingSource(uniqueWallets[i]);
    prog(`Tracing wallets… (${i + 1}/${uniqueWallets.length})`, 62 + Math.floor((i / uniqueWallets.length) * 25));
    await bundleSleep(100);
  }

  prog('Detecting bundles…', 88);
  const result = detectBundleGroups(buyers, fundingMap, totalSupply);
  prog('Done', 100);
  return result;
}

function detectBundleGroups(buyers, fundingMap, totalSupply) {
  const bySlot = {};
  const byFunder = {};

  for (const b of buyers) {
    const slotKey = String(b.slot);
    if (!bySlot[slotKey]) bySlot[slotKey] = [];
    bySlot[slotKey].push(b);

    const fs = fundingMap[b.wallet]?.fundingSource;
    if (fs) {
      if (!byFunder[fs]) byFunder[fs] = [];
      byFunder[fs].push(b);
    }
  }

  let groupIndex = 1;
  for (const group of Object.values(bySlot)) {
    if (group.length >= 2) {
      group.forEach(b => {
        b.verdict = 'BUNDLED';
        b.bundleGroup = `Block ${groupIndex}`;
      });
      groupIndex++;
    }
  }

  for (const [funder, group] of Object.entries(byFunder)) {
    if (group.length >= 2) {
      group.forEach(b => {
        if (b.verdict === 'UNKNOWN') {
          b.verdict = 'BUNDLED';
          b.bundleGroup = `Funder ${short(funder)}`;
        }
        b.fundingSource = funder;
      });
    }
  }

  if (totalSupply) {
    for (const b of buyers) {
      if (b.verdict !== 'UNKNOWN') continue;
      if (b.amount / totalSupply >= 0.5) b.verdict = 'FULLPORT';
      else if (b.amount / totalSupply >= 0.1) b.verdict = 'SUSPICIOUS';
      else b.verdict = 'CLEAN';
    }
  } else {
    buyers.filter(b => b.verdict === 'UNKNOWN').forEach(b => {
      b.verdict = 'EARLY';
    });
  }

  const bundled = buyers.filter(b => b.verdict === 'BUNDLED').length;
  const fullport = buyers.filter(b => b.verdict === 'FULLPORT').length;
  const suspicious = buyers.filter(b => b.verdict === 'SUSPICIOUS').length;
  const clean = buyers.filter(b => b.verdict === 'CLEAN').length;
  const bundleGroups = new Set(buyers.filter(b => b.bundleGroup).map(b => b.bundleGroup)).size;
  const bundledAmt = buyers.filter(b => b.verdict === 'BUNDLED').reduce((s, b) => s + b.amount, 0);
  const bundledPct = totalSupply ? Math.round((bundledAmt / totalSupply) * 100) : null;

  return {
    buyers,
    totalSupply,
    stats: { total: buyers.length, bundled, fullport, suspicious, clean, bundleGroups, bundledPct },
    fundingMap,
  };
}

async function traceFundingSource(walletAddress) {
  try {
    const sigs = await bundleRpc('getSignaturesForAddress', [walletAddress, { limit: 10 }]);
    if (!sigs?.length) return { fundingSource: null, fundingAmount: 0, fundingSlot: null };

    const oldest = [...sigs].reverse().slice(0, 5);
    for (const sig of oldest) {
      const tx = await bundleRpc('getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (!tx?.meta) continue;

      const accounts = (tx.transaction?.message?.accountKeys || []).map(a => typeof a === 'string' ? a : a.pubkey);
      const pre = tx.meta.preBalances || [];
      const post = tx.meta.postBalances || [];
      const walletIdx = accounts.indexOf(walletAddress);
      if (walletIdx === -1) continue;

      const gained = (post[walletIdx] || 0) - (pre[walletIdx] || 0);
      if (gained <= 0) continue;

      let sender = null;
      let maxLost = 0;
      for (let i = 0; i < accounts.length; i++) {
        if (accounts[i] === walletAddress) continue;
        const lost = (pre[i] || 0) - (post[i] || 0);
        if (lost > maxLost) {
          maxLost = lost;
          sender = accounts[i];
        }
      }

      if (sender && maxLost > 5000) {
        return { fundingSource: sender, fundingAmount: maxLost, fundingSlot: tx.slot };
      }
    }

    return { fundingSource: null, fundingAmount: 0, fundingSlot: null };
  } catch {
    return { fundingSource: null, fundingAmount: 0, fundingSlot: null };
  }
}

async function analyzeWalletConnections(addresses, onProgress) {
  const prog = (step, pct) => onProgress?.({ step, pct });
  prog('Tracing wallet histories…', 5);

  const results = {};
  for (let i = 0; i < addresses.length; i++) {
    results[addresses[i]] = await traceFundingSource(addresses[i]);
    prog(`Tracing ${i + 1}/${addresses.length}…`, 5 + Math.floor((i / addresses.length) * 80));
    await bundleSleep(120);
  }

  prog('Comparing sources…', 88);
  const groups = {};
  for (const [addr, info] of Object.entries(results)) {
    const src = info.fundingSource || 'unknown';
    if (!groups[src]) groups[src] = [];
    groups[src].push(addr);
  }

  const linkedGroups = Object.entries(groups).filter(([src, ws]) => src !== 'unknown' && ws.length >= 2);
  prog('Done', 100);
  return { addresses, fundingMap: results, linkedGroups };
}

// ══════════════════════════════════════════
// TOKEN + WALLET RESULT VIEWS
// ══════════════════════════════════════════
function buildBundleTokenResult() {
  const r = S.bundle.result;
  if (!r) {
    S.bundle.view = 'landing';
    return buildBundleLanding();
  }

  const s = r.stats;
  const buyers = r.buyers || [];
  const groups = {
    BUNDLED: buyers.filter(b => b.verdict === 'BUNDLED'),
    FULLPORT: buyers.filter(b => b.verdict === 'FULLPORT'),
    SUSPICIOUS: buyers.filter(b => b.verdict === 'SUSPICIOUS'),
    EARLY: buyers.filter(b => b.verdict === 'EARLY'),
    CLEAN: buyers.filter(b => b.verdict === 'CLEAN'),
  };

  const riskScore = Math.min(100, s.bundled * 10 + s.fullport * 25 + s.suspicious * 5);
  const riskColor = riskScore >= 60 ? 'var(--danger)' : riskScore >= 30 ? 'var(--warn)' : 'var(--green-dim)';
  const riskLabel = riskScore >= 60 ? 'HIGH RISK' : riskScore >= 30 ? 'MEDIUM RISK' : 'LOW RISK';

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Token Analysis</span>
        <button class="btn btn-ghost btn-sm" data-action="bundle-back">← Back</button>
      </div>
    </div>

    <div class="scroll-area" id="scroll-area">
      <div style="background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r);padding:12px 14px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <span style="font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-dim)">Risk Assessment</span>
          <span style="font-size:11px;font-weight:700;color:${riskColor}">${riskLabel}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">
          <div class="bundle-stat"><div class="bundle-stat-val">${s.total}</div><div class="bundle-stat-label">Buyers</div></div>
          <div class="bundle-stat"><div class="bundle-stat-val" style="color:var(--danger)">${s.bundled}</div><div class="bundle-stat-label">Bundled</div></div>
          <div class="bundle-stat"><div class="bundle-stat-val" style="color:var(--warn)">${s.fullport}</div><div class="bundle-stat-label">Full-port</div></div>
          <div class="bundle-stat"><div class="bundle-stat-val" style="color:var(--green-dim)">${s.clean}</div><div class="bundle-stat-label">Clean</div></div>
        </div>
        ${s.bundledPct !== null ? `<div style="font-size:10px;color:var(--text-muted);margin-top:8px;padding-top:8px;border-top:1px solid var(--border-md)">Bundled wallets hold <strong style="color:var(--danger)">${s.bundledPct}%</strong> of visible supply</div>` : ''}
      </div>

      ${groups.BUNDLED.length ? `<div class="bc-section-hdr" style="color:var(--danger)">🔴 Confirmed Bundles — ${s.bundleGroups} group${s.bundleGroups !== 1 ? 's' : ''}</div>${groups.BUNDLED.map(w => buildBundleWalletRow(w, r.totalSupply)).join('')}` : ''}
      ${groups.FULLPORT.length ? `<div class="bc-section-hdr" style="color:var(--danger);margin-top:12px">🟠 Full-Port Buys</div>${groups.FULLPORT.map(w => buildBundleWalletRow(w, r.totalSupply)).join('')}` : ''}
      ${groups.SUSPICIOUS.length ? `<div class="bc-section-hdr" style="color:var(--warn);margin-top:12px">🟡 Suspicious</div>${groups.SUSPICIOUS.map(w => buildBundleWalletRow(w, r.totalSupply)).join('')}` : ''}
      ${groups.EARLY.length ? `<div class="bc-section-hdr" style="color:var(--text-muted);margin-top:12px">⚪ Early Buyers</div>${groups.EARLY.map(w => buildBundleWalletRow(w, r.totalSupply)).join('')}` : ''}
      ${groups.CLEAN.length ? `<div class="bc-section-hdr" style="color:var(--green-dim);margin-top:12px">🟢 Clean</div>${groups.CLEAN.map(w => buildBundleWalletRow(w, r.totalSupply)).join('')}` : ''}
    </div>
  `;
}

function buildBundleWalletResult() {
  const r = S.bundle.walletResult;
  if (!r) {
    S.bundle.view = 'landing';
    return buildBundleLanding();
  }

  const linked = r.linkedGroups || [];

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Wallet Connections</span>
        <button class="btn btn-ghost btn-sm" data-action="bundle-back">← Back</button>
      </div>
    </div>

    <div class="scroll-area" id="scroll-area">
      ${linked.length === 0 ? `
        <div style="background:var(--green-bg);border:1px solid rgba(34,197,94,0.25);border-radius:var(--r);padding:14px;text-align:center">
          <div style="font-size:14px;margin-bottom:5px">✅</div>
          <div style="font-size:11px;font-weight:700;color:var(--green-dim)">No connections found</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:4px">These wallets don't appear to share a funding source.</div>
        </div>
      ` : `
        <div class="error-card" style="margin-bottom:12px">⚠ ${linked.length} linked group${linked.length > 1 ? 's' : ''} found — these wallets likely share an owner.</div>
        ${linked.map(([funder, wallets]) => `
          <div style="background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r);padding:10px 12px;margin-bottom:8px">
            <div style="font-size:9.5px;font-weight:700;color:var(--danger);margin-bottom:6px">Shared funder: <span style="font-family:var(--mono)">${short(funder)}</span></div>
            ${wallets.map(addr => {
              const saved = (S.savedWallets || []).find(w => w.publicKey === addr);
              return `
                <div style="font-size:9.5px;color:var(--text-dim);padding:3px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">
                  ${saved ? `<span>${saved.emoji || '💼'} ${saved.name}</span>` : ''}
                  <span style="font-family:var(--mono)">${short(addr)}</span>
                  <button class="btn btn-ghost btn-sm" style="padding:1px 5px;font-size:8px;margin-left:auto" data-action="copy" data-copy="${addr}">Copy</button>
                </div>
              `;
            }).join('')}
          </div>
        `).join('')}
      `}
    </div>
  `;
}

function buildBundleWalletRow(w, totalSupply) {
  const pct = totalSupply && w.amount ? ((w.amount / totalSupply) * 100).toFixed(2) : null;
  const colors = {
    BUNDLED: 'var(--danger)',
    FULLPORT: 'var(--danger)',
    SUSPICIOUS: 'var(--warn)',
    CLEAN: 'var(--green-dim)',
    EARLY: 'var(--text-muted)',
  };

  return `
    <div style="background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r-sm);padding:8px 10px;margin-bottom:5px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
        <span style="font-family:var(--mono);font-size:9.5px;color:var(--text-dim);cursor:pointer" data-action="copy" data-copy="${w.wallet}">${short(w.wallet)}</span>
        <div style="display:flex;align-items:center;gap:5px">
          ${w.bundleGroup ? `<span style="font-size:8px;background:rgba(220,38,38,0.1);color:var(--danger);padding:1px 5px;border-radius:20px">${w.bundleGroup}</span>` : ''}
          <span style="font-size:8.5px;font-weight:700;color:${colors[w.verdict] || 'var(--text-muted)'}">${w.verdict}</span>
        </div>
      </div>
      <div style="display:flex;gap:10px;font-size:9px;color:var(--text-muted);flex-wrap:wrap">
        ${w.amount ? `<span>${w.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens${pct ? ` (${pct}%)` : ''}</span>` : ''}
        ${w.solSpent ? `<span>${w.solSpent.toFixed(4)} SOL</span>` : ''}
        ${w.fundingSource ? `<span>Funder: <span style="font-family:var(--mono)">${short(w.fundingSource)}</span></span>` : ''}
      </div>
    </div>
  `;
}

// expose to global scope (fixes "buildBundlePage is not defined")
if (typeof window !== 'undefined') {
  window.buildBundlePage = buildBundlePage;
}