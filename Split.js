/* ═══════════════════════════════════════════
   split.js — Essor Studios / Ultimate Dev Tools
   Matches exact on-chain instruction layout observed on Solscan:
     #1  ComputeBudget: SetComputeUnitLimit
     #2  ComputeBudget: SetComputeUnitPrice
     #3  Associated Token Program: createIdempotent
         (inner: getAccountDataSize, createAccount, initializeImmutableOwner, initializeAccount3)
     #4  Token 2022 Program: transferChecked
═══════════════════════════════════════════ */
'use strict';

// ── Program IDs ────────────────────────────
const PROG_SPL        = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const PROG_TOKEN2022  = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const PROG_ATA        = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const PROG_SYSTEM     = '11111111111111111111111111111111';
const PROG_COMPUTE    = 'ComputeBudget111111111111111111111111111111';
const PUMP_AMM        = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP_BONDING    = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const HELIUS_KEY      = '9f6bffea-73da-4936-adab-429746a1b007';
const DEFAULT_RPC     = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const DEFAULT_WS      = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

// ── Endpoints ──────────────────────────────
function rpcUrl() {
  return (typeof S !== 'undefined' && S.settings?.rpcEndpoint) || DEFAULT_RPC;
}
function wsUrl() {
  return (typeof S !== 'undefined' && S.settings?.wsEndpoint) || DEFAULT_WS;
}

// ── RPC helper ─────────────────────────────
async function rpc(method, params) {
  const r = await fetch(rpcUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result ?? null;
}

// ── Ed25519 / PDA ──────────────────────────
const _P = 57896044618658097711785492504343953926634992332820282019728792003956564819949n;
const _D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function _mpow(b, e, m) {
  let r = 1n; b %= m;
  while (e > 0n) { if (e & 1n) r = r * b % m; e >>= 1n; b = b * b % m; }
  return r;
}

function _offCurve(bytes) {
  try {
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
    const s = y >> 255n;
    y &= (1n << 255n) - 1n;
    const y2 = y * y % _P;
    const u  = (y2 - 1n + _P) % _P;
    const v  = (_D * y2 % _P + 1n) % _P;
    if (v === 0n) return u !== 0n;
    const x2 = u * _mpow(v, _P - 2n, _P) % _P;
    if (x2 === 0n) return s !== 0n;
    let x = _mpow(x2, (_P + 3n) / 8n, _P);
    if ((x * x - x2 + _P) % _P !== 0n) x = x * _mpow(2n, (_P - 1n) / 4n, _P) % _P;
    return (x * x - x2 + _P) % _P !== 0n;
  } catch { return true; }
}

async function findPDA(seeds, prog) {
  const pb = bs58decode(prog);
  const m  = new TextEncoder().encode('ProgramDerivedAddress');
  for (let n = 255; n >= 0; n--) {
    const d = [...seeds.flatMap(s => [...s]), n, ...pb, ...m];
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(d)));
    if (_offCurve(h)) return bs58encode(h);
  }
  throw new Error('No valid PDA');
}

// ── Derive ATA ─────────────────────────────
// Seeds: [owner, tokenProgram, mint]
async function ata(owner, mint, tokenProg) {
  return findPDA(
    [bs58decode(owner), bs58decode(tokenProg), bs58decode(mint)],
    PROG_ATA
  );
}

// ── Detect token program ────────────────────
// pump.fun AMM tokens are Token-2022. Default to Token-2022;
// only use SPL if the mint account is explicitly owned by the SPL program.
async function getTokenProg(mint) {
  // Retry up to 3 times — RPC can be flaky
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await rpc('getAccountInfo', [mint, { encoding: 'base64' }]);
      const o = r?.value?.owner;
      if (!o) throw new Error('Mint account not found or owner field missing');
      if (o === PROG_SPL) {
        console.log('[Split] Mint is SPL Token (legacy)');
        return PROG_SPL;
      }
      if (o === PROG_TOKEN2022) {
        console.log('[Split] Mint is Token-2022');
        return PROG_TOKEN2022;
      }
      throw new Error('Unrecognised mint owner: ' + o);
    } catch (e) {
      console.warn(`[Split] getTokenProg attempt ${attempt}/3 failed:`, e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 600 * attempt));
      else throw new Error('Could not detect token program for mint ' + mint.slice(0,8) + ': ' + e.message);
    }
  }
}

