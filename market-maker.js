/* ═══════════════════════════════════════════
   market-maker.js — AI Market Maker v3
   Essor Studios / Solana Dev Tools

   Realistic staggered entries, AI-driven exits
   based on price analysis, momentum, and P&L.
   Always tries to exit in profit. Tracks live
   P&L across all open positions. Manual sell-all.
═══════════════════════════════════════════ */
'use strict';

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

// Price history window (how many samples to keep for trend analysis)
const MM_PRICE_WINDOW   = 30;   // last 30 price samples
const MM_PRICE_POLL_MS  = 8000; // poll price every 8s

// Activity thresholds (txs/min)
const MM_ACT_HIGH   = 15;
const MM_ACT_MED    = 4;

// Cycle intervals by activity (seconds between new buys)
const MM_CYC_MIN = { low: 50, medium: 22, high: 9  };
const MM_CYC_MAX = { low: 130, medium: 50, high: 22 };

// Max simultaneous open positions
const MM_MAX_OPEN = 4;

// Hold strategy base ranges (seconds) — AI overrides based on price
const MM_HOLD = {
  scalp:    { min: 20,  max: 120  },
  swing:    { min: 90,  max: 480  },
  position: { min: 400, max: 1800 },
};

// AI sell thresholds
const MM_AI = {
  // If price rose this much since our avg entry, start taking profit
  TAKE_PROFIT_PCT:   3.5,   // +3.5% → start selling
  // Sell more aggressively above this
  STRONG_PUMP_PCT:   7.0,   // +7%  → sell hard
  // Stop-loss: close positions to cap losses
  STOP_LOSS_PCT:    -6.0,   // -6%  → cut losses
  // Soft stop: reduce exposure when down here
  SOFT_STOP_PCT:    -3.0,   // -3%  → reduce
  // Min hold before any AI sell even fires (seconds) — avoids micro-candle noise
  MIN_HOLD_BEFORE_AI: 25,
  // How much to sell on each partial exit (fraction of bag)
  PARTIAL_SMALL:  0.35,  // trim 35% on moderate pump
  PARTIAL_LARGE:  0.65,  // trim 65% on strong pump
  FULL_EXIT:      1.00,  // full close
  // Residual threshold: if remaining bag < this fraction, just close fully
  RESIDUAL_CLOSE: 0.20,
  // Momentum: min consecutive price increases to call it a pump
  PUMP_CONFIRM:   3,
  // Dump confirmation: consecutive price drops before stop fires early
  DUMP_CONFIRM:   3,
};

// Fail circuit-breaker
const MM_FAIL_MAX = 5;
const MM_LOG_MAX  = 300;
const MM_HIST_MAX = 200;

// ─────────────────────────────────────────────
// RUNTIME STATE
// ─────────────────────────────────────────────
let MM = {
  running:       false,
  stopReq:       false,
  cycleTimer:    null,
  priceTimer:    null,      // interval handle for price polling
  openPositions: [],        // { id, wallet, tokensReceived, solSpent, avgEntryPrice, boughtAt, soldPct, migrated }
  idx:           0,
};
let _mmCdInterval = null;

function mmS() {
  if (!S.marketMaker) S.marketMaker = {};
  return S.marketMaker;
}

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────
function mmLog(msg, type = 'info') {
  const ts = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const mm = mmS();
  mm.log = mm.log || [];
  mm.log.unshift({ id: uid(), ts, msg, type, fullDate: new Date().toDateString() });
  if (mm.log.length > MM_LOG_MAX) mm.log = mm.log.slice(0, MM_LOG_MAX);
  if (S.activeTool === 'market-maker' && (mm._tab || 'config') === 'console') {
    const feed = document.getElementById('mm-feed');
    if (feed) {
      const d = document.createElement('div');
      d.className = `vb-log-entry vb-log-${type}`;
      d.innerHTML = `<span class="vb-log-ts">${ts}</span><span class="vb-log-msg">${mmEsc(msg)}</span>`;
      feed.insertBefore(d, feed.firstChild);
      while (feed.children.length > 120) feed.removeChild(feed.lastChild);
      const c = document.getElementById('mm-feed-count');
      if (c) c.textContent = `${mm.log.length} entries`;
    }
  }
  mmStatUpdate();
}
function mmEsc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─────────────────────────────────────────────
// STATS & P&L UPDATE
// ─────────────────────────────────────────────
function mmStatUpdate() {
  const mm   = mmS();
  const s    = mm.stats || {};
  const pnl  = mmCalcTotalPnl();
  const sign = pnl >= 0 ? '+' : '';
  const m = {
    'mm-stat-trades':  s.totalTrades  || 0,
    'mm-stat-open':    MM.openPositions.length,
    'mm-stat-fees':    parseFloat(s.feesPaid || 0).toFixed(4),
    'mm-stat-pnl':     sign + pnl.toFixed(5) + ' SOL',
  };
  for (const [id, v] of Object.entries(m)) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = v;
      if (id === 'mm-stat-pnl') el.style.color = pnl >= 0 ? 'var(--green-dim)' : 'var(--danger)';
    }
  }
  // Live P&L banner
  mmUpdatePnlBanner(pnl);
}

// ─────────────────────────────────────────────
// PRICE HISTORY & ANALYSIS ENGINE
// ─────────────────────────────────────────────

// Fetch current price from Jupiter or bonding curve
async function mmFetchPrice(mint, migrated) {
  try {
    if (!migrated) {
      // Bonding curve — fast on-chain read, no API latency
      const cv = await vbFetchCurve(mint);
      if (cv && !cv.complete && Number(cv.vt) > 0) {
        return Number(cv.vs) / Number(cv.vt); // lamports/token ratio
      }
    }
    // Jupiter price API
    const r = await vbJupFetch(
      `https://api.jup.ag/price/v2?ids=${encodeURIComponent(mint)}&vsToken=${VB_SOL_MINT}`
    );
    const p = r?.data?.[mint]?.price;
    return p ? parseFloat(p) : null;
  } catch { return null; }
}

// Record a new price sample and derive market signals
function mmRecordPrice(price) {
  const mm = mmS();
  if (!price || price <= 0) return;
  mm._prices = mm._prices || [];
  mm._prices.unshift({ p: price, t: Date.now() });
  if (mm._prices.length > MM_PRICE_WINDOW) mm._prices = mm._prices.slice(0, MM_PRICE_WINDOW);
  mm._lastPrice = price;

  // Derive short-term momentum: count consecutive up/down moves
  const prices = mm._prices;
  let upStreak = 0, downStreak = 0;
  for (let i = 0; i < Math.min(prices.length - 1, 6); i++) {
    if (prices[i].p > prices[i+1].p) upStreak++;
    else break;
  }
  for (let i = 0; i < Math.min(prices.length - 1, 6); i++) {
    if (prices[i].p < prices[i+1].p) downStreak++;
    else break;
  }
  mm._upStreak   = upStreak;
  mm._downStreak = downStreak;

  // Volatility: std-dev of last 10 samples as % of mean
  if (prices.length >= 5) {
    const recent = prices.slice(0, 10).map(x => x.p);
    const mean   = recent.reduce((a,b) => a+b, 0) / recent.length;
    const vari   = recent.reduce((a,b) => a + (b-mean)**2, 0) / recent.length;
    mm._volatility = mean > 0 ? Math.sqrt(vari) / mean : 0;
  }

  // Update live PnL display
  mmStatUpdate();
  mmUpdateMigBadge();
}

// ─────────────────────────────────────────────
// P&L CALCULATION
// ─────────────────────────────────────────────

// Returns estimated current value of all open positions in SOL
function mmCalcOpenValue() {
  const mm = mmS();
  const price = mm._lastPrice || 0;
  if (!price) return 0;
  return MM.openPositions.reduce((sum, pos) => {
    const remainPct = 1 - (pos.soldPct || 0);
    const tokRemain = pos.tokensReceived * remainPct;
    return sum + tokRemain * price;
  }, 0);
}

// Returns realised P&L (from closed trades) + unrealised (open positions at current price)
function mmCalcTotalPnl() {
  const mm = mmS();
  const realised   = parseFloat(mm.stats?.realisedPnl || 0);
  const unrealised = mmCalcOpenValue() - MM.openPositions.reduce((s, p) => {
    return s + p.solSpent * (1 - (p.soldPct || 0));
  }, 0);
  return realised + unrealised;
}

function mmUpdatePnlBanner(pnl) {
  const el = document.getElementById('mm-pnl-live');
  if (!el) return;
  const sign = pnl >= 0 ? '+' : '';
  el.textContent = `${sign}${pnl.toFixed(5)} SOL`;
  el.style.color = pnl >= 0 ? 'var(--green-dim)' : 'var(--danger)';
}

