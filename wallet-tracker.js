'use strict';

window.UdtModules = window.UdtModules || {};

window.UdtModules.tracker = {
  render(state) {
    const items = state.wallets.map((wallet) => `
      <div class="list-item">
        <strong>${UDT_APP.escape(wallet.label)}</strong>
        <div class="muted small" style="margin-top:6px;"><code>${UDT_APP.escape(wallet.address)}</code></div>
      </div>
    `).join('') || '<div class="list-item muted">Add watch-only wallets first.</div>';

    return `
      <section class="card panel">
        <h2>Wallet tracker</h2>
        <p class="muted">Read-only tracker shell. Wire this to a backend indexer or a trusted RPC proxy. Do not ship paid tracking logic and alert rules in public browser code if you want them protected.</p>
        <div class="list" style="margin-top:16px;">${items}</div>
      </section>
    `;
  }
};
