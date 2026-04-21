/* ═══════════════════════════════════════════════════════════════════
   ROTATE WALLETS

   Sells the entire token balance on a source wallet and instantly buys
   it back from one or more target wallets in a single Jito bundle.

   Target buy amount modes:
     - fixed:  each rotation buys a fixed total SOL amount
     - match:  buys roughly what the sell returned, ± a slider deviation

   When multiple target wallets are selected, the total is split between
   them with a random per-wallet deviation so the on-chain amounts look
   independent (they all add up to the target total).
═══════════════════════════════════════════════════════════════════ */

// ── Constants ────────────────────────────────────────────────────
// Must match the backend validation. The manual build path produces
// sell + N buys + tip = N+2 TXs; Jito max is 5, so max N = 3.
const ROTATE_MAX_TARGETS = 3;

// ── State init ──────────────────────────────────────────────────
function initRotateState() {
  if (!S.rotate) S.rotate = {
    mint:         '',
    sourceId:     '',
    targetIds:    [],
    mode:         'match',
    fixedSOL:     2,
    matchDevPct:  0,
    perWalletDevPct: 10,
    slippagePct:  15,
    jitoTipSOL:   0.0005,
    prioritySOL:  0.001,
    jitoRegion:   'mainnet',
    history:      [],
    _logs:        [],
    _running:     false,
    _srcOpen:     false,
    _tgtOpen:     false,
  };
  const r = S.rotate;
  if (r.mode !== 'fixed' && r.mode !== 'match') r.mode = 'match';
  if (typeof r.matchDevPct !== 'number')     r.matchDevPct = 0;
  if (typeof r.perWalletDevPct !== 'number') r.perWalletDevPct = 10;
  if (typeof r.fixedSOL !== 'number')        r.fixedSOL = 2;
  if (typeof r.slippagePct !== 'number')     r.slippagePct = 15;
  if (typeof r.jitoTipSOL !== 'number')      r.jitoTipSOL = 0.0005;
  if (typeof r.prioritySOL !== 'number')     r.prioritySOL = 0.001;
  if (typeof r.jitoRegion !== 'string')      r.jitoRegion = 'mainnet';
  if (!Array.isArray(r.targetIds))           r.targetIds = [];
  if (!Array.isArray(r.history))             r.history = [];
  if (!Array.isArray(r._logs))               r._logs = [];
  if (!Array.isArray(r._sourceTokens))       r._sourceTokens = [];
  if (typeof r._tokensLoading !== 'boolean') r._tokensLoading = false;
  if (typeof r._lastLoadedFor !== 'string')  r._lastLoadedFor = '';
}

