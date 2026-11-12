/* Shared browser helpers used by every page. Exposes window.PTS. */
(function () {
  'use strict';

  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.error) || `Request failed (${status})`);
      this.status = status;
      this.body = body || {};
    }
  }

  async function api(path, { method = 'GET', body, timeout = 30000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new ApiError(0, { error: err.name === 'AbortError' ? 'The server took too long to respond. Check your connection and try again.' : 'Cannot reach the server. Check your Wi-Fi or network connection.' });
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (res.status === 401 && !path.startsWith('/api/auth/login')) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      throw new ApiError(401, data);
    }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

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

  // Formats an ISO timestamp as "YYYY-MM-DD HH:mm:ss" in the factory time zone.
  let TZ = 'UTC';
  function setTimeZone(tz) { TZ = tz || 'UTC'; }
  function fmt(iso) {
    if (!iso) return '';
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(iso)).forEach((x) => { p[x.type] = x.value; });
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  function todayLocal(offsetDays = 0) { return fmt(new Date(Date.now() + offsetDays * 86400000).toISOString()).slice(0, 10); }

  function hours(h) {
    if (h === null || h === undefined) return '–';
    if (h < 1) return `${Math.round(h * 60)} min`;
    if (h < 48) return `${h.toFixed(1)} h`;
    return `${(h / 24).toFixed(1)} days`;
  }
  const pct = (x, digits = 1) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(digits)}%`);

  async function session() {
    const me = await api('/api/auth/me');
    setTimeZone(me.timezone);
    return me;
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.href = '/login'; }
  }

  // Live updates via Server-Sent Events, with automatic reconnect.
  function live(onChange, indicator) {
    let es;
    let timer;
    const connect = () => {
      es = new EventSource('/api/events');
      es.onopen = () => indicator && indicator.classList.add('on');
      es.addEventListener('reports-changed', (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => onChange(JSON.parse(e.data)), 250); // coalesce bursts
      });
      es.addEventListener('lists-changed', (e) => onChange({ ...JSON.parse(e.data), action: 'lists' }));
      es.onerror = () => indicator && indicator.classList.remove('on');
    };
    connect();
    return () => es && es.close();
  }

  // Renders the shared top navigation bar for manager pages.
  function topbar(active, me) {
    const el = document.querySelector('header.topbar');
    if (!el) return;
    const links = [['dashboard', '/dashboard/', 'Dashboard'], ['spreadsheet', '/spreadsheet/', 'Spreadsheet'], ['admin', '/dashboard/admin.html', 'Admin'], ['app', '/app/', 'Worker App']];
    el.innerHTML = `
      <div class="brand"><img src="/shared/logo.svg" alt="">Production Quality</div>
      <nav>${links.map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`).join('')}</nav>
      <div class="spacer"></div>
      <span class="live" id="live">Live</span>
      <span class="who">${esc(me.user.full_name)} · ${esc(me.user.role)}</span>
      <button class="link" id="logout">Sign out</button>`;
    el.querySelector('#logout').addEventListener('click', logout);
  }

  window.PTS = { api, ApiError, esc, sevBadge, statusBadge, toast, fmt, todayLocal, hours, pct, session, logout, live, topbar, SEVERITY_COLORS, STATUS_COLORS };
})();