// ─────────────────────────────────────────────
// MARKET ANALYSIS ENGINE
// ─────────────────────────────────────────────
//
// mmAnalyseMarket() — runs a full picture of the
// current market state from all available data
// and returns a MarketState object used by both
// the AI threshold engine and the sell decision.
//
// Inputs used:
//   mm._prices        — rolling 30-sample price history (8s poll)
//   mm._txHistory     — recent tx timestamps from getSignaturesForAddress
//   mm._curve         — bonding curve reserve data (Pump.fun only)
//   mm._lastPrice     — latest price
//   mm.stats          — realised PnL, trade count (how the session is going)
//
// Derived signals:
//   trend             — 'up'|'down'|'sideways'
//   momentum          — 0-1 normalised (how strong the direction is)
//   volatility        — coefficient of variation of recent prices
//   volumeAccel       — is tx rate accelerating or decelerating vs recent past?
//   liquidityDepth    — SOL in bonding curve vs our position size (Pump only)
//   priceAccel        — is price moving faster than normal (second derivative)
//   sessionPerf       — our own recent PnL trend (are our trades working?)
//   marketPhase       — 'accumulation'|'markup'|'distribution'|'markdown'
//
async function mmAnalyseMarket() {
  const mm = mmS();
  const prices    = mm._prices || [];
  const lastPrice = mm._lastPrice || 0;

  // ── 1. Trend direction ────────────────────────
  // Use weighted linear regression on last 10 price samples.
  // More recent samples get higher weight.
  let trend = 'sideways', trendStrength = 0;
  if (prices.length >= 4) {
    const n = Math.min(prices.length, 10);
    const pts = prices.slice(0, n);
    let sumW = 0, sumWX = 0, sumWY = 0, sumWXY = 0, sumWX2 = 0;
    pts.forEach((pt, i) => {
      const w = n - i; // higher weight for more recent
      const x = i;
      const y = pt.p;
      sumW   += w;
      sumWX  += w * x;
      sumWY  += w * y;
      sumWXY += w * x * y;
      sumWX2 += w * x * x;
    });
    const slope = (sumW * sumWXY - sumWX * sumWY) / (sumW * sumWX2 - sumWX * sumWX);
    // Normalise slope as % of price per sample
    const slopePct = lastPrice > 0 ? (slope / lastPrice) * 100 : 0;
    trendStrength = Math.min(1, Math.abs(slopePct) / 0.5); // saturates at ±0.5%/sample
    if      (slopePct >  0.05) trend = 'up';
    else if (slopePct < -0.05) trend = 'down';
    else                       trend = 'sideways';
  }

  // ── 2. Momentum (0-1) ─────────────────────────
  // Fraction of recent samples that moved in the trend direction,
  // weighted by the magnitude of each move.
  let momentum = 0;
  if (prices.length >= 3) {
    const n   = Math.min(prices.length - 1, 8);
    const pts = prices.slice(0, n + 1);
    let aggScore = 0;
    for (let i = 0; i < n; i++) {
      const chg = pts[i].p - pts[i+1].p; // positive = price rose (newest first)
      const mag = lastPrice > 0 ? Math.abs(chg) / lastPrice : 0;
      const dir = chg > 0 ? 1 : -1;
      aggScore += dir * Math.min(mag * 100, 1); // cap each sample at 1 unit
    }
    momentum = Math.min(1, Math.max(0, (aggScore / n + 1) / 2)); // normalise 0-1
  }

  // ── 3. Volatility (CoV) ───────────────────────
  // Coefficient of variation of last 10 price samples.
  let volatility = mm._volatility || 0;

  // ── 4. Price acceleration (second derivative) ─
  // Compare slope of first half vs second half of recent window.
  // Positive = price moving faster recently (acceleration).
  let priceAccel = 0;
  if (prices.length >= 8) {
    const n = Math.min(prices.length, 8);
    const half = Math.floor(n / 2);
    const recentHalf = prices.slice(0, half).map(x => x.p);
    const olderHalf  = prices.slice(half, n).map(x => x.p);
    const recentSlope = recentHalf.length > 1 ? (recentHalf[0] - recentHalf[recentHalf.length-1]) / recentHalf.length : 0;
    const olderSlope  = olderHalf.length  > 1 ? (olderHalf[0]  - olderHalf[olderHalf.length-1])   / olderHalf.length  : 0;
    priceAccel = lastPrice > 0 ? ((recentSlope - olderSlope) / lastPrice) * 100 : 0;
  }

  // ── 5. Volume / tx-rate acceleration ──────────
  // Compare tx rate in last 60s vs last 60-120s.
  // Positive = accelerating volume (more interest).
  let volumeAccel = 0;
  const txHistory = mm._txHistory || [];
  if (txHistory.length >= 4) {
    const now = Date.now() / 1000;
    const recent = txHistory.filter(t => t > now - 60).length;
    const older  = txHistory.filter(t => t > now - 120 && t <= now - 60).length;
    // normalised: +1 = twice as many txs, -1 = half as many
    volumeAccel = older > 0 ? (recent - older) / Math.max(older, 1) : 0;
    volumeAccel = Math.max(-1, Math.min(1, volumeAccel));
  }

  // ── 6. Liquidity depth ratio ──────────────────
  // How big is our average position size relative to the pool?
  // Smaller ratio → we can exit easily (tight stop OK).
  // Larger ratio → our sell will move price (wider stop, be careful).
  let liquidityDepth = 1.0; // 1.0 = unknown / safe default
  const cv = mm._curve;
  if (cv && Number(cv.vs) > 0) {
    const poolSolLam = Number(cv.vs);
    const avgPos = ((parseFloat(mm.minSOL)||0.05) + (parseFloat(mm.maxSOL)||0.25)) / 2;
    liquidityDepth = (avgPos * 1e9) / poolSolLam; // fraction of pool
  }

  // ── 7. Session performance ────────────────────
  // Are our recent trades profitable? Use last 5 sell records.
  let sessionPerf = 0; // -1 (losing) to +1 (winning)
  const recentSells = (mm.history || []).filter(h => h.action === 'sell').slice(0, 5);
  if (recentSells.length >= 2) {
    const avgPnl = recentSells.reduce((s, h) => s + (h.pnl || 0), 0) / recentSells.length;
    const avgCost = recentSells.reduce((s, h) => s + (h.solAmt || 0), 0) / recentSells.length;
    sessionPerf = avgCost > 0 ? Math.max(-1, Math.min(1, avgPnl / (avgCost * 0.05))) : 0;
  }

  // ── 8. Market phase ───────────────────────────
  // Wyckoff-inspired: classify current state from trend + momentum + volume accel.
  let marketPhase = 'sideways';
  if      (trend === 'up'   && volumeAccel > 0.2  && momentum > 0.6) marketPhase = 'markup';
  else if (trend === 'up'   && volumeAccel < -0.2 && momentum < 0.5) marketPhase = 'distribution';
  else if (trend === 'down' && volumeAccel > 0.2  && momentum < 0.4) marketPhase = 'markdown';
  else if (trend === 'down' && volumeAccel < -0.1 && momentum > 0.4) marketPhase = 'accumulation';
  else if (trend === 'up')                                             marketPhase = 'markup';
  else if (trend === 'down')                                           marketPhase = 'markdown';

  return {
    trend, trendStrength, momentum, volatility,
    priceAccel, volumeAccel, liquidityDepth,
    sessionPerf, marketPhase,
  };
}

// ─────────────────────────────────────────────
// DYNAMIC THRESHOLD RESOLVER
// ─────────────────────────────────────────────
//
// When AI threshold mode is ON, this replaces the
// user's static inputs with live-computed values.
//
// Logic:
//   • High volatility → tighter stop (losses escalate fast), wider TP (give room to run)
//   • Low liquidity depth → tighter stop, earlier TP (hard to exit large pos)
//   • Markup phase + volume accel → widen TP (let profits run on real pumps)
//   • Distribution phase → cut TP early, tighten stop
//   • Session losing → more conservative thresholds (the market is fighting us)
//   • Session winning → slightly more aggressive TP (stay with what's working)
//   • Price accelerating → bring TP closer (take what's on the table now)
//
function mmResolveThresholds(ms) {
  // ms = MarketState object from mmAnalyseMarket()
  const mm = mmS();

  // Base thresholds (fallback to static if AI mode off)
  if (!mm.aiThreshMode) {
    return {
      takeProfitPct: parseFloat(mm.takeProfitPct) || MM_AI.TAKE_PROFIT_PCT,
      strongPumpPct: parseFloat(mm.strongPumpPct) || MM_AI.STRONG_PUMP_PCT,
      stopLossPct:   parseFloat(mm.stopLossPct)   || MM_AI.STOP_LOSS_PCT,
      softStopPct:   parseFloat(mm.softStopPct)   || MM_AI.SOFT_STOP_PCT,
      partialSmall:  MM_AI.PARTIAL_SMALL,
      partialLarge:  MM_AI.PARTIAL_LARGE,
      pumpConfirm:   MM_AI.PUMP_CONFIRM,
      dumpConfirm:   MM_AI.DUMP_CONFIRM,
      minHold:       MM_AI.MIN_HOLD_BEFORE_AI,
    };
  }

  const { trend, trendStrength, momentum, volatility,
          priceAccel, volumeAccel, liquidityDepth,
          sessionPerf, marketPhase } = ms;

  // ── Take profit ────────────────────────────────
  // Base: 3.5%. Wider when markup + volume accel. Tighter when distributing.
  let tp = 3.5;
  if (marketPhase === 'markup' && volumeAccel > 0.3)   tp = 2.5; // pump is real, TP earlier
  if (marketPhase === 'markup' && volumeAccel > 0.6)   tp = 1.8; // strong pump, grab it fast
  if (marketPhase === 'distribution')                   tp = 4.5; // distribution = wait for higher
  if (volatility > 0.05)   tp *= 1.3;  // high vol → give more room before exiting
  if (liquidityDepth > 0.1) tp *= 0.7; // large pos vs pool → exit earlier (impact risk)
  if (priceAccel > 0.1)    tp *= 0.8;  // price already accelerating → grab now
  if (sessionPerf < -0.5)  tp *= 0.75; // session losing → take what we can sooner
  if (sessionPerf > 0.5)   tp *= 1.2;  // session winning → let profits run a bit more
  tp = Math.max(1.0, Math.min(8.0, tp));

  // ── Strong pump ────────────────────────────────
  // Base: 7%. When a real markup is in progress and volume is accelerating,
  // lower this (we've already been TP'd, strong pump means full exit earlier).
  let sp = 7.0;
  if (marketPhase === 'markup' && volumeAccel > 0.5) sp = 5.0;
  if (marketPhase === 'markup' && volumeAccel > 0.8) sp = 3.5;
  if (volatility > 0.06) sp *= 1.25; // high vol → don't declare strong pump prematurely
  sp = Math.max(tp + 1.0, Math.min(20.0, sp));

  // ── Stop loss ──────────────────────────────────
  // Base: -6%. Tighter when volatile (losses can compound fast).
  // Tighter when our position is large vs liquidity (exit before we can't).
  // Wider when price is still trending up overall (might recover).
  let sl = -6.0;
  if (volatility > 0.05)     sl = -4.5; // volatile → tighter stop
  if (volatility > 0.08)     sl = -3.0; // very volatile → very tight
  if (liquidityDepth > 0.08) sl = Math.max(sl, -4.0); // big pos → tighter
  if (trend === 'up' && trendStrength > 0.6) sl = Math.min(sl, -7.0); // strong uptrend → give room
  if (marketPhase === 'markdown')            sl = Math.max(sl, -3.5); // clear downtrend → stop fast
  if (sessionPerf < -0.5)                   sl = Math.max(sl, -4.0); // losing session → stricter
  sl = Math.max(-15.0, Math.min(-1.0, sl));

  // ── Soft stop ─────────────────────────────────
  // Always halfway between 0 and stop loss, roughly.
  let soft = sl / 2;
  if (marketPhase === 'accumulation') soft = sl * 0.4; // accumulation → hold a bit longer before trimming
  if (marketPhase === 'markdown')     soft = sl * 0.6; // markdown → trim faster
  soft = Math.max(sl + 0.5, Math.min(-0.5, soft));

  // ── Partial sell sizes ─────────────────────────
  // On markup with volume: sell bigger chunks (real buyers will absorb it).
  // On sideways/distribution: smaller trims.
  let partSmall = 0.35, partLarge = 0.65;
  if (marketPhase === 'markup'    && volumeAccel > 0.4) { partSmall = 0.45; partLarge = 0.75; }
  if (marketPhase === 'distribution')                   { partSmall = 0.25; partLarge = 0.50; }
  if (liquidityDepth > 0.1) { partSmall *= 0.7; partLarge *= 0.7; } // big pos → smaller chunks to avoid slippage

  // ── Confirmation requirements ──────────────────
  // High volume accel = real move, confirm faster.
  // Low volume accel = could be noise, require more confirmation.
  const pumpConfirm = volumeAccel > 0.5 ? 2 : volumeAccel > 0 ? 3 : 4;
  const dumpConfirm = volumeAccel > 0.5 ? 2 : 3;

  // ── Min hold ───────────────────────────────────
  // High vol → extend min hold (avoid reacting to noise).
  const minHold = volatility > 0.05 ? 40 : volatility > 0.03 ? 30 : 20;

  const thresholds = {
    takeProfitPct: parseFloat(tp.toFixed(2)),
    strongPumpPct: parseFloat(sp.toFixed(2)),
    stopLossPct:   parseFloat(sl.toFixed(2)),
    softStopPct:   parseFloat(soft.toFixed(2)),
    partialSmall:  parseFloat(partSmall.toFixed(3)),
    partialLarge:  parseFloat(partLarge.toFixed(3)),
    pumpConfirm, dumpConfirm, minHold,
  };

  // Cache on state so config tab can show live values
  mmS()._aiThresholds = thresholds;
  mmS()._aiMarketState = {
    phase: marketPhase, trend,
    vol:   (volatility * 100).toFixed(1) + '%',
    volAccel: volumeAccel.toFixed(2),
    momentum: momentum.toFixed(2),
    depth: (liquidityDepth * 100).toFixed(2) + '%',
    sessPerf: sessionPerf.toFixed(2),
  };

  return thresholds;
}

