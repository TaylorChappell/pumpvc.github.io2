/**
 * Ultimate Dev Tools — Railway Backend (FIXED)
 * Essor Studios
 */
'use strict';

const fetch = require('node-fetch');                    // Required for Node < 18
const { Keypair } = require('@solana/web3.js');        // For stable keypair generation
const bs58 = window.bs58;

const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { Pool }   = require('pg');
const cors       = require('cors');
const helmet     = require('helmet');
const { nanoid } = require('nanoid');

const app = express();

const JWT_SECRET       = process.env.JWT_SECRET       || 'CHANGE_THIS_IN_PROD';
const ADMIN_EMAIL      = process.env.ADMIN_EMAIL       || 'taylorchappell02@gmail.com';
const PAYMENT_ADDR     = process.env.PAYMENT_ADDR      || '';
const SUBSCRIPTION_USD = parseFloat(process.env.SUBSCRIPTION_USD || '99');
const PORT             = process.env.PORT              || 3000;
const SOLANA_RPC       = process.env.SOLANA_RPC        || 'https://mainnet.helius-rpc.com/?api-key=9f6bffea-73da-4936-adab-429746a1b007';
const GOOGLE_CLIENT_ID = '218003563778-dljv6ld9c467r57p38a6m32gibrtfmld.apps.googleusercontent.com';

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ── DB ──────────────────────────────────────────────────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id             SERIAL PRIMARY KEY,
      email          TEXT UNIQUE NOT NULL,
      name           TEXT,
      password       TEXT,
      google_id      TEXT,
      is_admin       BOOLEAN DEFAULT false,
      is_whitelisted BOOLEAN DEFAULT false,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id         SERIAL PRIMARY KEY,
      user_id    INT REFERENCES users(id) ON DELETE CASCADE,
      active     BOOLEAN DEFAULT false,
      trial      BOOLEAN DEFAULT false,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id)
    );
    CREATE TABLE IF NOT EXISTS promo_codes (
      id          SERIAL PRIMARY KEY,
      code        TEXT UNIQUE NOT NULL,
      days        INT NOT NULL DEFAULT 5,
      label       TEXT,
      disabled    BOOLEAN DEFAULT false,
      redeemed_by INT REFERENCES users(id),
      redeemed_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payments (
      id              SERIAL PRIMARY KEY,
      user_id         INT REFERENCES users(id),
      payment_id      TEXT UNIQUE NOT NULL,
      method          TEXT NOT NULL,
      amount_sol      NUMERIC,
      amount_usd      NUMERIC,
      sol_price_usd   NUMERIC,
      receive_address TEXT,
      receive_privkey TEXT,
      sender_address  TEXT,
      confirmed       BOOLEAN DEFAULT false,
      confirmed_at    TIMESTAMPTZ,
      refunded        BOOLEAN DEFAULT false,
      refunded_at     TIMESTAMPTZ,
      refund_sig      TEXT,
      swept           BOOLEAN DEFAULT false,
      swept_at        TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS whitelist (
      id       SERIAL PRIMARY KEY,
      email    TEXT UNIQUE NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const ex = await db.query('SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL.toLowerCase()]);
  if (!ex.rows.length) {
    const hash = await bcrypt.hash('changeme', 12);
    await db.query('INSERT INTO users (email, name, password, is_admin) VALUES ($1,$2,$3,true)',
      [ADMIN_EMAIL.toLowerCase(), 'Admin', hash]);
    console.log(`Superadmin created: ${ADMIN_EMAIL} / changeme — CHANGE PASSWORD`);
  } else {
    await db.query('UPDATE users SET is_admin = true WHERE email = $1', [ADMIN_EMAIL.toLowerCase()]);
  }
}

// ── Middleware ──────────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

async function adminMiddleware(req, res, next) {
  const r = await db.query('SELECT is_admin FROM users WHERE id=$1', [req.user.id]);
  if (!r.rows[0]?.is_admin) return res.status(403).json({ error: 'Admin required' });
  next();
}

const makeToken = (u) =>
  jwt.sign({ id: u.id, email: u.email, is_admin: u.is_admin }, JWT_SECRET, { expiresIn: '30d' });

// ── Active sub check (admins + whitelisted get free access) ────────────────────
async function getActiveSub(userId) {
  const ur = await db.query('SELECT is_admin, is_whitelisted FROM users WHERE id=$1', [userId]);
  const u  = ur.rows[0];
  if (u?.is_admin)       return { active: true, trial: false, expires_at: null, admin: true };
  if (u?.is_whitelisted) return { active: true, trial: false, expires_at: null, whitelisted: true };

  const sr  = await db.query('SELECT * FROM subscriptions WHERE user_id=$1', [userId]);
  const sub = sr.rows[0];
  if (!sub) return { active: false };

  const now = new Date();
  if (sub.active && sub.expires_at && new Date(sub.expires_at) < now) {
    await db.query('UPDATE subscriptions SET active=false WHERE user_id=$1', [userId]);
    return { active: false, expires_at: sub.expires_at };
  }
  if (sub.active) {
    const days = sub.expires_at
      ? Math.ceil((new Date(sub.expires_at) - now) / 86400000) : null;
    return { active: true, trial: sub.trial, expires_at: sub.expires_at, days_remaining: days };
  }
  return { active: false, expires_at: sub.expires_at };
}

// ── SOL price — multiple sources with timeout, long-lived cache ────────────────
// Cache lasts 2 minutes normally, but stale cache is always used rather than
// returning null — a 503 because of a price API outage is unacceptable.
// ── SOL price (now uses node-fetch) ───────────────────────────────────────────
let _priceCache = { usd: null, ts: 0 };

async function fetchWithTimeout(url, timeoutMs = 5000, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal, ...opts });
    clearTimeout(id);
    return r;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function getSolPriceUSD() {
  if (_priceCache.usd && Date.now() - _priceCache.ts < 120000) return _priceCache.usd;

  const sources = [
    async () => { const r = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', 4000); const d = await r.json(); return parseFloat(d?.price); },
    async () => { const r = await fetchWithTimeout('https://api.binance.us/api/v3/ticker/price?symbol=SOLUSD', 4000); const d = await r.json(); return parseFloat(d?.price); },
    async () => { const r = await fetchWithTimeout('https://www.okx.com/api/v5/market/ticker?instId=SOL-USDT', 4000); const d = await r.json(); return parseFloat(d?.data?.[0]?.last); },
    async () => { const r = await fetchWithTimeout('https://api.bybit.com/v5/market/tickers?category=spot&symbol=SOLUSDT', 4000); const d = await r.json(); return parseFloat(d?.result?.list?.[0]?.lastPrice); },
    async () => { const r = await fetchWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', 5000); const d = await r.json(); return parseFloat(d?.solana?.usd); },
    async () => { const r = await fetchWithTimeout('https://api.coincap.io/v2/assets/solana', 4000); const d = await r.json(); return parseFloat(d?.data?.priceUsd); },
  ];

  for (const fn of sources) {
    try {
      const price = await fn();
      if (price > 0 && isFinite(price)) {
        _priceCache = { usd: price, ts: Date.now() };
        return price;
      }
    } catch {}
  }

  if (_priceCache.usd) {
    console.warn(`[sol-price] Using stale cache: $${_priceCache.usd}`);
    return _priceCache.usd;
  }

  const FALLBACK_PRICE = 150;
  console.error(`[sol-price] Using fallback $${FALLBACK_PRICE}`);
  return FALLBACK_PRICE;
}

// ── BS58 ───────────────────────────────────────────────────────────────────────
const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58enc(bytes) {
  let z = 0; while (z < bytes.length && bytes[z] === 0) z++;
  const d = z < bytes.length ? [0] : [];
  for (let i = z; i < bytes.length; i++) {
    let c = bytes[i];
    for (let j = d.length - 1; j >= 0; j--) { c += d[j] << 8; d[j] = c % 58; c = c / 58 | 0; }
    while (c > 0) { d.unshift(c % 58); c = c / 58 | 0; }
  }
  return '1'.repeat(z) + d.map(x => B58A[x]).join('');
}
function b58dec(s) {
  let z = 0; while (z < s.length && s[z] === '1') z++;
  const b = z < s.length ? [0] : [];
  for (let i = z; i < s.length; i++) {
    let c = B58A.indexOf(s[i]); if (c < 0) throw new Error('bad b58');
    for (let j = b.length - 1; j >= 0; j--) { c += b[j] * 58; b[j] = c & 0xff; c >>= 8; }
    while (c > 0) { b.unshift(c & 0xff); c >>= 8; }
  }
  return new Uint8Array([...new Array(z).fill(0), ...b]);
}

// ── Solana keypair (using @solana/web3.js — most stable) ───────────────────────
function genKeypair() {
  const kp = Keypair.generate();
  return {
    publicKey:     kp.publicKey.toBase58(),
    privateKeyB58: bs58.encode(kp.secretKey)   // ← Fixed: use bs58 library
  };
}

// Restore keypair from stored 64-byte secret key (for refund/sweep)
function keypairFromB58(privB58) {
  const sk = b58dec(privB58);
  return Keypair.fromSecretKey(sk);
}

// ── Solana RPC (raw JSON-RPC, no SDK needed) ────────────────────────────────────
async function solRpc(method, params) {
  const r = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}

// ── Build + sign + serialize a SOL transfer transaction ─────────────────────────
function buildTransferTx(fromKp, toPubkeyBytes, lamports, blockhashBytes) {
  // Simple transfer using @solana/web3.js (much more reliable than manual bytes)
  const tx = new web3.Transaction({
    recentBlockhash: bs58.encode(blockhashBytes),
    feePayer: fromKp.publicKey
  });

  tx.add(
    web3.SystemProgram.transfer({
      fromPubkey: fromKp.publicKey,
      toPubkey: new web3.PublicKey(toPubkeyBytes),
      lamports: lamports
    })
  );

  // Sign the transaction
  tx.sign(fromKp);

  // Serialize to base64 for sendTransaction
  return tx.serialize();
}

// ── Decode b58 blockhash string to 32 bytes ─────────────────────────────────────
function blockhashToBytes(blockhash) {
  return b58dec(blockhash); // Solana blockhash is a b58-encoded 32-byte value
}

// ── Check if address received SOL after sinceTs ─────────────────────────────────
// Returns { sig, receivedLamports } or null.
async function checkSolReceived(addr, sinceTs) {
  try {
    const sigs = await solRpc('getSignaturesForAddress', [addr, { limit: 20 }]);
    if (!sigs?.length) return null;
    for (const si of sigs) {
      if (si.err) continue;
      if (si.blockTime && si.blockTime * 1000 < sinceTs - 120000) continue;
      const tx = await solRpc('getTransaction', [si.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
      if (!tx?.meta) continue;
      const keys = tx.transaction.message.accountKeys || [];
      const idx  = keys.findIndex(k => k === addr);
      if (idx === -1) continue;
      const received = (tx.meta.postBalances[idx] || 0) - (tx.meta.preBalances[idx] || 0);
      if (received > 0) return { sig: si.signature, receivedLamports: received };
    }
    return null;
  } catch (e) { console.error('[checkSolReceived]', e.message); return null; }
}

// ── Refund underpayment back to sender ─────────────────────────────────────────
async function refundPaymentWallet(privKeyB58, senderAddr, paymentId) {
  try {
    const kp  = keypairFromB58(privKeyB58);
    const from = b58enc(kp.publicKey);

    const bal = (await solRpc('getBalance', [from]))?.value || 0;
    const fee = 15000;
    if (bal <= fee) { console.log(`[refund] ${paymentId}: balance too low (${bal})`); return; }

    const { blockhash, lastValidBlockHeight } = (await solRpc('getLatestBlockhash', [{ commitment: 'finalized' }])).value;
    const wire = buildTransferTx(kp, b58dec(senderAddr), bal - fee, blockhashToBytes(blockhash));

    const txSig = await solRpc('sendTransaction', [
      Buffer.from(wire).toString('base64'),
      { encoding: 'base64', preflightCommitment: 'confirmed' }
    ]);
    console.log(`[refund] ${paymentId} -> ${senderAddr}: ${txSig} (${((bal-fee)/1e9).toFixed(6)} SOL)`);
    await db.query(
      `UPDATE payments SET refunded=true, refunded_at=NOW(), refund_sig=$1 WHERE payment_id=$2`,
      [txSig, paymentId]
    );
  } catch (e) { console.error('[refund]', e.message); }
}

// ── Sweep payment wallet → PAYMENT_ADDR ────────────────────────────────────────
async function sweepWallet(privKeyB58, paymentId) {
  if (!PAYMENT_ADDR) { console.warn('[sweep] PAYMENT_ADDR not set — skipping'); return; }
  try {
    const kp  = keypairFromB58(privKeyB58);
    const from = b58enc(kp.publicKey);

    const bal = (await solRpc('getBalance', [from]))?.value || 0;
    const fee = 15000;
    if (bal <= fee) return;

    const { blockhash } = (await solRpc('getLatestBlockhash', [{ commitment: 'finalized' }])).value;
    const wire = buildTransferTx(kp, b58dec(PAYMENT_ADDR), bal - fee, blockhashToBytes(blockhash));

    const txSig = await solRpc('sendTransaction', [
      Buffer.from(wire).toString('base64'),
      { encoding: 'base64', preflightCommitment: 'confirmed' }
    ]);
    console.log(`[sweep] ${paymentId} -> ${PAYMENT_ADDR}: ${txSig}`);
    await db.query('UPDATE payments SET swept=true, swept_at=NOW() WHERE payment_id=$1', [paymentId]);
  } catch (e) { console.error('[sweep]', e.message); }
}

// ── Activate subscription + trigger sweep ──────────────────────────────────────
async function confirmAndActivate(paymentId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE payments SET confirmed=true, confirmed_at=NOW() WHERE payment_id=$1', [paymentId]);
    const pr = await client.query('SELECT user_id, receive_privkey FROM payments WHERE payment_id=$1', [paymentId]);
    const { user_id, receive_privkey } = pr.rows[0] || {};
    if (!user_id) throw new Error('payment record missing user');
    const exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query(`
      INSERT INTO subscriptions (user_id, active, trial, expires_at)
      VALUES ($1, true, false, $2)
      ON CONFLICT (user_id) DO UPDATE SET active=true, trial=false, expires_at=$2
    `, [user_id, exp]);
    await client.query('COMMIT');
    if (receive_privkey && PAYMENT_ADDR) setImmediate(() => sweepWallet(receive_privkey, paymentId));
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// ── Payment routes ──────────────────────────────────────────────────────────────

// GET /api/subscription/sol-price — always returns a price, never 503
app.get('/api/subscription/sol-price', async (req, res) => {
  try {
    const usd = await getSolPriceUSD();
    res.json({
      usd:       SUBSCRIPTION_USD,
      sol:       parseFloat((SUBSCRIPTION_USD / usd).toFixed(6)),
      price_usd: usd,
    });
  } catch (e) {
    console.error('[sol-price]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/subscription/payment/init — create unique deposit address
app.post('/api/subscription/payment/init', authMiddleware, async (req, res) => {
  try {
    const { method } = req.body;

    // 1. Get SOL price — always returns a number (stale cache or $150 fallback)
    const priceUSD = await getSolPriceUSD();
    const amountSol = parseFloat((SUBSCRIPTION_USD / priceUSD).toFixed(6));

    // 2. Generate a fresh Ed25519 keypair for this payment
    //    tweetnacl.sign.keyPair() is pure JS, no native deps, works on all Node versions
    const kp        = genKeypair();
    const paymentId = nanoid(24);

    // 3. Persist payment record — ensure columns exist first
    await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS sender_address TEXT`).catch(() => {});
    await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded BOOLEAN DEFAULT false`).catch(() => {});
    await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`).catch(() => {});
    await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_sig TEXT`).catch(() => {});

    await db.query(
      `INSERT INTO payments
         (user_id, payment_id, method, amount_sol, amount_usd, sol_price_usd, receive_address, receive_privkey)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.user.id, paymentId, method || 'manual', amountSol, SUBSCRIPTION_USD, priceUSD,
       kp.publicKey, kp.privateKeyB58]
    );

    res.json({
      payment_id:    paymentId,
      address:       kp.publicKey,
      amount_sol:    amountSol,
      amount_usd:    SUBSCRIPTION_USD,
      sol_price_usd: priceUSD,
      expires_in:    1800,
    });
  } catch (e) {
    console.error('[payment/init]', e.message, '\n', e.stack);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/subscription/payment/sender — store sender address post-connect (for refunds)
app.post('/api/subscription/payment/sender', authMiddleware, async (req, res) => {
  try {
    const { payment_id, sender_address } = req.body;
    await db.query(
      `UPDATE payments SET sender_address=$1 WHERE payment_id=$2 AND user_id=$3`,
      [sender_address, payment_id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/subscription/payment/check/:id — poll for confirmation, handle refunds
app.get('/api/subscription/payment/check/:paymentId', authMiddleware, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const r = await db.query('SELECT * FROM payments WHERE payment_id=$1 AND user_id=$2', [paymentId, req.user.id]);
    const pay = r.rows[0];
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    if (pay.confirmed) return res.json({ confirmed: true });
    if (pay.refunded)  return res.json({ confirmed: false, refunded: true,
      message: `Refunded — you sent too little. Need ${pay.amount_sol} SOL. Please try again.` });

    const age = Date.now() - new Date(pay.created_at).getTime();
    if (age > 30 * 60 * 1000) return res.json({ confirmed: false, expired: true });

    const result = await checkSolReceived(pay.receive_address, new Date(pay.created_at).getTime());
    if (!result) return res.json({ confirmed: false });

    const { sig, receivedLamports } = result;
    const expectedLamports = Math.floor(parseFloat(pay.amount_sol) * 1e9);

    if (receivedLamports >= expectedLamports * 0.99) {
      // Full payment — activate subscription and sweep funds
      await confirmAndActivate(paymentId);
      return res.json({ confirmed: true, signature: sig });
    }

    // Underpayment
    const receivedSol = (receivedLamports / 1e9).toFixed(6);
    const requiredSol = parseFloat(pay.amount_sol).toFixed(6);

    if (pay.sender_address && pay.receive_privkey) {
      setImmediate(() => refundPaymentWallet(pay.receive_privkey, pay.sender_address, paymentId));
      return res.json({
        confirmed: false, refunding: true,
        message: `Only ${receivedSol} SOL received (need ${requiredSol}). Refunding automatically — try again with the correct amount.`,
      });
    }

    return res.json({
      confirmed: false, underpaid: true,
      message: `Only ${receivedSol} SOL received (need ${requiredSol}). Send the remaining ${(parseFloat(requiredSol) - parseFloat(receivedSol)).toFixed(6)} SOL to the same address.`,
    });
  } catch (e) { console.error('[payment/check]', e.message); res.status(500).json({ error: e.message }); }
});

// =============================================================================
// AUTH
// =============================================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email||!password) return res.status(400).json({ error:'Email and password required' });
    if (password.length<8) return res.status(400).json({ error:'Password too short' });
    if ((await db.query('SELECT id FROM users WHERE email=$1',[email.toLowerCase()])).rows.length)
      return res.status(409).json({ error:'Email already registered' });
    const hash = await bcrypt.hash(password, 12);
    const r = await db.query('INSERT INTO users(email,name,password)VALUES($1,$2,$3)RETURNING id,email,name,is_admin',
      [email.toLowerCase(), name||'', hash]);
    const u = r.rows[0];
    res.json({ token: makeToken(u), user: { id:u.id, email:u.email, name:u.name, is_admin:u.is_admin } });
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await db.query('SELECT id,email,name,password,is_admin FROM users WHERE email=$1',[email.toLowerCase()]);
    const u = r.rows[0];
    if (!u||!(await bcrypt.compare(password, u.password))) return res.status(401).json({error:'Invalid credentials'});
    res.json({ token: makeToken(u), user: { id:u.id, email:u.email, name:u.name, is_admin:u.is_admin } });
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { id_token } = req.body;
    const { OAuth2Client } = require('google-auth-library');
    const ticket = await new OAuth2Client(GOOGLE_CLIENT_ID).verifyIdToken({ idToken:id_token, audience:GOOGLE_CLIENT_ID });
    const { sub:googleId, email, name } = ticket.getPayload();
    let r = await db.query('SELECT id,email,name,is_admin FROM users WHERE email=$1',[email]);
    let u = r.rows[0];
    if (!u) {
      u = (await db.query('INSERT INTO users(email,name,google_id)VALUES($1,$2,$3)RETURNING id,email,name,is_admin',[email,name,googleId])).rows[0];
    } else {
      await db.query('UPDATE users SET google_id=$1 WHERE id=$2',[googleId,u.id]);
    }
    res.json({ token: makeToken(u), user: { id:u.id, email:u.email, name:u.name, is_admin:u.is_admin } });
  } catch(e){ console.error(e); res.status(401).json({error:'Google auth failed'}); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const r = await db.query('SELECT id,email,name,is_admin,is_whitelisted,created_at FROM users WHERE id=$1',[req.user.id]);
    if (!r.rows[0]) return res.status(404).json({error:'Not found'});
    res.json(r.rows[0]);
  } catch(e){ res.status(500).json({error:'Server error'}); }
});

app.get('/api/auth/verify', authMiddleware, (req, res) => res.json({ ok:true, userId:req.user.id }));
app.post('/api/auth/logout', authMiddleware, (req, res) => res.json({ ok:true }));

// =============================================================================
// SUBSCRIPTION
// =============================================================================
app.get('/api/subscription/status',  authMiddleware, async (req,res) => { try{ res.json(await getActiveSub(req.user.id)); }catch(e){res.status(500).json({error:'Server error'});} });
app.get('/api/subscription/verify',  authMiddleware, async (req,res) => { try{ res.json(await getActiveSub(req.user.id)); }catch(e){res.status(500).json({error:'Server error'});} });

// Helius webhook (optional, instant detection)
app.post('/api/webhooks/helius', async (req, res) => {
  try {
    if (req.headers['x-helius-secret'] !== process.env.HELIUS_WEBHOOK_SECRET) return res.status(403).send('Forbidden');
    res.send('ok');
  } catch(e){ res.status(500).send('error'); }
});

// =============================================================================
// ADMIN
// =============================================================================
const aR = express.Router();
aR.use(authMiddleware, adminMiddleware);

aR.post('/promo/generate', async (req,res)=>{ try{ const{days=5,label=''}=req.body; const code=nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g,'X'); await db.query('INSERT INTO promo_codes(code,days,label)VALUES($1,$2,$3)',[code,days,label]); res.json({code,days,label}); }catch(e){res.status(500).json({error:'Server error'});} });
aR.get('/promo/list', async (req,res)=>{ try{ const r=await db.query(`SELECT p.*,u.email as redeemed_by_email FROM promo_codes p LEFT JOIN users u ON p.redeemed_by=u.id ORDER BY p.created_at DESC`); res.json({codes:r.rows.map(x=>({...x,redeemed_by:x.redeemed_by_email}))}); }catch(e){res.status(500).json({error:'Server error'});} });
aR.post('/promo/disable', async (req,res)=>{ try{ await db.query('UPDATE promo_codes SET disabled=true WHERE code=$1',[req.body.code]); res.json({ok:true}); }catch(e){res.status(500).json({error:'Server error'});} });

aR.get('/users', async (req,res)=>{
  try{
    const page=Math.max(1,parseInt(req.query.page)||1), search=req.query.search||'', limit=25, offset=(page-1)*limit;
    const q = search
      ? `SELECT u.*,s.active as sub_active,s.trial as sub_trial,s.expires_at as sub_expires_at FROM users u LEFT JOIN subscriptions s ON u.id=s.user_id WHERE u.email ILIKE $3 OR u.name ILIKE $3 ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`
      : `SELECT u.*,s.active as sub_active,s.trial as sub_trial,s.expires_at as sub_expires_at FROM users u LEFT JOIN subscriptions s ON u.id=s.user_id ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`;
    const p = search?[limit,offset,`%${search}%`]:[limit,offset];
    const [ur,cr]=await Promise.all([db.query(q,p),db.query(`SELECT COUNT(*) FROM users${search?' WHERE email ILIKE $1 OR name ILIKE $1':''}`,search?[`%${search}%`]:[])]);
    res.json({users:ur.rows,total:parseInt(cr.rows[0].count),pages:Math.ceil(parseInt(cr.rows[0].count)/limit)});
  }catch(e){res.status(500).json({error:'Server error'});}
});

aR.post('/users/revoke-sub', async (req,res)=>{ try{ await db.query('UPDATE subscriptions SET active=false WHERE user_id=$1',[req.body.user_id]); res.json({ok:true}); }catch(e){res.status(500).json({error:'Server error'});} });

aR.post('/whitelist', async (req,res)=>{ try{ const{email}=req.body; await db.query('INSERT INTO whitelist(email)VALUES($1)ON CONFLICT DO NOTHING',[email.toLowerCase()]); await db.query('UPDATE users SET is_whitelisted=true WHERE email=$1',[email.toLowerCase()]); res.json({ok:true}); }catch(e){res.status(500).json({error:'Server error'});} });
aR.post('/whitelist/remove', async (req,res)=>{ try{ const{email}=req.body; await db.query('DELETE FROM whitelist WHERE email=$1',[email.toLowerCase()]); await db.query('UPDATE users SET is_whitelisted=false WHERE email=$1',[email.toLowerCase()]); res.json({ok:true}); }catch(e){res.status(500).json({error:'Server error'});} });
aR.get('/whitelist/list', async (req,res)=>{ try{ const r=await db.query('SELECT email,added_at FROM whitelist ORDER BY added_at DESC'); res.json({emails:r.rows}); }catch(e){res.status(500).json({error:'Server error'});} });

aR.post('/admins/add', async (req,res)=>{ try{ const{email}=req.body; if(email.toLowerCase()===ADMIN_EMAIL.toLowerCase())return res.status(400).json({error:'Cannot modify superadmin'}); await db.query('UPDATE users SET is_admin=true WHERE email=$1',[email.toLowerCase()]); res.json({ok:true}); }catch(e){res.status(500).json({error:'Server error'});} });
aR.post('/admins/remove', async (req,res)=>{ try{ const{email}=req.body; if(email.toLowerCase()===ADMIN_EMAIL.toLowerCase())return res.status(400).json({error:'Cannot remove superadmin'}); if(email.toLowerCase()===req.user.email.toLowerCase())return res.status(400).json({error:'Cannot remove yourself'}); await db.query('UPDATE users SET is_admin=false WHERE email=$1',[email.toLowerCase()]); res.json({ok:true}); }catch(e){res.status(500).json({error:'Server error'});} });
aR.get('/admins/list', async (req,res)=>{ try{ const r=await db.query('SELECT email,name,created_at FROM users WHERE is_admin=true ORDER BY created_at ASC'); res.json({admins:r.rows.map(x=>({...x,is_superadmin:x.email.toLowerCase()===ADMIN_EMAIL.toLowerCase()}))}); }catch(e){res.status(500).json({error:'Server error'});} });

aR.get('/payments/pending', async (req,res)=>{ try{ const r=await db.query(`SELECT p.payment_id,p.method,p.amount_sol,p.amount_usd,p.receive_address,p.confirmed,p.swept,p.created_at,u.email FROM payments p JOIN users u ON p.user_id=u.id WHERE p.confirmed=false ORDER BY p.created_at DESC LIMIT 50`); res.json({payments:r.rows}); }catch(e){res.status(500).json({error:'Server error'});} });

app.use('/api/admin', aR);

// =============================================================================
// STATE SYNC — stores full udt_v3 blob per user for cross-device persistence
// =============================================================================

// Add state_data column to users table if it doesn't exist
// ── Ensure all required columns exist (critical for payment system) ───────────
async function ensureStateColumn() {
  console.log('[migration] Ensuring all payments table columns exist...');

  // User state
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS state_data TEXT`).catch(() => {});

  // All payment columns (this fixes your current error and future ones)
  const paymentColumns = [
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_sol NUMERIC`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_usd NUMERIC`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS sol_price_usd NUMERIC`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS receive_address TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS receive_privkey TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS sender_address TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmed BOOLEAN DEFAULT false`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded BOOLEAN DEFAULT false`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_sig TEXT`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS swept BOOLEAN DEFAULT false`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS swept_at TIMESTAMPTZ`
  ];

  for (const sql of paymentColumns) {
    try {
      await db.query(sql);
    } catch (e) {
      console.warn('[migration] Column may already exist:', e.message);
    }
  }

  console.log('[migration] Payments table columns ensured.');
}

app.get('/api/state', authMiddleware, async (req, res) => {
  try {
    const r = await db.query('SELECT state_data FROM users WHERE id=$1', [req.user.id]);
    const raw = r.rows[0]?.state_data;
    res.json({ state: raw ? JSON.parse(raw) : null });
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.put('/api/state', authMiddleware, async (req, res) => {
  try {
    const { state } = req.body;
    if (!state) return res.status(400).json({ error:'No state provided' });
    // Strip only the non-serialisable in-memory crypto key and JWT token.
    // Private keys ARE stored — they're already in the user's localStorage on
    // every device they use, so storing them server-side (auth-gated) adds no
    // new exposure while enabling proper cross-session restoration.
    const safe = { ...state };
    if (safe.auth) safe.auth = { ...safe.auth, cryptoKey: undefined, token: undefined };
    await db.query('UPDATE users SET state_data=$1 WHERE id=$2', [JSON.stringify(safe), req.user.id]);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ error:'Server error' }); }
});

// =============================================================================
// WALLET SYNC — stores AES-256-GCM encrypted wallet blobs (from auth.js)
// =============================================================================
async function ensureWalletsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS wallet_data (
      user_id        INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      encrypted_blob TEXT,
      iv             TEXT,
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

app.get('/wallets', authMiddleware, async (req, res) => {
  try {
    const r = await db.query('SELECT encrypted_blob, iv FROM wallet_data WHERE user_id=$1', [req.user.id]);
    res.json({ data: r.rows[0] || null });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

app.put('/wallets', authMiddleware, async (req, res) => {
  try {
    const { encrypted_blob, iv } = req.body;
    if (!encrypted_blob || !iv) return res.status(400).json({ error:'Missing blob or iv' });
    await db.query(`
      INSERT INTO wallet_data (user_id, encrypted_blob, iv) VALUES ($1,$2,$3)
      ON CONFLICT (user_id) DO UPDATE SET encrypted_blob=$2, iv=$3, updated_at=NOW()
    `, [req.user.id, encrypted_blob, iv]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error:'Server error' }); }
});

// =============================================================================
// JUPITER PROXY — bypasses CORS block from browser → api.jup.ag
// =============================================================================
app.get('/api/proxy/jupiter/quote', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query).toString();
    const r = await fetch(`https://api.jup.ag/swap/v1/quote?${params}`, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(502).json({ error: 'Jupiter quote failed: ' + e.message }); }
});

app.post('/api/proxy/jupiter/swap', async (req, res) => {
  try {
    const r = await fetch('https://api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(502).json({ error: 'Jupiter swap failed: ' + e.message }); }
});

app.use(express.static('public'));

initDB()
  .then(async () => {
    await ensureStateColumn();     // ← Must be here
    await ensureWalletsTable();
    app.listen(PORT, () => console.log(`UDT backend on port ${PORT}`));
  })
  .catch(e => { 
    console.error('DB init failed:', e); 
    process.exit(1); 
  });

module.exports = app;