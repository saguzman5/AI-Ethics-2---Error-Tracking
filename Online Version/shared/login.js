(function () {
  'use strict';
  const form = document.getElementById('form');
  const err = document.getElementById('err');
  const btn = document.getElementById('submit');

  if (PTS.cfg.LOGIN_EMAIL_DOMAIN) document.getElementById('user-label').textContent = 'Username or email';

  // Only same-site relative destinations are allowed (no open redirects).
  function nextPage(role) {
    const next = new URLSearchParams(location.search).get('next') || '';
    if (/^(app|dashboard|spreadsheet)\/[^:]*$/.test(next) && !next.includes('//')) {
      if (role !== 'manager' && !next.startsWith('app/')) return 'app/';
      return next;
    }
    return role === 'manager' ? 'dashboard/' : 'app/';
  }

  if (!PTS.configured()) {
    const box = document.getElementById('setup');
    box.hidden = false;
    box.innerHTML = '<b>Setup not finished.</b> Open <code>config.js</code> and paste your Supabase project URL and publishable key. See Documentation/ONLINE_SETUP.md, step 4.';
    form.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
    return;
  }

  // Already signed in? Go straight to the right page.
  PTS.sb().auth.getSession().then(async ({ data }) => {
    if (!data.session) return;
    try { const me = await PTS.api('/api/auth/me'); PTS.go(nextPage(me.user.role)); } catch (e) { err.textContent = e.message; }
  }).catch(() => {});

  document.getElementById('username').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) { err.textContent = 'Enter your login and password.'; return; }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const { user } = await PTS.api('/api/auth/login', { method: 'POST', body: { username, password } });
      PTS.go(nextPage(user.role));
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
})();
