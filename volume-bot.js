/* ═══════════════════════════════════════════
   volume-bot.js — AI Volume Bot
   Essor Studios / Solana Dev Tools

   Zero-loss volume generation via Jito atomic
   bundles on Pump.fun bonding curve, with
   automatic fallback to Jupiter/Raydium for
   graduated (migrated) tokens.
═══════════════════════════════════════════ */
'use strict';

// ── Constants ──────────────────────────────
const VB_JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
];
const VB_JITO_TIP     = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const VB_PUMP_PROG    = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymMDer';
const VB_PUMP_FEE     = 'CebN5WGQ4jvEPvsVU4EoHEpgznyZtZbFoXAXkzXXXYac';
const VB_PUMP_GLOBAL  = '4wTV81gy7hd1kQPSGUjdNzW72HBEsJJYxiGBRtjMDKEU';
const VB_PUMP_EVAUTH  = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
const VB_TIP_SOL      = 0.000_05;
// IMPROVED: shorter AI intervals (was 45-180)
const VB_AI_MIN       = 15;   // normal AI minimum (seconds)
const VB_AI_MAX       = 90;   // normal AI maximum (seconds)
// NEW: Aggressive mode interval range
const VB_AI_MIN_AGG   = 8;    // aggressive minimum (seconds)
const VB_AI_MAX_AGG   = 35;   // aggressive maximum (seconds)
// NEW: Anti-AFK keep-alive range
const VB_AFKAFK_MIN   = 8;    // keep-alive minimum
const VB_AFKAFK_MAX   = 20;   // keep-alive maximum
const VB_AFKAFK_SOL   = 0.015; // IMPROVED: tighter keep-alive size (0.015–0.025 SOL)
const VB_AFK_IDLE_MS  = 15 * 60 * 1000; // 15 min idle → trigger anti-AFK
const VB_FAIL_MAX     = 5;
const VB_LOG_MAX      = 300;
const TOK_PROG        = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOC_PROG      = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv8a';
const SYS_PROG        = '11111111111111111111111111111111';
const RENT_PROG       = 'SysvarRent111111111111111111111111111111111';
const PUMP_BUY_DISC   = new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]);
const PUMP_SELL_DISC  = new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]);

// Jupiter Swap API v1 (current — replaces deprecated quote-api.jup.ag/v6)
// NOTE: manifest.json must include https://api.jup.ag/* in host_permissions
const VB_JUP_QUOTE   = 'https://api.jup.ag/swap/v1/quote';
const VB_JUP_SWAP    = 'https://api.jup.ag/swap/v1/swap';
const VB_SOL_MINT    = 'So11111111111111111111111111111111111111112';
// Raydium AMM v4 program — used to confirm migration
const VB_RAYDIUM_AMM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

// ── Runtime (not persisted) ─────────────────
let VB = { timer: null, running: false, idx: 0, stopReq: false };
let _vbCdInterval = null;

// ── RPC ─────────────────────────────────────
function vbRpcUrl() { return S.settings?.rpcEndpoint || 'https://api.mainnet-beta.solana.com'; }
async function vbRpc(method, params) {
  try {
    const r = await fetch(vbRpcUrl(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return (await r.json()).result ?? null;
  } catch { return null; }
}

// ── Balance cache ───────────────────────────
const vbBals = {};
async function vbFetchBal(pub) {
  const r = await vbRpc('getBalance', [pub]);
  const v = r?.value != null ? r.value / 1e9 : null;
  if (v !== null) vbBals[pub] = v;
  return v;
}
function vbGetBal(pub) {
  if (vbBals[pub] != null) return vbBals[pub];
  const g = balanceCache?.[pub]?.sol;
  return g != null ? parseFloat(g) : null;
}
async function vbRefreshAllBals() {
  const vb  = S.volumeBot;
  const pks = new Set();
  S.savedWallets.forEach(w => { if (w.publicKey) pks.add(w.publicKey); });
  (vb.generatedWallets || []).forEach(w => { if (w.publicKey) pks.add(w.publicKey); });
  const src = S.savedWallets.find(w => w.id === vb.sourceWalletId);
  if (src?.publicKey) pks.add(src.publicKey);
  for (const pk of pks) await vbFetchBal(pk);
  if (S.activeTool === 'volume-bot') render();
}

// ── Logging ──────────────────────────────────
function vbLog(msg, type = 'info') {
  const ts = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  S.volumeBot.log.unshift({ id: uid(), ts, msg, type });
  if (S.volumeBot.log.length > VB_LOG_MAX) S.volumeBot.log = S.volumeBot.log.slice(0, VB_LOG_MAX);
  if (S.activeTool === 'volume-bot' && (S.volumeBot._tab || 'config') === 'console') {
    const feed = document.getElementById('vb-feed');
    if (feed) {
      const d = document.createElement('div');
      d.className = `vb-log-entry vb-log-${type}`;
      d.innerHTML = `<span class="vb-log-ts">${ts}</span><span class="vb-log-msg">${vbEsc(msg)}</span>`;
      feed.insertBefore(d, feed.firstChild);
      while (feed.children.length > 100) feed.removeChild(feed.lastChild);
      const c = document.getElementById('vb-feed-count');
      if (c) c.textContent = `${S.volumeBot.log.length} entries`;
    }
  }
  vbStatUpdate();
}
function vbEsc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function vbStatUpdate() {
  const s = S.volumeBot.stats || {};
  const m = {
    'vb-stat-cycles': s.cycles || 0,
    'vb-stat-volume': parseFloat(s.volumeAdded || 0).toFixed(2),
    'vb-stat-fees':   parseFloat(s.feesPaid    || 0).toFixed(4),
    'vb-stat-fails':  s.bundlesFailed || 0,
  };
  for (const [id, v] of Object.entries(m)) { const el = document.getElementById(id); if (el) el.textContent = v; }
}

// ── Keypair / signing ────────────────────────
function vbKp(b58) {
  const b = bs58decode(b58);
  if (b.length === 64) return { seed: b.slice(0,32), pub: b.slice(32,64) };
  if (b.length === 32) return { seed: b, pub: new Uint8Array(32) };
  throw new Error('Invalid key length');
}
async function vbSign(msgBytes, seed) {
  const pkcs8 = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20,...seed]);
  const key   = await crypto.subtle.importKey('pkcs8', pkcs8, { name:'Ed25519' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('Ed25519', key, msgBytes));
}

// ── TX serialisation ─────────────────────────
function vbCU16(n) {
  const o=[]; let v=n;
  do { let b=v&0x7f; v>>=7; if(v) b|=0x80; o.push(b); } while(v);
  return new Uint8Array(o);
}
function vbSerMsg(msg) {
  const p = [];
  p.push(new Uint8Array([msg.header[0], msg.header[1], msg.header[2]]));
  p.push(vbCU16(msg.keys.length));
  for (const k of msg.keys) p.push(bs58decode(k));
  p.push(bs58decode(msg.bh));
  p.push(vbCU16(msg.ixs.length));
  for (const ix of msg.ixs) {
    p.push(new Uint8Array([ix.pi]));
    p.push(vbCU16(ix.ac.length));
    p.push(new Uint8Array(ix.ac));
    p.push(vbCU16(ix.data.length));
    p.push(ix.data);
  }
  const len = p.reduce((s,x)=>s+x.length,0);
  const out = new Uint8Array(len); let off=0;
  for (const x of p) { out.set(x,off); off+=x.length; }
  return out;
}
function vbSerTx(msgBytes, sigs) {
  const p = [vbCU16(sigs.length), ...sigs, msgBytes];
  const len = p.reduce((s,x)=>s+x.length,0);
  const out = new Uint8Array(len); let off=0;
  for (const x of p) { out.set(x,off); off+=x.length; }
  return out;
}

// ── Pump.fun ─────────────────────────────────
async function vbFetchCurve(mint) {
  const a = await vbRpc('getProgramAccounts',[VB_PUMP_PROG,{filters:[{dataSize:49},{memcmp:{offset:8,bytes:mint}}],encoding:'base64'}]);
  if (!a?.length) return null;
  const raw = Uint8Array.from(atob(a[0].account.data[0]),c=>c.charCodeAt(0));
  if (raw.length < 49) return null;
  const dv = new DataView(raw.buffer, raw.byteOffset);
  return { address:a[0].pubkey, mint,
    vt:dv.getBigUint64(8,true), vs:dv.getBigUint64(16,true),
    rt:dv.getBigUint64(24,true), rs:dv.getBigUint64(32,true),
    complete:raw[48]!==0, _ts:Date.now() };
}
function vbTokOut(solIn, c) {
  const sol=BigInt(Math.floor(solIn*1e9));
  return (c.vt*sol)/(c.vs+sol);
}
function vbBuyData(tok, maxSol) {
  const b=new Uint8Array(24); b.set(PUMP_BUY_DISC,0);
  const dv=new DataView(b.buffer);
  dv.setBigUint64(8,BigInt(tok.toString()),true);
  dv.setBigUint64(16,BigInt(maxSol.toString()),true);
  return b;
}
function vbSellData(tok, minSol) {
  const b=new Uint8Array(24); b.set(PUMP_SELL_DISC,0);
  const dv=new DataView(b.buffer);
  dv.setBigUint64(8,BigInt(tok.toString()),true);
  dv.setBigUint64(16,BigInt(minSol.toString()),true);
  return b;
}
async function vbAta(walletPub, mint) {
  const r = await vbRpc('getTokenAccountsByOwner',[walletPub,{mint},{encoding:'jsonParsed'}]);
  if (!r?.value?.length) return null;
  return { address:r.value[0].pubkey, amount:BigInt(r.value[0].account.data.parsed.info.tokenAmount.amount) };
}

// ── Jito ─────────────────────────────────────
async function vbSendBundle(txsB58) {
  for (const ep of VB_JITO_ENDPOINTS) {
    try {
      const r = await fetch(ep,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'sendBundle',params:[txsB58]})});
      const j = await r.json();
      if (j.result) return { bundleId:j.result, ep };
    } catch {}
  }
  throw new Error('All Jito endpoints failed');
}
async function vbConfirmBundle(bundleId) {
  // Jito bundle status: POST getBundleStatuses (NOT a GET with ?ids= query param)
  // The GET endpoint returns 405 Method Not Allowed — must use the JSON-RPC POST form.
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 2500));
    // Try each endpoint in round-robin so a single overloaded node doesn't block us
    const ep = VB_JITO_ENDPOINTS[i % VB_JITO_ENDPOINTS.length];
    try {
      const r = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]]
        }),
      });
      if (!r.ok) continue; // 429 / 5xx — try next poll
      const j = await r.json();
      const b = j?.result?.value?.[0];
      if (!b) continue; // null means bundle not yet seen — keep polling
      if (b.confirmation_status === 'confirmed' || b.confirmation_status === 'finalized')
        return { landed: true, slot: b.slot };
      if (b.err && Object.keys(b.err).length > 0)
        return { landed: false, reason: 'Bundle failed on-chain' };
    } catch {}
  }
  return { landed: false, reason: 'Timeout' };
}

// ── AI ───────────────────────────────────────
// IMPROVED: vbAiSec respects aggressive mode and uses tighter base intervals
function vbAiSec(curve, ai) {
  const vb  = S.volumeBot;
  const agg = !!vb.aggressiveMode;

  // Base interval from mode
  const [lo, hi] = agg ? [VB_AI_MIN_AGG, VB_AI_MAX_AGG] : [VB_AI_MIN, VB_AI_MAX];
  let t = Math.round((lo + hi) / 2); // midpoint as starting point

  // Liquidity-based adjustment: thin pools → slower, deep pools → faster
  if (curve) {
    const solReserves = Number(curve.vs) / 1e9;
    if      (solReserves < 3)   t = Math.min(t + 15, hi);
    else if (solReserves < 10)  t = Math.min(t + 5,  hi);
    else if (solReserves > 100) t = Math.max(t - 10, lo);
    else if (solReserves > 50)  t = Math.max(t - 5,  lo);
  }

  // Streak-based tuning
  if (ai.ok  >= 5) t = Math.max(t - 8,  lo); // on a roll → push harder
  if (ai.ok  >= 10) t = Math.max(t - 4, lo);
  if (ai.fail >= 2) t = Math.min(t + 10, hi); // backing off after failures
  if (ai.fail >= 4) t = Math.min(t + 10, hi);

  return Math.max(lo, Math.min(hi, t));
}