function _rShort(s){ if(!s) return ''; return s.length>14 ? s.slice(0,6)+'…'+s.slice(-4) : s; }
function _rTs(){ const d=new Date(); return d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function _rLog(msg, level='info') {
  if (!S.rotate) initRotateState();
  S.rotate._logs.unshift({ ts: _rTs(), msg: String(msg), level });
  if (S.rotate._logs.length > 200) S.rotate._logs.length = 200;
  const logEl = document.getElementById('rotate-log');
  if (logEl) logEl.innerHTML = _rLogsHTML();
}

function _rLogsHTML() {
  if (!S.rotate || !S.rotate._logs.length) {
    return '<div class="cpicker-empty" style="padding:14px">No activity yet.</div>';
  }
  return S.rotate._logs.map(function(l){
    var colour = l.level==='err'  ? 'var(--red)'
               : l.level==='ok'   ? 'var(--green)'
               : l.level==='warn' ? 'var(--warn)'
               : 'var(--text)';
    return '<div style="display:flex;gap:8px;padding:4px 8px;border-bottom:1px solid var(--border-md);font-family:var(--mono);font-size:10.5px">'+
      '<span style="color:var(--text-muted);flex-shrink:0">'+l.ts+'</span>'+
      '<span style="color:'+colour+';flex:1;word-break:break-word">'+_rEsc(l.msg)+'</span>'+
    '</div>';
  }).join('');
}

function _rEsc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Clickable Solscan link for a transaction signature
function _rSolscanLink(sig) {
  if (!sig) return '';
  return '<a href="https://solscan.io/tx/'+sig+'" target="_blank" rel="noopener" '+
    'style="color:var(--blue);text-decoration:none;font-family:var(--mono)">'+
    sig.slice(0,8)+'…'+sig.slice(-4)+'↗</a>';
}

/* ── Source wallet tokens picker (holdings) ───────────────────── */
function _rTokenList() {
  const r = S.rotate;
  if (!r.sourceId) {
    return '<div class="cpicker-empty" style="padding:10px">Select a source wallet first.</div>';
  }
  if (r._tokensLoading) {
    return '<div class="cpicker-empty" style="padding:10px"><span class="spinner" style="width:12px;height:12px;border-width:2px"></span>&nbsp;Loading tokens…</div>';
  }
  const tokens = r._sourceTokens || [];
  if (!tokens.length) {
    return '<div class="cpicker-empty" style="padding:10px">No tokens found in this wallet. Hit ↻ to refresh.</div>';
  }
  return '<div class="token-picker-list" style="max-height:160px;overflow-y:auto;border:1px solid var(--border-md);border-radius:var(--r-sm);background:var(--surface)">'+
    tokens.map(function(t){
      const selected = r.mint === t.mint;
      const shortMint = t.mint.slice(0,4)+'…'+t.mint.slice(-4);
      const name = t.name || shortMint;
      const amt = Number(t.uiAmount).toLocaleString(undefined, {maximumFractionDigits: 4});
      return '<div class="token-picker-row '+(selected?'selected':'')+'" data-action="rot-pick-token" data-mint="'+t.mint+'">'+
        '<div class="tprow-check '+(selected?'checked':'')+'"></div>'+
        '<div class="tprow-info">'+
          '<span class="tprow-name">'+_rEsc(name)+'</span>'+
          '<span class="tprow-mint">'+shortMint+'</span>'+
        '</div>'+
        '<span class="tprow-amount">'+amt+'</span>'+
      '</div>';
    }).join('')+
  '</div>';
}

/* ── Source wallet picker (single select) ─────────────────────── */
function _rSrcPicker() {
  const r = S.rotate;
  const dis = r._running ? ' disabled' : '';
  const wallets = (S.savedWallets||[]).filter(function(w){return w.privateKey;});
  const sel = wallets.find(function(w){return w.id===r.sourceId;});
  const label = sel ? (sel.emoji||'💼')+' '+(sel.name||_rShort(sel.publicKey)) : 'Select source wallet…';

  let dropdown = '';
  if (r._srcOpen) {
    let rows = '';
    wallets.forEach(function(w){
      rows += '<div class="tpicker-wallet-row" data-action="rot-src-pick" data-wid="'+w.id+'">'+
        '<span>'+(w.emoji||'💼')+'</span>'+
        '<div class="tpicker-info"><span class="tpicker-name">'+(w.name||'Wallet')+'</span>'+
        '<span class="tpicker-addr">'+_rShort(w.publicKey)+'</span></div>'+
        (w.solBalance!=null?'<span style="font-size:10px;font-weight:600;color:var(--blue);margin-left:auto">'+parseFloat(w.solBalance).toFixed(3)+' SOL</span>':'')+
      '</div>';
    });
    if (!wallets.length) rows = '<div class="cpicker-empty">No wallets with private keys. Add one in the Wallets tab.</div>';
    dropdown = '<div class="cpicker-dropdown cpicker-targets">'+rows+'</div>';
  }

  return '<div class="cpicker-wrap">'+
    '<div class="cpicker-btn '+(sel?'cpicker-selected':'')+'" data-action="rot-src-toggle"'+dis+'>'+
      '<span style="font-size:11px;color:'+(sel?'var(--navy)':'var(--text-muted)')+'">'+label+'</span>'+
      '<span class="cpicker-chevron '+(r._srcOpen?'open':'')+'">&#x203a;</span>'+
    '</div>'+dropdown+
  '</div>';
}

/* ── Target wallet picker (multi-select, max ROTATE_MAX_TARGETS) ── */
function _rTgtPicker() {
  const r = S.rotate;
  const dis = r._running ? ' disabled' : '';
  const wallets = (S.savedWallets||[]).filter(function(w){return w.privateKey;});
  const groups  = S.walletGroups || [];
  const selSet  = new Set(r.targetIds);
  const count   = r.targetIds.length;
  const atMax   = count >= ROTATE_MAX_TARGETS;
  const label   = count>0
    ? count+' wallet'+(count!==1?'s':'')+' selected'+(atMax?' (max)':'')
    : 'Select buy wallets…';

  let dropdown = '';
  if (r._tgtOpen) {
    let rows = '';

    const walletRow = function(w) {
      const sel = selSet.has(w.id);
      const overLimit = !sel && atMax;
      return '<div class="tpicker-wallet-row '+(sel?'selected':'')+'"'+
        (overLimit?' style="opacity:0.4;pointer-events:none" title="Max '+ROTATE_MAX_TARGETS+' buy wallets"':'')+
        ' data-action="rot-tgt-toggle" data-wid="'+w.id+'">'+
        '<div class="tpicker-check '+(sel?'checked':'')+'"></div>'+
        '<span>'+(w.emoji||'💼')+'</span>'+
        '<div class="tpicker-info"><span class="tpicker-name">'+(w.name||'Wallet')+'</span>'+
        '<span class="tpicker-addr">'+_rShort(w.publicKey)+'</span></div>'+
        (w.solBalance!=null?'<span style="font-size:10px;font-weight:600;color:var(--blue);margin-left:auto;flex-shrink:0">'+parseFloat(w.solBalance).toFixed(3)+' SOL</span>':'')+
      '</div>';
    };

    groups.forEach(function(g){
      const gW = wallets.filter(function(w){return w.groupId===g.id;});
      if (!gW.length) return;
      const allSel = gW.every(function(w){return selSet.has(w.id);});
      const somSel = gW.some(function(w){return selSet.has(w.id);});
      rows += '<div class="tpicker-group-hdr" data-action="rot-tgt-group" data-gid="'+g.id+'">'+
        '<div class="tpicker-check '+(allSel?'checked':somSel?'partial':'')+'"></div>'+
        '<span>'+(g.emoji||'📁')+'</span>'+
        '<span class="tpicker-group-name">'+g.name+'</span>'+
        '<span class="tpicker-count">'+gW.length+'</span>'+
      '</div>';
      gW.forEach(function(w){ rows += walletRow(w); });
    });

    wallets.filter(function(w){return !w.groupId;}).forEach(function(w){ rows += walletRow(w); });

    if (!wallets.length) rows = '<div class="cpicker-empty">No wallets with private keys. Add one in the Wallets tab.</div>';

    rows += '<div style="padding:6px 10px;font-size:9.5px;color:var(--text-muted);border-top:1px solid var(--border-md)">'+
      'Max '+ROTATE_MAX_TARGETS+' wallets — Jito bundle limit'+
    '</div>';

    dropdown = '<div class="cpicker-dropdown cpicker-targets">'+rows+'</div>';
  }

  return '<div class="cpicker-wrap">'+
    '<div class="cpicker-btn '+(count>0?'cpicker-selected':'')+'" data-action="rot-tgt-toggle-dd"'+dis+'>'+
      '<span style="font-size:11px;color:'+(count>0?'var(--navy)':'var(--text-muted)')+'">'+label+'</span>'+
      '<span class="cpicker-chevron '+(r._tgtOpen?'open':'')+'">&#x203a;</span>'+
    '</div>'+dropdown+
  '</div>';
}

/* ── Jito region selector ─────────────────────────────────────── */
function _rJitoRegionSelect(current, dis) {
  const opts = [
    ['mainnet',   '🌍 Mainnet (Global)'],
    ['amsterdam', '🇳🇱 Amsterdam'],
    ['dublin',    '🇮🇪 Dublin'],
    ['frankfurt', '🇩🇪 Frankfurt'],
    ['london',    '🇬🇧 London'],
    ['ny',        '🇺🇸 New York'],
    ['slc',       '🇺🇸 Salt Lake City'],
    ['singapore', '🇸🇬 Singapore'],
    ['tokyo',     '🇯🇵 Tokyo'],
  ];
  return '<select data-action="rot-field" data-field="jitoRegion" '+
    'style="font-size:11px;padding:4px 7px;border-radius:var(--r-sm);border:1px solid var(--border-md);background:var(--surface);color:var(--navy);cursor:pointer"'+dis+'>'+
    opts.map(function(o){
      return '<option value="'+o[0]+'"'+(current===o[0]?' selected':'')+'>'+o[1]+'</option>';
    }).join('')+
  '</select>';
}

/* ── Load holdings via RPC ────────────────────────────────────── */
async function _rLoadTokens() {
  const r = S.rotate;
  if (!r.sourceId) return;
  const w = (S.savedWallets||[]).find(function(x){return x.id===r.sourceId;});
  if (!w || !w.publicKey) { showToast('Source wallet has no public key'); return; }

  r._tokensLoading = true;
  await saveState();
  render();

  try {
    const HELIUS_KEY = '9f6bffea-73da-4936-adab-429746a1b007';
    const RPC = (S.settings && S.settings.rpcEndpoint) || ('https://mainnet.helius-rpc.com/?api-key='+HELIUS_KEY);
    const PROGS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
    const tokens = [];

    for (const prog of PROGS) {
      try {
        const resp = await fetch(RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getTokenAccountsByOwner',
            params: [w.publicKey, { programId: prog }, { encoding: 'jsonParsed' }]
          })
        });
        const j = await resp.json();
        for (const acc of (j.result?.value || [])) {
          const info = acc.account?.data?.parsed?.info;
          if (!info) continue;
          const ui = Number(info.tokenAmount?.uiAmount || 0);
          if (ui <= 0) continue;
          tokens.push({ mint: info.mint, uiAmount: ui, decimals: info.tokenAmount?.decimals || 0, name: null });
        }
      } catch (_) {}
    }

    tokens.sort(function(a,b){ return b.uiAmount - a.uiAmount; });

    if (tokens.length) {
      try {
        const resp = await fetch(RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch',
            params: { ids: tokens.map(function(t){return t.mint;}).slice(0, 100) } })
        });
        const j = await resp.json();
        if (j.result) {
          const names = {};
          for (const a of j.result) {
            if (a && a.id) names[a.id] = (a.content?.metadata?.name) || (a.content?.metadata?.symbol) || null;
          }
          tokens.forEach(function(t){ t.name = names[t.mint] || null; });
        }
      } catch (_) {}
    }

    r._sourceTokens = tokens;
    r._lastLoadedFor = r.sourceId;
    if (!tokens.length) showToast('No tokens found in this wallet');
  } catch (e) {
    _rLog('Token load failed: '+e.message, 'err');
  } finally {
    r._tokensLoading = false;
    await saveState();
    render();
  }
}

