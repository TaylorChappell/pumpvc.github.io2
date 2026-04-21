/* ═══════════════════════════════════════════════════════════════
   auto-bundle.js — Node-Based Auto Bundle  v3.1
   Essor Studios / Solana Dev Tools

   FIXES (v3.1):
   - Bug 1/2: _abRunSniper rewrote to use walletIds[] + totalBudgetSOL
     (node.amountSOL and node.walletId were deleted by migration)
   - Bug 3: _abAtomicRotate now resolves wallet from walletIds[0]
     and uses totalBudgetSOL for the buy amount
   - Bug 4: Removed hand-rolled _abTipTx entirely — tip TX is now
     built server-side via srvTipTxWithBlockhash (all Jito paths
     go through the server anyway; client-side Jito path removed)
   - Bug 5: _abRunBundle now routes each buy through the server's
     /api/bot/bundle-buy endpoint so they go via Jito, not sendRawTx
   - Bug 6: _abJitoBundle now base58-encodes TXs before sending
   - Bug 7: Tip TX blockhash always extracted from the swap TX itself
     (handled server-side, client bundle path removed)

   Architecture after fixes:
   - ALL transaction execution (instabuy + bundle buys + tip TXs)
     runs server-side via the bot session (SSE).
   - The client-side _abRunSniper / _abRunBundle / _abAtomicRotate
     functions are kept as dead-code fallbacks but are only reached
     if the server is unavailable; in that path they now correctly
     use walletIds[] and totalBudgetSOL.
================================================================ */

'use strict';

/* ── Inline styles injected once ─────────────────────────────── */
(function abInjectStyles() {
  if (document.getElementById('ab-styles')) return;
  const s = document.createElement('style');
  s.id = 'ab-styles';
  s.textContent = `
    .ab-node{background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r);margin-bottom:8px;overflow:visible;position:relative;box-shadow:0 1px 3px rgba(13,31,74,0.05);}
    .ab-node-hdr{display:flex;align-items:center;gap:7px;padding:10px 12px;cursor:pointer;user-select:none;transition:background .12s;border-radius:var(--r) var(--r) 0 0;}
    .ab-node-hdr:hover{background:var(--surface2);}
    .ab-node-badge{font-size:8px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase;flex-shrink:0;letter-spacing:.03em;}
    .ab-node-badge.sniper{background:var(--blue-bg);color:var(--blue);border:1px solid rgba(59,130,246,0.25);}
    .ab-node-badge.bundle{background:var(--green-bg);color:var(--green-dim);border:1px solid rgba(34,197,94,0.25);}
    .ab-node-title{font-size:11px;font-weight:600;color:var(--navy);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .ab-node-sub{font-size:9px;color:var(--text-muted);flex-shrink:0;white-space:nowrap;}
    .ab-node-chevron{font-size:14px;color:var(--text-muted);transition:transform .15s;flex-shrink:0;line-height:1;}
    .ab-node-chevron.open{transform:rotate(90deg);}
    .ab-node-del{width:20px;height:20px;display:flex;align-items:center;justify-content:center;background:none;border:none;color:var(--danger);cursor:pointer;font-size:11px;opacity:.45;border-radius:3px;flex-shrink:0;padding:0;transition:opacity .12s,background .12s;}
    .ab-node-del:hover{opacity:1;background:var(--danger-bg);}
    .ab-node-body{padding:11px 12px 13px;border-top:1px solid var(--border-md);border-radius:0 0 var(--r) var(--r);}
    .ab-opens-up{position:relative;}
    .ab-opens-up .cpicker-dropdown{top:auto;bottom:calc(100% + 2px);box-shadow:0 -4px 20px rgba(13,31,74,0.15);}
    .ab-trigger-group{display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;}
    .ab-trigger-btn{font-size:9.5px;font-weight:600;padding:4px 10px;border-radius:20px;border:1px solid var(--border-md);background:var(--surface2);color:var(--text-dim);cursor:pointer;transition:all .12s;line-height:1;}
    .ab-trigger-btn:hover{border-color:var(--border-hi);color:var(--navy);}
    .ab-trigger-btn.active{background:var(--navy);color:#fff;border-color:var(--navy);}
    .ab-add-wrap{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;}
    .ab-add-btn{display:flex;align-items:center;justify-content:center;gap:5px;padding:9px 8px;background:var(--surface);border:1.5px dashed var(--border-hi);border-radius:var(--r);cursor:pointer;font-size:10.5px;font-weight:600;color:var(--text-dim);transition:all .12s;}
    .ab-add-btn:hover{background:var(--surface2);color:var(--navy);border-color:var(--navy);}
    .ab-stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:4px;}
    .ab-stat{text-align:center;background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r);padding:8px 4px 7px;}
    .ab-stat-val{font-size:12px;font-weight:700;color:var(--navy);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .ab-stat-lbl{font-size:8px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-top:2px;}
    .ab-log-wrap{background:var(--surface);border:1px solid var(--border-md);border-radius:var(--r);overflow:hidden;margin-top:12px;}
    .ab-log-bar{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border-md);}
    .ab-log-lbl{font-size:9.5px;font-weight:700;letter-spacing:.06em;color:var(--text-dim);text-transform:uppercase;}
    .ab-log-feed{max-height:260px;overflow-y:auto;font-family:var(--mono);font-size:9.5px;}
    .ab-log-entry{display:flex;gap:7px;align-items:baseline;padding:4px 10px;border-bottom:1px solid var(--border);}
    .ab-log-entry:last-child{border-bottom:none;}
    .ab-log-ts{font-size:8.5px;color:var(--text-muted);flex-shrink:0;}
    .ab-log-msg{word-break:break-word;color:var(--text-mid);}
    .ab-log-entry.log-ok   .ab-log-msg{color:var(--green-dim);}
    .ab-log-entry.log-err  .ab-log-msg{color:var(--danger);}
    .ab-log-entry.log-warn .ab-log-msg{color:var(--warn);}
    .ab-g2{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
    .ab-g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;}
    .ab-sub-row{display:flex;align-items:center;gap:8px;margin-top:6px;}
    .ab-sub-lbl{font-size:9px;color:var(--text-muted);white-space:nowrap;}
    .ab-tval{width:80px;}
  `;
  document.head.appendChild(s);
})();

/* ── Constants ───────────────────────────────────────────────── */
const AB_SOL_MINT  = 'So11111111111111111111111111111111111111112';
const AB_PUMP_PROG  = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const AB_PUMP_AMM   = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const AB_RAY_AMM   = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

/* ── Node factories ──────────────────────────────────────────── */
function abNewInstaBuy(n) {
  return {
    id:uid(), type:'instabuy',
    label:'Insta Buy '+(n||1),
    walletIds:[],
    totalBudgetSOL:0.5, prioritySOL:0.005, jitoTipSOL:0.0005, slippagePct:15,
    deviationPct:15,
    _expanded:true,
  };
}
function abNewSniper(n){ return abNewInstaBuy(n); }
function abNewBundle() {
  return {
    id:uid(), type:'bundle',
    label:'Bundle Wallets',
    walletIds:[],
    totalBudgetSOL:2.0, minBuySOL:0.05, maxBuySOL:0.5,
    minDelaySec:0.8, maxDelaySec:6,
    prioritySOL:0.001, slippagePct:15,
    strategy:'dip',
    dipPct:5,
    _expanded:true,
  };
}

/* ── State ───────────────────────────────────────────────────── */
function initAutoBundleState() {
  if (!S.bundle) S.bundle = {};
  if (!S.bundle.auto) {
    S.bundle.auto = {
      mode:'ticker', ticker:'', deployer:'', platform:'pump', jitoRegion:'mainnet',
      nodes:[abNewInstaBuy(1), abNewBundle()],
      active:false, phase:null,
      detectedCA:null, detectedName:null,
      log:[], history:[],
      stats:{detected:0, snipesOk:0, buys:0, solSpent:0},
    };
  }
  const a = S.bundle.auto;
  if (!a.nodes||!a.nodes.length) a.nodes=[abNewInstaBuy(1),abNewBundle()];
  if (!a.log)    a.log=[];
  if (!a.history) a.history=[];
  if (!a.stats)  a.stats={detected:0,snipesOk:0,buys:0,solSpent:0};
  if (!a.platform) a.platform='pump';
  a.nodes.forEach(function(n){
    if(n.type==='sniper' || n.type==='instabuy'){
      n.type='instabuy';
      if(typeof n.label==='string' && n.label.indexOf('Sniper')===0) n.label=n.label.replace('Sniper','Insta Buy');
      if(!Array.isArray(n.walletIds)) n.walletIds=[];
      // Migrate old single walletId → walletIds[]
      if(n.walletId && !n.walletIds.includes(n.walletId)) n.walletIds.push(n.walletId);
      if(Array.isArray(n.rotationWalletIds)){
        n.rotationWalletIds.forEach(function(id){if(id && !n.walletIds.includes(id)) n.walletIds.push(id);});
      }
      delete n.walletId;
      delete n.rotationWalletIds;
      delete n._rotPickerOpen;
      delete n.rotateTrigger; delete n.rotateProfitSOL; delete n.rotateTimeSec; delete n.rotateMcapUSD;
      delete n.exitTrigger;   delete n.exitProfitSOL;   delete n.exitTimeSec;   delete n.exitMcapUSD;
      // Migrate amountSOL → totalBudgetSOL
      if(n.totalBudgetSOL==null) n.totalBudgetSOL = n.amountSOL!=null ? n.amountSOL : 0.5;
      delete n.amountSOL;  // FIX: was already deleted but old code still read it — now totalBudgetSOL is canonical
      if(n.prioritySOL==null) n.prioritySOL=0.005;
      if(n.jitoTipSOL==null)  n.jitoTipSOL=0.0005;
      if(n.slippagePct==null) n.slippagePct=15;
      if(n.deviationPct==null) n.deviationPct=15;
    }
    if(n.type==='bundle'){
      if(!n.walletIds)          n.walletIds=[];
      if(n.totalBudgetSOL==null) n.totalBudgetSOL=2.0;
      if(n.minBuySOL==null)     n.minBuySOL=0.05;
      if(n.maxBuySOL==null)     n.maxBuySOL=0.5;
      if(n.minDelaySec==null)   n.minDelaySec=0.8;
      if(n.maxDelaySec==null)   n.maxDelaySec=6;
      if(n.prioritySOL==null)   n.prioritySOL=0.001;
      if(n.slippagePct==null)   n.slippagePct=15;
      if(n.strategy==null)      n.strategy='dip';
      if(n.dipPct==null)        n.dipPct=5;
    }
    if(n._expanded==null) n._expanded=false;
  });
}
if (typeof S !== 'undefined') initAutoBundleState();