// IMPROVED: vbAiAmt allows up to 10 SOL when conditions warrant
function vbAiAmt(curve, bal, ai) {
  const vb  = S.volumeBot;
  const mn  = parseFloat(vb.minSOL) || 0.05;
  // NEW: cap respects maxVolumePerHour if set
  const rawMax = parseFloat(vb.maxSOL) || 2.0;
  const mx  = Math.min(rawMax, 10.0);
  let sz = (mn + mx) / 2;

  // Liquidity guard: don't move more than 3% of pool reserves
  if (curve) {
    const poolSol = Number(curve.vs) / 1e9;
    sz = Math.min(sz, poolSol * 0.03);
  }

  // Balance guard: never more than 75% of wallet balance
  if (bal > 0) sz = Math.min(sz, bal * 0.75);

  // Streak tuning: successful streaks allow slightly larger sizes
  if (ai.ok  >= 5)  sz = Math.min(sz * 1.15, mx);
  if (ai.ok  >= 10) sz = Math.min(sz * 1.10, mx);
  if (ai.fail >= 2) sz = Math.max(sz * 0.7,  mn);
  if (ai.fail >= 4) sz = Math.max(sz * 0.7,  mn);

  return Math.max(mn, Math.min(mx, sz));
}

// NEW: Check if Anti-AFK should activate based on idle time
function vbShouldAntiAfk() {
  const vb = S.volumeBot;
  if (!vb.antiAfkEnabled) return false;
  if (vb._afkActive) return true; // already in AFK mode
  const lastCycle = vb.lastCycle || 0;
  const lastSuccess = vb._lastSuccessTs || 0;
  const idleSince = Math.max(lastCycle, lastSuccess);
  if (!idleSince) return false;
  return (Date.now() - idleSince) > VB_AFK_IDLE_MS;
}

// NEW: Check max-volume-per-hour cap
// Returns true if the bot should pause due to the hourly cap being hit
function vbAtHourlyCap() {
  const vb = S.volumeBot;
  const cap = parseFloat(vb.maxVolPerHour) || 0;
  if (!cap) return false; // 0 = no cap
  // Sum volume from history entries in the last 60 minutes
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recentVol = (vb.history || []).reduce((sum, h) => {
    return sum + (new Date(h.ts).getTime() > cutoff ? (h.solUsed || 0) : 0);
  }, 0);
  return recentVol >= cap;
}

// ── SOL transfer ─────────────────────────────
async function vbSendSol(fromWallet, toPub, solAmt) {
  const kp=vbKp(fromWallet.privateKey);
  const bh=await vbRpc('getLatestBlockhash',[]);
  if (!bh?.value?.blockhash) throw new Error('No blockhash');
  const data=new Uint8Array(12); const dv=new DataView(data.buffer);
  dv.setUint32(0,2,true); dv.setBigUint64(4,BigInt(Math.round(solAmt*1e9)),true);
  const msg=vbSerMsg({header:[1,0,1],keys:[fromWallet.publicKey,toPub,SYS_PROG],bh:bh.value.blockhash,ixs:[{pi:2,ac:[0,1],data}]});
  const sig=await vbSign(msg,kp.seed);
  const tx=vbSerTx(msg,[sig]);
  const r=await vbRpc('sendTransaction',[bs58encode(tx),{encoding:'base58',skipPreflight:false}]);
  if (!r) throw new Error('TX failed');
  return r;
}


// ── Migration detection ──────────────────────
//
// vbDetectMigration(mint) → { migrated: bool, poolId?: string }
//
// Strategy (fast, single RPC call):
//   1. Check if the bonding curve PDA still exists AND is not complete.
//      Pump.fun sets the `complete` flag (byte 48) to 1 when the curve
//      graduates. A missing account OR complete=1 means migrated.
//   2. If complete or missing, do a lightweight getProgramAccounts scan
//      on Raydium AMM to find the pool. Cache the pool address.
//
// The detection result is cached for 60 s per mint so we don't spam RPC.

const _vbMigCache = {}; // mint → { ts, migrated, poolId }

async function vbDetectMigration(mint) {
  // Return cached result if fresh (<60 s old)
  const cached = _vbMigCache[mint];
  if (cached && Date.now() - cached.ts < 60_000) return cached;

  // Step 1: Fetch the pump.fun curve for this mint
  const curve = await vbFetchCurve(mint);

  if (curve && !curve.complete) {
    // Still live on bonding curve
    const result = { migrated: false, poolId: null, ts: Date.now() };
    _vbMigCache[mint] = result;
    return result;
  }

  // Step 2: Bonding curve gone or completed → look for Raydium pool
  // Raydium AMM v4 pool layout:
  //   baseMint at offset 400 (32 bytes)
  //   quoteMint at offset 432 (32 bytes)
  // We try both offsets (token could be base or quote).
  let poolId = null;

  const tryOffsets = [400, 432];
  for (const offset of tryOffsets) {
    const pools = await vbRpc('getProgramAccounts', [
      VB_RAYDIUM_AMM,
      {
        filters: [
          { dataSize: 752 },
          { memcmp: { offset, bytes: mint } },
        ],
        encoding: 'base64',
        // Only return the pubkey, not account data — faster
        dataSlice: { offset: 0, length: 0 },
      },
    ]);
    if (pools?.length) {
      poolId = pools[0].pubkey;
      break;
    }
  }

  const result = { migrated: true, poolId, ts: Date.now() };
  _vbMigCache[mint] = result;
  return result;
}

// Invalidate cached migration status (call when the bot starts fresh)
function vbClearMigCache(mint) {
  if (mint) delete _vbMigCache[mint];
  else Object.keys(_vbMigCache).forEach(k => delete _vbMigCache[k]);
}


// ── Main cycle (dual-path) ───────────────────

