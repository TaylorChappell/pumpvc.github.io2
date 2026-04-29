/* ═══════════════════════════════════════════
   market-maker.js — AI Market Maker
   Essor Studios / Solana Dev Tools

   Creates realistic, organic-looking trading
   patterns: wallets accumulate positions, hold
   for believable durations, stagger entries and
   exits, and adapt behaviour to how active the
   coin currently is — making the chart look
   bullish without every buy being immediately
   reversed.

   Architecture mirrors volume-bot.js 100%.
   Reuses: vbRpc, vbKp, vbSign, vbSignJupTx,
   vbSendBundle, vbConfirmBundle, vbDetectMigration,
   vbFetchCurve, vbDoBundle, vbJupFetch,
   vbJupiterSeparate, vbAta, vbSendSol, etc.
═══════════════════════════════════════════ */
'use strict';

// ── Constants ──────────────────────────────

// How long a wallet holds tokens before selling (seconds).
// These are per-strategy ranges, jittered at runtime.
const MM_HOLD_MIN = {
  scalp:    20,   // quick flip — 20–90s
  swing:   120,   // hold a few minutes — 2–8 min
  position: 600,  // longer bag — 10–30 min
};
const MM_HOLD_MAX = {
  scalp:    90,
  swing:   480,
  position: 1800,
};

// Cycle interval between starting new positions (seconds)
const MM_CYCLE_MIN = { low: 45, medium: 20, high: 8  };
const MM_CYCLE_MAX = { low: 120, medium: 45, high: 20 };

// Max wallets holding simultaneously (creates stacked open positions)
const MM_MAX_OPEN = 4;

// Activity detection: txs/min thresholds for coin activity level
const MM_ACTIVITY_HIGH   = 15;  // txs/min → high
const MM_ACTIVITY_MEDIUM = 4;   // txs/min → medium, below = low

// Fail circuit-breaker
const MM_FAIL_MAX  = 5;
const MM_LOG_MAX   = 300;
const MM_HIST_MAX  = 200;

// Sell-side jitter: sometimes we sell only 60-90% of our bag (leave a residual)
// to make it look like a real trader who doesn't fully exit
const MM_PARTIAL_SELL_PROB = 0.35; // 35% chance of partial sell
const MM_PARTIAL_SELL_MIN  = 0.55; // sell at least 55% of bag
const MM_PARTIAL_SELL_MAX  = 0.92; // sell at most 92% of bag

// ── Runtime ────────────────────────────────
// MM.openPositions: array of { wallet, tokensBought, solSpent, boughtAt, holdSec, sellAt }
// These are in-memory only — wallets hold real tokens on-chain
let MM = {
  running:       false,
  stopReq:       false,
  cycleTimer:    null,
  openPositions: [],   // active bags waiting to be sold
  sellTimers:    [],   // setTimeout handles for pending sells
  idx:           0,    // round-robin wallet index
};
let _mmCdInterval = null;

// ── State accessor ───────────────────────────
function mmS() {
  S.marketMaker = S.marketMaker || {};
  return S.marketMaker;
}

// ── Logging ──────────────────────────────────
function mmLog(msg, type = 'info') {
  const ts = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const mm = mmS();
  mm.log = mm.log || [];
  mm.log.unshift({ id: uid(), ts, msg, type, fullDate: new Date().toDateString() });
  if (mm.log.length > MM_LOG_MAX) mm.log = mm.log.slice(0, MM_LOG_MAX);

  if (S.activeTool === 'market-maker' && (mm._tab || 'config') === 'console') {
    const feed = document.getElementById('mm-feed');
    if (feed) {
      const d = document.createElement('div');
      d.className = `vb-log-entry vb-log-${type}`;
      d.innerHTML = `<span class="vb-log-ts">${ts}</span>`
                  + `<span class="vb-log-msg">${mmEsc(msg)}</span>`;
      feed.insertBefore(d, feed.firstChild);
      while (feed.children.length > 120) feed.removeChild(feed.lastChild);
      const c = document.getElementById('mm-feed-count');
      if (c) c.textContent = `${mm.log.length} entries`;
    }
  }
  mmStatUpdate();
}

function mmEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function mmStatUpdate() {
  const s = mmS().stats || {};
  const pos = MM.openPositions.length;
  const m = {
    'mm-stat-cycles':   s.cycles       || 0,
    'mm-stat-volume':   parseFloat(s.volumeAdded  || 0).toFixed(2),
    'mm-stat-open':     pos,
    'mm-stat-fees':     parseFloat(s.feesPaid     || 0).toFixed(4),
  };
  for (const [id, v] of Object.entries(m)) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }
}

// ── Jitter helper ─────────────────────────────
function mmJitter(val, pct = 8) {
  return val * (1 + (Math.random() * 2 - 1) * pct / 100);
}

// ── Activity level detection ──────────────────
// Looks at recent on-chain transaction count for the token
// to gauge how hot it is right now.
async function mmDetectActivity(mint) {
  try {
    const sigs = await vbRpc('getSignaturesForAddress', [
      mint, { limit: 30 }
    ]);
    if (!sigs || !sigs.length) return 'low';
    // Check how many txs landed in the last 2 minutes
    const cutoff = Date.now() / 1000 - 120;
    const recent = sigs.filter(s => s.blockTime && s.blockTime > cutoff).length;
    const perMin = recent / 2;
    if (perMin >= MM_ACTIVITY_HIGH)   return 'high';
    if (perMin >= MM_ACTIVITY_MEDIUM) return 'medium';
    return 'low';
  } catch {
    return 'medium'; // safe default
  }
}

// ── Hold time decision ────────────────────────
// Decides how long this position should be held before selling.
// More active coins → shorter holds (traders flip fast).
// Less active coins → longer holds (simulate accumulation).
function mmDecideHold(activity, strategy) {
  const profile = strategy || mmS().strategy || 'swing';
  const mn = MM_HOLD_MIN[profile] || 60;
  const mx = MM_HOLD_MAX[profile] || 300;

  // Modulate by activity
  let lo = mn, hi = mx;
  if (activity === 'high') {
    lo = mn;
    hi = Math.round(mx * 0.5); // flip faster on hot coins
  } else if (activity === 'low') {
    lo = Math.round(mn * 1.5);
    hi = mx; // hold longer on quiet coins
  }
  if (hi < lo) hi = lo + 10;

  return Math.round(lo + Math.random() * (hi - lo));
}

// ── Cycle interval decision ───────────────────
function mmDecideInterval(activity) {
  const mn = MM_CYCLE_MIN[activity]  || 20;
  const mx = MM_CYCLE_MAX[activity]  || 60;
  return Math.round(mmJitter((mn + mx) / 2, 20));
}

// ── Active wallet list ────────────────────────
function mmActiveWallets() {
  const mm  = mmS();
  const sel = new Set(mm.selectedWalletIds || []);
  if (mm.walletMode === 'existing') {
    return S.savedWallets.filter(w => {
      if (!w.privateKey || !w.publicKey) return false;
      if (sel.size > 0 && !sel.has(w.id)) return false;
      const b = vbGetBal(w.publicKey) ?? 0;
      return b >= 0.05;
    });
  }
  return (mm.generatedWallets || []).filter(w => w.privateKey && w.publicKey);
}

// ── Balance helpers ───────────────────────────
async function mmRefreshAllBals() {
  const mm = mmS();
  const pks = new Set();
  S.savedWallets.forEach(w => { if (w.publicKey) pks.add(w.publicKey); });
  (mm.generatedWallets || []).forEach(w => { if (w.publicKey) pks.add(w.publicKey); });
  for (const pk of pks) await vbFetchBal(pk);
  if (S.activeTool === 'market-maker') render();
}