// ─────────────────────────────────────────────
// AI SELL DECISION ENGINE
// ─────────────────────────────────────────────
//
// Called periodically for each open position.
// Analyses price movement since entry, momentum,
// current P&L, and decides whether/how much to sell.
//
// Returns: { action: 'hold'|'partial'|'full', pct: 0-1, reason: string }
//
// mmAiSellDecision now takes a pre-resolved thresholds object so the
// same decision logic works with both manual and AI-computed thresholds.
function mmAiSellDecision(position, thresholds) {
  const mm = mmS();
  const price = mm._lastPrice;
  if (!price || price <= 0) return { action: 'hold', pct: 0, reason: 'No price data' };

  // Use resolved thresholds (AI or manual)
  const T = thresholds || {
    takeProfitPct: parseFloat(mm.takeProfitPct) || MM_AI.TAKE_PROFIT_PCT,
    strongPumpPct: parseFloat(mm.strongPumpPct) || MM_AI.STRONG_PUMP_PCT,
    stopLossPct:   parseFloat(mm.stopLossPct)   || MM_AI.STOP_LOSS_PCT,
    softStopPct:   parseFloat(mm.softStopPct)   || MM_AI.SOFT_STOP_PCT,
    partialSmall:  MM_AI.PARTIAL_SMALL,
    partialLarge:  MM_AI.PARTIAL_LARGE,
    pumpConfirm:   MM_AI.PUMP_CONFIRM,
    dumpConfirm:   MM_AI.DUMP_CONFIRM,
    minHold:       MM_AI.MIN_HOLD_BEFORE_AI,
  };

  const heldSec     = (Date.now() - position.boughtAt) / 1000;
  const entryPrice  = position.avgEntryPrice;
  const pricePctChg = entryPrice > 0 ? ((price - entryPrice) / entryPrice) * 100 : 0;
  const remainPct   = 1 - (position.soldPct || 0);
  const upStreak    = mm._upStreak   || 0;
  const downStreak  = mm._downStreak || 0;
  const volatility  = mm._volatility || 0;

  // ── Min hold gate ─────────────────────────────
  if (heldSec < T.minHold) {
    return { action: 'hold', pct: 0, reason: `Too early (${heldSec.toFixed(0)}s < ${T.minHold}s)` };
  }

  // ── Residual close ────────────────────────────
  if (remainPct < MM_AI.RESIDUAL_CLOSE) {
    return { action: 'full', pct: 1.0, reason: `Residual close (${(remainPct*100).toFixed(0)}% left)` };
  }

  // ── Stop loss ─────────────────────────────────
  if (pricePctChg <= T.stopLossPct) {
    return { action: 'full', pct: 1.0, reason: `Stop-loss: ${pricePctChg.toFixed(2)}% ≤ ${T.stopLossPct}%` };
  }

  // ── Dump detection ────────────────────────────
  if (downStreak >= T.dumpConfirm && pricePctChg <= T.softStopPct) {
    return {
      action: 'partial', pct: T.partialLarge,
      reason: `Dump (${downStreak} drops, ${pricePctChg.toFixed(2)}%)`,
    };
  }

  // ── Soft stop ─────────────────────────────────
  if (pricePctChg <= T.softStopPct) {
    return {
      action: 'partial', pct: T.partialSmall,
      reason: `Soft stop: ${pricePctChg.toFixed(2)}% ≤ ${T.softStopPct}%`,
    };
  }

  // ── Strong pump ───────────────────────────────
  if (pricePctChg >= T.strongPumpPct) {
    if (upStreak >= T.pumpConfirm) {
      return {
        action: 'partial', pct: T.partialLarge,
        reason: `Strong pump: +${pricePctChg.toFixed(2)}%, ${upStreak} ups`,
      };
    }
    return {
      action: 'partial', pct: T.partialSmall,
      reason: `Pump: +${pricePctChg.toFixed(2)}% (confirming…)`,
    };
  }

  // ── Take profit ───────────────────────────────
  if (pricePctChg >= T.takeProfitPct && upStreak >= 2) {
    return {
      action: 'partial', pct: T.partialSmall,
      reason: `TP: +${pricePctChg.toFixed(2)}%, streak ${upStreak}`,
    };
  }

  // ── Time-based exit ───────────────────────────
  const strategy = mmS().strategy || 'swing';
  const maxHold  = MM_HOLD[strategy]?.max || 480;
  if (heldSec >= maxHold) {
    if (pricePctChg >= -1.5) {
      return { action: 'full', pct: 1.0, reason: `Max hold (${heldSec.toFixed(0)}s), ${pricePctChg.toFixed(2)}%` };
    }
    return {
      action: 'partial', pct: T.partialSmall,
      reason: `Max hold, trimming (${pricePctChg.toFixed(2)}%)`,
    };
  }

  // ── High vol with open gain → hold ───────────
  if (volatility > 0.04 && pricePctChg > 0) {
    return { action: 'hold', pct: 0, reason: `High vol ${(volatility*100).toFixed(1)}%, holding gain` };
  }

  return { action: 'hold', pct: 0, reason: `Holding (${pricePctChg.toFixed(2)}%, ${heldSec.toFixed(0)}s)` };
}