// ── Jupiter API fetch helper ──────────────────
//
// vbJupFetch(url, opts?) → parsed JSON
//
// Wraps fetch() with:
//  - Explicit error on non-2xx responses, including the raw response text
//    so the console shows e.g. "Quote API 429: Too Many Requests" rather
//    than the useless "Failed to fetch" that the old code gave.
//  - A 12-second timeout so a hung request doesn't stall a cycle forever.
//  - Automatic detection of Jupiter error envelopes ({ error: "…" }).
//
async function vbJupFetch(url, opts) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 12_000);
  try {
    const r = await fetch(url, { signal: controller.signal, ...opts });
    if (!r.ok) {
      // Try to get a helpful message from the response body
      let body = '';
      try { body = await r.text(); } catch {}
      // Trim long bodies
      if (body.length > 120) body = body.slice(0, 120) + '…';
      throw new Error(`HTTP ${r.status}${body ? ': ' + body : ''}`);
    }
    const json = await r.json();
    // Jupiter wraps errors in { error: "…" } even on 200 responses
    if (json && typeof json.error === 'string' && json.error) {
      throw new Error(json.error);
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Jupiter request timed out (12s)');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Main cycle (dual-path) ───────────────────
//
// Each cycle:
//   1. Detect whether the token is still on Pump.fun or has migrated.
//   2. Pre-migration  → vbPumpCycle()    (Jito 3-tx bundle on bonding curve)
//   3. Post-migration → vbJupiterCycle() (Jupiter v1 buy+sell via Raydium)
//
async function vbRunCycle() {
  if (!VB.running || VB.stopReq) return;
  const vb = S.volumeBot;
  if (!vb.active) return;

  vbLog('── Cycle start ──', 'info');

  // Pick wallet (round-robin)
  const wallets = vbActiveWallets();
  if (!wallets.length) { vbLog('⚠ No eligible wallets', 'warn'); vbSched(); return; }
  const wallet = wallets[VB.idx % wallets.length]; VB.idx++;

  // Check balance
  const bal = await vbFetchBal(wallet.publicKey) ?? 0;
  if (bal < 0.01) {
    vbLog(`⚠ ${short(wallet.publicKey)} low balance: ${bal.toFixed(4)} SOL`, 'warn');
    vbSched(); return;
  }

  // NEW: mark Anti-AFK cycle on vb so trading paths can see it
  vb._isAfkCycle = vb._afkActive === true;

  // Detect migration (cached 60 s)
  const mig = await vbDetectMigration(vb.targetCA);
  vb._migStatus = mig.migrated ? 'raydium' : 'pump';
  vbUpdateMigBadge();

  if (mig.migrated) {
    vbLog('🔄 Token is on Raydium — using Jupiter path', 'info');
    await vbJupiterCycle(wallet, bal);
  } else {
    await vbPumpCycle(wallet, bal);
  }
}

// ── Path A: Pump.fun bonding curve ────────────
async function vbPumpCycle(wallet, bal) {
  const vb = S.volumeBot;

  const bh = await vbRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
  if (!bh?.value?.blockhash) { vbLog('✕ No blockhash', 'error'); vbFail(); vbSched(); return; }

  // Refresh curve (cache 30 s)
  if (!vb._curve || Date.now() - vb._curve._ts > 30_000) {
    vb._curve = await vbFetchCurve(vb.targetCA);
  }
  if (!vb._curve || vb._curve.complete) {
    vbClearMigCache(vb.targetCA);
    vbLog('ℹ Bonding curve just graduated — switching to Jupiter next cycle', 'warn');
    vbSched(); return;
  }
  const cv = vb._curve;

  const aiSz = vb.minSOL === 0 && vb.maxSOL === 0;
  let sol = aiSz
    ? vbAiAmt(cv, bal, vb.ai)
    : (parseFloat(vb.minSOL) || 0.1) + Math.random() * Math.max(0, (parseFloat(vb.maxSOL) || 0.1) - (parseFloat(vb.minSOL) || 0.1));
  sol = Math.min(sol, Math.max(0, bal - VB_TIP_SOL - 0.0001));
  if (sol < 0.001) { vbLog('⚠ Amount too small', 'warn'); vbSched(); return; }

  const tokExp  = vbTokOut(sol, cv);
  const maxCost = BigInt(Math.floor(sol * 1.05 * 1e9));
  vbLog(`📥 [Pump] Buy ${sol.toFixed(4)} SOL → ${short(vb.targetCA)} (${short(wallet.publicKey)})`, 'buy');

  const curveAta = await vbRpc('getTokenAccountsByOwner', [cv.address, { mint: vb.targetCA }, { encoding: 'jsonParsed' }]);
  const cvTok    = curveAta?.value?.[0]?.pubkey;
  if (!cvTok) { vbLog('✕ Curve token acct not found', 'error'); vbFail(); vbSched(); return; }

  const userAta  = await vbAta(wallet.publicKey, vb.targetCA);
  const uAtaAddr = userAta?.address || wallet.publicKey;

  let bRes;
  try {
    bRes = await vbDoBundle({ wallet, bh: bh.value.blockhash, cv, cvTok, uAtaAddr, tokExp, maxCost });
  } catch (e) {
    vbLog(`✕ [Pump] Bundle error: ${e.message}`, 'error');
    vbFail(); vb.stats.bundlesFailed++;
    await saveState(); vbSched(); return;
  }

  const fees = VB_TIP_SOL + 0.00003;
  if (bRes.landed) {
    S.volumeBot._lastSuccessTs = Date.now(); // NEW: track for anti-AFK
    vbRecordSuccess(wallet.publicKey, sol, fees, bRes.bundleId, 'Pump.fun');
    vbLog(`✓ [Pump] Landed slot ${bRes.slot || '?'} | +${(sol * 2).toFixed(4)} SOL vol`, 'success');
  } else {
    vbLog(`✕ [Pump] Bundle not landed: ${bRes.reason}`, 'error');
    vbFail(); vb.stats.bundlesFailed++;
  }

  await saveState(); vbStatUpdate();
  if (S.activeTool === 'volume-bot' && vb._tab === 'history') render();
  vbSched();
}

// ── vbDoBundle (Pump.fun Jito 3-tx bundle) ────
async function vbDoBundle({ wallet, bh, cv, cvTok, uAtaAddr, tokExp, maxCost }) {
  const kp   = vbKp(wallet.privateKey);
  const keys = [wallet.publicKey, cv.address, cv.mint, cvTok, uAtaAddr,
                VB_PUMP_GLOBAL, VB_PUMP_FEE, VB_PUMP_EVAUTH, VB_PUMP_PROG,
                TOK_PROG, SYS_PROG, RENT_PROG, VB_JITO_TIP, ASSOC_PROG];
  const hdr  = [1, 0, 5];

  const buyIx  = { pi: 8, ac: [5,6,2,1,3,4,0,10,9,11,7,8], data: vbBuyData(tokExp, maxCost) };
  const sellIx = { pi: 8, ac: [5,6,2,1,3,4,0,9,10,7,8],   data: vbSellData(tokExp, BigInt(0)) };

  const tipD  = new Uint8Array(12);
  const tipDv = new DataView(tipD.buffer);
  tipDv.setUint32(0, 2, true);
  tipDv.setBigUint64(4, BigInt(Math.round(VB_TIP_SOL * 1e9)), true);

  const buyMsg  = vbSerMsg({ header: hdr, keys, bh, ixs: [buyIx] });
  const sellMsg = vbSerMsg({ header: hdr, keys, bh, ixs: [sellIx] });
  const tipMsg  = vbSerMsg({
    header: [1, 0, 1], keys: [wallet.publicKey, VB_JITO_TIP, SYS_PROG], bh,
    ixs: [{ pi: 2, ac: [0, 1], data: tipD }],
  });

  const [s1, s2, s3] = await Promise.all([
    vbSign(buyMsg, kp.seed), vbSign(sellMsg, kp.seed), vbSign(tipMsg, kp.seed),
  ]);

  const txs = [
    bs58encode(vbSerTx(buyMsg,  [s1])),
    bs58encode(vbSerTx(sellMsg, [s2])),
    bs58encode(vbSerTx(tipMsg,  [s3])),
  ];

  vbLog('📦 Submitting Jito bundle (Buy→Sell→Tip)…', 'info');
  const { bundleId, ep } = await vbSendBundle(txs);
  vbLog(`🔄 Bundle ${bundleId.slice(0, 12)}… via ${new URL(ep).hostname}`, 'info');
  return { ...(await vbConfirmBundle(bundleId)), bundleId };
}


// ── Path B: Jupiter v1 / Raydium (migrated) ──
//
// Buys the token via Jupiter then immediately sells the full position back,
// creating volume without a net SOL loss (minus fees).
//
// FIXED: The original "only one buy" problem was caused by:
//   1. Using the same low slippage (300 bps) for both buy and sell.
//      By the time the buy lands and the sell fires (~1s later), price has
//      moved past the 3% tolerance on a volatile memecoin → sell reverts.
//   2. Passing 100% of buy outAmount to sell — any rounding or micro-move
//      in pool state causes the sell to quote slightly more tokens than exist
//      in the user's ATA after fees, which also triggers rejection.
//   3. The fallback only tried once with the stale pre-built sell tx, which
//      carried the same too-tight slippage that already failed.
//
// Fix strategy:
//   - Buy slippage: 500 bps (5%) — enough for normal price impact
//   - Sell slippage: 1000 bps (10%) — extra tolerance for the brief time gap
//   - Sell input: 98.5% of buy outAmount — buffer for dust/rounding
//   - Fallback: re-fetch a fresh sell quote (new price, new slippage) rather
//     than re-using the stale pre-built sell tx
//   - Retry sell once at +500 bps if first sell attempt fails with slippage error
//   - Slippage failures do NOT trigger the circuit breaker (non-fatal)
//
async function vbJupiterCycle(wallet, bal) {
  const vb = S.volumeBot;

  // ── Amount to trade ────────────────────────
  // NEW: Anti-AFK cycles use tiny fixed size regardless of config
  let sol;
  if (vb._isAfkCycle) {
    // IMPROVED: tighter AFK range 0.015–0.025 SOL
    sol = VB_AFKAFK_SOL + Math.random() * 0.01; // 0.015–0.025 SOL
    vbLog('🛡️ Anti-AFK keep-alive cycle', 'info');
  } else {
    const aiSz = vb.minSOL === 0 && vb.maxSOL === 0;
    sol = aiSz
      ? vbAiAmt(null, bal, vb.ai) // Jupiter has no curve — use balance heuristic
      : (parseFloat(vb.minSOL) || 0.1) +
        Math.random() * Math.max(0, (parseFloat(vb.maxSOL) || 0.1) - (parseFloat(vb.minSOL) || 0.1));
  }
  sol = Math.min(sol, Math.max(0, bal - VB_TIP_SOL - 0.005));
  if (sol < 0.001) { vbLog('⚠ Amount too small for Jupiter cycle', 'warn'); vbSched(); return; }

  const lamports = Math.floor(sol * 1e9);

  // FIXED: separate buy/sell slippage. Sell is much wider to survive the gap.
  // vb.jupBuySlipBps  defaults to 500 (5%)
  // vb.jupSellSlipBps defaults to 1000 (10%)
  // IMPROVED: raise buy to 600 bps (6%), sell to 1300 bps (13%) for first-try reliability
  // on volatile memecoins. Both are user-configurable via vb.jupBuySlipBps / jupSellSlipBps.
  const buySlip  = parseInt(vb.jupBuySlipBps)  || 600;
  const sellSlip = parseInt(vb.jupSellSlipBps) || 1300;

  vbLog(
    `📥 [Jupiter] Buy ${sol.toFixed(4)} SOL → ${short(vb.targetCA)}` +
    `  slip: buy=${buySlip}bps sell=${sellSlip}bps  (${short(wallet.publicKey)})`,
    'buy'
  );

  try {
    // ── Step 1: Buy quote SOL → Token ──────────
    const buyQuote = await vbJupFetch(
      `${VB_JUP_QUOTE}?inputMint=${VB_SOL_MINT}&outputMint=${encodeURIComponent(vb.targetCA)}` +
      `&amount=${lamports}&slippageBps=${buySlip}&restrictIntermediateTokens=true`
    );

    const tokensOutRaw = parseInt(buyQuote.outAmount || '0');
    if (!tokensOutRaw) throw new Error('Buy quote: 0 tokens out — pool may have no liquidity');

    // FIXED: use the full quote amount for the pre-built bundle sell tx.
    // In the Jito bundle path both txs execute atomically in the same slot,
    // so the quote amount is accurate — no time passes between buy and sell.
    // tokensOutRaw is what Jupiter quotes as the output; we subtract 1 raw unit
    // as dust insurance (1 unit << any meaningful amount on any token).
    // The fallback path (vbJupiterSeparate) queries the actual ATA balance after
    // the buy lands, so it always uses the exact on-chain amount.
    const sellInputTokens = Math.max(1, tokensOutRaw - 1);

    const pricePerSol = (tokensOutRaw / lamports * 1e9).toFixed(0);
    vbLog(
      `  ↳ Buy quote: ${tokensOutRaw.toLocaleString()} tokens` +
      `  (${Number(pricePerSol).toLocaleString()} tok/SOL)` +
      `  sell: 100% (${sellInputTokens.toLocaleString()} units)`,
      'info'
    );

    // ── Step 2: Sell quote Token → SOL ─────────
    // FIXED: use sellSlip (wider) and the reduced sellInputTokens.
    const sellQuote = await vbJupFetch(
      `${VB_JUP_QUOTE}?inputMint=${encodeURIComponent(vb.targetCA)}&outputMint=${VB_SOL_MINT}` +
      `&amount=${sellInputTokens}&slippageBps=${sellSlip}&restrictIntermediateTokens=true`
    );

    const solBackRaw  = parseInt(sellQuote.outAmount || '0');
    const solBack     = solBackRaw / 1e9;
    const netLoss     = sol - solBack;
    vbLog(
      `  ↳ Sell quote: ~${solBack.toFixed(4)} SOL back` +
      `  net: ${netLoss >= 0 ? '-' : '+'}${Math.abs(netLoss).toFixed(4)} SOL` +
      `  (fees + price impact)`,
      'info'
    );

    // ── Step 3: Build both swap transactions ────
    const swapBody = (quote) => JSON.stringify({
      quoteResponse:            quote,
      userPublicKey:            wallet.publicKey,
      wrapAndUnwrapSol:         true,
      dynamicComputeUnitLimit:  true,
      skipUserAccountsRpcCalls: true,
      prioritizationFeeLamports:'auto',
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

    if (!buySwap.swapTransaction)  throw new Error('Jupiter returned no buy transaction');
    if (!sellSwap.swapTransaction) throw new Error('Jupiter returned no sell transaction');

    // ── Step 4: Sign both transactions ──────────
    const [signedBuyB64, signedSellB64] = await Promise.all([
      vbSignJupTx(buySwap.swapTransaction,  wallet.privateKey),
      vbSignJupTx(sellSwap.swapTransaction, wallet.privateKey),
    ]);

    // ── Step 5: Convert base64 → base58 for Jito ──
    const b64toB58 = (b64) =>
      bs58encode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    const buyTxB58  = b64toB58(signedBuyB64);
    const sellTxB58 = b64toB58(signedSellB64);

    // ── Step 6: Build Jito tip transaction ──────
    const bhRes = await vbRpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
    if (!bhRes?.value?.blockhash) throw new Error('No blockhash for Jito tip');

    const tipData = new Uint8Array(12);
    const tipDv   = new DataView(tipData.buffer);
    tipDv.setUint32(0, 2, true);
    tipDv.setBigUint64(4, BigInt(Math.round(VB_TIP_SOL * 1e9)), true);

    const kp      = vbKp(wallet.privateKey);
    const tipMsg  = vbSerMsg({
      header: [1, 0, 1],
      keys:   [wallet.publicKey, VB_JITO_TIP, SYS_PROG],
      bh:     bhRes.value.blockhash,
      ixs:    [{ pi: 2, ac: [0, 1], data: tipData }],
    });
    const tipSig   = await vbSign(tipMsg, kp.seed);
    const tipTxB58 = bs58encode(vbSerTx(tipMsg, [tipSig]));

    // ── Step 7: Submit as Jito bundle ───────────
    vbLog('📦 Submitting Jupiter bundle (Buy→Sell→Tip)…', 'info');
    const { bundleId, ep } = await vbSendBundle([buyTxB58, sellTxB58, tipTxB58]);
    vbLog(`🔄 Bundle ${bundleId.slice(0, 12)}… via ${new URL(ep).hostname}`, 'info');

    const conf = await vbConfirmBundle(bundleId);
    const fees = VB_TIP_SOL + 0.00008;

    if (conf.landed) {
      vbRecordSuccess(wallet.publicKey, sol, fees, bundleId, 'Jupiter');
      vbLog(`✓ [Jupiter] Landed slot ${conf.slot || '?'} | +${(sol * 2).toFixed(4)} SOL vol`, 'success');
    } else {
      vbLog(`ℹ Bundle didn't land (${conf.reason}) — falling back to separate txs…`, 'warn');
      // Pass the raw buy quote (not the signed tx) so the fallback can re-fetch
      // Jupiter and get a fresh blockhash. The signed tx from the bundle path has
      // an expired blockhash by the time the ~30s confirmation window ends.
      await vbJupiterSeparate(
        wallet, buyQuote, sol, fees,
        vb.targetCA, sellInputTokens, sellSlip
      );
    }

  } catch (e) {
    vbLog(`✕ [Jupiter] ${e.message}`, 'error');
    vbFail(); vb.stats.bundlesFailed++;
  }

  await saveState(); vbStatUpdate();
  if (S.activeTool === 'volume-bot' && vb._tab === 'history') render();
  vbSched();
}

// ── Jupiter fallback: sequential buy then sell ─
//
// Accepts the raw buyQuote object (not a pre-signed tx) so it can call
// Jupiter /swap again to get a transaction with a fresh, valid blockhash.
// The bundle path pre-signs with a blockhash that expires ~30s later, so
// any signed tx from that path is always stale by the time the bundle times out.
//
async function vbJupiterSeparate(wallet, buyQuote, sol, fees, tokenMint, sellInputTokens, sellSlip) {
  const vb = S.volumeBot;

  // ── send helper ───────────────────────────────
  const sendTx = async (b64) => {
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
    return j.result;
  };

  // ── slippage error detector ───────────────────
  const isSlippageError = (msg) =>
    msg.includes('0x1789') || msg.includes('0x1788') || msg.includes('0x1771') ||
    msg.includes('SlippageTolerance') || msg.includes('slippage') ||
    msg.includes('6001') || msg.includes('ExceededSlippage') ||
    msg.includes('insufficient output');

  // ── build a fresh sell tx ─────────────────────
  const buildSellTx = async (tokens, slip) => {
    const sq = await vbJupFetch(
      `${VB_JUP_QUOTE}?inputMint=${encodeURIComponent(tokenMint)}&outputMint=${VB_SOL_MINT}` +
      `&amount=${tokens}&slippageBps=${slip}&restrictIntermediateTokens=true`
    );
    const solBack = parseInt(sq.outAmount || '0') / 1e9;
    vbLog(`  ↳ Fresh sell quote: ~${solBack.toFixed(4)} SOL at ${slip}bps`, 'info');
    const ss = await vbJupFetch(VB_JUP_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse:            sq,
        userPublicKey:            wallet.publicKey,
        wrapAndUnwrapSol:         true,
        dynamicComputeUnitLimit:  true,
        skipUserAccountsRpcCalls: true,
        prioritizationFeeLamports:'auto',
      }),
    });
    if (!ss.swapTransaction) throw new Error('No sell transaction from Jupiter');
    return vbSignJupTx(ss.swapTransaction, wallet.privateKey);
  };

  try {
    // 1. Re-fetch the buy transaction with a FRESH blockhash from Jupiter.
    //    We reuse the same buyQuote object (prices/amounts are still valid
    //    for a few seconds) but get a new swapTransaction from Jupiter which
    //    will contain the current blockhash. This avoids the "already been
    //    processed" / "blockhash not found" error that occurs when reusing the
    //    pre-signed tx from the bundle path after the 30s confirmation window.
    vbLog('  ↳ Rebuilding buy tx with fresh blockhash…', 'info');
    const freshBuySwap = await vbJupFetch(VB_JUP_SWAP, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse:            buyQuote,
        userPublicKey:            wallet.publicKey,
        wrapAndUnwrapSol:         true,
        dynamicComputeUnitLimit:  true,
        skipUserAccountsRpcCalls: true,
        prioritizationFeeLamports:'auto',
      }),
    });
    if (!freshBuySwap.swapTransaction) throw new Error('Jupiter returned no fresh buy transaction');
    const freshSignedBuyB64 = await vbSignJupTx(freshBuySwap.swapTransaction, wallet.privateKey);

    // 2. Send the fresh buy
    const buySig = await sendTx(freshSignedBuyB64);
    const sellDelay = Math.max(200, parseInt(vb.sellDelayMs) || 600);
    vbLog(`  ↳ Buy sent: ${buySig.slice(0, 10)}… waiting ${sellDelay}ms…`, 'info');
    await new Promise(r => setTimeout(r, sellDelay));

    // 3. Query actual ATA balance after buy lands
    let actualSellTokens = sellInputTokens;
    try {
      const ata = await vbAta(wallet.publicKey, tokenMint);
      if (ata && ata.amount > 0n) {
        const ataAmt = Number(ata.amount);
        actualSellTokens = Math.max(1, ataAmt - 1);
        vbLog(`  ↳ ATA balance: ${ataAmt.toLocaleString()} tokens → selling ${actualSellTokens.toLocaleString()} (100%)`, 'info');
      } else {
        vbLog(`  ↳ ATA not found yet — using quote estimate (${sellInputTokens.toLocaleString()})`, 'warn');
      }
    } catch (ataErr) {
      vbLog(`  ↳ ATA query failed (${ataErr.message}) — using estimate`, 'warn');
    }

    // 4. First sell attempt with fresh quote
    let sellSig;
    try {
      const freshSell = await buildSellTx(actualSellTokens, sellSlip);
      sellSig = await sendTx(freshSell);
      vbLog(`  ↳ Sell sent: ${sellSig.slice(0, 10)}…`, 'info');
    } catch (sellErr) {
      if (isSlippageError(sellErr.message)) {
        const retrySellSlip = sellSlip + 600;
        vbLog(`  ⚠ Sell slippage (${sellSlip}bps) — retrying at ${retrySellSlip}bps…`, 'warn');
        try {
          const retrySell = await buildSellTx(actualSellTokens, retrySellSlip);
          sellSig = await sendTx(retrySell);
          vbLog(`  ↳ Sell retry sent: ${sellSig.slice(0, 10)}…`, 'info');
        } catch (retryErr) {
          vbLog(`  ⚠ Sell retry also failed (${retryErr.message}) — buy-only cycle recorded`, 'warn');
          vb.stats.cycles++;
          vb.stats.feesPaid = parseFloat(vb.stats.feesPaid || 0) + fees;
          vb.history = vb.history || [];
          vb.history.unshift({
            id: uid(), ts: new Date().toISOString(),
            wallet: wallet.publicKey, solUsed: sol,
            volume: sol, fees, netResult: -(sol + fees),
            bundleId: 'n/a', path: 'Jupiter (buy-only)',
          });
          if (vb.history.length > 200) vb.history = vb.history.slice(0, 200);
          return;
        }
      } else {
        throw sellErr;
      }
    }

    // Both legs succeeded
    S.volumeBot._lastSuccessTs = Date.now();
    vbRecordSuccess(wallet.publicKey, sol, fees + 0.00003, null, 'Jupiter');
    vbLog(`✓ [Jupiter fallback] +${(sol * 2).toFixed(4)} SOL vol`, 'success');

  } catch (e) {
    vbLog(`✕ [Jupiter fallback] ${e.message}`, 'error');
    vbFail(); vb.stats.bundlesFailed++;
  }
}

