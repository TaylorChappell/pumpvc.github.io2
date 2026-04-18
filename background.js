// Ultimate Dev Tools — Background Service Worker
// Essor Studios

const PUMPFUN_PROG = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymMDer';
let sniperConfig = null;

// ── ALARM ROUTING ──────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'udt-autosplit')    await checkAutoSplit();
  if (alarm.name === 'udt-tracker')      await checkTrackerAlerts();
  if (alarm.name === 'udt-sniper')       await checkSniperOpportunity();
  if (alarm.name === 'udt-volume-bot')   await handleVolumeBotAlarm();
});

// ── MESSAGE ROUTING ────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.action === 'startAutoSplit') {
      chrome.alarms.create('udt-autosplit', { periodInMinutes: 0.5 });
      sendResponse({ ok: true });
    }
    else if (msg.action === 'stopAutoSplit') {
      chrome.alarms.clear('udt-autosplit');
      sendResponse({ ok: true });
    }
    else if (msg.action === 'startTrackerRefresh') {
      chrome.alarms.create('udt-tracker', { periodInMinutes: 1 });
      sendResponse({ ok: true });
    }
    else if (msg.action === 'stopTrackerRefresh') {
      chrome.alarms.clear('udt-tracker');
      sendResponse({ ok: true });
    }
    else if (msg.action === 'startSniper') {
      sniperConfig = msg.config;
      chrome.alarms.create('udt-sniper', { periodInMinutes: 0.25 }); // every 15s
      sendResponse({ ok: true });
    }
    else if (msg.action === 'stopSniper') {
      sniperConfig = null;
      chrome.alarms.clear('udt-sniper');
      sendResponse({ ok: true });
    }
    // ── Volume Bot ───────────────────────────────
    else if (msg.action === 'startVolumeBot') {
      await chrome.storage.local.set({ vb_bg_active: true, vb_bg_config: msg.config });
      sendResponse({ ok: true });
    }
    else if (msg.action === 'stopVolumeBot') {
      await chrome.storage.local.set({ vb_bg_active: false });
      chrome.alarms.clear('udt-volume-bot');
      sendResponse({ ok: true });
    }
    else if (msg.action === 'scheduleVolumeBot') {
      // Schedule a one-time alarm to fire after delaySeconds
      // Chrome alarms minimum is 1 minute; for shorter delays we rely on
      // the popup's setTimeout. For delays >= 60s we use an alarm for persistence.
      const delaySeconds = msg.delaySeconds || 90;
      if (delaySeconds >= 60) {
        const delayMinutes = Math.max(1, delaySeconds / 60);
        chrome.alarms.create('udt-volume-bot', { delayInMinutes: delayMinutes });
      }
      sendResponse({ ok: true });
    }
    // ── Status ──────────────────────────────────
    else if (msg.action === 'getStatus') {
      const [as, tr, sn, vb] = await Promise.all([
        chrome.alarms.get('udt-autosplit'),
        chrome.alarms.get('udt-tracker'),
        chrome.alarms.get('udt-sniper'),
        chrome.alarms.get('udt-volume-bot'),
      ]);
      sendResponse({ autoSplit: !!as, tracker: !!tr, sniper: !!sn, volumeBot: !!vb });
    }
  })();
  return true;
});

// ── VOLUME BOT ALARM HANDLER ───────────────────
async function handleVolumeBotAlarm() {
  try {
    const { vb_bg_active } = await chrome.storage.local.get('vb_bg_active');
    if (!vb_bg_active) return;

    // Notify any open popup/side-panel windows to run the cycle
    const views = chrome.extension?.getViews?.({ type: 'popup' }) || [];
    if (views.length > 0) {
      // Popup is open — let it handle via message
      chrome.runtime.sendMessage({ action: 'volumeBotAlarmFired' }).catch(() => {});
    }
    // If popup is closed, we can't run the full on-chain logic from the background
    // (Solana signing requires the full crypto stack which isn't loaded here).
    // The alarm serves as a "wake up" signal — when the user re-opens the popup,
    // the bot resumes from the restored state.
    // For production, you'd move the signing logic into the SW or use a backend.
  } catch (e) {
    console.error('[UDT VolumeBot Alarm]', e);
  }
}

