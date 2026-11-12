/* Lightweight SVG charts (no external libraries). */
(function () {
  'use strict';
  const { esc } = PTS;
  const NS = 'http://www.w3.org/2000/svg';
  const PALETTE = ['#1d4ed8', '#0d9488', '#9333ea', '#ea580c', '#0284c7', '#ca8a04', '#db2777', '#4f46e5', '#16a34a', '#64748b', '#b91c1c', '#7c3aed'];

  const niceMax = (v) => {
    if (v <= 5) return 5;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  };

  function empty(el, text = 'No data for the selected filters') {
    el.innerHTML = `<div class="empty">${esc(text)}</div>`;
  }

  function line(el, points) {
    if (!points.length || points.every((p) => p.count === 0)) return empty(el);
    const W = Math.max(el.clientWidth, 320), H = 240, L = 36, R = 12, T = 12, B = 30;
    const max = niceMax(Math.max(...points.map((p) => p.count)));
    const x = (i) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
    const y = (v) => T + (H - T - B) * (1 - v / max);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Errors over time">`;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e2e8f0"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#64748b">${Math.round(v)}</text>`;
    }
    const every = Math.max(1, Math.ceil(points.length / Math.floor((W - L - R) / 70)));
    points.forEach((p, i) => {
      if (i % every === 0 || i === points.length - 1) {
        s += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#64748b">${esc(p.date.slice(5))}</text>`;
      }
    });
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join('');
    s += `<path d="${path}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z" fill="rgba(29,78,216,.10)"/>`;
    s += `<path d="${path}" fill="none" stroke="#1d4ed8" stroke-width="2.5" stroke-linejoin="round"/>`;
    points.forEach((p, i) => {
      s += `<circle cx="${x(i)}" cy="${y(p.count)}" r="${points.length > 60 ? 2 : 3.5}" fill="#fff" stroke="#1d4ed8" stroke-width="2"><title>${esc(p.date)}: ${p.count} error${p.count === 1 ? '' : 's'}</title></circle>`;
    });
    el.innerHTML = s + '</svg>';
  }

  // Horizontal bars; items: [{ name, count, color, key }]
  function hbar(el, items, { onClick, max: limit = 12 } = {}) {
    if (!items.length) return empty(el);
    const shown = items.slice(0, limit);
    const max = Math.max(...shown.map((i) => i.count));
    el.innerHTML = `<div class="hbars">${shown.map((i, n) => `
      <button class="hbar" type="button" data-key="${esc(i.key ?? i.name)}" title="${esc(i.name)}: ${i.count}">
        <span class="hbar-label">${esc(i.name)}</span>
        <span class="hbar-track"><span class="hbar-fill" data-w="${(i.count / max) * 100}" data-c="${i.color || PALETTE[n % PALETTE.length]}"></span></span>
        <span class="hbar-val">${i.count}</span>
      </button>`).join('')}</div>`;
    el.querySelectorAll('.hbar-fill').forEach((f) => { f.style.width = `${f.dataset.w}%`; f.style.background = f.dataset.c; });
    if (onClick) el.querySelectorAll('.hbar').forEach((b) => b.addEventListener('click', () => onClick(b.dataset.key)));
    else el.querySelectorAll('.hbar').forEach((b) => { b.disabled = true; });
  }

  function donut(el, items, { onClick } = {}) {
    const total = items.reduce((a, i) => a + i.count, 0);
    if (!total) return empty(el);
    const R = 80, r = 50, C = 100;
    let a0 = -Math.PI / 2;
    let s = `<svg viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Errors by type">`;
    items.forEach((it, n) => {
      const color = it.color || PALETTE[n % PALETTE.length];
      it._color = color;
      const frac = it.count / total;
      if (frac >= 0.9999) {
        s += `<circle cx="${C}" cy="${C}" r="${(R + r) / 2}" fill="none" stroke="${color}" stroke-width="${R - r}"><title>${esc(it.name)}: ${it.count}</title></circle>`;
        return;
      }
      const a1 = a0 + frac * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (ang, rad) => `${(C + rad * Math.cos(ang)).toFixed(2)},${(C + rad * Math.sin(ang)).toFixed(2)}`;
      s += `<path class="slice" data-key="${esc(it.key ?? it.name)}" d="M${p(a0, R)}A${R},${R} 0 ${large} 1 ${p(a1, R)}L${p(a1, r)}A${r},${r} 0 ${large} 0 ${p(a0, r)}Z" fill="${color}" stroke="#fff" stroke-width="1.5"><title>${esc(it.name)}: ${it.count} (${((it.count / total) * 100).toFixed(1)}%)</title></path>`;
      a0 = a1;
    });
    s += `<text x="100" y="98" text-anchor="middle" font-size="26" font-weight="700" fill="#0f172a">${total}</text><text x="100" y="118" text-anchor="middle" font-size="11" fill="#64748b">errors</text></svg>`;
    const legend = items.map((it) => `<li data-key="${esc(it.key ?? it.name)}"><i data-c="${it._color}"></i><span>${esc(it.name)}</span><b>${it.count}</b><em>${((it.count / total) * 100).toFixed(0)}%</em></li>`).join('');
    el.innerHTML = `<div class="donut">${s}<ul class="legend">${legend}</ul></div>`;
    el.querySelectorAll('.legend i').forEach((i) => { i.style.background = i.dataset.c; });
    if (onClick) el.querySelectorAll('[data-key]').forEach((n) => { n.style.cursor = 'pointer'; n.addEventListener('click', () => onClick(n.dataset.key)); });
  }

  // Vertical bars with fixed categories (e.g. severity)
  function vbar(el, items, { onClick } = {}) {
    const total = items.reduce((a, i) => a + i.count, 0);
    if (!total) return empty(el);
    const max = niceMax(Math.max(...items.map((i) => i.count)));
    el.innerHTML = `<div class="vbars">${items.map((i) => `
      <button type="button" class="vbar" data-key="${esc(i.key ?? i.name)}" title="${esc(i.name)}: ${i.count}">
        <span class="vbar-val">${i.count}</span>
        <span class="vbar-col"><span class="vbar-fill" data-h="${(i.count / max) * 100}" data-c="${i.color}"></span></span>
        <span class="vbar-label">${esc(i.name)}</span>
        <span class="vbar-pct">${((i.count / total) * 100).toFixed(0)}%</span>
      </button>`).join('')}</div>`;
    el.querySelectorAll('.vbar-fill').forEach((f) => { f.style.height = `${f.dataset.h}%`; f.style.background = f.dataset.c; });
    if (onClick) el.querySelectorAll('.vbar').forEach((b) => b.addEventListener('click', () => onClick(b.dataset.key)));
  }

  window.Charts = { line, hbar, donut, vbar, empty };
})();