// ── vbSignJupTx ───────────────────────────────
//
// Signs a base64-encoded transaction returned by Jupiter API.
// Handles both legacy (firstByte < 128) and versioned v0 (firstByte = 0x80).
// Identical algorithm to signJupiterTx() in sniper.js.
//
async function vbSignJupTx(base64Tx, privKeyB58) {
  const privBytes  = bs58decode(privKeyB58);
  const seed       = privBytes.slice(0, 32);
  const pkcs8      = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ...seed,
  ]);
  const signingKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']
  );

  const txBytes     = Uint8Array.from(atob(base64Tx), c => c.charCodeAt(0));
  const firstByte   = txBytes[0];
  const isVersioned = firstByte >= 128;

  // Versioned v0: [0x80][numSigs compact-u16][sigs…][message]
  // Legacy:       [numSigs][sigs…][message]
  // numSigs ≤ 127 encodes as a single byte in compact-u16, so txBytes[1] works.
  const numSigs   = isVersioned ? txBytes[1] : firstByte;
  const msgOffset = (isVersioned ? 2 : 1) + 64 * numSigs;
  const msgBytes  = txBytes.slice(msgOffset);

  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, signingKey, msgBytes)
  );
  const signed = new Uint8Array(txBytes);
  signed.set(signature, isVersioned ? 2 : 1);

  return btoa(String.fromCharCode(...signed));
}

// ── Shared record-success helper ──────────────
function vbRecordSuccess(walletPub, sol, fees, bundleId, path) {
  const vb = S.volumeBot;
  vb.stats.cycles++;
  vb.stats.volumeAdded = parseFloat(vb.stats.volumeAdded || 0) + sol * 2;
  vb.stats.feesPaid    = parseFloat(vb.stats.feesPaid    || 0) + fees;
  vb.lastCycle         = Date.now();
  vb.ai.ok++;
  vb.ai.fail = 0;
  vb.history = vb.history || [];
  vb.history.unshift({
    id: uid(), ts: new Date().toISOString(),
    wallet: walletPub, solUsed: sol,
    volume: sol * 2, fees, netResult: -fees,
    bundleId: bundleId || 'n/a',
    path: path || (vb._migStatus === 'raydium' ? 'Jupiter' : 'Pump.fun'),
  });
  if (vb.history.length > 200) vb.history = vb.history.slice(0, 200);
}

// ── Migration badge (live DOM update) ─────────
// NEW: badge also shows current interval mode (aggressive/anti-afk/ai)
function vbUpdateMigBadge() {
  const vb = S.volumeBot;
  const el = document.getElementById('vb-mig-badge');
  if (!el) return;

  // Build mode suffix
  let modeSuffix = '';
  if (vb._afkActive) {
    modeSuffix = ' • 🛡️ Anti-AFK';
  } else if (vb.aggressiveMode) {
    modeSuffix = ' • ⚡ Aggressive';
  } else if (vb.intervalSeconds === 0) {
    const sec = vb.nextIn;
    modeSuffix = sec ? ` • ${sec}s` : ' • AI';
  }

  if (vb._migStatus === 'raydium') {
    el.textContent = '🔄 Raydium' + modeSuffix;
    el.className   = 'vb-mig-badge vb-mig-raydium';
  } else if (vb._migStatus === 'pump') {
    el.textContent = '🟢 Pump.fun' + modeSuffix;
    el.className   = 'vb-mig-badge vb-mig-pump';
  } else {
    el.textContent = '⏳ Detecting…' + modeSuffix;
    el.className   = 'vb-mig-badge vb-mig-unknown';
  }
}

// ── Wallet helpers ───────────────────────────
function vbActiveWallets() {
  const vb=S.volumeBot; const sel=new Set(vb.selectedWalletIds||[]);
  if (vb.walletMode==='existing') {
    return S.savedWallets.filter(w=>{
      if (!w.privateKey||!w.publicKey) return false;
      if (sel.size>0&&!sel.has(w.id)) return false;
      const b=vbGetBal(w.publicKey)??parseFloat(balanceCache?.[w.publicKey]?.sol||0);
      return b>=0.1;
    });
  }
  return (vb.generatedWallets||[]).filter(w=>w.privateKey&&w.publicKey);
}
function vbFail() {
  S.volumeBot.ai.fail++; S.volumeBot.ai.ok=0;
  if (S.volumeBot.ai.fail>=VB_FAIL_MAX) { vbLog(`🛑 Circuit breaker (${VB_FAIL_MAX} fails)`,'error'); vbStop('Circuit breaker'); }
}
function vbSched() {
  if (!VB.running || VB.stopReq) return;
  const vb = S.volumeBot;

  // NEW: hourly cap check — pause and check again in 60s
  if (vbAtHourlyCap()) {
    vbLog('⏸ Max volume/hour reached — pausing until cap resets', 'warn');
    const el = document.getElementById('vb-countdown');
    if (el) el.textContent = 'Hourly cap — waiting…';
    VB.timer = setTimeout(() => vbSched(), 60_000);
    return;
  }

  let sec;
  // NEW: Anti-AFK overrides normal interval
  if (vbShouldAntiAfk()) {
    if (!vb._afkActive) {
      vb._afkActive = true;
      vbLog('🛡️ Anti-AFK activated — keeping chart alive', 'warn');
    }
    sec = VB_AFKAFK_MIN + Math.floor(Math.random() * (VB_AFKAFK_MAX - VB_AFKAFK_MIN));
  } else {
    if (vb._afkActive) {
      vb._afkActive = false;
      vbLog('🟢 Anti-AFK deactivated — resuming normal cycles', 'info');
    }
    // Normal interval: AI or manual
    if (vb.intervalSeconds === 0) {
      sec = vbAiSec(vb._curve, vb.ai);
    } else {
      // IMPROVED: manual minimum is now 5s instead of 10s
      sec = Math.max(5, parseInt(vb.intervalSeconds) || 30);
    }
  }

  vb.nextIn = sec;
  saveState();
  vbCd(sec);
  vbUpdateMigBadge(); // refresh badge so it shows current mode
  VB.timer = setTimeout(() => { vb.nextIn = null; vbRunCycle(); }, sec * 1000);
}
function vbCd(sec) {
  if (_vbCdInterval) clearInterval(_vbCdInterval);
  let r=sec;
  const tick=()=>{ const el=document.getElementById('vb-countdown'); if(el) el.textContent=`Next in ${r}s`; if(r<=0) clearInterval(_vbCdInterval); r--; };
  tick(); _vbCdInterval=setInterval(tick,1000);
}