/* ── Main page ────────────────────────────────────────────────── */
function buildRotatePage() {
  initRotateState();

  return (
    '<div class="tool-header">' +
      '<div class="tool-title-row"><span class="tool-title">Rotate Wallets</span></div>' +
    '</div>' +

    '<div class="scroll-area" id="scroll-area">' +
      _buildRotateForm() +
    '</div>'
  );
}

/* ── Rotate tab ───────────────────────────────────────────────── */
function _buildRotateForm() {
  const r = S.rotate;
  const dis = r._running ? ' disabled' : '';
  const matchSign = r.matchDevPct >= 0 ? '+' : '';

  return '<div class="split-form">' +

    '<div class="sf-row">' +
      '<div class="sf-label">Source Wallet ' +
        '<button class="help-q" data-action="show-help" data-title="Source Wallet" data-body="The wallet currently holding the token. Its entire balance of this token will be sold in the rotation.">?</button>' +
      '</div>' +
      _rSrcPicker() +
    '</div>' +

    '<div class="sf-row">' +
      '<div class="sf-label" style="display:flex;align-items:center">'+
        '<span>Token to Rotate</span>'+
        '<button class="help-q" data-action="show-help" data-title="Token" data-body="Pick a token from your source wallet holdings or paste any mint address below.">?</button>'+
        (r.sourceId ? '<button class="help-q" data-action="rot-refresh-tokens" title="Refresh token list" style="margin-left:auto;font-size:11px;width:auto;border-radius:4px;padding:1px 6px">↻ Refresh</button>' : '') +
      '</div>' +
      _rTokenList() +
    '</div>' +

    '<div class="sf-row" style="margin-top:6px">' +
      '<div class="sf-label" style="font-size:10px;color:var(--text-muted);font-weight:500">Or paste a mint address</div>' +
      '<input type="text" id="rot-mint" value="'+_rEsc(r.mint||'')+'" placeholder="Token mint address…" data-action="rot-field" data-field="mint"'+dis+'/>' +
    '</div>' +

    '<div class="sf-row">' +
      '<div class="sf-label">Buy Wallets ' +
        '<button class="help-q" data-action="show-help" data-title="Buy Wallets" data-body="These wallets buy back the token in the same Jito bundle as the sell. Max '+ROTATE_MAX_TARGETS+' wallets (Jito bundle size limit).">?</button>' +
      '</div>' +
      _rTgtPicker() +
    '</div>' +

    '<div style="height:1px;background:var(--border-md);margin:10px 0 2px"></div>' +

    '<div class="sf-row">' +
      '<div class="sf-label">Buy Amount ' +
        '<button class="help-q" data-action="show-help" data-title="Buy Amount" data-body="Match: buy back roughly the same SOL amount the sell returned, ± a deviation. Fixed: ignore the sell amount and always buy this exact total.">?</button>' +
      '</div>' +
      '<div class="ab-trigger-group">' +
        '<button class="ab-trigger-btn '+(r.mode==='match'?'active':'')+'" data-action="rot-mode" data-val="match"'+dis+'>Match Sell Amount</button>' +
        '<button class="ab-trigger-btn '+(r.mode==='fixed'?'active':'')+'" data-action="rot-mode" data-val="fixed"'+dis+'>Fixed Total</button>' +
      '</div>' +
    '</div>' +

    (r.mode==='fixed' ?
      '<div class="sf-row">' +
        '<div class="sf-label">Total SOL to Buy</div>' +
        '<input type="number" id="rot-fixed" value="'+r.fixedSOL+'" step="0.01" min="0.01" data-action="rot-field" data-field="fixedSOL"'+dis+'/>' +
      '</div>'
    :
      '<div class="sf-row">' +
        '<div class="sf-label">Match Deviation <span style="color:var(--navy);font-weight:700" id="rot-match-val">'+matchSign+r.matchDevPct+'%</span></div>' +
        '<div class="slider-row">' +
          '<input type="range" id="rot-match-slider" min="-50" max="50" step="1" value="'+r.matchDevPct+'" data-action="rot-match-slider"'+dis+'/>' +
          '<span class="slider-value" id="rot-match-slider-lbl">'+matchSign+r.matchDevPct+'%</span>' +
        '</div>' +
        '<div style="font-size:10px;color:var(--text-muted);margin-top:3px">' +
          (r.matchDevPct===0 ? 'Buy the exact sell amount' :
           r.matchDevPct>0  ? 'Buy '+r.matchDevPct+'% more than sold' :
                              'Buy '+(-r.matchDevPct)+'% less than sold') +
        '</div>' +
      '</div>'
    ) +

    '<div class="sf-row">' +
      '<div class="sf-label">Per-Wallet Spread <span style="color:var(--navy);font-weight:700" id="rot-spread-val">±'+r.perWalletDevPct+'%</span> ' +
        '<button class="help-q" data-action="show-help" data-title="Per-Wallet Spread" data-body="When multiple buy wallets are selected, this randomises each wallet\'s share. 0% = equal split. Higher = more random-looking. The total still adds up to the target.">?</button>' +
      '</div>' +
      '<div class="slider-row">' +
        '<input type="range" id="rot-spread-slider" min="0" max="50" step="1" value="'+r.perWalletDevPct+'" data-action="rot-spread-slider"'+dis+'/>' +
        '<span class="slider-value" id="rot-spread-slider-lbl">±'+r.perWalletDevPct+'%</span>' +
      '</div>' +
    '</div>' +

    '<div style="height:1px;background:var(--border-md);margin:10px 0 2px"></div>' +

    '<div class="ab-g3" style="margin-bottom:0">' +
      '<div class="sf-row" style="margin-bottom:0"><div class="sf-label">Slippage %</div>' +
        '<input type="number" id="rot-slip" value="'+r.slippagePct+'" step="1" min="1" max="50" data-action="rot-field" data-field="slippagePct"'+dis+'/>' +
      '</div>' +
      '<div class="sf-row" style="margin-bottom:0"><div class="sf-label">Priority (SOL)</div>' +
        '<input type="number" id="rot-pri" value="'+r.prioritySOL+'" step="0.001" min="0.0001" data-action="rot-field" data-field="prioritySOL"'+dis+'/>' +
      '</div>' +
      '<div class="sf-row" style="margin-bottom:0"><div class="sf-label">Jito Tip (SOL)</div>' +
        '<input type="number" id="rot-tip" value="'+r.jitoTipSOL+'" step="0.0001" min="0.0001" data-action="rot-field" data-field="jitoTipSOL"'+dis+'/>' +
      '</div>' +
    '</div>' +

    '<div class="sf-row" style="margin-top:8px;margin-bottom:0">' +
      '<div class="sf-label">Jito Region ' +
        '<button class="help-q" data-action="show-help" data-title="Jito Region" data-body="Bundle is submitted to this region plus two fallbacks in parallel. Pick the one closest to you.">?</button>' +
      '</div>' +
      _rJitoRegionSelect(r.jitoRegion||'mainnet', dis) +
    '</div>' +

    '<button class="btn '+(r._running?'btn-ghost':'btn-primary')+' btn-full" style="margin:16px 0 10px" data-action="rot-execute"'+(r._running?' disabled':'')+'>' +
      (r._running ? '<span class="spinner"></span>&nbsp;Rotating…' : '⟳ Execute Rotation') +
    '</button>' +

    '<div class="section-hdr">Activity Log</div>' +
    '<div id="rotate-log" style="max-height:300px;overflow-y:auto;border:1px solid var(--border-md);border-radius:var(--r-sm);background:var(--surface)">' + _rLogsHTML() + '</div>' +

  '</div>';
}