// ── Token balance ───────────────────────────
async function getBalance(ataAddr) {
  const r = await rpc('getTokenAccountBalance', [ataAddr]);
  if (!r?.value) return null;
  return {
    ui:  Number(r.value.uiAmount || 0),
    raw: BigInt(r.value.amount   || '0'),
    dec: r.value.decimals        || 0,
  };
}

// ── Fetch all tokens in a wallet ────────────
async function fetchWalletTokens(owner) {
  const tokens = [];
  for (const prog of [PROG_SPL, PROG_TOKEN2022]) {
    try {
      const r = await rpc('getTokenAccountsByOwner', [owner, { programId: prog }, { encoding: 'jsonParsed' }]);
      for (const a of (r?.value || [])) {
        const info = a.account?.data?.parsed?.info;
        if (!info) continue;
        const ui = Number(info.tokenAmount?.uiAmount || 0);
        if (ui <= 0) continue;
        tokens.push({
          mint:      info.mint,
          uiAmount:  ui,
          rawAmount: BigInt(info.tokenAmount?.amount || '0'),
          decimals:  info.tokenAmount?.decimals || 0,
          tokenProg: prog,
          name:      null,
        });
      }
    } catch {}
  }
  tokens.sort((a, b) => b.uiAmount - a.uiAmount);
  if (tokens.length > 0) {
    try {
      const res = await fetch(rpcUrl(), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids: tokens.map(t => t.mint).slice(0, 100) } })
      });
      const j = await res.json();
      if (j.result) {
        const names = {};
        for (const a of j.result) {
          if (a?.id) names[a.id] = a.content?.metadata?.name || a.content?.metadata?.symbol || null;
        }
        tokens.forEach(t => { t.name = names[t.mint] || null; });
      }
    } catch {}
  }
  return tokens;
}

// ── Account exists ──────────────────────────
async function exists(addr) {
  try {
    const r = await rpc('getAccountInfo', [addr, { encoding: 'base64' }]);
    return !!(r?.value);
  } catch { return false; }
}

// ── Encoding helpers ────────────────────────
function cu16(n) {
  if (n < 128)   return [n];
  if (n < 16384) return [(n & 0x7f) | 0x80, n >> 7];
  return [(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, n >> 14];
}

function u32le(n) {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

function u64le(n) {
  const b = []; let v = BigInt(n);
  for (let i = 0; i < 8; i++) { b.push(Number(v & 0xffn)); v >>= 8n; }
  return b;
}

// ── Account list builder ────────────────────
// Solana account order: writable-signers | readonly-signers | writable-non-signers | readonly-non-signers
// We don't use readonly-signers (numROSig always 0).
function buildAccounts(writableSigners, writableNonSigners, readonlyNonSigners) {
  const seen = new Set();
  const add  = (list, into) => { for (const a of list) { if (!seen.has(a)) { seen.add(a); into.push(a); } } };
  const ws = [], wns = [], ros = [];
  add(writableSigners,    ws);
  add(writableNonSigners, wns);
  add(readonlyNonSigners, ros);
  return {
    accounts:   [...ws, ...wns, ...ros],
    numSig:     ws.length,
    numROSig:   0,
    numROUnsig: ros.length,
  };
}

// ── Build Solana legacy transaction message ─
function buildMsg(accounts, numSig, numROSig, numROUnsig, ixs, blockhash) {
  const idxOf = a => {
    const i = accounts.indexOf(a);
    if (i < 0) throw new Error('Account missing from list: ' + a.slice(0, 8));
    return i;
  };
  const out = [numSig, numROSig, numROUnsig];
  out.push(...cu16(accounts.length));
  for (const a of accounts) {
    const b = bs58decode(a);
    if (b.length !== 32) throw new Error(`Bad key length ${b.length}: ${a.slice(0, 8)}`);
    out.push(...b);
  }
  out.push(...bs58decode(blockhash));
  out.push(...cu16(ixs.length));
  for (const ix of ixs) {
    out.push(idxOf(ix.prog));
    out.push(...cu16(ix.accts.length));
    out.push(...ix.accts.map(idxOf));
    out.push(...cu16(ix.data.length));
    out.push(...ix.data);
  }
  return new Uint8Array(out);
}

// ── Sign a message ──────────────────────────
async function signMsg(msg, privB58) {
  const priv = bs58decode(privB58);
  if (priv.length !== 64) throw new Error('Need 64-byte keypair. Export full keypair from Phantom/Backpack.');
  const pkcs8 = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ...priv.slice(0, 32)
  ]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, msg));
}

