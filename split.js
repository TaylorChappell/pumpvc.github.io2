'use strict';

window.UdtModules = window.UdtModules || {};

window.UdtModules.split = {
  render() {
    return `
      <section class="card panel">
        <h2>Split</h2>
        <p class="muted">Plan a token split job without exposing private wallet logic in the public frontend.</p>
        <div class="notice" style="margin:14px 0;">This browser client does not contain the private execution logic. It only submits validated jobs to your backend.</div>
        <form id="split-form" class="form-grid">
          <div><label class="label">Source public address</label><input class="input" name="sourceAddress" placeholder="Watch-only source address" type="text"></div><div><label class="label">Target addresses (comma separated)</label><textarea class="textarea" name="targetAddresses" placeholder="addr1, addr2, addr3"></textarea></div><div><label class="label">Token mint</label><input class="input" name="tokenMint" placeholder="Token mint" type="text"></div>
          <div style="display:flex; align-items:end;"><button class="btn primary" type="submit">Queue Split job</button></div>
        </form>
        <div id="split-result" style="margin-top:16px;"></div>
      </section>
    `;
  },
  bind(_state, _app) {
    const form = document.getElementById('split-form');
    const result = document.getElementById('split-result');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await UDT.ToolsAPI.createJob('split', data);
        result.innerHTML = `<div class="badge ok">Queued</div><div class="code-block" style="margin-top:12px;">${UDT_APP.escape(JSON.stringify(response.job, null, 2))}</div>`;
      } catch (error) {
        result.innerHTML = `<div class="badge danger">${UDT_APP.escape(error.message)}</div>`;
      }
    });
  }
};
