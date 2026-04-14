/* ═══════════════════════════════════════════
   bundle.js — Bundle Detection Engine
   Essor Studios / Ultimate Dev Tools

   Supports:
   - Pump.fun tokens (bonding curve buys)
   - Raydium / Jupiter launches
   - Same-block / same-funder detection
═══════════════════════════════════════════ */

'use strict';

const PUMPFUN_PROGRAM  = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymMDer';
const RAYDIUM_AMM      = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Detect if a tx is a pump.fun buy ────────
function isPumpFunBuy(tx, mintAddress) {
  if (!tx?.transaction?.message) return false;
  const accounts = tx.transaction.message.accountKeys || [];
  const addrs = accounts.map(a => typeof a === 'string' ? a : a.pubkey);
  return addrs.includes(PUMPFUN_PROGRAM);
}

// ── Extract buyer and amount from a tx ──────
function extractBuyer(tx, mintAddress) {
  if (!tx?.meta) return null;

  const postBals = tx.meta.postTokenBalances || [];
  const preBals  = tx.meta.preTokenBalances  || [];
  const accounts = tx.transaction?.message?.accountKeys || [];
  const sig      = tx.transaction?.signatures?.[0] || '';

  for (const post of postBals) {
    if (post.mint !== mintAddress) continue;
    if (!post.owner) continue;

    const pre    = preBals.find(p => p.accountIndex === post.accountIndex);
    const preAmt = Number(pre?.uiTokenAmount?.uiAmount || 0);
    const postAmt= Number(post.uiTokenAmount?.uiAmount || 0);

    if (postAmt > preAmt) {
      return {
        wallet:    post.owner,
        amount:    postAmt - preAmt,
        slot:      tx.slot,
        timestamp: tx.blockTime,
        signature: sig,
        isPump:    isPumpFunBuy(tx, mintAddress),
        verdict:   'UNKNOWN',
        fundingSource: null,
        bundleGroup:   null,
      };
    }
  }

  // Pump.fun fallback — check SOL balance changes to find buyer
  // when token accounts are not parsed
  const solPre  = tx.meta.preBalances  || [];
  const solPost = tx.meta.postBalances || [];
  const acctKeys= accounts.map(a => typeof a === 'string' ? a : a.pubkey);

  // If pump.fun is in accounts, the buyer is whoever lost SOL (not the program itself)
  if (acctKeys.includes(PUMPFUN_PROGRAM)) {
    for (let i = 0; i < acctKeys.length; i++) {
      const addr = acctKeys[i];
      if (addr === PUMPFUN_PROGRAM) continue;
      if (addr === mintAddress) continue;
      // Signer who lost SOL = buyer
      const lost = (solPre[i] || 0) - (solPost[i] || 0);
      if (lost > 5000 && tx.transaction?.message?.header?.numRequiredSignatures > 0) {
        // Check if this account is a signer
        const isSignerIndex = i < (tx.transaction?.message?.header?.numRequiredSignatures || 0);
        if (isSignerIndex) {
          return {
            wallet:    addr,
            amount:    0, // unknown amount from this path
            slot:      tx.slot,
            timestamp: tx.blockTime,
            signature: tx.transaction?.signatures?.[0] || '',
            isPump:    true,
            verdict:   'UNKNOWN',
            fundingSource: null,
            bundleGroup:   null,
          };
        }
      }
    }
  }

  return null;
}