// ── Generate & fund ──────────────────────────
async function vbGenFund() {
  const vb=S.volumeBot;
  const n=parseInt(vb.newWalletCount)||5;
  const tot=parseFloat(vb._fundTotal)||1.0;
  const src=S.savedWallets.find(w=>w.id===vb.sourceWalletId);
  if (!src?.privateKey) { showToast('Select a source wallet first'); return; }
  const per=tot/n;
  if (tot>5&&!confirm(`Fund ${n} wallets × ${per.toFixed(4)} SOL = ${tot} SOL total?`)) return;
  vbLog(`Generating ${n} wallets, ${per.toFixed(4)} SOL each…`,'info');
  const fresh=[];
  for (let i=0;i<n;i++) { const kp=await generateKeypair(); fresh.push({id:uid(),publicKey:kp.publicKey,privateKey:kp.privateKey}); }
  vb.generatedWallets=[...(vb.generatedWallets||[]),...fresh];
  await saveState(); render();
  for (const w of fresh) {
    try { await vbSendSol(src,w.publicKey,per); vbLog(`✓ Funded ${short(w.publicKey)}: ${per.toFixed(4)} SOL`,'success'); await vbFetchBal(w.publicKey); }
    catch(e) { vbLog(`✕ Fund failed ${short(w.publicKey)}: ${e.message}`,'error'); }
  }
  await saveState(); render(); showToast(`✓ ${n} wallets generated & funded`);
}
async function vbRefundOne(id) {
  const vb=S.volumeBot; const w=vb.generatedWallets?.find(x=>x.id===id);
  if (!w?.privateKey) return;
  const src=S.savedWallets.find(x=>x.id===vb.sourceWalletId);
  if (!src?.publicKey) { showToast('Source wallet not set'); return; }
  const bal=await vbFetchBal(w.publicKey)??0;
  if (bal<0.00001) { showToast('Balance too low'); return; }
  try { await vbSendSol(w,src.publicKey,bal-0.000010); vbLog(`↩ Refunded ${short(w.publicKey)}`,'success'); showToast('✓ Refunded'); await vbFetchBal(w.publicKey); await vbFetchBal(src.publicKey); render(); }
  catch(e) { showToast(`Refund failed: ${e.message}`); }
}
async function vbRefundAll() {
  const vb=S.volumeBot; const src=S.savedWallets.find(x=>x.id===vb.sourceWalletId);
  if (!src?.publicKey) { vbLog('⚠ No source wallet','warn'); return; }
  vbLog('↩ Refunding all…','info');
  for (const w of (vb.generatedWallets||[])) {
    if (!w.privateKey) continue;
    const bal=await vbFetchBal(w.publicKey)??0;
    if (bal<0.000010) continue;
    try { await vbSendSol(w,src.publicKey,bal-0.000010); vbLog(`↩ ${short(w.publicKey)}: ${(bal-0.000010).toFixed(4)} SOL`,'success'); }
    catch(e) { vbLog(`✕ ${short(w.publicKey)}: ${e.message}`,'error'); }
  }
}
async function vbDelGen(id) {
  const vb  = S.volumeBot;
  const w   = vb.generatedWallets?.find(x => x.id === id);
  if (!w) return;

  const src = S.savedWallets.find(x => x.id === vb.sourceWalletId);
  if (src?.publicKey && w.privateKey) {
    // Fetch fresh balance so we know exactly what to refund
    const bal = await vbFetchBal(w.publicKey) ?? 0;
    if (bal > 0.000_010) {
      try {
        await vbSendSol(w, src.publicKey, bal - 0.000_010);
        vbLog(`↩ Refunded ${bal.toFixed(4)} SOL from ${short(w.publicKey)} → source`, 'success');
        // Refresh source balance so UI shows updated amount
        await vbFetchBal(src.publicKey);
        showToast(`✓ Refunded ${bal.toFixed(4)} SOL to source wallet`);
      } catch (e) {
        vbLog(`⚠ Refund failed for ${short(w.publicKey)}: ${e.message}`, 'warn');
        showToast(`Wallet deleted (refund failed: ${e.message.slice(0, 40)})`);
      }
    } else {
      showToast('Wallet deleted (balance too low to refund)');
    }
  } else {
    showToast('Wallet deleted (no source wallet set for refund)');
  }

  vb.generatedWallets = vb.generatedWallets.filter(x => x.id !== id);
  await saveState();
  render();
}

// ── Start / stop ─────────────────────────────
async function vbStart() {
  const vb=S.volumeBot;
  if (!vb.targetCA||vb.targetCA.length<32) { showToast('Enter a valid token CA first'); return; }
  if (!vbActiveWallets().length) { showToast('No eligible wallets (need ≥0.1 SOL)'); return; }
  vbLog('🤖 AI Volume Bot starting…','info');
  vb.active=true; vb.ai={ok:0,fail:0};
  // NEW: reset anti-AFK and cycle tracking state
  vb._afkActive = false; vb._isAfkCycle = false; vb._lastSuccessTs = Date.now();
  vb.stats=vb.stats||{cycles:0,volumeAdded:0,feesPaid:0,bundlesFailed:0};
  VB.running=true; VB.stopReq=false; VB.idx=0;
  await saveState(); render();
  await vbRunCycle();
}
async function vbStop(reason) {
  VB.running=false; VB.stopReq=true;
  if (VB.timer) { clearTimeout(VB.timer); VB.timer=null; }
  if (_vbCdInterval) { clearInterval(_vbCdInterval); _vbCdInterval=null; }
  S.volumeBot.active=false; S.volumeBot.nextIn=null;
  if (reason) vbLog(`🛑 Stopped: ${reason}`,'warn'); else vbLog('🛑 Bot stopped.','info');
  if (S.volumeBot.returnSolOnStop&&S.volumeBot.walletMode==='generate') await vbRefundAll();
  await saveState(); render();
}