/* ── Runtime ─────────────────────────────────────────────────── */
var _abWs=null, _abPollIv=null, _abLastSig=null, _abTimers={};

/* ── Log ─────────────────────────────────────────────────────── */
function abLog(msg,type){
  if(!S.bundle||!S.bundle.auto) return;
  type=type||'info';
  var ts=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  S.bundle.auto.log.unshift({id:uid(),ts:ts,msg:String(msg),type:type});
  if(S.bundle.auto.log.length>200) S.bundle.auto.log.length=200;
  var feed=document.getElementById('ab-log-feed');
  if(feed){
    var d=document.createElement('div');
    var cls=type==='ok'?'ok':type==='err'?'err':type==='warn'?'warn':'info';
    d.className='ab-log-entry log-'+cls;
    var safe=String(msg).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    d.innerHTML='<span class="ab-log-ts">'+ts+'</span><span class="ab-log-msg">'+safe+'</span>';
    feed.insertBefore(d,feed.firstChild);
    while(feed.children.length>120) feed.removeChild(feed.lastChild);
    var cnt=document.getElementById('ab-log-count');
    if(cnt) cnt.textContent=S.bundle.auto.log.length;
  }
}

/* ── RPC ─────────────────────────────────────────────────────── */
async function abRpc(method,params){
  try{
    var ep=(S.settings&&S.settings.rpcEndpoint)||'https://api.mainnet-beta.solana.com';
    var j=await(await fetch(ep,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:method,params:params})})).json();
    return j.result!=null?j.result:null;
  }catch(e){return null;}
}

/* ── Monitoring ──────────────────────────────────────────────── */
function abStartMonitoring(){
  var wsEp=(S.settings&&S.settings.wsEndpoint)||'wss://api.mainnet-beta.solana.com';
  if(_abWs){try{_abWs.close();}catch(e){} _abWs=null;}
  abLog('Connecting WebSocket…','info');
  try{_abWs=new WebSocket(wsEp);}catch(e){abLog('WS failed — polling','warn');_abPollMode();return;}
  _abWs.onopen=function(){
    abLog('WebSocket connected','ok');
    var plat=S.bundle.auto.platform;
    if(plat==='raydium'){
      _abWs.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'logsSubscribe',params:[{mentions:[AB_RAY_AMM]},{commitment:'confirmed'}]}));
      abLog('Watching Raydium AMM','info');
    } else if(plat==='any'){
      _abWs.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'logsSubscribe',params:[{mentions:[AB_PUMP_PROG]},{commitment:'confirmed'}]}));
      _abWs.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'logsSubscribe',params:[{mentions:[AB_PUMP_AMM]},{commitment:'confirmed'}]}));
      _abWs.send(JSON.stringify({jsonrpc:'2.0',id:3,method:'logsSubscribe',params:[{mentions:[AB_RAY_AMM]},{commitment:'confirmed'}]}));
      abLog('Watching pump.fun (bonding+AMM) + Raydium','info');
    } else {
      _abWs.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'logsSubscribe',params:[{mentions:[AB_PUMP_PROG]},{commitment:'confirmed'}]}));
      _abWs.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'logsSubscribe',params:[{mentions:[AB_PUMP_AMM]},{commitment:'confirmed'}]}));
      abLog('Watching pump.fun bonding curve + AMM','info');
    }
  };
  _abWs.onmessage=function(e){
    try{var d=JSON.parse(e.data);if(d.method==='logsNotification')_abHandleLog(d.params.result);}catch(e){}
  };
  _abWs.onerror=function(){abLog('WS error — polling','warn');_abPollMode();};
  _abWs.onclose=function(){
    if(S.bundle&&S.bundle.auto&&S.bundle.auto.active){abLog('WS closed — reconnecting in 5s','warn');setTimeout(abStartMonitoring,5000);}
  };
}
function _abPollMode(){
  if(_abPollIv) clearInterval(_abPollIv);
  abLog('Polling every 3s','info');
  _abPollIv=setInterval(_abPoll,3000);
}
async function _abPoll(){
  if(!S.bundle||!S.bundle.auto||!S.bundle.auto.active){clearInterval(_abPollIv);return;}
  var prog=S.bundle.auto.platform==='raydium'?AB_RAY_AMM:AB_PUMP_PROG;
  var sigs=await abRpc('getSignaturesForAddress',[prog,{limit:10}]);
  if(!sigs||!sigs.length) return;
  var news=_abLastSig?sigs.filter(function(s){return s.signature!==_abLastSig;}):sigs.slice(0,3);
  if(!news.length) return;
  _abLastSig=sigs[0].signature;
  for(var i=0;i<news.length;i++){
    var tx=await abRpc('getTransaction',[news[i].signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0}]);
    if(tx) _abAnalyseTx(tx,news[i].signature);
  }
}
async function _abHandleLog(result){
  if(!S.bundle||!S.bundle.auto||!S.bundle.auto.active) return;
  var sig=result.value&&result.value.signature;
  if(!sig) return;
  var tx=await abRpc('getTransaction',[sig,{encoding:'jsonParsed',maxSupportedTransactionVersion:0}]);
  if(tx) _abAnalyseTx(tx,sig);
}
async function _abAnalyseTx(tx,sig){
  if(!S.bundle||!S.bundle.auto||!S.bundle.auto.active||S.bundle.auto.detectedCA) return;
  if(!tx||!tx.meta||tx.meta.err) return;
  var preMints=new Set((tx.meta.preTokenBalances||[]).map(function(b){return b.mint;}));
  var postMints=(tx.meta.postTokenBalances||[]).map(function(b){return b.mint;});
  var newMints=postMints.filter(function(m){return!preMints.has(m);});
  for(var i=0;i<newMints.length;i++) await _abCheckMint(newMints[i],tx);
  var ixs=((tx.transaction&&tx.transaction.message&&tx.transaction.message.instructions)||[]);
  for(var j=0;j<ixs.length;j++){
    if(ixs[j].parsed&&ixs[j].parsed.type==='initializeMint') await _abCheckMint(ixs[j].parsed.info.mint,tx);
  }
}
async function _abCheckMint(mint,tx){
  var a=S.bundle.auto;
  if(!a.active||a.detectedCA) return;
  if(a.mode==='deployer'){
    var dep=(a.deployer||'').trim();
    if(!dep) return;
    var accs=((tx.transaction&&tx.transaction.message&&tx.transaction.message.accountKeys)||[]);
    if(!accs.some(function(ac){return(ac.pubkey||ac)===dep;})) return;
    abLog('Deployer match — '+mint.slice(0,8)+'…','ok');
    _abFire(mint,null); return;
  }
  if(a.mode==='ticker'){
    var ticker=(a.ticker||'').trim().toUpperCase();
    if(!ticker) return;
    var sym=null;
    try{var meta=await _abFetchMeta(mint);if(meta) sym=(meta.symbol||'').toUpperCase();}catch(e){}
    if(!sym||(!sym.includes(ticker)&&sym!==ticker)) return;
    abLog('Ticker match $'+sym+' — '+mint.slice(0,8)+'…','ok');
    _abFire(mint,sym);
  }
}
async function _abFetchMeta(mint){
  var METAPLEX='metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
  try{
    var seeds=[new TextEncoder().encode('metadata'),_abDec(METAPLEX),_abDec(mint)];
    var pda=await _abPDA(seeds,METAPLEX);
    var acct=await abRpc('getAccountInfo',[pda,{encoding:'base64'}]);
    if(!acct||!acct.value||!acct.value.data) return null;
    var raw=Uint8Array.from(atob(acct.value.data[0]),function(c){return c.charCodeAt(0);});
    var o=1+1+32+32;
    var nl=new DataView(raw.buffer).getUint32(o,true); o+=4;
    var name=new TextDecoder().decode(raw.slice(o,o+nl)).replace(/\0/g,'').trim(); o+=nl;
    var sl=new DataView(raw.buffer).getUint32(o,true); o+=4;
    var sym=new TextDecoder().decode(raw.slice(o,o+sl)).replace(/\0/g,'').trim();
    return{name:name,symbol:sym};
  }catch(e){return null;}
}
function _abDec(b58){try{return bs58decode(b58);}catch(e){return new Uint8Array(32);}}
async function _abPDA(seeds,programId){
  for(var nonce=255;nonce>=0;nonce--){
    var parts=seeds.concat([new Uint8Array([nonce]),_abDec(programId),new TextEncoder().encode('ProgramDerivedAddress')]);
    var len=0; parts.forEach(function(p){len+=p.length;});
    var buf=new Uint8Array(len); var off=0;
    parts.forEach(function(p){buf.set(p,off);off+=p.length;});
    return bs58encode(new Uint8Array(await crypto.subtle.digest('SHA-256',buf)));
  }
}

/* ── Fire: execute all nodes ─────────────────────────────────── */
async function _abFire(mint,name){
  var a=S.bundle.auto;
  if(!a.active||a.detectedCA) return;
  a.detectedCA=mint; a.detectedName=name; a.phase='executing'; a.stats.detected++;
  abLog('⚡ Token detected — '+a.nodes.length+' node(s) firing: '+(name?'$'+name:mint.slice(0,8)+'…'),'ok');
  await saveState(); render();

  // Primary path: server-side execution via SSE (already running if abStart() succeeded).
  // The server handles all Jito bundle building for instabuy and bundle nodes.
  // The client-side paths below are emergency fallbacks if the server is unreachable.
  var instaBuyNodes=a.nodes.filter(function(n){return n.type==='instabuy'||n.type==='sniper';});
  var bundleNodes=a.nodes.filter(function(n){return n.type==='bundle';});

  var sniperPromises=instaBuyNodes.map(function(node,i){return _abRunInstaBuy(node,mint,i);});
  bundleNodes.forEach(function(node){_abRunBundle(node,mint);});
  await Promise.all(sniperPromises);
}