// ── Main analysis ────────────────────────────
async function analyzeBundles(mintAddress, onProgress) {
  const report = p => onProgress && onProgress(p);

  report({ step: 'Fetching token transactions…', pct: 5 });

  // Get signatures — for pump.fun we use the token mint address directly
  const sigsRaw = await bundleRpc('getSignaturesForAddress', [
    mintAddress,
    { limit: 150, commitment: 'confirmed' }
  ]);

  if (!sigsRaw || sigsRaw.length === 0) {
    throw new Error('No transactions found. Double-check the CA and make sure you have a working RPC in Settings.');
  }

  // Oldest first — launch transactions are at the end
  const sigs = [...sigsRaw].reverse().slice(0, 80);
  report({ step: `Got ${sigsRaw.length} transactions. Analysing first ${sigs.length}…`, pct: 12 });

  // Fetch tx details in small batches with delay (avoid rate limits)
  const txDetails = [];
  const batchSize = 4;

  for (let i = 0; i < sigs.length; i += batchSize) {
    const batch = sigs.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(s => bundleRpc('getTransaction', [
        s.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
      ]))
    );
    txDetails.push(...results.filter(Boolean));
    const pct = 12 + Math.floor((i / sigs.length) * 38);
    report({ step: `Fetched ${Math.min(i + batchSize, sigs.length)} / ${sigs.length}…`, pct });
    await sleep(200); // rate limit friendly
  }

  report({ step: 'Extracting buyers…', pct: 52 });

  const buyers    = [];
  const seenWallets = new Set();

  for (const tx of txDetails) {
    if (!tx) continue;
    const buyer = extractBuyer(tx, mintAddress);
    if (buyer && !seenWallets.has(buyer.wallet)) {
      seenWallets.add(buyer.wallet);
      buyers.push(buyer);
    }
  }

  if (buyers.length === 0) {
    throw new Error('Could not identify any buyers. This token may use an unusual program — try a different CA or check your RPC endpoint in Settings.');
  }

  const launchSlot = Math.min(...buyers.map(b => b.slot));
  const isPumpToken = buyers.some(b => b.isPump);
  report({ step: `Found ${buyers.length} buyers. Tracing funding sources…`, pct: 55 });

  // Trace early buyers (within 5 slots of launch for pump.fun, 3 for others)
  const slotWindow  = isPumpToken ? 5 : 3;
  const earlyBuyers = buyers.filter(b => b.slot - launchSlot <= slotWindow);

  report({ step: `Tracing ${earlyBuyers.length} early buyer${earlyBuyers.length !== 1 ? 's' : ''}…`, pct: 58 });

  for (let i = 0; i < earlyBuyers.length; i++) {
    const b = earlyBuyers[i];
    b.fundingSource = await traceFundingSource(b.wallet);
    report({ step: `Tracing wallet ${i + 1} / ${earlyBuyers.length}…`, pct: 58 + Math.floor((i / earlyBuyers.length) * 28) });
    await sleep(150);
  }

  report({ step: 'Scoring wallets…', pct: 88 });

  // Group wallets by shared funder
  const sourceMap   = {};
  for (const b of earlyBuyers) {
    if (!b.fundingSource) continue;
    if (!sourceMap[b.fundingSource]) sourceMap[b.fundingSource] = [];
    sourceMap[b.fundingSource].push(b.wallet);
  }

  // Also group by same slot (same block = likely bundled even if different funders)
  const slotMap = {};
  for (const b of earlyBuyers) {
    if (b.slot - launchSlot > 1) continue; // only first 2 slots
    if (!slotMap[b.slot]) slotMap[b.slot] = [];
    slotMap[b.slot].push(b.wallet);
  }

  let bundleGroupId = 0;
  const groupLabels = {};

  for (const b of buyers) {
    const slotDiff = b.slot - launchSlot;

    const sharedFunder = b.fundingSource && sourceMap[b.fundingSource]?.length > 1;
    const sameBlock    = slotMap[b.slot]?.length > 1;

    if (sharedFunder) {
      if (!groupLabels[b.fundingSource]) {
        groupLabels[b.fundingSource] = 'Group ' + String.fromCharCode(65 + bundleGroupId++);
      }
      b.bundleGroup = groupLabels[b.fundingSource];
      b.verdict     = slotDiff <= 2 ? 'BUNDLE' : 'SUSPICIOUS';
    } else if (sameBlock && slotDiff <= 1) {
      b.verdict = 'SUSPICIOUS';
    } else if (slotDiff <= slotWindow) {
      b.verdict = 'EARLY';
    } else {
      b.verdict = 'CLEAN';
    }

    b.slotDiff = slotDiff;
  }

  // Get supply
  report({ step: 'Fetching supply…', pct: 93 });
  const supplyInfo  = await bundleRpc('getTokenSupply', [mintAddress]);
  const totalSupply = Number(supplyInfo?.value?.uiAmount || 0);

  // ── Full-port detection ──────────────────────────────────────────────────
  // A "full port" buyer is an EARLY/CLEAN buyer who purchased ≥50% of the visible
  // token supply in their first buy — a strong signal of coordinated dev/team buying.
  // We only flag wallets that are NOT already BUNDLE/SUSPICIOUS (to avoid double-counting).
  if (totalSupply > 0) {
    for (const b of buyers) {
      if (b.verdict === 'BUNDLE' || b.verdict === 'SUSPICIOUS') continue;
      const pct = (b.amount / totalSupply) * 100;
      if (pct >= 50) {
        b.verdict  = 'FULLPORT';
        b.fullPort = true;
      }
    }
  }

  const bundled    = buyers.filter(b => b.verdict === 'BUNDLE');
  const suspicious = buyers.filter(b => b.verdict === 'SUSPICIOUS');
  const fullPorts  = buyers.filter(b => b.verdict === 'FULLPORT');
  const bundledAmt = bundled.reduce((s, b) => s + b.amount, 0);
  const suspAmt    = suspicious.reduce((s, b) => s + b.amount, 0);
  const bundledPct = totalSupply > 0 ? ((bundledAmt / totalSupply) * 100).toFixed(1) : '?';
  const suspPct    = totalSupply > 0 ? ((suspAmt   / totalSupply) * 100).toFixed(1) : '?';

  report({ step: 'Done!', pct: 100 });

  return {
    mint: mintAddress,
    launchSlot,
    totalSupply,
    isPumpToken,
    buyers,
    stats: {
      total:        buyers.length,
      bundled:      bundled.length,
      suspicious:   suspicious.length,
      fullPort:     fullPorts.length,
      bundledPct,
      suspiciousPct: suspPct,
      bundleGroups: Object.keys(groupLabels).length,
    },
    sourceMap,
    groupLabels,
  };
}