// ── Injected styles ───────────────────────────
(function vbInjectStyles() {
  if (document.getElementById('vb-injected-css')) return;
  const s = document.createElement('style');
  s.id = 'vb-injected-css';
  s.textContent = `
/* ── VB: tabs ── */
.vb-tabs { display:flex; border-bottom:1px solid var(--border-md); margin:0 -14px; padding:0 14px; }

/* ── VB: stats strip ── */
.vb-stats-row { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; padding:12px 0 10px; }
.vb-stat { text-align:center; background:var(--surface); border:1px solid var(--border-md); border-radius:var(--r); padding:8px 4px 7px; min-width:0; }
.vb-stat-val { font-size:12px; font-weight:700; color:var(--navy); font-family:var(--mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.vb-stat-lbl { font-size:8px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; margin-top:2px; white-space:nowrap; }

/* ── VB: running banner ── */
.vb-running-banner { display:flex; justify-content:space-between; align-items:center; background:var(--green-bg); border:1px solid rgba(34,197,94,.25); border-radius:var(--r); padding:7px 11px; margin-top:12px; font-size:10.5px; font-weight:600; color:var(--green-dim); gap:8px; }
.vb-countdown { font-size:9.5px; color:var(--text-dim); font-family:var(--mono); font-weight:400; }

/* ── VB: AI toggle row ── */
.vb-ai-row { display:flex; align-items:center; gap:5px; }
.vb-ai-label { font-size:9.5px; color:var(--text-muted); font-weight:600; letter-spacing:.04em; }
.vb-ai-hint { display:flex; align-items:center; gap:5px; background:rgba(13,31,74,.04); border:1px solid var(--border-md); border-radius:var(--r-sm); padding:7px 10px; font-size:10px; font-weight:600; color:var(--navy); }

/* ── VB: divider ── */
.vb-divider { height:1px; background:var(--border-md); margin:12px 0; }

/* ── VB: SOL pill in tpicker rows ── */
.tpicker-sol { font-family:var(--mono); font-size:9px; font-weight:600; color:var(--blue); flex-shrink:0; margin-left:auto; padding-right:4px; white-space:nowrap; }
.tpicker-sol.low { color:var(--danger); }
.vb-low-opacity { opacity:.45; }

/* ── VB: picker header row (select-all + refresh together) ── */
.vb-picker-toolbar { display:flex; justify-content:space-between; align-items:center; padding:5px 10px 4px; border-bottom:1px solid var(--border); }
.vb-picker-toolbar-left { font-size:9.5px; color:var(--text-muted); }
.vb-picker-toolbar-right { display:flex; align-items:center; gap:4px; }
.vb-sel-all-btn { font-size:9px; background:none; border:none; color:var(--navy); cursor:pointer; font-weight:600; padding:2px 6px; border-radius:3px; font-family:var(--sans); }
.vb-sel-all-btn:hover { background:var(--navy-ghost2); }
.vb-icon-btn { width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center; background:none; border:1px solid var(--border-md); border-radius:4px; cursor:pointer; color:var(--text-dim); font-size:12px; transition:all .12s; flex-shrink:0; }
.vb-icon-btn:hover { background:var(--navy-ghost2); border-color:var(--border-hi); color:var(--navy); }
.vb-icon-btn.spinning { animation:spin .7s linear infinite; pointer-events:none; opacity:.6; }

/* ── VB: gen panel ── */
.vb-gen-panel { background:var(--surface); border:1px solid var(--border-md); border-radius:var(--r); padding:10px; }
.vb-gen-inputs { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px; }
.vb-gen-inputs .field { margin-bottom:0; }

/* ── VB: generated wallet accordion ── */
.vb-gen-accordion { margin-top:12px; border-top:1px solid var(--border-md); padding-top:10px; }
.vb-gen-accordion-hdr {
  display:flex; align-items:center; justify-content:space-between;
  cursor:pointer; user-select:none; padding:0 0 2px;
  gap:8px;
}
.vb-gen-accordion-title { font-size:10px; font-weight:700; color:var(--navy); letter-spacing:.01em; }
.vb-gen-accordion-meta { font-size:9px; color:var(--text-muted); }
.vb-gen-accordion-actions { display:flex; gap:4px; align-items:center; }
.vb-gen-chevron { font-size:14px; color:var(--text-muted); transition:transform .15s; line-height:1; display:inline-block; }
.vb-gen-chevron.open { transform:rotate(90deg); }
.vb-gen-body { margin-top:8px; display:flex; flex-direction:column; gap:5px; }

.vb-gen-wallet-card {
  background:var(--surface2);
  border:1px solid var(--border-md);
  border-radius:var(--r-sm);
  padding:8px 10px;
  display:flex;
  align-items:center;
  gap:10px;
}
.vb-gen-wallet-card:hover { border-color:var(--border-hi); }
.vb-gen-wallet-left { flex:1; min-width:0; }
.vb-gen-wallet-pub {
  font-family:var(--mono); font-size:9.5px; color:var(--navy);
  cursor:pointer; display:block; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis;
  margin-bottom:3px;
}
.vb-gen-wallet-pub:hover { text-decoration:underline; }
.vb-gen-wallet-bal-pill {
  display:inline-block; font-family:var(--mono); font-size:8.5px; font-weight:700;
  color:var(--blue); background:var(--blue-bg); border-radius:10px;
  padding:1px 6px;
}
.vb-gen-wallet-bal-pill.stale { color:var(--text-muted); background:var(--surface3); }
.vb-gen-wallet-right { display:flex; gap:4px; flex-shrink:0; }
/* orange copy-key button */
.vb-copy-key-btn {
  display:inline-flex; align-items:center; justify-content:center;
  width:26px; height:26px;
  background:rgba(217,119,6,.1); border:1px solid rgba(217,119,6,.3);
  border-radius:var(--r-sm); cursor:pointer; color:var(--warn);
  font-size:12px; transition:all .12s; flex-shrink:0;
}
.vb-copy-key-btn:hover { background:rgba(217,119,6,.2); border-color:var(--warn); }
.vb-copy-key-btn:active { transform:scale(.92); }

/* ── VB: console ── */
.vb-console-toolbar { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
.vb-console-count { font-size:9.5px; font-weight:700; letter-spacing:.06em; color:var(--text-dim); text-transform:uppercase; }
.vb-console {
  background:var(--surface); border:1px solid var(--border-md);
  border-radius:var(--r); padding:0; max-height:360px; overflow-y:auto;
}
.vb-console::-webkit-scrollbar { width:3px; }
.vb-console::-webkit-scrollbar-thumb { background:var(--border-md); border-radius:3px; }
.vb-log-entry {
  display:grid; grid-template-columns:72px 1fr;
  gap:0; padding:4px 8px;
  border-bottom:1px solid rgba(13,31,74,.05);
  line-height:1.45; align-items:baseline;
}
.vb-log-entry:last-child { border-bottom:none; }
.vb-log-ts {
  font-family:var(--mono); font-size:8.5px;
  color:var(--text-muted); flex-shrink:0;
  padding-top:1px; white-space:nowrap;
}
.vb-log-msg { font-family:var(--mono); font-size:9.5px; word-break:break-word; }

/* type colors */
.vb-log-buy     { background:rgba(34,197,94,.04); }
.vb-log-buy     .vb-log-msg { color:#16a34a; }
.vb-log-sell    { background:rgba(217,119,6,.04); }
.vb-log-sell    .vb-log-msg { color:#b45309; }
.vb-log-success { background:rgba(34,197,94,.07); }
.vb-log-success .vb-log-msg { color:#15803d; font-weight:700; }
.vb-log-error   { background:rgba(220,38,38,.05); }
.vb-log-error   .vb-log-msg { color:#dc2626; }
.vb-log-warn    { background:rgba(217,119,6,.06); }
.vb-log-warn    .vb-log-msg { color:#d97706; }
.vb-log-info    .vb-log-msg { color:var(--text-mid); }
.vb-log-ts-date { color:var(--warn); }

/* ── VB: history ── */
.vb-history-toolbar { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
.vb-hist-count { font-size:9.5px; font-weight:700; letter-spacing:.06em; color:var(--text-dim); text-transform:uppercase; }
.vb-history-table { border:1px solid var(--border-md); border-radius:var(--r); overflow:hidden; }
.vb-hist-hdr { display:grid; grid-template-columns:60px 70px 58px 62px 80px 70px; background:var(--surface2); padding:5px 10px; font-size:8.5px; font-weight:700; color:var(--text-dim); text-transform:uppercase; letter-spacing:.05em; gap:4px; }
.vb-hist-row { display:grid; grid-template-columns:60px 70px 58px 62px 80px 70px; padding:6px 10px; border-bottom:1px solid var(--border); align-items:center; gap:4px; font-size:9.5px; }
.vb-hist-row:last-child { border-bottom:none; }
.vb-hist-row:hover { background:var(--surface); }
.vb-hist-time   { color:var(--text-muted); font-family:var(--mono); font-size:8.5px; }
.vb-hist-wallet { font-family:var(--mono); color:var(--navy); cursor:pointer; font-size:9px; }
.vb-hist-sol, .vb-hist-vol, .vb-hist-fees { font-family:var(--mono); color:var(--text-mid); }
.vb-hist-net { font-family:var(--mono); font-weight:600; }
.vb-hist-net.pos { color:var(--green-dim); }
.vb-hist-net.neg { color:var(--danger); }

/* ── VB: migration status badge ── */
.vb-mig-badge {
  display:inline-flex; align-items:center; gap:5px;
  font-size:9.5px; font-weight:600;
  padding:3px 8px; border-radius:20px;
  margin-top:6px; margin-bottom:2px;
  border:1px solid transparent;
}
.vb-mig-pump {
  color:var(--green-dim);
  background:var(--green-bg);
  border-color:rgba(34,197,94,.25);
}
.vb-mig-raydium {
  color:var(--blue);
  background:var(--blue-bg);
  border-color:rgba(59,130,246,.25);
}
.vb-mig-unknown {
  color:var(--text-muted);
  background:var(--surface2);
  border-color:var(--border-md);
}
/* NEW: mode pill inside config */
.vb-mode-pill {
  display:inline-flex; align-items:center; gap:4px;
  font-size:8.5px; font-weight:700; padding:2px 7px;
  border-radius:10px; letter-spacing:.03em; flex-shrink:0;
}
.vb-pill-agg { background:rgba(239,68,68,.1); color:#dc2626; border:1px solid rgba(220,38,38,.25); }
.vb-pill-afk { background:rgba(59,130,246,.1); color:var(--blue); border:1px solid rgba(59,130,246,.25); }
.vb-pill-ai  { background:var(--navy-ghost2); color:var(--navy); border:1px solid var(--border-md); }
  `;
  document.head.appendChild(s);
})();

// ── Page ──────────────────────────────────────
function buildVolumeBotPage() {
  const vb  = S.volumeBot;
  const tab = vb._tab || 'config';
  const on  = vb.active;
  return `
    <div class="tool-header">
      <div class="tool-title-row">
        <span class="tool-title">AI Volume Bot</span>
        <div style="display:flex;gap:5px;align-items:center">
          ${on ? `<span class="live-badge">● LIVE</span>` : ''}
          <button class="btn ${on ? 'btn-danger' : 'btn-primary'} btn-sm"
            data-action="${on ? 'vb-stop' : 'vb-start'}">${on ? '⏹ Stop' : '▶ Start'}</button>
        </div>
      </div>
      <div class="vb-tabs">
        <button class="tab ${tab==='config'  ? 'active' : ''}" data-action="vb-tab" data-tab="config">Config</button>
        <button class="tab ${tab==='console' ? 'active' : ''}" data-action="vb-tab" data-tab="console">Console${vb.log?.length ? ` <span class="nav-badge" style="background:var(--navy-ghost2);color:var(--navy);font-size:7px;padding:1px 4px">${Math.min(vb.log.length,99)}</span>` : ''}</button>
        <button class="tab ${tab==='history' ? 'active' : ''}" data-action="vb-tab" data-tab="history">History${vb.history?.length ? ` (${vb.history.length})` : ''}</button>
      </div>
    </div>
    <div class="scroll-area" id="scroll-area">
      ${tab === 'config' ? buildVbConfig() : tab === 'console' ? buildVbConsole() : buildVbHistory()}
    </div>`;
}

// ── Config tab ────────────────────────────────
function buildVbConfig() {
  const vb    = S.volumeBot;
  const on    = vb.active;
  const stats = vb.stats || {};
  const aiInt = vb.intervalSeconds === 0;
  const aiSz  = vb.minSOL === 0 && vb.maxSOL === 0;
  const dis   = on ? '<div style="opacity:.5;pointer-events:none">' : '<div>';

  return `
    <div class="vb-stats-row">
      <div class="vb-stat">
        <div class="vb-stat-val" id="vb-stat-cycles">${stats.cycles || 0}</div>
        <div class="vb-stat-lbl">Cycles</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="vb-stat-volume">${parseFloat(stats.volumeAdded || 0).toFixed(2)} SOL</div>
        <div class="vb-stat-lbl">Volume</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="vb-stat-fees">${parseFloat(stats.feesPaid || 0).toFixed(4)}</div>
        <div class="vb-stat-lbl">Fees SOL</div>
      </div>
      <div class="vb-stat">
        <div class="vb-stat-val" id="vb-stat-fails">${stats.bundlesFailed || 0}</div>
        <div class="vb-stat-lbl">Failures</div>
      </div>
    </div>

    ${dis}
      <div class="field">
        <div class="field-label">Target Coin CA
          <button class="help-q" id="h-vb-ca" data-action="show-help" data-title="Target Coin CA"
            data-body="The mint address of the Pump.fun token to generate volume for. Works on both pre-migration (bonding curve) and post-migration (Raydium via Jupiter) tokens — auto-detects each cycle.">?</button>
        </div>
        <input type="text" placeholder="Token mint address…"
          value="${vb.targetCA || ''}" data-vb-field="targetCA"/>
      </div>
      <div id="vb-mig-badge" class="vb-mig-badge vb-mig-unknown">⏳ Detecting…</div>

      <div class="vb-divider"></div>

      <div class="field">
        <div class="field-label" style="justify-content:space-between;flex-wrap:nowrap">
          <span style="white-space:nowrap">Interval (seconds)
            <button class="help-q" id="h-vb-interval" data-action="show-help" data-title="Cycle Interval"
              data-body="Seconds between buy/sell cycles. AI mode: 15–90s based on liquidity. Aggressive mode: 8–35s. Manual minimum is 5s.">?</button>
          </span>
          <div class="vb-ai-row">
            <div class="toggle ${aiInt ? 'on' : ''}" data-action="vb-toggle-ai-int"></div>
            <span class="vb-ai-label">AI</span>
          </div>
        </div>
        ${aiInt
          ? `<div class="vb-ai-hint">🤖 AI decides: 15–90s based on liquidity &amp; streaks</div>`
          : `<input type="number" min="5" max="3600" step="5" placeholder="30"
               value="${vb.intervalSeconds || 30}" data-vb-field="intervalSeconds"/>`}
      </div>

      <!-- NEW: Aggressive Mode -->
      <div class="sf-toggle-row" style="margin-bottom:10px">
        <div class="sf-toggle-left">
          <div class="field-label" style="margin-bottom:0">
            ⚡ Aggressive Mode
            <button class="help-q" id="h-vb-agg" data-action="show-help" data-title="Aggressive Mode"
              data-body="Cuts AI interval range to 8–35 seconds for maximum volume throughput. Use on coins with strong liquidity. Only applies when AI Interval is on.">?</button>
            ${vb.aggressiveMode ? '<span class="vb-mode-pill vb-pill-agg">ACTIVE</span>' : ''}
          </div>
          <div class="sf-toggle-hint">8–35s AI intervals for max volume</div>
        </div>
        <div class="sf-toggle-right">
          <div class="toggle ${vb.aggressiveMode ? 'on' : ''}" data-action="vb-toggle-aggressive"></div>
        </div>
      </div>

      <div class="field">
        <div class="field-label" style="justify-content:space-between;flex-wrap:nowrap">
          <span style="white-space:nowrap">SOL per Cycle (min – max)
            <button class="help-q" id="h-vb-sol" data-action="show-help" data-title="SOL per Cycle"
              data-body="Random amount between min and max each cycle. Set both to 0 for AI mode — AI can size up to 10 SOL when liquidity supports it.">?</button>
          </span>
          <div class="vb-ai-row">
            <div class="toggle ${aiSz ? 'on' : ''}" data-action="vb-toggle-ai-size"></div>
            <span class="vb-ai-label">AI</span>
          </div>
        </div>
        ${aiSz
          ? `<div class="vb-ai-hint">🤖 AI decides size (up to 10 SOL) from liquidity &amp; balance</div>`
          : `<div style="display:flex;gap:6px;align-items:center">
               <input type="number" min="0.01" max="100" step="0.05" placeholder="0.10"
                 value="${vb.minSOL != null ? parseFloat(vb.minSOL).toFixed(2) : ''}"
                 data-vb-field="minSOL" style="flex:1"/>
               <span style="font-size:11px;color:var(--text-muted);flex-shrink:0">–</span>
               <input type="number" min="0.01" max="100" step="0.05" placeholder="1.00"
                 value="${vb.maxSOL != null ? parseFloat(vb.maxSOL).toFixed(2) : ''}"
                 data-vb-field="maxSOL" style="flex:1"/>
               <span style="font-size:10px;color:var(--text-muted);flex-shrink:0">SOL</span>
             </div>`}
      </div>

      <!-- NEW: Max Volume per Hour cap -->
      <div class="field">
        <div class="field-label">
          Max Volume / Hour
          <button class="help-q" id="h-vb-cap" data-action="show-help" data-title="Max Volume per Hour"
            data-body="Optional SOL cap on total volume per 60-minute window. Bot pauses automatically when the cap is hit and resumes when the window rolls. Set to 0 to disable.">?</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="number" min="0" max="10000" step="1" placeholder="0 (no cap)"
            value="${vb.maxVolPerHour != null ? parseFloat(vb.maxVolPerHour) || '' : ''}"
            data-vb-field="maxVolPerHour" style="flex:1"/>
          <span style="font-size:10px;color:var(--text-muted);flex-shrink:0">SOL</span>
        </div>
      </div>

      <!-- NEW: Anti-AFK Mode -->
      <div class="sf-toggle-row" style="margin-bottom:10px">
        <div class="sf-toggle-left">
          <div class="field-label" style="margin-bottom:0">
            🛡️ Anti-AFK Mode
            <button class="help-q" id="h-vb-afk" data-action="show-help" data-title="Anti-AFK Mode"
              data-body="When the chart has been quiet for 15+ minutes with no successful cycles, the bot automatically switches to tiny keep-alive trades (0.02 SOL every 8–20s) to keep the token active. Deactivates automatically once normal cycles resume.">?</button>
            ${vb._afkActive ? '<span class="vb-mode-pill vb-pill-afk">ACTIVE</span>' : ''}
          </div>
          <div class="sf-toggle-hint">Auto keep-alive after 15 min idle</div>
        </div>
        <div class="sf-toggle-right">
          <div class="toggle ${vb.antiAfkEnabled ? 'on' : ''}" data-action="vb-toggle-antifak"></div>
        </div>
      </div>

      <!-- NEW: Sell Delay config -->
      <div class="field">
        <div class="field-label">
          Sell Delay (ms)
          <button class="help-q" id="h-vb-delay" data-action="show-help" data-title="Sell Delay"
            data-body="Milliseconds to wait between sending the buy and fetching the sell quote. Lower = faster volume but riskier. Higher = more reliable but slower. Default 600ms is a good balance for Raydium memecoins.">?</button>
        </div>
        <input type="number" min="200" max="5000" step="100" placeholder="600"
          value="${vb.sellDelayMs != null ? parseInt(vb.sellDelayMs) || 600 : 600}"
          data-vb-field="sellDelayMs" style="max-width:120px"/>
      </div>

      <div class="vb-divider"></div>

      <div class="field">
        <div class="field-label">Wallet Mode
          <button class="help-q" id="h-vb-wmode" data-action="show-help" data-title="Wallet Mode"
            data-body="Use Existing: rotate through your saved funded wallets. Generate New: create fresh wallets auto-funded from a source.">?</button>
        </div>
        <div class="mode-toggle">
          <button class="mode-btn ${vb.walletMode === 'existing' ? 'active' : ''}"
            data-action="vb-mode" data-mode="existing">Use Existing</button>
          <button class="mode-btn ${vb.walletMode === 'generate' ? 'active' : ''}"
            data-action="vb-mode" data-mode="generate">Generate New</button>
        </div>
      </div>

      ${vb.walletMode === 'existing' ? buildVbExisting() : buildVbGenerate()}
    </div>

    ${on ? `<div class="vb-running-banner">
      <span>🟢 Bot is running</span>
      <span class="vb-countdown" id="vb-countdown">…</span>
    </div>` : ''}`;
}