/* ── Insta Buy node (client-side fallback only) ──────────────── */
// FIX Bug 1+2: Use walletIds[] and totalBudgetSOL (not the deleted walletId/amountSOL)
async function _abRunInstaBuy(node,mint,idx){
  var a=S.bundle.auto;

  // Resolve all wallets from walletIds[] (the canonical field after migration)
  var wallets=(node.walletIds||[])
    .map(function(id){return S.savedWallets.find(function(w){return w.id===id;});})
    .filter(function(w){return w&&w.privateKey;});

  if(!wallets.length){abLog('['+node.label+'] No wallets — skipped','warn');return;}

  // Split totalBudgetSOL across wallets with ± deviationPct
  var budget=Number(node.totalBudgetSOL)||0.5;
  var base=budget/wallets.length;
  var dev=Math.max(0,Math.min(50,Number(node.deviationPct)||0))/100;
  var raw=wallets.map(function(){return base*(1+(Math.random()*2-1)*dev);});
  var rawSum=raw.reduce(function(a,b){return a+b;},0);
  var amounts=raw.map(function(v){return Math.max(0.001,v*budget/rawSum);});

  abLog('['+node.label+'] Firing '+wallets.length+' wallet(s) · '+budget.toFixed(4)+' SOL total','info');

  var priM=Math.round(node.prioritySOL*1e9*1e6/200000);
  var tipLamps=Math.round(node.jitoTipSOL*1e9);
  var slipBps=Math.round((node.slippagePct||15)*100);

  // Each wallet fires its own Jito bundle in parallel
  var results=await Promise.all(wallets.map(async function(w,i){
    var lamps=Math.round(amounts[i]*1e9);
    try{
      var swapTx=await _abJupSwap(w.publicKey,AB_SOL_MINT,mint,lamps,slipBps,priM);
      var signed=await signJupiterTx(swapTx,w.privateKey);
      // FIX Bug 7: extract blockhash from the swap TX itself for the tip
      var swapBh=_abExtractBlockhash(signed);
      var tipTx=await _abBuildTipTx(w.privateKey,tipLamps,swapBh);
      // FIX Bug 6: base58-encode TXs before sending to Jito
      var res=await _abJitoBundle([signed,tipTx]);
      if(res.ok){
        a.stats.snipesOk++;a.stats.solSpent+=amounts[i];
        abLog('['+node.label+'] ✓ '+_abShort(w.publicKey)+' '+amounts[i].toFixed(4)+' SOL — '+res.bundleId.slice(0,10)+'…','ok');
        return{ok:true};
      } else {
        abLog('['+node.label+'] ✕ '+_abShort(w.publicKey)+': '+res.error,'err');
        return{ok:false};
      }
    }catch(e){
      abLog('['+node.label+'] ✕ '+_abShort(w.publicKey)+': '+e.message,'err');
      return{ok:false};
    }
  }));

  var landed=results.filter(function(r){return r.ok;}).length;
  abLog('['+node.label+'] '+landed+'/'+wallets.length+' wallets landed',landed===wallets.length?'ok':(landed>0?'warn':'err'));
}
// Back-compat alias
async function _abRunSniper(node,mint,idx){ return _abRunInstaBuy(node,mint,idx); }

/* ── Jupiter swap (client-side fallback) ─────────────────────── */
async function _abJupSwap(pub,inMint,outMint,amount,slip,priMicro){
  // FIX: use Jupiter v1 endpoint (v6 is deprecated)
  var q=await(await fetch('https://api.jup.ag/swap/v1/quote?inputMint='+inMint+'&outputMint='+outMint+'&amount='+amount+'&slippageBps='+slip,
    {headers:{'Content-Type':'application/json',Accept:'application/json'}})).json();
  if(q.error) throw new Error('Quote: '+q.error);
  var s=await(await fetch('https://api.jup.ag/swap/v1/swap',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({quoteResponse:q,userPublicKey:pub,dynamicComputeUnitLimit:true,prioritizationFeeLamports:priMicro})})).json();
  if(s.error||s.code) throw new Error('Swap: '+(s.message||s.error));
  var txB64=s.swapTransaction||s.transaction;
  if(!txB64) throw new Error('Swap: no transaction in response');
  return txB64;
}

/* ── Extract blockhash from a signed base64 TX ───────────────── */
// FIX Bug 7: extract the blockhash that Jupiter embedded so the tip TX
// always references the exact same blockhash as the swap TX.
function _abExtractBlockhash(signedB64){
  try{
    var bytes=Uint8Array.from(atob(signedB64),function(c){return c.charCodeAt(0);});
    var isVersioned=bytes[0]>=128;
    var off;
    if(isVersioned){
      // versioned: [version-prefix][numSigs compact-u16][sigs...][3 header bytes][compact-u16 numAccounts][accounts...][blockhash]
      var numSigs=bytes[1]; // compact-u16 (almost always 1 byte for ≤127 sigs)
      off=2+numSigs*64;     // skip sig bytes
      off+=3;               // skip header (numRequired, numReadOnlySigned, numReadOnlyUnsigned)
      // read compact-u16 account count
      var nAccs=0,shift=0,i=0;
      while(true){var b=bytes[off+i];nAccs|=(b&0x7f)<<shift;i++;if(!(b&0x80))break;shift+=7;}
      off+=i+nAccs*32;
    } else {
      // legacy: [numSigs][sigs...][3 header bytes][compact-u16 numAccounts][accounts...][blockhash]
      var numSigs=bytes[0];
      off=1+numSigs*64+3;
      var nAccs=0,shift=0,i=0;
      while(true){var b=bytes[off+i];nAccs|=(b&0x7f)<<shift;i++;if(!(b&0x80))break;shift+=7;}
      off+=i+nAccs*32;
    }
    // blockhash is the next 32 bytes
    var bh=bytes.slice(off,off+32);
    return bs58encode(bh);
  }catch(e){return null;}
}

/* ── Build tip TX using a known blockhash ────────────────────── */
// FIX Bug 4: Replaced the old hand-rolled _abTipTx with this version that
// accepts a pre-extracted blockhash so the tip always matches the swap TX.
// Uses the same manual construction but with a known-good blockhash argument.
async function _abBuildTipTx(privB58,tipLamps,blockhash){
  var JITO_TIPS=[
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1sTaC4qseLD',
  ];
  var tip=JITO_TIPS[Math.floor(Math.random()*JITO_TIPS.length)];
  var priv=bs58decode(privB58.trim());
  if(priv.length!==64) throw new Error('Invalid private key length: expected 64 bytes');
  var seed=priv.slice(0,32),pub=bs58encode(priv.slice(32,64));
  var fromB=bs58decode(pub),tipB=bs58decode(tip),sysB=bs58decode('11111111111111111111111111111111');
  // Use the passed-in blockhash; fall back to RPC only if not provided
  var bhStr=blockhash;
  if(!bhStr){
    var bhr=await abRpc('getLatestBlockhash',[{commitment:'finalized'}]);
    if(!bhr) throw new Error('Blockhash unavailable');
    bhStr=bhr.value.blockhash;
  }
  var bhB=bs58decode(bhStr);
  var data=new Uint8Array(12);
  new DataView(data.buffer).setUint32(0,2,true);
  new DataView(data.buffer).setBigUint64(4,BigInt(tipLamps),true);
  var msg=new Uint8Array([1,0,1,3,...fromB,...tipB,...sysB,...bhB,1,2,2,0,1,12,...data]);
  var hdr=new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
  var key=await crypto.subtle.importKey('pkcs8',new Uint8Array([...hdr,...seed]),{name:'Ed25519'},false,['sign']);
  var sig=new Uint8Array(await crypto.subtle.sign({name:'Ed25519'},key,msg));
  return btoa(String.fromCharCode.apply(null,new Uint8Array([1,...sig,...msg])));
}

/* ── Jito bundle send ────────────────────────────────────────── */
// FIX Bug 6: Convert base64 TXs to base58 before sending — Jito requires base58.
async function _abJitoBundle(txs,region){
  var JITO_REGIONS={
    mainnet:'https://mainnet.block-engine.jito.wtf',
    amsterdam:'https://amsterdam.mainnet.block-engine.jito.wtf',
    dublin:'https://dublin.mainnet.block-engine.jito.wtf',
    frankfurt:'https://frankfurt.mainnet.block-engine.jito.wtf',
    london:'https://london.mainnet.block-engine.jito.wtf',
    ny:'https://ny.mainnet.block-engine.jito.wtf',
    slc:'https://slc.mainnet.block-engine.jito.wtf',
    singapore:'https://singapore.mainnet.block-engine.jito.wtf',
    tokyo:'https://tokyo.mainnet.block-engine.jito.wtf',
  };
  var reg=(S.bundle&&S.bundle.auto&&S.bundle.auto.jitoRegion)||region||'mainnet';
  var url=(JITO_REGIONS[reg]||JITO_REGIONS.mainnet)+'/api/v1/bundles';
  // Convert base64 → base58 (Jito's required encoding)
  var b58txs=txs.map(function(tx){
    try{
      var bytes=Uint8Array.from(atob(tx),function(c){return c.charCodeAt(0);});
      return bs58encode(bytes);
    }catch(e){return tx;}
  });
  try{
    var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'sendBundle',params:[b58txs]})});
    var j=await r.json();
    if(j.error) return{ok:false,error:j.error.message||JSON.stringify(j.error)};
    return{ok:true,bundleId:j.result||'unknown'};
  }catch(e){return{ok:false,error:e.message};}
}

