'use strict';

window.UdtModules = window.UdtModules || {};

window.UdtModules.wallets = {
  render(state) {
    const walletRows = state.wallets.map((wallet) => `
      <tr>
        <td>${UDT_APP.escape(wallet.label)}</td>
        <td><code>${UDT_APP.escape(wallet.address)}</code></td>
        <td><button class="btn ghost" data-remove-wallet="${wallet.id}">Remove</button></td>
      </tr>
    `).join('') || `<tr><td colspan="3" class="muted">No watch-only wallets saved.</td></tr>`;

    return `
      <section class="card panel">
        <h2>Watch-only wallet list</h2>
        <p class="muted">This rewrite removes browser-side raw private key storage from the website. Keep signing inside a wallet extension or a separate private worker.</p>
        <form id="wallet-form" class="form-grid" style="margin-top:16px;">
          <div>
            <label class="label">Label</label>
            <input class="input" name="label" placeholder="Treasury" required>
          </div>
          <div>
            <label class="label">Public address</label>
            <input class="input" name="address" placeholder="Solana address" required>
          </div>
          <div style="display:flex; align-items:end;">
            <button class="btn primary" type="submit">Add watch-only wallet</button>
          </div>
        </form>
        <hr class="sep">
        <table class="table">
          <thead><tr><th>Label</th><th>Address</th><th></th></tr></thead>
          <tbody>${walletRows}</tbody>
        </table>
      </section>
    `;
  },

  bind(state, app) {
    const form = document.getElementById('wallet-form');
    if (form) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const result = await UDT.WalletAPI.add({
          label: String(data.get('label') || ''),
          address: String(data.get('address') || ''),
        });
        state.wallets.unshift(result.wallet);
        app.render();
      });
    }

    document.querySelectorAll('[data-remove-wallet]').forEach((button) => {
      button.addEventListener('click', async () => {
        const id = Number(button.dataset.removeWallet);
        await UDT.WalletAPI.remove(id);
        state.wallets = state.wallets.filter((wallet) => wallet.id !== id);
        app.render();
      });
    });
  }
};
