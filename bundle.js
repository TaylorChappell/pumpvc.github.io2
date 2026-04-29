/* ═══════════════════════════════════════════
   bundle.js — Bundle Engine + Checker
   Essor Studios / Solana Dev Tools
   UI consistent with volume-bot.js / split.js
═══════════════════════════════════════════ */
'use strict';

/* ── Inline styles (injected once) ─────────── */
(function bundleInjectStyles() {
  if (document.getElementById('bundle-styles')) return;
  const s = document.createElement('style');
  s.id = 'bundle-styles';
  s.textContent = `
    .bundle-tabs { display:flex; border-bottom:1px solid var(--border-md); margin:0 -14px; padding:0 14px; }
    .bundle-progress-card { background:var(--surface); border:1px solid var(--border-md); border-radius:var(--r); padding:12px 14px; margin:10px 0; }
    .bundle-progress-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:7px; }
    .bundle-progress-step { font-size:10px; color:var(--text-dim); }
    .bundle-progress-pct { font-size:10px; font-weight:600; color:var(--navy); font-family:var(--mono); }
    .bundle-progress-bar-wrap { background:var(--border-md); border-radius:3px; height:3px; overflow:hidden; }
    .bundle-progress-bar { background:var(--navy); height:100%; transition:width 0.3s ease; border-radius:3px; }
    .bundle-log-wrap { background:var(--surface); border:1px solid var(--border-md); border-radius:var(--r); overflow:hidden; }
    .bundle-log-toolbar { display:flex; justify-content:space-between; align-items:center; padding:6px 10px; border-bottom:1px solid var(--border-md); }
    .bundle-log-label { font-size:9.5px; font-weight:700; letter-spacing:.06em; color:var(--text-dim); text-transform:uppercase; }
    .bundle-log-feed { max-height:280px; overflow-y:auto; }
    .bundle-log-entry { display:flex; gap:7px; align-items:baseline; padding:4px 10px; border-bottom:1px solid var(--border); }
    .bundle-log-entry:last-child { border-bottom:none; }
    .bundle-log-ts { font-family:var(--mono); font-size:8.5px; color:var(--text-muted); flex-shrink:0; }
    .bundle-log-msg { font-family:var(--mono); font-size:9.5px; word-break:break-word; color:var(--text-mid); }
    .bundle-log-entry.log-ok   .bundle-log-msg { color:#16a34a; }
    .bundle-log-entry.log-err  .bundle-log-msg { color:#dc2626; }
    .bundle-log-entry.log-warn .bundle-log-msg { color:#d97706; }
    .bundle-hist-card { background:var(--surface); border:1px solid var(--border-md); border-radius:var(--r); margin-bottom:8px; overflow:hidden; }
    .bundle-hist-hdr { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; cursor:pointer; }
    .bundle-hist-hdr:hover { background:var(--surface2); }
    .bundle-hist-chevron { font-size:13px; color:var(--text-muted); transition:transform 0.15s; display:inline-block; }
    .bundle-hist-chevron.open { transform:rotate(90deg); }
    .bundle-wallet-card { background:var(--surface2); border:1px solid var(--border-md); border-radius:var(--r-sm); padding:8px 10px; margin-bottom:6px; }
    .bundle-wallet-field-lbl { font-size:8.5px; font-weight:700; letter-spacing:.05em; color:var(--text-muted); text-transform:uppercase; margin-bottom:2px; }
    .bundle-wallet-row { display:flex; align-items:center; gap:4px; }
    .bundle-wallet-val { font-family:var(--mono); font-size:9px; color:var(--text-dim); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .bc-verdict { display:inline-block; font-size:8px; font-weight:700; padding:1px 6px; border-radius:20px; letter-spacing:.03em; }
    .bc-verdict-bundled    { background:rgba(220,38,38,.1); color:var(--danger); }
    .bc-verdict-fullport   { background:rgba(220,38,38,.1); color:var(--danger); }
    .bc-verdict-suspicious { background:rgba(217,119,6,.1);  color:var(--warn); }
    .bc-verdict-clean      { background:rgba(34,197,94,.1);  color:var(--green-dim); }
    .bc-verdict-early      { background:var(--surface2);     color:var(--text-muted); }
  `;
  document.head.appendChild(s);
})();

/* ── Constants ──────────────────────────────── */
const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymMDer';
const RAYDIUM_AMM     = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

/* ── Core helpers ───────────────────────────── */
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
  } catch { return null; }
}

function bundleSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function bShort(addr) {
  if (!addr) return '—';
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

/* ── Logging ────────────────────────────────── */
const BUNDLE_LOG_MAX = 200;

function bundleLog(msg, type = 'info') {
  if (typeof S === 'undefined') return;
  if (!S.bundle) S.bundle = {};
  if (!S.bundle.runLog) S.bundle.runLog = [];
  const ts = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const id = typeof uid === 'function' ? uid() : Math.random().toString(36).slice(2);
  S.bundle.runLog.unshift({ id, ts, msg, type });
  if (S.bundle.runLog.length > BUNDLE_LOG_MAX) S.bundle.runLog = S.bundle.runLog.slice(0, BUNDLE_LOG_MAX);

  const feed = document.getElementById('bundle-log-feed');
  if (feed) {
    const d = document.createElement('div');
    d.className = 'bundle-log-entry log-' + type;
    const safe = String(msg).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    d.innerHTML = '<span class="bundle-log-ts">' + ts + '</span><span class="bundle-log-msg">' + safe + '</span>';
    feed.insertBefore(d, feed.firstChild);
    while (feed.children.length > 80) feed.removeChild(feed.lastChild);
    const cnt = document.getElementById('bundle-log-count');
    if (cnt) cnt.textContent = S.bundle.runLog.length + ' entries';
  }
}

/* ── SplitNow proxy ─────────────────────────── */
async function splitNowReq(method, path, body) {
  let token = null;
  if (typeof Auth !== 'undefined' && Auth.getToken) token = await Auth.getToken();
  if (!token) token = localStorage.getItem('udt_token');
  if (!token) throw new Error('Not logged in');

  let url = '';
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
  };

  if (method === 'POST' && path === '/create-bundle') {
    url = BACKEND + '/api/proxy/splitnow/create-bundle';
    opts.body = JSON.stringify(body || {});
  } else if (method === 'GET' && path.startsWith('/order/')) {
    const id = path.split('/order/')[1];
    url = BACKEND + '/api/proxy/splitnow/order/' + encodeURIComponent(id);
  } else {
    throw new Error('Unsupported SplitNow proxy route: ' + method + ' ' + path);
  }

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text || 'HTTP ' + res.status }; }
  if (!res.ok) throw new Error(data?.error || data?.message || 'Proxy error ' + res.status);
  return data;
}

/* ════════════════════════════════════════════
   PAGE ROUTER
═══════════════════════════════════════════ */
function buildBundlePage() {
  const b = S.bundle || {};
  if (b.view === 'token-result')  return buildBundleTokenResult();
  if (b.view === 'wallet-result') return buildBundleWalletResult();
  if (b.view === 'create-result') return buildCreateBundleResult();
  return buildBundleLanding();
}

