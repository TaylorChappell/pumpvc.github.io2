/**
 * Ultimate Dev Tools — Railway Backend
 * Essor Studios
 *
 * npm install express pg bcryptjs jsonwebtoken nanoid cors helmet google-auth-library node-fetch
 */
'use strict';

const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { Pool }   = require('pg');
const cors       = require('cors');
const helmet     = require('helmet');
const { nanoid } = require('nanoid');
const app        = express();

const JWT_SECRET       = process.env.JWT_SECRET       || 'CHANGE_THIS_IN_PROD';
const ADMIN_EMAIL      = process.env.ADMIN_EMAIL       || 'taylorchappell02@gmail.com';
const PAYMENT_ADDR     = process.env.PAYMENT_ADDR      || '';
const SUBSCRIPTION_USD = parseFloat(process.env.SUBSCRIPTION_USD || '199');
const PORT             = process.env.PORT              || 3000;
const SOLANA_RPC       = process.env.SOLANA_RPC        || 'https://api.mainnet-beta.solana.com';
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
      confirmed       BOOLEAN DEFAULT false,
      confirmed_at    TIMESTAMPTZ,
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

// ── SOL price (CoinGecko + Binance fallback) ────────────────────────────────────
let _priceCache = { usd: null, ts: 0 };
async function getSolPriceUSD() {
  if (_priceCache.usd && Date.now() - _priceCache.ts < 60000) return _priceCache.usd;
  const tryFetch = async (url) => {
    const r = await fetch(url);
    return await r.json();
  };
  try {
    const d = await tryFetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const p = parseFloat(d?.solana?.usd);
    if (p > 0) { _priceCache = { usd: p, ts: Date.now() }; return p; }
  } catch {}
  try {
    const d = await tryFetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    const p = parseFloat(d?.price);
    if (p > 0) { _priceCache = { usd: p, ts: Date.now() }; return p; }
  } catch {}
  return _priceCache.usd || null;
}

// ── BS58 (minimal, server-side) ─────────────────────────────────────────────────
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58enc(bytes) {
  let z=0; while(z<bytes.length&&bytes[z]===0)z++;
  const d=z<bytes.length?[0]:[];
  for(let i=z;i<bytes.length;i++){let c=bytes[i];for(let j=d.length-1;j>=0;j--){c+=d[j]<<8;d[j]=c%58;c=c/58|0;}while(c>0){d.unshift(c%58);c=c/58|0;}}
  return '1'.repeat(z)+d.map(x=>A[x]).join('');
}
function b58dec(s) {
  let z=0; while(z<s.length&&s[z]==='1')z++;
  const b=z<s.length?[0]:[];
  for(let i=z;i<s.length;i++){let c=A.indexOf(s[i]);if(c<0)throw new Error('bad b58');for(let j=b.length-1;j>=0;j--){c+=b[j]*58;b[j]=c&0xff;c>>=8;}while(c>0){b.unshift(c&0xff);c>>=8;}}
  return new Uint8Array([...new Array(z).fill(0),...b]);
}

// ── Generate per-payment keypair ────────────────────────────────────────────────
async function genKeypair() {
  const { webcrypto } = require('crypto');
  const kp = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign','verify']);
  const pub  = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
  const p8   = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey));
  const seed = p8.slice(16, 48);
  const full = new Uint8Array(64); full.set(seed); full.set(pub, 32);
  return { publicKey: b58enc(pub), privateKeyB58: b58enc(full) };
}