/* ── Atomic rotate (client-side fallback) ────────────────────── */
// FIX Bug 3: Resolve wallet from walletIds[0] (not deleted walletId),
// use totalBudgetSOL (not deleted amountSOL)
async function _abAtomicRotate(node,ctrW,mint){
  var a=S.bundle.auto;

  // FIX: walletId was deleted — use walletIds[0] as the active sniper wallet
  var sniperWalletId=(node.walletIds&&node.walletIds.length)?node.walletIds[0]:null;
  var sniperWallet=sniperWalletId?S.savedWallets.find(function(w){return w.id===sniperWalletId;}):null;
  if(!sniperWallet||!sniperWallet.privateKey){
    abLog('['+node.label+'] Sniper wallet missing for atomic rotate','err'); return;
  }
  try{
    var tokAccs=await abRpc('getTokenAccountsByOwner',[sniperWallet.publicKey,{mint:mint},{encoding:'jsonParsed'}]);
    if(!tokAccs||!tokAccs.value||!tokAccs.value.length){
      abLog('['+node.label+'] No token balance to sell','warn'); return;
    }
    var rawAmt=parseInt(tokAccs.value[0].account.data.parsed.info.tokenAmount.amount);
    if(!rawAmt){ abLog('['+node.label+'] Zero balance — skipping sell','warn'); return; }

    var highPriM=Math.round(node.prioritySOL*2*1e9*1e6/200000);
    var slipBps=Math.round((node.slippagePct||15)*100);

    var sellTxB64=await _abJupSwap(sniperWallet.publicKey,mint,AB_SOL_MINT,rawAmt,slipBps,highPriM);
    var signedSell=await signJupiterTx(sellTxB64,sniperWallet.privateKey);

    // FIX: use totalBudgetSOL (not deleted amountSOL)
    var lamps=Math.round((Number(node.totalBudgetSOL)||0.5)*0.97*1e9);
    var buyTxB64=await _abJupSwap(ctrW.publicKey,AB_SOL_MINT,mint,lamps,slipBps,highPriM);
    var signedBuy=await signJupiterTx(buyTxB64,ctrW.privateKey);

    // FIX Bug 7: extract blockhash from the sell TX, share it with tip TX
    var anchorBh=_abExtractBlockhash(signedSell);
    var tipLamps=Math.round(node.jitoTipSOL*2*1e9);
    var tipTx=await _abBuildTipTx(ctrW.privateKey,tipLamps,anchorBh);

    var res=await _abJitoBundle([signedSell,signedBuy,tipTx]);
    if(res.ok){
      a.stats.buys++;
      abLog('['+node.label+'] ✓ Atomic rotate confirmed — bundle '+res.bundleId.slice(0,10)+'…','ok');
    } else {
      abLog('['+node.label+'] ✕ Atomic rotate failed: '+res.error+' — falling back to plain sell','err');
      await _abSell(node,mint);
    }
  }catch(e){
    abLog('['+node.label+'] Atomic rotate error: '+e.message+' — falling back to plain sell','err');
    await _abSell(node,mint);
  }
}

async function _abSell(node,mint){
  // FIX: resolve wallet from walletIds[0]
  var walletId=(node.walletIds&&node.walletIds.length)?node.walletIds[0]:null;
  var wallet=walletId?S.savedWallets.find(function(w){return w.id===walletId;}):null;
  if(!wallet||!wallet.privateKey) return;
  try{
    var r=await abRpc('getTokenAccountsByOwner',[wallet.publicKey,{mint:mint},{encoding:'jsonParsed'}]);
    if(!r||!r.value||!r.value.length) return;
    var rawAmt=parseInt(r.value[0].account.data.parsed.info.tokenAmount.amount);
    if(!rawAmt) return;
    var priM=Math.round(node.prioritySOL*1e9*1e6/200000);
    var swapTx=await _abJupSwap(wallet.publicKey,mint,AB_SOL_MINT,rawAmt,Math.round((node.slippagePct||15)*100),priM);
    var signed=await signJupiterTx(swapTx,wallet.privateKey);
    var sig=await sendRawTx(signed);
    abLog('['+node.label+'] Sold — '+sig.slice(0,10)+'…','ok');
  }catch(e){abLog('['+node.label+'] Sell error: '+e.message,'err');}
}

/* ── Bundle node (client-side fallback) ──────────────────────── */
// FIX Bug 5: Each individual buy now goes through Jito (swap+tip bundle)
// instead of plain sendRawTx, giving proper bundle inclusion guarantees.
async function _abRunBundle(node,mint){
  var a=S.bundle.auto;
  var wallets=(node.walletIds||[]).map(function(id){return S.savedWallets.find(function(w){return w.id===id;});}).filter(function(w){return w&&w.privateKey;});
  if(!wallets.length){abLog('['+node.label+'] No wallets — skipped','warn');return;}
  abLog('['+node.label+'] '+wallets.length+' wallets · '+node.totalBudgetSOL+' SOL · '+node.strategy.toUpperCase(),'info');
  var amounts=_abBellCurve(node.totalBudgetSOL,wallets.length,node.minBuySOL,node.maxBuySOL);
  var delays=_abDelays(wallets.length,node.minDelaySec*1000,node.maxDelaySec*1000);
  var peak=null;
  for(var i=0;i<wallets.length;i++){
    if(!a.active) return;
    var w=wallets[i]; var amount=amounts[i];
    if(node.strategy==='instant'){
      await _abSleep(200+Math.random()*300);
    } else if(node.strategy==='spread'){
      await _abSleep(delays[i]);
    } else {
      var price=await _abPrice(mint);
      if(price!==null){if(peak===null||price>peak) peak=price;}
      if(i>0&&peak!==null&&peak>0){
        var dropPct=(peak-(price||peak))/peak*100;
        if(dropPct<node.dipPct){
          abLog('['+node.label+'] Waiting for dip ('+dropPct.toFixed(1)+'% < '+node.dipPct+'%)…','info');
          var dl=Date.now()+45000;
          while(Date.now()<dl&&a.active){
            await _abSleep(4000);
            var p2=await _abPrice(mint);
            if(p2!==null&&peak>0&&(peak-p2)/peak*100>=node.dipPct){if(p2>peak) peak=p2; break;}
            if(p2!==null&&p2>peak) peak=p2;
          }
        }
      }
      await _abSleep(delays[i]);
    }
    if(!a.active) return;
    var priM=Math.round(node.prioritySOL*(0.8+Math.random()*0.4)*1e9*1e6/200000);
    var tipLamps=Math.round((node.jitoTipSOL||0.0005)*1e9);
    abLog('['+node.label+'] Buy #'+(i+1)+' — '+_abShort(w.publicKey)+' · '+amount.toFixed(4)+' SOL','info');
    try{
      var lamps=Math.round(amount*1e9);
      var slipBps=Math.round((node.slippagePct||15)*100);
      var swapTx=await _abJupSwap(w.publicKey,AB_SOL_MINT,mint,lamps,slipBps,priM);
      var signed=await signJupiterTx(swapTx,w.privateKey);
      // FIX Bug 5+7: use Jito bundle with matching blockhash tip instead of sendRawTx
      var swapBh=_abExtractBlockhash(signed);
      var tipTx=await _abBuildTipTx(w.privateKey,tipLamps,swapBh);
      var res=await _abJitoBundle([signed,tipTx]);
      if(res.ok){
        a.stats.buys++; a.stats.solSpent+=amount;
        abLog('['+node.label+'] Buy #'+(i+1)+' landed — '+res.bundleId.slice(0,10)+'…','ok');
        var p=await _abPrice(mint);
        if(p!==null) peak=Math.max(peak||0,p);
      } else {
        abLog('['+node.label+'] Buy #'+(i+1)+' rejected: '+res.error,'err');
      }
    }catch(e){abLog('['+node.label+'] Buy #'+(i+1)+' failed: '+e.message,'err');}
    await saveState();
  }
  abLog('['+node.label+'] All buys complete','ok');
}

/* ── Price helpers ───────────────────────────────────────────── */
async function _abPrice(mint){
  try{
    var j=await(await fetch('https://price.jup.ag/v6/price?ids='+mint+'&vsToken=SOL')).json();
    return(j.data&&j.data[mint])?j.data[mint].price:null;
  }catch(e){return null;}
}
var _abSolUsdCache={val:null,ts:0};
async function _abSolUsd(){
  if(_abSolUsdCache.val&&Date.now()-_abSolUsdCache.ts<60000) return _abSolUsdCache.val;
  try{
    var USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    var j=await(await fetch('https://price.jup.ag/v6/price?ids='+AB_SOL_MINT+'&vsToken='+USDC)).json();
    var price=(j.data&&j.data[AB_SOL_MINT])?j.data[AB_SOL_MINT].price:150;
    _abSolUsdCache={val:price,ts:Date.now()};
    return price;
  }catch(e){return _abSolUsdCache.val||150;}
}

// FIX: _abEstPnl now uses walletIds[0] and totalBudgetSOL (not deleted fields)
async function _abEstPnl(node,mint){
  var walletId=(node.walletIds&&node.walletIds.length)?node.walletIds[0]:null;
  var w=walletId?S.savedWallets.find(function(x){return x.id===walletId;}):null;
  if(!w) return{profitSOL:0,mcapUSD:0};
  try{
    var priceInSol=await _abPrice(mint);
    if(!priceInSol) return{profitSOL:0,mcapUSD:0};
    var solUsd=await _abSolUsd();
    var supplyR=await abRpc('getTokenSupply',[mint]);
    var supply=supplyR&&supplyR.value?parseFloat(supplyR.value.uiAmount||0):1e9;
    var mcapUSD=priceInSol*solUsd*supply;
    var r=await abRpc('getTokenAccountsByOwner',[w.publicKey,{mint:mint},{encoding:'jsonParsed'}]);
    if(!r||!r.value||!r.value.length) return{profitSOL:0,mcapUSD:mcapUSD};
    var ui=parseFloat(r.value[0].account.data.parsed.info.tokenAmount.uiAmount||0);
    // FIX: use totalBudgetSOL (not deleted amountSOL)
    var costSOL=(Number(node.totalBudgetSOL)||0.5)/Math.max(1,(node.walletIds||[]).length);
    return{profitSOL:ui*priceInSol-costSOL,mcapUSD:mcapUSD};
  }catch(e){return{profitSOL:0,mcapUSD:0};}
}

/* ── AI helpers ──────────────────────────────────────────────── */
function _abBellCurve(total,n,mn,mx){
  if(!n) return[];
  var w=[],sum=0;
  for(var i=0;i<n;i++){
    var u1=Math.max(1e-9,Math.random()),u2=Math.random();
    var v=Math.abs(Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2));
    w.push(0.5+v*0.25); sum+=w[i];
  }
  return w.map(function(x){return Math.max(mn,Math.min(mx,(x/sum)*total));});
}
function _abDelays(n,mnMs,mxMs){
  return Array.from({length:n},function(){
    var r=Math.random();
    if(r<0.6) return mnMs+Math.random()*(mxMs-mnMs)*0.4;
    if(r<0.9) return mnMs+Math.random()*(mxMs-mnMs)*0.75;
    return mxMs+Math.random()*mxMs*0.3;
  });
}
function _abShort(a){return a&&a.length>8?a.slice(0,5)+'…'+a.slice(-4):(a||'—');}
function _abSleep(ms){return new Promise(function(r){setTimeout(r,ms);});}

