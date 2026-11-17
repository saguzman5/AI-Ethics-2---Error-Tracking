/* Live spreadsheet view. Data comes from the central database through the
   API; this page never stores records of its own. */
(function () {
  'use strict';
  const { api, esc, sevBadge, statusBadge, fmt } = PTS;
  const $ = (id) => document.getElementById(id);

  // Required spreadsheet columns (exact names), then resolution columns.
  const COLS = [
    { key: 'error_id', label: 'error_ID', cls: 'mono' },
    { key: 'box_id', label: 'box_ID', cls: 'mono' },
    { key: 'order_id', label: 'order_ID', cls: 'mono' },
    { key: 'stage', label: 'stage', select: true },
    { key: 'error_type', label: 'error_type', select: true },
    { key: 'severity', label: 'severity', select: true, rank: { Low: 1, Medium: 2, High: 3, Critical: 4 } },
    { key: 'timestamp_local', label: 'timestamp', cls: 'ts', sortKey: 'timestamp' },
    { key: 'status', label: 'status', select: true, rank: { Open: 1, 'Under Review': 2, 'In Rework': 3, Resolved: 4 } },
    { key: 'photo_image', label: 'photo_image' },
    { key: 'description', label: 'description', cls: 'desc' },
    { key: 'requires_rework', label: 'requires_rework', select: true },
    { key: 'resolved_at_local', label: 'resolved_at', cls: 'ts', sortKey: 'resolved_at' },
  ];

  let filters;
  let rows = [];
  let colFilters = {};
  let sort = { key: 'timestamp', dir: 'desc' };
  let seen = new Map(); // error_id -> updated_at, to flash changed rows
  let first = true;

  const cellText = (r, c) => (c.key === 'requires_rework' ? (r.requires_rework ? 'Yes' : 'No') : c.key === 'photo_image' ? (r.photo_image ? 'View photo' : '') : String(r[c.key] ?? ''));

  async function load() {
    const q = filters.query();
    try {
      const res = await api(`/api/reports?${q}&sort=timestamp&dir=desc&limit=50000`);
      const changed = new Set();
      for (const r of res.rows) {
        if (!first && seen.get(r.error_id) !== r.updated_at) changed.add(r.error_id);
      }
      seen = new Map(res.rows.map((r) => [r.error_id, r.updated_at]));
      first = false;
      rows = res.rows;
      render(changed);
      $('exp-csv').dataset.q = q;
      $('exp-xlsx').dataset.q = q;
      $('status').textContent = `Synced with the central database at ${fmt(new Date().toISOString()).slice(11)} · updates automatically`;
    } catch (e) { PTS.toast(e.message, 'error'); }
  }

  function visibleRows() {
    let out = rows.filter((r) => COLS.every((c) => {
      const f = colFilters[c.key];
      if (!f) return true;
      const v = cellText(r, c);
      return c.select ? v === f : v.toLowerCase().includes(f.toLowerCase());
    }));
    const c = COLS.find((x) => (x.sortKey || x.key) === sort.key);
    const val = (r) => {
      if (c.rank) return c.rank[r[c.key]] || 0;
      if (c.sortKey) return r[c.sortKey] || '';
      return cellText(r, c).toLowerCase();
    };
    out = out.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      const d = x < y ? -1 : x > y ? 1 : a.error_id < b.error_id ? -1 : 1;
      return sort.dir === 'asc' ? d : -d;
    });
    return out;
  }

  function render(changed = new Set()) {
    const vis = visibleRows();
    $('count').textContent = `${vis.length} of ${rows.length} records`;
    const active = document.activeElement && document.activeElement.dataset.col;
    const uniq = (key) => [...new Set(rows.map((r) => cellText(r, COLS.find((c) => c.key === key))))].filter(Boolean).sort();
    const head = COLS.map((c) => `<th data-sort="${c.sortKey || c.key}">${c.label}${sort.key === (c.sortKey || c.key) ? `<span class="arrow">${sort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}</th>`).join('');
    const filt = COLS.map((c) => `<th>${c.select
      ? `<select data-col="${c.key}" aria-label="Filter ${c.label}"><option value="">All</option>${uniq(c.key).map((v) => `<option ${colFilters[c.key] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`
      : `<input data-col="${c.key}" value="${esc(colFilters[c.key] || '')}" placeholder="Filter…" aria-label="Filter ${c.label}">`}</th>`).join('');
    const body = vis.map((r, i) => `<tr class="${r.severity === 'Critical' ? 'critical' : ''} ${changed.has(r.error_id) ? 'flash' : ''}">
      <td class="rownum">${i + 1}</td>
      ${COLS.map((c) => {
        const v = r[c.key];
        if (c.key === 'error_id') return `<td class="mono"><button class="idlink" data-open="${esc(v)}">${esc(v)}</button></td>`;
        if (c.key === 'severity') return `<td class="sevcell">${sevBadge(v)}</td>`;
        if (c.key === 'status') return `<td>${statusBadge(v)}</td>`;
        if (c.key === 'photo_image') return `<td>${v ? `<a href="${esc(v)}" target="_blank" rel="noopener">View photo</a>` : '<span class="muted">–</span>'}</td>`;
        return `<td class="${c.cls || ''}">${esc(cellText(r, c))}</td>`;
      }).join('')}
    </tr>`).join('');
    $('grid').innerHTML = `<table class="grid"><thead><tr><th class="rownum">#</th>${head}</tr><tr class="filter-row"><th class="rownum"></th>${filt}</tr></thead><tbody>${body}</tbody></table>`;
    if (active) {
      const el = $('grid').querySelector(`[data-col="${active}"]`);
      if (el) { el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); }
    }
  }

  $('grid').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      sort = { key: th.dataset.sort, dir: sort.key === th.dataset.sort && sort.dir === 'desc' ? 'asc' : 'desc' };
      render();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) window.ReportPanel.open(open.dataset.open);
  });
  let t;
  $('grid').addEventListener('input', (e) => {
    const col = e.target.dataset.col;
    if (!col) return;
    colFilters[col] = e.target.value;
    clearTimeout(t);
    t = setTimeout(() => render(), e.target.tagName === 'SELECT' ? 0 : 200);
  });
  $('clear-col').addEventListener('click', () => { colFilters = {}; render(); });

  (async function init() {
    const me = await PTS.session({ manager: true });
    PTS.topbar('spreadsheet', me);
    const [pub, adm] = await Promise.all([api('/api/lists'), api('/api/admin/lists')]);
    const lists = { stages: adm.stages, categories: adm.categories, severities: pub.severities, statuses: pub.statuses };
    window.ReportPanel.init(lists, () => load());
    filters = PTS.Filters.mount($('filters'), lists, load);
    await load();
    PTS.live((evt) => { load(); window.ReportPanel.refreshIfOpen(evt.error_id); }, $('live'));
  })().catch((e) => { if (e.status !== 401) PTS.toast(e.message, 'error'); });
})();
