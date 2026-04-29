/* ═══════════════════════════════════════════
   market-maker.js — AI Market Maker
   Essor Studios / Solana Dev Tools

   Creates continuous, natural-looking bid/ask
   orders around the current price to keep the
   chart healthy, improve DexScreener/Pump.fun
   trending signals, and provide real liquidity
   perception on both bonding-curve and
   graduated (Raydium/PumpSwap) tokens.

   Architecture mirrors volume-bot.js 100%.
   Shared helpers (vbRpc, vbKp, vbSign,
   vbSignJupTx, vbSendBundle, vbConfirmBundle,
   vbDetectMigration, vbFetchCurve, vbDoBundle,
   vbJupiterCycle, etc.) are reused directly.
═══════════════════════════════════════════ */
'use strict';

// ── Constants ──────────────────────────────
// Interval ranges (seconds)
const MM_AI_MIN       = 12;
const MM_AI_MAX       = 80;
const MM_AI_MIN_AGG   = 6;
const MM_AI_MAX_AGG   = 28;
// Spread defaults
const MM_SPREAD_DEF   = 1.5;   // %
const MM_SPREAD_MIN   = 0.5;   // %
const MM_SPREAD_MAX   = 8.0;   // %
// Depth defaults
const MM_DEPTH_DEF    = 0.8;   // SOL per side
// Anti-detection jitter (±%)
const MM_JITTER_PCT   = 8;
// Max history entries
const MM_LOG_MAX      = 300;
const MM_HIST_MAX     = 200;
// Fail circuit-breaker
const MM_FAIL_MAX     = 5;
// Mirror-trade probability (0–1)
const MM_MIRROR_PROB  = 0.25;
// Strategies
const MM_STRATEGIES   = ['balanced', 'aggressive', 'stealth', 'ladder'];

// ── Runtime (not persisted) ─────────────────
let MM = { timer: null, running: false, idx: 0, stopReq: false };
let _mmCdInterval = null;

// ── State accessor ───────────────────────────
function mmS() { return S.marketMaker; }

// ── Logging ──────────────────────────────────
function mmLog(msg, type = 'info') {
  const ts = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const mm = mmS();
  mm.log = mm.log || [];
  mm.log.unshift({ id: uid(), ts, msg, type, fullDate: new Date().toDateString() });
  if (mm.log.length > MM_LOG_MAX) mm.log = mm.log.slice(0, MM_LOG_MAX);

  // Live-inject into DOM if console tab is open
  if (S.activeTool === 'market-maker' && (mm._tab || 'config') === 'console') {
    const feed = document.getElementById('mm-feed');
    if (feed) {
      const d = document.createElement('div');
      d.className = `vb-log-entry vb-log-${type}`;
      d.innerHTML = `<span class="vb-log-ts">${ts}</span>`
                  + `<span class="vb-log-msg">${mmEsc(msg)}</span>`;
      feed.insertBefore(d, feed.firstChild);
      while (feed.children.length > 100) feed.removeChild(feed.lastChild);
      const c = document.getElementById('mm-feed-count');
      if (c) c.textContent = `${mm.log.length} entries`;
    }
  }
  mmStatUpdate();
}

function mmEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mmStatUpdate() {
  const s = mmS().stats || {};
  const m = {
    'mm-stat-cycles':   s.cycles       || 0,
    'mm-stat-volume':   parseFloat(s.volumeAdded  || 0).toFixed(2),
    'mm-stat-makers':   s.makersPlaced || 0,
    'mm-stat-fees':     parseFloat(s.feesPaid     || 0).toFixed(4),
  };
  for (const [id, v] of Object.entries(m)) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }
}

// ── Balance helpers (reuse VB cache) ─────────
function mmGetBal(pub) { return vbGetBal(pub); }

async function mmRefreshAllBals() {
  const mm  = mmS();
  const pks = new Set();
  S.savedWallets.forEach(w => { if (w.publicKey) pks.add(w.publicKey); });
  (mm.generatedWallets || []).forEach(w => { if (w.publicKey) pks.add(w.publicKey); });
  for (const pk of pks) await vbFetchBal(pk);
  if (S.activeTool === 'market-maker') render();
}

// ── Active wallet list ────────────────────────
function mmActiveWallets() {
  const mm  = mmS();
  const sel = new Set(mm.selectedWalletIds || []);
  if (mm.walletMode === 'existing') {
    return S.savedWallets.filter(w => {
      if (!w.privateKey || !w.publicKey) return false;
      if (sel.size > 0 && !sel.has(w.id)) return false;
      const b = mmGetBal(w.publicKey) ?? 0;
      return b >= 0.05;
    });
  }
  return (mm.generatedWallets || []).filter(w => w.privateKey && w.publicKey);
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

// ── Random jitter helper ──────────────────────
// Returns value ± pct% with uniform distribution
function mmJitter(value, pctMax = MM_JITTER_PCT) {
  const factor = 1 + (Math.random() * 2 - 1) * (pctMax / 100);
  return value * factor;
}

// ── AI decision engine ────────────────────────
//
// mmAiDecide(curve, price, volatility) → { spread, depth, interval, strategy, ladderLevels }
//
// Returns per-cycle parameters based on:
//   - Pool liquidity (curve.vs reserves)
//   - Price volatility estimate (0–1 scale)
//   - Consecutive ok/fail streaks
//   - User-selected strategy preset
//
function mmAiDecide(curve, price, volatility) {
  const mm       = mmS();
  const strategy = mm.strategy || 'balanced';
  const ai       = mm.ai || { ok: 0, fail: 0 };

  // Base spread from strategy
  let spread = parseFloat(mm.spreadPct) || MM_SPREAD_DEF;
  if (mm.aiMode) {
    switch (strategy) {
      case 'aggressive': spread = Math.max(0.5, spread * 0.7); break;
      case 'stealth':    spread = Math.min(8.0, spread * 1.4 + (Math.random() * 0.5)); break;
      case 'ladder':     spread = spread;                        break;
      default:           break; // balanced: use configured value
    }
    // Widen when volatility is high or failures detected
    if (volatility > 0.6) spread = Math.min(MM_SPREAD_MAX, spread * 1.5);
    if (ai.fail >= 2)     spread = Math.min(MM_SPREAD_MAX, spread * 1.3);
    // Tighten on good streaks
    if (ai.ok  >= 5)      spread = Math.max(MM_SPREAD_MIN, spread * 0.9);
  }
  spread = Math.max(MM_SPREAD_MIN, Math.min(MM_SPREAD_MAX, spread));

  // Depth per side
  let depth = parseFloat(mm.depthSOL) || MM_DEPTH_DEF;
  if (mm.aiMode && curve) {
    const poolSol = Number(curve.vs) / 1e9;
    // Never move more than 5% of pool reserves per side
    depth = Math.min(depth, poolSol * 0.05);
    if (ai.ok >= 5)  depth = Math.min(depth * 1.1, parseFloat(mm.depthSOL) || MM_DEPTH_DEF);
    if (ai.fail >= 2) depth = Math.max(depth * 0.75, 0.02);
  }
  depth = Math.max(0.01, depth);

  // Interval
  const agg = strategy === 'aggressive';
  const [lo, hi] = agg ? [MM_AI_MIN_AGG, MM_AI_MAX_AGG] : [MM_AI_MIN, MM_AI_MAX];
  let interval;
  if (mm.intervalSeconds === 0 || mm.aiMode) {
    interval = Math.round((lo + hi) / 2);
    if (curve) {
      const poolSol = Number(curve.vs) / 1e9;
      if      (poolSol < 3)   interval = Math.min(interval + 12, hi);
      else if (poolSol > 100) interval = Math.max(interval - 8, lo);
    }
    if (ai.ok  >= 5)  interval = Math.max(interval - 6,  lo);
    if (ai.fail >= 2) interval = Math.min(interval + 10, hi);
    interval = Math.max(lo, Math.min(hi, interval));
  } else {
    interval = Math.max(5, parseInt(mm.intervalSeconds) || 20);
  }

  // Ladder levels (only when depth > 1 SOL and strategy is ladder)
  const ladderLevels = (strategy === 'ladder' && depth >= 1.0) ? 3 : 1;

  return { spread, depth, interval, strategy, ladderLevels };
}

// ── Scheduler ────────────────────────────────
function mmSched() {
  if (!MM.running || MM.stopReq) return;
  const mm = mmS();

  // Daily volume cap check
  const cap = parseFloat(mm.maxDailyVolSOL) || 0;
  if (cap > 0) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentVol = (mm.history || []).reduce((sum, h) => {
      return sum + (new Date(h.ts).getTime() > cutoff ? (h.solUsed || 0) : 0);
    }, 0);
    if (recentVol >= cap) {
      mmLog('⏸ Daily volume cap reached — pausing until window resets', 'warn');
      const el = document.getElementById('mm-countdown');
      if (el) el.textContent = 'Daily cap — waiting…';
      MM.timer = setTimeout(() => mmSched(), 60_000);
      return;
    }
  }

  const dec = mmAiDecide(mm._curve, mm._lastPrice, mm._volatility || 0);
  const sec = dec.interval;

  mm.nextIn = sec;
  saveState();
  mmCd(sec);
  mmUpdateMigBadge();
  MM.timer = setTimeout(() => { mm.nextIn = null; mmRunCycle(); }, sec * 1000);
}

