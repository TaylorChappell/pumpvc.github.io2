'use strict';

window.UdtModules = window.UdtModules || {};

window.UdtModules.sniper = {
  render() {
    return `
      <section class="card panel">
        <h2>Sniper</h2>
        <p class="muted">Queue a protected execution request. The actual strategy, signing, and RPC logic should live in your private server worker.</p>
        <div class="notice" style="margin:14px 0;">This browser client does not contain the private execution logic. It only submits validated jobs to your backend.</div>
        <form id="sniper-form" class="form-grid">
          <div><label class="label">Target mint</label><input class="input" name="targetMint" placeholder="Token mint" type="text"></div><div><label class="label">Max spend (SOL)</label><input class="input" name="maxSpend" placeholder="0.5" type="number"></div><div><label class="label">Slippage (bps)</label><input class="input" name="slippageBps" placeholder="500" type="number"></div>
          <div style="display:flex; align-items:end;"><button class="btn primary" type="submit">Queue Sniper job</button></div>
        </form>
        <div id="sniper-result" style="margin-top:16px;"></div>
      </section>
    `;
  },
  bind(_state, _app) {
    const form = document.getElementById('sniper-form');
    const result = document.getElementById('sniper-result');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await UDT.ToolsAPI.createJob('sniper', data);
        result.innerHTML = `<div class="badge ok">Queued</div><div class="code-block" style="margin-top:12px;">${UDT_APP.escape(JSON.stringify(response.job, null, 2))}</div>`;
      } catch (error) {
        result.innerHTML = `<div class="badge danger">${UDT_APP.escape(error.message)}</div>`;
      }
    });
  }
};
