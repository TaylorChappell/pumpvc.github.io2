'use strict';

window.UdtModules = window.UdtModules || {};

const App = {
  state: {
    user: null,
    subscription: null,
    route: 'overview',
    jobs: [],
    wallets: [],
    settings: {
      apiBase: UDT_CONFIG.apiBase,
    },
  },

  async bootDashboard() {
    const user = await UDT.AuthAPI.restore();
    if (!user) {
      location.replace('auth.html');
      return;
    }

    this.state.user = user;
    this.state.subscription = await UDT.SubAPI.status().catch(() => ({ active: false }));
    this.state.jobs = (await UDT.ToolsAPI.listJobs().catch(() => ({ jobs: [] }))).jobs || [];
    this.state.wallets = (await UDT.WalletAPI.list().catch(() => ({ wallets: [] }))).wallets || [];

    const saved = await UDT.StateAPI.load().catch(() => ({ state: {} }));
    if (saved?.state?.route) this.state.route = saved.state.route;

    this.bindShell();
    this.render();
  },

  bindShell() {
    document.querySelectorAll('[data-route]').forEach((button) => {
      button.addEventListener('click', () => {
        this.state.route = button.dataset.route;
        this.persist();
        this.render();
      });
    });

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await UDT.AuthAPI.logout();
        location.replace('auth.html');
      });
    }
  },

  async persist() {
    await UDT.StateAPI.save({ route: this.state.route }).catch(() => {});
  },

  renderOverview() {
    const sub = this.state.subscription || { active: false };
    const expiry = sub.expires_at ? new Date(sub.expires_at).toLocaleString() : '—';
    return `
      <div class="grid grid-3">
        <section class="card metric">
          <h3>Account</h3>
          <strong>${this.escape(this.state.user.name)}</strong>
          <div class="muted small">${this.escape(this.state.user.email)}</div>
        </section>
        <section class="card metric">
          <h3>Subscription</h3>
          <strong>${sub.active ? 'Active' : 'Inactive'}</strong>
          <div class="muted small">Expires: ${this.escape(expiry)}</div>
        </section>
        <section class="card metric">
          <h3>Queued jobs</h3>
          <strong>${this.state.jobs.length}</strong>
          <div class="muted small">Protected workflows are server-side only.</div>
        </section>
      </div>
      <div class="grid grid-2" style="margin-top:16px;">
        <section class="card panel">
          <h2>Why this rewrite is safer</h2>
          <div class="list">
            <div class="list-item">No fallback secrets or default admin password.</div>
            <div class="list-item">No raw private keys stored in website localStorage.</div>
            <div class="list-item">Premium tool actions are queued through the backend.</div>
            <div class="list-item">Copied frontend code is not enough to run protected jobs.</div>
          </div>
        </section>
        <section class="card panel">
          <h2>Current security stance</h2>
          <p class="muted">This frontend is intentionally a thin client. Sensitive execution should live in a private server worker, not in browser JavaScript.</p>
          <hr class="sep">
          <div class="status-line"><span class="badge ${sub.active ? 'ok' : 'danger'}">${sub.active ? 'Subscription active' : 'Subscription inactive'}</span></div>
        </section>
      </div>
    `;
  },

  renderJobs() {
    const rows = this.state.jobs.map((job) => `
      <tr>
        <td>${this.escape(job.tool)}</td>
        <td>${this.escape(job.status)}</td>
        <td>${new Date(job.created_at).toLocaleString()}</td>
        <td><code>${this.escape(job.id)}</code></td>
      </tr>
    `).join('') || `<tr><td colspan="4" class="muted">No jobs yet.</td></tr>`;

    return `
      <section class="card panel">
        <h2>Protected tool jobs</h2>
        <p class="muted">Jobs are created server-side after auth and subscription checks. Real execution belongs in your private worker.</p>
        <table class="table">
          <thead><tr><th>Tool</th><th>Status</th><th>Created</th><th>ID</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
    `;
  },

  renderSettings() {
    return `
      <section class="card panel">
        <h2>Settings</h2>
        <div class="notice">Set <code>window.UDT_CONFIG.apiBase</code> before loading <code>api.js</code>, or edit the default in <code>api.js</code>.</div>
        <div class="code-block" style="margin-top:16px;">window.UDT_CONFIG = { apiBase: 'https://your-railway-app.up.railway.app/api' };</div>
      </section>
    `;
  },

  render() {
    document.querySelectorAll('[data-route]').forEach((button) => {
      button.classList.toggle('active', button.dataset.route === this.state.route);
    });

    const title = document.getElementById('view-title');
    const subtitle = document.getElementById('view-subtitle');
    const mount = document.getElementById('app-main');
    const map = {
      overview: ['Overview', 'Thin client dashboard with protected backend flows.'],
      wallets: ['Wallets', 'Watch-only addresses and optional encrypted vault storage.'],
      tracker: ['Tracker', 'Read-only wallet tracking UI.'],
      bundle: ['Bundle', 'Queue protected bundle jobs on the backend.'],
      split: ['Split', 'Queue protected split jobs on the backend.'],
      sniper: ['Sniper', 'Queue protected sniper jobs on the backend.'],
      volume: ['Volume', 'Queue protected volume jobs on the backend.'],
      jobs: ['Jobs', 'Review queued and completed protected jobs.'],
      settings: ['Settings', 'App configuration and deployment notes.'],
    };

    const [mainTitle, mainSubtitle] = map[this.state.route] || map.overview;
    title.textContent = mainTitle;
    subtitle.textContent = mainSubtitle;

    const mod = window.UdtModules[this.state.route];
    if (mod && typeof mod.render === 'function') {
      mount.innerHTML = mod.render(this.state, this);
      if (typeof mod.bind === 'function') mod.bind(this.state, this);
      return;
    }

    if (this.state.route === 'jobs') {
      mount.innerHTML = this.renderJobs();
      return;
    }

    if (this.state.route === 'settings') {
      mount.innerHTML = this.renderSettings();
      return;
    }

    mount.innerHTML = this.renderOverview();
  },

  escape(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  },
};

window.UDT_APP = App;