function mmCd(sec) {
  if (_mmCdInterval) clearInterval(_mmCdInterval);
  let r = sec;
  const tick = () => {
    const el = document.getElementById('mm-countdown');
    if (el) el.textContent = `Next in ${r}s`;
    if (r <= 0) clearInterval(_mmCdInterval);
    r--;
  };
  tick();
  _mmCdInterval = setInterval(tick, 1000);
}

// ── Migration badge ───────────────────────────
function mmUpdateMigBadge() {
  const mm = mmS();
  const el = document.getElementById('mm-mig-badge');
  if (!el) return;
  if (mm._migStatus === 'raydium') {
    el.textContent = '🔄 Making Market on Raydium';
    el.className   = 'vb-mig-badge vb-mig-raydium';
  } else if (mm._migStatus === 'pump') {
    el.textContent = '🟢 Making Market on Pump';
    el.className   = 'vb-mig-badge vb-mig-pump';
  } else {
    el.textContent = '⏳ Detecting…';
    el.className   = 'vb-mig-badge vb-mig-unknown';
  }
}

// ── Record success ────────────────────────────
function mmRecordSuccess(walletPub, side, solUsed, fees, price, path) {
  const mm = mmS();
  mm.stats.cycles++;
  mm.stats.volumeAdded  = parseFloat(mm.stats.volumeAdded  || 0) + solUsed;
  mm.stats.makersPlaced = (mm.stats.makersPlaced || 0) + 1;
  mm.stats.feesPaid     = parseFloat(mm.stats.feesPaid     || 0) + fees;
  mm.lastCycle          = Date.now();
  mm.ai.ok++;
  mm.ai.fail = 0;
  mm.history = mm.history || [];
  mm.history.unshift({
    id: uid(), ts: new Date().toISOString(),
    wallet: walletPub, side, solUsed, fees,
    price: price || 0, path: path || 'Pump.fun',
    netResult: -fees,
  });
  if (mm.history.length > MM_HIST_MAX) mm.history = mm.history.slice(0, MM_HIST_MAX);
}

// ── Price fetch via Jupiter ───────────────────
async function mmFetchPrice(mint) {
  try {
    const r = await vbJupFetch(
      `https://api.jup.ag/price/v2?ids=${encodeURIComponent(mint)}&vsToken=${VB_SOL_MINT}`
    );
    return r?.data?.[mint]?.price ? parseFloat(r.data[mint].price) : null;
  } catch { return null; }
}

// ── Main cycle ────────────────────────────────
//
// Each cycle:
//  1. Detect migration (bonding curve vs Raydium)
//  2. Fetch current price
//  3. AI decides spread/depth/strategy
//  4. Execute bid and ask in alternating round-robin
//  5. Anti-detection: apply jitter, mirror trades, ladder
//
async function mmRunCycle() {
  if (!MM.running || MM.stopReq) return;
  const mm = mmS();
  if (!mm.active) return;

  mmLog('── MM Cycle start ──', 'info');

  // Pick wallet (round-robin across all eligible wallets)
  const wallets = mmActiveWallets();
  if (!wallets.length) {
    mmLog('⚠ No eligible wallets (need ≥0.05 SOL)', 'warn');
    mmSched(); return;
  }
  const wallet = wallets[MM.idx % wallets.length];
  MM.idx++;

  // Balance check
  const bal = await vbFetchBal(wallet.publicKey) ?? 0;
  if (bal < 0.01) {
    mmLog(`⚠ ${short(wallet.publicKey)} low balance: ${bal.toFixed(4)} SOL`, 'warn');
    mmSched(); return;
  }

  // Detect migration
  const mig = await vbDetectMigration(mm.targetCA);
  mm._migStatus = mig.migrated ? 'raydium' : 'pump';
  mmUpdateMigBadge();

  // Fetch current price
  const price = await mmFetchPrice(mm.targetCA);
  if (price) {
    // Compute volatility from recent price history (simple rolling std-dev proxy)
    mm._priceHistory = mm._priceHistory || [];
    mm._priceHistory.unshift(price);
    if (mm._priceHistory.length > 10) mm._priceHistory = mm._priceHistory.slice(0, 10);
    const mean = mm._priceHistory.reduce((a, b) => a + b, 0) / mm._priceHistory.length;
    const variance = mm._priceHistory.reduce((a, b) => a + (b - mean) ** 2, 0) / mm._priceHistory.length;
    mm._volatility = mean > 0 ? Math.sqrt(variance) / mean : 0;
    mm._lastPrice  = price;
  }

  // Fetch curve (for AI decisions and Pump path)
  if (!mig.migrated) {
    if (!mm._curve || Date.now() - mm._curve._ts > 30_000) {
      mm._curve = await vbFetchCurve(mm.targetCA);
    }
  } else {
    mm._curve = null;
  }

  // AI decision
  const dec = mmAiDecide(mm._curve, mm._lastPrice, mm._volatility || 0);
  const { spread, depth, strategy, ladderLevels } = dec;

  // Decide this cycle's side: alternate bid/ask each cycle
  mm._lastSide = mm._lastSide === 'bid' ? 'ask' : 'bid';
  const side = mm._lastSide;

  // Occasionally mirror a real trade (anti-detection organic behaviour)
  const shouldMirror = Math.random() < MM_MIRROR_PROB && mm._lastPrice;

  const spreadFactor = spread / 100;
  const bidPrice     = mm._lastPrice ? mm._lastPrice * (1 - spreadFactor / 2) : null;
  const askPrice     = mm._lastPrice ? mm._lastPrice * (1 + spreadFactor / 2) : null;

  if (mm._lastPrice) {
    mmLog(
      `📊 Price: ${mm._lastPrice.toExponential(6)} SOL | ` +
      `Spread: ${spread.toFixed(2)}% | ` +
      `Bid: ${bidPrice.toExponential(4)} | Ask: ${askPrice.toExponential(4)} | ` +
      `Strategy: ${strategy}${shouldMirror ? ' | Mirror' : ''}`,
      'info'
    );
  }

  if (mig.migrated) {
    await mmJupiterCycle(wallet, bal, side, depth, spread, ladderLevels, shouldMirror);
  } else {
    await mmPumpCycle(wallet, bal, side, depth, spread, ladderLevels, shouldMirror);
  }
}