// ── Existing wallet picker ─────────────────────
function buildVbExisting() {
  const vb   = S.volumeBot;
  const sel  = new Set(vb.selectedWalletIds || []);
  const open = !!vb._existOpen;
  const all  = S.savedWallets.filter(w => w.publicKey && w.privateKey);
  const grps = S.walletGroups || [];
  const ung  = all.filter(w => !w.groupId);
  const cnt  = sel.size;

  return `
    <div class="cpicker-wrap" style="margin-bottom:14px">
      <div class="cpicker-btn ${cnt > 0 ? 'cpicker-selected' : ''}" data-action="vb-exist-toggle">
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
              <button class="vb-icon-btn" data-action="vb-refresh-bals" id="vb-refresh-btn" title="Refresh balances">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M9.5 5.5A4 4 0 1 1 7 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                  <path d="M7 1v2.2H9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button class="vb-sel-all-btn" data-action="vb-sel-all">
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
              <div class="tpicker-group-hdr" data-action="vb-sel-grp" data-gid="${g.id}">
                <div class="tpicker-check ${allS ? 'checked' : somS ? 'partial' : ''}"></div>
                <span>${g.emoji || '📁'}</span>
                <span class="tpicker-group-name">${g.name}</span>
                <span class="tpicker-count">${gw.length}</span>
              </div>
              ${gw.map(w => vbWRow(w, sel)).join('')}`;
          }).join('')}

          ${ung.map(w => vbWRow(w, sel)).join('')}

          ${all.length === 0
            ? `<div class="cpicker-empty">No wallets with private keys.<br>Add some in the Wallets tab.</div>`
            : ''}

          <div class="cpicker-divider"></div>
          <div class="cpicker-paste-label">Or paste private key</div>
          <div style="display:flex;gap:5px;padding:0 8px 8px">
            <input type="password" id="vb-paste-priv" placeholder="Base58 private key…"
              style="flex:1;font-size:10.5px"/>
            <button class="btn btn-ghost btn-sm" data-action="vb-paste-use">Use</button>
          </div>
        </div>` : ''}
    </div>`;
}

function vbWRow(w, sel) {
  const bal = vbGetBal(w.publicKey);
  const low = bal !== null && bal < 0.1;
  return `
    <div class="tpicker-wallet-row ${sel.has(w.id) ? 'selected' : ''} ${low ? 'vb-low-opacity' : ''}"
      data-action="vb-sel-w" data-wid="${w.id}">
      <div class="tpicker-check ${sel.has(w.id) ? 'checked' : ''}"></div>
      <span>${w.emoji || '💼'}</span>
      <div class="tpicker-info">
        <span class="tpicker-name">${w.name || 'Wallet'}</span>
        <span class="tpicker-addr">${short(w.publicKey)}</span>
      </div>
      <span class="tpicker-sol ${low ? 'low' : ''}">${bal !== null ? `${bal.toFixed(2)} SOL` : '—'}</span>
    </div>`;
}