// ── Send signed transaction ─────────────────
function _toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function sendTx(msg, sig, label, simulate) {
  const tx = new Uint8Array(1 + 64 + msg.length);
  tx[0] = 1; tx.set(sig, 1); tx.set(msg, 65);
  const b64 = _toB64(tx);

  if (simulate) {
    try {
      const sr = await fetch(rpcUrl(), {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method:  'simulateTransaction',
          params:  [b64, { encoding: 'base64', commitment: 'processed', replaceRecentBlockhash: true, sigVerify: false }]
        })
      });
      const sj = await sr.json();
      const sv = sj.result?.value;
      if (sv?.err) {
        const logs = sv.logs || [];
        logs.forEach(l => console.log('[sim]', l));
        const detail = logs.find(l => l.includes('Error') || l.includes('failed')) || '';
        throw new Error('Sim: ' + JSON.stringify(sv.err) + (detail ? ' — ' + detail : ''));
      }
      console.log(`[Split] ${label} sim OK (${sv?.logs?.length || 0} logs)`);
    } catch (e) {
      if (e.message.startsWith('Sim:')) throw e;
      console.warn(`[Split] ${label} sim error (skipping):`, e.message);
    }
  }

  const txSig = await rpc('sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }]);
  if (!txSig) throw new Error('No signature returned');
  console.log(`[Split] ✓ ${label}: ${txSig}`);
  return txSig;
}

// ── Split amounts with optional deviation ───
function splitAmounts(totalRaw, n, deviation) {
  if (!n) return [];
  const total   = BigInt(totalRaw);
  const weights = Array.from({ length: n }, () =>
    Math.max(0.001, 1 + (deviation ? (Math.random() * 2 - 1) * deviation / 100 : 0))
  );
  const ws      = weights.reduce((a, b) => a + b, 0);
  const amounts = weights.map(w => BigInt(Math.floor(Number(total) * w / ws)));
  amounts[0]   += total - amounts.reduce((a, b) => a + b, 0n);
  return amounts;
}

// ── Fetch rent-exempt minimum for a token account ──
// Uses getMinimumBalanceForRentExemption RPC call.
// Token-2022 ATA with immutableOwner extension = 170 bytes = 2,074,080 lamports
// SPL ATA = 165 bytes = 2,039,280 lamports
// We fetch dynamically so we're always accurate.
async function getAtaRentLamports(tokenProg) {
  const bytes = tokenProg === PROG_TOKEN2022 ? 170 : 165;
  try {
    const r = await rpc('getMinimumBalanceForRentExemption', [bytes]);
    if (r && typeof r === 'number') return r;
  } catch {}
  // Fallback to known constants if RPC fails
  return tokenProg === PROG_TOKEN2022 ? 2_074_080 : 2_039_280;
}

// ── Build + send BATCHED ATA create transaction ─────
//
// Creates up to ATA_BATCH_SIZE ATAs in a single transaction.
// Each ATA ix = Associated Token Program createIdempotent:
//   accounts: [payer(w,s), ataAddr(w), owner(r), mint(r), SystemProg(r), TokenProg(r)]
//   data: [1]  (CreateIdempotent)
//
// Payer funds the rent (2,074,080 lamports per Token-2022 ATA) from its SOL balance.
// This is the correct on-chain approach — no SOL needed in the destination wallet.
//
const ATA_BATCH_SIZE = 3; // 3 ATA creates per tx is safe within compute limits

