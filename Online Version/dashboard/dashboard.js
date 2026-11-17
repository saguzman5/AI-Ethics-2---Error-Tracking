/* Management dashboard: KPIs, charts, resolution tracking and report table.
   Every number comes from /api/metrics and /api/reports (the database). */
(function () {
  'use strict';
  const { api, esc, sevBadge, statusBadge, pct, hours, fmt, SEVERITY_COLORS, STATUS_COLORS } = PTS;
  const $ = (id) => document.getElementById(id);
  const TABLE_LIMIT = 1000;

  let filters;
  let lists;
  let sort = { col: 'timestamp', dir: 'desc' };
  let lastMetrics = null;
  let loading = false;
  let pending = false;

  const COLS = [
    ['error_id', 'Error ID'], ['box_id', 'Box ID'], ['order_id', 'Order ID'], ['stage', 'Stage'],
    ['error_type', 'Error type'], ['severity', 'Severity'], ['timestamp', 'Timestamp'], ['status', 'Status'],
  ];

  function idFor(listName, name) {
    const item = lists[listName].find((x) => x.name === name);
    return item ? item.id : null;
  }

  async function load() {
    if (loading) { pending = true; return; }
    loading = true;
    const q = filters.query();
    try {
      const [m, rep] = await Promise.all([
        api(`/api/metrics?${q}`),
        api(`/api/reports?${q}&sort=${sort.col}&dir=${sort.dir}&limit=${TABLE_LIMIT}`),
      ]);
      lastMetrics = m;
      renderKpis(m);
      renderCharts(m);
      renderResolution(m);
      renderTable(rep);
      $('exp-csv').dataset.q = `${q}&sort=${sort.col}&dir=${sort.dir}`;
      $('exp-xlsx').dataset.q = `${q}&sort=${sort.col}&dir=${sort.dir}`;
      $('to-sheet').href = `../spreadsheet/${location.hash}`;
      $('updated').textContent = `Live from the central database · updated ${fmt(new Date().toISOString()).slice(11)}`;
    } catch (e) {
      PTS.toast(e.message, 'error');
    } finally {
      loading = false;
      if (pending) { pending = false; load(); }
    }
  }

  function renderKpis(m) {
    const k = m.kpis;
    const p = m.products;
    $('k-total').textContent = k.total_errors;
    $('k-total-s').textContent = `on ${p.affected_products} affected product${p.affected_products === 1 ? '' : 's'}`;
    $('k-unres').textContent = k.unresolved_errors;
    $('k-unres-s').textContent = `Open + Under Review + In Rework`;
    $('k-hc').textContent = k.high_critical_errors;
    $('k-hc-s').textContent = `${k.critical_errors} critical · ${k.high_critical_errors - k.critical_errors} high`;
    $('k-rr').textContent = pct(k.rework_rate);
    $('k-rr-s').textContent = `${p.rework_products} of ${p.products_in_scope} products needed rework`;
    $('k-res').textContent = k.resolved_errors;
    $('k-res-s').textContent = `${pct(m.rates.resolution_rate, 0)} of reported errors`;
  }

  function renderCharts(m) {
    Charts.line($('c-time'), m.errors_over_time);
    Charts.vbar($('c-sev'), Object.entries(m.severity_counts).map(([name, count]) => ({ name, count, color: SEVERITY_COLORS[name] })),
      { onClick: (key) => filters.set('severity', filters.values().severity === key ? '' : key) });
    Charts.hbar($('c-stage'), m.by_stage.map((s) => ({ ...s, key: idFor('stages', s.name), color: '#1d4ed8' })),
      { onClick: (key) => filters.set('stage_id', filters.values().stage_id === key ? '' : key) });
    Charts.donut($('c-type'), m.by_type.slice(0, 8).concat(m.by_type.length > 8
      ? [{ name: 'Other types', count: m.by_type.slice(8).reduce((a, b) => a + b.count, 0), key: '' }] : [])
      .map((t) => ({ ...t, key: t.key === '' ? '' : idFor('categories', t.name) })),
    { onClick: (key) => key && filters.set('category_id', filters.values().category_id === key ? '' : key) });
    $('c-top').innerHTML = m.top_issues.length ? `<ol class="ranked">${m.top_issues.map((t) => `
      <li><div><div class="t">${esc(t.error_type)}</div><div class="m">at ${esc(t.stage)}${t.critical_high ? ` · ${t.critical_high} high/critical` : ''} · last ${esc(t.last_local.slice(0, 10))}</div></div>
      <div class="n">${t.count}<small>${(t.share * 100).toFixed(0)}%</small></div></li>`).join('')}</ol>` : '<div class="empty">No data for the selected filters</div>';
  }

  function renderResolution(m) {
    const total = m.kpis.total_errors;
    $('pipeline').innerHTML = Object.entries(m.status_counts).map(([s, n]) => `
      <button class="stage-tile" type="button" data-status="${esc(s)}">
        <span class="k">${esc(s)}</span><span class="v">${n}</span><span class="s">${total ? ((n / total) * 100).toFixed(0) : 0}% of errors</span>
      </button>`).join('');
    $('pipeline').querySelectorAll('.stage-tile').forEach((b) => {
      b.style.background = STATUS_COLORS[b.dataset.status];
      b.addEventListener('click', () => filters.set('status', filters.values().status === b.dataset.status ? '' : b.dataset.status));
    });
    const p = m.products;
    $('r-rr').textContent = pct(m.rates.rework_rate);
    $('r-rr-s').textContent = `products requiring rework ÷ products produced (${p.rework_products} ÷ ${p.products_in_scope})`;
    $('r-avg').textContent = hours(m.resolution.avg_resolution_hours);
    $('r-avg-s').textContent = m.resolution.resolved_count
      ? `mean time from report to resolution, ${m.resolution.resolved_count} resolved · median ${hours(m.resolution.median_resolution_hours)}`
      : 'no resolved errors in this selection';
    $('r-resrate').textContent = pct(m.rates.resolution_rate);

    const maxv = Math.max(p.products_in_scope, total, 1);
    const row = (label, value, color, note) => `
      <div class="row"><span>${label}</span><b>${value}</b><div class="bar"><span data-w="${(value / maxv) * 100}" data-c="${color}"></span></div></div>
      ${note ? `<div class="note">${note}</div>` : ''}`;
    $('funnel').innerHTML =
      row('Products produced (in scope)', p.products_in_scope, '#94a3b8', 'Boxes registered with a production date in the selected period / order / box filter.') +
      row('Reported errors', total, '#1d4ed8', `One product can have several errors: ${p.affected_products ? (total / p.affected_products).toFixed(2) : '0'} errors per affected product.`) +
      row('Affected products (at least 1 error)', p.affected_products, '#d97706', `Product error rate ${pct(m.rates.product_error_rate)} of products produced.`) +
      row('Products requiring rework', p.rework_products, '#0d9488', `${p.errors_requiring_rework} errors required rework (${pct(m.rates.rework_share_of_errors)} of errors).`);
    $('funnel').querySelectorAll('.bar span').forEach((s) => { s.style.width = `${s.dataset.w}%`; s.style.background = s.dataset.c; });
  }

  function renderTable(rep) {
    $('t-count').textContent = rep.total > rep.rows.length
      ? `showing ${rep.rows.length} of ${rep.total} – narrow the filters or export for the full list`
      : `${rep.total} report${rep.total === 1 ? '' : 's'}`;
    if (!rep.rows.length) { $('table').innerHTML = '<div class="empty">No error reports match the selected filters.</div>'; return; }
    const selected = window.ReportPanel.currentId();
    const head = COLS.map(([k, label]) => `<th class="sortable" data-col="${k}">${label}${sort.col === k ? `<span class="arrow">${sort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}</th>`).join('');
    const body = rep.rows.map((r) => `
      <tr class="clickable ${r.severity === 'Critical' ? 'critical' : ''} ${r.error_id === selected ? 'selected' : ''}" data-id="${esc(r.error_id)}" tabindex="0">
        <td class="mono nowrap">${esc(r.error_id)}${r.photo_image ? ' <span class="photo-ico" title="Has photo"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 7h3l2-2h6l2 2h3v12H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg></span>' : ''}</td>
        <td class="mono nowrap">${esc(r.box_id)}</td>
        <td class="mono nowrap">${esc(r.order_id)}</td>
        <td>${esc(r.stage)}</td>
        <td>${esc(r.error_type)}</td>
        <td>${sevBadge(r.severity)}</td>
        <td class="nowrap">${esc(r.timestamp_local)}</td>
        <td>${statusBadge(r.status)}</td>
      </tr>`).join('');
    $('table').innerHTML = `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  $('table').addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (th) {
      const col = th.dataset.col;
      sort = { col, dir: sort.col === col && sort.dir === 'desc' ? 'asc' : 'desc' };
      load();
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) {
      $('table').querySelectorAll('tr.selected').forEach((x) => x.classList.remove('selected'));
      tr.classList.add('selected');
      window.ReportPanel.open(tr.dataset.id);
    }
  });
  $('table').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('tr[data-id]')) window.ReportPanel.open(e.target.dataset.id);
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => lastMetrics && Charts.line($('c-time'), lastMetrics.errors_over_time), 200);
  });

  async function loadLists() {
    const [pub, adm] = await Promise.all([api('/api/lists'), api('/api/admin/lists')]);
    return { stages: adm.stages, categories: adm.categories, severities: pub.severities, statuses: pub.statuses };
  }

  (async function init() {
    const me = await PTS.session({ manager: true });
    PTS.topbar('dashboard', me);
    $('tz').textContent = me.timezone;
    lists = await loadLists();
    window.ReportPanel.init(lists, () => load());
    filters = PTS.Filters.mount($('filters'), lists, load);
    await load();
    const deep = new URLSearchParams(location.search).get('report');
    if (deep) window.ReportPanel.open(deep);
    PTS.live(async (evt) => {
      if (evt.action === 'lists') { lists = await loadLists(); window.ReportPanel.setLists(lists); }
      load();
      window.ReportPanel.refreshIfOpen(evt.error_id);
      if (evt.action === 'created') PTS.toast(`New error report ${evt.error_id}`);
    }, $('live'));
  })().catch((e) => { if (e.status !== 401) PTS.toast(e.message, 'error'); });
})();