// ── AUTO SPLIT ─────────────────────────────────────────────
async function checkAutoSplit() {
  try {
    const { udt_v2 } = await chrome.storage.local.get('udt_v2');
    if (!udt_v2?.split?.auto?.enabled) return;
    const cfg = udt_v2.split.auto;
    if (!cfg.sourceWallet) return;

    const rpc = udt_v2.settings?.rpcEndpoint || 'https://api.mainnet-beta.solana.com';
    const sigs = await rpcCall(rpc, 'getSignaturesForAddress', [cfg.sourceWallet, { limit: 5 }]);
    if (!sigs) return;

    const lastChecked = udt_v2.split.autoLastChecked || 0;
    const newSigs = sigs.filter(s => (s.blockTime || 0) > lastChecked);
    if (!newSigs.length) return;
    udt_v2.split.autoLastChecked = Math.floor(Date.now() / 1000);

    for (const sig of newSigs) {
      const tx = await rpcCall(rpc, 'getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
      if (!tx?.meta) continue;
      for (const p of (tx.meta.postTokenBalances || [])) {
        if (p.owner !== cfg.sourceWallet) continue;
        if (cfg.caFilter && p.mint !== cfg.caFilter) continue;
        const preEntry = (tx.meta.preTokenBalances || []).find(x => x.mint === p.mint && x.owner === cfg.sourceWallet);
        const preAmt = preEntry ? Number(preEntry.uiTokenAmount?.uiAmount || 0) : 0;
        const postAmt = Number(p.uiTokenAmount?.uiAmount || 0);
        if (postAmt > preAmt) {
          const triggers = udt_v2.split.autoTriggers || [];
          if (!triggers.find(t => t.id === sig.signature)) {
            triggers.push({ id: sig.signature, mint: p.mint, amount: postAmt - preAmt, timestamp: sig.blockTime, processed: false });
            udt_v2.split.autoTriggers = triggers.slice(-20);
          }
        }
      }
    }
    await chrome.storage.local.set({ udt_v2 });
  } catch (e) { console.error('[UDT AutoSplit]', e); }
}

// ── WALLET TRACKER ALERTS ──────────────────────
async function checkTrackerAlerts() {
  try {
    const { udt_v2 } = await chrome.storage.local.get('udt_v2');
    if (!udt_v2?.tracker?.wallets?.length) return;
    const rpc = udt_v2.settings?.rpcEndpoint || 'https://api.mainnet-beta.solana.com';

    for (const w of udt_v2.tracker.wallets) {
      if (!w.alertOnBuy || !w.address) continue;
      const sigs = await rpcCall(rpc, 'getSignaturesForAddress', [w.address, { limit: 3 }]);
      if (!sigs?.length) continue;

      const lastSig = w.recentTxs?.[0]?.sig;
      const newSigs = lastSig ? sigs.filter(s => s.signature !== lastSig) : sigs.slice(0, 1);

      for (const sig of newSigs) {
        const tx = await rpcCall(rpc, 'getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
        if (!tx?.meta || tx.meta.err) continue;

        for (const post of (tx.meta.postTokenBalances || [])) {
          if (post.owner !== w.address) continue;
          const pre = (tx.meta.preTokenBalances || []).find(x => x.mint === post.mint && x.owner === w.address);
          const preAmt = pre ? Number(pre.uiTokenAmount?.uiAmount || 0) : 0;
          const postAmt = Number(post.uiTokenAmount?.uiAmount || 0);
          if (postAmt > preAmt) {
            chrome.notifications?.create(`tracker-buy-${sig.signature}`, {
              type: 'basic',
              iconUrl: 'icon48.png',
              title: `🔔 ${w.name || w.address.slice(0, 6)} bought a token`,
              message: `${(postAmt - preAmt).toLocaleString()} tokens of ${post.mint.slice(0, 8)}…`,
            });
          }
        }
      }
    }
  } catch (e) { console.error('[UDT Tracker]', e); }
}

// ── SNIPER MONITORING ──────────────────────────
async function checkSniperOpportunity() {
  try {
    const cfg = sniperConfig;
    if (!cfg) return;

    const rpc = 'https://api.mainnet-beta.solana.com';

    if (cfg.mode === 'ca') {
      if (!cfg.walletPubkey || !cfg.targetCA) return;
      const tokAccs = await rpcCall(rpc, 'getTokenAccountsByOwner', [
        cfg.walletPubkey, { mint: cfg.targetCA }, { encoding: 'jsonParsed' }
      ]);
      const alreadyHolds = tokAccs?.value?.length > 0;
      if (!alreadyHolds) {
        chrome.storage.local.get('udt_v2', ({ udt_v2 }) => {
          if (!udt_v2?.sniper?.enabled) return;
          if (!udt_v2.sniper.pendingSnipe) {
            udt_v2.sniper.pendingSnipe = { ca: cfg.targetCA, name: '', ts: Date.now() };
            chrome.storage.local.set({ udt_v2 });
          }
        });
      }
    }
    else if (cfg.mode === 'pumpfun') {
      const sigs = await rpcCall(rpc, 'getSignaturesForAddress', [PUMPFUN_PROG, { limit: 10 }]);
      if (!sigs) return;

      const { udt_v2 } = await chrome.storage.local.get('udt_v2');
      if (!udt_v2?.sniper?.enabled) return;
      const lastCheckedSig = udt_v2.sniper.lastCheckedSig;
      const newSigs = lastCheckedSig ? sigs.filter(s => s.signature !== lastCheckedSig) : sigs.slice(0, 3);
      if (!newSigs.length) return;

      udt_v2.sniper.lastCheckedSig = sigs[0].signature;

      for (const sig of newSigs) {
        const tx = await rpcCall(rpc, 'getTransaction', [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
        if (!tx?.meta || tx.meta.err) continue;

        const postBalances = tx.meta.postTokenBalances || [];
        for (const bal of postBalances) {
          const mint = bal.mint;
          if (!mint) continue;
          if (!udt_v2.sniper.pendingSnipe) {
            udt_v2.sniper.pendingSnipe = { ca: mint, name: '', ts: Date.now() };
          }
        }
      }

      await chrome.storage.local.set({ udt_v2 });
    }
  } catch (e) { console.error('[UDT Sniper]', e); }
}

// ── RPC HELPER ─────────────────────────────────
async function rpcCall(endpoint, method, params) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return (await res.json()).result ?? null;
  } catch { return null; }
}