// ── Trace SOL funding source of a wallet ────
async function traceFundingSource(walletAddress) {
  try {
    const sigs = await bundleRpc('getSignaturesForAddress', [walletAddress, { limit: 10 }]);
    if (!sigs?.length) return null;

    // Check oldest transactions for incoming SOL
    const oldest = [...sigs].reverse().slice(0, 3);

    for (const sig of oldest) {
      const tx = await bundleRpc('getTransaction', [
        sig.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
      ]);
      if (!tx?.meta) continue;

      const accounts = tx.transaction?.message?.accountKeys || [];
      const pre      = tx.meta.preBalances  || [];
      const post     = tx.meta.postBalances || [];
      const addrs    = accounts.map(a => typeof a === 'string' ? a : a.pubkey);

      // Find who sent SOL to this wallet
      const walletIdx = addrs.indexOf(walletAddress);
      if (walletIdx === -1) continue;

      const walletGained = (post[walletIdx] || 0) - (pre[walletIdx] || 0);
      if (walletGained <= 0) continue;

      // Find the sender (largest SOL decrease that isn't the wallet itself)
      let sender = null;
      let maxLost = 0;
      for (let i = 0; i < addrs.length; i++) {
        if (addrs[i] === walletAddress) continue;
        const lost = (pre[i] || 0) - (post[i] || 0);
        if (lost > maxLost) {
          maxLost = lost;
          sender  = addrs[i];
        }
      }

      if (sender && maxLost > 5000) return sender;
    }

    return null;
  } catch { return null; }
}
// ═══════════════════════════════════════════
// WALLET CONNECTION ANALYSIS
// ═══════════════════════════════════════════

// Checks a list of wallet addresses for connections:
//  1. Direct SOL/token transfers between them
//  2. Shared funding source (same wallet funded multiple)
//  3. Same-time funding (funded within 2 slots of each other)