// ── Fail / circuit-breaker ────────────────────
function mmFail() {
  const mm = mmS();
  mm.ai.fail++;
  mm.ai.ok = 0;
  if (mm.ai.fail >= MM_FAIL_MAX) {
    mmLog(`🛑 Circuit breaker (${MM_FAIL_MAX} consecutive fails)`, 'error');
    mmStop('Circuit breaker');
  }
}

// ── Record history entry ──────────────────────
function mmRecord(walletPub, action, solAmt, fees, tokAmt, path) {
  const mm = mmS();
  if (action === 'sell') {
    mm.stats.cycles++;
    mm.stats.volumeAdded = parseFloat(mm.stats.volumeAdded || 0) + solAmt;
    mm.stats.feesPaid    = parseFloat(mm.stats.feesPaid    || 0) + fees;
    mm.ai.ok++;
    mm.ai.fail = 0;
  }
  mm.history = mm.history || [];
  mm.history.unshift({
    id: uid(), ts: new Date().toISOString(),
    wallet: walletPub, action, solAmt, fees,
    tokAmt: tokAmt || 0, path: path || 'Pump.fun',
  });
  if (mm.history.length > MM_HIST_MAX) mm.history = mm.history.slice(0, MM_HIST_MAX);
}

// ── Migration badge ───────────────────────────
function mmUpdateMigBadge() {
  const mm = mmS();
  const el = document.getElementById('mm-mig-badge');
  if (!el) return;
  if (mm._migStatus === 'raydium') {
    el.textContent = '🔄 Raydium/Jupiter';
    el.className   = 'vb-mig-badge vb-mig-raydium';
  } else if (mm._migStatus === 'pump') {
    el.textContent = `🟢 Pump.fun · ${MM.openPositions.length} open`;
    el.className   = 'vb-mig-badge vb-mig-pump';
  } else {
    el.textContent = '⏳ Detecting…';
    el.className   = 'vb-mig-badge vb-mig-unknown';
  }
}

// ── Countdown ────────────────────────────────
function mmCd(sec, label) {
  if (_mmCdInterval) clearInterval(_mmCdInterval);
  let r = sec;
  const tick = () => {
    const el = document.getElementById('mm-countdown');
    if (el) el.textContent = label ? `${label} in ${r}s` : `Next in ${r}s`;
    if (r <= 0) clearInterval(_mmCdInterval);
    r--;
  };
  tick();
  _mmCdInterval = setInterval(tick, 1000);
}

// ══════════════════════════════════════════════
// CORE: SEND A STANDALONE BUY (no immediate sell)
// ══════════════════════════════════════════════
//
// Unlike the Volume Bot which atomically buys+sells in the same bundle,
// the Market Maker sends a REAL buy that leaves tokens in the wallet.
// The sell is scheduled separately after a hold period.
//
async function mmSendBuy(wallet, sol, mint, migrated) {
  const lamports  = Math.floor(sol * 1e9);
  const buySlip   = 600;

  if (migrated) {
    // ── Jupiter buy (post-grad) ──────────────────
    const buyQuote = await vbJupFetch(
      `${VB_JUP_QUOTE}?inputMint=${VB_SOL_MINT}` +
      `&outputMint=${encodeURIComponent(mint)}` +
      `&amount=${lamports}&slippageBps=${buySlip}&restrictIntermediateTokens=true`
    );
    const tokensOutRaw = parseInt(buyQuote.outAmount || '0');
    if (!tokensOutRaw) throw new Error('Buy quote: 0 tokens out');

    const swapBody = JSON.stringify({
      quoteResponse:            buyQuote,
      userPublicKey:            wallet.publicKey,
      wrapAndUnwrapSol:         true,
      dynamicComputeUnitLimit:  true,
      skipUserAccountsRpcCalls: true,
      prioritizationFeeLamports: 'auto',
    });
    const buySwap = await vbJupFetch(VB_JUP_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: swapBody,
    });
    if (!buySwap.swapTransaction) throw new Error('No buy tx from Jupiter');
    const signedBuyB64 = await vbSignJupTx(buySwap.swapTransaction, wallet.privateKey);

    // Send as standalone RPC (NOT a bundle — it stays in the wallet)
    const sig = await mmSendRawB64(signedBuyB64);
    mmLog(
      `📥 Buy sent: ${sol.toFixed(4)} SOL → ~${tokensOutRaw.toLocaleString()} tok` +
      ` (${short(wallet.publicKey)}) · sig: ${sig.slice(0,10)}…`,
      'buy'
    );
    return { tokensReceived: tokensOutRaw, sig };

  } else {
    // ── Pump.fun buy (bonding curve) ─────────────
    const cv = await vbFetchCurve(mint);
    if (!cv || cv.complete) throw new Error('Curve gone/complete');

    const tokExp  = vbTokOut(sol, cv);
    const maxCost = BigInt(Math.floor(sol * 1.05 * 1e9));

    const bh = await vbRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
    if (!bh?.value?.blockhash) throw new Error('No blockhash');

    const curveAta = await vbRpc('getTokenAccountsByOwner', [
      cv.address, { mint }, { encoding: 'jsonParsed' }
    ]);
    const cvTok = curveAta?.value?.[0]?.pubkey;
    if (!cvTok) throw new Error('Curve token acct not found');

    const userAta  = await vbAta(wallet.publicKey, mint);
    const uAtaAddr = userAta?.address || wallet.publicKey;

    // Build BUY-only transaction (no sell) using pump.fun instruction directly
    const kp   = vbKp(wallet.privateKey);
    const keys = [wallet.publicKey, cv.address, cv.mint, cvTok, uAtaAddr,
                  VB_PUMP_GLOBAL, VB_PUMP_FEE, VB_PUMP_EVAUTH, VB_PUMP_PROG,
                  TOK_PROG, SYS_PROG, RENT_PROG, ASSOC_PROG];
    const hdr  = [1, 0, 5];

    const buyIx = { pi: 8, ac: [5,6,2,1,3,4,0,10,9,11,7,8], data: vbBuyData(tokExp, maxCost) };

    // Tip TX to incentivise validators to include our transaction quickly
    const tipD  = new Uint8Array(12);
    const tipDv = new DataView(tipD.buffer);
    tipDv.setUint32(0, 2, true);
    tipDv.setBigUint64(4, BigInt(Math.round(VB_TIP_SOL * 1e9)), true);

    const buyMsg = vbSerMsg({ header: hdr, keys, bh: bh.value.blockhash, ixs: [buyIx] });
    const tipMsg = vbSerMsg({
      header: [1, 0, 1],
      keys:   [wallet.publicKey, VB_JITO_TIP, SYS_PROG],
      bh:     bh.value.blockhash,
      ixs:    [{ pi: 2, ac: [0, 1], data: tipD }],
    });

    const [s1, s2] = await Promise.all([
      vbSign(buyMsg, kp.seed), vbSign(tipMsg, kp.seed)
    ]);

    // Bundle: just [buyTx, tipTx] — no sell
    const { bundleId } = await vbSendBundle([
      bs58encode(vbSerTx(buyMsg, [s1])),
      bs58encode(vbSerTx(tipMsg, [s2])),
    ]);
    const conf = await vbConfirmBundle(bundleId);
    if (!conf.landed) throw new Error(`Bundle not landed: ${conf.reason}`);

    const tokN = Number(tokExp);
    mmLog(
      `📥 Buy landed: ${sol.toFixed(4)} SOL → ~${tokN.toLocaleString()} tok` +
      ` (${short(wallet.publicKey)}) · bundle: ${bundleId.slice(0,10)}…`,
      'buy'
    );
    return { tokensReceived: tokN, bundleId };
  }
}

