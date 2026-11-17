/* Filter bar shared by the dashboard and the spreadsheet. Filter state is
   kept in the URL hash so views can be bookmarked and shared. */
(function () {
  'use strict';
  const { esc, todayLocal } = PTS;
  const KEYS = ['from', 'to', 'stage_id', 'category_id', 'severity', 'status', 'order_id', 'box_id'];

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const out = {};
    for (const k of KEYS) if (p.get(k)) out[k] = p.get(k);
    return out;
  }

  function mount(container, lists, onChange) {
    let values = readHash();
    const opt = (items, sel, label) => `<option value="">${label}</option>` +
      items.map((i) => {
        const v = typeof i === 'object' ? String(i.id) : i;
        const n = typeof i === 'object' ? i.name + (i.active === 0 ? ' (inactive)' : '') : i;
        return `<option value="${esc(v)}" ${String(sel || '') === v ? 'selected' : ''}>${esc(n)}</option>`;
      }).join('');

    container.innerHTML = `
      <div class="filters">
        <label class="field">Period
          <select class="input" data-k="range">
            <option value="">Custom</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option><option value="all">All time</option>
          </select></label>
        <label class="field">From<input class="input" type="date" data-k="from"></label>
        <label class="field">To<input class="input" type="date" data-k="to"></label>
        <label class="field">Stage<select class="input" data-k="stage_id">${opt(lists.stages, values.stage_id, 'All stages')}</select></label>
        <label class="field">Error type<select class="input" data-k="category_id">${opt(lists.categories, values.category_id, 'All types')}</select></label>
        <label class="field">Severity<select class="input" data-k="severity">${opt(lists.severities, values.severity, 'All')}</select></label>
        <label class="field">Status<select class="input" data-k="status">${opt(lists.statuses, values.status, 'All')}</select></label>
        <label class="field">Order ID<input class="input" data-k="order_id" placeholder="Any" spellcheck="false"></label>
        <label class="field">Box ID<input class="input" data-k="box_id" placeholder="Any" spellcheck="false"></label>
        <button class="btn" type="button" data-k="reset">Reset</button>
      </div>`;

    const el = (k) => container.querySelector(`[data-k="${k}"]`);
    const sync = () => {
      for (const k of KEYS) el(k).value = values[k] || '';
      el('range').value = !values.from && !values.to ? 'all' : '';
    };
    sync();

    const emit = () => {
      const p = new URLSearchParams();
      for (const k of KEYS) if (values[k]) p.set(k, values[k]);
      history.replaceState(null, '', `${location.pathname}${location.search}${p.toString() ? '#' + p : ''}`);
      onChange(api);
    };

    let typing;
    container.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (!KEYS.includes(k)) return;
      values[k] = e.target.value.trim();
      if (k === 'from' || k === 'to') el('range').value = '';
      clearTimeout(typing);
      typing = setTimeout(emit, e.target.tagName === 'INPUT' && e.target.type !== 'date' ? 350 : 0);
    });
    el('range').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v === 'all') { delete values.from; delete values.to; }
      else if (v) { values.from = todayLocal(-(Number(v) - 1)); values.to = todayLocal(0); }
      sync();
      el('range').value = v;
      emit();
    });
    el('reset').addEventListener('click', () => { values = {}; sync(); emit(); });

    const api = {
      values: () => ({ ...values }),
      query: () => {
        const p = new URLSearchParams();
        for (const k of KEYS) if (values[k]) p.set(k, values[k]);
        return p.toString();
      },
      set(k, v) { if (v) values[k] = String(v); else delete values[k]; sync(); emit(); },
      hash: () => location.hash,
    };
    return api;
  }

  window.PTS.Filters = { mount };
})();
