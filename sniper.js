/* ═══════════════════════════════════════════
   sniper.js Sniper Bot Tool
   Essor Studios / Solana Dev Tools
═══════════════════════════════════════════ */

'use strict';

const JUPITER_QUOTE  = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP   = 'https://quote-api.jup.ag/v6/swap';
const SOL_MINT       = 'So11111111111111111111111111111111111111112';
const PUMPFUN_PROG   = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymMDer';

// ─────────────────────────────────────────
// TRANSACTION SIGNING
// ─────────────────────────────────────────

// Import Ed25519 key from raw 32-byte seed
async function importEd25519Key(seedBytes) {
  return crypto.subtle.importKey('raw', seedBytes, { name: 'Ed25519' }, false, ['sign']);
}

// Sign a Jupiter transaction (returned as base64)
// Handles both legacy and versioned (v0) transactions
async function signJupiterTx(base64Tx, privateKeyB58) {
  const privBytes = bs58decode(privateKeyB58);
  // privBytes: 64 bytes = seed(32) + pubkey(32), or 32 bytes (seed only)
  const seed = privBytes.slice(0, 32);
  const signingKey = await importEd25519Key(seed);

  // Decode the transaction
  const txBytes = Uint8Array.from(atob(base64Tx), c => c.charCodeAt(0));

  // Determine if legacy or versioned
  // Versioned transaction starts with 0x80 | version (so >= 128)
  // Legacy starts with numRequiredSignatures (usually 1)
  const firstByte = txBytes[0];
  const isVersioned = firstByte >= 128;

  let messageBytes, messageOffset;

  if (isVersioned) {
    // Versioned: [prefix(1)] [numSigs(compact)] [signatures...] [message]
    // For v0, prefix = 0x80, numSigs typically 1
    const numSigs = txBytes[1]; // compact-u16 (usually just 1 byte for small counts)
    messageOffset = 2 + (64 * numSigs);
    messageBytes = txBytes.slice(messageOffset);
  } else {
    // Legacy: [numSigs(1)] [numRequiredSigners(1)] [numReadonlySignedAccounts(1)] ...
    // Actually: [numSigs] [signature_1(64)] ... [message]
    const numSigs = firstByte;
    messageOffset = 1 + (64 * numSigs);
    messageBytes = txBytes.slice(messageOffset);
  }

  // Sign message bytes
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signingKey, messageBytes));

  // Insert signature at position 1 (after the count byte)
  const signed = new Uint8Array(txBytes.length);
  signed.set(txBytes);
  if (isVersioned) {
    signed.set(signature, 2); // After version+numSigs bytes
  } else {
    signed.set(signature, 1); // After numSigs byte
  }

  return btoa(String.fromCharCode(...signed));
}

// Submit signed transaction to RPC
async function sendRawTx(signedBase64) {
  const endpoint = (typeof S !== 'undefined' && S.settings?.rpcEndpoint) || 'https://api.mainnet-beta.solana.com';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sendTransaction',
        params: [signedBase64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'processed' }]
      })
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'RPC error');
    return j.result; // transaction signature
  } catch (e) {
    throw new Error('Send failed: ' + e.message);
  }
}