// ══════════════════════════════════════════════
// CORE: SEND A STANDALONE SELL
// ══════════════════════════════════════════════
//
// Sells some or all of a wallet's token balance.
// Queries actual ATA balance first so we always
// sell what's actually there.
//
async function mmSendSell(wallet, mint, pctToSell, migrated) {
  const sellSlip = 1300;

  // Query actual on-chain ATA balance
  const ata = await vbAta(wallet.publicKey, mint);
  const rawBal = ata?.amount ? Number(ata.amount) : 0;
  if (rawBal <= 0) {
    mmLog(`⚠ ${short(wallet.publicKey)} has no tokens to sell — skipping`, 'warn');
    return null;
  }

  const sellAmt = Math.max(1, Math.floor(rawBal * pctToSell));
  mmLog(
    `📤 Sell ${(pctToSell * 100).toFixed(0)}% of bag (${sellAmt.toLocaleString()} tok)` +
    ` from ${short(wallet.publicKey)}…`,
    'sell'
  );

  if (migrated) {
    // ── Jupiter sell ─────────────────────────────
    const sellQuote = await vbJupFetch(
      `${VB_JUP_QUOTE}?inputMint=${encodeURIComponent(mint)}&outputMint=${VB_SOL_MINT}` +
      `&amount=${sellAmt}&slippageBps=${sellSlip}&restrictIntermediateTokens=true`
    );
    const solBackRaw = parseInt(sellQuote.outAmount || '0');
    const solBack    = solBackRaw / 1e9;

    const swapBody = JSON.stringify({
      quoteResponse:            sellQuote,
      userPublicKey:            wallet.publicKey,
      wrapAndUnwrapSol:         true,
      dynamicComputeUnitLimit:  true,
      skipUserAccountsRpcCalls: true,
      prioritizationFeeLamports: 'auto',
    });
    const sellSwap = await vbJupFetch(VB_JUP_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: swapBody,
    });
    if (!sellSwap.swapTransaction) throw new Error('No sell tx from Jupiter');
    const signedSellB64 = await vbSignJupTx(sellSwap.swapTransaction, wallet.privateKey);

    // Retry with wider slippage on failure
    let sig;
    try {
      sig = await mmSendRawB64(signedSellB64);
    } catch (e) {
      if (e.message.includes('0x1789') || e.message.includes('slippage')) {
        const retrySlip = sellSlip + 700;
        mmLog(`  ↳ Slippage — retrying at ${retrySlip}bps…`, 'warn');
        const rq = await vbJupFetch(
          `${VB_JUP_QUOTE}?inputMint=${encodeURIComponent(mint)}&outputMint=${VB_SOL_MINT}` +
          `&amount=${sellAmt}&slippageBps=${retrySlip}&restrictIntermediateTokens=true`
        );
        const rs = await vbJupFetch(VB_JUP_SWAP, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteResponse: rq, userPublicKey: wallet.publicKey,
            wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
            skipUserAccountsRpcCalls: true, prioritizationFeeLamports: 'auto',
          }),
        });
        const retryB64 = await vbSignJupTx(rs.swapTransaction, wallet.privateKey);
        sig = await mmSendRawB64(retryB64);
      } else throw e;
    }

    mmLog(
      `✓ Sell landed: ~${solBack.toFixed(4)} SOL back (${short(wallet.publicKey)})` +
      ` · sig: ${sig.slice(0,10)}…`,
      'success'
    );
    return { solReceived: solBack, sig, tokensSold: sellAmt };

  } else {
    // ── Pump.fun sell (bonding curve) ────────────
    const cv = await vbFetchCurve(mint);
    if (!cv || cv.complete) {
      mmLog('ℹ Curve graduated mid-hold — using Jupiter for sell', 'warn');
      return mmSendSell(wallet, mint, pctToSell, true);
    }

    const bh = await vbRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
    if (!bh?.value?.blockhash) throw new Error('No blockhash for sell');

    const userAta  = await vbAta(wallet.publicKey, mint);
    const uAtaAddr = userAta?.address || wallet.publicKey;
    const curveAta = await vbRpc('getTokenAccountsByOwner', [
      cv.address, { mint }, { encoding: 'jsonParsed' }
    ]);
    const cvTok = curveAta?.value?.[0]?.pubkey;
    if (!cvTok) throw new Error('Curve token acct not found');

    const kp   = vbKp(wallet.privateKey);
    const keys = [wallet.publicKey, cv.address, cv.mint, cvTok, uAtaAddr,
                  VB_PUMP_GLOBAL, VB_PUMP_FEE, VB_PUMP_EVAUTH, VB_PUMP_PROG,
                  TOK_PROG, SYS_PROG, RENT_PROG, VB_JITO_TIP, ASSOC_PROG];
    const hdr  = [1, 0, 5];

    const sellIx = { pi: 8, ac: [5,6,2,1,3,4,0,9,10,7,8], data: vbSellData(BigInt(sellAmt), BigInt(0)) };

    const tipD  = new Uint8Array(12);
    const tipDv = new DataView(tipD.buffer);
    tipDv.setUint32(0, 2, true);
    tipDv.setBigUint64(4, BigInt(Math.round(VB_TIP_SOL * 1e9)), true);

    const sellMsg = vbSerMsg({ header: hdr, keys, bh: bh.value.blockhash, ixs: [sellIx] });
    const tipMsg  = vbSerMsg({
      header: [1, 0, 1],
      keys:   [wallet.publicKey, VB_JITO_TIP, SYS_PROG],
      bh:     bh.value.blockhash,
      ixs:    [{ pi: 2, ac: [0, 1], data: tipD }],
    });

    const [s1, s2] = await Promise.all([
      vbSign(sellMsg, kp.seed), vbSign(tipMsg, kp.seed)
    ]);

    const { bundleId } = await vbSendBundle([
      bs58encode(vbSerTx(sellMsg, [s1])),
      bs58encode(vbSerTx(tipMsg,  [s2])),
    ]);
    const conf = await vbConfirmBundle(bundleId);
    if (!conf.landed) throw new Error(`Sell bundle not landed: ${conf.reason}`);

    // Estimate SOL received from curve formula
    const solEst = (Number(cv.vs) / 1e9) * (sellAmt / Number(cv.vt));
    mmLog(
      `✓ Sell landed: ~${solEst.toFixed(4)} SOL back (${short(wallet.publicKey)})` +
      ` · bundle: ${bundleId.slice(0,10)}…`,
      'success'
    );
    return { solReceived: solEst, bundleId, tokensSold: sellAmt };
  }
}