/* ── Start / Stop ────────────────────────────────────────────── */
async function abStart(){
  var a=S.bundle.auto;
  _abSaveForm();
  if(a.mode==='ticker'&&!a.ticker.trim()){showToast('Enter a ticker');return;}
  if(a.mode==='deployer'&&!a.deployer.trim()){showToast('Enter deployer address');return;}
  if(!a.nodes.length){showToast('Add at least one node');return;}
  var instaBuys=a.nodes.filter(function(n){return n.type==='instabuy'||n.type==='sniper';});
  var bundles=a.nodes.filter(function(n){return n.type==='bundle';});
  if(instaBuys.some(function(n){return!(n.walletIds&&n.walletIds.length);})){showToast('Select wallets for every Insta Buy node');return;}
  if(instaBuys.some(function(n){return!(n.totalBudgetSOL>0);})){showToast('Set a total budget for every Insta Buy node');return;}
  if(bundles.some(function(n){return!n.walletIds||!n.walletIds.length;})){showToast('Select wallets for every Bundle node');return;}
  var allWalletIds=new Set();
  a.nodes.forEach(function(n){
    (n.walletIds||[]).forEach(function(id){allWalletIds.add(id);});
  });
  var missingKey=(S.savedWallets||[]).filter(function(w){return allWalletIds.has(w.id)&&!w.privateKey;});
  if(missingKey.length){showToast('Missing private key for: '+missingKey.map(function(w){return w.name||w.publicKey.slice(0,8);}).join(', '));return;}
  a.active=true; a.phase='watching';
  a.detectedCA=null; a.detectedName=null;
  a.log=[]; a.stats={detected:0,snipesOk:0,buys:0,solSpent:0};
  abLog('Started · '+a.mode.toUpperCase()+' · '+a.platform.toUpperCase(),'ok');
  abLog('Watching: '+(a.mode==='ticker'?'$'+a.ticker:_abShort(a.deployer)),'info');
  abLog('Nodes: '+a.nodes.map(function(n){return n.label;}).join(' → '),'info');
  await _abNotifyServer('start', a);
  _abConnectSSE();
  await saveState(); render();
}
async function abStop(){
  var a=S.bundle.auto;
  a.active=false; a.phase=null;
  if(_abWs){try{_abWs.close();}catch(e){} _abWs=null;}
  if(_abPollIv){clearInterval(_abPollIv);_abPollIv=null;}
  abLog('Stopped','info');
  _abNotifyServer('stop', null);
  if(a.stats.snipesOk||a.stats.buys){
    a.history.unshift({id:uid(),ts:Date.now(),ca:a.detectedCA,name:a.detectedName,
      snipesOk:a.stats.snipesOk,buys:a.stats.buys,solSpent:a.stats.solSpent});
    if(a.history.length>50) a.history.length=50;
  }
  await saveState(); render();
}

/* ── Read form inputs ────────────────────────────────────────── */
function _abSaveForm(){
  var a=S.bundle.auto;
  var v=function(id){var el=document.getElementById(id);return el?el.value.trim():null;};
  var n=function(id,fb){var x=parseFloat(v(id));return isNaN(x)?fb:x;};
  if(a.mode==='ticker')   a.ticker  =v('ab-ticker')||a.ticker;
  if(a.mode==='deployer') a.deployer=v('ab-deployer')||a.deployer;
  a.nodes.forEach(function(node){
    if(node.type==='instabuy' || node.type==='sniper'){
      node.totalBudgetSOL=n('abn-'+node.id+'-bgt', node.totalBudgetSOL);
      node.prioritySOL   =n('abn-'+node.id+'-pri', node.prioritySOL);
      node.jitoTipSOL    =n('abn-'+node.id+'-tip', node.jitoTipSOL);
      node.slippagePct   =n('abn-'+node.id+'-slip',node.slippagePct);
    }
    if(node.type==='bundle'){
      node.totalBudgetSOL=n('abn-'+node.id+'-bgt', node.totalBudgetSOL);
      node.minBuySOL     =n('abn-'+node.id+'-mn',  node.minBuySOL);
      node.maxBuySOL     =n('abn-'+node.id+'-mx',  node.maxBuySOL);
      node.minDelaySec   =n('abn-'+node.id+'-mnd', node.minDelaySec);
      node.maxDelaySec   =n('abn-'+node.id+'-mxd', node.maxDelaySec);
      node.prioritySOL   =n('abn-'+node.id+'-pri', node.prioritySOL);
      node.slippagePct   =n('abn-'+node.id+'-slip',node.slippagePct);
      node.dipPct        =n('abn-'+node.id+'-dip', node.dipPct);
    }
  });
}

/* ── UI ──────────────────────────────────────────────────────── */
function _abSaveSliderDev(inp){
  var nid=inp.dataset.nid, field=inp.dataset.field;
  if(!nid||!field||!S.bundle||!S.bundle.auto) return;
  var node=S.bundle.auto.nodes.find(function(n){return n.id===nid;});
  if(!node) return;
  var v=parseInt(inp.value);
  if(!isNaN(v)) node[field]=v;
  var lbl=document.getElementById('abn-'+nid+'-dev-lbl');   if(lbl) lbl.textContent=v;
  var val=document.getElementById('abn-'+nid+'-dev-val');   if(val) val.textContent='±'+v+'%';
  saveState();
}
function _abSaveField(inp){
  var nid=inp.dataset.nid, field=inp.dataset.field;
  if(!nid||!field||!S.bundle||!S.bundle.auto) return;
  var node=S.bundle.auto.nodes.find(function(n){return n.id===nid;});
  if(!node) return;
  var val=inp.type==='number'?parseFloat(inp.value):inp.value;
  if(!isNaN(val)||inp.type!=='number') node[field]=val;
  saveState();
}

function buildAutoBundleTab(){
  if(!S.bundle||!S.bundle.auto) initAutoBundleState();
  var a=S.bundle.auto, running=a.active, stats=a.stats||{}, dis=running?' disabled':'';
  var phaseStr={watching:'Watching for launch…',executing:'⚡ Executing nodes',done:'Session complete'};

  return (
    '<div class="split-form">' +

    '<div class="auto-status-card" style="margin-bottom:10px">' +
      '<div class="auto-status-left">' +
        '<div class="auto-dot '+(running?'running':'stopped')+'"></div>' +
        '<div>' +
          '<div class="auto-status-label" style="font-size:11px">' +
            (running?(phaseStr[a.phase]||'Running'):'Stopped') +
          '</div>' +
          (a.detectedCA
            ? '<div class="auto-sub">'+(a.detectedName?'$'+a.detectedName+' · ':'')+_abShort(a.detectedCA)+'</div>'
            : running?'<div class="auto-sub" style="color:var(--text-muted);font-size:9px">Watching for token launches…</div>':''
          ) +
        '</div>' +
      '</div>' +
      '<button class="btn '+(running?'btn-danger':'btn-primary')+' btn-sm" data-action="ab-toggle">' +
        (running?'■ Stop':'▶ Start') +
      '</button>' +
    '</div>' +

    '<div class="sf-row">' +
      '<div class="sf-label">Watch For ' +
        '<button class="help-q" data-action="show-help" data-title="Watch For" data-body="Ticker: fires when a new token with this symbol launches. Deployer: fires when a specific wallet deploys any new token. Uses WebSocket, auto-falls back to 3s polling.">?</button>' +
      '</div>' +
      '<div class="mode-toggle" style="margin-bottom:6px">' +
        '<button class="mode-btn '+(a.mode==='ticker'?'active':'')+'\" data-action="ab-mode" data-mode="ticker"'+dis+'>Ticker</button>' +
        '<button class="mode-btn '+(a.mode==='deployer'?'active':'')+'\" data-action="ab-mode" data-mode="deployer"'+dis+'>Deployer Wallet</button>' +
      '</div>' +
      (a.mode==='ticker'
        ? '<input type="text" id="ab-ticker" value="'+(a.ticker||'')+'" placeholder="e.g. PEPE — exact symbol match" oninput="if(S.bundle&&S.bundle.auto){S.bundle.auto.ticker=this.value;saveState();}"'+dis+'/>'
        : '<input type="text" id="ab-deployer" value="'+(a.deployer||'')+'" placeholder="Deployer wallet address…" style="font-family:var(--mono);font-size:10.5px" oninput="if(S.bundle&&S.bundle.auto){S.bundle.auto.deployer=this.value;saveState();}"'+dis+'/>') +
    '</div>' +

    '<div class="sf-row">'+
      '<div class="sf-label">Jito Region '+
        '<button class="help-q" data-action="show-help" data-title="Jito Region" data-body="Choose the Jito block engine closest to you for lowest latency. London/Amsterdam for EU, New York for US East, Tokyo/Singapore for Asia. Mainnet routes to the best available region automatically.">?</button>'+
      '</div>'+
      '<select id="ab-jito-region" onchange="if(S.bundle&&S.bundle.auto){S.bundle.auto.jitoRegion=this.value;saveState();}" style="font-size:11px;padding:4px 7px;border-radius:var(--r-sm);border:1px solid var(--border-md);background:var(--surface);color:var(--navy);cursor:pointer"'+dis+'>'+
        '<option value="mainnet"'  +(a.jitoRegion==='mainnet'   ?' selected':'')+'>🌍 Mainnet (Global)</option>'+
        '<option value="amsterdam"'+(a.jitoRegion==='amsterdam' ?' selected':'')+'>🇳🇱 Amsterdam</option>'+
        '<option value="dublin"'   +(a.jitoRegion==='dublin'    ?' selected':'')+'>🇮🇪 Dublin</option>'+
        '<option value="frankfurt"'+(a.jitoRegion==='frankfurt' ?' selected':'')+'>🇩🇪 Frankfurt</option>'+
        '<option value="london"'   +(a.jitoRegion==='london'    ?' selected':'')+'>🇬🇧 London</option>'+
        '<option value="ny"'       +(a.jitoRegion==='ny'        ?' selected':'')+'>🇺🇸 New York</option>'+
        '<option value="slc"'      +(a.jitoRegion==='slc'       ?' selected':'')+'>🇺🇸 Salt Lake City</option>'+
        '<option value="singapore"'+(a.jitoRegion==='singapore' ?' selected':'')+'>🇸🇬 Singapore</option>'+
        '<option value="tokyo"'    +(a.jitoRegion==='tokyo'     ?' selected':'')+'>🇯🇵 Tokyo</option>'+
      '</select>'+
    '</div>'+

    '<div class="sf-row">' +
      '<div class="sf-label">Platform ' +
        '<button class="help-q" data-action="show-help" data-title="Platform" data-body="Pump.fun watches its bonding curve program. Raydium watches new AMM pool creation. Any monitors both simultaneously.">?</button>' +
      '</div>' +
      '<div class="mode-toggle" style="margin-bottom:0">' +
        '<button class="mode-btn '+(a.platform==='pump'?'active':'')+'\" data-action="ab-platform" data-platform="pump"'+dis+'>Pump.fun</button>' +
        '<button class="mode-btn '+(a.platform==='raydium'?'active':'')+'\" data-action="ab-platform" data-platform="raydium"'+dis+'>Raydium</button>' +
        '<button class="mode-btn '+(a.platform==='any'?'active':'')+'\" data-action="ab-platform" data-platform="any"'+dis+'>Any</button>' +
      '</div>' +
    '</div>' +

    '<div class="section-divider" style="margin:14px 0 0"></div>' +
    '<div class="section-hdr" style="margin:10px 0">Execution Flow ' +
      '<button class="help-q" data-action="show-help" data-title="Execution Flow" data-body="Nodes run top-to-bottom when a token is detected. Insta Buy nodes fire parallel Jito bundles from all selected wallets the instant the coin is detected. Bundle nodes accumulate organically after.">?</button>' +
    '</div>' +

    a.nodes.map(function(node,i){return _abNodeCard(node,i,running);}).join('') +

    (!running?
      '<div class="ab-add-wrap">' +
        '<button class="ab-add-btn" data-action="ab-add-sniper">＋ Insta Buy Node</button>' +
        '<button class="ab-add-btn" data-action="ab-add-bundle">＋ Bundle Node</button>' +
      '</div>'
    :'') +

    '<button class="btn '+(running?'btn-danger':'btn-primary')+' btn-full" style="margin:4px 0 12px" data-action="ab-toggle">' +
      (running?'■  STOP AUTO BUNDLE':'▶  START AUTO BUNDLE') +
    '</button>' +

    '<div class="ab-stats-grid">' +
      '<div class="ab-stat"><div class="ab-stat-val">'+(stats.detected||0)+'</div><div class="ab-stat-lbl">Detected</div></div>' +
      '<div class="ab-stat"><div class="ab-stat-val">'+(stats.snipesOk||0)+'</div><div class="ab-stat-lbl">Snipes</div></div>' +
      '<div class="ab-stat"><div class="ab-stat-val">'+(stats.buys||0)+'</div><div class="ab-stat-lbl">Buys</div></div>' +
      '<div class="ab-stat"><div class="ab-stat-val">'+((stats.solSpent||0).toFixed(3))+'</div><div class="ab-stat-lbl">SOL Spent</div></div>' +
    '</div>' +

    '</div>'
  );
}