// ─────────────────────────────────────────
// JUPITER SWAP
// ─────────────────────────────────────────
async function executeSnipe(tokenCA, amountSOL, slippageBps, walletPubkey, walletPrivkey) {
  const lamports = Math.floor(amountSOL * 1e9);

  // 1. Get quote
  sniperLog('Fetching Jupiter quote…', 'info');
  const quoteUrl = `${JUPITER_QUOTE}?inputMint=${SOL_MINT}&outputMint=${tokenCA}&amount=${lamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false&asLegacyTransaction=true`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error('Quote fetch failed: ' + quoteRes.status);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error('Quote error: ' + quote.error);

  sniperLog(`Quote: ${(parseInt(quote.outAmount) / 1e6).toLocaleString()} tokens out`, 'info');

  // 2. Build swap transaction
  sniperLog('Building swap transaction…', 'info');
  const swapRes = await fetch(JUPITER_SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: walletPubkey,
      wrapAndUnwrapSol: true,
      asLegacyTransaction: true,
      prioritizationFeeLamports: Math.floor((S.sniper.priorityFeeSOL || 0.001) * 1e9),
    })
  });
  if (!swapRes.ok) throw new Error('Swap build failed: ' + swapRes.status);
  const swapData = await swapRes.json();
  if (swapData.error) throw new Error('Swap error: ' + swapData.error);

  const rawTx = swapData.swapTransaction;
  if (!rawTx) throw new Error('No transaction in swap response');

  // 3. Sign
  sniperLog('Signing transaction…', 'info');
  const signedTx = await signJupiterTx(rawTx, walletPrivkey);

  // 4. Send
  sniperLog('Sending transaction…', 'info');
  const txSig = await sendRawTx(signedTx);

  sniperLog(`✓ Sent! Sig: ${txSig.slice(0, 12)}…`, 'success');
  return txSig;
}

// ─────────────────────────────────────────
// LOG HELPERS
// ─────────────────────────────────────────
function sniperLog(msg, type = 'info') {
  S.sniper.log.unshift({ ts: Date.now(), msg, type });
  if (S.sniper.log.length > 50) S.sniper.log = S.sniper.log.slice(0, 50);
  // Update log panel live if visible
  const logPanel = document.getElementById('sniper-log');
  if (logPanel) {
    logPanel.innerHTML = buildSniperLogEntries();
  }
}