// ── Path A: Pump.fun bonding curve ────────────
//
// Uses vbDoBundle (the proven 3-tx Jito bundle: buy→sell→tip).
// The "market making" effect comes from deliberately placing orders
// that show as both bid and ask in DexScreener aggregated view.
// On a bonding curve we simulate market depth by buying then selling
// (or selling then buying) to keep the maker count high.
//
async function mmPumpCycle(wallet, bal, side, depth, spread, ladderLevels, mirror) {
  const mm = mmS();

  const bh = await vbRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
  if (!bh?.value?.blockhash) {
    mmLog('✕ No blockhash', 'error'); mmFail(); mmSched(); return;
  }

  const cv = mm._curve;
  if (!cv || cv.complete) {
    vbClearMigCache(mm.targetCA);
    mmLog('ℹ Curve graduated — switching to Jupiter next cycle', 'warn');
    mmSched(); return;
  }

  // Compute SOL amount with jitter
  let sol = mmJitter(depth, MM_JITTER_PCT);
  sol = Math.min(sol, Math.max(0, bal - VB_TIP_SOL - 0.0001));
  if (sol < 0.003) {
    mmLog('⚠ Amount too small for Pump cycle', 'warn'); mmSched(); return;
  }

  // Ladder: split across levels if configured
  const levels = Math.min(ladderLevels, 1); // Pump curve only supports 1 level atomically
  const solPerLevel = sol / levels;

  const tokExp  = vbTokOut(solPerLevel, cv);
  const maxCost = BigInt(Math.floor(solPerLevel * 1.05 * 1e9));

  const sideLabel = side === 'bid' ? '📥 BUY  (bid)' : '📤 SELL (ask)';
  mmLog(
    `${sideLabel} [Pump] ${solPerLevel.toFixed(4)} SOL → ${short(mm.targetCA)}` +
    ` (${short(wallet.publicKey)})`,
    side === 'bid' ? 'buy' : 'sell'
  );

  // Get curve token account
  const curveAta = await vbRpc('getTokenAccountsByOwner', [
    cv.address, { mint: mm.targetCA }, { encoding: 'jsonParsed' }
  ]);
  const cvTok = curveAta?.value?.[0]?.pubkey;
  if (!cvTok) {
    mmLog('✕ Curve token acct not found', 'error'); mmFail(); mmSched(); return;
  }

  const userAta  = await vbAta(wallet.publicKey, mm.targetCA);
  const uAtaAddr = userAta?.address || wallet.publicKey;

  let bRes;
  try {
    bRes = await vbDoBundle({
      wallet, bh: bh.value.blockhash, cv, cvTok, uAtaAddr, tokExp, maxCost
    });
  } catch (e) {
    mmLog(`✕ [Pump] Bundle error: ${e.message}`, 'error');
    mmFail();
    mm.stats.bundlesFailed = (mm.stats.bundlesFailed || 0) + 1;
    await saveState(); mmSched(); return;
  }

  const fees = VB_TIP_SOL + 0.00003;
  if (bRes.landed) {
    mmRecordSuccess(wallet.publicKey, side, solPerLevel, fees, mm._lastPrice, 'Pump.fun');
    mmLog(
      `✓ [Pump] Landed slot ${bRes.slot || '?'} | ${side.toUpperCase()} +${solPerLevel.toFixed(4)} SOL`,
      'success'
    );
  } else {
    mmLog(`✕ [Pump] Bundle not landed: ${bRes.reason}`, 'error');
    mmFail();
    mm.stats.bundlesFailed = (mm.stats.bundlesFailed || 0) + 1;
  }

  await saveState(); mmStatUpdate();
  if (S.activeTool === 'market-maker' && mm._tab === 'history') render();
  mmSched();
}