/* ── Action handler ───────────────────────────────────────────── */
async function handleRotateAction(action, el) {
  initRotateState();
  const r = S.rotate;

  if (action === 'rot-pick-token') {
    r.mint = el.dataset.mint || '';
    await saveState();
    const inp = document.getElementById('rot-mint');
    if (inp) inp.value = r.mint;
    document.querySelectorAll('[data-action="rot-pick-token"]').forEach(function(row){
      const c = row.querySelector('.tprow-check');
      if (row.dataset.mint === r.mint) { row.classList.add('selected'); if (c) c.classList.add('checked'); }
      else { row.classList.remove('selected'); if (c) c.classList.remove('checked'); }
    });
    return;
  }
  if (action === 'rot-refresh-tokens') { await _rLoadTokens(); return; }

  if (action === 'rot-src-toggle') { r._srcOpen = !r._srcOpen; await saveState(); render(); return; }
  if (action === 'rot-src-pick') {
    const changed = r.sourceId !== el.dataset.wid;
    r.sourceId = el.dataset.wid;
    r._srcOpen = false;
    if (changed) { r._sourceTokens = []; r._lastLoadedFor = ''; }
    await saveState(); render();
    if (changed) _rLoadTokens();
    return;
  }

  if (action === 'rot-tgt-toggle-dd') { r._tgtOpen = !r._tgtOpen; await saveState(); render(); return; }
  if (action === 'rot-tgt-toggle') {
    const wid = el.dataset.wid;
    if (r.targetIds.includes(wid)) {
      r.targetIds = r.targetIds.filter(function(x){return x!==wid;});
    } else {
      if (r.targetIds.length >= ROTATE_MAX_TARGETS) {
        showToast('Max '+ROTATE_MAX_TARGETS+' buy wallets (Jito bundle size limit)');
        return;
      }
      r.targetIds.push(wid);
    }
    await saveState(); render(); return;
  }
  if (action === 'rot-tgt-group') {
    const gid = el.dataset.gid;
    const gW = (S.savedWallets||[]).filter(function(w){return w.privateKey && w.groupId===gid;});
    const allSel = gW.every(function(w){return r.targetIds.includes(w.id);});
    if (allSel) {
      r.targetIds = r.targetIds.filter(function(id){return !gW.some(function(w){return w.id===id;});});
    } else {
      let capped = false;
      gW.forEach(function(w){
        if (!r.targetIds.includes(w.id)) {
          if (r.targetIds.length < ROTATE_MAX_TARGETS) r.targetIds.push(w.id);
          else capped = true;
        }
      });
      if (capped) showToast('Max '+ROTATE_MAX_TARGETS+' buy wallets — some wallets were not added');
    }
    await saveState(); render(); return;
  }

  if (action === 'rot-mode') { r.mode = el.dataset.val; await saveState(); render(); return; }

  if (action === 'rot-field') {
    const field = el.dataset.field;
    const val = el.type === 'number' ? parseFloat(el.value) : el.value;
    if (field === 'mint')       r.mint = String(val||'').trim();
    else if (field === 'jitoRegion') r.jitoRegion = String(val||'mainnet');
    else if (!isNaN(val))       r[field] = val;
    saveState(); return;
  }

  if (action === 'rot-match-slider') {
    r.matchDevPct = parseInt(el.value);
    const sign = r.matchDevPct >= 0 ? '+' : '';
    const v = document.getElementById('rot-match-val');        if (v) v.textContent = sign+r.matchDevPct+'%';
    const l = document.getElementById('rot-match-slider-lbl'); if (l) l.textContent = sign+r.matchDevPct+'%';
    saveState(); return;
  }
  if (action === 'rot-spread-slider') {
    r.perWalletDevPct = parseInt(el.value);
    const v = document.getElementById('rot-spread-val');        if (v) v.textContent = '±'+r.perWalletDevPct+'%';
    const l = document.getElementById('rot-spread-slider-lbl'); if (l) l.textContent = '±'+r.perWalletDevPct+'%';
    saveState(); return;
  }

  if (action === 'rot-execute') { await executeRotation(); return; }
}