// ─────────────────────────────────────────────
// PRICE POLLING LOOP
// ─────────────────────────────────────────────
// Runs every MM_PRICE_POLL_MS while bot is active.
// Fetches latest price, records it, then runs the
// AI sell engine against every open position.
//
async function mmPriceLoop() {
  if (!MM.running) return;
  const mm = mmS();
  if (!mm.targetCA) return;

  try {
    const mig   = mm._migStatus === 'raydium';

    // Update tx history for volume analysis (lightweight — just timestamps)
    try {
      const sigs = await vbRpc('getSignaturesForAddress', [mm.targetCA, { limit: 20 }]);
      if (sigs?.length) {
        mm._txHistory = sigs.map(s => s.blockTime || 0).filter(Boolean);
      }
    } catch {}

    // Fetch latest price
    const price = await mmFetchPrice(mm.targetCA, mig);
    if (price) mmRecordPrice(price);

    // Run full market analysis
    const marketState = await mmAnalyseMarket();

    // Resolve thresholds: AI-computed if aiThreshMode, manual otherwise
    const thresholds = mmResolveThresholds(marketState);

    // Log AI state summary periodically (every ~5th poll = ~40s)
    mm._pollCount = (mm._pollCount || 0) + 1;
    if (mm._pollCount % 5 === 0 && mm.aiThreshMode) {
      const ms = mm._aiMarketState || {};
      mmLog(
        `📡 Market: ${ms.phase||'?'} · vol ${ms.vol||'?'} · accel ${ms.volAccel||'?'} · ` +
        `mom ${ms.momentum||'?'} · sess ${ms.sessPerf||'?'} → ` +
        `TP ${thresholds.takeProfitPct}% | SL ${thresholds.stopLossPct}% | ` +
        `Soft ${thresholds.softStopPct}%`,
        'info'
      );
    }

    // Run AI sell check on every open position
    for (const pos of [...MM.openPositions]) {
      if (!MM.running) break;
      const decision = mmAiSellDecision(pos, thresholds);
      if (decision.action === 'hold') continue;

      mmLog(
        `🤖 AI: ${decision.action.toUpperCase()} ${(decision.pct*100).toFixed(0)}%` +
        ` [${short(pos.wallet.publicKey)}] — ${decision.reason}`,
        decision.action === 'full' ? 'warn' : 'info'
      );
      await mmExecuteSell(pos, decision.pct, decision.reason, mig);
    }

    // Refresh config tab display if open (shows live AI thresholds)
    if (S.activeTool === 'market-maker' && mm._tab === 'config') {
      mmStatUpdate();
      // Update just the live threshold readouts without a full re-render
      const ms = mm._aiMarketState || {};
      const el = document.getElementById('mm-ai-state-live');
      if (el) {
        el.innerHTML = mm.aiThreshMode
          ? `<span class="mm-ai-badge">${ms.phase||'?'}</span> ` +
            `vol <b>${ms.vol||'?'}</b> · accel <b>${ms.volAccel||'?'}</b> · ` +
            `mom <b>${ms.momentum||'?'}</b> · depth <b>${ms.depth||'?'}</b>`
          : `AI threshold mode off — using manual values`;
      }
      ['tp','sl','soft','sp'].forEach(k => {
        const e2 = document.getElementById(`mm-live-thresh-${k}`);
        if (!e2) return;
        const v = k==='tp'?thresholds.takeProfitPct:k==='sl'?thresholds.stopLossPct:k==='soft'?thresholds.softStopPct:thresholds.strongPumpPct;
        e2.textContent = (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
        e2.style.color = v >= 0 ? 'var(--green-dim)' : 'var(--danger)';
      });
    }

  } catch (e) {
    mmLog(`⚠ Price loop error: ${e.message}`, 'warn');
  }
}

// ─────────────────────────────────────────────
// ACTIVITY DETECTION
// ─────────────────────────────────────────────
async function mmDetectActivity(mint) {
  try {
    const sigs   = await vbRpc('getSignaturesForAddress', [mint, { limit: 30 }]);
    if (!sigs?.length) return 'low';
    const cutoff = Date.now() / 1000 - 120;
    const recent = sigs.filter(s => s.blockTime && s.blockTime > cutoff).length;
    const perMin = recent / 2;
    if (perMin >= MM_ACT_HIGH) return 'high';
    if (perMin >= MM_ACT_MED)  return 'medium';
    return 'low';
  } catch { return 'medium'; }
}

// ─────────────────────────────────────────────
// WALLET HELPERS
// ─────────────────────────────────────────────
function mmActiveWallets() {
  const mm  = mmS();
  const sel = new Set(mm.selectedWalletIds || []);
  if (mm.walletMode === 'existing') {
    return S.savedWallets.filter(w => {
      if (!w.privateKey || !w.publicKey) return false;
      if (sel.size > 0 && !sel.has(w.id)) return false;
      return (vbGetBal(w.publicKey) ?? 0) >= 0.05;
    });
  }
  return (mm.generatedWallets || []).filter(w => w.privateKey && w.publicKey);
}

async function mmRefreshAllBals() {
  const mm = mmS();
  const pks = new Set();
  S.savedWallets.forEach(w => { if (w.publicKey) pks.add(w.publicKey); });
  (mm.generatedWallets || []).forEach(w => { if (w.publicKey) pks.add(w.publicKey); });
  for (const pk of pks) await vbFetchBal(pk);
  if (S.activeTool === 'market-maker') render();
}

function mmFail() {
  const mm = mmS();
  mm.ai = mm.ai || { ok: 0, fail: 0 };
  mm.ai.fail++;
  mm.ai.ok = 0;
  if (mm.ai.fail >= MM_FAIL_MAX) {
    mmLog(`🛑 Circuit breaker (${MM_FAIL_MAX} fails)`, 'error');
    mmStop('Circuit breaker');
  }
}

function mmJitter(val, pct = 8) {
  return val * (1 + (Math.random() * 2 - 1) * pct / 100);
}

// ─────────────────────────────────────────────
// RECORD HISTORY
// ─────────────────────────────────────────────
function mmRecord(walletPub, action, solAmt, fees, tokAmt, path, pnlDelta) {
  const mm = mmS();
  mm.stats = mm.stats || { totalTrades: 0, feesPaid: 0, realisedPnl: 0 };
  if (action === 'sell') {
    mm.stats.totalTrades++;
    mm.stats.feesPaid    = parseFloat(mm.stats.feesPaid    || 0) + fees;
    mm.stats.realisedPnl = parseFloat(mm.stats.realisedPnl || 0) + (pnlDelta || 0);
    mm.ai = mm.ai || { ok: 0, fail: 0 };
    mm.ai.ok++;
    mm.ai.fail = 0;
  }
  mm.history = mm.history || [];
  mm.history.unshift({
    id: uid(), ts: new Date().toISOString(),
    wallet: walletPub, action, solAmt, fees,
    tokAmt: tokAmt || 0, path: path || 'Pump.fun',
    pnl: pnlDelta || 0,
  });
  if (mm.history.length > MM_HIST_MAX) mm.history = mm.history.slice(0, MM_HIST_MAX);
}

// ─────────────────────────────────────────────
// SEND BUY (standalone — tokens stay in wallet)
// ─────────────────────────────────────────────
async function mmSendBuy(wallet, sol, mint, migrated) {
  const lamports = Math.floor(sol * 1e9);
  const buySlip  = 600;

  if (migrated) {
    const buyQuote = await vbJupFetch(
      `${VB_JUP_QUOTE}?inputMint=${VB_SOL_MINT}&outputMint=${encodeURIComponent(mint)}` +
      `&amount=${lamports}&slippageBps=${buySlip}&restrictIntermediateTokens=true`
    );
    const tokensOutRaw = parseInt(buyQuote.outAmount || '0');
    if (!tokensOutRaw) throw new Error('Buy quote: 0 tokens out');

    const buySwap = await vbJupFetch(VB_JUP_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: buyQuote, userPublicKey: wallet.publicKey,
        wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
        skipUserAccountsRpcCalls: true, prioritizationFeeLamports: 'auto',
      }),
    });
    if (!buySwap.swapTransaction) throw new Error('No buy tx from Jupiter');
    const signed = await vbSignJupTx(buySwap.swapTransaction, wallet.privateKey);
    const sig    = await mmSendRawB64(signed);
    mmLog(`📥 Buy: ${sol.toFixed(4)} SOL → ~${tokensOutRaw.toLocaleString()} tok (${short(wallet.publicKey)}) · ${sig.slice(0,10)}…`, 'buy');
    return { tokensReceived: tokensOutRaw, sig };

  } else {
    const cv = await vbFetchCurve(mint);
    if (!cv || cv.complete) throw new Error('Curve gone/complete');
    const tokExp  = vbTokOut(sol, cv);
    const maxCost = BigInt(Math.floor(sol * 1.05 * 1e9));
    const bh      = await vbRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
    if (!bh?.value?.blockhash) throw new Error('No blockhash');
    const curveAta = await vbRpc('getTokenAccountsByOwner', [cv.address, { mint }, { encoding: 'jsonParsed' }]);
    const cvTok    = curveAta?.value?.[0]?.pubkey;
    if (!cvTok) throw new Error('Curve token acct not found');
    const userAta  = await vbAta(wallet.publicKey, mint);
    const uAtaAddr = userAta?.address || wallet.publicKey;
    const kp       = vbKp(wallet.privateKey);
    const keys     = [wallet.publicKey, cv.address, cv.mint, cvTok, uAtaAddr,
                      VB_PUMP_GLOBAL, VB_PUMP_FEE, VB_PUMP_EVAUTH, VB_PUMP_PROG,
                      TOK_PROG, SYS_PROG, RENT_PROG, VB_JITO_TIP, ASSOC_PROG];
    const buyIx    = { pi: 8, ac: [5,6,2,1,3,4,0,10,9,11,7,8], data: vbBuyData(tokExp, maxCost) };
    const tipD     = new Uint8Array(12);
    new DataView(tipD.buffer).setUint32(0, 2, true);
    new DataView(tipD.buffer).setBigUint64(4, BigInt(Math.round(VB_TIP_SOL * 1e9)), true);
    const buyMsg   = vbSerMsg({ header: [1,0,5], keys, bh: bh.value.blockhash, ixs: [buyIx] });
    const tipMsg   = vbSerMsg({ header: [1,0,1], keys: [wallet.publicKey, VB_JITO_TIP, SYS_PROG], bh: bh.value.blockhash, ixs: [{ pi: 2, ac: [0,1], data: tipD }] });
    const [s1, s2] = await Promise.all([vbSign(buyMsg, kp.seed), vbSign(tipMsg, kp.seed)]);
    const { bundleId } = await vbSendBundle([bs58encode(vbSerTx(buyMsg, [s1])), bs58encode(vbSerTx(tipMsg, [s2]))]);
    const conf = await vbConfirmBundle(bundleId);
    if (!conf.landed) throw new Error(`Buy bundle not landed: ${conf.reason}`);
    const tokN = Number(tokExp);
    mmLog(`📥 Buy landed: ${sol.toFixed(4)} SOL → ~${tokN.toLocaleString()} tok (${short(wallet.publicKey)})`, 'buy');
    return { tokensReceived: tokN, bundleId };
  }
}

// ─────────────────────────────────────────────
// SEND SELL (standalone — AI-driven percentage)
// ─────────────────────────────────────────────
async function mmSendSell(wallet, mint, pctToSell, migrated) {
  const sellSlip = 1300;

  // Always query actual on-chain balance — never trust our token estimate
  const ata    = await vbAta(wallet.publicKey, mint);
  const rawBal = ata?.amount ? Number(ata.amount) : 0;
  if (rawBal <= 0) {
    mmLog(`⚠ ${short(wallet.publicKey)} — no tokens on-chain, skipping`, 'warn');
    return null;
  }

  const sellAmt = Math.max(1, Math.floor(rawBal * Math.min(pctToSell, 1.0)));
  mmLog(`📤 Selling ${(pctToSell*100).toFixed(0)}% (${sellAmt.toLocaleString()} tok) from ${short(wallet.publicKey)}…`, 'sell');

  if (migrated) {
    const sellQuote = await vbJupFetch(
      `${VB_JUP_QUOTE}?inputMint=${encodeURIComponent(mint)}&outputMint=${VB_SOL_MINT}` +
      `&amount=${sellAmt}&slippageBps=${sellSlip}&restrictIntermediateTokens=true`
    );
    const solBack = parseInt(sellQuote.outAmount || '0') / 1e9;
    const sellSwap = await vbJupFetch(VB_JUP_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: sellQuote, userPublicKey: wallet.publicKey,
        wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
        skipUserAccountsRpcCalls: true, prioritizationFeeLamports: 'auto',
      }),
    });
    if (!sellSwap.swapTransaction) throw new Error('No sell tx from Jupiter');
    const signedB64 = await vbSignJupTx(sellSwap.swapTransaction, wallet.privateKey);
    let sig;
    try {
      sig = await mmSendRawB64(signedB64);
    } catch (e) {
      if (e.message.includes('0x1789') || e.message.toLowerCase().includes('slippage')) {
        mmLog(`  ↳ Slippage — retrying at ${sellSlip + 700}bps…`, 'warn');
        const rq = await vbJupFetch(`${VB_JUP_QUOTE}?inputMint=${encodeURIComponent(mint)}&outputMint=${VB_SOL_MINT}&amount=${sellAmt}&slippageBps=${sellSlip+700}&restrictIntermediateTokens=true`);
        const rs = await vbJupFetch(VB_JUP_SWAP, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ quoteResponse: rq, userPublicKey: wallet.publicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, skipUserAccountsRpcCalls: true, prioritizationFeeLamports: 'auto' }) });
        sig = await mmSendRawB64(await vbSignJupTx(rs.swapTransaction, wallet.privateKey));
      } else throw e;
    }
    mmLog(`✓ Sell: ~${solBack.toFixed(4)} SOL back (${short(wallet.publicKey)}) · ${sig.slice(0,10)}…`, 'success');
    return { solReceived: solBack, sig, tokensSold: sellAmt };

  } else {
    // Pump.fun sell
    const cv = await vbFetchCurve(mint);
    if (!cv || cv.complete) {
      mmLog('ℹ Curve graduated — switching sell to Jupiter', 'warn');
      return mmSendSell(wallet, mint, pctToSell, true);
    }
    const bh = await vbRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
    if (!bh?.value?.blockhash) throw new Error('No blockhash');
    const userAta  = await vbAta(wallet.publicKey, mint);
    const uAtaAddr = userAta?.address || wallet.publicKey;
    const curveAta = await vbRpc('getTokenAccountsByOwner', [cv.address, { mint }, { encoding: 'jsonParsed' }]);
    const cvTok    = curveAta?.value?.[0]?.pubkey;
    if (!cvTok) throw new Error('Curve token acct not found');
    const kp      = vbKp(wallet.privateKey);
    const keys    = [wallet.publicKey, cv.address, cv.mint, cvTok, uAtaAddr, VB_PUMP_GLOBAL, VB_PUMP_FEE, VB_PUMP_EVAUTH, VB_PUMP_PROG, TOK_PROG, SYS_PROG, RENT_PROG, VB_JITO_TIP, ASSOC_PROG];
    const sellIx  = { pi: 8, ac: [5,6,2,1,3,4,0,9,10,7,8], data: vbSellData(BigInt(sellAmt), BigInt(0)) };
    const tipD    = new Uint8Array(12);
    new DataView(tipD.buffer).setUint32(0, 2, true);
    new DataView(tipD.buffer).setBigUint64(4, BigInt(Math.round(VB_TIP_SOL * 1e9)), true);
    const sellMsg = vbSerMsg({ header: [1,0,5], keys, bh: bh.value.blockhash, ixs: [sellIx] });
    const tipMsg  = vbSerMsg({ header: [1,0,1], keys: [wallet.publicKey, VB_JITO_TIP, SYS_PROG], bh: bh.value.blockhash, ixs: [{ pi: 2, ac: [0,1], data: tipD }] });
    const [s1, s2] = await Promise.all([vbSign(sellMsg, kp.seed), vbSign(tipMsg, kp.seed)]);
    const { bundleId } = await vbSendBundle([bs58encode(vbSerTx(sellMsg, [s1])), bs58encode(vbSerTx(tipMsg, [s2]))]);
    const conf = await vbConfirmBundle(bundleId);
    if (!conf.landed) throw new Error(`Sell bundle not landed: ${conf.reason}`);
    const solEst = (Number(cv.vs) / 1e9) * (sellAmt / Number(cv.vt));
    mmLog(`✓ Sell landed: ~${solEst.toFixed(4)} SOL back (${short(wallet.publicKey)})`, 'success');
    return { solReceived: solEst, bundleId, tokensSold: sellAmt };
  }
}