// ── Send raw base64 transaction via RPC ───────
async function mmSendRawB64(b64) {
  const r = await fetch(vbRpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'sendTransaction',
      params: [b64, {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'processed',
        maxRetries: 3,
      }],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  if (!j.result) throw new Error('sendTransaction returned no signature');
  return j.result;
}

// ══════════════════════════════════════════════
// MAIN CYCLE ORCHESTRATOR
// ══════════════════════════════════════════════
//
// Each cycle:
//  1. Detect migration + activity level
//  2. Pick a wallet that isn't already holding
//  3. Decide buy size based on activity
//  4. Send buy (tokens stay in wallet)
//  5. Schedule a sell timer based on hold strategy
//  6. Schedule next buy cycle
//
// While a position is open, OTHER wallets can
// also be buying (staggered entries). Sells fire
// independently on their own timers.
//
async function mmRunCycle() {
  if (!MM.running || MM.stopReq) return;
  const mm = mmS();
  if (!mm.active) return;

  // Detect migration (cached 60s inside vbDetectMigration)
  const mig = await vbDetectMigration(mm.targetCA);
  mm._migStatus = mig.migrated ? 'raydium' : 'pump';
  mmUpdateMigBadge();

  // Detect activity level (drives hold time + interval)
  const activity = await mmDetectActivity(mm.targetCA);
  mm._activity   = activity;

  mmLog(`── New position · activity: ${activity} · path: ${mm._migStatus} ──`, 'info');

  // Don't open more than MM_MAX_OPEN simultaneous positions
  if (MM.openPositions.length >= MM_MAX_OPEN) {
    mmLog(`⏸ ${MM_MAX_OPEN} positions already open — waiting for sells`, 'warn');
    mmSched(activity);
    return;
  }

  // Pick a wallet that isn't already holding an open position
  const wallets = mmActiveWallets();
  if (!wallets.length) {
    mmLog('⚠ No eligible wallets (need ≥0.05 SOL)', 'warn');
    mmSched(activity);
    return;
  }

  // Filter out wallets already in an open position
  const busyPubs = new Set(MM.openPositions.map(p => p.wallet.publicKey));
  const available = wallets.filter(w => !busyPubs.has(w.publicKey));
  if (!available.length) {
    mmLog('⏸ All wallets have open positions — waiting for sells', 'warn');
    mmSched(activity);
    return;
  }

  const wallet = available[MM.idx % available.length];
  MM.idx++;

  const bal = await vbFetchBal(wallet.publicKey) ?? 0;
  if (bal < 0.01) {
    mmLog(`⚠ ${short(wallet.publicKey)} balance too low: ${bal.toFixed(4)} SOL`, 'warn');
    mmSched(activity);
    return;
  }

  // Size the buy based on activity and user config
  const minS = parseFloat(mm.minSOL) || 0.05;
  const maxS = parseFloat(mm.maxSOL) || 0.25;
  let sol = minS + Math.random() * (maxS - minS);
  sol = mmJitter(sol, 8);
  sol = Math.min(sol, bal * 0.8 - VB_TIP_SOL); // never spend more than 80% of balance
  if (sol < 0.01) {
    mmLog(`⚠ Computed buy size too small (${sol.toFixed(4)} SOL)`, 'warn');
    mmSched(activity);
    return;
  }

  // Send the buy
  let buyResult;
  try {
    buyResult = await mmSendBuy(wallet, sol, mm.targetCA, mig.migrated);
  } catch (e) {
    mmLog(`✕ Buy failed: ${e.message}`, 'error');
    mmFail();
    mmSched(activity);
    return;
  }

  const fees = VB_TIP_SOL + 0.00005;
  mmRecord(wallet.publicKey, 'buy', sol, fees, buyResult.tokensReceived, mig.migrated ? 'Jupiter' : 'Pump.fun');

  // Decide hold duration
  const strategy = mm.strategy || 'swing';
  const holdSec  = mmDecideHold(activity, strategy);
  const sellAt   = Date.now() + holdSec * 1000;

  // Register the open position
  const position = {
    wallet,
    tokensReceived: buyResult.tokensReceived,
    solSpent: sol,
    boughtAt: Date.now(),
    holdSec,
    sellAt,
    migrated: mig.migrated,
    id: uid(),
  };
  MM.openPositions.push(position);

  mmLog(
    `⏱ Holding ${sol.toFixed(4)} SOL position (${short(wallet.publicKey)}) — ` +
    `selling in ~${holdSec}s (${strategy})`,
    'info'
  );
  mmUpdateMigBadge();

  // Schedule the sell
  const sellTimer = setTimeout(async () => {
    if (!MM.running && !mm.active) return; // bot stopped
    await mmExecuteSell(position);
  }, holdSec * 1000);

  MM.sellTimers.push(sellTimer);

  // Update stats + render
  mm.stats.cycles = (mm.stats.cycles || 0); // incremented on sell
  await saveState(); mmStatUpdate();
  if (S.activeTool === 'market-maker' && mm._tab === 'history') render();

  // Schedule next buy
  mmSched(activity);
}

// ── Execute a scheduled sell ──────────────────
async function mmExecuteSell(position) {
  const mm = mmS();
  if (!position) return;

  // Remove from open positions list
  MM.openPositions = MM.openPositions.filter(p => p.id !== position.id);
  mmUpdateMigBadge();

  // Re-detect migration in case it happened during the hold
  let migrated = position.migrated;
  try {
    const mig = await vbDetectMigration(mm.targetCA);
    migrated = mig.migrated;
  } catch {}

  // Decide what fraction to sell (partial vs full exit)
  let pctToSell = 1.0;
  if (Math.random() < MM_PARTIAL_SELL_PROB) {
    pctToSell = MM_PARTIAL_SELL_MIN + Math.random() * (MM_PARTIAL_SELL_MAX - MM_PARTIAL_SELL_MIN);
    mmLog(
      `💼 Partial exit: selling ${(pctToSell * 100).toFixed(0)}% of bag ` +
      `(holding ${((1 - pctToSell) * 100).toFixed(0)}% residual)`,
      'info'
    );
  }

  let sellResult;
  try {
    sellResult = await mmSendSell(position.wallet, mm.targetCA, pctToSell, migrated);
  } catch (e) {
    mmLog(`✕ Sell failed for ${short(position.wallet.publicKey)}: ${e.message}`, 'error');
    mmFail();
    await saveState(); mmStatUpdate();
    return;
  }

  if (!sellResult) return; // wallet had no tokens (already sold or never landed)

  const fees = VB_TIP_SOL + 0.00005;
  const path = migrated ? 'Jupiter' : 'Pump.fun';
  mmRecord(position.wallet.publicKey, 'sell', sellResult.solReceived, fees, sellResult.tokensSold, path);

  const held = Math.round((Date.now() - position.boughtAt) / 1000);
  const pnl  = sellResult.solReceived - position.solSpent;
  mmLog(
    `✓ Sell complete · held ${held}s · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(5)} SOL PnL` +
    ` (${short(position.wallet.publicKey)})`,
    'success'
  );

  await saveState(); mmStatUpdate();
  if (S.activeTool === 'market-maker' && mm._tab === 'history') render();
}

// ── Scheduler ────────────────────────────────
function mmSched(activity) {
  if (!MM.running || MM.stopReq) return;
  const mm = mmS();

  const sec = mmDecideInterval(activity || mm._activity || 'medium');
  mm.nextIn = sec;
  saveState();
  mmCd(sec, 'Next buy');
  mmUpdateMigBadge();
  MM.cycleTimer = setTimeout(() => {
    mm.nextIn = null;
    mmRunCycle();
  }, sec * 1000);
}

// ── Start / Stop ─────────────────────────────
async function mmStart() {
  const mm = mmS();
  if (!mm.targetCA || mm.targetCA.length < 32) {
    showToast('Enter a valid token CA first'); return;
  }
  if (!mmActiveWallets().length) {
    showToast('No eligible wallets (need ≥0.05 SOL)'); return;
  }
  mmLog('📈 AI Market Maker starting…', 'info');
  mm.active         = true;
  mm.ai             = { ok: 0, fail: 0 };
  mm.stats          = mm.stats || { cycles: 0, volumeAdded: 0, feesPaid: 0 };
  MM.running        = true;
  MM.stopReq        = false;
  MM.idx            = 0;
  MM.openPositions  = [];
  await saveState(); render();
  await mmRunCycle();
}

async function mmStop(reason) {
  MM.running  = false;
  MM.stopReq  = true;
  if (MM.cycleTimer)   { clearTimeout(MM.cycleTimer);  MM.cycleTimer = null; }
  if (_mmCdInterval)   { clearInterval(_mmCdInterval); _mmCdInterval = null; }
  // Cancel all pending sell timers
  MM.sellTimers.forEach(t => clearTimeout(t));
  MM.sellTimers    = [];
  // Don't abandon open positions — log them so user knows
  if (MM.openPositions.length) {
    mmLog(`⚠ ${MM.openPositions.length} position(s) still open — tokens remain in wallets`, 'warn');
    MM.openPositions.forEach(p => {
      mmLog(`  · ${short(p.wallet.publicKey)} holding ~${p.tokensReceived.toLocaleString()} tokens`, 'warn');
    });
    MM.openPositions = [];
  }
  const mm = mmS();
  mm.active  = false;
  mm.nextIn  = null;
  if (reason) mmLog(`🛑 Stopped: ${reason}`, 'warn');
  else        mmLog('🛑 Market Maker stopped.', 'info');
  await saveState(); render();
}

// ── Generate & fund wallets ───────────────────
async function mmGenFund() {
  const mm  = mmS();
  const n   = parseInt(mm.newWalletCount) || 5;
  const tot = parseFloat(mm._fundTotal)   || 1.0;
  const src = S.savedWallets.find(w => w.id === mm.sourceWalletId);
  if (!src?.privateKey) { showToast('Select a source wallet first'); return; }
  const per = tot / n;
  if (tot > 5 && !confirm(`Fund ${n} wallets × ${per.toFixed(4)} SOL = ${tot} SOL?`)) return;
  mmLog(`Generating ${n} wallets, ${per.toFixed(4)} SOL each…`, 'info');
  const fresh = [];
  for (let i = 0; i < n; i++) {
    const kp = await generateKeypair();
    fresh.push({ id: uid(), publicKey: kp.publicKey, privateKey: kp.privateKey });
  }
  mm.generatedWallets = [...(mm.generatedWallets || []), ...fresh];
  await saveState(); render();
  for (const w of fresh) {
    try {
      await vbSendSol(src, w.publicKey, per);
      mmLog(`✓ Funded ${short(w.publicKey)}: ${per.toFixed(4)} SOL`, 'success');
      await vbFetchBal(w.publicKey);
    } catch (e) { mmLog(`✕ Fund failed ${short(w.publicKey)}: ${e.message}`, 'error'); }
  }
  await saveState(); render(); showToast(`✓ ${n} wallets generated & funded`);
}

async function mmRefundAll() {
  const mm  = mmS();
  const src = S.savedWallets.find(w => w.id === mm.sourceWalletId);
  if (!src?.publicKey) { mmLog('⚠ No source wallet', 'warn'); return; }
  for (const w of (mm.generatedWallets || [])) {
    if (!w.privateKey) continue;
    const bal = await vbFetchBal(w.publicKey) ?? 0;
    if (bal < 0.000_010) continue;
    try {
      await vbSendSol(w, src.publicKey, bal - 0.000_010);
      mmLog(`↩ ${short(w.publicKey)}: ${(bal-0.000_010).toFixed(4)} SOL`, 'success');
    } catch (e) { mmLog(`✕ ${short(w.publicKey)}: ${e.message}`, 'error'); }
  }
}

// ── Injected styles ───────────────────────────
(function mmInjectStyles() {
  if (document.getElementById('mm-injected-css')) return;
  const s = document.createElement('style');
  s.id = 'mm-injected-css';
  s.textContent = `
/* ── MM: history table — 7 cols (Time, Wallet, Action, SOL, Tokens, Fees, Path) ── */
.mm-hist-hdr, .mm-hist-row {
  display:grid;
  grid-template-columns:58px 68px 42px 62px 72px 62px 58px;
  gap:4px; padding:5px 10px;
}
.mm-hist-hdr {
  background:var(--surface2);
  font-size:8.5px; font-weight:700; color:var(--text-dim);
  text-transform:uppercase; letter-spacing:.05em;
}
.mm-hist-row {
  border-bottom:1px solid var(--border);
  align-items:center; font-size:9.5px;
}
.mm-hist-row:last-child { border-bottom:none; }
.mm-hist-row:hover { background:var(--surface); }
.mm-act-buy  { color:var(--green-dim); font-weight:700; font-size:9px; }
.mm-act-sell { color:var(--blue);      font-weight:700; font-size:9px; }
/* ── MM: strategy pills ── */
.mm-strategy-row { display:flex; gap:5px; flex-wrap:wrap; margin-bottom:12px; }
.mm-strat-pill {
  flex:1; min-width:70px; text-align:center;
  padding:5px 8px; border-radius:var(--r-sm);
  font-size:9px; font-weight:700; cursor:pointer;
  border:1px solid var(--border-md); background:var(--surface2);
  color:var(--text-mid); transition:all .12s; letter-spacing:.02em;
}
.mm-strat-pill:hover { border-color:var(--border-hi); color:var(--navy); }
.mm-strat-pill.active { background:var(--navy-ghost2); border-color:var(--navy); color:var(--navy); }
.mm-strat-pill.strat-scalp.active  { background:rgba(239,68,68,.1); border-color:rgba(220,38,38,.4); color:#dc2626; }
.mm-strat-pill.strat-pos.active    { background:rgba(139,92,246,.1); border-color:rgba(139,92,246,.4); color:#7c3aed; }
/* ── MM: open positions indicator ── */
.mm-open-badge {
  display:inline-flex; align-items:center; gap:5px;
  font-size:9.5px; font-weight:600; padding:3px 8px;
  border-radius:20px; margin-top:6px; margin-bottom:2px;
  background:rgba(34,197,94,.08); border:1px solid rgba(34,197,94,.25);
  color:var(--green-dim);
}
/* ── MM: side-by-side min/max SOL inputs ── */
.mm-sol-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; }
.mm-sol-row .field { margin-bottom:0; }
  `;
  document.head.appendChild(s);
})();

// ── Page builder ──────────────────────────────
function buildMarketMakerPage() {
  const mm  = mmS();
  const tab = mm._tab || 'config';
  const on  = mm.active;
  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">AI Market Maker</span>
        <div style="display:flex;gap:5px;align-items:center">
          ${on ? `<span class="live-badge">● LIVE</span>` : ''}
          <button class="btn ${on ? 'btn-danger' : 'btn-primary'} btn-sm"
            data-action="${on ? 'mm-stop' : 'mm-start'}">${on ? '⏹ Stop' : '▶ Start'}</button>
        </div>
      </div>
      <div class="vb-tabs">
        <button class="tab ${tab==='config'  ?'active':''}" data-action="mm-tab" data-tab="config">Config</button>
        <button class="tab ${tab==='console' ?'active':''}" data-action="mm-tab" data-tab="console">Console${mm.log?.length?` <span class="nav-badge" style="background:var(--navy-ghost2);color:var(--navy);font-size:7px;padding:1px 4px">${Math.min(mm.log.length,99)}</span>`:''}
        </button>
        <button class="tab ${tab==='history' ?'active':''}" data-action="mm-tab" data-tab="history">History${mm.history?.length?` (${mm.history.length})`:''}</button>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">
      ${tab==='config'  ? buildMmConfig()  : ''}
      ${tab==='console' ? buildMmConsole() : ''}
      ${tab==='history' ? buildMmHistory() : ''}
    </div>`;
}

// ── Config tab ────────────────────────────────
function buildMmConfig() {
  const mm    = mmS();
  const on    = mm.active;
  const stats = mm.stats || {};
  const dis   = on ? '<div style="opacity:.5;pointer-events:none">' : '<div>';
  const openPos = MM.openPositions.length;

  return `
    <div class="vb-stats-row">
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-cycles">${stats.cycles || 0}</div>
        <div class="vb-stat-lbl">Sells</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-volume">${parseFloat(stats.volumeAdded||0).toFixed(2)}</div>
        <div class="vb-stat-lbl">SOL Volume</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-open">${openPos}</div>
        <div class="vb-stat-lbl">Open Bags</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-fees">${parseFloat(stats.feesPaid||0).toFixed(4)}</div>
        <div class="vb-stat-lbl">Fees SOL</div>
      </div>
    </div>

    ${dis}
      <div class="field">
        <div class="field-label">Target Coin CA
          <button class="help-q" data-action="show-help" data-title="Target Coin CA"
            data-body="Mint address of the token to market-make. Auto-detects bonding curve vs Raydium.">?</button>
        </div>
        <input type="text" placeholder="Token mint address…"
          value="${mm.targetCA||''}" data-mm-field="targetCA"/>
      </div>
      <div id="mm-mig-badge" class="vb-mig-badge vb-mig-unknown">⏳ Detecting…</div>

      <div class="vb-divider"></div>

      <!-- Hold strategy -->
      <div class="field">
        <div class="field-label">Hold Strategy
          <button class="help-q" data-action="show-help" data-title="Hold Strategy"
            data-body="Scalp: buy and sell quickly (20–90s). Swing: hold a few minutes (2–8 min). Position: longer holds (10–30 min). All durations adjust automatically based on how active the coin is.">?</button>
        </div>
        <div class="mm-strategy-row">
          ${[
            { id:'scalp',    label:'⚡ Scalp',    cls:'strat-scalp' },
            { id:'swing',    label:'🌊 Swing',    cls:'' },
            { id:'position', label:'💎 Position', cls:'strat-pos' },
          ].map(s => `
            <button class="mm-strat-pill ${s.cls} ${(mm.strategy||'swing')===s.id?'active':''}"
              data-action="mm-strategy" data-strategy="${s.id}">${s.label}</button>
          `).join('')}
        </div>
        <div style="font-size:9px;color:var(--text-muted);line-height:1.5;margin-top:2px">
          Hold times auto-shorten on active coins, lengthen on quiet ones.
          Partial exits (~35% of sells) leave a residual bag for realism.
        </div>
      </div>

      <!-- Buy size range -->
      <div class="field">
        <div class="field-label">Buy Size (SOL)
          <button class="help-q" data-action="show-help" data-title="Buy Size"
            data-body="Random amount between min and max per buy. Applied with ±8% jitter. Never exceeds 80% of wallet balance.">?</button>
        </div>
        <div class="mm-sol-row">
          <div class="field">
            <div class="field-label">Min</div>
            <input type="number" min="0.01" max="100" step="0.01" placeholder="0.05"
              value="${parseFloat(mm.minSOL||0.05).toFixed(3)}" data-mm-field="minSOL"/>
          </div>
          <div class="field">
            <div class="field-label">Max</div>
            <input type="number" min="0.01" max="100" step="0.05" placeholder="0.25"
              value="${parseFloat(mm.maxSOL||0.25).toFixed(3)}" data-mm-field="maxSOL"/>
          </div>
        </div>
      </div>

      <div class="vb-divider"></div>

      <!-- Wallet mode -->
      <div class="field">
        <div class="field-label">Wallet Mode
          <button class="help-q" data-action="show-help" data-title="Wallet Mode"
            data-body="Use Existing: rotate through saved wallets. Generate New: create fresh wallets funded from a source wallet. Multiple wallets allow staggered buys — while one is holding, others can enter.">?</button>
        </div>
        <div class="mode-toggle">
          <button class="mode-btn ${mm.walletMode==='existing'?'active':''}"
            data-action="mm-mode" data-mode="existing">Use Existing</button>
          <button class="mode-btn ${mm.walletMode==='generate'?'active':''}"
            data-action="mm-mode" data-mode="generate">Generate New</button>
        </div>
      </div>
      ${mm.walletMode==='existing' ? buildMmExisting() : buildMmGenerate()}
    </div>

    ${on ? `
      <div class="vb-running-banner">
        <span>📈 Market Maker running${openPos > 0 ? ` · ${openPos} bag${openPos!==1?'s':''} open` : ''}</span>
        <span class="vb-countdown" id="mm-countdown">…</span>
      </div>` : ''}`;
}

// ── Wallet pickers (reuse VB patterns) ───────
function buildMmExisting() {
  const mm   = mmS();
  const sel  = new Set(mm.selectedWalletIds||[]);
  const open = !!mm._existOpen;
  const all  = S.savedWallets.filter(w => w.publicKey && w.privateKey);
  const grps = S.walletGroups||[];
  const ung  = all.filter(w => !w.groupId);
  const cnt  = sel.size;

  return `
    <div class="cpicker-wrap" style="margin-bottom:14px">
      <div class="cpicker-btn ${cnt>0?'cpicker-selected':''}" data-action="mm-exist-toggle">
        <span style="font-size:11px;font-weight:600;flex:1;color:${cnt>0?'var(--navy)':'var(--text-muted)'}">
          ${cnt>0?`${cnt} wallet${cnt!==1?'s':''} selected`:'Select wallets for rotation…'}
        </span>
        <span class="cpicker-chevron ${open?'open':''}">›</span>
      </div>
      ${open?`
        <div class="cpicker-dropdown cpicker-targets">
          <div class="vb-picker-toolbar">
            <span class="vb-picker-toolbar-left">${cnt?`${cnt} selected`:'None (all eligible)'}</span>
            <div class="vb-picker-toolbar-right">
              <button class="vb-icon-btn" data-action="mm-refresh-bals" title="Refresh balances">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M9.5 5.5A4 4 0 1 1 7 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                  <path d="M7 1v2.2H9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button class="vb-sel-all-btn" data-action="mm-sel-all">
                ${cnt===all.length?'Deselect all':'Select all'}
              </button>
            </div>
          </div>
          ${grps.map(g=>{
            const gw=all.filter(w=>w.groupId===g.id);
            if(!gw.length)return'';
            const allS=gw.every(w=>sel.has(w.id)),somS=gw.some(w=>sel.has(w.id));
            return`<div class="tpicker-group-hdr" data-action="mm-sel-grp" data-gid="${g.id}">
              <div class="tpicker-check ${allS?'checked':somS?'partial':''}"></div>
              <span>${g.emoji||'📁'}</span>
              <span class="tpicker-group-name">${g.name}</span>
              <span class="tpicker-count">${gw.length}</span>
            </div>${gw.map(w=>mmWRow(w,sel)).join('')}`;
          }).join('')}
          ${ung.map(w=>mmWRow(w,sel)).join('')}
          ${all.length===0?`<div class="cpicker-empty">No wallets with private keys.</div>`:''}
          <div class="cpicker-divider"></div>
          <div class="cpicker-paste-label">Or paste private key</div>
          <div style="display:flex;gap:5px;padding:0 8px 8px">
            <input type="password" id="mm-paste-priv" placeholder="Base58 private key…" style="flex:1;font-size:10.5px"/>
            <button class="btn btn-ghost btn-sm" data-action="mm-paste-use">Use</button>
          </div>
        </div>`:``}
    </div>`;
}

function mmWRow(w, sel) {
  const bal = vbGetBal(w.publicKey);
  const low = bal !== null && bal < 0.05;
  const holding = MM.openPositions.some(p => p.wallet.publicKey === w.publicKey);
  return `
    <div class="tpicker-wallet-row ${sel.has(w.id)?'selected':''} ${low?'vb-low-opacity':''}"
      data-action="mm-sel-w" data-wid="${w.id}">
      <div class="tpicker-check ${sel.has(w.id)?'checked':''}"></div>
      <span>${w.emoji||'💼'}</span>
      <div class="tpicker-info">
        <span class="tpicker-name">${w.name||'Wallet'}${holding?' 🟢':''}</span>
        <span class="tpicker-addr">${short(w.publicKey)}</span>
      </div>
      <span class="tpicker-sol ${low?'low':''}">${bal!==null?`${bal.toFixed(2)} SOL`:'—'}</span>
    </div>`;
}

function buildMmGenerate() {
  const mm  = mmS();
  const gen = mm.generatedWallets||[];
  const src = S.savedWallets.find(w => w.id===mm.sourceWalletId);
  const srcBal = src?.publicKey ? vbGetBal(src.publicKey) : null;
  return `
    <div class="vb-gen-panel">
      <div class="vb-gen-inputs">
        <div class="field"><div class="field-label">Wallets</div>
          <input type="number" min="1" max="20" step="1" value="${mm.newWalletCount||5}" data-mm-field="newWalletCount" placeholder="5"/>
        </div>
        <div class="field"><div class="field-label">Total SOL</div>
          <input type="number" min="0.01" step="0.10" value="${parseFloat(mm._fundTotal||1).toFixed(2)}" data-mm-field="_fundTotal" placeholder="1.00"/>
        </div>
      </div>
      <div class="field">
        <div class="field-label">Source Wallet</div>
        <div class="cpicker-wrap">
          <div class="cpicker-btn ${src?'cpicker-selected':''}" data-action="mm-src-tog">
            ${src?`<span>${src.emoji||'💼'}</span>
              <div class="cpicker-row-info" style="flex:1;min-width:0">
                <span class="cpicker-name">${src.name||'Wallet'}</span>
                <span class="cpicker-addr">${short(src.publicKey)}</span>
              </div>
              ${srcBal!==null?`<span class="cpicker-bal">${srcBal.toFixed(4)} SOL</span>`:''}`:
              `<span class="cpicker-name" style="color:var(--text-muted);flex:1">Select source wallet…</span>`}
            <span class="cpicker-chevron ${mm._srcOpen?'open':''}">›</span>
          </div>
          ${mm._srcOpen?`
            <div class="cpicker-dropdown">
              ${S.savedWallets.filter(w=>w.publicKey).map(w=>{
                const b=vbGetBal(w.publicKey);
                return`<div class="cpicker-row ${w.id===mm.sourceWalletId?'active':''}" data-action="mm-src-pick" data-wid="${w.id}">
                  <span>${w.emoji||'💼'}</span>
                  <div class="cpicker-row-info"><span class="cpicker-name">${w.name||'Wallet'}</span><span class="cpicker-addr">${short(w.publicKey)}</span></div>
                  ${b!==null?`<span class="cpicker-bal">${b.toFixed(4)} SOL</span>`:''}
                </div>`;
              }).join('')||'<div class="cpicker-empty">No saved wallets</div>'}
              <div class="cpicker-divider"></div>
              <div style="display:flex;gap:5px;padding:0 8px 8px">
                <input type="password" id="mm-src-paste" placeholder="Base58 private key…" style="flex:1;font-size:10.5px"/>
                <button class="btn btn-ghost btn-sm" data-action="mm-src-paste-use">Use</button>
              </div>
            </div>`:``}
        </div>
      </div>
      <button class="btn btn-primary btn-full" data-action="mm-gen" style="border-radius:var(--r)">+ Generate &amp; Fund Wallets</button>
      ${gen.length?buildMmGenAccordion(gen):''}
    </div>`;
}

function buildMmGenAccordion(gen) {
  const mm=mmS(), isOpen=!!mm._genOpen;
  const totalBal=gen.reduce((s,w)=>{const b=vbGetBal(w.publicKey);return s+(b!==null?b:0);},0);
  return`<div class="vb-gen-accordion">
    <div class="vb-gen-accordion-hdr" data-action="mm-gen-toggle">
      <span class="vb-gen-chevron ${isOpen?'open':''}">›</span>
      <span class="vb-gen-accordion-title">Generated Wallets (${gen.length})</span>
      <span class="vb-gen-accordion-meta">${totalBal.toFixed(4)} SOL total</span>
      <div class="vb-gen-accordion-actions" onclick="event.stopPropagation()">
        <button class="btn btn-secondary btn-sm" data-action="mm-refund-all" style="font-size:9px;padding:2px 7px">↩ All</button>
      </div>
    </div>
    ${isOpen?`<div class="vb-gen-body">${gen.map(w=>{
      const bal=vbGetBal(w.publicKey),balStr=bal!==null?`${bal.toFixed(4)} SOL`:'— SOL';
      const holding=MM.openPositions.some(p=>p.wallet.publicKey===w.publicKey);
      return`<div class="vb-gen-wallet-card">
        <div class="vb-gen-wallet-left">
          <span class="vb-gen-wallet-pub link" data-action="copy" data-copy="${w.publicKey}">${short(w.publicKey)} ⧉${holding?' 🟢':''}</span>
          <span class="vb-gen-wallet-bal-pill ${bal===null?'stale':''}">${balStr}</span>
        </div>
        <div class="vb-gen-wallet-right">
          <button class="vb-copy-key-btn" data-action="mm-copy-key" data-priv="${encodeURIComponent(w.privateKey)}" title="Copy key">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="3.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 3V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          </button>
          <button class="btn btn-danger btn-sm" data-action="mm-del-one" data-wid="${w.id}" style="font-size:11px;padding:3px 7px">✕</button>
        </div>
      </div>`;}).join('')}</div>`:``}
  </div>`;
}

// ── Console tab ───────────────────────────────
function buildMmConsole() {
  const logs=mmS().log||[], today=new Date().toDateString();
  return`<div class="vb-console-toolbar">
    <span class="vb-console-count" id="mm-feed-count">${logs.length} entries</span>
    <button class="btn btn-secondary btn-sm" data-action="mm-clear-log">Clear</button>
  </div>
  <div class="vb-console" id="mm-feed">
    ${logs.length?logs.map(e=>{
      const entryDate=e.fullDate||today;
      const tsDisplay=entryDate!==today?`<span class="vb-log-ts-date">${entryDate.slice(4,10)}</span> ${e.ts}`:e.ts;
      return`<div class="vb-log-entry vb-log-${e.type}"><span class="vb-log-ts">${tsDisplay}</span><span class="vb-log-msg">${mmEsc(e.msg)}</span></div>`;
    }).join(''):`<div class="vb-log-entry vb-log-info"><span class="vb-log-ts">—</span><span class="vb-log-msg" style="color:var(--text-muted)">Start the Market Maker to see activity.</span></div>`}
  </div>`;
}

// ── History tab ───────────────────────────────
function buildMmHistory() {
  const hist=mmS().history||[];
  if(!hist.length)return`<div class="empty-state" style="padding:40px 20px"><div class="empty-icon">📈</div><div class="empty-text">No trades yet.</div></div>`;
  return`<div class="vb-history-toolbar">
    <span class="vb-hist-count">${hist.length} trades</span>
    <button class="btn btn-secondary btn-sm" data-action="mm-clear-hist">Clear</button>
  </div>
  <div class="vb-history-table">
    <div class="mm-hist-hdr"><span>Time</span><span>Wallet</span><span>Act</span><span>SOL</span><span>Tokens</span><span>Fees</span><span>Path</span></div>
    ${hist.map(h=>{
      const t=new Date(h.ts).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      return`<div class="mm-hist-row">
        <span class="vb-hist-time">${t}</span>
        <span class="vb-hist-wallet link" data-action="copy" data-copy="${h.wallet}">${short(h.wallet)}</span>
        <span class="mm-act-${h.action}">${(h.action||'buy').toUpperCase()}</span>
        <span class="vb-hist-sol">${parseFloat(h.solAmt||0).toFixed(4)}</span>
        <span class="vb-hist-sol" style="font-size:8.5px">${h.tokAmt?(h.tokAmt).toLocaleString():'—'}</span>
        <span class="vb-hist-fees">${parseFloat(h.fees||0).toFixed(6)}</span>
        <span class="vb-hist-fees" style="font-size:8.5px">${h.path||'Pump'}</span>
      </div>`;
    }).join('')}
  </div>`;
}

// ── attachMarketMakerHandlers ─────────────────
function attachMarketMakerHandlers() {
  const mm = mmS();
  document.querySelectorAll('[data-mm-field]').forEach(el => {
    el.addEventListener('change', async function() {
      const field=this.dataset.mmField;
      let val=this.value;
      if(this.type==='number') val=val===''?'':(parseFloat(val)||0);
      mmS()[field]=val;
      await saveState();
    });
  });
  if(mm.active && mm.nextIn) mmCd(mm.nextIn, 'Next buy');
  mmStatUpdate();
  mmUpdateMigBadge();
  if(Date.now()-(mm._lastBalFetch||0)>60_000){
    mm._lastBalFetch=Date.now();
    mmRefreshAllBals();
  }
}

// ── handleMarketMakerAction ───────────────────
async function handleMarketMakerAction(a, el) {
  const mm = mmS();
  if(a==='mm-tab'){mm._tab=el.dataset.tab;await saveState();render();return;}
  if(a==='mm-start'){await mmStart();return;}
  if(a==='mm-stop'){await mmStop();return;}
  if(a==='mm-strategy'){mm.strategy=el.dataset.strategy;await saveState();render();return;}
  if(a==='mm-mode'){mm.walletMode=el.dataset.mode;await saveState();render();return;}
  if(a==='mm-exist-toggle'){mm._existOpen=!mm._existOpen;await saveState();render();return;}
  if(a==='mm-sel-w'){
    const id=el.dataset.wid,ids=mm.selectedWalletIds=mm.selectedWalletIds||[];
    const i=ids.indexOf(id);i>-1?ids.splice(i,1):ids.push(id);
    await saveState();render();return;
  }
  if(a==='mm-sel-all'){
    const all=S.savedWallets.filter(w=>w.publicKey&&w.privateKey);
    mm.selectedWalletIds=mm.selectedWalletIds?.length===all.length?[]:all.map(w=>w.id);
    await saveState();render();return;
  }
  if(a==='mm-sel-grp'){
    const gid=el.dataset.gid,gw=S.savedWallets.filter(w=>w.groupId===gid&&w.publicKey&&w.privateKey);
    const ids=mm.selectedWalletIds=mm.selectedWalletIds||[];
    const allS=gw.every(w=>ids.includes(w.id));
    if(allS)gw.forEach(w=>{const i=ids.indexOf(w.id);if(i>-1)ids.splice(i,1);});
    else gw.forEach(w=>{if(!ids.includes(w.id))ids.push(w.id);});
    await saveState();render();return;
  }
  if(a==='mm-paste-use'){
    const raw=document.getElementById('mm-paste-priv')?.value?.trim();
    if(!raw)return;
    try{
      const kp=vbKp(raw),pub=bs58encode(kp.pub);
      let sw=S.savedWallets.find(w=>w.publicKey===pub);
      if(!sw){sw={id:uid(),name:'Pasted Wallet',emoji:'💼',publicKey:pub,privateKey:raw,groupId:null};S.savedWallets.push(sw);}
      mm.selectedWalletIds=[...(mm.selectedWalletIds||[])];
      if(!mm.selectedWalletIds.includes(sw.id))mm.selectedWalletIds.push(sw.id);
      vbFetchBal(pub).then(()=>render());
      await saveState();render();
    }catch{showToast('Invalid private key');}
    return;
  }
  if(a==='mm-copy-key'){const priv=decodeURIComponent(el.dataset.priv||'');if(priv)copyText(priv);return;}
  if(a==='mm-refresh-bals'){await mmRefreshAllBals();return;}
  if(a==='mm-src-tog'){mm._srcOpen=!mm._srcOpen;await saveState();render();return;}
  if(a==='mm-src-pick'){mm.sourceWalletId=el.dataset.wid;mm._srcOpen=false;const src=S.savedWallets.find(w=>w.id===mm.sourceWalletId);if(src?.publicKey)vbFetchBal(src.publicKey).then(()=>render());await saveState();render();return;}
  if(a==='mm-src-paste-use'){
    const raw=document.getElementById('mm-src-paste')?.value?.trim();
    if(!raw)return;
    try{const kp=vbKp(raw),pub=bs58encode(kp.pub);let sw=S.savedWallets.find(w=>w.publicKey===pub);if(!sw){sw={id:uid(),name:'Pasted Source',emoji:'💼',publicKey:pub,privateKey:raw,groupId:null};S.savedWallets.push(sw);}mm.sourceWalletId=sw.id;mm._srcOpen=false;vbFetchBal(pub).then(()=>render());await saveState();render();}catch{showToast('Invalid private key');}
    return;
  }
  if(a==='mm-gen-toggle'){mm._genOpen=!mm._genOpen;await saveState();render();return;}
  if(a==='mm-gen'){
    const nEl=document.querySelector('[data-mm-field="newWalletCount"]');
    const tEl=document.querySelector('[data-mm-field="_fundTotal"]');
    if(nEl?.value)mm.newWalletCount=parseInt(nEl.value)||5;
    if(tEl?.value)mm._fundTotal=parseFloat(tEl.value)||1.0;
    await saveState();await mmGenFund();return;
  }
  if(a==='mm-del-one'){
    const id=el.dataset.wid,w=mm.generatedWallets?.find(x=>x.id===id);
    if(!w)return;
    const src=S.savedWallets.find(x=>x.id===mm.sourceWalletId);
    if(src?.publicKey&&w.privateKey){const bal=await vbFetchBal(w.publicKey)??0;if(bal>0.000_010){try{await vbSendSol(w,src.publicKey,bal-0.000_010);showToast(`✓ Refunded ${bal.toFixed(4)} SOL`);}catch(e){showToast(`Deleted (refund failed)`);}}}
    mm.generatedWallets=mm.generatedWallets.filter(x=>x.id!==id);
    await saveState();render();return;
  }
  if(a==='mm-refund-all'){await mmRefundAll();render();return;}
  if(a==='mm-clear-log'){mm.log=[];await saveState();render();return;}
  if(a==='mm-clear-hist'){mm.history=[];await saveState();render();return;}
}