/* ── Shared response renderer ─────────────────────────────────── */
// Always renders server logs first, then signatures as clickable explorer links.
// Used by both executors so the behaviour is identical.
function _rHandleResponse(resp, historyEntry) {
  const r = S.rotate;

  // Server logs come first — they contain retry/attempt progress details
  if (resp.logs && Array.isArray(resp.logs)) {
    resp.logs.forEach(function(l){ _rLog(l.msg, l.level||'info'); });
  }

  if (resp.ok === false) {
    _rLog('✕ '+(resp.error||'Unknown error'), 'err');
    // If a sell sig exists despite failure (confirm timeout), show it so
    // the user can manually check whether the sell landed on-chain.
    if (resp.sellSig) {
      _rLog('Sell TX may have landed — verify on-chain', 'warn');
      _rInjectSigLink('Sell (verify): ', resp.sellSig, 'var(--warn)');
    }
    return;
  }

  if (resp.summary) _rLog(resp.summary, 'ok');

  if (resp.sellSig)  _rInjectSigLink('Sell: ', resp.sellSig, 'var(--text)');
  if (resp.buySigs && resp.buySigs.length) {
    resp.buySigs.forEach(function(sig, i){
      if (sig) _rInjectSigLink('Buy '+(i+1)+': ', sig, 'var(--text)');
    });
  }

  if (historyEntry) {
    historyEntry.sigs = [resp.sellSig].concat(resp.buySigs||[]).filter(Boolean);
    r.history.unshift(historyEntry);
    if (r.history.length > 50) r.history.length = 50;
  }
}