// ── Solana RPC ─────────────────────────────────────────────────────────────────
async function solRpc(method, params) {
  const r = await fetch(SOLANA_RPC, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}

// Check if address received >= expectedLamports after sinceTs
async function checkSolReceived(addr, expectedLamports, sinceTs) {
  try {
    const sigs = await solRpc('getSignaturesForAddress', [addr, { limit: 20 }]);
    if (!sigs?.length) return null;
    for (const si of sigs) {
      if (si.err) continue;
      if (si.blockTime && si.blockTime * 1000 < sinceTs - 120000) continue;
      const tx = await solRpc('getTransaction', [si.signature, { encoding:'json', maxSupportedTransactionVersion:0 }]);
      if (!tx?.meta) continue;
      const keys = tx.transaction.message.accountKeys || [];
      const idx  = keys.indexOf ? keys.indexOf(addr) : keys.findIndex(k => k === addr);
      if (idx === -1) continue;
      const pre  = tx.meta.preBalances[idx]  || 0;
      const post = tx.meta.postBalances[idx] || 0;
      if (post - pre >= expectedLamports * 0.99) return si.signature;
    }
    return null;
  } catch (e) { console.error('[checkSolReceived]', e.message); return null; }
}

// ── Sweep per-payment wallet → PAYMENT_ADDR ─────────────────────────────────────
async function sweepWallet(privKeyB58, paymentId) {
  if (!PAYMENT_ADDR) return;
  try {
    const priv = b58dec(privKeyB58);
    const seed = priv.slice(0, 32);
    const pub  = priv.slice(32, 64);
    const from = b58enc(pub);

    const bal = (await solRpc('getBalance', [from]))?.value || 0;
    if (bal < 10000) return; // not worth sweeping

    const bh = await solRpc('getLatestBlockhash', [{ commitment:'finalized' }]);
    const { blockhash } = bh?.value || {};
    if (!blockhash) return;

    const fee    = 15000;
    const amount = bal - fee;
    if (amount <= 0) return;

    const toPub  = b58dec(PAYMENT_ADDR);
    const sysProg = new Uint8Array(32);
    const bhBytes = b58dec(blockhash);

    const cl = (n) => n<=0x7f ? new Uint8Array([n]) : new Uint8Array([n&0x7f|0x80, n>>7]);
    const amtBuf = new ArrayBuffer(8);
    const amtDv  = new DataView(amtBuf);
    amtDv.setUint32(0, amount & 0xffffffff, true);
    amtDv.setUint32(4, Math.floor(amount / 0x100000000), true);
    const instrData = new Uint8Array([2,0,0,0,...new Uint8Array(amtBuf)]);

    const msg = new Uint8Array([
      1,0,1,                           // header
      ...cl(3), ...pub, ...toPub, ...sysProg,  // accounts
      ...bhBytes,                      // recent blockhash
      ...cl(1), 2, ...cl(2), 0,1, ...cl(instrData.length), ...instrData
    ]);

    const { webcrypto } = require('crypto');
    const pkcs8h = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
    const sk = await webcrypto.subtle.importKey('pkcs8', new Uint8Array([...pkcs8h,...seed]), {name:'Ed25519'}, false, ['sign']);
    const sig = new Uint8Array(await webcrypto.subtle.sign('Ed25519', sk, msg));

    const wire = new Uint8Array([...cl(1), ...sig, ...msg]);
    const txSig = await solRpc('sendTransaction', [Buffer.from(wire).toString('base64'), { encoding:'base64', preflightCommitment:'confirmed' }]);
    console.log(`[sweep] payment ${paymentId} → ${PAYMENT_ADDR}: ${txSig}`);
    await db.query('UPDATE payments SET swept=true, swept_at=NOW() WHERE payment_id=$1', [paymentId]);
  } catch (e) { console.error('[sweep]', e.message); }
}

// ── Activate subscription + sweep ──────────────────────────────────────────────
async function confirmAndActivate(paymentId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE payments SET confirmed=true, confirmed_at=NOW() WHERE payment_id=$1', [paymentId]);
    const pr = await client.query('SELECT user_id, receive_privkey FROM payments WHERE payment_id=$1', [paymentId]);
    const { user_id, receive_privkey } = pr.rows[0] || {};
    if (!user_id) throw new Error('no user');
    const exp = new Date(Date.now() + 30*24*60*60*1000);
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

// GET current SOL price
app.get('/api/subscription/sol-price', async (req, res) => {
  try {
    const usd = await getSolPriceUSD();
    if (!usd) return res.status(503).json({ error:'Price unavailable' });
    res.json({ usd:SUBSCRIPTION_USD, sol:parseFloat((SUBSCRIPTION_USD/usd).toFixed(6)), price_usd:usd, fetched_at:Date.now() });
  } catch(e){ res.status(500).json({error:'Server error'}); }
});

// Redeem promo
app.post('/api/subscription/redeem-promo', authMiddleware, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { code } = req.body;
    if (!code) { await client.query('ROLLBACK'); return res.status(400).json({error:'Code required'}); }
    const cr = await client.query('SELECT * FROM promo_codes WHERE code=$1 FOR UPDATE',[code.trim().toUpperCase()]);
    const p  = cr.rows[0];
    if (!p)         { await client.query('ROLLBACK'); return res.status(404).json({error:'Code not found'}); }
    if (p.disabled) { await client.query('ROLLBACK'); return res.status(410).json({error:'Code disabled'}); }
    if (p.redeemed_by){ await client.query('ROLLBACK'); return res.status(409).json({error:'Code already used'}); }
    if ((await client.query('SELECT id FROM promo_codes WHERE redeemed_by=$1',[req.user.id])).rows.length)
      { await client.query('ROLLBACK'); return res.status(409).json({error:'Already redeemed a code'}); }
    await client.query('UPDATE promo_codes SET redeemed_by=$1,redeemed_at=NOW() WHERE id=$2',[req.user.id,p.id]);
    const exp = new Date(Date.now()+p.days*86400000);
    await client.query(`INSERT INTO subscriptions(user_id,active,trial,expires_at)VALUES($1,true,true,$2)
      ON CONFLICT(user_id)DO UPDATE SET active=true,trial=true,expires_at=$2`,[req.user.id,exp]);
    await client.query('COMMIT');
    res.json({ ok:true, expires_at:exp, days:p.days });
  } catch(e){ await client.query('ROLLBACK'); console.error(e); res.status(500).json({error:'Server error'}); }
  finally{ client.release(); }
});