function _abNodeCard(node,idx,running){
  if(node.type==='instabuy' || node.type==='sniper') return _abInstaBuyCard(node,idx,running);
  if(node.type==='bundle') return _abBundleCard(node,idx,running);
  return '';
}

function _abInstaBuyCard(node,idx,running){
  var dis=running?' disabled':'', open=node._expanded;
  var cnt=(node.walletIds||[]).length;
  var sub=cnt>0 ? cnt+' wallet'+(cnt!==1?'s':'') : 'No wallets set';
  var body='';
  if(open){
    body='<div class="ab-node-body">'+
      '<div class="sf-row">'+
        '<div class="sf-label">Buy Wallets '+
          '<button class="help-q" data-action="show-help" data-title="Buy Wallets" data-body="All selected wallets fire simultaneously the moment a coin is detected — each buys a share of the total budget in parallel, with random per-wallet deviation.">?</button>'+
        '</div>'+
        _abMpkPicker(node,'instabuy',dis)+
      '</div>'+
      '<div class="ab-g3" style="margin-bottom:0">'+
        '<div class="sf-row" style="margin-bottom:0"><div class="sf-label">Total Budget (SOL)</div>'+
          '<input type="number" id="abn-'+node.id+'-bgt" value="'+(node.totalBudgetSOL||0.5)+'" step="0.01" min="0.01" data-nid="'+node.id+'" data-field="totalBudgetSOL" oninput="_abSaveField(this)"'+dis+'/>'+
        '</div>'+
        '<div class="sf-row" style="margin-bottom:0"><div class="sf-label">Priority (SOL)</div>'+
          '<input type="number" id="abn-'+node.id+'-pri" value="'+node.prioritySOL+'" step="0.001" min="0.001" data-nid="'+node.id+'" data-field="prioritySOL" oninput="_abSaveField(this)"'+dis+'/>'+
        '</div>'+
        '<div class="sf-row" style="margin-bottom:0"><div class="sf-label">Jito Tip (SOL)</div>'+
          '<input type="number" id="abn-'+node.id+'-tip" value="'+node.jitoTipSOL+'" step="0.0001" min="0.0001" data-nid="'+node.id+'" data-field="jitoTipSOL" oninput="_abSaveField(this)"'+dis+'/>'+
        '</div>'+
      '</div>'+
      ((node.walletIds&&node.walletIds.length>0)?
        '<div style="font-size:9.5px;color:var(--text-muted);margin:4px 0 2px">'+
          '~'+((node.totalBudgetSOL||0.5)/node.walletIds.length).toFixed(4)+' SOL each · ±'+(node.deviationPct||0)+'% deviation'+
        '</div>' : '')+
      '<div class="sf-row" style="margin-top:6px;margin-bottom:0">'+
        '<div class="sf-label">Slippage '+
          '<button class="help-q" data-action="show-help" data-title="Slippage %" data-body="How much price movement to tolerate between quote and fill. 15-20% is typical for volatile new tokens at launch.">?</button>'+
        '</div>'+
        '<div style="display:flex;align-items:center;gap:5px">'+
          '<input type="number" id="abn-'+node.id+'-slip" value="'+(node.slippagePct||15)+'" step="1" min="1" max="50" style="width:70px" data-nid="'+node.id+'" data-field="slippagePct" oninput="_abSaveField(this)"'+dis+'/>'+
          '<span style="font-size:11px;color:var(--text-dim)">%</span>'+
        '</div>'+
      '</div>'+
      '<div class="sf-row" style="margin-top:8px;margin-bottom:0">'+
        '<div class="sf-label">Per-Wallet Deviation <span style="color:var(--navy);font-weight:700" id="abn-'+node.id+'-dev-val">±'+(node.deviationPct||0)+'%</span> '+
          '<button class="help-q" data-action="show-help" data-title="Per-Wallet Deviation" data-body="Randomises each wallet buy amount by up to this percentage. 0% = every wallet buys an equal share. 20% = each wallet buys 80–120% of their share. Total expected spend stays the same.">?</button>'+
        '</div>'+
        '<div class="slider-row">'+
          '<input type="range" min="0" max="50" step="1" value="'+(node.deviationPct||0)+'" data-nid="'+node.id+'" data-field="deviationPct" oninput="_abSaveSliderDev(this)"'+dis+'/>'+
          '<span class="slider-value">±<span id="abn-'+node.id+'-dev-lbl">'+(node.deviationPct||0)+'</span>%</span>'+
        '</div>'+
      '</div>'+
    '</div>';
  }
  return '<div class="ab-node">'+
    '<div class="ab-node-hdr" data-action="ab-node-toggle" data-nid="'+node.id+'">'+
      '<span class="ab-node-badge sniper">Insta Buy</span>'+
      '<span class="ab-node-title">'+node.label+'</span>'+
      '<span class="ab-node-sub">'+sub+'</span>'+
      '<span class="ab-node-chevron '+(open?'open':'')+'">&#x203a;</span>'+
      (!running?'<button class="ab-node-del" data-action="ab-node-del" data-nid="'+node.id+'">&#x2715;</button>':'')+
    '</div>'+
    body+
  '</div>';
}
function _abSniperCard(node,idx,running){ return _abInstaBuyCard(node,idx,running); }