/* ════════════════════════════════════════════
   LANDING
═══════════════════════════════════════════ */
function buildBundleLanding() {
  const b   = S.bundle || {};
  const tab = b.createTab || 'check';
  const logCount  = (b.runLog || []).length;
  const histCount = (b.createHistory || []).length;

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Bundle</span>
      </div>
      <div class="bundle-tabs">
        <button class="tab ${tab==='check'  ?'active':''}" data-action="bundle-tab" data-tab="check">Check</button>
        <button class="tab ${tab==='create' ?'active':''}" data-action="bundle-tab" data-tab="create">Create</button>
        <button class="tab ${tab==='auto'   ?'active':''}" data-action="bundle-tab" data-tab="auto">
          Auto${(S.bundle && S.bundle.auto && S.bundle.auto.active) ? ' <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 0 2px var(--green-bg);vertical-align:middle;margin-left:3px;animation:pulse-dot 1.8s ease-in-out infinite"></span>' : ''}
        </button>
        <button class="tab ${tab==='log'    ?'active':''}" data-action="bundle-tab" data-tab="log">
          Log${logCount ? ' <span class="nav-badge" style="background:var(--navy-ghost2);color:var(--navy);font-size:7px;padding:1px 4px">' + Math.min(logCount,99) + '</span>' : ''}
        </button>
        <button class="tab ${tab==='history'?'active':''}" data-action="bundle-tab" data-tab="history">
          History${histCount ? '<span style="margin-left:4px;background:var(--navy-ghost2);color:var(--navy);font-size:8px;font-weight:700;padding:1px 5px;border-radius:20px">' + histCount + '</span>' : ''}
        </button>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">
      ${tab==='check'  ? buildBundleCheckTab()  : ''}
      ${tab==='create' ? buildBundleCreateTab() : ''}
      ${tab==='log'    ? buildBundleLogTab()    : ''}
      ${tab==='history'? buildBundleHistoryTab(): ''}
      ${tab==='auto'    ? (typeof buildAutoBundleTab === 'function' ? buildAutoBundleTab() : '') : ''}
    </div>`;
}

/* ════════════════════════════════════════════
   CHECK TAB — wallet picker
═══════════════════════════════════════════ */
function buildBundleCheckWalletPicker() {
  const b = S.bundle || {};
  const open = !!b._walletPickerOpen;
  const selectedList = b.walletAddresses || [];
  const selected = new Set(selectedList);
  const allWallets = (S.savedWallets || []).filter(w => w.publicKey);
  const groups = S.walletGroups || [];
  const ungrouped = allWallets.filter(w => !w.groupId);
  const count = selected.size;
  // Refresh balances when the wallet picker is open
  if (open && typeof wRefreshBalancesIfStale === 'function') wRefreshBalancesIfStale(allWallets);

  const chips = selectedList.map((addr, i) => {
    const w = allWallets.find(x => x.publicKey === addr);
    return '<span style="display:inline-flex;align-items:center;gap:4px;background:var(--navy-ghost);color:var(--navy);border-radius:999px;padding:3px 8px;font-size:9px;font-family:var(--mono)">'
      + (w ? (w.emoji||'💼')+' '+w.name : bShort(addr))
      + '<span data-action="bc-wallet-remove" data-idx="'+i+'" style="cursor:pointer;opacity:.55">\u2715</span></span>';
  }).join('');

  let dropdownInner = '';
  for (const g of groups) {
    const gw = allWallets.filter(w => w.groupId===g.id && w.publicKey);
    if (!gw.length) continue;
    const selCount = gw.filter(w => selected.has(w.publicKey)).length;
    const allSel = selCount===gw.length;
    const partial = selCount>0 && !allSel;
    dropdownInner += '<div class="tpicker-group-row'+(allSel?' selected':'')+(partial?' partial':'')+'" data-action="bundle-check-wallet-group" data-gid="'+g.id+'">'
      + '<div class="tpicker-check'+(allSel?' checked':'')+(partial?' partial':'')+'"></div>'
      + '<span>'+(g.emoji||'📁')+'</span><span class="tpicker-group-name">'+g.name+'</span>'
      + '<span class="tpicker-count">'+gw.length+'</span></div>';
    for (const w of gw) {
      const sel = selected.has(w.publicKey);
      dropdownInner += '<div class="tpicker-wallet-row'+(sel?' selected':'')+'" data-action="bundle-check-wallet-pick" data-pub="'+w.publicKey+'">'
        + '<div class="tpicker-check'+(sel?' checked':'')+'"></div><span>'+(w.emoji||'💼')+'</span>'
        + '<div class="tpicker-info"><span class="tpicker-name">'+(w.name||'Wallet')+'</span><span class="tpicker-addr">'+bShort(w.publicKey)+'</span></div></div>';
    }
  }
  for (const w of ungrouped) {
    const sel = selected.has(w.publicKey);
    dropdownInner += '<div class="tpicker-wallet-row'+(sel?' selected':'')+'" data-action="bundle-check-wallet-pick" data-pub="'+w.publicKey+'">'
      + '<div class="tpicker-check'+(sel?' checked':'')+'"></div><span>'+(w.emoji||'💼')+'</span>'
      + '<div class="tpicker-info"><span class="tpicker-name">'+(w.name||'Wallet')+'</span><span class="tpicker-addr">'+bShort(w.publicKey)+'</span></div></div>';
  }
  if (!allWallets.length) dropdownInner += '<div class="cpicker-empty">No saved wallets yet.</div>';

  return `
    <div class="field" style="margin-bottom:0">
      ${count>0 ? '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">'+chips+'</div>' : ''}
      <div class="cpicker-wrap">
        <div class="cpicker-btn ${count>0?'cpicker-selected':''}" data-action="bundle-check-wallet-toggle">
          <span style="font-size:11px;font-weight:600;flex:1;color:${count>0?'var(--navy)':'var(--text-muted)'}">
            ${count>0 ? count+' wallet'+(count!==1?'s':'')+' selected' : 'Select wallet, group, or paste address\u2026'}
          </span>
          <span class="cpicker-chevron ${open?'open':''}">&#8250;</span>
        </div>
        ${open ? `<div class="cpicker-dropdown">
          ${dropdownInner}
          <div class="cpicker-divider"></div>
          <div class="cpicker-paste-label">Or paste wallet address</div>
          <div style="display:flex;gap:5px;padding:0 8px 8px">
            <input type="text" id="bundle-check-paste" placeholder="Wallet address\u2026" style="flex:1;font-size:10.5px"/>
            <button class="btn btn-ghost btn-sm" data-action="bundle-check-wallet-paste">Add</button>
          </div>
        </div>` : ''}
      </div>
    </div>`;
}

function buildBundleCheckTab() {
  const b = S.bundle || {};
  const walletCount = (b.walletAddresses||[]).length;
  return `
    <div class="field">
      <div class="field-label">
        Token Contract Address
        <button class="help-q" data-action="show-help"
          data-title="Token Contract Address"
          data-body="Paste a Solana token mint address to scan its early buyers and detect bundle patterns. The tool fetches the first 80 transactions, identifies buyers, traces each wallet back to its funding source, and groups wallets that share a common funder or bought in the same block.">?</button>
      </div>
      <div class="add-row">
        <input type="text" id="bundle-ca" value="${b.ca||''}" placeholder="Token mint address\u2026"/>
        <button class="btn btn-primary btn-sm" data-action="run-bundle" ${b.loading?'disabled':''}>
          ${b.loading ? '<span class="spinner-dark"></span>' : 'Analyze'}
        </button>
      </div>
    </div>

    ${b.loading ? buildBundleProgress(b.progress) : ''}
    ${b.error   ? '<div class="error-card">\u26a0 '+b.error+'</div>' : ''}

    <div class="bc-divider"></div>

    <div class="settings-section" style="padding-bottom:12px;margin-bottom:0">
      <div class="settings-section-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span style="display:flex;align-items:center;gap:6px">
          Wallet Connection Check
          <button class="help-q" data-action="show-help"
            data-title="Wallet Connection Check"
            data-body="Select 2+ wallets or a whole group to check whether they share the same on-chain funding source. A shared funder strongly suggests the same person controls all the wallets. Great for checking if your own bundle is detectable before launch.">?</button>
        </span>
        <span style="font-size:9px;font-weight:400;color:var(--text-muted)">${walletCount} selected</span>
      </div>

      ${buildBundleCheckWalletPicker()}

      <button class="btn btn-primary btn-sm btn-full" data-action="run-wallet-check"
        style="margin-top:8px" ${b.walletLoading||walletCount<2?'disabled':''}>
        ${b.walletLoading
          ? '<span class="spinner-dark"></span> Checking\u2026'
          : 'Check '+(walletCount>=2 ? walletCount+' Wallets' : 'Wallets (need 2+)')}
      </button>

      ${b.walletLoading ? buildBundleProgress(b.walletProgress) : ''}
      ${b.walletError   ? '<div class="error-card" style="margin-top:8px">\u26a0 '+b.walletError+'</div>' : ''}
    </div>`;
}

/* ════════════════════════════════════════════
   CREATE TAB
═══════════════════════════════════════════ */
function buildBundleCreateTab() {
  const c    = S.bundle.create || {};
  const allW = (S.savedWallets||[]).filter(w => w.publicKey && w.privateKey);
  const selSrc = allW.find(w => w.privateKey===c.sourceWalletPrivKey) || allW.find(w => w.id===c.sourceWalletId);
  const distrib = c.distribMode || 'equal';
  const count = parseInt(c.walletCount,10) || 5;
  const running = !!c.running;
  const open = !!S.bundle._createSourceOpen;
  // Refresh balances when the source picker is open
  if (open && typeof wRefreshBalancesIfStale === 'function') wRefreshBalancesIfStale(allW);
  const stagger = !!c.staggerFunding;
  const stgMin = Math.max(1, parseInt(c.staggerMinSec,10)||30);
  const stgMax = Math.max(stgMin, parseInt(c.staggerMaxSec,10)||60);

  /* Source wallet picker rows */
  let srcRows = allW.length === 0
    ? '<div class="cpicker-empty">No saved wallets with private keys.<br>Add one in the Wallets tab.</div>'
    : allW.map(w =>
        '<div class="cpicker-row '+(c.sourceWalletPrivKey===w.privateKey?'active':'')+'" data-action="bundle-src-pick" data-wallet-id="'+w.id+'" data-priv="'+encodeURIComponent(w.privateKey)+'">'
        +'<span>'+(w.emoji||'💼')+'</span>'
        +'<div class="cpicker-row-info"><span class="cpicker-name">'+(w.name||'Wallet')+'</span><span class="cpicker-addr">'+bShort(w.publicKey)+'</span></div>'
        +(w.solBalance!=null ? '<span class="cpicker-bal">'+w.solBalance+' SOL</span>' : '')
        +'</div>'
      ).join('');

  let srcLabel = selSrc
    ? '<span>'+(selSrc.emoji||'💼')+'</span><span class="cpicker-name">'+(selSrc.name||'Wallet')+'</span><span class="cpicker-addr">'+bShort(selSrc.publicKey)+'</span>'
    : c.sourceWalletPrivKey
      ? '<span>&#128273;</span><span class="cpicker-name">Custom Private Key</span><span class="cpicker-addr">Saved in form</span>'
      : '<span style="color:var(--text-muted);font-size:11px">Select source wallet\u2026</span>';

  return `
    <div class="vb-stats-row">
      <div class="vb-stat"><div class="vb-stat-val">${count}</div><div class="vb-stat-lbl">Wallets</div></div>
      <div class="vb-stat"><div class="vb-stat-val">${c.totalSol ? parseFloat(c.totalSol).toFixed(2) : '\u2014'}</div><div class="vb-stat-lbl">Total SOL</div></div>
      <div class="vb-stat"><div class="vb-stat-val">${distrib==='equal'?'Equal':'Rand'}</div><div class="vb-stat-lbl">Distrib</div></div>
      <div class="vb-stat"><div class="vb-stat-val">${stagger ? stgMin+'\u2013'+stgMax+'s' : 'Off'}</div><div class="vb-stat-lbl">Stagger</div></div>
    </div>

    <div class="vb-divider"></div>

    <div class="field">
      <div class="field-label">
        Source Wallet
        <button class="help-q" data-action="show-help"
          data-title="Source Wallet"
          data-body="The wallet that sends SOL into the SplitNow exchange. SOL travels: Source \u2192 SplitNow \u2192 fresh generated wallets. There is zero direct on-chain link from your source to the output wallets. Make sure this wallet has enough SOL to cover your total distribution plus exchange fees.">?</button>
      </div>
      <p style="font-size:10px;color:var(--text-muted);margin-bottom:8px;line-height:1.5">
        Source \u2192 SplitNow exchange \u2192 fresh wallets. No direct on-chain link.
      </p>
      <div class="cpicker-wrap">
        <div class="cpicker-btn ${selSrc||c.sourceWalletPrivKey?'cpicker-selected':''}" data-action="bundle-src-toggle">
          ${srcLabel}
          <span class="cpicker-chevron ${open?'open':''}">&#8250;</span>
        </div>
        ${open ? `<div class="cpicker-dropdown">
          ${srcRows}
          <div class="cpicker-divider"></div>
          <div class="cpicker-paste-label">Or paste private key</div>
          <div style="display:flex;gap:5px;padding:0 8px 8px">
            <input type="password" id="bundle-source-priv" value="${c.sourceWalletPrivKey||''}"
              placeholder="Base58 private key\u2026" style="flex:1;font-size:10.5px"/>
            <button class="btn btn-ghost btn-sm" data-action="bundle-src-paste">Use</button>
          </div>
        </div>` : ''}
      </div>
    </div>

    <div class="vb-divider"></div>

    <div class="field">
      <div class="field-label">
        Wallet Count
        <button class="help-q" data-action="show-help"
          data-title="Wallet Count"
          data-body="How many fresh wallets to generate. Each wallet gets a brand-new private key created in your browser. Keys are shown once after creation \u2014 enable Save to Group to persist them. Maximum 50 wallets per bundle.">?</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="number" id="cb-wallet-count" value="${count}" min="1" max="50" style="width:80px" data-bind-bundle-create="walletCount"/>
        <span style="font-size:10px;color:var(--text-muted)">wallets (max 50)</span>
      </div>
    </div>

    <div class="field">
      <div class="field-label">
        Total SOL to Distribute
        <button class="help-q" data-action="show-help"
          data-title="Total SOL to Distribute"
          data-body="The total SOL spread across all generated wallets via SplitNow. SplitNow charges a small exchange fee on top of this amount \u2014 make sure your source wallet has a slightly larger balance to cover it.">?</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="number" id="cb-total-sol" value="${c.totalSol||''}" min="0.01" step="0.01" placeholder="e.g. 5.0" style="width:110px" data-bind-bundle-create="totalSol"/>
        <span style="font-size:10px;color:var(--text-muted)">SOL total</span>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="field" style="margin-bottom:0">
        <div class="field-label" style="gap:5px">
          Min SOL/Wallet
          <button class="help-q" data-action="show-help"
            data-title="Minimum SOL per Wallet"
            data-body="Every generated wallet will receive at least this much SOL. Leave blank for no minimum. Useful when you want a floor so no wallet ends up nearly empty.">?</button>
          <span style="font-size:8.5px;color:var(--text-muted)">(optional)</span>
        </div>
        <input type="number" id="cb-min-sol" value="${c.minSolPerWallet||''}" min="0" step="0.01" placeholder="No min" data-bind-bundle-create="minSolPerWallet"/>
      </div>
      <div class="field" style="margin-bottom:0">
        <div class="field-label" style="gap:5px">
          Max SOL/Wallet
          <button class="help-q" data-action="show-help"
            data-title="Maximum SOL per Wallet"
            data-body="Optional cap so no single wallet receives too much. Keeps amounts believably varied. Leave blank for no cap.">?</button>
          <span style="font-size:8.5px;color:var(--text-muted)">(optional)</span>
        </div>
        <input type="number" id="cb-max-sol" value="${c.maxSolPerWallet||''}" min="0" step="0.01" placeholder="No cap" data-bind-bundle-create="maxSolPerWallet"/>
      </div>
    </div>

    <div class="vb-divider"></div>

    <div class="field">
      <div class="field-label">
        Distribution Mode
        <button class="help-q" data-action="show-help"
          data-title="Distribution Mode"
          data-body="Equal sends the same SOL to every wallet \u2014 straightforward but detectable on-chain. Random creates an uneven, natural-looking spread that is harder to identify as a coordinated bundle.">?</button>
      </div>
      <div class="mode-toggle">
        <button class="mode-btn ${distrib==='equal' ?'active':''}" data-action="cb-set-distrib" data-mode="equal">Equal split</button>
        <button class="mode-btn ${distrib==='random'?'active':''}" data-action="cb-set-distrib" data-mode="random">Random spread</button>
      </div>
      <p style="font-size:9.5px;color:var(--text-muted);margin:0;line-height:1.5">
        ${distrib==='equal' ? 'Every wallet receives the same amount.' : 'Amounts vary randomly within min/max \u2014 harder to fingerprint.'}
      </p>
    </div>

    <div class="vb-divider"></div>

    <div class="sf-toggle-row" style="margin-bottom:${stagger?'10px':'0'}">
      <div class="sf-toggle-left">
        <div class="field-label" style="margin-bottom:0">
          Stagger Wallet Funding
          <button class="help-q" data-action="show-help"
            data-title="Stagger Wallet Funding"
            data-body="When enabled, SplitNow waits a random delay between funding each output wallet instead of doing them all at once. This makes the timing of each wallet\u2019s first funding look organic rather than simultaneous, reducing bundle detectability.">?</button>
        </div>
        <div class="sf-toggle-hint">${stagger ? stgMin+'\u2013'+stgMax+'s random delay between wallets' : 'All wallets funded as fast as possible'}</div>
      </div>
      <div class="sf-toggle-right">
        <div class="toggle ${stagger?'on':''}" data-action="cb-toggle-stagger"></div>
      </div>
    </div>

    ${stagger ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div class="field" style="margin-bottom:0">
          <div class="field-label" style="gap:5px">
            Min Delay (sec)
            <button class="help-q" data-action="show-help"
              data-title="Minimum Stagger Delay"
              data-body="Shortest wait SplitNow can use between wallet fundings. Must be at least 1 second.">?</button>
          </div>
          <input type="number" id="cb-stagger-min" value="${stgMin}" min="1" step="1" placeholder="30" data-bind-bundle-create="staggerMinSec"/>
        </div>
        <div class="field" style="margin-bottom:0">
          <div class="field-label" style="gap:5px">
            Max Delay (sec)
            <button class="help-q" data-action="show-help"
              data-title="Maximum Stagger Delay"
              data-body="Longest wait SplitNow can use. A random value between min and max is picked each time, making the timing pattern unpredictable.">?</button>
          </div>
          <input type="number" id="cb-stagger-max" value="${stgMax}" min="1" step="1" placeholder="60" data-bind-bundle-create="staggerMaxSec"/>
        </div>
      </div>
    ` : '<div style="margin-bottom:12px"></div>'}

    <div class="sf-toggle-row" style="margin-bottom:${c.addToGroup?'10px':'14px'}">
      <div class="sf-toggle-left">
        <div class="field-label" style="margin-bottom:0">
          Save to Wallet Group
          <button class="help-q" data-action="show-help"
            data-title="Save to Wallet Group"
            data-body="After the bundle completes, all generated wallets are saved into a named group in your Wallets tab. This lets you reuse them across tools \u2014 volume bot, token splitter, or a future connection check.">?</button>
        </div>
        <div class="sf-toggle-hint">${c.addToGroup ? 'Wallets saved after creation' : 'Keys shown once \u2014 enable to persist them'}</div>
      </div>
      <div class="sf-toggle-right">
        <div class="toggle ${c.addToGroup?'on':''}" data-action="cb-toggle-group"></div>
      </div>
    </div>

    ${c.addToGroup ? `
      <div class="field">
        <div class="field-label">
          Group Name
          <button class="help-q" data-action="show-help"
            data-title="Wallet Group Name"
            data-body="The label used for the saved group. Each wallet inside will be named [Group] W1, W2\u2026 etc. so they stay organised.">?</button>
        </div>
        <input type="text" id="cb-group-name" value="${c.groupName||''}"
          placeholder="e.g. Bundle Jan 2025\u2026" maxlength="30" data-bind-bundle-create="groupName"/>
      </div>
    ` : ''}

    ${c.error ? '<div class="error-card">'+c.error+'</div>' : ''}
    ${running  ? buildBundleProgress({ step: c.runStep||'Working\u2026', pct: c.runPct||0 }) : ''}

    <div id="bundle-track-link" style="display:${c.orderId?'flex':'none'};align-items:center;gap:8px;background:rgba(13,31,74,.05);border:1px solid var(--border-md);border-radius:var(--r);padding:9px 12px;margin-bottom:10px">
      <span style="font-size:13px">🔗</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:9.5px;font-weight:700;color:var(--navy);margin-bottom:1px">SplitNow Order</div>
        <span class="bundle-order-id" style="font-family:var(--mono);font-size:8.5px;color:var(--text-muted)">${c.orderId||''}</span>
      </div>
      <a href="${c.orderId?'https://splitnow.io/order/'+c.orderId:'#'}" target="_blank" rel="noopener"
        style="font-size:9px;font-weight:600;color:var(--navy);text-decoration:none;white-space:nowrap;flex-shrink:0">
        Track &#8250;
      </a>
    </div>

    <button class="btn btn-primary btn-full" data-action="cb-run" ${running?'disabled':''}>
      ${running ? '<span class="spinner-dark"></span>&nbsp; Creating\u2026' : '&#9889; Create Bundle'}
    </button>
    <p style="font-size:9px;color:var(--text-muted);text-align:center;margin-top:7px;line-height:1.5">
      SOL is routed through SplitNow\u2019s exchange network. No direct on-chain link between source and destination wallets.
    </p>`;
}

/* ════════════════════════════════════════════
   LOG TAB
═══════════════════════════════════════════ */
function buildBundleLogTab() {
  const logs = (S.bundle||{}).runLog || [];
  const abLogSection = (typeof buildAutoBundleLogSection === 'function') ? buildAutoBundleLogSection() : '';
  if (!logs.length) {
    if (abLogSection) return abLogSection;
  return `<div class="empty-state">
      <div class="empty-icon">&#128203;</div>
      <div class="empty-text">No activity yet.<br>Run a check or create a bundle to see logs here.</div>
    </div>`;
  }
  const rows = logs.map(e => {
    const safe = String(e.msg).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return '<div class="bundle-log-entry log-'+(e.type||'info')+'">'
      +'<span class="bundle-log-ts">'+e.ts+'</span>'
      +'<span class="bundle-log-msg">'+safe+'</span></div>';
  }).join('');
  return `
    <div class="bundle-log-wrap">
      <div class="bundle-log-toolbar">
        <span class="bundle-log-label" id="bundle-log-count">${logs.length} entries</span>
        <button class="btn btn-ghost btn-sm" data-action="bundle-clear-log" style="font-size:9px;padding:2px 8px">Clear</button>
      </div>
      <div class="bundle-log-feed" id="bundle-log-feed">${rows}</div>
    </div>
    ${abLogSection}`;
}function buildBundleHistoryTab() {
  const history = (S.bundle||{}).createHistory || [];
  if (!history.length) {
    const abHistRows = (typeof buildAutoBundleHistoryRows === 'function') ? buildAutoBundleHistoryRows() : '';
  return `<div class="empty-state">
      <div class="empty-icon">&#128230;</div>
      <div class="empty-text">No bundles created yet.<br>Switch to the Create tab to get started.</div>
    </div>`;
  }
  return history.slice().reverse().map(entry => {
    const expanded = ((S.bundle.historyExpanded)||{})[entry.id];
    const date = new Date(entry.ts).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'2-digit'})
      + ' ' + new Date(entry.ts).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

    const walletCards = (entry.wallets||[]).map((w,i) => {
      const visKey = entry.id+'-'+i;
      const shown  = ((S.bundle.historyKeyVis)||{})[visKey];
      return '<div class="bundle-wallet-card">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'
        +'<span style="font-size:10px;font-weight:600;color:var(--navy)">Wallet '+(i+1)+(w.sol?'<span style="font-weight:400;color:var(--text-muted)"> \u00b7 '+w.sol+' SOL</span>':'')+'</span>'
        +'<span style="font-size:9px;color:var(--green-dim);background:var(--green-bg);padding:1px 6px;border-radius:20px">Funded</span>'
        +'</div>'
        +'<div style="margin-bottom:5px"><div class="bundle-wallet-field-lbl">Address</div>'
        +'<div class="bundle-wallet-row"><span class="bundle-wallet-val">'+w.publicKey+'</span>'
        +'<button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="copy" data-copy="'+w.publicKey+'">Copy</button></div></div>'
        +'<div><div class="bundle-wallet-field-lbl">Private Key</div>'
        +'<div class="bundle-wallet-row"><span class="bundle-wallet-val">'
        +(shown ? w.privateKey : '\u2022'.repeat(Math.min(w.privateKey?.length||32,32)))
        +'</span><button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="bh-toggle-key" data-id="'+entry.id+'" data-idx="'+i+'">'+(shown?'Hide':'Show')+'</button>'
        +'<button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="copy" data-copy="'+w.privateKey+'">Copy</button></div></div>'
        +'</div>';
    }).join('');

    return '<div class="bundle-hist-card">'
      +'<div class="bundle-hist-hdr" data-action="bh-toggle" data-id="'+entry.id+'">'
      +'<div><div style="font-size:11px;font-weight:600;color:var(--navy)">'+(entry.groupName||'Bundle')
      +'<span style="font-weight:400;color:var(--text-muted)"> \u00b7 '+(entry.wallets?.length||0)+' wallets \u00b7 '+entry.totalSol+' SOL</span></div>'
      +'<div style="font-size:9.5px;color:var(--text-muted);margin-top:2px">'+date+' \u00b7 '+(entry.distribMode==='random'?'Random dist.':'Equal dist.')+(entry.staggerFunding?' \u00b7 Staggered '+entry.staggerMinSec+'\u2013'+entry.staggerMaxSec+'s':'')+'</div></div>'
      +'<span class="bundle-hist-chevron '+(expanded?'open':'')+'">&#8250;</span>'
      +'</div>'
      +(expanded ? '<div style="border-top:1px solid var(--border-md);padding:10px 12px">'
        +'<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">'
        +'<button class="btn btn-ghost btn-sm" data-action="bh-copy-all-keys" data-id="'+entry.id+'">Copy All Keys</button>'
        +'<button class="btn btn-ghost btn-sm" data-action="bh-copy-all-addrs" data-id="'+entry.id+'">Copy All Addresses</button>'
        +'<button class="btn btn-danger btn-sm" data-action="bh-delete" data-id="'+entry.id+'">Delete</button>'
        +'</div>'+walletCards+'</div>' : '')
      +'</div>';
  }).join('');
}