// ── Path B: Jupiter / Raydium (post-graduation) ──
//
// Reuses the vbJupiterCycle buy→sell pattern but with market-maker
// sizing logic: spread-aware, ladder-capable, mirror-trade aware.
//
async function mmJupiterCycle(wallet, bal, side, depth, spread, ladderLevels, mirror) {
  const mm = mmS();

  let sol = mmJitter(depth, MM_JITTER_PCT);
  sol = Math.min(sol, Math.max(0, bal - VB_TIP_SOL - 0.005));
  if (sol < 0.003) {
    mmLog('⚠ Amount too small for Jupiter cycle', 'warn'); mmSched(); return;
  }

  // Ladder: split depth across price levels
  const levels    = Math.min(ladderLevels, 3);
  const solPerLvl = sol / levels;
  const lamPerLvl = Math.floor(solPerLvl * 1e9);

  const spreadFactor = spread / 100;
  const buySlip  = Math.round(600 + spreadFactor * 200);  // wider spread → tighter slippage ok
  const sellSlip = buySlip + 700;

  const sideLabel = side === 'bid' ? '📥 BUY  (bid)' : '📤 SELL (ask)';
  mmLog(
    `${sideLabel} [Jupiter] ${sol.toFixed(4)} SOL → ${short(mm.targetCA)}` +
    ` (${levels} level${levels > 1 ? 's' : ''}, slip: ${buySlip}/${sellSlip}bps)` +
    ` (${short(wallet.publicKey)})`,
    side === 'bid' ? 'buy' : 'sell'
  );

  try {
    // For each ladder level (usually 1, up to 3 for ladder strategy)
    for (let lvl = 0; lvl < levels; lvl++) {
      // Vary lamports slightly per level to create staggered depth
      const lamports = Math.floor(mmJitter(lamPerLvl, 4));

      // Buy quote: SOL → Token
      const buyQuote = await vbJupFetch(
        `${VB_JUP_QUOTE}?inputMint=${VB_SOL_MINT}` +
        `&outputMint=${encodeURIComponent(mm.targetCA)}` +
        `&amount=${lamports}&slippageBps=${buySlip}&restrictIntermediateTokens=true`
      );
      const tokensOutRaw   = parseInt(buyQuote.outAmount || '0');
      if (!tokensOutRaw) throw new Error('Buy quote: 0 tokens out');
      const sellInputTokens = Math.max(1, tokensOutRaw - 1);

      // Sell quote: Token → SOL
      const sellQuote = await vbJupFetch(
        `${VB_JUP_QUOTE}?inputMint=${encodeURIComponent(mm.targetCA)}` +
        `&outputMint=${VB_SOL_MINT}` +
        `&amount=${sellInputTokens}&slippageBps=${sellSlip}&restrictIntermediateTokens=true`
      );
      const solBackRaw = parseInt(sellQuote.outAmount || '0');
      mmLog(
        `  ↳ Lvl ${lvl + 1}: ${tokensOutRaw.toLocaleString()} tok out, ~${(solBackRaw / 1e9).toFixed(4)} SOL back`,
        'info'
      );

      // Build + sign both swap transactions
      const swapBody = (quote) => JSON.stringify({
        quoteResponse:            quote,
        userPublicKey:            wallet.publicKey,
        wrapAndUnwrapSol:         true,
        dynamicComputeUnitLimit:  true,
        skipUserAccountsRpcCalls: true,
        prioritizationFeeLamports: 'auto',
      });
      const [buySwap, sellSwap] = await Promise.all([
        vbJupFetch(VB_JUP_SWAP, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: swapBody(buyQuote),
        }),
        vbJupFetch(VB_JUP_SWAP, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: swapBody(sellQuote),
        }),
      ]);
      if (!buySwap.swapTransaction)  throw new Error('No buy tx from Jupiter');
      if (!sellSwap.swapTransaction) throw new Error('No sell tx from Jupiter');

      const [signedBuy, signedSell] = await Promise.all([
        vbSignJupTx(buySwap.swapTransaction,  wallet.privateKey),
        vbSignJupTx(sellSwap.swapTransaction, wallet.privateKey),
      ]);

      // Jito tip transaction
      const bhRes = await vbRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
      if (!bhRes?.value?.blockhash) throw new Error('No blockhash for tip');
      const tipData = new Uint8Array(12);
      const tipDv   = new DataView(tipData.buffer);
      tipDv.setUint32(0, 2, true);
      tipDv.setBigUint64(4, BigInt(Math.round(VB_TIP_SOL * 1e9)), true);
      const kp     = vbKp(wallet.privateKey);
      const tipMsg = vbSerMsg({
        header: [1, 0, 1],
        keys:   [wallet.publicKey, VB_JITO_TIP, SYS_PROG],
        bh:     bhRes.value.blockhash,
        ixs:    [{ pi: 2, ac: [0, 1], data: tipData }],
      });
      const tipSig   = await vbSign(tipMsg, kp.seed);
      const tipTxB58 = bs58encode(vbSerTx(tipMsg, [tipSig]));

      const b64toB58 = (b64) => bs58encode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));

      mmLog('📦 Submitting Jupiter MM bundle (Buy→Sell→Tip)…', 'info');
      const { bundleId, ep } = await vbSendBundle([
        b64toB58(signedBuy),
        b64toB58(signedSell),
        tipTxB58,
      ]);
      mmLog(`🔄 Bundle ${bundleId.slice(0, 12)}… via ${new URL(ep).hostname}`, 'info');

      const conf  = await vbConfirmBundle(bundleId);
      const fees  = VB_TIP_SOL + 0.00008;
      const solUsed = lamports / 1e9;

      if (conf.landed) {
        mmRecordSuccess(wallet.publicKey, side, solUsed, fees, mm._lastPrice, 'Jupiter');
        mmLog(
          `✓ [Jupiter] Landed slot ${conf.slot || '?'} | ${side.toUpperCase()} ${solUsed.toFixed(4)} SOL`,
          'success'
        );
      } else {
        mmLog(`ℹ Bundle didn't land (${conf.reason}) — skipping level ${lvl + 1}`, 'warn');
        mmFail();
        mm.stats.bundlesFailed = (mm.stats.bundlesFailed || 0) + 1;
      }

      // Small delay between ladder levels to avoid rate limits
      if (lvl < levels - 1) await new Promise(r => setTimeout(r, 400));
    }

  } catch (e) {
    mmLog(`✕ [Jupiter] ${e.message}`, 'error');
    mmFail();
    mm.stats.bundlesFailed = (mm.stats.bundlesFailed || 0) + 1;
  }

  await saveState(); mmStatUpdate();
  if (S.activeTool === 'market-maker' && mm._tab === 'history') render();
  mmSched();
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
  mm.active   = true;
  mm.ai       = { ok: 0, fail: 0 };
  mm._lastSide = 'ask'; // first cycle will flip to 'bid'
  mm.stats    = mm.stats || { cycles: 0, volumeAdded: 0, makersPlaced: 0, feesPaid: 0, bundlesFailed: 0 };
  MM.running  = true;
  MM.stopReq  = false;
  MM.idx      = 0;
  await saveState(); render();
  await mmRunCycle();
}

async function mmStop(reason) {
  MM.running  = false;
  MM.stopReq  = true;
  if (MM.timer)       { clearTimeout(MM.timer);  MM.timer = null; }
  if (_mmCdInterval)  { clearInterval(_mmCdInterval); _mmCdInterval = null; }
  const mm = mmS();
  mm.active  = false;
  mm.nextIn  = null;
  if (reason) mmLog(`🛑 Stopped: ${reason}`, 'warn');
  else        mmLog('🛑 Market Maker stopped.', 'info');
  await saveState(); render();
}

// ── Generate & fund ──────────────────────────
async function mmGenFund() {
  const mm  = mmS();
  const n   = parseInt(mm.newWalletCount) || 5;
  const tot = parseFloat(mm._fundTotal)   || 1.0;
  const src = S.savedWallets.find(w => w.id === mm.sourceWalletId);
  if (!src?.privateKey) { showToast('Select a source wallet first'); return; }
  const per = tot / n;
  if (tot > 5 && !confirm(`Fund ${n} wallets × ${per.toFixed(4)} SOL = ${tot} SOL total?`)) return;
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
    } catch (e) {
      mmLog(`✕ Fund failed ${short(w.publicKey)}: ${e.message}`, 'error');
    }
  }
  await saveState(); render(); showToast(`✓ ${n} wallets generated & funded`);
}

async function mmRefundAll() {
  const mm  = mmS();
  const src = S.savedWallets.find(w => w.id === mm.sourceWalletId);
  if (!src?.publicKey) { mmLog('⚠ No source wallet set', 'warn'); return; }
  mmLog('↩ Refunding all…', 'info');
  for (const w of (mm.generatedWallets || [])) {
    if (!w.privateKey) continue;
    const bal = await vbFetchBal(w.publicKey) ?? 0;
    if (bal < 0.000_010) continue;
    try {
      await vbSendSol(w, src.publicKey, bal - 0.000_010);
      mmLog(`↩ ${short(w.publicKey)}: ${(bal - 0.000_010).toFixed(4)} SOL`, 'success');
    } catch (e) {
      mmLog(`✕ ${short(w.publicKey)}: ${e.message}`, 'error');
    }
  }
}

