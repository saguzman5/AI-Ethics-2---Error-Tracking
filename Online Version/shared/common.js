/* Shared browser helpers for the online version. Exposes window.PTS. */
(function () {
  'use strict';

  // Site root, e.g. https://name.github.io/repo/ (this file is in shared/).
  const ROOT = new URL('../', document.currentScript.src).href;
  const cfg = window.PTS_CONFIG || {};

  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.error) || `Request failed (${status})`);
      this.status = status;
      this.body = body || {};
    }
  }

  function configured() {
    return !!(cfg.SUPABASE_URL && cfg.SUPABASE_KEY && /^https:\/\//.test(cfg.SUPABASE_URL) && !/PASTE-/.test(cfg.SUPABASE_KEY));
  }

  let client = null;
  function sb() {
    if (client) return client;
    if (!configured()) throw new ApiError(0, { error: 'The app is not set up yet: fill in config.js with your Supabase project URL and key (see Documentation/ONLINE_SETUP.md, step 4).' });
    if (!window.supabase || !window.supabase.createClient) throw new ApiError(0, { error: 'Could not load the online database library. Check the internet connection and reload the page.' });
    client = window.supabase.createClient(cfg.SUPABASE_URL.replace(/\/+$/, ''), cfg.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    return client;
  }

  const go = (rel) => { location.href = ROOT + rel; };
  const here = () => (location.href.startsWith(ROOT) ? location.href.slice(ROOT.length) : '');
  function toLogin() { go(`?next=${encodeURIComponent(here())}`); }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cls = (s) => String(s).replace(/\s+/g, '-');
  const sevBadge = (s) => `<span class="badge sev-${cls(s)}">${esc(s)}</span>`;
  const statusBadge = (s) => `<span class="badge st-${cls(s)}">${esc(s)}</span>`;
  const SEVERITY_COLORS = { Low: '#0284c7', Medium: '#d97706', High: '#ea580c', Critical: '#dc2626' };
  const STATUS_COLORS = { Open: '#4f46e5', 'Under Review': '#9333ea', 'In Rework': '#0d9488', Resolved: '#16a34a' };

  function toast(message, kind = '') {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.setAttribute('role', 'status');
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
  }

  // ------------------------------------------------------------- time zone
  let TZ = 'UTC';
  const fmtCache = new Map();
  function parts(ms, tz) {
    if (!fmtCache.has(tz)) {
      fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    }
    const p = {};
    fmtCache.get(tz).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    return p;
  }
  function setTimeZone(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); TZ = tz || 'UTC'; } catch { TZ = 'UTC'; }
  }
  function fmt(iso) {
    if (!iso) return '';
    const p = parts(typeof iso === 'number' ? iso : Date.parse(iso), TZ);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  const dateKey = (iso) => fmt(iso).slice(0, 10);
  const todayLocal = (offsetDays = 0) => fmt(Date.now() + offsetDays * 86400000).slice(0, 10);
  function tzOffset(ms) {
    const p = parts(ms, TZ);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  }
  function localMidnightUtc(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return null;
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    let ms = guess - tzOffset(guess);
    ms = guess - tzOffset(ms);
    return new Date(ms).toISOString();
  }
  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const excelSerial = (iso) => { const ms = Date.parse(iso); return (ms + tzOffset(ms)) / 86400000 + 25569; };

  function hours(h) {
    if (h === null || h === undefined) return '–';
    if (h < 1) return `${Math.round(h * 60)} min`;
    if (h < 48) return `${h.toFixed(1)} h`;
    return `${(h / 24).toFixed(1)} days`;
  }
  const pct = (x, digits = 1) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(digits)}%`);

  // ------------------------------------------------------------- session
  async function api(path, opts = {}) {
    if (!window.PTS_BACKEND) throw new ApiError(0, { error: 'backend.js not loaded' });
    return window.PTS_BACKEND.handle(path, opts);
  }

  let me = null;
  async function session({ manager = false } = {}) {
    me = await api('/api/auth/me');
    setTimeZone(me.timezone);
    if (manager && me.user.role !== 'manager') { go('app/'); throw new ApiError(403, { error: 'Manager access required' }); }
    return me;
  }

  async function logout() {
    try { await sb().auth.signOut(); } catch { /* ignore */ }
    go('');
  }

  // Live updates: Supabase Realtime, plus a light check every 30 seconds
  // in case the realtime connection drops.
  function live(onChange, indicator) {
    let timer;
    const fire = (evt) => { clearTimeout(timer); timer = setTimeout(() => onChange(evt), 300); };
    try {
      sb().channel('pts-error-reports')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'error_reports' }, (payload) => {
          const row = payload.new || {};
          fire({ error_id: row.error_id, action: payload.eventType === 'INSERT' ? 'created' : 'status' });
        })
        .subscribe((status) => { if (indicator) indicator.classList.toggle('on', status === 'SUBSCRIBED'); });
    } catch { /* polling below still works */ }
    let last = null;
    setInterval(async () => {
      try {
        const marker = await window.PTS_BACKEND.changeMarker();
        if (last !== null && marker !== last) fire({ action: 'poll' });
        last = marker;
      } catch { /* offline; try again later */ }
    }, 30000);
  }

  function topbar(active, info) {
    const el = document.querySelector('header.topbar');
    if (!el) return;
    const links = [['dashboard', 'dashboard/', 'Dashboard'], ['spreadsheet', 'spreadsheet/', 'Spreadsheet'], ['admin', 'dashboard/admin.html', 'Admin'], ['app', 'app/', 'Worker App']];
    el.innerHTML = `
      <div class="brand"><img src="${ROOT}shared/logo.svg" alt="">Production Quality</div>
      <nav>${links.map(([k, href, label]) => `<a href="${ROOT}${href}" class="${k === active ? 'active' : ''}">${label}</a>`).join('')}</nav>
      <div class="spacer"></div>
      <span class="live" id="live">Live</span>
      <span class="who">${esc(info.user.full_name)} · ${esc(info.user.role)}</span>
      <button class="link" id="logout">Sign out</button>`;
    el.querySelector('#logout').addEventListener('click', logout);
  }

  // Export buttons: <a data-export="csv|xlsx" data-q="filters">
  document.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-export]');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.busy) return;
    a.dataset.busy = '1';
    const label = a.textContent;
    a.textContent = 'Preparing…';
    try { await window.PTS_BACKEND.exportReports(a.dataset.export, a.dataset.q || ''); }
    catch (ex) { toast(ex.message, 'error'); }
    finally { a.textContent = label; delete a.dataset.busy; }
  });

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const labelUrl = (box, order) => `${ROOT}app/?box=${encodeURIComponent(box)}&order=${encodeURIComponent(order)}`;

  window.PTS = Object.assign(window.PTS || {}, {
    ROOT, cfg, configured, sb, go, here, toLogin, api, ApiError, esc, sevBadge, statusBadge, toast,
    fmt, dateKey, todayLocal, localMidnightUtc, addDays, excelSerial, setTimeZone, tz: () => TZ,
    hours, pct, session, me: () => me, logout, live, topbar, download, labelUrl, SEVERITY_COLORS, STATUS_COLORS,
  });
})();