/* ════════════════════════════════════════════
   CREATE RESULT
═══════════════════════════════════════════ */
function buildCreateBundleResult() {
  const r = S.bundle.createResult;
  if (!r) { S.bundle.view = 'landing'; return buildBundleLanding(); }

  const walletCards = r.wallets.map((w,i) => {
    const shown = ((S.bundle.createKeyVis)||{})[i];
    return '<div class="bundle-wallet-card" style="background:var(--surface);border:1px solid var(--border-md)">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'
      +'<span style="font-size:10.5px;font-weight:700;color:var(--navy)">Wallet '+(i+1)+'</span>'
      +'<span style="font-size:10px;font-family:var(--mono);font-weight:600;color:var(--navy)">'+w.sol+' SOL</span></div>'
      +'<div style="margin-bottom:5px"><div class="bundle-wallet-field-lbl">Address</div>'
      +'<div class="bundle-wallet-row"><span class="bundle-wallet-val" style="white-space:normal;word-break:break-all">'+w.publicKey+'</span>'
      +'<button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="copy" data-copy="'+w.publicKey+'">Copy</button></div></div>'
      +'<div><div class="bundle-wallet-field-lbl">Private Key</div>'
      +'<div class="bundle-wallet-row"><span class="bundle-wallet-val" style="white-space:normal;word-break:break-all">'
      +(shown ? w.privateKey : '\u2022'.repeat(Math.min(w.privateKey?.length||32,32)))
      +'</span><button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="cr-toggle-key" data-idx="'+i+'">'+(shown?'Hide':'Show')+'</button>'
      +'<button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:8.5px;flex-shrink:0" data-action="copy" data-copy="'+w.privateKey+'">Copy</button></div></div>'
      +'</div>';
  }).join('');

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Bundle Created</span>
        <button class="btn btn-ghost btn-sm" data-action="bundle-back">\u2190 Back</button>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">
      <div style="background:var(--green-bg);border:1px solid rgba(34,197,94,0.25);border-radius:var(--r);padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px">
        <span style="font-size:20px">&#127881;</span>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--green-dim)">Bundle funded successfully!</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:2px">
            ${r.wallets.length} wallets \u00b7 ${r.totalSol} SOL \u00b7 ${r.distribMode==='random'?'Random':'Equal'} distribution
          </div>
        </div>
      </div>
      ${r.orderId ? `<a href="https://splitnow.io/order/${r.orderId}" target="_blank" rel="noopener"
        style="display:flex;align-items:center;gap:8px;background:rgba(13,31,74,.05);border:1px solid var(--border-md);border-radius:var(--r);padding:9px 12px;margin-bottom:12px;text-decoration:none">
        <span style="font-size:13px">🔗</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:9.5px;font-weight:700;color:var(--navy);margin-bottom:1px">SplitNow Order</div>
          <span style="font-family:var(--mono);font-size:8.5px;color:var(--text-muted)">${r.orderId}</span>
        </div>
        <span style="font-size:9px;font-weight:600;color:var(--navy);white-space:nowrap;flex-shrink:0">View &#8250;</span>
      </a>` : ''}
      <div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" data-action="cb-copy-all-keys">Copy All Private Keys</button>
        <button class="btn btn-ghost btn-sm" data-action="cb-copy-all-addrs">Copy All Addresses</button>
      </div>
      ${walletCards}
      <button class="btn btn-primary btn-full" data-action="bundle-back" style="margin-top:4px">Done</button>
    </div>`;
}

/* ════════════════════════════════════════════
   PROGRESS CARD
═══════════════════════════════════════════ */
function buildBundleProgress(p) {
  return '<div class="bundle-progress-card">'
    +'<div class="bundle-progress-row">'
    +'<span class="bundle-progress-step" id="bundle-prog-step">'+(p?.step||'Working\u2026')+'</span>'
    +'<span class="bundle-progress-pct" id="bundle-prog-pct">'+(p?.pct||0)+'%</span></div>'
    +'<div class="bundle-progress-bar-wrap">'
    +'<div class="bundle-progress-bar" id="bundle-prog-bar" style="width:'+(p?.pct||0)+'%"></div>'
    +'</div></div>';
}

/* keep old name working */
function buildBundleLoading(p) { return buildBundleProgress(p); }

/* ════════════════════════════════════════════
   TOKEN RESULT
═══════════════════════════════════════════ */
function buildBundleTokenResult() {
  const r = S.bundle.result;
  if (!r) { S.bundle.view='landing'; return buildBundleLanding(); }

  const s = r.stats;
  const buyers = r.buyers||[];
  const groups = {
    BUNDLED:    buyers.filter(b=>b.verdict==='BUNDLED'),
    FULLPORT:   buyers.filter(b=>b.verdict==='FULLPORT'),
    SUSPICIOUS: buyers.filter(b=>b.verdict==='SUSPICIOUS'),
    EARLY:      buyers.filter(b=>b.verdict==='EARLY'),
    CLEAN:      buyers.filter(b=>b.verdict==='CLEAN'),
  };
  const riskScore = Math.min(100, s.bundled*10 + s.fullport*25 + s.suspicious*5);
  const riskColor = riskScore>=60 ? 'var(--danger)' : riskScore>=30 ? 'var(--warn)' : 'var(--green-dim)';
  const riskLabel = riskScore>=60 ? 'HIGH RISK' : riskScore>=30 ? 'MEDIUM RISK' : 'LOW RISK';

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Token Analysis</span>
        <button class="btn btn-ghost btn-sm" data-action="bundle-back">\u2190 Back</button>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">
      <div style="background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r);padding:12px 14px;margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <span style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim)">Risk Assessment</span>
          <span style="font-size:11px;font-weight:700;color:${riskColor}">${riskLabel}</span>
        </div>
        <div class="vb-stats-row" style="padding:0">
          <div class="vb-stat"><div class="vb-stat-val">${s.total}</div><div class="vb-stat-lbl">Buyers</div></div>
          <div class="vb-stat"><div class="vb-stat-val" style="color:var(--danger)">${s.bundled}</div><div class="vb-stat-lbl">Bundled</div></div>
          <div class="vb-stat"><div class="vb-stat-val" style="color:var(--warn)">${s.fullport}</div><div class="vb-stat-lbl">Full-port</div></div>
          <div class="vb-stat"><div class="vb-stat-val" style="color:var(--green-dim)">${s.clean}</div><div class="vb-stat-lbl">Clean</div></div>
        </div>
        ${s.bundledPct!==null ? '<div style="font-size:10px;color:var(--text-muted);margin-top:8px;padding-top:8px;border-top:1px solid var(--border-md)">Bundled wallets hold <strong style="color:var(--danger)">'+s.bundledPct+'%</strong> of visible supply</div>' : ''}
      </div>
      ${groups.BUNDLED.length    ? '<div class="bc-section-hdr" style="color:var(--danger)">\uD83D\uDD34 Confirmed Bundles \u2014 '+s.bundleGroups+' group'+(s.bundleGroups!==1?'s':'')+'</div>'+groups.BUNDLED.map(w=>buildBundleWalletRow(w,r.totalSupply)).join('') : ''}
      ${groups.FULLPORT.length   ? '<div class="bc-section-hdr" style="color:var(--danger);margin-top:12px">\uD83D\uDFE0 Full-Port Buys</div>'+groups.FULLPORT.map(w=>buildBundleWalletRow(w,r.totalSupply)).join('') : ''}
      ${groups.SUSPICIOUS.length ? '<div class="bc-section-hdr" style="color:var(--warn);margin-top:12px">\uD83D\uDFE1 Suspicious</div>'+groups.SUSPICIOUS.map(w=>buildBundleWalletRow(w,r.totalSupply)).join('') : ''}
      ${groups.EARLY.length      ? '<div class="bc-section-hdr" style="color:var(--text-muted);margin-top:12px">\u26AA Early Buyers</div>'+groups.EARLY.map(w=>buildBundleWalletRow(w,r.totalSupply)).join('') : ''}
      ${groups.CLEAN.length      ? '<div class="bc-section-hdr" style="color:var(--green-dim);margin-top:12px">\uD83D\uDFE2 Clean</div>'+groups.CLEAN.map(w=>buildBundleWalletRow(w,r.totalSupply)).join('') : ''}
    </div>`;
}