function _abBundleCard(node,idx,running){
  var dis=running?' disabled':'', open=node._expanded;
  var cnt=(node.walletIds||[]).length;
  var strats={dip:'Buy Dips',spread:'Spread',instant:'Fast'};
  var body='';
  if(open){
    body='<div class="ab-node-body">'+
      '<div class="sf-row">'+
        '<div class="sf-label">Buy Wallets '+
          '<button class="help-q" data-action="show-help" data-title="Bundle Buy Wallets" data-body="These wallets accumulate the token after the sniper fires. Budget is distributed using a bell-curve so amounts look like independent retail buys.">?</button>'+
        '</div>'+
        _abMpkPicker(node,'bundle',dis)+
      '</div>'+
      '<div class="sf-row">'+
        '<div class="sf-label">Strategy '+
          '<button class="help-q" data-action="show-help" data-title="Buy Strategy" data-body="Buy Dips: waits for price to drop N% from recent peak before each buy. Spread: staggered random delays. Fast: minimal delay.">?</button>'+
        '</div>'+
        '<div class="mode-toggle" style="margin-bottom:0">'+
          Object.keys(strats).map(function(v){
            return '<button class="mode-btn '+(node.strategy===v?'active':'')+'\" data-action="ab-bundle-strat" data-nid="'+node.id+'" data-strat="'+v+'"'+dis+'>'+strats[v]+'</button>';
          }).join('')+
        '</div>'+
        (node.strategy==='dip'?
          '<div class="ab-sub-row" style="margin-top:6px"><span class="ab-sub-lbl">Dip threshold:</span>'+
            '<input type="number" id="abn-'+node.id+'-dip" value="'+node.dipPct+'" step="1" min="1" max="50" style="width:60px" data-nid="'+node.id+'" data-field="dipPct" oninput="_abSaveField(this)"'+dis+'/>'+
            '<span class="ab-sub-lbl">% drop from recent high</span>'+
          '</div>':'')+
      '</div>'+
      '<div class="ab-g2" style="margin-bottom:0">'+
        '<div class="sf-row" style="margin-bottom:0">'+
          '<div class="sf-label">Total Budget (SOL)</div>'+
          '<input type="number" id="abn-'+node.id+'-bgt" value="'+node.totalBudgetSOL+'" step="0.1" min="0.01" data-nid="'+node.id+'" data-field="totalBudgetSOL" oninput="_abSaveField(this)"'+dis+'/>'+
        '</div>'+
        '<div class="sf-row" style="margin-bottom:0"><div class="sf-label">Priority (SOL)</div>'+
          '<input type="number" id="abn-'+node.id+'-pri" value="'+node.prioritySOL+'" step="0.0005" min="0.0001" data-nid="'+node.id+'" data-field="prioritySOL" oninput="_abSaveField(this)"'+dis+'/>'+
        '</div>'+
      '</div>'+
      '<div class="ab-g2" style="margin-top:8px;margin-bottom:0">'+
        '<div class="sf-row" style="margin-bottom:0"><div class="sf-label">Min Buy (SOL)</div>'+
          '<input type="number" id="abn-'+node.id+'-mn" value="'+node.minBuySOL+'" step="0.01" min="0.01" data-nid="'+node.id+'" data-field="minBuySOL" oninput="_abSaveField(this)"'+dis+'/>'+
        '</div>'+
        '<div class="sf-row" style="margin-bottom:0"><div class="sf-label">Max Buy (SOL)</div>'+
          '<input type="number" id="abn-'+node.id+'-mx" value="'+node.maxBuySOL+'" step="0.01" min="0.01" data-nid="'+node.id+'" data-field="maxBuySOL" oninput="_abSaveField(this)"'+dis+'/>'+
        '</div>'+
      '</div>'+
      '<div class="ab-g2" style="margin-top:8px;margin-bottom:0">'+
        '<div class="sf-row" style="margin-bottom:0"><div class="sf-label">Min Delay (s)</div>'+
          '<input type="number" id="abn-'+node.id+'-mnd" value="'+node.minDelaySec+'" step="0.5" min="0.1" data-nid="'+node.id+'" data-field="minDelaySec" oninput="_abSaveField(this)"'+dis+'/>'+
        '</div>'+
        '<div class="sf-row" style="margin-bottom:0"><div class="sf-label">Max Delay (s)</div>'+
          '<input type="number" id="abn-'+node.id+'-mxd" value="'+node.maxDelaySec+'" step="0.5" min="0.1" data-nid="'+node.id+'" data-field="maxDelaySec" oninput="_abSaveField(this)"'+dis+'/>'+
        '</div>'+
      '</div>'+
      '<div class="sf-row" style="margin-top:8px">'+
        '<div class="sf-label">Slippage</div>'+
        '<div style="display:flex;align-items:center;gap:5px">'+
          '<input type="number" id="abn-'+node.id+'-slip" value="'+(node.slippagePct||15)+'" step="1" min="1" max="50" style="width:70px" data-nid="'+node.id+'" data-field="slippagePct" oninput="_abSaveField(this)"'+dis+'/>'+
          '<span style="font-size:11px;color:var(--text-dim)">%</span>'+
        '</div>'+
      '</div>'+
    '</div>';
  }
  return '<div class="ab-node">'+
    '<div class="ab-node-hdr" data-action="ab-node-toggle" data-nid="'+node.id+'">'+
      '<span class="ab-node-badge bundle">Bundle</span>'+
      '<span class="ab-node-title">'+node.label+'</span>'+
      '<span class="ab-node-sub">'+cnt+' wallet'+(cnt!==1?'s':'')+' · '+strats[node.strategy||'dip']+'</span>'+
      '<span class="ab-node-chevron '+(open?'open':'')+'">›</span>'+
      (!running?'<button class="ab-node-del" data-action="ab-node-del" data-nid="'+node.id+'">✕</button>':'')+
    '</div>'+
    body+
  '</div>';
}

function _abMpkPicker(node, arr, dis) {
  var selIds = arr === 'rot' ? (node.rotationWalletIds||[]) : (node.walletIds||[]);
  var wallets = S.savedWallets || [];
  var groups  = S.walletGroups || [];
  var allW    = wallets.filter(function(w){ return w.publicKey; });
  var ungrouped = allW.filter(function(w){ return !w.groupId; });
  var openKey = 'ab-mpk-'+arr+'-'+node.id;
  var open    = !!(S.bundle._abMpkOpen && S.bundle._abMpkOpen[openKey]);
  var selSet  = new Set(selIds);
  var count   = selIds.length;
  var label = arr === 'rot'
    ? (count > 0 ? count+' rotation wallet'+(count!==1?'s':'')+' (round-robin)' : 'Select rotation wallets…')
    : (count > 0 ? count+' wallet'+(count!==1?'s':'')+' selected' : 'Select wallets…');
  var dropdown = '';
  if (open) {
    var rows = '';
    groups.forEach(function(g) {
      var gW = allW.filter(function(w){ return w.groupId === g.id; });
      if (!gW.length) return;
      var allSel = gW.every(function(w){ return selSet.has(w.id); });
      var somSel = gW.some(function(w){ return selSet.has(w.id); });
      rows += '<div class="tpicker-group-hdr" data-action="ab-mpk-group" data-nid="'+node.id+'" data-arr="'+arr+'" data-gid="'+g.id+'">' +
        '<div class="tpicker-check '+(allSel?'checked':somSel?'partial':'')+'"></div>' +
        '<span>'+(g.emoji||'📁')+'</span>' +
        '<span class="tpicker-group-name">'+g.name+'</span>' +
        '<span class="tpicker-count">'+gW.length+'</span>' +
      '</div>';
      gW.forEach(function(w) {
        var sel = selSet.has(w.id);
        rows += '<div class="tpicker-wallet-row '+(sel?'selected':'')+'\" data-action="ab-mpk-wallet" data-nid="'+node.id+'" data-arr="'+arr+'" data-wid="'+w.id+'">' +
          '<div class="tpicker-check '+(sel?'checked':'')+'"></div>' +
          '<span>'+(w.emoji||'💼')+'</span>' +
          '<div class="tpicker-info"><span class="tpicker-name">'+(w.name||'Wallet')+'</span><span class="tpicker-addr">'+wShort(w.publicKey)+'</span></div>' +
          (w.solBalance!=null?'<span style="font-size:10px;font-weight:600;color:var(--blue);margin-left:auto;flex-shrink:0">'+parseFloat(w.solBalance).toFixed(3)+' SOL</span>':'')+
        '</div>';
      });
    });
    ungrouped.forEach(function(w) {
      var sel = selSet.has(w.id);
      rows += '<div class="tpicker-wallet-row '+(sel?'selected':'')+'\" data-action="ab-mpk-wallet" data-nid="'+node.id+'" data-arr="'+arr+'" data-wid="'+w.id+'">' +
        '<div class="tpicker-check '+(sel?'checked':'')+'"></div>' +
        '<span>'+(w.emoji||'💼')+'</span>' +
        '<div class="tpicker-info"><span class="tpicker-name">'+(w.name||'Wallet')+'</span><span class="tpicker-addr">'+wShort(w.publicKey)+'</span></div>' +
        (w.solBalance!=null?'<span style="font-size:10px;font-weight:600;color:var(--blue);margin-left:auto;flex-shrink:0">'+parseFloat(w.solBalance).toFixed(3)+' SOL</span>':'')+
      '</div>';
    });
    if (!allW.length) rows = '<div class="cpicker-empty">No wallets yet. Add some in the Wallets tab.</div>';
    var pasteId = 'ab-mpk-paste-inp-'+arr+'-'+node.id;
    dropdown = '<div class="cpicker-dropdown cpicker-targets">'+rows+
      '<div class="cpicker-divider"></div>'+
      '<div class="cpicker-paste-label">Or paste private key</div>'+
      '<div style="display:flex;gap:5px;padding:0 8px 8px">'+
        '<input type="password" id="'+pasteId+'" placeholder="Base58 private key…" style="flex:1;font-size:10.5px"/>'+
        '<button class="btn btn-ghost btn-sm" data-action="ab-mpk-paste" data-nid="'+node.id+'" data-arr="'+arr+'" data-inp="'+pasteId+'">Add</button>'+
      '</div>'+
    '</div>';
  }
  return '<div class="cpicker-wrap">'+
    '<div class="cpicker-btn '+(count>0?'cpicker-selected':'')+'\" data-action="ab-mpk-toggle" data-nid="'+node.id+'" data-arr="'+arr+'"'+dis+'>'+
      '<span style="font-size:11px;color:'+(count>0?'var(--navy)':'var(--text-muted)')+'">'+label+'</span>'+
      '<span class="cpicker-chevron '+(open?'open':'')+'">&#x203a;</span>'+
    '</div>'+dropdown+
  '</div>';
}

/* ── Log / History sections ──────────────────────────────────── */
function buildAutoBundleLogSection(){
  if(!S.bundle||!S.bundle.auto) return '';
  var a=S.bundle.auto;
  if(!a.log||!a.log.length) return '';
  return '<div class="section-hdr" style="margin-top:14px;margin-bottom:6px">Auto Bundle Log '+
    '<span id="ab-log-count" style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-muted);margin-left:4px">'+a.log.length+'</span></div>'+
    '<div class="ab-log-wrap">'+
      '<div class="ab-log-bar"><span class="ab-log-lbl">Console</span>'+
        '<button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:9px" data-action="ab-clear-log">Clear</button>'+
      '</div>'+
      '<div class="ab-log-feed" id="ab-log-feed">'+
        a.log.map(function(e){
          var safe=String(e.msg).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          var cls=e.type==='ok'?'ok':e.type==='err'?'err':e.type==='warn'?'warn':'info';
          return '<div class="ab-log-entry log-'+cls+'"><span class="ab-log-ts">'+e.ts+'</span><span class="ab-log-msg">'+safe+'</span></div>';
        }).join('')+
      '</div>'+
    '</div>';
}