// Init payment — generates per-user wallet, locks USD→SOL rate
app.post('/api/subscription/payment/init', authMiddleware, async (req, res) => {
  try {
    const priceUSD = await getSolPriceUSD();
    if (!priceUSD) return res.status(503).json({ error:'Could not fetch SOL price. Please try again.' });

    const amountSol = parseFloat((SUBSCRIPTION_USD / priceUSD).toFixed(6));
    const paymentId = nanoid(24);
    const kp        = await genKeypair();

    await db.query(
      `INSERT INTO payments(user_id,payment_id,method,amount_sol,amount_usd,sol_price_usd,receive_address,receive_privkey)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.user.id, paymentId, req.body.method||'manual', amountSol, SUBSCRIPTION_USD, priceUSD, kp.publicKey, kp.privateKeyB58]
    );

    res.json({
      payment_id:    paymentId,
      address:       kp.publicKey,   // unique per-user, per-payment
      amount_sol:    amountSol,
      amount_usd:    SUBSCRIPTION_USD,
      sol_price_usd: priceUSD,
      expires_in:    1800
    });
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

// Check payment
app.get('/api/subscription/payment/check/:paymentId', authMiddleware, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const r = await db.query('SELECT * FROM payments WHERE payment_id=$1 AND user_id=$2',[paymentId,req.user.id]);
    const pay = r.rows[0];
    if (!pay) return res.status(404).json({error:'Payment not found'});
    if (pay.confirmed) return res.json({ confirmed:true });

    const age = Date.now() - new Date(pay.created_at).getTime();
    if (age > 30*60*1000) return res.json({ confirmed:false, expired:true });

    const expectedLamports = Math.floor(parseFloat(pay.amount_sol) * 1e9);
    const createdTs        = new Date(pay.created_at).getTime();

    const sig = await checkSolReceived(pay.receive_address, expectedLamports, createdTs);
    if (sig) {
      await confirmAndActivate(paymentId);
      return res.json({ confirmed:true, signature:sig });
    }
    res.json({ confirmed:false });
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

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

app.use(express.static('public'));

initDB()
  .then(()=>app.listen(PORT,()=>console.log(`UDT backend on port ${PORT}`)))
  .catch(e=>{ console.error('DB init failed:',e); process.exit(1); });

module.exports = app;