/* ════════════════════════════════════════════
   WALLET RESULT
═══════════════════════════════════════════ */
function buildBundleWalletResult() {
  const r = S.bundle.walletResult;
  if (!r) { S.bundle.view='landing'; return buildBundleLanding(); }
  const linked = r.linkedGroups||[];

  const linkedHtml = linked.length===0
    ? '<div style="background:var(--green-bg);border:1px solid rgba(34,197,94,0.25);border-radius:var(--r);padding:14px;text-align:center">'
      +'<div style="font-size:14px;margin-bottom:5px">\u2705</div>'
      +'<div style="font-size:11px;font-weight:700;color:var(--green-dim)">No connections found</div>'
      +'<div style="font-size:10px;color:var(--text-muted);margin-top:4px">These wallets don\u2019t appear to share a funding source.</div>'
      +'</div>'
    : '<div class="error-card" style="margin-bottom:12px">\u26a0 '+linked.length+' linked group'+(linked.length>1?'s':'')+' found \u2014 these wallets likely share an owner.</div>'
      + linked.map(([funder,wallets]) => {
          const wRows = wallets.map(addr => {
            const saved = (S.savedWallets||[]).find(w=>w.publicKey===addr);
            return '<div style="font-size:9.5px;color:var(--text-dim);padding:5px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">'
              +(saved ? '<span>'+(saved.emoji||'💼')+' '+saved.name+'</span>' : '')
              +'<span style="font-family:var(--mono)">'+bShort(addr)+'</span>'
              +'<button class="btn btn-ghost btn-sm" style="padding:1px 5px;font-size:8px;margin-left:auto" data-action="copy" data-copy="'+addr+'">Copy</button>'
              +'</div>';
          }).join('');
          return '<div style="background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r);padding:10px 12px;margin-bottom:8px">'
            +'<div style="font-size:9.5px;font-weight:700;color:var(--danger);margin-bottom:6px">Shared funder: <span style="font-family:var(--mono)">'+bShort(funder)+'</span>'
            +'<button class="btn btn-ghost btn-sm" style="padding:1px 5px;font-size:8px;margin-left:6px" data-action="copy" data-copy="'+funder+'">Copy</button></div>'
            +wRows+'</div>';
        }).join('');

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Wallet Connections</span>
        <button class="btn btn-ghost btn-sm" data-action="bundle-back">\u2190 Back</button>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">${linkedHtml}</div>`;
}