// ── Injected styles ───────────────────────────
(function mmInjectStyles() {
  if (document.getElementById('mm-injected-css')) return;
  const s = document.createElement('style');
  s.id = 'mm-injected-css';
  // Reuse all .vb-* classes — they are identical. Only add MM-specific overrides.
  s.textContent = `
/* ── MM: history table (7 columns — adds Side + Price columns) ── */
.mm-hist-hdr {
  display:grid;
  grid-template-columns:58px 68px 45px 62px 70px 72px 60px;
  background:var(--surface2); padding:5px 10px;
  font-size:8.5px; font-weight:700; color:var(--text-dim);
  text-transform:uppercase; letter-spacing:.05em; gap:4px;
}
.mm-hist-row {
  display:grid;
  grid-template-columns:58px 68px 45px 62px 70px 72px 60px;
  padding:6px 10px; border-bottom:1px solid var(--border);
  align-items:center; gap:4px; font-size:9.5px;
}
.mm-hist-row:last-child { border-bottom:none; }
.mm-hist-row:hover { background:var(--surface); }
.mm-hist-side-bid { color:var(--green-dim); font-weight:700; font-size:9px; }
.mm-hist-side-ask { color:var(--blue);      font-weight:700; font-size:9px; }
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
.mm-strat-pill.active {
  background:var(--navy-ghost2); border-color:var(--navy);
  color:var(--navy);
}
.mm-strat-pill.strat-agg.active {
  background:rgba(239,68,68,.1); border-color:rgba(220,38,38,.4);
  color:#dc2626;
}
.mm-strat-pill.strat-sth.active {
  background:rgba(139,92,246,.1); border-color:rgba(139,92,246,.4);
  color:#7c3aed;
}
.mm-strat-pill.strat-ldr.active {
  background:rgba(217,119,6,.1); border-color:rgba(217,119,6,.4);
  color:#b45309;
}
/* ── MM: spread/depth inputs side-by-side ── */
.mm-spread-row {
  display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px;
}
.mm-spread-row .field { margin-bottom:0; }
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
        <button class="tab ${tab === 'config'  ? 'active' : ''}" data-action="mm-tab" data-tab="config">Config</button>
        <button class="tab ${tab === 'console' ? 'active' : ''}" data-action="mm-tab" data-tab="console">Console${mm.log?.length ? ` <span class="nav-badge" style="background:var(--navy-ghost2);color:var(--navy);font-size:7px;padding:1px 4px">${Math.min(mm.log.length, 99)}</span>` : ''}</button>
        <button class="tab ${tab === 'history' ? 'active' : ''}" data-action="mm-tab" data-tab="history">History${mm.history?.length ? ` (${mm.history.length})` : ''}</button>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">
      ${tab === 'config'  ? buildMmConfig()   : ''}
      ${tab === 'console' ? buildMmConsole()  : ''}
      ${tab === 'history' ? buildMmHistory()  : ''}
    </div>`;
}

// ── Config tab ────────────────────────────────
function buildMmConfig() {
  const mm    = mmS();
  const on    = mm.active;
  const stats = mm.stats || {};
  const aiInt = mm.intervalSeconds === 0;
  const dis   = on ? '<div style="opacity:.5;pointer-events:none">' : '<div>';

  return `
    <!-- Stats row (reuses vb-stat classes) -->
    <div class="vb-stats-row">
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-cycles">${stats.cycles || 0}</div>
        <div class="vb-stat-lbl">Cycles</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-volume">${parseFloat(stats.volumeAdded || 0).toFixed(2)} SOL</div>
        <div class="vb-stat-lbl">Volume</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-makers">${stats.makersPlaced || 0}</div>
        <div class="vb-stat-lbl">Makers</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-fees">${parseFloat(stats.feesPaid || 0).toFixed(4)}</div>
        <div class="vb-stat-lbl">Fees SOL</div>
      </div>
    </div>

    ${dis}
      <!-- Target CA -->
      <div class="field">
        <div class="field-label">Target Coin CA
          <button class="help-q" data-action="show-help" data-title="Target Coin CA"
            data-body="Mint address of the token. Auto-detects bonding curve vs Raydium each cycle.">?</button>
        </div>
        <input type="text" placeholder="Token mint address…"
          value="${mm.targetCA || ''}" data-mm-field="targetCA"/>
      </div>
      <div id="mm-mig-badge" class="vb-mig-badge vb-mig-unknown">⏳ Detecting…</div>

      <div class="vb-divider"></div>

      <!-- Strategy presets -->
      <div class="field">
        <div class="field-label">Strategy
          <button class="help-q" data-action="show-help" data-title="Strategy"
            data-body="Balanced: moderate spread and frequency. Aggressive: tight spread, high frequency for deep liquidity. Stealth: wider spread + human-like jitter to avoid bot detection. Ladder: 2-3 price levels per side when depth &gt; 1 SOL.">?</button>
        </div>
        <div class="mm-strategy-row">
          ${[
            { id: 'balanced',   label: '⚖️ Balanced',   cls: '' },
            { id: 'aggressive', label: '⚡ Aggressive', cls: 'strat-agg' },
            { id: 'stealth',    label: '🥷 Stealth',    cls: 'strat-sth' },
            { id: 'ladder',     label: '🪜 Ladder',     cls: 'strat-ldr' },
          ].map(s => `
            <button class="mm-strat-pill ${s.cls} ${(mm.strategy || 'balanced') === s.id ? 'active' : ''}"
              data-action="mm-strategy" data-strategy="${s.id}">${s.label}</button>
          `).join('')}
        </div>
      </div>

      <!-- Spread & Depth -->
      <div class="mm-spread-row">
        <div class="field">
          <div class="field-label">Spread %
            <button class="help-q" data-action="show-help" data-title="Base Spread %"
              data-body="Percentage difference between bid and ask prices. AI widens it automatically during high volatility.">?</button>
          </div>
          <input type="number" min="${MM_SPREAD_MIN}" max="${MM_SPREAD_MAX}" step="0.1"
            value="${parseFloat(mm.spreadPct || MM_SPREAD_DEF).toFixed(1)}"
            data-mm-field="spreadPct"/>
        </div>
        <div class="field">
          <div class="field-label">Depth / Side (SOL)
            <button class="help-q" data-action="show-help" data-title="Depth per Side"
              data-body="SOL amount placed on each of the bid and ask sides per cycle. Applied with ±8% random jitter.">?</button>
          </div>
          <input type="number" min="0.01" max="50" step="0.1"
            value="${parseFloat(mm.depthSOL || MM_DEPTH_DEF).toFixed(2)}"
            data-mm-field="depthSOL"/>
        </div>
      </div>

      <!-- AI Mode toggle -->
      <div class="sf-toggle-row" style="margin-bottom:10px">
        <div class="sf-toggle-left">
          <div class="field-label" style="margin-bottom:0">
            🤖 AI Mode
            <button class="help-q" data-action="show-help" data-title="AI Mode"
              data-body="When ON: AI automatically adjusts spread, depth, and interval each cycle based on pool liquidity, price volatility, and success streaks. Recommended.">?</button>
            ${mm.aiMode ? '<span class="vb-mode-pill vb-pill-ai">ACTIVE</span>' : ''}
          </div>
          <div class="sf-toggle-hint">Auto-tune spread, depth &amp; interval</div>
        </div>
        <div class="sf-toggle-right">
          <div class="toggle ${mm.aiMode ? 'on' : ''}" data-action="mm-toggle-ai"></div>
        </div>
      </div>

      <!-- Interval -->
      <div class="field">
        <div class="field-label" style="justify-content:space-between;flex-wrap:nowrap">
          <span>Rebalance Interval (s)
            <button class="help-q" data-action="show-help" data-title="Rebalance Interval"
              data-body="Seconds between market-making cycles. Set to 0 for AI control (12–80s based on liquidity and streaks).">?</button>
          </span>
          <div class="vb-ai-row">
            <span class="vb-ai-label">AI</span>
            <div class="toggle ${aiInt ? 'on' : ''}" data-action="mm-toggle-ai-int"></div>
          </div>
        </div>
        ${aiInt
          ? `<div class="vb-ai-hint">🤖 AI decides: 12–80s based on liquidity &amp; streaks</div>`
          : `<input type="number" min="5" max="3600" step="5" placeholder="20"
               value="${mm.intervalSeconds || 20}" data-mm-field="intervalSeconds"/>`}
      </div>

      <!-- Max daily volume cap -->
      <div class="field">
        <div class="field-label">Max Daily Volume (SOL)
          <button class="help-q" data-action="show-help" data-title="Max Daily Volume"
            data-body="Optional cap on total SOL traded per 24-hour rolling window. Set to 0 to disable.">?</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="number" min="0" step="1" placeholder="0 (no cap)"
            value="${mm.maxDailyVolSOL != null ? parseFloat(mm.maxDailyVolSOL) || '' : ''}"
            data-mm-field="maxDailyVolSOL" style="flex:1"/>
          <span style="font-size:10px;color:var(--text-muted);flex-shrink:0">SOL</span>
        </div>
      </div>

      <div class="vb-divider"></div>

      <!-- Wallet mode -->
      <div class="field">
        <div class="field-label">Wallet Mode
          <button class="help-q" data-action="show-help" data-title="Wallet Mode"
            data-body="Use Existing: rotate through your saved funded wallets. Generate New: create fresh wallets auto-funded from a source.">?</button>
        </div>
        <div class="mode-toggle">
          <button class="mode-btn ${mm.walletMode === 'existing' ? 'active' : ''}"
            data-action="mm-mode" data-mode="existing">Use Existing</button>
          <button class="mode-btn ${mm.walletMode === 'generate' ? 'active' : ''}"
            data-action="mm-mode" data-mode="generate">Generate New</button>
        </div>
      </div>

      ${mm.walletMode === 'existing' ? buildMmExisting() : buildMmGenerate()}
    </div>

    ${on ? `<div class="vb-running-banner">
      <span>📈 Market Maker is running</span>
      <span class="vb-countdown" id="mm-countdown">…</span>
    </div>` : ''}`;
}

// ── Existing wallet picker (mirrors buildVbExisting) ──
function buildMmExisting() {
  const mm   = mmS();
  const sel  = new Set(mm.selectedWalletIds || []);
  const open = !!mm._existOpen;
  const all  = S.savedWallets.filter(w => w.publicKey && w.privateKey);
  const grps = S.walletGroups || [];
  const ung  = all.filter(w => !w.groupId);
  const cnt  = sel.size;

  return `
    <div class="cpicker-wrap" style="margin-bottom:14px">
      <div class="cpicker-btn ${cnt > 0 ? 'cpicker-selected' : ''}" data-action="mm-exist-toggle">
        <span style="font-size:11px;font-weight:600;flex:1;color:${cnt > 0 ? 'var(--navy)' : 'var(--text-muted)'}">
          ${cnt > 0 ? `${cnt} wallet${cnt !== 1 ? 's' : ''} selected` : 'Select wallets for rotation…'}
        </span>
        <span class="cpicker-chevron ${open ? 'open' : ''}">›</span>
      </div>
      ${open ? `
        <div class="cpicker-dropdown cpicker-targets">
          <div class="vb-picker-toolbar">
            <span class="vb-picker-toolbar-left">${cnt ? `${cnt} selected` : 'None (all eligible)'}</span>
            <div class="vb-picker-toolbar-right">
              <button class="vb-icon-btn" data-action="mm-refresh-bals" id="mm-refresh-btn" title="Refresh balances">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M9.5 5.5A4 4 0 1 1 7 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                  <path d="M7 1v2.2H9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button class="vb-sel-all-btn" data-action="mm-sel-all">
                ${cnt === all.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
          </div>

          ${grps.map(g => {
            const gw   = all.filter(w => w.groupId === g.id);
            if (!gw.length) return '';
            const allS = gw.every(w => sel.has(w.id));
            const somS = gw.some(w  => sel.has(w.id));
            return `
              <div class="tpicker-group-hdr" data-action="mm-sel-grp" data-gid="${g.id}">
                <div class="tpicker-check ${allS ? 'checked' : somS ? 'partial' : ''}"></div>
                <span>${g.emoji || '📁'}</span>
                <span class="tpicker-group-name">${g.name}</span>
                <span class="tpicker-count">${gw.length}</span>
              </div>
              ${gw.map(w => mmWRow(w, sel)).join('')}`;
          }).join('')}

          ${ung.map(w => mmWRow(w, sel)).join('')}

          ${all.length === 0
            ? `<div class="cpicker-empty">No wallets with private keys.<br>Add some in the Wallets tab.</div>`
            : ''}

          <div class="cpicker-divider"></div>
          <div class="cpicker-paste-label">Or paste private key</div>
          <div style="display:flex;gap:5px;padding:0 8px 8px">
            <input type="password" id="mm-paste-priv" placeholder="Base58 private key…"
              style="flex:1;font-size:10.5px"/>
            <button class="btn btn-ghost btn-sm" data-action="mm-paste-use">Use</button>
          </div>
        </div>` : ''}
    </div>`;
}

function mmWRow(w, sel) {
  const bal = mmGetBal(w.publicKey);
  const low = bal !== null && bal < 0.05;
  return `
    <div class="tpicker-wallet-row ${sel.has(w.id) ? 'selected' : ''} ${low ? 'vb-low-opacity' : ''}"
      data-action="mm-sel-w" data-wid="${w.id}">
      <div class="tpicker-check ${sel.has(w.id) ? 'checked' : ''}"></div>
      <span>${w.emoji || '💼'}</span>
      <div class="tpicker-info">
        <span class="tpicker-name">${w.name || 'Wallet'}</span>
        <span class="tpicker-addr">${short(w.publicKey)}</span>
      </div>
      <span class="tpicker-sol ${low ? 'low' : ''}">${bal !== null ? `${bal.toFixed(2)} SOL` : '—'}</span>
    </div>`;
}

// ── Generate panel (mirrors buildVbGenerate) ──
function buildMmGenerate() {
  const mm  = mmS();
  const gen = mm.generatedWallets || [];
  const src = S.savedWallets.find(w => w.id === mm.sourceWalletId);
  const srcBal = src?.publicKey ? mmGetBal(src.publicKey) : null;

  return `
    <div class="vb-gen-panel">
      <div class="vb-gen-inputs">
        <div class="field">
          <div class="field-label">Wallets</div>
          <input type="number" min="1" max="20" step="1"
            value="${mm.newWalletCount || 5}"
            data-mm-field="newWalletCount" placeholder="5"/>
        </div>
        <div class="field">
          <div class="field-label">Total SOL</div>
          <input type="number" min="0.01" step="0.10"
            value="${mm._fundTotal != null ? parseFloat(mm._fundTotal).toFixed(2) : '1.00'}"
            data-mm-field="_fundTotal" placeholder="1.00"/>
        </div>
      </div>

      <div class="field">
        <div class="field-label">Source Wallet
          <button class="help-q" data-action="show-help" data-title="Source Wallet"
            data-body="Funds generated market-maker wallets and receives SOL back when refunded.">?</button>
        </div>
        <div class="cpicker-wrap">
          <div class="cpicker-btn ${src ? 'cpicker-selected' : ''}" data-action="mm-src-tog">
            ${src
              ? `<span>${src.emoji || '💼'}</span>
                 <div class="cpicker-row-info" style="flex:1;min-width:0">
                   <span class="cpicker-name">${src.name || 'Wallet'}</span>
                   <span class="cpicker-addr">${short(src.publicKey)}</span>
                 </div>
                 ${srcBal !== null ? `<span class="cpicker-bal">${srcBal.toFixed(4)} SOL</span>` : ''}`
              : `<span class="cpicker-name" style="color:var(--text-muted);flex:1">Select source wallet…</span>`}
            <span class="cpicker-chevron ${mm._srcOpen ? 'open' : ''}">›</span>
          </div>
          ${mm._srcOpen ? `
            <div class="cpicker-dropdown">
              ${S.savedWallets.filter(w => w.publicKey).map(w => {
                const b = mmGetBal(w.publicKey);
                return `<div class="cpicker-row ${w.id === mm.sourceWalletId ? 'active' : ''}"
                  data-action="mm-src-pick" data-wid="${w.id}">
                  <span>${w.emoji || '💼'}</span>
                  <div class="cpicker-row-info">
                    <span class="cpicker-name">${w.name || 'Wallet'}</span>
                    <span class="cpicker-addr">${short(w.publicKey)}</span>
                  </div>
                  ${b !== null ? `<span class="cpicker-bal">${b.toFixed(4)} SOL</span>` : ''}
                </div>`;
              }).join('') || '<div class="cpicker-empty">No saved wallets</div>'}
              <div class="cpicker-divider"></div>
              <div class="cpicker-paste-label">Or paste private key</div>
              <div style="display:flex;gap:5px;padding:0 8px 8px">
                <input type="password" id="mm-src-paste" placeholder="Base58 private key…"
                  style="flex:1;font-size:10.5px"/>
                <button class="btn btn-ghost btn-sm" data-action="mm-src-paste-use">Use</button>
              </div>
            </div>` : ''}
        </div>
      </div>

      <button class="btn btn-primary btn-full" data-action="mm-gen"
        style="border-radius:var(--r)">+ Generate &amp; Fund Wallets</button>

      ${gen.length ? buildMmGenAccordion(gen) : ''}
    </div>`;
}

function buildMmGenAccordion(gen) {
  const mm      = mmS();
  const isOpen  = !!mm._genOpen;
  const totalBal = gen.reduce((s, w) => {
    const b = mmGetBal(w.publicKey);
    return s + (b !== null ? b : 0);
  }, 0);
  return `
    <div class="vb-gen-accordion">
      <div class="vb-gen-accordion-hdr" data-action="mm-gen-toggle">
        <span class="vb-gen-chevron ${isOpen ? 'open' : ''}">›</span>
        <span class="vb-gen-accordion-title">Generated Wallets (${gen.length})</span>
        <span class="vb-gen-accordion-meta">${totalBal.toFixed(4)} SOL total</span>
        <div class="vb-gen-accordion-actions" onclick="event.stopPropagation()">
          <button class="vb-icon-btn" data-action="mm-refresh-gen" title="Refresh balances">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M9.5 5.5A4 4 0 1 1 7 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
              <path d="M7 1v2.2H9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="btn btn-secondary btn-sm" data-action="mm-refund-all" style="font-size:9px;padding:2px 7px">↩ All</button>
        </div>
      </div>
      ${isOpen ? `
        <div class="vb-gen-body">
          ${gen.map(w => {
            const bal    = mmGetBal(w.publicKey);
            const balStr = bal !== null ? `${bal.toFixed(4)} SOL` : '— SOL';
            return `
              <div class="vb-gen-wallet-card">
                <div class="vb-gen-wallet-left">
                  <span class="vb-gen-wallet-pub link" data-action="copy" data-copy="${w.publicKey}">${short(w.publicKey)} ⧉</span>
                  <span class="vb-gen-wallet-bal-pill ${bal === null ? 'stale' : ''}">${balStr}</span>
                </div>
                <div class="vb-gen-wallet-right">
                  <button class="vb-copy-key-btn" data-action="mm-copy-key"
                    data-priv="${encodeURIComponent(w.privateKey)}" title="Copy private key">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <rect x="1" y="3.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
                      <path d="M3.5 3V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                    </svg>
                  </button>
                  <button class="btn btn-danger btn-sm" data-action="mm-del-one" data-wid="${w.id}"
                    style="font-size:11px;padding:3px 7px">✕</button>
                </div>
              </div>`;
          }).join('')}
        </div>` : ''}
    </div>`;
}

// ── Console tab ───────────────────────────────
function buildMmConsole() {
  const logs  = mmS().log || [];
  const today = new Date().toDateString();
  return `
    <div class="vb-console-toolbar">
      <span class="vb-console-count" id="mm-feed-count">${logs.length} entries</span>
      <button class="btn btn-secondary btn-sm" data-action="mm-clear-log">Clear</button>
    </div>
    <div class="vb-console" id="mm-feed">
      ${logs.length
        ? logs.map(e => {
            const entryDate = e.fullDate || today;
            const tsDisplay = entryDate !== today
              ? `<span class="vb-log-ts-date">${entryDate.slice(4, 10)}</span> ${e.ts}`
              : e.ts;
            return `<div class="vb-log-entry vb-log-${e.type}">
              <span class="vb-log-ts">${tsDisplay}</span>
              <span class="vb-log-msg">${mmEsc(e.msg)}</span>
            </div>`;
          }).join('')
        : `<div class="vb-log-entry vb-log-info">
             <span class="vb-log-ts">—</span>
             <span class="vb-log-msg" style="color:var(--text-muted)">Start the Market Maker to see activity.</span>
           </div>`}
    </div>`;
}

// ── History tab ───────────────────────────────
function buildMmHistory() {
  const hist = mmS().history || [];
  if (!hist.length) return `
    <div class="empty-state" style="padding:40px 20px">
      <div class="empty-icon">📈</div>
      <div class="empty-text">No orders placed yet.<br>
        <span style="font-size:9.5px;color:var(--text-muted)">Appears after each successful cycle.</span>
      </div>
    </div>`;
  return `
    <div class="vb-history-toolbar">
      <span class="vb-hist-count">${hist.length} orders</span>
      <button class="btn btn-secondary btn-sm" data-action="mm-clear-hist">Clear</button>
    </div>
    <div class="vb-history-table">
      <div class="mm-hist-hdr">
        <span>Time</span><span>Wallet</span><span>Side</span>
        <span>SOL</span><span>Price</span><span>Fees</span><span>Path</span>
      </div>
      ${hist.map(h => {
        const t = new Date(h.ts).toLocaleTimeString('en-GB', {
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        return `<div class="mm-hist-row">
          <span class="vb-hist-time">${t}</span>
          <span class="vb-hist-wallet link" data-action="copy" data-copy="${h.wallet}">${short(h.wallet)}</span>
          <span class="mm-hist-side-${h.side || 'bid'}">${(h.side || 'bid').toUpperCase()}</span>
          <span class="vb-hist-sol">${parseFloat(h.solUsed || 0).toFixed(4)}</span>
          <span class="vb-hist-sol" style="font-size:8.5px">${h.price ? h.price.toExponential(3) : '—'}</span>
          <span class="vb-hist-fees">${parseFloat(h.fees || 0).toFixed(6)}</span>
          <span class="vb-hist-fees" style="font-size:8.5px">${h.path || 'Pump'}</span>
        </div>`;
      }).join('')}
    </div>`;
}

// ── attachMarketMakerHandlers ─────────────────
function attachMarketMakerHandlers() {
  const mm = mmS();

  // Bind change → saveState on all mm-field inputs
  document.querySelectorAll('[data-mm-field]').forEach(el => {
    el.addEventListener('change', async function () {
      const field = this.dataset.mmField;
      let val     = this.value;
      if (this.type === 'number') val = val === '' ? '' : parseFloat(val) || 0;
      mmS()[field] = val;
      await saveState();
    });
  });

  // Restore live countdown
  if (mm.active && mm.nextIn) mmCd(mm.nextIn);
  mmStatUpdate();
  mmUpdateMigBadge();

  // Auto-refresh balances if stale
  if (Date.now() - (mm._lastBalFetch || 0) > 60_000) {
    mm._lastBalFetch = Date.now();
    mmRefreshAllBals();
  }
}

// ── handleMarketMakerAction ───────────────────
async function handleMarketMakerAction(a, el) {
  const mm = mmS();

  if (a === 'mm-tab')   { mm._tab = el.dataset.tab; await saveState(); render(); return; }
  if (a === 'mm-start') { await mmStart(); return; }
  if (a === 'mm-stop')  { await mmStop();  return; }

  // Strategy preset
  if (a === 'mm-strategy') {
    mm.strategy = el.dataset.strategy;
    await saveState(); render(); return;
  }

  // AI toggles
  if (a === 'mm-toggle-ai') {
    mm.aiMode = !mm.aiMode;
    await saveState(); render(); return;
  }
  if (a === 'mm-toggle-ai-int') {
    mm.intervalSeconds = mm.intervalSeconds === 0 ? 20 : 0;
    await saveState(); render(); return;
  }

  // Wallet mode
  if (a === 'mm-mode') { mm.walletMode = el.dataset.mode; await saveState(); render(); return; }

  // Existing picker
  if (a === 'mm-exist-toggle') { mm._existOpen = !mm._existOpen; await saveState(); render(); return; }

  if (a === 'mm-sel-w') {
    const id  = el.dataset.wid;
    const ids = mm.selectedWalletIds = mm.selectedWalletIds || [];
    const i   = ids.indexOf(id);
    i > -1 ? ids.splice(i, 1) : ids.push(id);
    await saveState(); render(); return;
  }

  if (a === 'mm-sel-all') {
    const all = S.savedWallets.filter(w => w.publicKey && w.privateKey);
    mm.selectedWalletIds = mm.selectedWalletIds?.length === all.length ? [] : all.map(w => w.id);
    await saveState(); render(); return;
  }

  if (a === 'mm-sel-grp') {
    const gid = el.dataset.gid;
    const gw  = S.savedWallets.filter(w => w.groupId === gid && w.publicKey && w.privateKey);
    const ids = mm.selectedWalletIds = mm.selectedWalletIds || [];
    const allS = gw.every(w => ids.includes(w.id));
    if (allS) gw.forEach(w => { const i = ids.indexOf(w.id); if (i > -1) ids.splice(i, 1); });
    else      gw.forEach(w => { if (!ids.includes(w.id)) ids.push(w.id); });
    await saveState(); render(); return;
  }

  if (a === 'mm-paste-use') {
    const raw = document.getElementById('mm-paste-priv')?.value?.trim();
    if (!raw) return;
    try {
      const kp  = vbKp(raw);
      const pub = bs58encode(kp.pub);
      let sw    = S.savedWallets.find(w => w.publicKey === pub);
      if (!sw) {
        sw = { id: uid(), name: 'Pasted Wallet', emoji: '💼', publicKey: pub, privateKey: raw, groupId: null };
        S.savedWallets.push(sw);
      }
      mm.selectedWalletIds = [...(mm.selectedWalletIds || [])];
      if (!mm.selectedWalletIds.includes(sw.id)) mm.selectedWalletIds.push(sw.id);
      vbFetchBal(pub).then(() => render());
      await saveState(); render();
    } catch { showToast('Invalid private key'); }
    return;
  }

  if (a === 'mm-copy-key') {
    const priv = decodeURIComponent(el.dataset.priv || '');
    if (priv) copyText(priv);
    return;
  }

  if (a === 'mm-refresh-bals') {
    const btn = document.getElementById('mm-refresh-btn');
    if (btn) btn.classList.add('spinning');
    await mmRefreshAllBals();
    if (btn) btn.classList.remove('spinning');
    return;
  }

  if (a === 'mm-refresh-gen') {
    for (const w of (mm.generatedWallets || [])) if (w.publicKey) await vbFetchBal(w.publicKey);
    render(); return;
  }

  // Source picker
  if (a === 'mm-src-tog')  { mm._srcOpen = !mm._srcOpen; await saveState(); render(); return; }

  if (a === 'mm-src-pick') {
    mm.sourceWalletId = el.dataset.wid; mm._srcOpen = false;
    const src = S.savedWallets.find(w => w.id === mm.sourceWalletId);
    if (src?.publicKey) vbFetchBal(src.publicKey).then(() => render());
    await saveState(); render(); return;
  }

  if (a === 'mm-src-paste-use') {
    const raw = document.getElementById('mm-src-paste')?.value?.trim();
    if (!raw) return;
    try {
      const kp  = vbKp(raw);
      const pub = bs58encode(kp.pub);
      let sw    = S.savedWallets.find(w => w.publicKey === pub);
      if (!sw) {
        sw = { id: uid(), name: 'Pasted Source', emoji: '💼', publicKey: pub, privateKey: raw, groupId: null };
        S.savedWallets.push(sw);
      }
      mm.sourceWalletId = sw.id; mm._srcOpen = false;
      vbFetchBal(pub).then(() => render());
      await saveState(); render();
    } catch { showToast('Invalid private key'); }
    return;
  }

  // Generate accordion
  if (a === 'mm-gen-toggle') { mm._genOpen = !mm._genOpen; await saveState(); render(); return; }

  // Generate wallets
  if (a === 'mm-gen') {
    const nEl = document.querySelector('[data-mm-field="newWalletCount"]');
    const tEl = document.querySelector('[data-mm-field="_fundTotal"]');
    if (nEl?.value) mm.newWalletCount = parseInt(nEl.value)   || 5;
    if (tEl?.value) mm._fundTotal     = parseFloat(tEl.value) || 1.0;
    await saveState();
    await mmGenFund(); return;
  }

  if (a === 'mm-del-one') {
    const id = el.dataset.wid;
    const w  = mm.generatedWallets?.find(x => x.id === id);
    if (!w) return;
    const src = S.savedWallets.find(x => x.id === mm.sourceWalletId);
    if (src?.publicKey && w.privateKey) {
      const bal = await vbFetchBal(w.publicKey) ?? 0;
      if (bal > 0.000_010) {
        try { await vbSendSol(w, src.publicKey, bal - 0.000_010); showToast(`✓ Refunded ${bal.toFixed(4)} SOL`); }
        catch (e) { showToast(`Deleted (refund failed: ${e.message.slice(0, 40)})`); }
      }
    }
    mm.generatedWallets = mm.generatedWallets.filter(x => x.id !== id);
    await saveState(); render(); return;
  }

  if (a === 'mm-refund-all') { await mmRefundAll(); render(); return; }

  // Log / history
  if (a === 'mm-clear-log')  { mm.log = [];     await saveState(); render(); return; }
  if (a === 'mm-clear-hist') { mm.history = []; await saveState(); render(); return; }
}