async function createATABatch(payer, payerPriv, targets, mint, tokenProg, blockhash) {
  // targets = [{ owner, addr }, ...]
  if (!targets.length) return;

  // Build one createIdempotent ix per target
  const ataIxs = targets.map(t => ({
    prog:  PROG_ATA,
    accts: [payer, t.addr, t.owner, mint, PROG_SYSTEM, tokenProg],
    data:  [1], // CreateIdempotent
  }));

  // Compute budget — scale CU limit with number of ATAs
  const cuPerATA = 50_000;
  const ixCULimit = { prog: PROG_COMPUTE, accts: [], data: [2, ...u32le(cuPerATA * targets.length + 5_000)] };
  const ixCUPrice = { prog: PROG_COMPUTE, accts: [], data: [3, ...u64le(2_500_000)] };

  // All ATA addresses are writable non-signers; owners + mint + programs are readonly
  const allAtaAddrs  = targets.map(t => t.addr);
  const allOwners    = targets.map(t => t.owner);

  const { accounts, numSig, numROSig, numROUnsig } = buildAccounts(
    [payer],
    allAtaAddrs,
    [...allOwners, mint, PROG_SYSTEM, tokenProg, PROG_ATA, PROG_COMPUTE]
  );

  const msg = buildMsg(accounts, numSig, numROSig, numROUnsig,
    [ixCULimit, ixCUPrice, ...ataIxs],
    blockhash
  );

  const label = `ATA-batch(${targets.length})`;
  console.log(`[Split] ${label}: creating ATAs for`, targets.map(t => t.owner.slice(0,6)).join(', '));
  const sig = await signMsg(msg, payerPriv);
  return sendTx(msg, sig, label, false); // no simulation for ATA creates
}

// ── Build + send transfer transaction ───────
//
// Matches Solscan instruction #4: Token 2022 Program transferChecked
//
// Per-transfer accounts (4):
//   [0] sourceATA  — writable
//   [1] mint       — readonly  (required by transferChecked, NOT by plain Transfer)
//   [2] destATA    — writable
//   [3] authority  — writable, signer
//
// data: [12, ...u64le(amount), decimals]
//   12 = TransferChecked discriminator
//
async function sendTransferBatch(srcPub, sourcePrivKey, srcATA, mint, tokenProg, batch, decimals, blockhash, label) {
  const ixCULimit = { prog: PROG_COMPUTE, accts: [], data: [2, ...u32le(200_000)]    };
  const ixCUPrice = { prog: PROG_COMPUTE, accts: [], data: [3, ...u64le(2_500_000)] };

  const transferIxs = batch
    .filter(t => t.amount > 0n)
    .map(t => ({
      prog:  tokenProg,
      accts: [srcATA, mint, t.addr, srcPub],        // src, mint, dst, authority
      data:  [12, ...u64le(t.amount), decimals],    // TransferChecked
    }));

  if (!transferIxs.length) return null;

  const { accounts, numSig, numROSig, numROUnsig } = buildAccounts(
    [srcPub],                                   // writable signer (authority + fee payer)
    [srcATA, ...batch.map(t => t.addr)],        // writable non-signers (src ATA + dest ATAs)
    [mint, tokenProg, PROG_COMPUTE]             // readonly
  );

  const msg = buildMsg(accounts, numSig, numROSig, numROUnsig,
    [ixCULimit, ixCUPrice, ...transferIxs],
    blockhash
  );

  const sig = await signMsg(msg, sourcePrivKey);
  return sendTx(msg, sig, label, false); // skip sim — ATAs confirmed via polling, sim causes false InsufficientFundsForRent
}