function buildBundleWalletRow(w, totalSupply) {
  const pct = totalSupply && w.amount ? ((w.amount/totalSupply)*100).toFixed(2) : null;
  const vc = { BUNDLED:'bc-verdict-bundled', FULLPORT:'bc-verdict-fullport', SUSPICIOUS:'bc-verdict-suspicious', CLEAN:'bc-verdict-clean', EARLY:'bc-verdict-early' }[w.verdict]||'bc-verdict-early';
  return '<div style="background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r-sm);padding:8px 10px;margin-bottom:5px">'
    +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">'
    +'<span style="font-family:var(--mono);font-size:9.5px;color:var(--text-dim);cursor:pointer" data-action="copy" data-copy="'+w.wallet+'">'+bShort(w.wallet)+'</span>'
    +'<div style="display:flex;align-items:center;gap:5px">'
    +(w.bundleGroup ? '<span style="font-size:8px;background:rgba(220,38,38,0.1);color:var(--danger);padding:1px 5px;border-radius:20px">'+w.bundleGroup+'</span>' : '')
    +'<span class="bc-verdict '+vc+'">'+w.verdict+'</span></div></div>'
    +'<div style="display:flex;gap:10px;font-size:9px;color:var(--text-muted);flex-wrap:wrap">'
    +(w.amount ? '<span>'+w.amount.toLocaleString(undefined,{maximumFractionDigits:0})+' tokens'+(pct?' ('+pct+'%)':'')+'</span>' : '')
    +(w.solSpent ? '<span>'+w.solSpent.toFixed(4)+' SOL</span>' : '')
    +(w.fundingSource ? '<span>Funder: <span style="font-family:var(--mono)">'+bShort(w.fundingSource)+'</span></span>' : '')
    +'</div></div>';
}

