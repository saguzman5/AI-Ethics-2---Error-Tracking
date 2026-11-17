/* Slide-in panel showing one error report with photo, history and the
   manager actions (status update, resolution notes, corrections). */
(function () {
  'use strict';
  const { api, esc, sevBadge, statusBadge, toast } = PTS;

  let lists = null;
  let current = null;
  let onSaved = () => {};

  function ensureDom() {
    if (document.getElementById('panel')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="panel-backdrop" id="panel-backdrop" hidden></div>
      <aside class="panel" id="panel" aria-hidden="true" aria-labelledby="panel-title" role="dialog">
        <div class="panel-head">
          <h2 id="panel-title">Error report</h2>
          <button class="btn sm" id="panel-close" aria-label="Close">Close</button>
        </div>
        <div class="panel-body" id="panel-body"></div>
      </aside>`;
    document.body.append(...wrap.children);
    document.getElementById('panel-close').addEventListener('click', close);
    document.getElementById('panel-backdrop').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  function close() {
    const p = document.getElementById('panel');
    if (!p) return;
    p.classList.remove('open');
    p.setAttribute('aria-hidden', 'true');
    document.getElementById('panel-backdrop').hidden = true;
    current = null;
    document.dispatchEvent(new CustomEvent('panel-closed'));
  }

  async function open(errorId) {
    ensureDom();
    const p = document.getElementById('panel');
    p.classList.add('open');
    p.setAttribute('aria-hidden', 'false');
    document.getElementById('panel-backdrop').hidden = false;
    document.getElementById('panel-title').textContent = errorId;
    document.getElementById('panel-body').innerHTML = '<div class="empty">Loading…</div>';
    try {
      current = await api(`/api/reports/${encodeURIComponent(errorId)}`);
      render();
    } catch (e) {
      document.getElementById('panel-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  async function refreshIfOpen(errorId) {
    if (current && (!errorId || errorId === current.error_id)) {
      const editing = document.activeElement && document.getElementById('panel').contains(document.activeElement) && /TEXTAREA|SELECT|INPUT/.test(document.activeElement.tagName);
      if (editing) return; // do not wipe a note the manager is typing
      try { current = await api(`/api/reports/${encodeURIComponent(current.error_id)}`); render(); } catch { /* ignore */ }
    }
  }

  function render() {
    const r = current;
    const statusOpts = lists.statuses.map((s) => `<option ${s === r.status ? 'selected' : ''}>${esc(s)}</option>`).join('');
    const opt = (items, sel) => items.map((i) => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)}${i.active === 0 ? ' (inactive)' : ''}</option>`).join('');
    const history = r.history.map((h) => `
      <li>
        <div class="tl-dot st-${esc(h.to_status.replace(/\s+/g, '-'))}"></div>
        <div class="tl-body">
          <div>${h.from_status ? `${statusBadge(h.from_status)} &rarr; ` : ''}${statusBadge(h.to_status)}</div>
          ${h.note ? `<div class="tl-note">${esc(h.note)}</div>` : ''}
          <div class="tl-meta">${esc(h.changed_at_local)} · ${esc(h.changed_by)}</div>
        </div>
      </li>`).join('');
    const revisions = r.revisions.length ? `
      <h3>Corrections</h3>
      <ul class="revs">${r.revisions.map((v) => `<li><b>${esc(v.field)}</b>: ${esc(v.old_value)} &rarr; ${esc(v.new_value)} <span class="muted">· ${esc(v.changed_at_local)} · ${esc(v.changed_by)}</span></li>`).join('')}</ul>` : '';

    document.getElementById('panel-title').innerHTML = `${esc(r.error_id)} ${sevBadge(r.severity)} ${statusBadge(r.status)}`;
    document.getElementById('panel-body').innerHTML = `
      ${r.severity === 'Critical' ? '<div class="crit-banner">Critical severity – prioritise investigation</div>' : ''}
      <dl class="facts">
        <dt>Box ID</dt><dd class="mono">${esc(r.box_id)}</dd>
        <dt>Order ID</dt><dd class="mono">${esc(r.order_id)}</dd>
        <dt>Product</dt><dd>${esc(r.product_name || '–')}</dd>
        <dt>Stage</dt><dd>${esc(r.stage)}</dd>
        <dt>Error type</dt><dd>${esc(r.error_type)}</dd>
        <dt>Reported</dt><dd>${esc(r.timestamp_local)} by ${esc(r.reported_by_name)}</dd>
        <dt>Requires rework</dt><dd>${r.requires_rework ? '<b>Yes</b>' : 'No'}</dd>
        <dt>Resolved</dt><dd>${r.resolved_at_local ? esc(r.resolved_at_local) : '–'}</dd>
      </dl>
      <h3>Description</h3>
      <p class="desc">${esc(r.description)}</p>
      <h3>Photo</h3>
      ${r.photo_image ? `<a href="${esc(r.photo_image)}" target="_blank" rel="noopener"><img class="evidence" src="${esc(r.photo_image)}" alt="Photo for ${esc(r.error_id)}"></a>` : '<p class="muted">No photo was attached.</p>'}

      <form class="action" id="status-form">
        <h3>Update status</h3>
        <div class="grid2">
          <label class="field">New status<select class="input" name="status">${statusOpts}</select></label>
          <label class="field check"><input type="checkbox" name="requires_rework" ${r.requires_rework ? 'checked' : ''}> Product requires rework</label>
        </div>
        <label class="field">Note / corrective action<textarea class="input" name="note" rows="3" maxlength="2000" placeholder="What was found and what was done? Required when resolving."></textarea></label>
        <div class="form-err" id="status-err"></div>
        <button class="btn primary" type="submit">Save update</button>
      </form>

      <h3>Resolution history</h3>
      <ul class="timeline">${history}</ul>
      ${revisions}

      <details class="action">
        <summary>Correct classification</summary>
        <form id="correct-form">
          <p class="muted small">The worker's original description, photo, box, order and timestamp cannot be changed. Every correction is logged.</p>
          <div class="grid3">
            <label class="field">Stage<select class="input" name="stage_id">${opt(lists.stages, r.stage_id)}</select></label>
            <label class="field">Error type<select class="input" name="category_id">${opt(lists.categories, r.category_id)}</select></label>
            <label class="field">Severity<select class="input" name="severity">${lists.severities.map((s) => `<option ${s === r.severity ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          </div>
          <div class="form-err" id="correct-err"></div>
          <button class="btn" type="submit">Save correction</button>
        </form>
      </details>`;

    const sf = document.getElementById('status-form');
    sf.status.addEventListener('change', () => { if (sf.status.value === 'In Rework') sf.requires_rework.checked = true; });
    sf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('status-err');
      err.textContent = '';
      const body = { status: sf.status.value, note: sf.note.value.trim(), requires_rework: sf.requires_rework.checked, expected_updated_at: r.updated_at };
      if (body.status === 'Resolved' && !body.note) { err.textContent = 'Describe the corrective action before resolving.'; sf.note.focus(); return; }
      if (body.status === r.status && !body.note && body.requires_rework === r.requires_rework) { err.textContent = 'Change the status, the rework flag, or add a note.'; return; }
      sf.querySelector('button').disabled = true;
      try {
        if (body.status === r.status && !body.note && body.requires_rework !== r.requires_rework) {
          current = await api(`/api/reports/${encodeURIComponent(r.error_id)}`, { method: 'PATCH', body: { requires_rework: body.requires_rework, expected_updated_at: r.updated_at } });
        } else {
          current = await api(`/api/reports/${encodeURIComponent(r.error_id)}/status`, { method: 'POST', body });
        }
        toast(`${r.error_id} updated`, 'ok');
        render();
        onSaved(current);
      } catch (ex) {
        err.textContent = ex.message;
        sf.querySelector('button').disabled = false;
      }
    });

    const cf = document.getElementById('correct-form');
    cf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('correct-err');
      err.textContent = '';
      const body = { expected_updated_at: r.updated_at };
      if (Number(cf.stage_id.value) !== r.stage_id) body.stage_id = Number(cf.stage_id.value);
      if (Number(cf.category_id.value) !== r.category_id) body.category_id = Number(cf.category_id.value);
      if (cf.severity.value !== r.severity) body.severity = cf.severity.value;
      if (Object.keys(body).length === 1) { err.textContent = 'Nothing changed.'; return; }
      try {
        current = await api(`/api/reports/${encodeURIComponent(r.error_id)}`, { method: 'PATCH', body });
        toast(`${r.error_id} corrected`, 'ok');
        render();
        onSaved(current);
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  window.ReportPanel = {
    init(l, saved) { lists = l; onSaved = saved || onSaved; ensureDom(); },
    setLists(l) { lists = l; },
    open, close, refreshIfOpen,
    currentId: () => current && current.error_id,
  };
})();
