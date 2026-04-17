'use strict';

const fetch = require('node-fetch');
const {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const bs58 = require('bs58');

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const { nanoid } = require('nanoid');

const app = express();

// ─── Constants ──────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_IN_PROD';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'taylorchappell02@gmail.com';
const PAYMENT_ADDR = 'CdmKRQMDT3HNrybjXJ1kPxGo9y4bXhm69MobM2sV4N8R';
const SUBSCRIPTION_USD = parseFloat(process.env.SUBSCRIPTION_USD || '99');
const PORT = process.env.PORT || 3000;
const SOLANA_RPC =
  process.env.SOLANA_RPC ||
  'https://mainnet.helius-rpc.com/?api-key=9f6bffea-73da-4936-adab-429746a1b007';
const GOOGLE_CLIENT_ID =
  '218003563778-dljv6ld9c467r57p38a6m32gibrtfmld.apps.googleusercontent.com';

// Strongly recommend env-only in production
const SPLITNOW_KEY =
  process.env.SPLITNOW_KEY || 'REPLACE_ME_WITH_ENV_SECRET';
const SPLITNOW_BASE = 'https://splitnow.io/api';

const SWEEP_MAX_ATTEMPTS = 10;
const SWEEP_BASE_DELAY = 8000;
const TX_FEE_LAMPORTS = 5000;
const RENT_EXEMPT_MINIMUM = 890880;

// Default SplitNow stagger values (SECONDS in your app/backend API)
const DEFAULT_STAGGER_MIN_SEC = 30;
const DEFAULT_STAGGER_MAX_SEC = 60;
const DEFAULT_STAGGER_MIN_MS = DEFAULT_STAGGER_MIN_SEC * 1000;
const DEFAULT_STAGGER_MAX_MS = DEFAULT_STAGGER_MAX_SEC * 1000;
const MIN_ALLOWED_STAGGER_SEC = 1;
const MAX_ALLOWED_STAGGER_SEC = 24 * 60 * 60; // 24h

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeStaggerSettings(input) {
  const enabled =
    input?.stagger_enabled === true ||
    input?.stagger_enabled === 'true' ||
    input?.stagger_funding === true ||
    input?.stagger_funding === 'true' ||
    input?.staggerMode === true;

  let minSec = toPositiveInt(
    input?.stagger_min_sec ?? input?.staggerMinSec,
    30
  );

  let maxSec = toPositiveInt(
    input?.stagger_max_sec ?? input?.staggerMaxSec,
    60
  );

  if (minSec < 1) minSec = 1;
  if (maxSec < 1) maxSec = 1;
  if (maxSec < minSec) maxSec = minSec;

  return {
    staggerEnabled: enabled,
    staggerMinSec: minSec,
    staggerMaxSec: maxSec,
    staggerMinMs: minSec * 1000,
    staggerMaxMs: maxSec * 1000,
  };
}

// ─── DB ─────────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Solana connection ──────────────────────────────────────────────────────
const solConn = new Connection(SOLANA_RPC, 'confirmed');

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ─── General helpers ────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toPositiveInt(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return fallback;
  return Math.floor(n);
}

// ─── DB init ────────────────────────────────────────────────────────────────
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
      sweep_attempts  INT DEFAULT 0,
      sweep_last_err  TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS whitelist (
      id       SERIAL PRIMARY KEY,
      email    TEXT UNIQUE NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const ex = await db.query('SELECT id FROM users WHERE email = $1', [
    ADMIN_EMAIL.toLowerCase(),
  ]);

  if (!ex.rows.length) {
    const hash = await bcrypt.hash('changeme', 12);
    await db.query(
      'INSERT INTO users (email, name, password, is_admin) VALUES ($1,$2,$3,true)',
      [ADMIN_EMAIL.toLowerCase(), 'Admin', hash]
    );
    console.log(
      `Superadmin created: ${ADMIN_EMAIL} / changeme — CHANGE PASSWORD`
    );
  } else {
    await db.query('UPDATE users SET is_admin = true WHERE email = $1', [
      ADMIN_EMAIL.toLowerCase(),
    ]);
  }
}

async function ensureColumns() {
  console.log('[migration] Ensuring all columns exist...');
  const cols = [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS state_data TEXT',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_sol NUMERIC',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_usd NUMERIC',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS sol_price_usd NUMERIC',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS receive_address TEXT',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS receive_privkey TEXT',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS sender_address TEXT',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmed BOOLEAN DEFAULT false',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded BOOLEAN DEFAULT false',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_sig TEXT',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS swept BOOLEAN DEFAULT false',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS swept_at TIMESTAMPTZ',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS sweep_attempts INT DEFAULT 0',
    'ALTER TABLE payments ADD COLUMN IF NOT EXISTS sweep_last_err TEXT',
  ];

  for (const sql of cols) {
    try {
      await db.query(sql);
    } catch {}
  }

  console.log('[migration] Done.');
}

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

// ─── Middleware ─────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }

  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function adminMiddleware(req, res, next) {
  const r = await db.query('SELECT is_admin FROM users WHERE id=$1', [
    req.user.id,
  ]);
  if (!r.rows[0]?.is_admin) {
    return res.status(403).json({ error: 'Admin required' });
  }
  next();
}

const makeToken = (u) =>
  jwt.sign(
    { id: u.id, email: u.email, is_admin: u.is_admin },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

// ─── Subscription helpers ───────────────────────────────────────────────────
async function getActiveSub(userId) {
  const ur = await db.query(
    'SELECT is_admin, is_whitelisted FROM users WHERE id=$1',
    [userId]
  );
  const u = ur.rows[0];

  if (u?.is_admin) {
    return { active: true, trial: false, expires_at: null, admin: true };
  }
  if (u?.is_whitelisted) {
    return {
      active: true,
      trial: false,
      expires_at: null,
      whitelisted: true,
    };
  }

  const sr = await db.query('SELECT * FROM subscriptions WHERE user_id=$1', [
    userId,
  ]);
  const sub = sr.rows[0];
  if (!sub) return { active: false };

  const now = new Date();
  if (sub.active && sub.expires_at && new Date(sub.expires_at) < now) {
    await db.query('UPDATE subscriptions SET active=false WHERE user_id=$1', [
      userId,
    ]);
    return { active: false, expires_at: sub.expires_at };
  }

  if (sub.active) {
    const days = sub.expires_at
      ? Math.ceil((new Date(sub.expires_at) - now) / 86400000)
      : null;
    return {
      active: true,
      trial: sub.trial,
      expires_at: sub.expires_at,
      days_remaining: days,
    };
  }

  return { active: false, expires_at: sub.expires_at };
}

let _priceCache = { usd: null, ts: 0 };

async function getSolPriceUSD() {
  if (_priceCache.usd && Date.now() - _priceCache.ts < 120000) {
    return _priceCache.usd;
  }

  const sources = [
    async () => {
      const r = await fetchWithTimeout(
        'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
        4000
      );
      const d = await r.json();
      return parseFloat(d?.price);
    },
    async () => {
      const r = await fetchWithTimeout(
        'https://api.binance.us/api/v3/ticker/price?symbol=SOLUSD',
        4000
      );
      const d = await r.json();
      return parseFloat(d?.price);
    },
    async () => {
      const r = await fetchWithTimeout(
        'https://www.okx.com/api/v5/market/ticker?instId=SOL-USDT',
        4000
      );
      const d = await r.json();
      return parseFloat(d?.data?.[0]?.last);
    },
    async () => {
      const r = await fetchWithTimeout(
        'https://api.bybit.com/v5/market/tickers?category=spot&symbol=SOLUSDT',
        4000
      );
      const d = await r.json();
      return parseFloat(d?.result?.list?.[0]?.lastPrice);
    },
    async () => {
      const r = await fetchWithTimeout(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        5000
      );
      const d = await r.json();
      return parseFloat(d?.solana?.usd);
    },
    async () => {
      const r = await fetchWithTimeout(
        'https://api.coincap.io/v2/assets/solana',
        4000
      );
      const d = await r.json();
      return parseFloat(d?.data?.priceUsd);
    },
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

  if (_priceCache.usd) return _priceCache.usd;
  return 150;
}

// ─── Solana helpers ──────────────────────────────────────────────────────────
function genKeypair() {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey.toBase58(),
    privateKeyB58: bs58.encode(kp.secretKey),
  };
}

function keypairFromB58(privB58) {
  const decode = bs58.decode
    ? bs58.decode.bind(bs58)
    : bs58.default.decode.bind(bs58.default);

  const sk = decode(privB58);
  return Keypair.fromSecretKey(
    sk instanceof Uint8Array ? sk : new Uint8Array(sk)
  );
}

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

async function sendSolTransfer(fromKeypair, toAddress, lamports) {
  const toPubkey = new PublicKey(toAddress);
  const { blockhash } = await solConn.getLatestBlockhash('finalized');

  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: fromKeypair.publicKey,
  });

  tx.add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey,
      lamports,
    })
  );

  tx.sign(fromKeypair);

  const sig = await solConn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  console.log(
    `[transfer] ${fromKeypair.publicKey.toBase58()} → ${toAddress}: ${sig} (${(
      lamports / LAMPORTS_PER_SOL
    ).toFixed(6)} SOL)`
  );

  return sig;
}