/* ════════════════════════════════════════════
   CREATE BUNDLE LOGIC
═══════════════════════════════════════════ */
function bundleDistributeSOL(totalSol, walletCount, distribMode, minPerWallet, maxPerWallet) {
  const total = parseFloat(totalSol);
  const min = parseFloat(minPerWallet) > 0 ? parseFloat(minPerWallet) : 0;
  const max = parseFloat(maxPerWallet) > 0 ? parseFloat(maxPerWallet) : Infinity;
  if (!Number.isFinite(total)||total<=0) throw new Error('Invalid total SOL');
  if (!Number.isFinite(walletCount)||walletCount<1) throw new Error('Invalid wallet count');
  if (min>max) throw new Error('Min SOL per wallet cannot be greater than max SOL per wallet');
  if ((min*walletCount)>total) throw new Error('Total SOL is too low. You need at least '+(min*walletCount).toFixed(6)+' SOL for '+walletCount+' wallets with a minimum of '+min+' SOL each.');
  if (Number.isFinite(max)&&(max*walletCount)<total) throw new Error('Total SOL is too high. Maximum distributable is '+(max*walletCount).toFixed(6)+' SOL.');

  const amounts = Array(walletCount).fill(min);
  let remaining = total - (min*walletCount);
  if (remaining<=0) return amounts.map(v=>parseFloat(v.toFixed(6)));

  if (distribMode==='equal') {
    const extra = remaining/walletCount;
    for (let i=0;i<walletCount;i++) {
      amounts[i]+=extra;
      if (amounts[i]>max) throw new Error('Equal distribution exceeds the max SOL per wallet cap');
    }
    return amounts.map(v=>parseFloat(v.toFixed(6)));
  }

  let safety=0;
  while (remaining>0.000001 && safety<1000) {
    safety++;
    const open = amounts.map((v,i)=>({i,room:max-v})).filter(x=>x.room>0.000001);
    if (!open.length) break;
    const wts = open.map(()=>Math.random());
    const ws  = wts.reduce((a,b)=>a+b,0);
    let dist=0;
    for (let n=0;n<open.length;n++) {
      const {i,room}=open[n];
      const add=Math.min(room,(wts[n]/ws)*remaining);
      amounts[i]+=add; dist+=add;
    }
    remaining-=dist;
    if (dist<=0.000001) break;
  }
  if (remaining>0.000001) {
    for (let i=0;i<amounts.length&&remaining>0.000001;i++) {
      const room=max-amounts[i]; if(room<=0) continue;
      const add=Math.min(room,remaining); amounts[i]+=add; remaining-=add;
    }
  }
  if (remaining>0.00001) throw new Error('Could not distribute SOL within the min/max wallet constraints');

  const rounded = amounts.map(v=>parseFloat(v.toFixed(6)));
  let diff = parseFloat((total - rounded.reduce((a,b)=>a+b,0)).toFixed(6));
  for (let i=0; Math.abs(diff)>=0.000001 && i<rounded.length*10; i++) {
    const idx=i%rounded.length;
    if (diff>0 && rounded[idx]+0.000001<=max) { rounded[idx]=parseFloat((rounded[idx]+0.000001).toFixed(6)); diff=parseFloat((diff-0.000001).toFixed(6)); }
    else if (diff<0 && rounded[idx]-0.000001>=min) { rounded[idx]=parseFloat((rounded[idx]-0.000001).toFixed(6)); diff=parseFloat((diff+0.000001).toFixed(6)); }
  }
  return rounded;
}