// ── Main split orchestrator ─────────────────
async function executeSplitOnChain({ sourcePrivKey, mint, targets, deviation, knownBalance, keepSource }, onProgress) {
  const log = (msg, pct) => { console.log(`[Split] ${pct}% ${msg}`); onProgress?.({ msg, pct }); };

  log('Validating wallet…', 2);
  const priv = bs58decode(sourcePrivKey.trim());
  if (priv.length !== 64) throw new Error('Private key must be 64 bytes. Export full keypair from Phantom/Backpack.');
  const srcPub = bs58encode(priv.slice(32, 64));

  log('Detecting token program…', 4);
  const tokenProg = await getTokenProg(mint);

  log('Deriving source ATA…', 6);
  const srcATA = await ata(srcPub, mint, tokenProg);

  let bal;
  if (knownBalance) {
    bal = knownBalance;
    log(`Known balance: ${bal.ui.toLocaleString()} tokens`, 8);
  } else {
    log('Fetching token balance…', 7);
    for (let i = 1; i <= 4; i++) {
      try { bal = await getBalance(srcATA); if (bal?.raw > 0n) break; } catch {}
      if (i < 4) { log(`Waiting (${i}/4)…`, 7 + i); await new Promise(r => setTimeout(r, 1000 * i)); }
    }
    if (!bal?.raw) throw new Error('No tokens found in source wallet. Check wallet, token, and RPC in Settings.');
    log(`${bal.ui.toLocaleString()} tokens found`, 8);
  }

  log(`Splitting into ${targets.length} wallets…`, 10);
  // keepSource=true: source keeps 1 share, targets split the rest.
  // We split across (targets.length + 1) equal slots and only send the first targets.length.
  const splitSlots = keepSource ? targets.length + 1 : targets.length;
  const allAmounts = splitAmounts(bal.raw, splitSlots, deviation);
  // When keepSource, discard the last slot (that's what stays in source). Otherwise use all.
  const amounts = keepSource ? allAmounts.slice(0, targets.length) : allAmounts;

  log('Deriving target ATAs…', 12);
  const targetInfos = [];
  for (let i = 0; i < targets.length; i++) {
    const owner = targets[i].address;
    const addr  = await ata(owner, mint, tokenProg);
    const ex    = await exists(addr);
    targetInfos.push({ owner, addr, exists: ex, amount: amounts[i] });
    log(`${i+1}/${targets.length}: ${owner.slice(0,6)}… ATA ${ex ? '✓ exists' : 'needs create'}`, 12 + (i / targets.length) * 18);
  }

  log('Getting blockhash…', 31);
  const bh0 = await rpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
  if (!bh0?.value?.blockhash) throw new Error('Cannot get blockhash — check RPC in Settings.');
  let blockhash = bh0.value.blockhash;

  const results    = [];
  const needCreate = targetInfos.filter(t => !t.exists);

  // ── Phase 1: Create missing ATAs ──────────
  if (needCreate.length > 0) {
    // Pre-check: fetch ATA rent and warn if source wallet SOL is tight
    log('Checking SOL balance for ATA rent…', 31);
    const rentPerATA = await getAtaRentLamports(tokenProg);
    const totalRentNeeded = rentPerATA * needCreate.length;
    const TX_FEE_ESTIMATE = 10_000 * needCreate.length; // ~0.00001 SOL per tx, generous
    const solBal = await rpc('getBalance', [srcPub]);
    const srcLamports = solBal?.value ?? 0;
    const minRequired = totalRentNeeded + TX_FEE_ESTIMATE + 890_880; // +rent-exempt for srcPub itself
    if (srcLamports < minRequired) {
      const needed = ((minRequired - srcLamports) / 1e9).toFixed(6);
      throw new Error(
        `Source wallet needs ~${needed} more SOL to pay ATA rent for ${needCreate.length} new wallet(s). ` +
        `Each new token account requires ${(rentPerATA / 1e9).toFixed(6)} SOL rent (refundable).`
      );
    }
    log(`SOL OK — funding ${needCreate.length} ATA(s) at ${(rentPerATA/1e9).toFixed(6)} SOL each`, 33);

    // Batch ATAs — ATA_BATCH_SIZE per transaction
    const ataBatches = [];
    for (let i = 0; i < needCreate.length; i += ATA_BATCH_SIZE) {
      ataBatches.push(needCreate.slice(i, i + ATA_BATCH_SIZE));
    }

    for (let bi = 0; bi < ataBatches.length; bi++) {
      const batch = ataBatches[bi];
      try {
        await createATABatch(srcPub, sourcePrivKey, batch, mint, tokenProg, blockhash);
        log(`ATA batch ${bi+1}/${ataBatches.length} sent`, 33 + (bi / ataBatches.length) * 11);
      } catch (e) {
        // Idempotent — already-existing ATAs are fine, re-throw real errors
        if (e.message.includes('already') || e.message.includes('0x0')) {
          log(`ATA batch ${bi+1} — already exist, continuing`, 33 + (bi / ataBatches.length) * 11);
        } else {
          throw new Error(`ATA creation failed: ${e.message}`);
        }
      }
    }

    // Poll until every created ATA is confirmed on-chain (max 40s)
    log('Waiting for ATAs to confirm on-chain…', 44);
    const confirmDeadline = Date.now() + 40_000;
    let allConfirmed = false;
    while (Date.now() < confirmDeadline) {
      await new Promise(r => setTimeout(r, 2000));
      const checks = await Promise.all(needCreate.map(t => exists(t.addr)));
      const confirmedCount = checks.filter(Boolean).length;
      if (checks.every(Boolean)) { allConfirmed = true; break; }
      log(`Confirming ATAs… (${confirmedCount}/${needCreate.length})`, 44);
    }
    if (!allConfirmed) {
      // Count how many are missing
      const missing = needCreate.filter(async (t, i) => !(await exists(t.addr)));
      console.warn('[Split] Some ATAs may not have confirmed yet — proceeding anyway');
    }
    const bh2 = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    if (bh2?.value?.blockhash) blockhash = bh2.value.blockhash;
    log('ATAs ready ✓', 46);
  }

  // ── Phase 2: Transfers (4 per tx) ─────────
  const BATCH   = 4;
  const batches = [];
  for (let i = 0; i < targetInfos.length; i += BATCH) batches.push(targetInfos.slice(i, i + BATCH));

  for (let bi = 0; bi < batches.length; bi++) {
    log(`Transfer ${bi+1}/${batches.length}…`, 48 + (bi / batches.length) * 48);
    try {
      const txSig = await sendTransferBatch(
        srcPub, sourcePrivKey, srcATA, mint, tokenProg,
        batches[bi], bal.dec, blockhash, `transfer-${bi+1}`
      );
      if (txSig) {
        results.push({ batch: bi+1, sig: txSig, ok: true });
        log(`✓ Tx ${txSig.slice(0,10)}…`, 50 + (bi / batches.length) * 48);
      }
    } catch (e) {
      let err = e.message || 'Unknown';
      if (err.includes('0x1'))               err = 'Insufficient token balance';
      if (err.includes('insufficient funds')) err = 'Not enough SOL for fees';
      if (err.includes('InvalidAccountData')) err = 'Target ATA not initialised — ATA creation may have failed';
      results.push({ batch: bi+1, error: err, ok: false });
      log(`✕ ${err}`, 50 + (bi / batches.length) * 48);
      console.error('[Split] Transfer failed:', err);
    }
    if (bi < batches.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  log('Done!', 100);
  return {
    success:      results.filter(r => r.ok).length,
    failed:       results.filter(r => !r.ok).length,
    results,
    sourcePubkey: srcPub,
    totalAmount:  bal.ui,
    totalRaw:     bal.raw,
  };
}

// ═══════════════════════════════════════════
// AUTO-SPLIT — WebSocket + polling fallback
// ═══════════════════════════════════════════
let _ws = null, _ping = null, _poll = null;
let _run = false, _cfg = null, _att = 0;
let _seen = new Set(), _subId = null, _mode = 'ws';

function isAutoSplitRunning() { return _run; }
function autoSplitMode()      { return _mode; }

function startAutoSplitWS(cfg) {
  stopAutoSplitWS();
  _cfg = cfg; _run = true; _att = 0; _mode = 'ws'; _seen.clear();
  console.log('[AutoSplit] Starting, watching:', bs58encode(bs58decode(cfg.sourcePrivKey).slice(32, 64)));
  _connect();
}

function stopAutoSplitWS() {
  _run = false; _cfg = null;
  clearInterval(_ping); clearInterval(_poll);
  _poll = null; _subId = null; _seen.clear();
  if (_ws) { _ws.onclose = null; _ws.onerror = null; try { _ws.close(); } catch {} _ws = null; }
  console.log('[AutoSplit] Stopped');
}

function _fallbackPoll() {
  if (_poll) return;
  _mode = 'poll';
  console.log('[AutoSplit] Falling back to 3s polling');
  if (typeof S !== 'undefined') {
    S.split.auto.wsStatus = 'polling';
    if (typeof saveState === 'function') saveState();
    if (typeof render    === 'function') render();
  }
  _poll = setInterval(_doPoll, 3000);
}

async function _doPoll() {
  if (!_run || !_cfg) return;
  try {
    const pub  = bs58encode(bs58decode(_cfg.sourcePrivKey).slice(32, 64));
    const sigs = await rpc('getSignaturesForAddress', [pub, { limit: 5, commitment: 'confirmed' }]);
    if (!sigs?.length) return;
    const fresh = sigs.filter(s => !_seen.has(s.signature) && !s.err);
    fresh.forEach(s => _seen.add(s.signature));
    if (_seen.size > 500) { const a = [..._seen]; _seen = new Set(a.slice(-200)); }
    for (const s of fresh) {
      const tx = await rpc('getTransaction', [s.signature, {
        encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed'
      }]).catch(() => null);
      if (!tx?.meta) continue;
      await _checkBuy(tx.meta.preTokenBalances || [], tx.meta.postTokenBalances || [], pub);
    }
  } catch (e) { console.warn('[AutoSplit Poll]', e.message); }
}

function _connect() {
  if (!_run || !_cfg) return;
  const url = wsUrl();
  console.log('[AutoSplit] Connecting:', url.replace(/api-key=[^&]+/, 'api-key=***'));
  try { _ws = new WebSocket(url); }
  catch (e) { console.warn('[AutoSplit] WS init failed:', e.message); _fallbackPoll(); return; }

  _ws.onopen = () => {
    console.log('[AutoSplit] ✓ Connected');
    _att = 0;
    const pub = bs58encode(bs58decode(_cfg.sourcePrivKey).slice(32, 64));
    _ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method:  'transactionSubscribe',
      params:  [
        { accountInclude: [pub], failed: false },
        { commitment: 'processed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 }
      ]
    }));
    clearInterval(_ping);
    _ping = setInterval(() => {
      if (_ws?.readyState === WebSocket.OPEN)
        _ws.send(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'getHealth', params: [] }));
    }, 25000);
    if (typeof S !== 'undefined') {
      S.split.auto.wsStatus = 'connected';
      if (typeof saveState === 'function') saveState();
      if (typeof render    === 'function') render();
    }
  };

  _ws.onmessage = async (raw) => {
    try {
      const msg = JSON.parse(raw.data);
      if (msg.id === 1 && msg.result !== undefined) {
        _subId = msg.result;
        console.log('[AutoSplit] ✓ Subscribed, id:', _subId);
        return;
      }
      if (msg.method !== 'transactionNotification') return;
      const val = msg.params?.result;
      if (!val) return;
      const sig = val.signature;
      if (!sig || _seen.has(sig)) return;
      _seen.add(sig);
      if (_seen.size > 1000) { const a = [..._seen]; _seen = new Set(a.slice(-500)); }
      console.log('[AutoSplit] TX:', sig.slice(0, 12) + '…');
      const tx = val.transaction;
      if (!tx?.meta) return;
      const pub = bs58encode(bs58decode(_cfg.sourcePrivKey).slice(32, 64));
      await _checkBuy(tx.meta.preTokenBalances || [], tx.meta.postTokenBalances || [], pub, val);
    } catch (e) { console.warn('[AutoSplit] Message error:', e.message); }
  };

  _ws.onerror = () => console.warn('[AutoSplit] WS error');

  _ws.onclose = () => {
    clearInterval(_ping);
    if (!_run) return;
    _att++;
    if (_att <= 3) setTimeout(_connect, 1500 * _att);
    else _fallbackPoll();
  };
}

