'use strict';

window.UdtModules = window.UdtModules || {};

window.UdtModules.bundle = {
  render() {
    return `
      <section class="card panel">
        <h2>Bundle</h2>
        <p class="muted">Use this for protected bundle orchestration. Keep third-party API keys and decision logic on the backend.</p>
        <div class="notice" style="margin:14px 0;">This browser client does not contain the private execution logic. It only submits validated jobs to your backend.</div>
        <form id="bundle-form" class="form-grid">
          <div><label class="label">Target mint</label><input class="input" name="targetMint" placeholder="Token mint" type="text"></div><div><label class="label">Wallet count</label><input class="input" name="walletCount" placeholder="5" type="number"></div><div><label class="label">Total amount</label><input class="input" name="totalAmount" placeholder="10" type="number"></div>
          <div style="display:flex; align-items:end;"><button class="btn primary" type="submit">Queue Bundle job</button></div>
        </form>
        <div id="bundle-result" style="margin-top:16px;"></div>
      </section>
    `;
  },
  bind(_state, _app) {
    const form = document.getElementById('bundle-form');
    const result = document.getElementById('bundle-result');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await UDT.ToolsAPI.createJob('bundle', data);
        result.innerHTML = `<div class="badge ok">Queued</div><div class="code-block" style="margin-top:12px;">${UDT_APP.escape(JSON.stringify(response.job, null, 2))}</div>`;
      } catch (error) {
        result.innerHTML = `<div class="badge danger">${UDT_APP.escape(error.message)}</div>`;
      }
    });
  }
};