// Insert a clickable Solscan link as the first entry in the log panel
function _rInjectSigLink(label, sig, colour) {
  const logEl = document.getElementById('rotate-log');
  if (!logEl || !sig) return;
  const d = document.createElement('div');
  d.style.cssText = 'display:flex;gap:8px;padding:4px 8px;border-bottom:1px solid var(--border-md);font-family:var(--mono);font-size:10.5px';
  d.innerHTML = '<span style="color:var(--text-muted);flex-shrink:0">'+_rTs()+'</span>'+
    '<span style="color:'+colour+';flex:1">'+_rEsc(label)+_rSolscanLink(sig)+'</span>';
  logEl.insertBefore(d, logEl.firstChild);
}

/* ── Rotation executor ────────────────────────────────────────── */
async function executeRotation() {
  const r = S.rotate;

  if (!r.mint || r.mint.length < 32)             { showToast('Enter a valid token address'); return; }
  if (!r.sourceId)                                { showToast('Pick a source wallet'); return; }
  if (!r.targetIds.length)                        { showToast('Pick at least one buy wallet'); return; }
  if (r.targetIds.length > ROTATE_MAX_TARGETS)   { showToast('Max '+ROTATE_MAX_TARGETS+' buy wallets'); return; }

  const source = (S.savedWallets||[]).find(function(w){return w.id===r.sourceId;});
  if (!source || !source.privateKey) { showToast('Source wallet missing private key'); return; }

  const targets = r.targetIds
    .map(function(id){return (S.savedWallets||[]).find(function(w){return w.id===id;});})
    .filter(function(w){return w && w.privateKey;});
  if (!targets.length) { showToast('Target wallets missing private keys'); return; }
  if (r.mode === 'fixed' && !(r.fixedSOL > 0)) { showToast('Enter a fixed SOL amount'); return; }

  r._running = true;
  render();

  try {
    _rLog('Starting rotation for '+_rShort(r.mint), 'info');
    _rLog('Source: '+_rShort(source.publicKey)+' · Targets: '+targets.length, 'info');

    const body = {
      mint:            r.mint,
      sourcePrivKey:   source.privateKey,
      targetPrivKeys:  targets.map(function(w){return w.privateKey;}),
      mode:            r.mode,
      fixedSOL:        r.fixedSOL,
      matchDevPct:     r.matchDevPct,
      perWalletDevPct: r.perWalletDevPct,
      slippagePct:     r.slippagePct,
      jitoTipSOL:      r.jitoTipSOL,
      prioritySOL:     r.prioritySOL,
      jitoRegion:      r.jitoRegion || 'mainnet',
    };

    const token = (S.auth && S.auth.token) || localStorage.getItem('udt_token') || '';
    if (!token || typeof BACKEND === 'undefined') throw new Error('Not authenticated');

    const httpRes = await fetch(BACKEND + '/api/rotate-wallets/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(body),
    });

    // Surface HTTP errors that didn't produce JSON (e.g. 502 gateway, 413 too large)
    if (!httpRes.ok) {
      const text = await httpRes.text().catch(function(){return '';});
      const parsed = JSON.parse(text || 'null');
      if (parsed && typeof parsed === 'object') {
        _rHandleResponse(parsed, null);
        return;
      }
      throw new Error('Server error HTTP '+httpRes.status+(text?' — '+text.slice(0,120):''));
    }

    const resp = await httpRes.json().catch(function(){
      return { ok:false, error:'Server returned invalid JSON' };
    });

    _rHandleResponse(resp, {
      id: Math.random().toString(36).slice(2,10),
      ts: Date.now(),
      mint: r.mint,
      sold: resp.soldSOL || 0,
      bought: resp.boughtSOL || 0,
    });

  } catch (e) {
    _rLog('✕ '+(e.message||String(e)), 'err');
  } finally {
    r._running = false;
    await saveState();
    render();
  }
}

/* ── Export ────────────────────────────────────────────────────── */
window.initRotateState     = initRotateState;
window.buildRotatePage     = buildRotatePage;
window.handleRotateAction  = handleRotateAction;
window._rLoadTokens        = _rLoadTokens;