function bundleGenerateKeypair() {
  if (!window.solanaWeb3?.Keypair) throw new Error('Solana web3 SDK not loaded');
  const kp = window.solanaWeb3.Keypair.generate();
  if (!kp?.publicKey?.toBase58||!kp?.secretKey) throw new Error('Generated keypair is missing expected fields');
  return { publicKey: kp.publicKey.toBase58(), privateKey: bs58encode(kp.secretKey) };
}

function bundleBuildGeneratedWallets(n) {
  const wallets=[];
  for (let i=0;i<n;i++) {
    const kp=bundleGenerateKeypair();
    if (!kp.publicKey||!kp.privateKey) throw new Error('Generated wallet '+(i+1)+' is invalid');
    wallets.push(kp);
  }
  return wallets;
}

async function runCreateBundle() {
  const c = S.bundle.create||{};
  const sourceWallet = (S.savedWallets||[]).find(w=>w.id===c.sourceWalletId);
  const sourcePriv = (c.sourceWalletPrivKey||sourceWallet?.privateKey||'').trim();
  const walletCount = Math.max(1,Math.min(50,parseInt(c.walletCount,10)||5));
  const totalSol = parseFloat(c.totalSol);
  const minPer = parseFloat(c.minSolPerWallet)||0;
  const maxPer = parseFloat(c.maxSolPerWallet)||0;
  const distrib = c.distribMode||'equal';
  const stagger = !!c.staggerFunding;
  const stgMin = Math.max(1,parseInt(c.staggerMinSec,10)||30);
  const stgMax = Math.max(stgMin,parseInt(c.staggerMaxSec,10)||60);

  if (!sourcePriv) throw new Error('Select a source wallet with a private key');
  if (!totalSol||totalSol<=0) throw new Error('Enter a valid SOL amount');
  if (stagger&&stgMin>stgMax) throw new Error('Stagger min delay cannot be greater than stagger max delay');

  // Clear previous order tracking on new run
  if (S.bundle.create) S.bundle.create.orderId = null;
  const prevTrackEl = document.getElementById('bundle-track-link');
  if (prevTrackEl) prevTrackEl.style.display = 'none';

  const setStep = (step, pct) => {
    if (!S.bundle.create) S.bundle.create={};
    S.bundle.create.runStep=step; S.bundle.create.runPct=pct;
    const stepEl=document.getElementById('bundle-prog-step');
    const barEl =document.getElementById('bundle-prog-bar');
    const pctEl =document.getElementById('bundle-prog-pct');
    if (stepEl) stepEl.textContent=step;
    if (barEl)  barEl.style.width=pct+'%';
    if (pctEl)  pctEl.textContent=pct+'%';
    bundleLog(step,'info');
  };

  setStep('Generating fresh wallets\u2026',10);
  await bundleSleep(150);
  const generatedWallets = bundleBuildGeneratedWallets(walletCount);

  setStep('Calculating distribution\u2026',18);
  const amounts = bundleDistributeSOL(totalSol,walletCount,distrib,minPer,maxPer);
  const splits = generatedWallets.map((w,i) => {
    if (!w?.publicKey) throw new Error('Generated wallet '+(i+1)+' is missing a publicKey');
    return { address:w.publicKey, amount:amounts[i] };
  });

  setStep('Creating SplitNow quote/order\u2026',25);
  const createRes = await splitNowReq('POST','/create-bundle',{
    source_private_key: sourcePriv,
    splits,
    exchanger_id: 'binance',
    stagger_funding: stagger,
    stagger_min_sec: stgMin,
    stagger_max_sec: stgMax,
  });

  const data = createRes?.data||{};
  const orderId = data.orderId||data.shortId;
  if (!orderId) throw new Error('SplitNow did not return an order ID');

  // Persist orderId into state so tracking card survives re-renders
  if (!S.bundle.create) S.bundle.create = {};
  S.bundle.create.orderId = orderId;

  setStep('Deposit sent \u2014 waiting for SplitNow\u2026',45);
  bundleLog('Order '+orderId+' \u2014 polling for completion\u2026','info');

  // Show live tracking card with link to SplitNow order page
  const trackUrl = 'https://splitnow.io/order/' + orderId;
  const trackEl = document.getElementById('bundle-track-link');
  if (trackEl) {
    trackEl.style.display = 'flex';
    const anchor = trackEl.querySelector('a');
    if (anchor) anchor.href = trackUrl;
    const idEl = trackEl.querySelector('.bundle-order-id');
    if (idEl) idEl.textContent = orderId;
  }
  bundleLog('Track live: '+trackUrl,'info');

  let latestOrder=data.fetchedOrder||null, completed=false;
  const POLL=5000;
  const staggerMs = stagger ? Math.max(0,walletCount-1)*(stgMax*1000) : 0;
  const totalWait = Math.max(20*60*1000, staggerMs+5*60*1000);
  const MAX_POLLS = Math.ceil(totalWait/POLL);

  for (let attempt=0;attempt<MAX_POLLS;attempt++) {
    await bundleSleep(POLL);
    const orderRes = await splitNowReq('GET','/order/'+orderId);
    latestOrder=orderRes;
    const od = orderRes?.data||orderRes;
    const raw=String(od?.status||'').toLowerCase();
    const short=String(od?.statusShort||'').toLowerCase();
    const txt=String(od?.statusText||'').toLowerCase();
    const pct=Math.min(95,45+Math.floor(((attempt+1)/MAX_POLLS)*45));
    setStep('Processing\u2026 '+(od?.statusText||od?.statusShort||od?.status||'pending'),pct);
    if (raw==='completed'||short==='completed'||txt==='completed') { completed=true; bundleLog('Order completed \u2713','ok'); break; }
    if (raw==='failed'||raw==='cancelled'||short==='failed'||short==='cancelled') throw new Error('SplitNow order failed: '+(od?.statusText||od?.status||'unknown'));
  }

  if (!completed) {
    const last=latestOrder?.data||latestOrder||{};
    throw new Error('SplitNow order timed out. Last status: '+(last.statusText||last.statusShort||last.status||'unknown'));
  }

  setStep('Finalising\u2026',98);
  await bundleSleep(250);

  const wallets = generatedWallets.map((w,i)=>({ publicKey:w.publicKey, privateKey:w.privateKey, sol:amounts[i] }));
  const result = {
    id:uid(), ts:Date.now(), wallets,
    totalSol:parseFloat(totalSol.toFixed(6)),
    distribMode:distrib,
    groupName:(c.groupName?.trim()||'Bundle '+new Date().toLocaleDateString('en-GB')),
    addToGroup:!!c.addToGroup,
    orderId:data.orderId||null, shortId:data.shortId||null,
    depositTxSig:data.depositTxSig||null,
    staggerFunding:stagger, staggerMinSec:stagger?stgMin:null, staggerMaxSec:stagger?stgMax:null,
    orderData:latestOrder,
  };

  if (!S.bundle.createHistory) S.bundle.createHistory=[];
  S.bundle.createHistory.push(result);
  if (S.bundle.createHistory.length>20) S.bundle.createHistory=S.bundle.createHistory.slice(-20);

  if (c.addToGroup) {
    const groupId=uid();
    S.walletGroups=S.walletGroups||[];
    S.walletGroups.push({id:groupId,name:result.groupName,emoji:'📦',collapsed:false});
    wallets.forEach((w,i)=>S.savedWallets.push({id:uid(),name:result.groupName+' W'+(i+1),emoji:'💼',publicKey:w.publicKey,privateKey:w.privateKey,groupId}));
    if (typeof syncWalletsToServer==='function') await syncWalletsToServer();
    showToast('\u2713 '+wallets.length+' wallets saved to "'+result.groupName+'"');
  }

  bundleLog('Bundle created \u2014 '+wallets.length+' wallets, '+result.totalSol+' SOL','ok');
  return result;
}

/* ════════════════════════════════════════════
   BUNDLE CHECK LOGIC
═══════════════════════════════════════════ */
function isPumpFunBuy(tx) {
  if (!tx?.transaction?.message) return false;
  const accts = (tx.transaction.message.accountKeys||[]).map(a=>typeof a==='string'?a:a.pubkey);
  return accts.includes(PUMPFUN_PROGRAM);
}