async function analyzeWalletConnections(addresses, onProgress) {
  const report = p => onProgress && onProgress(p);
  const n = addresses.length;

  if (n < 2) throw new Error('Select at least 2 wallets to check connections.');

  report({ step: `Tracing funding sources for ${n} wallets…`, pct: 5 });

  // ── Step 1: Get funding info for every wallet ──────────────────────────
  const walletData = [];
  for (let i = 0; i < n; i++) {
    const addr = addresses[i];
    const info = await getFundingInfo(addr);
    walletData.push({ addr, ...info });
    report({ step: `Tracing ${i + 1} / ${n}…`, pct: 5 + Math.floor((i / n) * 40) });
    await sleep(150);
  }

  report({ step: 'Scanning for direct transfers between wallets…', pct: 46 });

  // ── Step 2: Scan recent tx history of each wallet for direct transfers ─
  const addrSet       = new Set(addresses);
  const directTxList  = [];
  const connMap       = {}; // addr → Set of addrs it's connected to
  addresses.forEach(a => { connMap[a] = new Set(); });

  for (let i = 0; i < n; i++) {
    const addr = addresses[i];
    try {
      const sigs = await bundleRpc('getSignaturesForAddress', [addr, { limit: 40, commitment: 'confirmed' }]);
      if (!sigs?.length) continue;

      for (const s of sigs.slice(0, 30)) {
        const tx = await bundleRpc('getTransaction', [s.signature, {
          encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed'
        }]);
        if (!tx?.meta || tx.meta.err) continue;

        const accounts = (tx.transaction?.message?.accountKeys || []).map(a => typeof a === 'string' ? a : a.pubkey);
        const pre       = tx.meta.preBalances  || [];
        const post      = tx.meta.postBalances || [];

        // Check if any other watched wallet is in this tx's accounts
        for (let j = 0; j < accounts.length; j++) {
          const other = accounts[j];
          if (!addrSet.has(other) || other === addr) continue;

          // Is there a meaningful SOL flow between addr and other?
          const addrIdx  = accounts.indexOf(addr);
          const solLost  = addrIdx >= 0 ? (pre[addrIdx]  || 0) - (post[addrIdx]  || 0) : 0;
          const solGained= j >= 0       ? (post[j] || 0) - (pre[j] || 0)              : 0;

          const isDirectTransfer = solLost > 5000 || solGained > 5000;
          if (!isDirectTransfer) continue;

          const from = solLost > 0 ? addr  : other;
          const to   = solLost > 0 ? other : addr;
          const solAmt = Math.max(solLost, solGained);

          // Deduplicate by signature
          if (!directTxList.find(t => t.sig === s.signature && t.from === from)) {
            directTxList.push({ sig: s.signature, from, to, solAmt, slot: tx.slot });
            connMap[from]?.add(to);
            connMap[to]?.add(from);
          }
        }
      }
    } catch {}
    report({ step: `Scanning wallet ${i + 1} / ${n}…`, pct: 46 + Math.floor((i / n) * 30) });
    await sleep(100);
  }

  report({ step: 'Grouping shared funders…', pct: 78 });

  // ── Step 3: Group by shared funder ────────────────────────────────────
  const funderMap = {};
  for (const w of walletData) {
    if (!w.fundingSource) continue;
    if (!funderMap[w.fundingSource]) funderMap[w.fundingSource] = [];
    funderMap[w.fundingSource].push({ addr: w.addr, amt: w.fundingAmount || 0 });
  }
  const sharedFunderGroups = Object.entries(funderMap)
    .filter(([, ws]) => ws.length > 1)
    .map(([funder, wallets]) => ({ funder, wallets }));

  // Mark connections from shared funders
  for (const grp of sharedFunderGroups) {
    for (const w of grp.wallets) {
      for (const other of grp.wallets) {
        if (other.addr !== w.addr) connMap[w.addr]?.add(other.addr);
      }
    }
  }

  report({ step: 'Detecting same-time funding…', pct: 85 });

  // ── Step 4: Same-time funding (within 2 slots) ────────────────────────
  // Group wallets whose FIRST funding tx landed within 2 slots of each other
  const bySlot = {};
  for (const w of walletData) {
    if (!w.fundingSlot) continue;
    // Round to nearest 2-slot window
    const bucket = Math.floor(w.fundingSlot / 2) * 2;
    if (!bySlot[bucket]) bySlot[bucket] = [];
    bySlot[bucket].push({ addr: w.addr, funder: w.fundingSource, slot: w.fundingSlot });
  }
  const sameFundingGroups = Object.entries(bySlot)
    .filter(([, ws]) => ws.length > 1)
    .map(([slot, wallets]) => ({ slot: parseInt(slot), wallets }));

  report({ step: 'Done!', pct: 100 });

  // ── Build per-wallet connectedTo list ──────────────────────────────────
  const wallets = walletData.map(w => ({
    ...w,
    connectedTo: [...(connMap[w.addr] || [])],
  }));

  const connectionCount =
    sharedFunderGroups.length + directTxList.length + sameFundingGroups.length;

  return {
    wallets,
    directTxList,
    sharedFunderGroups,
    sameFundingGroups,
    connectionCount,
    directTransfers:  directTxList.length,
    sharedFunders:    sharedFunderGroups.length,
    sameFundingTime:  sameFundingGroups.length,
  };
}

// ── Get funding source AND slot for a wallet ───────────────────────────────
// Returns { fundingSource, fundingAmount, fundingSlot }
async function getFundingInfo(walletAddress) {
  try {
    const sigs = await bundleRpc('getSignaturesForAddress', [walletAddress, { limit: 15 }]);
    if (!sigs?.length) return { fundingSource: null, fundingAmount: 0, fundingSlot: null };

    // Check oldest transactions for the first incoming SOL
    const oldest = [...sigs].reverse().slice(0, 5);

    for (const sig of oldest) {
      const tx = await bundleRpc('getTransaction', [
        sig.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
      ]);
      if (!tx?.meta) continue;

      const accounts = (tx.transaction?.message?.accountKeys || []).map(a => typeof a === 'string' ? a : a.pubkey);
      const pre       = tx.meta.preBalances  || [];
      const post      = tx.meta.postBalances || [];
      const walletIdx = accounts.indexOf(walletAddress);
      if (walletIdx === -1) continue;

      const gained = (post[walletIdx] || 0) - (pre[walletIdx] || 0);
      if (gained <= 0) continue;

      // Find sender (largest SOL decrease)
      let sender = null, maxLost = 0;
      for (let i = 0; i < accounts.length; i++) {
        if (accounts[i] === walletAddress) continue;
        const lost = (pre[i] || 0) - (post[i] || 0);
        if (lost > maxLost) { maxLost = lost; sender = accounts[i]; }
      }

      if (sender && maxLost > 5000) {
        return {
          fundingSource: sender,
          fundingAmount: maxLost,
          fundingSlot:   tx.slot,
        };
      }
    }
    return { fundingSource: null, fundingAmount: 0, fundingSlot: null };
  } catch {
    return { fundingSource: null, fundingAmount: 0, fundingSlot: null };
  }
}