async function checkSolReceived(addr, sinceTs) {
  try {
    const sigs = await solRpc('getSignaturesForAddress', [addr, { limit: 20 }]);
    if (!sigs?.length) return null;

    for (const si of sigs) {
      if (si.err) continue;
      if (si.blockTime && si.blockTime * 1000 < sinceTs - 120000) continue;

      const tx = await solRpc('getTransaction', [
        si.signature,
        {
          encoding: 'json',
          maxSupportedTransactionVersion: 0,
        },
      ]);

      if (!tx?.meta) continue;
      const keys = tx.transaction.message.accountKeys || [];
      const idx = keys.findIndex((k) => k === addr);
      if (idx === -1) continue;

      const received =
        (tx.meta.postBalances[idx] || 0) - (tx.meta.preBalances[idx] || 0);

      if (received > 0) {
        return {
          sig: si.signature,
          receivedLamports: received,
        };
      }
    }

    return null;
  } catch (e) {
    console.error('[checkSolReceived]', e.message);
    return null;
  }
}

// ─── SplitNOW helpers ────────────────────────────────────────────────────────
function calcPctBipsFromSplits(splits) {
  const total = splits.reduce((sum, s) => sum + Number(s.amount || 0), 0);
  if (!total || total <= 0) throw new Error('Invalid splits total');

  const raw = splits.map((s) => ({
    ...s,
    pct: Math.floor((Number(s.amount) / total) * 10000),
  }));

  let used = raw.reduce((sum, s) => sum + s.pct, 0);
  let diff = 10000 - used;
  let i = 0;

  while (diff > 0) {
    raw[i % raw.length].pct += 1;
    diff -= 1;
    i += 1;
  }

  return raw.map((s) => ({
    address: s.address,
    amount: Number(s.amount),
    pctBips: s.pct,
  }));
}