// Raw RPC send helper
async function mmSendRawB64(b64) {
  const r = await fetch(vbRpcUrl(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'sendTransaction',
      params: [b64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'processed', maxRetries: 3 }],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  if (!j.result) throw new Error('sendTransaction returned no signature');
  return j.result;
}

// ─────────────────────────────────────────────
// EXECUTE SELL (called by AI loop or manual)
// Updates position state and records P&L
// ─────────────────────────────────────────────
async function mmExecuteSell(position, pctToSell, reason, migrated) {
  // Remove from open positions immediately to prevent double-sell race
  const posIdx = MM.openPositions.findIndex(p => p.id === position.id);
  if (posIdx === -1) return; // already gone

  const isFull = pctToSell >= 0.99;
  if (isFull) {
    MM.openPositions.splice(posIdx, 1);
  } else {
    // Mark partial so AI knows how much is left
    MM.openPositions[posIdx].soldPct = (MM.openPositions[posIdx].soldPct || 0) + pctToSell;
    if (MM.openPositions[posIdx].soldPct >= 0.99) {
      MM.openPositions.splice(posIdx, 1);
    }
  }
  mmUpdateMigBadge();

  // Re-detect migration in case it happened during hold
  let mig = migrated;
  try {
    const m = await vbDetectMigration(mmS().targetCA);
    mig = m.migrated;
  } catch {}

  let sellResult;
  try {
    sellResult = await mmSendSell(position.wallet, mmS().targetCA, pctToSell, mig);
  } catch (e) {
    mmLog(`✕ Sell failed [${short(position.wallet.publicKey)}]: ${e.message}`, 'error');
    // Re-add position to list so it can be retried
    if (posIdx !== -1) MM.openPositions.push(position);
    mmFail();
    return;
  }

  if (!sellResult) return;

  const costBasis = position.solSpent * pctToSell;
  const pnlDelta  = sellResult.solReceived - costBasis - (VB_TIP_SOL + 0.00005);
  const sign      = pnlDelta >= 0 ? '+' : '';

  mmLog(
    `💰 PnL: ${sign}${pnlDelta.toFixed(5)} SOL · reason: ${reason}`,
    pnlDelta >= 0 ? 'success' : 'warn'
  );
  mmRecord(
    position.wallet.publicKey, 'sell',
    sellResult.solReceived, VB_TIP_SOL + 0.00005,
    sellResult.tokensSold, mig ? 'Jupiter' : 'Pump.fun',
    pnlDelta
  );

  await saveState(); mmStatUpdate();
  if (S.activeTool === 'market-maker' && mmS()._tab === 'history') render();
}

// ─────────────────────────────────────────────
// MANUAL SELL ALL
// Immediately closes every open position regardless
// of price. Cancels the price-loop AI decisions.
// ─────────────────────────────────────────────
async function mmManualSellAll() {
  mmLog('🔴 MANUAL SELL ALL triggered', 'warn');
  const mm  = mmS();
  const mig = mm._migStatus === 'raydium';
  const positions = [...MM.openPositions];
  MM.openPositions = []; // clear first to prevent AI double-fire
  for (const pos of positions) {
    try {
      await mmExecuteSell(pos, 1.0, 'Manual sell-all', mig);
    } catch (e) {
      mmLog(`✕ Manual sell failed [${short(pos.wallet.publicKey)}]: ${e.message}`, 'error');
    }
  }
  mmLog('✓ Manual sell-all complete', 'info');
  await saveState(); mmStatUpdate();
  if (S.activeTool === 'market-maker') render();
}

// ─────────────────────────────────────────────
// MAIN BUY CYCLE
// ─────────────────────────────────────────────
async function mmRunCycle() {
  if (!MM.running || MM.stopReq) return;
  const mm = mmS();
  if (!mm.active) return;

  // Detect migration
  const mig  = await vbDetectMigration(mm.targetCA);
  mm._migStatus = mig.migrated ? 'raydium' : 'pump';
  mmUpdateMigBadge();

  // Activity level drives cycle speed
  const activity = await mmDetectActivity(mm.targetCA);
  mm._activity   = activity;

  mmLog(`── Buy cycle · activity: ${activity} · path: ${mm._migStatus} ──`, 'info');

  // Don't stack too many open positions
  if (MM.openPositions.length >= MM_MAX_OPEN) {
    mmLog(`⏸ ${MM_MAX_OPEN} positions open — skipping buy, waiting for AI sells`, 'warn');
    mmSched(activity);
    return;
  }

  // Pick an available wallet (not already holding)
  const wallets  = mmActiveWallets();
  if (!wallets.length) { mmLog('⚠ No eligible wallets', 'warn'); mmSched(activity); return; }
  const busyPubs = new Set(MM.openPositions.map(p => p.wallet.publicKey));
  const avail    = wallets.filter(w => !busyPubs.has(w.publicKey));
  if (!avail.length) { mmLog('⏸ All wallets holding — waiting for sells', 'warn'); mmSched(activity); return; }

  const wallet = avail[MM.idx % avail.length];
  MM.idx++;

  const bal = await vbFetchBal(wallet.publicKey) ?? 0;
  if (bal < 0.01) { mmLog(`⚠ ${short(wallet.publicKey)} balance too low`, 'warn'); mmSched(activity); return; }

  // Size the buy
  const minS = parseFloat(mm.minSOL) || 0.05;
  const maxS = parseFloat(mm.maxSOL) || 0.25;
  let sol    = minS + Math.random() * (maxS - minS);
  sol        = mmJitter(sol, 8);
  sol        = Math.min(sol, bal * 0.8 - VB_TIP_SOL);
  if (sol < 0.01) { mmLog('⚠ Buy size too small', 'warn'); mmSched(activity); return; }

  // Fetch entry price for P&L tracking
  const entryPrice = mm._lastPrice || await mmFetchPrice(mm.targetCA, mig.migrated) || 0;

  let buyResult;
  try {
    buyResult = await mmSendBuy(wallet, sol, mm.targetCA, mig.migrated);
  } catch (e) {
    mmLog(`✕ Buy failed: ${e.message}`, 'error');
    mmFail(); mmSched(activity); return;
  }

  // Register position (AI sell loop will manage the exit)
  const position = {
    id:            uid(),
    wallet,
    tokensReceived: buyResult.tokensReceived,
    solSpent:       sol,
    avgEntryPrice:  entryPrice,
    boughtAt:       Date.now(),
    soldPct:        0,
    migrated:       mig.migrated,
  };
  MM.openPositions.push(position);

  mmLog(
    `📊 Position open: ${sol.toFixed(4)} SOL · entry price: ${entryPrice.toExponential(4)}` +
    ` · AI managing exit`,
    'info'
  );

  mmRecord(wallet.publicKey, 'buy', sol, VB_TIP_SOL + 0.00005, buyResult.tokensReceived, mig.migrated ? 'Jupiter' : 'Pump.fun', 0);
  await saveState(); mmStatUpdate();
  if (S.activeTool === 'market-maker' && mm._tab === 'history') render();

  mmSched(activity);
}

// ─────────────────────────────────────────────
// SCHEDULER
// ─────────────────────────────────────────────
function mmSched(activity) {
  if (!MM.running || MM.stopReq) return;
  const mn  = MM_CYC_MIN[activity] || 22;
  const mx  = MM_CYC_MAX[activity] || 50;
  const sec = Math.round(mmJitter((mn + mx) / 2, 20));
  mmS().nextIn = sec;
  saveState();
  mmCd(sec, 'Next buy');
  mmUpdateMigBadge();
  MM.cycleTimer = setTimeout(() => { mmS().nextIn = null; mmRunCycle(); }, sec * 1000);
}

function mmCd(sec, label) {
  if (_mmCdInterval) clearInterval(_mmCdInterval);
  let r = sec;
  const tick = () => {
    const el = document.getElementById('mm-countdown');
    if (el) el.textContent = `${label || 'Next'} in ${r}s`;
    if (r <= 0) clearInterval(_mmCdInterval);
    r--;
  };
  tick(); _mmCdInterval = setInterval(tick, 1000);
}

// ─────────────────────────────────────────────
// MIGRATION BADGE
// ─────────────────────────────────────────────
function mmUpdateMigBadge() {
  const mm  = mmS();
  const el  = document.getElementById('mm-mig-badge');
  if (!el) return;
  const open = MM.openPositions.length;
  if (mm._migStatus === 'raydium') {
    el.textContent = `🔄 Raydium · ${open} bag${open!==1?'s':''}`;
    el.className   = 'vb-mig-badge vb-mig-raydium';
  } else if (mm._migStatus === 'pump') {
    el.textContent = `🟢 Pump.fun · ${open} bag${open!==1?'s':''}`;
    el.className   = 'vb-mig-badge vb-mig-pump';
  } else {
    el.textContent = '⏳ Detecting…';
    el.className   = 'vb-mig-badge vb-mig-unknown';
  }
}

// ─────────────────────────────────────────────
// START / STOP
// ─────────────────────────────────────────────
async function mmStart() {
  const mm = mmS();
  if (!mm.targetCA || mm.targetCA.length < 32) { showToast('Enter a valid token CA first'); return; }
  if (!mmActiveWallets().length) { showToast('No eligible wallets (need ≥0.05 SOL)'); return; }
  mmLog('📈 AI Market Maker starting…', 'info');
  mm.active       = true;
  mm.aiThreshMode = mm.aiThreshMode !== undefined ? mm.aiThreshMode : true; // default ON
  mm.ai           = { ok: 0, fail: 0 };
  mm.stats  = mm.stats || { totalTrades: 0, feesPaid: 0, realisedPnl: 0 };
  mm._prices    = [];
  mm._txHistory = [];
  mm._pollCount = 0;
  MM.running       = true;
  MM.stopReq       = false;
  MM.idx           = 0;
  MM.openPositions = [];
  await saveState(); render();

  // Start price polling loop
  MM.priceTimer = setInterval(mmPriceLoop, MM_PRICE_POLL_MS);

  await mmRunCycle();
}

async function mmStop(reason) {
  MM.running  = false;
  MM.stopReq  = true;
  if (MM.cycleTimer)  { clearTimeout(MM.cycleTimer);   MM.cycleTimer = null; }
  if (MM.priceTimer)  { clearInterval(MM.priceTimer);  MM.priceTimer = null; }
  if (_mmCdInterval)  { clearInterval(_mmCdInterval);  _mmCdInterval = null; }
  const mm = mmS();
  mm.active = false;
  mm.nextIn = null;
  if (MM.openPositions.length) {
    mmLog(`⚠ ${MM.openPositions.length} position(s) still open — tokens remain in wallets. Use Sell All to close.`, 'warn');
  }
  if (reason) mmLog(`🛑 Stopped: ${reason}`, 'warn');
  else        mmLog('🛑 Market Maker stopped.', 'info');
  await saveState(); render();
}

// ─────────────────────────────────────────────
// GENERATE & FUND WALLETS
// ─────────────────────────────────────────────
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
  for (let i = 0; i < n; i++) { const kp = await generateKeypair(); fresh.push({ id: uid(), publicKey: kp.publicKey, privateKey: kp.privateKey }); }
  mm.generatedWallets = [...(mm.generatedWallets || []), ...fresh];
  await saveState(); render();
  for (const w of fresh) {
    try { await vbSendSol(src, w.publicKey, per); mmLog(`✓ Funded ${short(w.publicKey)}: ${per.toFixed(4)} SOL`, 'success'); await vbFetchBal(w.publicKey); }
    catch (e) { mmLog(`✕ Fund failed ${short(w.publicKey)}: ${e.message}`, 'error'); }
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
    try { await vbSendSol(w, src.publicKey, bal - 0.000_010); mmLog(`↩ ${short(w.publicKey)}: ${(bal-0.000_010).toFixed(4)} SOL`, 'success'); }
    catch (e) { mmLog(`✕ ${short(w.publicKey)}: ${e.message}`, 'error'); }
  }
}