function extractBuyer(tx, mintAddress) {
  if (!tx?.meta) return null;
  const post=tx.meta.postTokenBalances||[], pre=tx.meta.preTokenBalances||[];
  const sig=tx.transaction?.signatures?.[0]||'';
  for (const p of post) {
    if (p.mint!==mintAddress||!p.owner) continue;
    const pr=pre.find(x=>x.accountIndex===p.accountIndex);
    const preAmt=Number(pr?.uiTokenAmount?.uiAmount||0);
    const postAmt=Number(p.uiTokenAmount?.uiAmount||0);
    if (postAmt>preAmt) return {wallet:p.owner,amount:postAmt-preAmt,slot:tx.slot,timestamp:tx.blockTime,signature:sig,isPump:isPumpFunBuy(tx),verdict:'UNKNOWN',fundingSource:null,bundleGroup:null};
  }
  const accts=(tx.transaction?.message?.accountKeys||[]).map(a=>typeof a==='string'?a:a.pubkey);
  if (!accts.includes(PUMPFUN_PROGRAM)) return null;
  const sp=tx.meta.preBalances||[], sq=tx.meta.postBalances||[];
  let maxSpent=0,bi=-1;
  for (let i=0;i<accts.length;i++) { const s=(sp[i]||0)-(sq[i]||0); if(s>maxSpent){maxSpent=s;bi=i;} }
  if (bi===-1) return null;
  return {wallet:accts[bi],amount:0,slot:tx.slot,timestamp:tx.blockTime,signature:sig,isPump:true,verdict:'UNKNOWN',fundingSource:null,bundleGroup:null,solSpent:maxSpent/1e9};
}

async function getTokenSupply(mint) {
  const r=await bundleRpc('getTokenSupply',[mint]);
  return r?.value?.uiAmount||null;
}

async function analyzeBundles(mintAddress, onProgress) {
  const prog=(step,pct)=>{ onProgress?.({step,pct}); bundleLog(step,'info'); };
  prog('Fetching token transactions\u2026',5);
  const sigs=await bundleRpc('getSignaturesForAddress',[mintAddress,{limit:100}]);
  if (!sigs?.length) throw new Error('No transactions found for this token');
  prog('Fetching transaction details\u2026',15);
  const totalSupply=await getTokenSupply(mintAddress);
  const buyers=[];
  for (let i=0;i<Math.min(sigs.length,80);i+=10) {
    const batch=sigs.slice(i,i+10);
    const txs=await Promise.all(batch.map(s=>bundleRpc('getTransaction',[s.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}])));
    for (const tx of txs) { if(!tx) continue; const b=extractBuyer(tx,mintAddress); if(b) buyers.push(b); }
    prog('Analysing transactions\u2026 ('+Math.min(i+10,sigs.length)+'/'+Math.min(sigs.length,80)+')',15+Math.floor((i/80)*45));
    await bundleSleep(150);
  }
  if (!buyers.length) throw new Error('No buy transactions found');
  prog('Tracing funding sources\u2026',62);
  const uniq=[...new Set(buyers.map(b=>b.wallet))];
  const fundingMap={};
  for (let i=0;i<uniq.length;i++) {
    fundingMap[uniq[i]]=await traceFundingSource(uniq[i]);
    prog('Tracing wallets\u2026 ('+(i+1)+'/'+uniq.length+')',62+Math.floor((i/uniq.length)*25));
    await bundleSleep(100);
  }
  prog('Detecting bundles\u2026',88);
  const result=detectBundleGroups(buyers,fundingMap,totalSupply);
  prog('Done',100);
  return result;
}

function detectBundleGroups(buyers, fundingMap, totalSupply) {
  const bySlot={}, byFunder={};
  for (const b of buyers) {
    const k=String(b.slot);
    if(!bySlot[k]) bySlot[k]=[];
    bySlot[k].push(b);
    const fs=fundingMap[b.wallet]?.fundingSource;
    if(fs){if(!byFunder[fs])byFunder[fs]=[]; byFunder[fs].push(b);}
  }
  let gi=1;
  for (const g of Object.values(bySlot)) {
    if(g.length>=2){g.forEach(b=>{b.verdict='BUNDLED';b.bundleGroup='Block '+gi;});gi++;}
  }
  for (const [f,g] of Object.entries(byFunder)) {
    if(g.length>=2){g.forEach(b=>{if(b.verdict==='UNKNOWN'){b.verdict='BUNDLED';b.bundleGroup='Funder '+bShort(f);}b.fundingSource=f;});}
  }
  if (totalSupply) {
    for (const b of buyers) {
      if(b.verdict!=='UNKNOWN') continue;
      if(b.amount/totalSupply>=0.5) b.verdict='FULLPORT';
      else if(b.amount/totalSupply>=0.1) b.verdict='SUSPICIOUS';
      else b.verdict='CLEAN';
    }
  } else {
    buyers.filter(b=>b.verdict==='UNKNOWN').forEach(b=>{b.verdict='EARLY';});
  }
  const bundled    =buyers.filter(b=>b.verdict==='BUNDLED').length;
  const fullport   =buyers.filter(b=>b.verdict==='FULLPORT').length;
  const suspicious =buyers.filter(b=>b.verdict==='SUSPICIOUS').length;
  const clean      =buyers.filter(b=>b.verdict==='CLEAN').length;
  const bundleGroups=new Set(buyers.filter(b=>b.bundleGroup).map(b=>b.bundleGroup)).size;
  const bundledAmt =buyers.filter(b=>b.verdict==='BUNDLED').reduce((s,b)=>s+b.amount,0);
  const bundledPct =totalSupply ? Math.round((bundledAmt/totalSupply)*100) : null;
  return {buyers,totalSupply,stats:{total:buyers.length,bundled,fullport,suspicious,clean,bundleGroups,bundledPct},fundingMap};
}

async function traceFundingSource(addr) {
  try {
    const sigs=await bundleRpc('getSignaturesForAddress',[addr,{limit:10}]);
    if(!sigs?.length) return {fundingSource:null,fundingAmount:0,fundingSlot:null};
    for (const sig of [...sigs].reverse().slice(0,5)) {
      const tx=await bundleRpc('getTransaction',[sig.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}]);
      if(!tx?.meta) continue;
      const accts=(tx.transaction?.message?.accountKeys||[]).map(a=>typeof a==='string'?a:a.pubkey);
      const pre=tx.meta.preBalances||[], post=tx.meta.postBalances||[];
      const wi=accts.indexOf(addr); if(wi===-1) continue;
      if((post[wi]||0)-(pre[wi]||0)<=0) continue;
      let sender=null,maxL=0;
      for (let i=0;i<accts.length;i++) { if(accts[i]===addr) continue; const l=(pre[i]||0)-(post[i]||0); if(l>maxL){maxL=l;sender=accts[i];} }
      if(sender&&maxL>5000) return {fundingSource:sender,fundingAmount:maxL,fundingSlot:tx.slot};
    }
    return {fundingSource:null,fundingAmount:0,fundingSlot:null};
  } catch { return {fundingSource:null,fundingAmount:0,fundingSlot:null}; }
}

async function analyzeWalletConnections(addresses, onProgress) {
  const prog=(step,pct)=>{ onProgress?.({step,pct}); bundleLog(step,'info'); };
  prog('Tracing wallet histories\u2026',5);
  const results={};
  for (let i=0;i<addresses.length;i++) {
    results[addresses[i]]=await traceFundingSource(addresses[i]);
    prog('Tracing '+(i+1)+'/'+addresses.length+'\u2026',5+Math.floor((i/addresses.length)*80));
    await bundleSleep(120);
  }
  prog('Comparing sources\u2026',88);
  const groups={};
  for (const [addr,info] of Object.entries(results)) {
    const src=info.fundingSource||'unknown';
    if(!groups[src]) groups[src]=[];
    groups[src].push(addr);
  }
  const linkedGroups=Object.entries(groups).filter(([src,ws])=>src!=='unknown'&&ws.length>=2);
  prog('Done',100);
  return {addresses,fundingMap:results,linkedGroups};
}

/* expose to global scope */
if (typeof window !== 'undefined') {
  window.buildBundlePage = buildBundlePage;
}