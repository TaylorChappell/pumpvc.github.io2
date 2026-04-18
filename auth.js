'use strict';

window.AuthPage = {
  async boot() {
    const user = await UDT.AuthAPI.restore();
    if (user && location.pathname.endsWith('/auth.html')) {
      location.replace('dashboard.html');
      return;
    }

    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const message = document.getElementById('auth-message');

    const setMessage = (text, type = 'info') => {
      if (!message) return;
      message.textContent = text;
      message.className = `notice ${type === 'error' ? 'badge danger' : ''}`;
    };

    if (loginForm) {
      loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(loginForm);
        try {
          await UDT.AuthAPI.login({
            email: String(form.get('email') || ''),
            password: String(form.get('password') || ''),
          });
          location.replace('dashboard.html');
        } catch (error) {
          setMessage(error.message, 'error');
        }
      });
    }

    if (registerForm) {
      registerForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(registerForm);
        try {
          await UDT.AuthAPI.register({
            name: String(form.get('name') || ''),
            email: String(form.get('email') || ''),
            password: String(form.get('password') || ''),
          });
          location.replace('dashboard.html');
        } catch (error) {
          setMessage(error.message, 'error');
        }
      });
    }
  }
};