// ─────────────────────────────────────────────
// INJECTED STYLES
// ─────────────────────────────────────────────
(function mmInjectStyles() {
  if (document.getElementById('mm-injected-css')) return;
  const s = document.createElement('style');
  s.id = 'mm-injected-css';
  s.textContent = `
/* AI market state badge */
.mm-ai-badge {
  display:inline-block; padding:1px 6px; border-radius:10px;
  font-size:8px; font-weight:700; text-transform:uppercase; letter-spacing:.05em;
  background:var(--navy-ghost2); color:var(--navy); margin-right:3px;
}
/* History table — 8 cols */
.mm-hist-hdr, .mm-hist-row {
  display:grid;
  grid-template-columns:52px 64px 42px 58px 66px 58px 50px 58px;
  gap:3px; padding:5px 8px;
}
.mm-hist-hdr { background:var(--surface2); font-size:8px; font-weight:700; color:var(--text-dim); text-transform:uppercase; letter-spacing:.05em; }
.mm-hist-row { border-bottom:1px solid var(--border); align-items:center; font-size:9px; }
.mm-hist-row:last-child { border-bottom:none; }
.mm-hist-row:hover { background:var(--surface); }
.mm-act-buy  { color:var(--green-dim); font-weight:700; font-size:8.5px; }
.mm-act-sell { color:var(--blue);      font-weight:700; font-size:8.5px; }
.mm-pnl-pos  { color:var(--green-dim); font-family:var(--mono); font-size:8.5px; font-weight:700; }
.mm-pnl-neg  { color:var(--danger);    font-family:var(--mono); font-size:8.5px; font-weight:700; }
/* Strategy pills */
.mm-strategy-row { display:flex; gap:5px; margin-bottom:12px; }
.mm-strat-pill {
  flex:1; text-align:center; padding:5px 6px; border-radius:var(--r-sm);
  font-size:9px; font-weight:700; cursor:pointer;
  border:1px solid var(--border-md); background:var(--surface2); color:var(--text-mid); transition:all .12s;
}
.mm-strat-pill:hover { border-color:var(--border-hi); color:var(--navy); }
.mm-strat-pill.active { background:var(--navy-ghost2); border-color:var(--navy); color:var(--navy); }
.mm-strat-pill.strat-scalp.active  { background:rgba(239,68,68,.1); border-color:rgba(220,38,38,.35); color:#dc2626; }
.mm-strat-pill.strat-pos.active    { background:rgba(139,92,246,.1); border-color:rgba(139,92,246,.35); color:#7c3aed; }
/* P&L live banner */
.mm-pnl-banner {
  display:flex; align-items:center; justify-content:space-between;
  background:var(--surface); border:1px solid var(--border-md);
  border-radius:var(--r); padding:8px 12px; margin:8px 0 4px;
  font-size:10.5px;
}
.mm-pnl-label { color:var(--text-muted); font-size:9.5px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; }
.mm-pnl-value { font-family:var(--mono); font-size:13px; font-weight:700; }
/* Open positions mini-list */
.mm-positions-list { margin-top:8px; display:flex; flex-direction:column; gap:4px; }
.mm-pos-row {
  display:flex; align-items:center; justify-content:space-between;
  background:var(--surface2); border:1px solid var(--border-md);
  border-radius:var(--r-sm); padding:5px 10px; font-size:9.5px;
}
.mm-pos-wallet { font-family:var(--mono); color:var(--navy); }
.mm-pos-pnl { font-family:var(--mono); font-weight:700; font-size:9px; }
.mm-pos-pnl.pos { color:var(--green-dim); }
.mm-pos-pnl.neg { color:var(--danger); }
/* Sol range row */
.mm-sol-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; }
.mm-sol-row .field { margin-bottom:0; }
/* AI thresholds section */
.mm-ai-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px; }
.mm-ai-grid .field { margin-bottom:0; }
  `;
  document.head.appendChild(s);
})();