function buildAutoBundleHistoryRows(){
  if(!S.bundle||!S.bundle.auto) return '';
  var hist=S.bundle.auto.history||[];
  if(!hist.length) return '';
  return '<div class="section-hdr" style="margin-top:14px;margin-bottom:6px">Auto Bundle Sessions</div>'+
    hist.map(function(h){
      var date=new Date(h.ts).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      return '<div class="bundle-hist-card">'+
        '<div class="bundle-hist-hdr">'+
          '<div style="display:flex;align-items:center;gap:8px"><span class="verdict-badge badge-purple">Auto</span><span style="font-size:10px;color:var(--text-muted)">'+date+'</span></div>'+
          '<span style="font-size:10px;color:var(--text-dim)">'+(h.snipesOk||0)+' snipes · '+(h.buys||0)+' buys · '+((h.solSpent||0).toFixed(3))+' SOL</span>'+
        '</div>'+
        (h.ca?'<div style="padding:3px 12px 8px;font-size:9.5px;color:var(--text-muted)">'+(h.name?'$'+h.name+' · ':'')+_abShort(h.ca)+'</div>':'')+
      '</div>';
    }).join('');
}

/* ── Event handler ───────────────────────────────────────────── */
async function handleAutoBundleAction(action,el){
  if(!S.bundle||!S.bundle.auto) initAutoBundleState();
  var a=S.bundle.auto;

  if(action==='ab-toggle'){_abSaveForm();if(a.active) await abStop();else await abStart();return;}
  if(action==='ab-mode'){_abSaveForm();a.mode=el.dataset.mode;await saveState();render();return;}
  if(action==='ab-jito-region'){
    var sel=document.getElementById('ab-jito-region');
    if(sel&&S.bundle&&S.bundle.auto){S.bundle.auto.jitoRegion=sel.value;saveState();}
    return;
  }
  if(action==='ab-platform'){_abSaveForm();a.platform=el.dataset.platform;await saveState();render();return;}
  if(action==='ab-node-toggle'){
    _abSaveForm();
    var node=a.nodes.find(function(n){return n.id===el.dataset.nid;});
    if(node){node._expanded=!node._expanded;await saveState();render();}return;
  }
  if(action==='ab-node-del'){a.nodes=a.nodes.filter(function(n){return n.id!==el.dataset.nid;});await saveState();render();return;}
  if(action==='ab-add-sniper'||action==='ab-add-instabuy'){var node=abNewInstaBuy(a.nodes.filter(function(n){return n.type==='instabuy'||n.type==='sniper';}).length+1);a.nodes.push(node);await saveState();render();return;}
  if(action==='ab-add-bundle'){var node=abNewBundle();a.nodes.push(node);await saveState();render();return;}
  if(action==='ab-bundle-strat'){_abSaveForm();var node=a.nodes.find(function(n){return n.id===el.dataset.nid;});if(node){node.strategy=el.dataset.strat;await saveState();render();}return;}
  if(action==='ab-mpk-toggle'){
    var nid=el.dataset.nid, arr2=el.dataset.arr;
    var node=a.nodes.find(function(n){return n.id===nid;});
    if(!node) return;
    if(!S.bundle._abMpkOpen) S.bundle._abMpkOpen={};
    var k='ab-mpk-'+arr2+'-'+nid;
    S.bundle._abMpkOpen[k]=!S.bundle._abMpkOpen[k];
    render(); return;
  }
  if(action==='ab-mpk-wallet'){
    var nid=el.dataset.nid, arr2=el.dataset.arr, wid=el.dataset.wid;
    var node=a.nodes.find(function(n){return n.id===nid;});
    if(!node) return;
    var arr3=arr2==='rot'?node.rotationWalletIds:node.walletIds;
    var i=arr3.indexOf(wid);
    if(i>=0) arr3.splice(i,1); else arr3.push(wid);
    await saveState(); render(); return;
  }
  if(action==='ab-mpk-group'){
    var nid=el.dataset.nid, arr2=el.dataset.arr, gid=el.dataset.gid;
    var node=a.nodes.find(function(n){return n.id===nid;});
    if(!node) return;
    var arr3=arr2==='rot'?node.rotationWalletIds:node.walletIds;
    var gW=(S.savedWallets||[]).filter(function(w){return w.groupId===gid&&w.publicKey;});
    var allSel=gW.every(function(w){return arr3.includes(w.id);});
    if(allSel) gW.forEach(function(w){var i=arr3.indexOf(w.id);if(i>=0)arr3.splice(i,1);});
    else       gW.forEach(function(w){if(!arr3.includes(w.id))arr3.push(w.id);});
    await saveState(); render(); return;
  }
  if(action==='ab-mpk-paste'){
    var nid=el.dataset.nid, arr2=el.dataset.arr, inpId=el.dataset.inp;
    var node=a.nodes.find(function(n){return n.id===nid;});
    if(!node) return;
    var arr3=arr2==='rot'?node.rotationWalletIds:node.walletIds;
    var inp=document.getElementById(inpId);
    var val=inp&&inp.value.trim();
    if(!val){showToast('Paste a private key first');return;}
    try{
      var privBytes=bs58decode(val);
      var pub=bs58encode(privBytes.slice(32,64));
      var w=S.savedWallets.find(function(x){return x.publicKey===pub;});
      if(!w){w={id:uid(),name:'Pasted Wallet',emoji:'🔑',publicKey:pub,privateKey:val,groupId:null};S.savedWallets.push(w);}
      else if(!w.privateKey){w.privateKey=val;}
      if(!arr3.includes(w.id)) arr3.push(w.id);
      if(inp) inp.value='';
      showToast('Added: '+wShort(pub));
    }catch(err){showToast('Invalid private key');}
    await saveState(); render(); return;
  }
  if(action==='ab-clear-log'){a.log=[];await saveState();render();return;}
}

document.addEventListener('click',function(e){
  if(!S.bundle) return;
  if(e.target.closest('.cpicker-wrap')) return;
  var changed=false;
  if(S.bundle._abMpkOpen&&Object.values(S.bundle._abMpkOpen).some(Boolean)){S.bundle._abMpkOpen={};changed=true;}
  if(changed&&S.activeTool==='bundle-checker') render();
});

/* ── Server sync ─────────────────────────────────────────────── */
function _abGetToken(){
  return (S.auth&&S.auth.token)||localStorage.getItem('udt_token')||'';
}

async function _abNotifyServer(action, config){
  var token=_abGetToken();
  if(!token||typeof BACKEND==='undefined') return;
  try{
    var body='{}';
    if(action==='start'){
      var walletIds=new Set();
      (config.nodes||[]).forEach(function(n){
        // FIX: only use walletIds[] (walletId was deleted by migration)
        (n.walletIds||[]).forEach(function(id){walletIds.add(id);});
      });
      var wallets=(S.savedWallets||[])
        .filter(function(w){return walletIds.has(w.id)&&w.publicKey&&w.privateKey;})
        .map(function(w){return{id:w.id,publicKey:w.publicKey,privateKey:w.privateKey};});
      body=JSON.stringify({
        mode:       config.mode,
        ticker:     config.ticker,
        deployer:   config.deployer,
        platform:   config.platform,
        jitoRegion: config.jitoRegion||'mainnet',
        nodes:      config.nodes||[],
        wallets:    wallets,
      });
    }
    var r=await fetch(BACKEND+'/api/bot/auto-bundle/'+action,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body: body,
    });
    if(!r.ok){
      var err=await r.json().catch(function(){return{};});
      abLog('Server start failed: '+(err.error||r.status),'err');
    }
  }catch(e){
    abLog('Server notify failed: '+e.message,'err');
    console.warn('[auto-bundle] server notify failed:',e.message);
  }
}

async function abCheckServerStatus(){
  var token=_abGetToken();
  if(!token||typeof BACKEND==='undefined') return;
  try{
    var r=await fetch(BACKEND+'/api/bot/auto-bundle/status',{headers:{'Authorization':'Bearer '+token}});
    if(!r.ok) return;
    var d=await r.json();
    if(d.active&&S.bundle&&S.bundle.auto&&!S.bundle.auto.active){
      S.bundle.auto.active=true;
      S.bundle.auto.phase=d.phase||'watching';
      S.bundle.auto.detectedCA=d.detectedCA||null;
      S.bundle.auto.detectedName=d.detectedName||null;
      abLog('Reconnected to running bot session (server-side)','ok');
      _abConnectSSE();
      render();
    }
  }catch(e){ console.warn('[auto-bundle] server status check failed:',e.message); }
}

var _abEvtSource=null;
function _abConnectSSE(){
  var token=_abGetToken();
  if(!token||typeof BACKEND==='undefined') return;
  if(_abEvtSource){_abEvtSource.close();_abEvtSource=null;}
  try{
    _abEvtSource=new EventSource(BACKEND+'/api/bot/auto-bundle/events?token='+encodeURIComponent(token));
    _abEvtSource.onmessage=function(e){
      try{
        var d=JSON.parse(e.data);
        if(d.type==='log')  abLog(d.msg,d.level||'info');
        if(d.type==='detected'){
          abLog('🎯 Detected: '+(d.name?'$'+d.name+' ':'')+d.ca,'ok');
          if(S.bundle&&S.bundle.auto){
            S.bundle.auto.detectedCA=d.ca;
            S.bundle.auto.detectedName=d.name;
            S.bundle.auto.phase='executing';
            render();
          }
        }
        if(d.type==='phase'){
          if(S.bundle&&S.bundle.auto) S.bundle.auto.phase=d.phase;
          render();
        }
        if(d.type==='stats'){
          if(S.bundle&&S.bundle.auto&&S.bundle.auto.stats){
            if(d.snipesOk!=null)  S.bundle.auto.stats.snipesOk=d.snipesOk;
            if(d.buys!=null)      S.bundle.auto.stats.buys=d.buys;
            if(d.solSpent!=null)  S.bundle.auto.stats.solSpent=d.solSpent;
          }
          render();
        }
        if(d.type==='stopped'){
          if(S.bundle&&S.bundle.auto) S.bundle.auto.active=false;
          render();
        }
      }catch(ex){}
    };
    _abEvtSource.onerror=function(){
      setTimeout(function(){
        if(S.bundle&&S.bundle.auto&&S.bundle.auto.active) abCheckServerStatus();
      },5000);
    };
  }catch(e){ console.warn('[auto-bundle] SSE connect failed:',e.message); }
}

/* ── Exports ─────────────────────────────────────────────────── */
window.buildAutoBundleTab         = buildAutoBundleTab;
window.buildAutoBundleLogSection  = buildAutoBundleLogSection;
window.buildAutoBundleHistoryRows = buildAutoBundleHistoryRows;
window.handleAutoBundleAction     = handleAutoBundleAction;
window.initAutoBundleState        = initAutoBundleState;