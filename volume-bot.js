'use strict';

window.UdtModules = window.UdtModules || {};

window.UdtModules.volume = {
  render() {
    return `
      <section class="card panel">
        <h2>Volume</h2>
        <p class="muted">This page only queues backend-controlled jobs. It does not expose automation logic or secrets in public JavaScript.</p>
        <div class="notice" style="margin:14px 0;">This browser client does not contain the private execution logic. It only submits validated jobs to your backend.</div>
        <form id="volume-form" class="form-grid">
          <div><label class="label">Target mint</label><input class="input" name="targetMint" placeholder="Token mint" type="text"></div><div><label class="label">Budget</label><input class="input" name="budget" placeholder="50" type="number"></div><div><label class="label">Internal notes</label><textarea class="textarea" name="notes" placeholder="Optional job note"></textarea></div>
          <div style="display:flex; align-items:end;"><button class="btn primary" type="submit">Queue Volume job</button></div>
        </form>
        <div id="volume-result" style="margin-top:16px;"></div>
      </section>
    `;
  },
  bind(_state, _app) {
    const form = document.getElementById('volume-form');
    const result = document.getElementById('volume-result');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await UDT.ToolsAPI.createJob('volume', data);
        result.innerHTML = `<div class="badge ok">Queued</div><div class="code-block" style="margin-top:12px;">${UDT_APP.escape(JSON.stringify(response.job, null, 2))}</div>`;
      } catch (error) {
        result.innerHTML = `<div class="badge danger">${UDT_APP.escape(error.message)}</div>`;
      }
    });
  }
};