// ─────────────────────────────────────────────
// PAGE BUILDER
// ─────────────────────────────────────────────
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
          ${on && MM.openPositions.length ? `<button class="btn btn-danger btn-sm" data-action="mm-sell-all">🔴 Sell All</button>` : ''}
          <button class="btn ${on?'btn-secondary':'btn-primary'} btn-sm"
            data-action="${on?'mm-stop':'mm-start'}">${on?'⏹ Stop':'▶ Start'}</button>
        </div>
      </div>
      <div class="vb-tabs">
        <button class="tab ${tab==='config' ?'active':''}" data-action="mm-tab" data-tab="config">Config</button>
        <button class="tab ${tab==='console'?'active':''}" data-action="mm-tab" data-tab="console">Console${mm.log?.length?` <span class="nav-badge" style="background:var(--navy-ghost2);color:var(--navy);font-size:7px;padding:1px 4px">${Math.min(mm.log.length,99)}</span>`:''}</button>
        <button class="tab ${tab==='history'?'active':''}" data-action="mm-tab" data-tab="history">History${mm.history?.length?` (${mm.history.length})`:''}</button>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">
      ${tab==='config'  ? buildMmConfig()  : ''}
      ${tab==='console' ? buildMmConsole() : ''}
      ${tab==='history' ? buildMmHistory() : ''}
    </div>`;
}

// ─────────────────────────────────────────────
// CONFIG TAB
// ─────────────────────────────────────────────
function buildMmConfig() {
  const mm    = mmS();
  const on    = mm.active;
  const stats = mm.stats || {};
  const pnl   = mmCalcTotalPnl();
  const pnlSign = pnl >= 0 ? '+' : '';
  const dis   = on ? '<div style="opacity:.5;pointer-events:none">' : '<div>';
  const price = mm._lastPrice;
  const openPos = MM.openPositions.length;

  return `
    <!-- Stats row -->
    <div class="vb-stats-row">
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-trades">${stats.totalTrades||0}</div>
        <div class="vb-stat-lbl">Trades</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-open">${openPos}</div>
        <div class="vb-stat-lbl">Open Bags</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-fees">${parseFloat(stats.feesPaid||0).toFixed(4)}</div>
        <div class="vb-stat-lbl">Fees SOL</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="mm-stat-pnl" style="color:${pnl>=0?'var(--green-dim)':'var(--danger)'}">${pnlSign}${pnl.toFixed(5)}</div>
        <div class="vb-stat-lbl">PnL SOL</div>
      </div>
    </div>

    <!-- Live P&L banner -->
    <div class="mm-pnl-banner">
      <div>
        <div class="mm-pnl-label">Live P&amp;L (realised + unrealised)</div>
        ${price ? `<div style="font-size:9px;color:var(--text-muted);margin-top:1px">Price: ${price.toExponential(5)} · ${openPos} open · ${mm._upStreak||0}↑ streak</div>` : '<div style="font-size:9px;color:var(--text-muted)">Fetching price…</div>'}
      </div>
      <div class="mm-pnl-value" id="mm-pnl-live" style="color:${pnl>=0?'var(--green-dim)':'var(--danger)'}">${pnlSign}${pnl.toFixed(5)} SOL</div>
    </div>

    <!-- Open positions mini-list -->
    ${openPos > 0 ? `
      <div class="mm-positions-list">
        ${MM.openPositions.map(pos => {
          const currentVal = price ? (pos.tokensReceived * (1-(pos.soldPct||0))) * price : null;
          const costBasis  = pos.solSpent * (1-(pos.soldPct||0));
          const posPnl     = currentVal !== null ? currentVal - costBasis : null;
          const pnlStr     = posPnl !== null ? `${posPnl>=0?'+':''}${posPnl.toFixed(5)} SOL` : '…';
          const heldSec    = Math.round((Date.now() - pos.boughtAt) / 1000);
          return `<div class="mm-pos-row">
            <span class="mm-pos-wallet">${short(pos.wallet.publicKey)}</span>
            <span style="color:var(--text-muted);font-size:8.5px">${pos.solSpent.toFixed(4)} SOL in · ${heldSec}s</span>
            <span class="mm-pos-pnl ${posPnl===null?'':(posPnl>=0?'pos':'neg')}">${pnlStr}</span>
          </div>`;
        }).join('')}
        <button class="btn btn-danger btn-sm" style="margin-top:4px;width:100%" data-action="mm-sell-all">
          🔴 Sell All Open Positions
        </button>
      </div>
    ` : ''}

    <div id="mm-mig-badge" class="vb-mig-badge vb-mig-unknown" style="margin-bottom:4px">⏳ Detecting…</div>

    <div class="vb-divider"></div>

    ${dis}
      <!-- Target CA -->
      <div class="field">
        <div class="field-label">Target Coin CA
          <button class="help-q" data-action="show-help" data-title="Target Coin CA"
            data-body="Mint address of the token. Auto-detects Pump.fun bonding curve vs Raydium each cycle.">?</button>
        </div>
        <input type="text" placeholder="Token mint address…" value="${mm.targetCA||''}" data-mm-field="targetCA"/>
      </div>

      <!-- Hold strategy -->
      <div class="field">
        <div class="field-label">Hold Strategy
          <button class="help-q" data-action="show-help" data-title="Hold Strategy"
            data-body="Sets the baseline hold range. The AI overrides this with early exits on strong pumps/dumps and extends holds when price is slowly climbing. Scalp: 20s–2min. Swing: 1.5–8min. Position: 7–30min.">?</button>
        </div>
        <div class="mm-strategy-row">
          ${[{id:'scalp',label:'⚡ Scalp',cls:'strat-scalp'},{id:'swing',label:'🌊 Swing',cls:''},{id:'position',label:'💎 Position',cls:'strat-pos'}].map(s =>
            `<button class="mm-strat-pill ${s.cls} ${(mm.strategy||'swing')===s.id?'active':''}" data-action="mm-strategy" data-strategy="${s.id}">${s.label}</button>`
          ).join('')}
        </div>
      </div>

      <!-- Buy size -->
      <div class="field">
        <div class="field-label">Buy Size (SOL)
          <button class="help-q" data-action="show-help" data-title="Buy Size"
            data-body="Random size per buy, uniformly drawn between min and max with ±8% jitter. Never exceeds 80% of wallet balance.">?</button>
        </div>
        <div class="mm-sol-row">
          <div class="field"><div class="field-label">Min</div>
            <input type="number" min="0.01" max="100" step="0.01" placeholder="0.05" value="${parseFloat(mm.minSOL||0.05).toFixed(3)}" data-mm-field="minSOL"/>
          </div>
          <div class="field"><div class="field-label">Max</div>
            <input type="number" min="0.01" max="100" step="0.05" placeholder="0.25" value="${parseFloat(mm.maxSOL||0.25).toFixed(3)}" data-mm-field="maxSOL"/>
          </div>
        </div>
      </div>

      <!-- AI Threshold Mode + manual fallback -->
      <div class="field">
        <div class="field-label">Exit Thresholds
          <button class="help-q" data-action="show-help" data-title="Exit Thresholds"
            data-body="AI Mode: thresholds are dynamically computed from on-chain volume, price momentum, liquidity depth, market phase (markup/distribution/markdown), and how well your own session is performing. Manual: fixed values you control.">?</button>
        </div>

        <!-- AI mode toggle row -->
        <div class="sf-toggle-row" style="margin-bottom:8px">
          <div class="sf-toggle-left">
            <div class="field-label" style="margin-bottom:0">
              🤖 AI Threshold Mode
              ${mm.aiThreshMode ? '<span class="vb-mode-pill vb-pill-ai" style="margin-left:5px">ACTIVE</span>' : ''}
            </div>
            <div class="sf-toggle-hint">Adjusts TP/SL/Soft based on volume, phase, liquidity</div>
          </div>
          <div class="sf-toggle-right">
            <div class="toggle ${mm.aiThreshMode ? 'on' : ''}" data-action="mm-toggle-ai-thresh"></div>
          </div>
        </div>

        ${mm.aiThreshMode ? `
          <!-- Live AI state readout -->
          <div style="background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r-sm);padding:7px 10px;margin-bottom:8px">
            <div style="font-size:9px;color:var(--text-muted);margin-bottom:5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase">Live Market State</div>
            <div id="mm-ai-state-live" style="font-size:9px;color:var(--text-mid);line-height:1.6">
              ${(() => {
                const ms = mm._aiMarketState || {};
                return ms.phase
                  ? `<span class="mm-ai-badge">${ms.phase}</span> vol <b>${ms.vol}</b> · accel <b>${ms.volAccel}</b> · mom <b>${ms.momentum}</b> · depth <b>${ms.depth}</b>`
                  : 'Waiting for first price poll…';
              })()}
            </div>
          </div>
          <!-- Live computed thresholds (read-only) -->
          <div class="mm-ai-grid">
            ${(function() {
              const labels = ['Take Profit','Stop Loss','Soft Stop','Strong Pump'];
              const keys   = ['tp','sl','soft','sp'];
              const T      = mm._aiThresholds || {};
              const defs   = [MM_AI.TAKE_PROFIT_PCT, MM_AI.STOP_LOSS_PCT, MM_AI.SOFT_STOP_PCT, MM_AI.STRONG_PUMP_PCT];
              const vals   = [T.takeProfitPct, T.stopLossPct, T.softStopPct, T.strongPumpPct];
              return keys.map(function(k, i) {
                const val = vals[i] != null ? vals[i] : defs[i];
                const col = val >= 0 ? 'var(--green-dim)' : 'var(--danger)';
                const fmt = (val >= 0 ? '+' : '') + val.toFixed(2) + '%';
                const dim = vals[i] == null ? 'opacity:.4;' : '';
                return '<div class="field" style="text-align:center">'
                  + '<div class="field-label" style="font-size:8px;justify-content:center">' + labels[i] + '</div>'
                  + '<div id="mm-live-thresh-' + k + '" style="font-size:13px;font-weight:700;font-family:var(--mono);color:' + col + ';' + dim + '">' + fmt + '</div>'
                  + '</div>';
              }).join('');
            })()}
          </div>
          <div style="font-size:8.5px;color:var(--text-muted);margin-top:4px">
            Thresholds update every ~40s as market data arrives. Phase: markup→wider TP, markdown→tighter SL.
          </div>
        ` : `
          <!-- Manual threshold inputs -->
          <div class="mm-ai-grid">
            <div class="field"><div class="field-label" style="font-size:8.5px">Take Profit %</div>
              <input type="number" min="0.5" max="50" step="0.5" value="${parseFloat(mm.takeProfitPct||MM_AI.TAKE_PROFIT_PCT).toFixed(1)}" data-mm-field="takeProfitPct"/>
            </div>
            <div class="field"><div class="field-label" style="font-size:8.5px">Strong Pump %</div>
              <input type="number" min="1" max="100" step="1" value="${parseFloat(mm.strongPumpPct||MM_AI.STRONG_PUMP_PCT).toFixed(1)}" data-mm-field="strongPumpPct"/>
            </div>
            <div class="field"><div class="field-label" style="font-size:8.5px">Stop Loss %</div>
              <input type="number" min="-50" max="0" step="0.5" value="${parseFloat(mm.stopLossPct||MM_AI.STOP_LOSS_PCT).toFixed(1)}" data-mm-field="stopLossPct"/>
            </div>
            <div class="field"><div class="field-label" style="font-size:8.5px">Soft Stop %</div>
              <input type="number" min="-20" max="0" step="0.5" value="${parseFloat(mm.softStopPct||MM_AI.SOFT_STOP_PCT).toFixed(1)}" data-mm-field="softStopPct"/>
            </div>
          </div>
        `}
      </div>

      <div class="vb-divider"></div>

      <!-- Wallet mode -->
      <div class="field">
        <div class="field-label">Wallet Mode</div>
        <div class="mode-toggle">
          <button class="mode-btn ${mm.walletMode==='existing'?'active':''}" data-action="mm-mode" data-mode="existing">Use Existing</button>
          <button class="mode-btn ${mm.walletMode==='generate'?'active':''}" data-action="mm-mode" data-mode="generate">Generate New</button>
        </div>
      </div>
      ${mm.walletMode==='existing' ? buildMmExisting() : buildMmGenerate()}
    </div>

    ${on ? `
      <div class="vb-running-banner">
        <span>📈 Running · ${openPos} bag${openPos!==1?'s':''} open · ${mm._upStreak||0}↑ ${mm._downStreak||0}↓</span>
        <span class="vb-countdown" id="mm-countdown">…</span>
      </div>` : ''}`;
}

// ─────────────────────────────────────────────
// WALLET PICKERS
// ─────────────────────────────────────────────
function buildMmExisting() {
  const mm=mmS(),sel=new Set(mm.selectedWalletIds||[]),open=!!mm._existOpen;
  const all=S.savedWallets.filter(w=>w.publicKey&&w.privateKey),grps=S.walletGroups||[],ung=all.filter(w=>!w.groupId),cnt=sel.size;
  return`<div class="cpicker-wrap" style="margin-bottom:14px">
    <div class="cpicker-btn ${cnt>0?'cpicker-selected':''}" data-action="mm-exist-toggle">
      <span style="font-size:11px;font-weight:600;flex:1;color:${cnt>0?'var(--navy)':'var(--text-muted)'}">${cnt>0?`${cnt} wallet${cnt!==1?'s':''} selected`:'Select wallets for rotation…'}</span>
      <span class="cpicker-chevron ${open?'open':''}">›</span>
    </div>
    ${open?`<div class="cpicker-dropdown cpicker-targets">
      <div class="vb-picker-toolbar">
        <span class="vb-picker-toolbar-left">${cnt?`${cnt} selected`:'None'}</span>
        <div class="vb-picker-toolbar-right">
          <button class="vb-icon-btn" data-action="mm-refresh-bals" title="Refresh"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M9.5 5.5A4 4 0 1 1 7 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M7 1v2.2H9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button class="vb-sel-all-btn" data-action="mm-sel-all">${cnt===all.length?'Deselect all':'Select all'}</button>
        </div>
      </div>
      ${grps.map(g=>{const gw=all.filter(w=>w.groupId===g.id);if(!gw.length)return'';const allS=gw.every(w=>sel.has(w.id)),somS=gw.some(w=>sel.has(w.id));return`<div class="tpicker-group-hdr" data-action="mm-sel-grp" data-gid="${g.id}"><div class="tpicker-check ${allS?'checked':somS?'partial':''}"></div><span>${g.emoji||'📁'}</span><span class="tpicker-group-name">${g.name}</span><span class="tpicker-count">${gw.length}</span></div>${gw.map(w=>mmWRow(w,sel)).join('')}`;}).join('')}
      ${ung.map(w=>mmWRow(w,sel)).join('')}
      ${all.length===0?`<div class="cpicker-empty">No wallets with private keys.</div>`:''}
      <div class="cpicker-divider"></div>
      <div style="display:flex;gap:5px;padding:0 8px 8px"><input type="password" id="mm-paste-priv" placeholder="Base58 private key…" style="flex:1;font-size:10.5px"/><button class="btn btn-ghost btn-sm" data-action="mm-paste-use">Use</button></div>
    </div>`:``}
  </div>`;
}

function mmWRow(w,sel) {
  const bal=vbGetBal(w.publicKey),low=bal!==null&&bal<0.05;
  const holding=MM.openPositions.some(p=>p.wallet.publicKey===w.publicKey);
  return`<div class="tpicker-wallet-row ${sel.has(w.id)?'selected':''} ${low?'vb-low-opacity':''}" data-action="mm-sel-w" data-wid="${w.id}">
    <div class="tpicker-check ${sel.has(w.id)?'checked':''}"></div>
    <span>${w.emoji||'💼'}</span>
    <div class="tpicker-info"><span class="tpicker-name">${w.name||'Wallet'}${holding?' 🟢':''}</span><span class="tpicker-addr">${short(w.publicKey)}</span></div>
    <span class="tpicker-sol ${low?'low':''}">${bal!==null?`${bal.toFixed(2)} SOL`:'—'}</span>
  </div>`;
}

function buildMmGenerate() {
  const mm=mmS(),gen=mm.generatedWallets||[],src=S.savedWallets.find(w=>w.id===mm.sourceWalletId),srcBal=src?.publicKey?vbGetBal(src.publicKey):null;
  return`<div class="vb-gen-panel">
    <div class="vb-gen-inputs">
      <div class="field"><div class="field-label">Wallets</div><input type="number" min="1" max="20" step="1" value="${mm.newWalletCount||5}" data-mm-field="newWalletCount" placeholder="5"/></div>
      <div class="field"><div class="field-label">Total SOL</div><input type="number" min="0.01" step="0.10" value="${parseFloat(mm._fundTotal||1).toFixed(2)}" data-mm-field="_fundTotal" placeholder="1.00"/></div>
    </div>
    <div class="field"><div class="field-label">Source Wallet</div>
      <div class="cpicker-wrap">
        <div class="cpicker-btn ${src?'cpicker-selected':''}" data-action="mm-src-tog">
          ${src?`<span>${src.emoji||'💼'}</span><div class="cpicker-row-info" style="flex:1;min-width:0"><span class="cpicker-name">${src.name||'Wallet'}</span><span class="cpicker-addr">${short(src.publicKey)}</span></div>${srcBal!==null?`<span class="cpicker-bal">${srcBal.toFixed(4)} SOL</span>`:''}`:`<span class="cpicker-name" style="color:var(--text-muted);flex:1">Select source wallet…</span>`}
          <span class="cpicker-chevron ${mm._srcOpen?'open':''}">›</span>
        </div>
        ${mm._srcOpen?`<div class="cpicker-dropdown">${S.savedWallets.filter(w=>w.publicKey).map(w=>{const b=vbGetBal(w.publicKey);return`<div class="cpicker-row ${w.id===mm.sourceWalletId?'active':''}" data-action="mm-src-pick" data-wid="${w.id}"><span>${w.emoji||'💼'}</span><div class="cpicker-row-info"><span class="cpicker-name">${w.name||'Wallet'}</span><span class="cpicker-addr">${short(w.publicKey)}</span></div>${b!==null?`<span class="cpicker-bal">${b.toFixed(4)} SOL</span>`:''}</div>`;}).join('')||'<div class="cpicker-empty">No saved wallets</div>'}<div class="cpicker-divider"></div><div style="display:flex;gap:5px;padding:0 8px 8px"><input type="password" id="mm-src-paste" placeholder="Base58…" style="flex:1;font-size:10.5px"/><button class="btn btn-ghost btn-sm" data-action="mm-src-paste-use">Use</button></div></div>`:``}
      </div>
    </div>
    <button class="btn btn-primary btn-full" data-action="mm-gen" style="border-radius:var(--r)">+ Generate &amp; Fund Wallets</button>
    ${gen.length?buildMmGenAccordion(gen):''}
  </div>`;
}

function buildMmGenAccordion(gen) {
  const mm=mmS(),isOpen=!!mm._genOpen,totalBal=gen.reduce((s,w)=>{const b=vbGetBal(w.publicKey);return s+(b!==null?b:0);},0);
  return`<div class="vb-gen-accordion"><div class="vb-gen-accordion-hdr" data-action="mm-gen-toggle"><span class="vb-gen-chevron ${isOpen?'open':''}">›</span><span class="vb-gen-accordion-title">Generated Wallets (${gen.length})</span><span class="vb-gen-accordion-meta">${totalBal.toFixed(4)} SOL</span><div class="vb-gen-accordion-actions" onclick="event.stopPropagation()"><button class="btn btn-secondary btn-sm" data-action="mm-refund-all" style="font-size:9px;padding:2px 7px">↩ All</button></div></div>
  ${isOpen?`<div class="vb-gen-body">${gen.map(w=>{const bal=vbGetBal(w.publicKey),holding=MM.openPositions.some(p=>p.wallet.publicKey===w.publicKey);return`<div class="vb-gen-wallet-card"><div class="vb-gen-wallet-left"><span class="vb-gen-wallet-pub link" data-action="copy" data-copy="${w.publicKey}">${short(w.publicKey)} ⧉${holding?' 🟢':''}</span><span class="vb-gen-wallet-bal-pill ${bal===null?'stale':''}">${bal!==null?`${bal.toFixed(4)} SOL`:'— SOL'}</span></div><div class="vb-gen-wallet-right"><button class="vb-copy-key-btn" data-action="mm-copy-key" data-priv="${encodeURIComponent(w.privateKey)}" title="Copy key"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="3.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 3V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></button><button class="btn btn-danger btn-sm" data-action="mm-del-one" data-wid="${w.id}" style="font-size:11px;padding:3px 7px">✕</button></div></div>`;}).join('')}</div>`:``}
  </div>`;
}

// ─────────────────────────────────────────────
// CONSOLE TAB
// ─────────────────────────────────────────────
function buildMmConsole() {
  const logs=mmS().log||[],today=new Date().toDateString();
  return`<div class="vb-console-toolbar"><span class="vb-console-count" id="mm-feed-count">${logs.length} entries</span><button class="btn btn-secondary btn-sm" data-action="mm-clear-log">Clear</button></div>
  <div class="vb-console" id="mm-feed">${logs.length?logs.map(e=>{const d=e.fullDate||today,ts=d!==today?`<span class="vb-log-ts-date">${d.slice(4,10)}</span> ${e.ts}`:e.ts;return`<div class="vb-log-entry vb-log-${e.type}"><span class="vb-log-ts">${ts}</span><span class="vb-log-msg">${mmEsc(e.msg)}</span></div>`;}).join(''):`<div class="vb-log-entry vb-log-info"><span class="vb-log-ts">—</span><span class="vb-log-msg" style="color:var(--text-muted)">Start the Market Maker to see activity.</span></div>`}</div>`;
}

// ─────────────────────────────────────────────
// HISTORY TAB
// ─────────────────────────────────────────────
function buildMmHistory() {
  const hist=mmS().history||[];
  if(!hist.length)return`<div class="empty-state" style="padding:40px 20px"><div class="empty-icon">📈</div><div class="empty-text">No trades yet.</div></div>`;
  return`<div class="vb-history-toolbar"><span class="vb-hist-count">${hist.length} trades</span><button class="btn btn-secondary btn-sm" data-action="mm-clear-hist">Clear</button></div>
  <div class="vb-history-table">
    <div class="mm-hist-hdr"><span>Time</span><span>Wallet</span><span>Act</span><span>SOL</span><span>Tokens</span><span>Fees</span><span>Path</span><span>PnL</span></div>
    ${hist.map(h=>{const t=new Date(h.ts).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}),pnl=h.pnl||0,sign=pnl>=0?'+':'';return`<div class="mm-hist-row"><span class="vb-hist-time">${t}</span><span class="vb-hist-wallet link" data-action="copy" data-copy="${h.wallet}">${short(h.wallet)}</span><span class="mm-act-${h.action}">${(h.action||'buy').toUpperCase()}</span><span class="vb-hist-sol">${parseFloat(h.solAmt||0).toFixed(4)}</span><span style="font-family:var(--mono);font-size:8.5px">${h.tokAmt?(h.tokAmt).toLocaleString():'—'}</span><span class="vb-hist-fees">${parseFloat(h.fees||0).toFixed(6)}</span><span style="font-size:8.5px">${h.path||'Pump'}</span><span class="${h.action==='sell'?(pnl>=0?'mm-pnl-pos':'mm-pnl-neg'):''}">${h.action==='sell'?sign+pnl.toFixed(5):'—'}</span></div>`;}).join('')}
  </div>`;
}

// ─────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────
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
  mmStatUpdate(); mmUpdateMigBadge();
  if(Date.now()-(mm._lastBalFetch||0)>60_000){ mm._lastBalFetch=Date.now(); mmRefreshAllBals(); }
}

async function handleMarketMakerAction(a, el) {
  const mm = mmS();
  if(a==='mm-tab'){mm._tab=el.dataset.tab;await saveState();render();return;}
  if(a==='mm-start'){await mmStart();return;}
  if(a==='mm-stop'){await mmStop();return;}
  if(a==='mm-sell-all'){await mmManualSellAll();return;}
  if(a==='mm-strategy'){mm.strategy=el.dataset.strategy;await saveState();render();return;}
  if(a==='mm-toggle-ai-thresh'){mm.aiThreshMode=!mm.aiThreshMode;await saveState();render();return;}
  if(a==='mm-mode'){mm.walletMode=el.dataset.mode;await saveState();render();return;}
  if(a==='mm-exist-toggle'){mm._existOpen=!mm._existOpen;await saveState();render();return;}
  if(a==='mm-sel-w'){const id=el.dataset.wid,ids=mm.selectedWalletIds=mm.selectedWalletIds||[];const i=ids.indexOf(id);i>-1?ids.splice(i,1):ids.push(id);await saveState();render();return;}
  if(a==='mm-sel-all'){const all=S.savedWallets.filter(w=>w.publicKey&&w.privateKey);mm.selectedWalletIds=mm.selectedWalletIds?.length===all.length?[]:all.map(w=>w.id);await saveState();render();return;}
  if(a==='mm-sel-grp'){const gid=el.dataset.gid,gw=S.savedWallets.filter(w=>w.groupId===gid&&w.publicKey&&w.privateKey),ids=mm.selectedWalletIds=mm.selectedWalletIds||[];const allS=gw.every(w=>ids.includes(w.id));if(allS)gw.forEach(w=>{const i=ids.indexOf(w.id);if(i>-1)ids.splice(i,1);});else gw.forEach(w=>{if(!ids.includes(w.id))ids.push(w.id);});await saveState();render();return;}
  if(a==='mm-paste-use'){const raw=document.getElementById('mm-paste-priv')?.value?.trim();if(!raw)return;try{const kp=vbKp(raw),pub=bs58encode(kp.pub);let sw=S.savedWallets.find(w=>w.publicKey===pub);if(!sw){sw={id:uid(),name:'Pasted Wallet',emoji:'💼',publicKey:pub,privateKey:raw,groupId:null};S.savedWallets.push(sw);}mm.selectedWalletIds=[...(mm.selectedWalletIds||[])];if(!mm.selectedWalletIds.includes(sw.id))mm.selectedWalletIds.push(sw.id);vbFetchBal(pub).then(()=>render());await saveState();render();}catch{showToast('Invalid private key');}return;}
  if(a==='mm-copy-key'){const priv=decodeURIComponent(el.dataset.priv||'');if(priv)copyText(priv);return;}
  if(a==='mm-refresh-bals'){await mmRefreshAllBals();return;}
  if(a==='mm-src-tog'){mm._srcOpen=!mm._srcOpen;await saveState();render();return;}
  if(a==='mm-src-pick'){mm.sourceWalletId=el.dataset.wid;mm._srcOpen=false;const src=S.savedWallets.find(w=>w.id===mm.sourceWalletId);if(src?.publicKey)vbFetchBal(src.publicKey).then(()=>render());await saveState();render();return;}
  if(a==='mm-src-paste-use'){const raw=document.getElementById('mm-src-paste')?.value?.trim();if(!raw)return;try{const kp=vbKp(raw),pub=bs58encode(kp.pub);let sw=S.savedWallets.find(w=>w.publicKey===pub);if(!sw){sw={id:uid(),name:'Pasted Source',emoji:'💼',publicKey:pub,privateKey:raw,groupId:null};S.savedWallets.push(sw);}mm.sourceWalletId=sw.id;mm._srcOpen=false;vbFetchBal(pub).then(()=>render());await saveState();render();}catch{showToast('Invalid private key');}return;}
  if(a==='mm-gen-toggle'){mm._genOpen=!mm._genOpen;await saveState();render();return;}
  if(a==='mm-gen'){const nEl=document.querySelector('[data-mm-field="newWalletCount"]'),tEl=document.querySelector('[data-mm-field="_fundTotal"]');if(nEl?.value)mm.newWalletCount=parseInt(nEl.value)||5;if(tEl?.value)mm._fundTotal=parseFloat(tEl.value)||1.0;await saveState();await mmGenFund();return;}
  if(a==='mm-del-one'){const id=el.dataset.wid,w=mm.generatedWallets?.find(x=>x.id===id);if(!w)return;const src=S.savedWallets.find(x=>x.id===mm.sourceWalletId);if(src?.publicKey&&w.privateKey){const bal=await vbFetchBal(w.publicKey)??0;if(bal>0.000_010){try{await vbSendSol(w,src.publicKey,bal-0.000_010);showToast(`✓ Refunded`);}catch{}}}mm.generatedWallets=mm.generatedWallets.filter(x=>x.id!==id);await saveState();render();return;}
  if(a==='mm-refund-all'){await mmRefundAll();render();return;}
  if(a==='mm-clear-log'){mm.log=[];await saveState();render();return;}
  if(a==='mm-clear-hist'){mm.history=[];await saveState();render();return;}
}