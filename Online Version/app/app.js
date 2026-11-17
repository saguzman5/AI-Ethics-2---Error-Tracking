/* Worker error-reporting app. */
(function () {
  'use strict';
  const { api, esc, sevBadge, statusBadge, fmt } = PTS;
  const $ = (id) => document.getElementById(id);

  const state = {
    me: null,
    lists: null,
    product: null,       // { box_id, order_id, product_name, registered, open_errors }
    stageId: null,
    categoryId: null,
    severity: null,
    photo: null,         // data URL (compressed JPEG)
    submissionId: null,  // idempotency key; reused on retry
    submitting: false,
  };

  const LAST_STAGE_KEY = 'pts.lastStage';

  // ------------------------------------------------------------------ views
  function show(view) {
    for (const v of ['scan', 'form', 'done', 'mine']) $(`view-${v}`).hidden = v !== view;
    const order = ['scan', 'form', 'done'];
    const idx = order.indexOf(view);
    document.querySelectorAll('.steps li').forEach((li) => {
      const i = order.indexOf(li.dataset.step);
      li.classList.toggle('active', i === idx);
      li.classList.toggle('complete', idx > -1 && i < idx);
    });
    document.querySelector('.steps').hidden = view === 'mine';
    window.scrollTo(0, 0);
    if (view === 'scan') startCamera();
    else window.Scanner.stop($('video'));
  }

  // ------------------------------------------------------------------ scanning
  function scanMsg(text) { $('scanner-msg').textContent = text; }
  function scanError(text) {
    const el = $('scan-error');
    el.textContent = text || '';
    el.hidden = !text;
  }

  async function startCamera() {
    $('scanner').classList.remove('found');
    scanMsg('Starting camera…');
    try {
      await window.Scanner.start($('video'), onCode, scanMsg);
    } catch (e) {
      scanMsg('Camera unavailable');
      scanError(e.message);
    }
  }

  async function onCode(text) {
    $('scanner').classList.add('found');
    scanMsg('QR code found');
    await lookup(text);
  }

  async function lookup(code) {
    scanError('');
    try {
      const p = await api(`/api/products/lookup?code=${encodeURIComponent(code)}`);
      openForm(p);
    } catch (e) {
      scanError(e.message);
      if (!$('view-scan').hidden) setTimeout(startCamera, 1200);
    }
  }

  $('btn-camera').addEventListener('click', () => { scanError(''); startCamera(); });
  $('file-qr').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    scanError('');
    scanMsg('Reading photo…');
    try { await lookup(await window.Scanner.decodeFile(file)); }
    catch (err) { scanError(err.message); scanMsg('Try again'); }
  });
  $('manual-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('manual-code').value.trim();
    if (!code) { scanError('Enter a Box ID or scan with a handheld scanner.'); return; }
    lookup(code);
  });

  // ------------------------------------------------------------------ report form
  function newSubmissionId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function openForm(product, { keepStage = true } = {}) {
    state.product = product;
    state.categoryId = null;
    state.severity = null;
    state.photo = null;
    state.submissionId = newSubmissionId();
    const last = Number(localStorage.getItem(LAST_STAGE_KEY));
    state.stageId = keepStage && state.lists.stages.some((s) => s.id === last) ? last : null;

    $('p-box').textContent = product.box_id;
    $('p-order').textContent = product.order_id;
    $('p-name').textContent = product.product_name || (product.registered ? '' : 'New box – it will be registered with this report');
    const open = product.open_errors || [];
    $('p-open').hidden = !open.length;
    $('p-open').innerHTML = open.length
      ? `<strong>${open.length} open report${open.length > 1 ? 's' : ''} on this box:</strong><br>` +
        open.map((o) => `${esc(o.error_id)} · ${esc(o.error_type)} at ${esc(o.stage)} (${esc(o.status)})`).join('<br>')
      : '';
    $('description').value = '';
    $('desc-count').textContent = '0';
    renderChoices();
    setPhoto(null);
    clearErrors();
    $('dup-warning').hidden = true;
    show('form');
  }

  function renderChoices() {
    const chip = (item, selected, kind) =>
      `<button type="button" class="chip" data-kind="${kind}" data-id="${item.id}" aria-pressed="${item.id === selected}">${esc(item.name)}</button>`;
    $('stages').innerHTML = state.lists.stages.map((s) => chip(s, state.stageId, 'stage')).join('');
    $('categories').innerHTML = state.lists.categories.map((c) => chip(c, state.categoryId, 'category')).join('');
    $('severities').innerHTML = state.lists.severities.map((s) =>
      `<button type="button" class="sev" data-sev="${esc(s)}" aria-pressed="${s === state.severity}">${esc(s)}</button>`).join('');
    document.querySelectorAll('.sev').forEach((b) => b.style.setProperty('--c', PTS.SEVERITY_COLORS[b.dataset.sev]));
  }

  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) {
      const id = Number(chip.dataset.id);
      if (chip.dataset.kind === 'stage') { state.stageId = id; localStorage.setItem(LAST_STAGE_KEY, String(id)); }
      else state.categoryId = id;
      chip.parentElement.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      clearError(chip.dataset.kind);
      return;
    }
    const sev = e.target.closest('.sev');
    if (sev) {
      state.severity = sev.dataset.sev;
      document.querySelectorAll('.sev').forEach((b) => b.setAttribute('aria-pressed', String(b === sev)));
      clearError('severity');
    }
  });

  $('description').addEventListener('input', (e) => {
    $('desc-count').textContent = String(e.target.value.length);
    if (e.target.value.trim().length >= 3) clearError('description');
  });

  $('btn-change-box').addEventListener('click', () => show('scan'));

  // ------------------------------------------------------------------ photo
  async function compress(file) {
    if (!/^image\//.test(file.type) && file.type !== '') throw new Error('Please choose an image file.');
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      try { bitmap = await createImageBitmap(file); }
      catch { throw new Error('This image format is not supported. Use your camera or a JPEG/PNG image.'); }
    }
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bitmap.width * scale);
    c.height = Math.round(bitmap.height * scale);
    c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
    if (bitmap.close) bitmap.close();
    return c.toDataURL('image/jpeg', 0.82);
  }

  function setPhoto(dataUrl) {
    state.photo = dataUrl;
    $('photo-preview').hidden = !dataUrl;
    $('photo-buttons').hidden = !!dataUrl;
    if (dataUrl) $('photo-img').src = dataUrl; else $('photo-img').removeAttribute('src');
  }

  async function onPhoto(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      setPhoto(await compress(file));
      clearError('photo');
    } catch (err) { setError('photo', err.message); }
  }
  $('file-camera').addEventListener('change', onPhoto);
  $('file-gallery').addEventListener('change', onPhoto);
  $('btn-remove-photo').addEventListener('click', () => setPhoto(null));

  // ------------------------------------------------------------------ validation
  const groupFor = { stage: 'g-stage', category: 'g-type', severity: 'g-sev', description: 'g-desc', photo: 'g-photo' };
  function setError(field, msg) {
    document.querySelector(`.field-err[data-for="${field}"]`).textContent = msg;
    $(groupFor[field]).classList.add('invalid');
  }
  function clearError(field) {
    document.querySelector(`.field-err[data-for="${field}"]`).textContent = '';
    $(groupFor[field]).classList.remove('invalid');
  }
  function clearErrors() {
    Object.keys(groupFor).forEach(clearError);
    $('submit-error').hidden = true;
  }

  function validate() {
    clearErrors();
    const errors = [];
    if (!state.stageId) errors.push(['stage', 'Choose the stage where you found the error.']);
    if (!state.categoryId) errors.push(['category', 'Choose the type of error.']);
    if (!state.severity) errors.push(['severity', 'Choose how serious the error is.']);
    const d = $('description').value.trim();
    if (d.length < 3) errors.push(['description', 'Describe the problem in a few words.']);
    if (state.me.require_photo && !state.photo) errors.push(['photo', 'A photo is required.']);
    errors.forEach(([f, m]) => setError(f, m));
    if (errors.length) $(groupFor[errors[0][0]]).scrollIntoView({ behavior: 'smooth', block: 'center' });
    return errors.length === 0;
  }

  // ------------------------------------------------------------------ submit
  async function submit(confirmDuplicate = false) {
    if (state.submitting) return;
    if (!validate()) return;
    state.submitting = true;
    const btn = $('btn-submit');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Submitting…';
    $('dup-warning').hidden = true;
    try {
      const res = await api('/api/reports', {
        method: 'POST',
        timeout: 60000,
        body: {
          client_submission_id: state.submissionId,
          box_id: state.product.box_id,
          order_id: state.product.order_id,
          stage_id: state.stageId,
          category_id: state.categoryId,
          severity: state.severity,
          description: $('description').value.trim(),
          photo: state.photo || undefined,
          confirm_duplicate: confirmDuplicate || undefined,
        },
      });
      showDone(res.report);
    } catch (e) {
      if (e.status === 409 && e.body.code === 'POSSIBLE_DUPLICATE') {
        $('dup-text').textContent = `${e.message} Is this a different problem?`;
        $('dup-warning').hidden = false;
        $('dup-warning').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        const el = $('submit-error');
        el.textContent = `Report not submitted: ${e.message}` + (e.status === 0 || e.status >= 500 ? ' Your answers are kept; tap Submit to try again.' : '');
        el.hidden = false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } finally {
      state.submitting = false;
      btn.disabled = false;
      btn.textContent = 'Submit report';
    }
  }

  $('report-form').addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
  $('btn-dup-confirm').addEventListener('click', () => submit(true));
  $('btn-dup-cancel').addEventListener('click', () => { $('dup-warning').hidden = true; });

  function showDone(r) {
    $('d-id').textContent = r.error_id;
    $('d-box').textContent = `${r.box_id} / ${r.order_id}`;
    $('d-time').textContent = r.timestamp_local;
    $('d-status').innerHTML = statusBadge(r.status);
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    show('done');
  }

  $('btn-next').addEventListener('click', () => { $('manual-code').value = ''; show('scan'); });
  $('btn-same').addEventListener('click', async () => {
    try { openForm(await api(`/api/products/lookup?code=${encodeURIComponent(state.product.box_id)}`)); }
    catch { openForm(state.product); }
  });

  // ------------------------------------------------------------------ my reports
  async function showMine() {
    const current = ['scan', 'form', 'done'].find((v) => !$(`view-${v}`).hidden);
    if (current) state.prevView = current;
    show('mine');
    $('mine-list').innerHTML = '<div class="empty">Loading…</div>';
    try {
      const rows = await api('/api/reports/mine');
      $('mine-list').innerHTML = rows.length ? rows.map((r) => `
        <div class="mine-item">
          <div class="top"><strong class="mono">${esc(r.error_id)}</strong>${statusBadge(r.status)}</div>
          <div class="meta">${esc(r.box_id)} · ${esc(r.order_id)}</div>
          <div class="meta">${esc(r.error_type)} at ${esc(r.stage)} ${sevBadge(r.severity)}</div>
          <div class="meta muted">${esc(r.timestamp_local)}</div>
        </div>`).join('') : '<div class="empty">You have not submitted any reports yet.</div>';
    } catch (e) {
      $('mine-list').innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    }
  }
  $('btn-mine').addEventListener('click', showMine);
  // Return to whatever the worker was doing (an unfinished form is kept).
  $('btn-mine-back').addEventListener('click', () => show(state.prevView || 'scan'));
  $('btn-logout').addEventListener('click', PTS.logout);

  // ------------------------------------------------------------------ init
  (async function init() {
    try {
      state.me = await PTS.session();
      state.lists = await api('/api/lists');
    } catch (e) {
      if (e.status !== 401) scanError(e.message);
      return;
    }
    $('who').textContent = `${state.me.user.full_name}`;
    $('photo-req').textContent = state.me.require_photo ? 'required' : 'recommended';

    // Labels printed by the system encode /app/?box=..&order=.. so a phone's
    // own camera app can open this page with the box pre-selected.
    const params = new URLSearchParams(location.search);
    if (params.get('box')) {
      const code = `BOX:${params.get('box')};ORDER:${params.get('order') || ''}`;
      history.replaceState(null, '', location.pathname);
      try {
        openForm(await api(`/api/products/lookup?code=${encodeURIComponent(params.get('order') ? code : params.get('box'))}`));
        return;
      } catch (e) { scanError(e.message); }
    }
    show('scan');
  })();
})();