async function _checkBuy(pre, post, pub, wsVal) {
  for (const p of post) {
    if (p.owner !== pub) continue;
    const prev    = pre.find(x => x.accountIndex === p.accountIndex);
    const preAmt  = Number(prev?.uiTokenAmount?.uiAmount  ?? 0);
    const postAmt = Number(p.uiTokenAmount?.uiAmount ?? 0);
    if (postAmt <= preAmt) continue;
    const mint = p.mint;
    if (_cfg.caFilter && mint !== _cfg.caFilter) continue;
    console.log('[AutoSplit] ✓ Buy:', (postAmt - preAmt).toLocaleString(), 'tokens of', mint.slice(0, 8));
    const kb = {
      ui:  postAmt,
      raw: BigInt(p.uiTokenAmount?.amount ?? '0'),
      dec: p.uiTokenAmount?.decimals || 0,
    };
    await _doSplit(mint, kb);
    return;
  }
}

async function _doSplit(mint, knownBalance) {
  if (!_cfg || !_run) return;
  let targets = [];
  if (_cfg.mode === 'existing') {
    if (!_cfg.targetWallets?.length) { console.warn('[AutoSplit] No target wallets set'); return; }
    targets = _cfg.targetWallets.map(a => ({ address: a }));
  } else {
    const n = _cfg.newWalletCount || 5;
    const wallets = [];
    for (let i = 0; i < n; i++) {
      const kp = await generateKeypair();
      wallets.push(kp);
      targets.push({ address: kp.publicKey });
    }
    if (typeof S !== 'undefined') {
      S.split.auto.generatedHistory = S.split.auto.generatedHistory || [];
      S.split.auto.generatedHistory.unshift({ id: uid(), ts: Date.now(), mint, wallets });
      if (S.split.auto.generatedHistory.length > 20)
        S.split.auto.generatedHistory = S.split.auto.generatedHistory.slice(0, 20);
    }
  }

  console.log('[AutoSplit] Splitting into', targets.length, 'wallets');
  try {
    const result = await executeSplitOnChain({
      sourcePrivKey: _cfg.sourcePrivKey, mint, targets,
      deviation: _cfg.deviation || 0, knownBalance,
      keepSource: _cfg.keepSource || false,
    }, p => { if (typeof S !== 'undefined') S.split.auto.lastProgress = p; });

    if (typeof S !== 'undefined') {
      S.split.auto.lastResult = { mint, ...result, ts: Date.now() };

      // Push a proper history record so it shows in the History tab
      S.split.auto.history = S.split.auto.history || [];
      const histRecord = {
        id: (typeof uid === 'function' ? uid() : Math.random().toString(36).slice(2,10)),
        timestamp: Date.now(),
        _source: 'auto',
        type: _cfg.mode === 'new' ? 'new' : 'existing',
        sourcePubkey: result.sourcePubkey,
        tokenCA: mint,
        deviation: _cfg.deviation || 0,
        totalAmount: result.totalAmount,
        txResults: result.results,
        wallets: targets.map((t, i) => ({
          address: t.address,
          privateKey: (_cfg.mode === 'new' && S.split.auto.generatedHistory?.[0]?.wallets?.[i]?.privateKey) || null,
          amount: result.totalAmount / targets.length,
          pct: (100 / targets.length).toFixed(1),
        })),
      };
      S.split.auto.history.unshift(histRecord);
      if (S.split.auto.history.length > 50) S.split.auto.history = S.split.auto.history.slice(0, 50);

      if (typeof saveState === 'function') saveState();
      if (typeof render    === 'function') render();
    }
    console.log('[AutoSplit] Split done:', result.success, 'ok,', result.failed, 'failed');

    // One-time mode: stop auto-split after the first successful fire
    if (_cfg.oneTime) {
      console.log('[AutoSplit] One-time mode — stopping after first split.');
      stopAutoSplitWS();
      if (typeof S !== 'undefined') {
        S.split.auto.wsStatus = null;
        if (typeof saveState === 'function') saveState();
        if (typeof render    === 'function') render();
      }
    }
  } catch (e) {
    console.error('[AutoSplit] Failed:', e.message);
    if (typeof S !== 'undefined') {
      S.split.auto.lastResult = { mint, success: 0, failed: 1, error: e.message, ts: Date.now() };
      if (typeof saveState === 'function') saveState();
      if (typeof render    === 'function') render();
    }
  }
}