// ── Generate panel ────────────────────────────
function buildVbGenerate() {
  const vb  = S.volumeBot;
  const gen = vb.generatedWallets || [];
  const src = S.savedWallets.find(w => w.id === vb.sourceWalletId);
  const srcBal = src?.publicKey ? vbGetBal(src.publicKey) : null;

  return `
    <div class="vb-gen-panel">
      <div class="vb-gen-inputs">
        <div class="field">
          <div class="field-label">Wallets</div>
          <input type="number" min="1" max="20" step="1"
            value="${vb.newWalletCount || 5}"
            data-vb-field="newWalletCount" placeholder="5"/>
        </div>
        <div class="field">
          <div class="field-label">Total SOL</div>
          <input type="number" min="0.01" step="0.10"
            value="${vb._fundTotal != null ? parseFloat(vb._fundTotal).toFixed(2) : '1.00'}"
            data-vb-field="_fundTotal" placeholder="1.00"/>
        </div>
      </div>

      <div class="field">
        <div class="field-label">Source Wallet
          <button class="help-q" id="h-vb-src" data-action="show-help" data-title="Source Wallet"
            data-body="Funds generated bot wallets and receives SOL back when you delete or refund them.">?</button>
        </div>
        <div class="cpicker-wrap">
          <div class="cpicker-btn ${src ? 'cpicker-selected' : ''}" data-action="vb-src-tog">
            ${src
              ? `<span>${src.emoji || '💼'}</span>
                 <div class="cpicker-row-info" style="flex:1;min-width:0">
                   <span class="cpicker-name">${src.name || 'Wallet'}</span>
                   <span class="cpicker-addr">${short(src.publicKey)}</span>
                 </div>
                 ${srcBal !== null ? `<span class="cpicker-bal">${srcBal.toFixed(4)} SOL</span>` : ''}`
              : `<span class="cpicker-name" style="color:var(--text-muted);flex:1">Select source wallet…</span>`}
            <span class="cpicker-chevron ${vb._srcOpen ? 'open' : ''}">›</span>
          </div>
          ${vb._srcOpen ? `
            <div class="cpicker-dropdown">
              ${S.savedWallets.filter(w => w.publicKey).map(w => {
                const b = vbGetBal(w.publicKey);
                return `<div class="cpicker-row ${w.id === vb.sourceWalletId ? 'active' : ''}"
                  data-action="vb-src-pick" data-wid="${w.id}">
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
                <input type="password" id="vb-src-paste" placeholder="Base58 private key…"
                  style="flex:1;font-size:10.5px"/>
                <button class="btn btn-ghost btn-sm" data-action="vb-src-paste-use">Use</button>
              </div>
            </div>` : ''}
        </div>
      </div>

      <div class="sf-toggle-row" style="margin-bottom:12px">
        <div class="sf-toggle-left">
          <div class="field-label" style="margin-bottom:0">Return SOL on Stop</div>
          <div class="sf-toggle-hint">Auto-refund generated wallets when bot stops</div>
        </div>
        <div class="sf-toggle-right">
          <div class="toggle ${vb.returnSolOnStop ? 'on' : ''}" data-action="vb-tog-return"></div>
        </div>
      </div>

      <button class="btn btn-primary btn-full" data-action="vb-gen"
        style="border-radius:var(--r)">+ Generate &amp; Fund Wallets</button>

      ${gen.length ? buildVbGenAccordion(gen) : ''}
    </div>`;
}

function buildVbGenAccordion(gen) {
  const vb      = S.volumeBot;
  const isOpen  = !!vb._genOpen;
  const totalBal = gen.reduce((s, w) => {
    const b = vbGetBal(w.publicKey);
    return s + (b !== null ? b : 0);
  }, 0);

  return `
    <div class="vb-gen-accordion">
      <div class="vb-gen-accordion-hdr" data-action="vb-gen-toggle">
        <span class="vb-gen-chevron ${isOpen ? 'open' : ''}">›</span>
        <span class="vb-gen-accordion-title">Generated Wallets (${gen.length})</span>
        <span class="vb-gen-accordion-meta">${totalBal.toFixed(4)} SOL total</span>
        <div class="vb-gen-accordion-actions" onclick="event.stopPropagation()">
          <button class="vb-icon-btn" data-action="vb-refresh-gen" id="vb-gen-ref-btn" title="Refresh balances">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M9.5 5.5A4 4 0 1 1 7 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
              <path d="M7 1v2.2H9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="btn btn-secondary btn-sm" data-action="vb-refund-all" style="font-size:9px;padding:2px 7px">↩ All</button>
        </div>
      </div>

      ${isOpen ? `
        <div class="vb-gen-body">
          ${gen.map(w => {
            const bal    = vbGetBal(w.publicKey);
            const balStr = bal !== null ? `${bal.toFixed(4)} SOL` : '— SOL';
            return `
              <div class="vb-gen-wallet-card">
                <div class="vb-gen-wallet-left">
                  <span class="vb-gen-wallet-pub link" data-action="copy" data-copy="${w.publicKey}"
                    title="Click to copy address">${short(w.publicKey)} ⧉</span>
                  <span class="vb-gen-wallet-bal-pill ${bal === null ? 'stale' : ''}">${balStr}</span>
                </div>
                <div class="vb-gen-wallet-right">
                  <button class="vb-copy-key-btn" data-action="vb-copy-key" data-priv="${encodeURIComponent(w.privateKey)}"
                    title="Copy private key">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <rect x="1" y="3.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
                      <path d="M3.5 3V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
                    </svg>
                  </button>
                  <button class="btn btn-secondary btn-sm" data-action="vb-refund-one" data-wid="${w.id}"
                    title="Refund to source" style="font-size:11px;padding:3px 7px">↩</button>
                  <button class="btn btn-danger btn-sm" data-action="vb-del-one" data-wid="${w.id}"
                    title="Delete &amp; refund" style="font-size:11px;padding:3px 7px">✕</button>
                </div>
              </div>`;
          }).join('')}
        </div>` : ''}
    </div>`;
}

// ── Console tab ───────────────────────────────
function buildVbConsole() {
  const logs = S.volumeBot.log || [];
  const today = new Date().toDateString();

  return `
    <div class="vb-console-toolbar">
      <span class="vb-console-count" id="vb-feed-count">${logs.length} entries</span>
      <button class="btn btn-secondary btn-sm" data-action="vb-clear-log">Clear</button>
    </div>
    <div class="vb-console" id="vb-feed">
      ${logs.length
        ? logs.map(e => {
            // Show date if log entry is from a different day
            const entryDate = e.fullDate || today;
            const tsDisplay = entryDate !== today
              ? `<span class="vb-log-ts-date">${entryDate.slice(4, 10)}</span> ${e.ts}`
              : e.ts;
            return `<div class="vb-log-entry vb-log-${e.type}">
              <span class="vb-log-ts">${tsDisplay}</span>
              <span class="vb-log-msg">${vbEsc(e.msg)}</span>
            </div>`;
          }).join('')
        : `<div class="vb-log-entry vb-log-info">
             <span class="vb-log-ts">—</span>
             <span class="vb-log-msg" style="color:var(--text-muted)">Start the bot to see activity.</span>
           </div>`}
    </div>`;
}

// ── History tab ───────────────────────────────
function buildVbHistory() {
  const hist = S.volumeBot.history || [];
  if (!hist.length) return `
    <div class="empty-state" style="padding:40px 20px">
      <div class="empty-icon">📊</div>
      <div class="empty-text">No completed cycles yet.<br>
        <span style="font-size:9.5px;color:var(--text-muted)">Appears after each successful bundle.</span>
      </div>
    </div>`;
  return `
    <div class="vb-history-toolbar">
      <span class="vb-hist-count">${hist.length} cycles</span>
      <button class="btn btn-secondary btn-sm" data-action="vb-clear-hist">Clear</button>
    </div>
    <div class="vb-history-table">
      <div class="vb-hist-hdr">
        <span>Time</span><span>Wallet</span><span>SOL In</span>
        <span>Volume</span><span>Fees</span><span>Path</span>
      </div>
      ${hist.map(h => {
        const t   = new Date(h.ts).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
        const net = parseFloat(h.netResult || 0);
        return `<div class="vb-hist-row">
          <span class="vb-hist-time">${t}</span>
          <span class="vb-hist-wallet link" data-action="copy" data-copy="${h.wallet}">${short(h.wallet)}</span>
          <span class="vb-hist-sol">${parseFloat(h.solUsed).toFixed(4)}</span>
          <span class="vb-hist-vol">${parseFloat(h.volume).toFixed(4)}</span>
          <span class="vb-hist-fees">${parseFloat(h.fees || 0).toFixed(6)}</span>
          <span class="vb-hist-net ${net >= 0 ? 'pos' : 'neg'}">${net.toFixed(6)}</span>
          <span class="vb-hist-fees" style="font-size:8.5px">${h.path || 'Pump'}</span>
        </div>`;
      }).join('')}
    </div>`;
}

// ── attachVolumeBotHandlers ───────────────────
function attachVolumeBotHandlers() {
  const vb = S.volumeBot;

  // Bind change → saveState on all vb-field inputs
  document.querySelectorAll('[data-vb-field]').forEach(el => {
    el.addEventListener('change', async function () {
      const field = this.dataset.vbField;
      let val     = this.value;
      if (this.type === 'number') val = val === '' ? '' : parseFloat(val) || 0;
      S.volumeBot[field] = val;
      await saveState();
    });
  });

  // Restore live countdown
  if (vb.active && vb.nextIn) vbCd(vb.nextIn);
  vbStatUpdate();
  vbUpdateMigBadge();

  // Auto-refresh balances if stale
  if (Date.now() - (vb._lastBalFetch || 0) > 60000) {
    vb._lastBalFetch = Date.now();
    vbRefreshAllBals();
  }
}

// ── handleVolumeBotAction ─────────────────────
async function handleVolumeBotAction(a, el) {
  const vb = S.volumeBot;

  if (a === 'vb-tab')   { vb._tab = el.dataset.tab; await saveState(); render(); return; }
  if (a === 'vb-start') { await vbStart(); return; }
  if (a === 'vb-stop')  { await vbStop();  return; }

  // AI toggles
  if (a === 'vb-toggle-ai-int') {
    // IMPROVED: default manual value is now 30s
    vb.intervalSeconds = vb.intervalSeconds === 0 ? 30 : 0;
    await saveState(); render(); return;
  }
  if (a === 'vb-toggle-ai-size') {
    if (vb.minSOL === 0 && vb.maxSOL === 0) { vb.minSOL = 0.10; vb.maxSOL = 1.00; }
    else { vb.minSOL = 0; vb.maxSOL = 0; }
    await saveState(); render(); return;
  }

  // NEW: Aggressive Mode toggle
  if (a === 'vb-toggle-aggressive') {
    vb.aggressiveMode = !vb.aggressiveMode;
    await saveState(); render(); return;
  }

  // NEW: Anti-AFK toggle
  if (a === 'vb-toggle-antifak') {
    vb.antiAfkEnabled = !vb.antiAfkEnabled;
    if (!vb.antiAfkEnabled) { vb._afkActive = false; vb._isAfkCycle = false; }
    await saveState(); render(); return;
  }

  // Mode
  if (a === 'vb-mode') { vb.walletMode = el.dataset.mode; await saveState(); render(); return; }

  // Existing picker
  if (a === 'vb-exist-toggle') { vb._existOpen = !vb._existOpen; await saveState(); render(); return; }

  if (a === 'vb-sel-w') {
    const id = el.dataset.wid;
    const ids = vb.selectedWalletIds = vb.selectedWalletIds || [];
    const i = ids.indexOf(id);
    i > -1 ? ids.splice(i, 1) : ids.push(id);
    await saveState(); render(); return;
  }

  if (a === 'vb-sel-all') {
    const all = S.savedWallets.filter(w => w.publicKey && w.privateKey);
    vb.selectedWalletIds = vb.selectedWalletIds?.length === all.length ? [] : all.map(w => w.id);
    await saveState(); render(); return;
  }

  if (a === 'vb-sel-grp') {
    const gid = el.dataset.gid;
    const gw  = S.savedWallets.filter(w => w.groupId === gid && w.publicKey && w.privateKey);
    const ids = vb.selectedWalletIds = vb.selectedWalletIds || [];
    const allS = gw.every(w => ids.includes(w.id));
    if (allS) gw.forEach(w => { const i = ids.indexOf(w.id); if (i > -1) ids.splice(i, 1); });
    else      gw.forEach(w => { if (!ids.includes(w.id)) ids.push(w.id); });
    await saveState(); render(); return;
  }

  if (a === 'vb-paste-use') {
    const raw = document.getElementById('vb-paste-priv')?.value?.trim();
    if (!raw) return;
    try {
      const kp  = vbKp(raw);
      const pub = bs58encode(kp.pub);
      let sw    = S.savedWallets.find(w => w.publicKey === pub);
      if (!sw) {
        sw = { id: uid(), name: 'Pasted Wallet', emoji: '💼', publicKey: pub, privateKey: raw, groupId: null };
        S.savedWallets.push(sw);
      }
      vb.selectedWalletIds = [...(vb.selectedWalletIds || [])];
      if (!vb.selectedWalletIds.includes(sw.id)) vb.selectedWalletIds.push(sw.id);
      vbFetchBal(pub).then(() => render());
      await saveState(); render();
    } catch { showToast('Invalid private key'); }
    return;
  }

  // Copy key — just copies, no reveal
  if (a === 'vb-copy-key') {
    const priv = decodeURIComponent(el.dataset.priv || '');
    if (priv) copyText(priv);
    return;
  }

  // Refresh balances
  if (a === 'vb-refresh-bals') {
    const btn = document.getElementById('vb-refresh-btn');
    if (btn) btn.classList.add('spinning');
    await vbRefreshAllBals();
    if (btn) btn.classList.remove('spinning');
    return;
  }

  if (a === 'vb-refresh-gen') {
    const btn = document.getElementById('vb-gen-ref-btn');
    if (btn) btn.classList.add('spinning');
    for (const w of (vb.generatedWallets || [])) if (w.publicKey) await vbFetchBal(w.publicKey);
    if (btn) btn.classList.remove('spinning');
    render(); return;
  }

  // Source picker
  if (a === 'vb-src-tog')  { vb._srcOpen = !vb._srcOpen; await saveState(); render(); return; }

  if (a === 'vb-src-pick') {
    vb.sourceWalletId = el.dataset.wid; vb._srcOpen = false;
    const src = S.savedWallets.find(w => w.id === vb.sourceWalletId);
    if (src?.publicKey) vbFetchBal(src.publicKey).then(() => render());
    await saveState(); render(); return;
  }

  if (a === 'vb-src-paste-use') {
    const raw = document.getElementById('vb-src-paste')?.value?.trim();
    if (!raw) return;
    try {
      const kp  = vbKp(raw);
      const pub = bs58encode(kp.pub);
      let sw    = S.savedWallets.find(w => w.publicKey === pub);
      if (!sw) {
        sw = { id: uid(), name: 'Pasted Source', emoji: '💼', publicKey: pub, privateKey: raw, groupId: null };
        S.savedWallets.push(sw);
      }
      vb.sourceWalletId = sw.id; vb._srcOpen = false;
      vbFetchBal(pub).then(() => render());
      await saveState(); render();
    } catch { showToast('Invalid private key'); }
    return;
  }

  // Generate mode toggles
  if (a === 'vb-tog-return') { vb.returnSolOnStop = !vb.returnSolOnStop; await saveState(); render(); return; }

  // Generate accordion toggle
  if (a === 'vb-gen-toggle') { vb._genOpen = !vb._genOpen; await saveState(); render(); return; }

  // Generate wallets
  if (a === 'vb-gen') {
    const nEl = document.querySelector('[data-vb-field="newWalletCount"]');
    const tEl = document.querySelector('[data-vb-field="_fundTotal"]');
    if (nEl?.value) vb.newWalletCount = parseInt(nEl.value)   || 5;
    if (tEl?.value) vb._fundTotal     = parseFloat(tEl.value) || 1.0;
    await saveState();
    await vbGenFund(); return;
  }

  if (a === 'vb-refund-one') { await vbRefundOne(el.dataset.wid); return; }
  if (a === 'vb-del-one')    { await vbDelGen(el.dataset.wid);    return; }
  if (a === 'vb-refund-all') { await vbRefundAll(); render(); return; }

  // Log / history
  if (a === 'vb-clear-log')  { vb.log = [];     await saveState(); render(); return; }
  if (a === 'vb-clear-hist') { vb.history = []; await saveState(); render(); return; }
}

// ── Patch vbLog to store full date ────────────
const _vbLogOrig = vbLog;
// eslint-disable-next-line no-func-assign
vbLog = function(msg, type) {
  // Store today's date string on every entry so console can show it for old logs
  const entry_date = new Date().toDateString();
  _vbLogOrig(msg, type);
  // Patch the most recent entry with fullDate
  if (S.volumeBot.log.length) S.volumeBot.log[0].fullDate = entry_date;
};