async function splitNowRequest(method, path, body) {
  const url = SPLITNOW_BASE + path;

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SPLITNOW_KEY}`,
      'X-Api-Key': SPLITNOW_KEY,
      'x-api-key': SPLITNOW_KEY,
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    console.error('[splitnow] HTTP fail', {
      url,
      status: res.status,
      statusText: res.statusText,
      responseText: text,
      responseJson: data,
      requestBody: body,
    });

    const msg =
      (data && typeof data.message === 'string' && data.message) ||
      (data && typeof data.error === 'string' && data.error) ||
      (text && text.trim()) ||
      `SplitNow API error ${res.status}`;

    throw new Error(msg);
  }

  return data ?? { success: true };
}

async function createSplitNowQuote(totalSol) {
  const payload = {
    type: 'floating_rate',
    quoteInput: {
      fromAmount: Number(totalSol),
      fromAssetId: 'sol',
      fromNetworkId: 'solana',
    },
    quoteOutputs: [
      {
        toPctBips: 10000,
        toAssetId: 'sol',
        toNetworkId: 'solana',
      },
    ],
    customSignature: '',
  };

  const quoteRes = await splitNowRequest('POST', '/quotes/', payload);
  const quoteId = quoteRes?.data;

  if (!quoteId) {
    throw new Error('SplitNow quote did not return a quote ID');
  }

  return { quoteId, raw: quoteRes };
}

async function createSplitNowOrder({
  quoteId,
  totalSol,
  splits,
  exchangerId = 'binance',
  staggerEnabled = false,
  staggerMinMs = DEFAULT_STAGGER_MIN_MS,
  staggerMaxMs = DEFAULT_STAGGER_MAX_MS,
}) {
  const outputs = calcPctBipsFromSplits(splits).map((s) => ({
    toAddress: s.address,
    toPctBips: s.pctBips,
    toAssetId: 'sol',
    toNetworkId: 'solana',
    toExchangerId: exchangerId,
  }));

  const safeMinMs = toPositiveInt(staggerMinMs, DEFAULT_STAGGER_MIN_MS);
  const safeMaxMs = Math.max(
    safeMinMs,
    toPositiveInt(staggerMaxMs, DEFAULT_STAGGER_MAX_MS)
  );

  const payload = {
    type: 'floating_rate',
    quoteId,
    orderInput: {
      fromAmount: Number(totalSol),
      fromAssetId: 'sol',
      fromNetworkId: 'solana',
    },
    orderOutputs: outputs,
    staggerMode: !!staggerEnabled,
    staggerMinMs: safeMinMs,
    staggerMaxMs: safeMaxMs,
    customSignature: '',
  };

  const orderRes = await splitNowRequest('POST', '/orders/', payload);
  const orderId = orderRes?.data?.orderId || orderRes?.data?.shortId || null;

  if (!orderId) {
    throw new Error('SplitNow order did not return an order ID');
  }

  return {
    orderId: orderRes.data.orderId,
    shortId: orderRes.data.shortId,
    raw: orderRes,
  };
}

async function fetchSplitNowOrder(id) {
  return splitNowRequest('GET', `/orders/${encodeURIComponent(id)}`);
}

// ─── Payment helpers ─────────────────────────────────────────────────────────
async function sweepWallet(privKeyB58, paymentId) {
  await sleep(SWEEP_BASE_DELAY);

  let rentExemptMin;
  try {
    rentExemptMin = await solConn.getMinimumBalanceForRentExemption(0);
  } catch {
    rentExemptMin = RENT_EXEMPT_MINIMUM;
  }

  for (let attempt = 1; attempt <= SWEEP_MAX_ATTEMPTS; attempt++) {
    try {
      const kp = keypairFromB58(privKeyB58);
      const addr = kp.publicKey.toBase58();
      const balance = await solConn.getBalance(kp.publicKey, 'confirmed');

      console.log(
        `[sweep] attempt ${attempt}/${SWEEP_MAX_ATTEMPTS} — payment ${paymentId} — wallet ${addr} — balance ${balance} lamports — rentMin ${rentExemptMin}`
      );

      const sendLamports = balance - TX_FEE_LAMPORTS - rentExemptMin;

      if (sendLamports <= 0) {
        const msg = `balance too low to sweep: ${balance} lamports (need > ${
          TX_FEE_LAMPORTS + rentExemptMin
        })`;

        if (attempt === SWEEP_MAX_ATTEMPTS) {
          await db.query(
            'UPDATE payments SET sweep_attempts=$1, sweep_last_err=$2 WHERE payment_id=$3',
            [attempt, msg, paymentId]
          );
          return;
        }

        await db.query(
          'UPDATE payments SET sweep_attempts=$1, sweep_last_err=$2 WHERE payment_id=$3',
          [attempt, msg, paymentId]
        );

        await sleep(Math.min(SWEEP_BASE_DELAY * Math.pow(2, attempt), 120000));
        continue;
      }

      const sig = await sendSolTransfer(kp, PAYMENT_ADDR, sendLamports);

      await db.query(
        'UPDATE payments SET swept=true, swept_at=NOW(), sweep_attempts=$1, sweep_last_err=NULL WHERE payment_id=$2',
        [attempt, paymentId]
      );

      console.log(
        `[sweep] ✅ ${paymentId} swept ${(
          sendLamports / LAMPORTS_PER_SOL
        ).toFixed(6)} SOL → ${PAYMENT_ADDR} (sig: ${sig})`
      );
      return;
    } catch (err) {
      const msg = err.message || String(err);
      console.error(`[sweep] attempt ${attempt} failed for ${paymentId}:`, msg);

      await db
        .query(
          'UPDATE payments SET sweep_attempts=$1, sweep_last_err=$2 WHERE payment_id=$3',
          [attempt, msg, paymentId]
        )
        .catch(() => {});

      if (attempt === SWEEP_MAX_ATTEMPTS) return;
      await sleep(Math.min(SWEEP_BASE_DELAY * Math.pow(2, attempt), 120000));
    }
  }
}

async function refundPaymentWallet(privKeyB58, senderAddr, paymentId) {
  try {
    const kp = keypairFromB58(privKeyB58);
    const bal = await solConn.getBalance(kp.publicKey, 'confirmed');

    let rentMin = RENT_EXEMPT_MINIMUM;
    try {
      rentMin = await solConn.getMinimumBalanceForRentExemption(0);
    } catch {}

    const sendLamports = bal - TX_FEE_LAMPORTS - rentMin;
    if (sendLamports <= 0) return;

    const sig = await sendSolTransfer(kp, senderAddr, sendLamports);

    await db.query(
      'UPDATE payments SET refunded=true, refunded_at=NOW(), refund_sig=$1 WHERE payment_id=$2',
      [sig, paymentId]
    );
  } catch (e) {
    console.error('[refund]', e.message);
  }
}

async function confirmAndActivate(paymentId) {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT confirmed FROM payments WHERE payment_id=$1',
      [paymentId]
    );

    if (existing.rows[0]?.confirmed) {
      await client.query('COMMIT');
      return;
    }

    await client.query(
      'UPDATE payments SET confirmed=true, confirmed_at=NOW() WHERE payment_id=$1',
      [paymentId]
    );

    const pr = await client.query(
      'SELECT user_id, receive_privkey, method FROM payments WHERE payment_id=$1',
      [paymentId]
    );

    const { user_id, receive_privkey, method } = pr.rows[0] || {};
    if (!user_id) throw new Error('payment record missing user_id');

    const exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await client.query(
      `
      INSERT INTO subscriptions (user_id, active, trial, expires_at)
      VALUES ($1, true, false, $2)
      ON CONFLICT (user_id) DO UPDATE SET active=true, trial=false, expires_at=$2
    `,
      [user_id, exp]
    );

    await client.query('COMMIT');

    if (method !== 'phantom' && receive_privkey) {
      setImmediate(() => sweepWallet(receive_privkey, paymentId));
    }
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// =============================================================================
// ROUTES
// =============================================================================

app.get('/api/subscription/sol-price', async (req, res) => {
  try {
    const usd = await getSolPriceUSD();
    res.json({
      usd: SUBSCRIPTION_USD,
      sol: parseFloat((SUBSCRIPTION_USD / usd).toFixed(6)),
      price_usd: usd,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/subscription/payment/init', authMiddleware, async (req, res) => {
  try {
    const { method } = req.body;
    const priceUSD = await getSolPriceUSD();
    const amountSol = parseFloat((SUBSCRIPTION_USD / priceUSD).toFixed(6));
    const kp = genKeypair();
    const paymentId = nanoid(24);

    await db.query(
      `INSERT INTO payments
         (user_id, payment_id, method, amount_sol, amount_usd, sol_price_usd, receive_address, receive_privkey)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        req.user.id,
        paymentId,
        method || 'manual',
        amountSol,
        SUBSCRIPTION_USD,
        priceUSD,
        kp.publicKey,
        kp.privateKeyB58,
      ]
    );

    res.json({
      payment_id: paymentId,
      address: kp.publicKey,
      payment_addr: PAYMENT_ADDR,
      amount_sol: amountSol,
      amount_usd: SUBSCRIPTION_USD,
      sol_price_usd: priceUSD,
      expires_in: 1800,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/subscription/payment/sender', authMiddleware, async (req, res) => {
  try {
    const { payment_id, sender_address } = req.body;
    await db.query(
      'UPDATE payments SET sender_address=$1 WHERE payment_id=$2 AND user_id=$3',
      [sender_address, payment_id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/subscription/payment/confirm', authMiddleware, async (req, res) => {
  try {
    const { payment_id, signature } = req.body;
    if (!payment_id || !signature) {
      return res.status(400).json({ error: 'Missing payment_id or signature' });
    }

    const r = await db.query(
      'SELECT * FROM payments WHERE payment_id=$1 AND user_id=$2',
      [payment_id, req.user.id]
    );
    const pay = r.rows[0];
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    if (pay.confirmed) return res.json({ confirmed: true });

    let tx = null;

    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        tx = await solRpc('getTransaction', [
          signature,
          {
            encoding: 'json',
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          },
        ]);
        if (tx && !tx.meta?.err) break;
      } catch {}
      await sleep(5000);
    }

    if (!tx || tx.meta?.err) {
      return res.json({
        confirmed: false,
        pending: true,
        message: 'Transaction not yet confirmed — keep waiting',
      });
    }

    const addr = pay.receive_address;
    const keys = tx.transaction.message.accountKeys || [];
    const idx = keys.findIndex((k) => k === addr);
    if (idx === -1) {
      return res.json({
        confirmed: false,
        message: 'Address not found in transaction',
      });
    }

    const receivedLamports =
      (tx.meta.postBalances[idx] || 0) - (tx.meta.preBalances[idx] || 0);
    const expectedLamports = Math.floor(
      parseFloat(pay.amount_sol) * LAMPORTS_PER_SOL
    );

    if (receivedLamports >= expectedLamports * 0.99) {
      await confirmAndActivate(payment_id);
      return res.json({ confirmed: true, signature });
    }

    return res.json({
      confirmed: false,
      underpaid: true,
      message: `Received ${(receivedLamports / LAMPORTS_PER_SOL).toFixed(
        6
      )} SOL, need ${pay.amount_sol}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/subscription/payment/check/:paymentId', authMiddleware, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const r = await db.query(
      'SELECT * FROM payments WHERE payment_id=$1 AND user_id=$2',
      [paymentId, req.user.id]
    );
    const pay = r.rows[0];

    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    if (pay.confirmed) return res.json({ confirmed: true });

    if (pay.refunded) {
      return res.json({
        confirmed: false,
        refunded: true,
        message: `Refunded — you sent too little. Need ${pay.amount_sol} SOL. Please try again.`,
      });
    }

    const age = Date.now() - new Date(pay.created_at).getTime();
    if (age > 30 * 60 * 1000) {
      return res.json({ confirmed: false, expired: true });
    }

    const result = await checkSolReceived(
      pay.receive_address,
      new Date(pay.created_at).getTime()
    );

    if (!result) return res.json({ confirmed: false });

    const { sig, receivedLamports } = result;
    const expectedLamports = Math.floor(
      parseFloat(pay.amount_sol) * LAMPORTS_PER_SOL
    );

    if (receivedLamports >= expectedLamports * 0.99) {
      await confirmAndActivate(paymentId);
      return res.json({ confirmed: true, signature: sig });
    }

    const receivedSol = (receivedLamports / LAMPORTS_PER_SOL).toFixed(6);
    const requiredSol = parseFloat(pay.amount_sol).toFixed(6);

    if (pay.sender_address && pay.receive_privkey) {
      setImmediate(() =>
        refundPaymentWallet(pay.receive_privkey, pay.sender_address, paymentId)
      );

      return res.json({
        confirmed: false,
        refunding: true,
        message: `Only ${receivedSol} SOL received (need ${requiredSol}). Refunding automatically.`,
      });
    }

    return res.json({
      confirmed: false,
      underpaid: true,
      message: `Only ${receivedSol} SOL received (need ${requiredSol}). Send the remaining ${(
        parseFloat(requiredSol) - parseFloat(receivedSol)
      ).toFixed(6)} SOL to the same address.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/proxy/splitnow/create-bundle', authMiddleware, async (req, res) => {
  try {
    console.log(
      '[splitnow/create-bundle] raw body',
      JSON.stringify(req.body, null, 2)
    );

    const {
      source_private_key,
      splits,
      exchanger_id,
      stagger_enabled,
      stagger_funding,
      stagger_min_sec,
      stagger_max_sec,
    } = req.body;

    if (!source_private_key || typeof source_private_key !== 'string') {
      return res.status(400).json({ error: 'Missing source_private_key' });
    }

    if (!Array.isArray(splits) || !splits.length) {
      return res.status(400).json({ error: 'Missing splits' });
    }

    const badSplit = splits.find((s) => {
      const amount = Number(s?.amount);
      return !s?.address || !Number.isFinite(amount) || amount <= 0;
    });

    if (badSplit) {
      console.log('[splitnow/create-bundle] bad split', badSplit);
      return res.status(400).json({
        error: 'Each split needs address and amount',
        badSplit,
        splits,
      });
    }

    const totalSol = splits.reduce((sum, s) => sum + Number(s.amount || 0), 0);
    if (!Number.isFinite(totalSol) || totalSol <= 0) {
      return res.status(400).json({ error: 'Invalid total SOL', splits });
    }

    const stagger = normalizeStaggerSettings({
      stagger_enabled,
      stagger_funding,
      stagger_min_sec,
      stagger_max_sec,
    });

    console.log('[splitnow/create-bundle] start', {
      splitCount: splits.length,
      totalSol,
      exchanger_id: exchanger_id || 'binance',
      staggerEnabled: stagger.staggerEnabled,
      staggerMinSec: stagger.staggerMinSec,
      staggerMaxSec: stagger.staggerMaxSec,
    });

    console.log('[splitnow/create-bundle] creating quote...');
    const { quoteId, raw: quoteRaw } = await createSplitNowQuote(totalSol);
    console.log('[splitnow/create-bundle] quote ok', { quoteId, quoteRaw });

    console.log('[splitnow/create-bundle] creating order...');
    const { orderId, shortId, raw: orderRaw } = await createSplitNowOrder({
      quoteId,
      totalSol,
      splits,
      exchangerId: exchanger_id || 'binance',
      staggerEnabled: stagger.staggerEnabled,
      staggerMinMs: stagger.staggerMinMs,
      staggerMaxMs: stagger.staggerMaxMs,
    });

    console.log('[splitnow/create-bundle] order ok', {
      orderId,
      shortId,
      orderRaw,
    });

    const fetchId = orderId || shortId;
    console.log('[splitnow/create-bundle] fetching order...', { fetchId });

    const fetched = await fetchSplitNowOrder(fetchId);
    console.log('[splitnow/create-bundle] fetched order', fetched);

    const orderData = fetched?.data || fetched;

    const depositAddress =
      orderData?.depositWalletAddress ||
      orderData?.depositAddress ||
      orderData?.deposit_address ||
      null;

    const depositAmount =
      Number(orderData?.orderInput?.fromAmount) ||
      Number(orderData?.depositAmount) ||
      totalSol;

    console.log('[splitnow/create-bundle] deposit info', {
      depositAddress,
      depositAmount,
      status: orderData?.status,
      statusShort: orderData?.statusShort,
      statusText: orderData?.statusText,
    });

    if (!depositAddress) {
      return res.status(502).json({
        error: 'SplitNow order did not return a deposit wallet address',
        quote: quoteRaw,
        order: orderRaw,
        fetched,
      });
    }

    const fromKeypair = keypairFromB58(source_private_key);
    const lamports = Math.floor(depositAmount * LAMPORTS_PER_SOL);
    const balance = await solConn.getBalance(fromKeypair.publicKey, 'confirmed');

    console.log('[splitnow/create-bundle] source balance', {
      source: fromKeypair.publicKey.toBase58(),
      balance,
      lamportsNeeded: lamports,
    });

    if (balance < lamports + TX_FEE_LAMPORTS) {
      return res.status(400).json({
        error: `Source wallet has insufficient SOL. Need ${(
          (lamports + TX_FEE_LAMPORTS) / LAMPORTS_PER_SOL
        ).toFixed(6)} SOL incl. fee, have ${(
          balance / LAMPORTS_PER_SOL
        ).toFixed(6)} SOL.`,
        balanceLamports: balance,
        neededLamports: lamports + TX_FEE_LAMPORTS,
      });
    }

    console.log('[splitnow/create-bundle] sending deposit...');
    const depositTxSig = await sendSolTransfer(
      fromKeypair,
      depositAddress,
      lamports
    );
    console.log('[splitnow/create-bundle] deposit sent', { depositTxSig });

    res.json({
      success: true,
      data: {
        quoteId,
        orderId,
        shortId,
        depositAddress,
        depositAmount,
        depositTxSig,
        fetchedOrder: fetched,
        staggerEnabled: stagger.staggerEnabled,
        staggerMinSec: stagger.staggerMinSec,
        staggerMaxSec: stagger.staggerMaxSec,
      },
    });
  } catch (e) {
    console.error('[splitnow/create-bundle] FAIL', e.message, e.stack);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/proxy/splitnow/order/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing order ID' });

    const order = await fetchSplitNowOrder(id);
    res.json(order);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── Auth ────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password too short' });
    }

    if (
      (await db.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]))
        .rows.length
    ) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hash = await bcrypt.hash(password, 12);

    const r = await db.query(
      'INSERT INTO users(email,name,password)VALUES($1,$2,$3)RETURNING id,email,name,is_admin',
      [email.toLowerCase(), name || '', hash]
    );

    const u = r.rows[0];
    res.json({
      token: makeToken(u),
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        is_admin: u.is_admin,
      },
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const r = await db.query(
      'SELECT id,email,name,password,is_admin FROM users WHERE email=$1',
      [email.toLowerCase()]
    );
    const u = r.rows[0];

    if (!u || !(await bcrypt.compare(password, u.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({
      token: makeToken(u),
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        is_admin: u.is_admin,
      },
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { id_token } = req.body;
    const { OAuth2Client } = require('google-auth-library');

    const ticket = await new OAuth2Client(GOOGLE_CLIENT_ID).verifyIdToken({
      idToken: id_token,
      audience: GOOGLE_CLIENT_ID,
    });

    const { sub: googleId, email, name } = ticket.getPayload();

    let r = await db.query(
      'SELECT id,email,name,is_admin FROM users WHERE email=$1',
      [email]
    );
    let u = r.rows[0];

    if (!u) {
      u = (
        await db.query(
          'INSERT INTO users(email,name,google_id)VALUES($1,$2,$3)RETURNING id,email,name,is_admin',
          [email, name, googleId]
        )
      ).rows[0];
    } else {
      await db.query('UPDATE users SET google_id=$1 WHERE id=$2', [
        googleId,
        u.id,
      ]);
    }

    res.json({
      token: makeToken(u),
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        is_admin: u.is_admin,
      },
    });
  } catch {
    res.status(401).json({ error: 'Google auth failed' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id,email,name,is_admin,is_whitelisted,created_at FROM users WHERE id=$1',
      [req.user.id]
    );

    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/verify', authMiddleware, (req, res) =>
  res.json({ ok: true, userId: req.user.id })
);
app.post('/api/auth/logout', authMiddleware, (req, res) => res.json({ ok: true }));

// ─── Subscription routes ─────────────────────────────────────────────────────
app.get('/api/subscription/status', authMiddleware, async (req, res) => {
  try {
    res.json(await getActiveSub(req.user.id));
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/subscription/verify', authMiddleware, async (req, res) => {
  try {
    res.json(await getActiveSub(req.user.id));
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/subscription/redeem-promo', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code provided' });

    const cr = await db.query('SELECT * FROM promo_codes WHERE code=$1', [
      code.toUpperCase(),
    ]);
    const c = cr.rows[0];

    if (!c) return res.status(404).json({ error: 'Code not found' });
    if (c.disabled) return res.status(400).json({ error: 'Code is disabled' });
    if (c.redeemed_by) return res.status(400).json({ error: 'Code already used' });

    const exp = new Date(Date.now() + c.days * 24 * 60 * 60 * 1000);

    await db.query(
      `
      INSERT INTO subscriptions (user_id, active, trial, expires_at)
      VALUES ($1, true, true, $2)
      ON CONFLICT (user_id) DO UPDATE SET active=true, trial=true, expires_at=$2
    `,
      [req.user.id, exp]
    );

    await db.query(
      'UPDATE promo_codes SET redeemed_by=$1, redeemed_at=NOW() WHERE code=$2',
      [req.user.id, code.toUpperCase()]
    );

    res.json({ ok: true, days: c.days });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/webhooks/helius', async (req, res) => {
  try {
    if (req.headers['x-helius-secret'] !== process.env.HELIUS_WEBHOOK_SECRET) {
      return res.status(403).send('Forbidden');
    }
    res.send('ok');
  } catch {
    res.status(500).send('error');
  }
});

// ─── Admin routes ────────────────────────────────────────────────────────────
const aR = express.Router();
aR.use(authMiddleware, adminMiddleware);

aR.post('/promo/generate', async (req, res) => {
  try {
    const { days = 5, label = '' } = req.body;
    const code = nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
    await db.query('INSERT INTO promo_codes(code,days,label)VALUES($1,$2,$3)', [
      code,
      days,
      label,
    ]);
    res.json({ code, days, label });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.get('/promo/list', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT p.*,u.email as redeemed_by_email
      FROM promo_codes p
      LEFT JOIN users u ON p.redeemed_by=u.id
      ORDER BY p.created_at DESC
    `);

    res.json({
      codes: r.rows.map((x) => ({
        ...x,
        redeemed_by: x.redeemed_by_email,
      })),
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.post('/promo/disable', async (req, res) => {
  try {
    await db.query('UPDATE promo_codes SET disabled=true WHERE code=$1', [
      req.body.code,
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const search = req.query.search || '';
    const limit = 25;
    const offset = (page - 1) * limit;

    const q = search
      ? `SELECT u.*,s.active as sub_active,s.trial as sub_trial,s.expires_at as sub_expires_at FROM users u LEFT JOIN subscriptions s ON u.id=s.user_id WHERE u.email ILIKE $3 OR u.name ILIKE $3 ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`
      : `SELECT u.*,s.active as sub_active,s.trial as sub_trial,s.expires_at as sub_expires_at FROM users u LEFT JOIN subscriptions s ON u.id=s.user_id ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`;

    const p = search ? [limit, offset, `%${search}%`] : [limit, offset];

    const [ur, cr] = await Promise.all([
      db.query(q, p),
      db.query(
        `SELECT COUNT(*) FROM users${
          search ? ' WHERE email ILIKE $1 OR name ILIKE $1' : ''
        }`,
        search ? [`%${search}%`] : []
      ),
    ]);

    res.json({
      users: ur.rows,
      total: parseInt(cr.rows[0].count),
      pages: Math.ceil(parseInt(cr.rows[0].count) / limit),
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.post('/users/revoke-sub', async (req, res) => {
  try {
    await db.query('UPDATE subscriptions SET active=false WHERE user_id=$1', [
      req.body.user_id,
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.post('/whitelist', async (req, res) => {
  try {
    const { email } = req.body;
    await db.query(
      'INSERT INTO whitelist(email)VALUES($1)ON CONFLICT DO NOTHING',
      [email.toLowerCase()]
    );
    await db.query('UPDATE users SET is_whitelisted=true WHERE email=$1', [
      email.toLowerCase(),
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.post('/whitelist/remove', async (req, res) => {
  try {
    const { email } = req.body;
    await db.query('DELETE FROM whitelist WHERE email=$1', [
      email.toLowerCase(),
    ]);
    await db.query('UPDATE users SET is_whitelisted=false WHERE email=$1', [
      email.toLowerCase(),
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.get('/whitelist/list', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT email,added_at FROM whitelist ORDER BY added_at DESC'
    );
    res.json({ emails: r.rows });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.post('/admins/add', async (req, res) => {
  try {
    const { email } = req.body;
    if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      return res.status(400).json({ error: 'Cannot modify superadmin' });
    }

    await db.query('UPDATE users SET is_admin=true WHERE email=$1', [
      email.toLowerCase(),
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.post('/admins/remove', async (req, res) => {
  try {
    const { email } = req.body;

    if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      return res.status(400).json({ error: 'Cannot remove superadmin' });
    }
    if (email.toLowerCase() === req.user.email.toLowerCase()) {
      return res.status(400).json({ error: 'Cannot remove yourself' });
    }

    await db.query('UPDATE users SET is_admin=false WHERE email=$1', [
      email.toLowerCase(),
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.get('/admins/list', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT email,name,created_at FROM users WHERE is_admin=true ORDER BY created_at ASC'
    );
    res.json({
      admins: r.rows.map((x) => ({
        ...x,
        is_superadmin:
          x.email.toLowerCase() === ADMIN_EMAIL.toLowerCase(),
      })),
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.get('/payments/pending', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT
        p.payment_id,p.method,p.amount_sol,p.amount_usd,p.receive_address,
        p.confirmed,p.swept,p.sweep_attempts,p.sweep_last_err,p.created_at,
        u.email
      FROM payments p
      JOIN users u ON p.user_id=u.id
      ORDER BY p.created_at DESC
      LIMIT 100
    `);

    res.json({ payments: r.rows });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

aR.post('/payments/retry-sweep', async (req, res) => {
  try {
    const { payment_id } = req.body;
    const r = await db.query('SELECT * FROM payments WHERE payment_id=$1', [
      payment_id,
    ]);
    const pay = r.rows[0];

    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    if (!pay.confirmed) {
      return res.status(400).json({ error: 'Payment not confirmed yet' });
    }
    if (pay.swept) return res.status(400).json({ error: 'Already swept' });
    if (!pay.receive_privkey) {
      return res.status(400).json({ error: 'No private key on record' });
    }

    await db.query(
      'UPDATE payments SET sweep_attempts=0, sweep_last_err=NULL WHERE payment_id=$1',
      [payment_id]
    );

    setImmediate(() => sweepWallet(pay.receive_privkey, payment_id));
    res.json({ ok: true, message: 'Sweep re-triggered in background' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use('/api/admin', aR);

// ─── State sync ──────────────────────────────────────────────────────────────
app.get('/api/state', authMiddleware, async (req, res) => {
  try {
    const r = await db.query('SELECT state_data FROM users WHERE id=$1', [
      req.user.id,
    ]);
    const raw = r.rows[0]?.state_data;
    res.json({ state: raw ? JSON.parse(raw) : null });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/state', authMiddleware, async (req, res) => {
  try {
    const { state } = req.body;
    if (!state) return res.status(400).json({ error: 'No state provided' });

    const safe = { ...state };
    if (safe.auth) {
      safe.auth = { ...safe.auth, cryptoKey: undefined, token: undefined };
    }

    await db.query('UPDATE users SET state_data=$1 WHERE id=$2', [
      JSON.stringify(safe),
      req.user.id,
    ]);

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Wallet sync ─────────────────────────────────────────────────────────────
app.get('/wallets', authMiddleware, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT encrypted_blob, iv FROM wallet_data WHERE user_id=$1',
      [req.user.id]
    );
    res.json({ data: r.rows[0] || null });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/wallets', authMiddleware, async (req, res) => {
  try {
    const { encrypted_blob, iv } = req.body;
    if (!encrypted_blob || !iv) {
      return res.status(400).json({ error: 'Missing blob or iv' });
    }

    await db.query(
      `
      INSERT INTO wallet_data (user_id, encrypted_blob, iv) VALUES ($1,$2,$3)
      ON CONFLICT (user_id) DO UPDATE SET encrypted_blob=$2, iv=$3, updated_at=NOW()
    `,
      [req.user.id, encrypted_blob, iv]
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Jupiter proxy ───────────────────────────────────────────────────────────
app.get('/api/proxy/jupiter/quote', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query).toString();
    const r = await fetch(`https://api.jup.ag/swap/v1/quote?${params}`, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) {
    res.status(502).json({ error: 'Jupiter quote failed: ' + e.message });
  }
});

app.post('/api/proxy/jupiter/swap', async (req, res) => {
  try {
    const r = await fetch('https://api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(req.body),
    });

    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) {
    res.status(502).json({ error: 'Jupiter swap failed: ' + e.message });
  }
});

// ─── Static / start ──────────────────────────────────────────────────────────
app.use(express.static('public'));

initDB()
  .then(async () => {
    await ensureColumns();
    await ensureWalletsTable();
    app.listen(PORT, () => console.log(`UDT backend on port ${PORT}`));
  })
  .catch((e) => {
    console.error('DB init failed:', e);
    process.exit(1);
  });

module.exports = app;