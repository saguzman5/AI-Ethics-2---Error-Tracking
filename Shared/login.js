(function () {
  'use strict';
  const form = document.getElementById('form');
  const err = document.getElementById('err');
  const btn = document.getElementById('submit');

  // Only allow same-site relative redirects (prevents open redirects).
  function nextUrl(role) {
    const next = new URLSearchParams(location.search).get('next');
    if (next && /^\/(app|dashboard|spreadsheet)\//.test(next)) {
      if (role === 'worker' && !next.startsWith('/app/')) return '/app/';
      return next;
    }
    return role === 'manager' ? '/dashboard/' : '/app/';
  }

  document.getElementById('username').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) { err.textContent = 'Enter your username and password.'; return; }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const { user } = await PTS.api('/api/auth/login', { method: 'POST', body: { username, password } });
      location.href = nextUrl(user.role);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
})();