// ─────────────────────────────────────────
// PAGE BUILDER
// ─────────────────────────────────────────
function buildSniperPage() {
  const sn = S.sniper;
  const sourceWallet = S.savedWallets.find(w => w.id === sn.sourceWalletId);
  const isRunning = sn.enabled;

  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">Sniper Bot</span>
        <div style="display:flex;align-items:center;gap:6px">
          <div class="auto-dot ${isRunning ? 'running' : 'stopped'}" style="width:8px;height:8px;border-radius:50%"></div>
          <span style="font-size:10px;font-weight:600;color:${isRunning ? 'var(--green)' : 'var(--danger)'}">
            ${isRunning ? 'WATCHING' : 'STOPPED'}
          </span>
        </div>
      </div>
      <div class="tabs">
        <button class="tab ${sn.activeTab !== 'history' ? 'active' : ''}" data-action="sniper-tab" data-tab="config">Config</button>
        <button class="tab ${sn.activeTab === 'history' ? 'active' : ''}" data-action="sniper-tab" data-tab="history">History (${sn.history.length})</button>
      </div>
    </div>

    <div class="scroll-area" id="scroll-area">
      ${sn.activeTab === 'history' ? buildSniperHistory() : buildSniperConfig(sn, sourceWallet, isRunning)}
    </div>
  `;
}

function buildSniperConfig(sn, sourceWallet, isRunning) {
  return `
    <!-- Status & Start/Stop -->
    <div class="auto-status" style="margin-bottom:14px">
      <div class="auto-indicator">
        <div class="auto-dot ${isRunning ? 'running' : 'stopped'}"></div>
        <span class="auto-label" style="color:${isRunning ? 'var(--green)' : 'var(--danger)'}">
          ${isRunning ? 'Bot Running' : 'Bot Stopped'}
        </span>
        ${sn.log.length > 0 ? `<span style="font-size:9px;color:var(--text-muted)">${sn.log[0].msg.slice(0, 28)}…</span>` : ''}
      </div>
      <button class="btn btn-sm ${isRunning ? 'btn-danger' : 'btn-primary'}" data-action="sniper-toggle">
        ${isRunning ? '■ Stop' : '▶ Start'}
      </button>
    </div>

    <!-- Mode -->
    <div class="field">
      <div class="field-label">Snipe Mode</div>
      <div class="mode-toggle">
        <button class="mode-btn ${sn.mode === 'ca' ? 'active' : ''}" data-action="sniper-mode" data-mode="ca">
          Specific Token CA
        </button>
        <button class="mode-btn ${sn.mode === 'pumpfun' ? 'active' : ''}" data-action="sniper-mode" data-mode="pumpfun">
          New Pump.fun Launches
        </button>
      </div>
    </div>

    ${sn.mode === 'ca' ? `
      <div class="field">
        <div class="field-label">Target Token CA</div>
        <input type="text" id="sniper-ca" value="${sn.targetCA}" placeholder="Token mint address to snipe…"/>
      </div>
    ` : `
      <div class="field">
        <div class="field-label">Name Keyword Filter <span style="font-weight:400;text-transform:none;font-size:9px;color:var(--text-muted)">(optional)</span></div>
        <input type="text" id="sniper-keyword" value="${sn.keywordFilter}" placeholder="e.g. AI, PEPE, dog…"/>
      </div>
      <div class="field">
        <div class="field-label">Max Market Cap (SOL) <span style="font-weight:400;text-transform:none;font-size:9px;color:var(--text-muted)">(0 = no limit)</span></div>
        <input type="number" id="sniper-maxcap" value="${sn.maxMarketCapSOL}" min="0" style="max-width:120px"/>
      </div>
    `}

    <div class="section-divider"></div>

    <!-- Source wallet -->
    <div class="field">
      <div class="field-label">
        Source Wallet
        <span class="label-action" data-action="sniper-pick-wallet">Pick from saved</span>
      </div>
      ${sourceWallet ? `
        <div class="wallet-card" style="margin-bottom:6px">
          <div>
            <div class="wallet-card-label">${sourceWallet.emoji} ${sourceWallet.name}</div>
            <div style="font-family:var(--mono);font-size:10px;color:var(--text-mid);margin-top:2px">${shortAddr(sourceWallet.publicKey)}</div>
          </div>
          <button class="wallet-remove" data-action="sniper-clear-wallet">×</button>
        </div>
      ` : `
        <input type="text" id="sniper-wallet-addr" placeholder="Wallet address…" style="margin-bottom:4px"/>
        <input type="password" id="sniper-wallet-key" placeholder="Private key (base58, stored locally)…"/>
      `}
      ${!sourceWallet && S.savedWallets.length === 0 ? `
        <div class="info-box warn" style="margin-top:6px;margin-bottom:0">⚠ No saved wallets. Go to Settings to add a wallet with a private key.</div>
      ` : ''}
    </div>

    <!-- Buy settings -->
    <div class="grid-2">
      <div class="field">
        <div class="field-label">Buy Amount (SOL)</div>
        <input type="number" id="sniper-buy-amount" value="${sn.buyAmountSOL}" min="0.001" step="0.01"/>
      </div>
      <div class="field">
        <div class="field-label">Priority Fee (SOL)</div>
        <input type="number" id="sniper-priority" value="${sn.priorityFeeSOL}" min="0" step="0.0001"/>
      </div>
    </div>

    <div class="field">
      <div class="field-label">Slippage — <span style="color:var(--navy);font-weight:700">${(sn.slippageBps / 100).toFixed(1)}%</span></div>
      <div class="slider-row">
        <div class="slider-wrap">
          <input type="range" id="sniper-slippage" min="50" max="5000" step="50" value="${sn.slippageBps}" data-action="sniper-slippage-slide"/>
        </div>
        <span class="slider-value" id="sniper-slip-val">${(sn.slippageBps / 100).toFixed(1)}%</span>
      </div>
    </div>

    <div class="info-box" style="margin-bottom:14px">
      Swaps execute via <strong>Jupiter Aggregator</strong>. The bot polls every 15s for
      ${sn.mode === 'ca' ? 'the first buy opportunity on your target CA' : 'new Pump.fun token launches matching your filters'}.
      Private keys never leave your device.
    </div>

    <!-- Activity log -->
    ${sn.log.length > 0 ? `
      <div class="section-hdr">Activity Log</div>
      <div class="sniper-log-box" id="sniper-log">
        ${buildSniperLogEntries()}
      </div>
    ` : ''}
  `;
}

function buildSniperLogEntries() {
  return S.sniper.log.slice(0, 20).map(entry => {
    const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cls = entry.type === 'success' ? 'log-success' : entry.type === 'error' ? 'log-error' : 'log-info';
    return `<div class="log-entry ${cls}"><span class="log-time">${time}</span><span class="log-msg">${entry.msg}</span></div>`;
  }).join('');
}

function buildSniperHistory() {
  const hist = S.sniper.history;
  if (!hist.length) return `
    <div class="empty-state" style="padding:50px 20px">
      <div class="empty-icon">◎</div>
      <div class="empty-text">No snipe history yet.<br>Start the bot to begin monitoring.</div>
    </div>
  `;

  return hist.map(h => {
    const time = new Date(h.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const statusClass = h.status === 'success' ? 'badge-existing' : h.status === 'pending' ? 'badge-new' : 'badge-error';
    const statusLabel = h.status === 'success' ? 'SNIPED' : h.status === 'pending' ? 'PENDING' : 'FAILED';

    return `
      <div class="history-entry">
        <div class="history-header">
          <div class="history-meta">
            <span class="history-type-badge ${statusClass}">${statusLabel}</span>
            <span class="history-time">${time}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="history-amount">${h.amountSOL} SOL</span>
            ${h.txSig ? `<span class="history-type-badge badge-existing" style="cursor:pointer" data-action="copy" data-copy="${h.txSig}" title="${h.txSig}">TX ↗</span>` : ''}
          </div>
        </div>
        <div style="padding:0 12px 10px;font-size:9.5px;color:var(--text-dim)">
          <div style="font-family:var(--mono);color:var(--blue);cursor:pointer;margin-bottom:3px" data-action="copy" data-copy="${h.ca}">${shortAddr(h.ca)} ${h.name ? '— '+h.name : ''}</div>
          ${h.error ? `<div style="color:var(--danger)">${h.error}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ─────────────────────────────────────────
// EVENT HANDLERS
// ─────────────────────────────────────────
async function handleSniperAction(a, el) {

  if (a === 'sniper-tab') {
    S.sniper.activeTab = el.dataset.tab;
    await saveState(); render();

  } else if (a === 'sniper-mode') {
    S.sniper.mode = el.dataset.mode;
    await saveState(); render();

  } else if (a === 'sniper-toggle') {
    await toggleSniper();

  } else if (a === 'sniper-pick-wallet') {
    openWalletPicker('sniper-source', 'privkey');

  } else if (a === 'sniper-clear-wallet') {
    S.sniper.sourceWalletId = '';
    await saveState(); render();

  } else if (a === 'sniper-slippage-slide') {
    S.sniper.slippageBps = parseInt(el.value);
    const lbl = document.getElementById('sniper-slip-val');
    if (lbl) lbl.textContent = (S.sniper.slippageBps / 100).toFixed(1) + '%';
    saveState();
  }
}

async function toggleSniper() {
  // Save config first
  saveSniperConfig();

  // Validate
  const sn = S.sniper;
  const sourceWallet = S.savedWallets.find(w => w.id === sn.sourceWalletId);
  if (!sourceWallet && !document.getElementById('sniper-wallet-addr')?.value) {
    showToast('Set a source wallet first'); return;
  }
  if (sn.mode === 'ca' && !sn.targetCA) {
    showToast('Enter a target token CA'); return;
  }
  if (!sn.buyAmountSOL || sn.buyAmountSOL <= 0) {
    showToast('Set a buy amount > 0'); return;
  }

  sn.enabled = !sn.enabled;

  if (sn.enabled) {
    sniperLog('🎯 Sniper started', 'info');
    chrome.runtime.sendMessage({ action: 'startSniper', config: buildSniperBgConfig() });
  } else {
    sniperLog('■ Sniper stopped', 'info');
    chrome.runtime.sendMessage({ action: 'stopSniper' });
  }

  await saveState(); render();
}

function saveSniperConfig() {
  const sn = S.sniper;
  const caEl = document.getElementById('sniper-ca');
  const kwEl = document.getElementById('sniper-keyword');
  const capEl = document.getElementById('sniper-maxcap');
  const amtEl = document.getElementById('sniper-buy-amount');
  const prioEl = document.getElementById('sniper-priority');

  if (caEl) sn.targetCA = caEl.value.trim();
  if (kwEl) sn.keywordFilter = kwEl.value.trim();
  if (capEl) sn.maxMarketCapSOL = parseFloat(capEl.value) || 0;
  if (amtEl) sn.buyAmountSOL = parseFloat(amtEl.value) || 0.1;
  if (prioEl) sn.priorityFeeSOL = parseFloat(prioEl.value) || 0.001;

  // Handle manual wallet entry
  const addrEl = document.getElementById('sniper-wallet-addr');
  const keyEl = document.getElementById('sniper-wallet-key');
  if (addrEl?.value && keyEl?.value) {
    // Create a temporary saved wallet
    const existing = S.savedWallets.find(w => w.publicKey === addrEl.value.trim());
    if (existing) {
      sn.sourceWalletId = existing.id;
    } else {
      const newW = { id: uid(), name: 'Sniper Wallet', emoji: '🎯', publicKey: addrEl.value.trim(), privateKey: keyEl.value.trim() };
      S.savedWallets.push(newW);
      sn.sourceWalletId = newW.id;
    }
  }
}

function buildSniperBgConfig() {
  const sn = S.sniper;
  const sourceWallet = S.savedWallets.find(w => w.id === sn.sourceWalletId);
  return {
    mode: sn.mode,
    targetCA: sn.targetCA,
    keywordFilter: sn.keywordFilter,
    maxMarketCapSOL: sn.maxMarketCapSOL,
    buyAmountSOL: sn.buyAmountSOL,
    slippageBps: sn.slippageBps,
    priorityFeeSOL: sn.priorityFeeSOL,
    walletPubkey: sourceWallet?.publicKey || '',
  };
}

// Called from background when a snipe opportunity is detected
async function handleSniperTrigger(ca, tokenName) {
  const sn = S.sniper;
  if (!sn.enabled) return;

  const sourceWallet = S.savedWallets.find(w => w.id === sn.sourceWalletId);
  if (!sourceWallet?.privateKey) {
    sniperLog('✕ No private key — add in Settings', 'error');
    return;
  }

  const histEntry = {
    id: uid(), ts: Date.now(), ca, name: tokenName,
    amountSOL: sn.buyAmountSOL, status: 'pending', txSig: null, error: null
  };
  sn.history.unshift(histEntry);
  if (sn.history.length > 100) sn.history = sn.history.slice(0, 100);

  sniperLog(`🎯 Target found: ${tokenName || shortAddr(ca)}`, 'info');

  try {
    const txSig = await executeSnipe(
      ca, sn.buyAmountSOL, sn.slippageBps,
      sourceWallet.publicKey, sourceWallet.privateKey
    );
    histEntry.status = 'success';
    histEntry.txSig = txSig;
    sniperLog(`✓ Sniped ${tokenName || shortAddr(ca)} — ${txSig.slice(0, 10)}…`, 'success');
    // After one successful snipe on specific CA, stop
    if (sn.mode === 'ca') {
      sn.enabled = false;
      chrome.runtime.sendMessage({ action: 'stopSniper' });
      sniperLog('Auto-stopped after successful snipe', 'info');
    }
  } catch (err) {
    histEntry.status = 'failed';
    histEntry.error = err.message;
    sniperLog(`✕ Snipe failed: ${err.message}`, 'error');
  }

  await saveState(); render();
}
