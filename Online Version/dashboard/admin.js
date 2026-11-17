(function () {
  'use strict';
  const { api, esc, toast } = PTS;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ tabs
  const loaders = {};
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('section.tab').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
    history.replaceState(null, '', `#${name}`);
    if (loaders[name]) loaders[name]().catch((e) => toast(e.message, 'error'));
  }
  document.querySelector('.tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });

  // ------------------------------------------------------------------ stages & categories
  loaders.lists = async () => {
    const l = await api('/api/admin/lists');
    for (const [kind, rows] of [['stages', l.stages], ['categories', l.categories]]) {
      $(kind).innerHTML = rows.map((r) => `
        <tr class="${r.active ? '' : 'inactive'}" data-id="${r.id}" data-kind="${kind}">
          <td><input class="input name" value="${esc(r.name)}" maxlength="60"></td>
          <td><input class="input order" type="number" value="${r.sort_order}"></td>
          <td>${r.used}</td>
          <td><input type="checkbox" class="active" ${r.active ? 'checked' : ''} aria-label="Active"></td>
          <td><button class="btn sm save">Save</button></td>
        </tr>`).join('');
    }
  };
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button.save');
    if (!btn) return;
    const tr = btn.closest('tr');
    try {
      await api(`/api/admin/${tr.dataset.kind}/${tr.dataset.id}`, {
        method: 'PATCH',
        body: { name: tr.querySelector('.name').value, sort_order: Number(tr.querySelector('.order').value), active: tr.querySelector('.active').checked },
      });
      toast('Saved', 'ok');
      loaders.lists();
    } catch (ex) { toast(ex.message, 'error'); }
  });
  for (const [form, kind] of [['add-stage', 'stages'], ['add-category', 'categories']]) {
    $(form).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/api/admin/${kind}`, { method: 'POST', body: { name: e.target.name.value } });
        e.target.reset();
        toast('Added', 'ok');
        loaders.lists();
      } catch (ex) { toast(ex.message, 'error'); }
    });
  }

  // ------------------------------------------------------------------ products
  loaders.products = async () => {
    const [orders, products] = await Promise.all([api('/api/admin/orders'), api(`/api/admin/products?q=${encodeURIComponent($('prod-q').value)}`)]);
    $('orders').innerHTML = orders.map((o) => `<tr><td class="mono">${esc(o.order_id)}</td><td>${esc(o.product_name || '')}</td><td>${o.boxes}</td><td>${o.errors}</td>
      <td><a class="btn sm" href="labels.html?order=${encodeURIComponent(o.order_id)}" target="_blank">Labels</a></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">No orders yet</td></tr>';
    $('products').innerHTML = products.map((p) => `<tr><td class="mono">${esc(p.box_id)}</td><td class="mono">${esc(p.order_id)}</td><td>${esc(p.product_name || '')}</td>
      <td class="nowrap">${esc(p.produced_at_local)}</td><td>${p.errors}</td>
      <td><a class="btn sm" href="labels.html?boxes=${encodeURIComponent(p.box_id)}" target="_blank">Label</a></td></tr>`).join('')
      || '<tr><td colspan="6" class="muted">No products found</td></tr>';
  };
  let qTimer;
  $('prod-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loaders.products, 300); });
  $('add-products').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('prod-err').textContent = '';
    const body = { order_id: f.order_id.value.trim(), product_name: f.product_name.value.trim(), customer: f.customer.value.trim() };
    if (f.box_id.value.trim()) body.box_id = f.box_id.value.trim();
    else if (f.count.value) body.count = Number(f.count.value);
    if (f.box_prefix.value.trim()) body.box_prefix = f.box_prefix.value.trim();
    try {
      const res = await api('/api/admin/products', { method: 'POST', body });
      toast(`Registered ${res.box_ids.length} box(es)`, 'ok');
      f.reset();
      loaders.products();
      window.open(`labels.html?boxes=${encodeURIComponent(res.box_ids.join(','))}`, '_blank');
    } catch (ex) { $('prod-err').textContent = ex.message; }
  });

  // ------------------------------------------------------------------ users
  let meId = null;
  loaders.users = async () => {
    const users = await api('/api/admin/users');
    $('users').innerHTML = users.map((u) => `
      <tr class="${u.active ? '' : 'inactive'}" data-id="${u.id}">
        <td><input class="input uname" value="${esc(u.full_name)}" maxlength="80"></td>
        <td class="mono small">${esc(u.email || u.username)}</td>
        <td><select class="input role" ${u.id === meId ? 'disabled' : ''}><option value="worker" ${u.role === 'worker' ? 'selected' : ''}>worker</option><option value="manager" ${u.role === 'manager' ? 'selected' : ''}>manager</option></select></td>
        <td>${u.reports}</td>
        <td><input type="checkbox" class="uactive" ${u.active ? 'checked' : ''} ${u.id === meId ? 'disabled' : ''} aria-label="Active"></td>
        <td><button class="btn sm usave">Save</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">No users yet</td></tr>';
  };
  $('users-reload').addEventListener('click', () => loaders.users());
  $('users').addEventListener('click', async (e) => {
    if (!e.target.classList.contains('usave')) return;
    const tr = e.target.closest('tr');
    try {
      await api(`/api/admin/users/${tr.dataset.id}`, { method: 'PATCH', body: {
        full_name: tr.querySelector('.uname').value.trim(), role: tr.querySelector('.role').value, active: tr.querySelector('.uactive').checked } });
      toast('User saved', 'ok');
      loaders.users();
    } catch (ex) { toast(ex.message, 'error'); }
  });

  // ------------------------------------------------------------------ settings
  loaders.settings = async () => {
    const s = await api('/api/admin/settings');
    const f = $('settings-form');
    f.timezone.value = s.timezone || 'UTC';
    f.duplicate_window_minutes.value = s.duplicate_window_minutes || '30';
    f.require_photo.checked = s.require_photo === 'true';
    f.auto_register_products.checked = s.auto_register_products !== 'false';
    if (!$('tz-list').children.length && Intl.supportedValuesOf) {
      $('tz-list').innerHTML = Intl.supportedValuesOf('timeZone').map((z) => `<option value="${esc(z)}">`).join('');
    }
  };
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('settings-err').textContent = '';
    try {
      await api('/api/admin/settings', { method: 'POST', body: {
        timezone: f.timezone.value.trim(), duplicate_window_minutes: String(Number(f.duplicate_window_minutes.value) || 0),
        require_photo: f.require_photo.checked, auto_register_products: f.auto_register_products.checked } });
      PTS.setTimeZone(f.timezone.value.trim());
      toast('Settings saved', 'ok');
    } catch (ex) { $('settings-err').textContent = ex.message; }
  });

  // ------------------------------------------------------------------ spreadsheet feed
  const feedText = (f) => `var SUPABASE_URL = '${f.supabase_url}';\nvar SUPABASE_KEY = '${f.supabase_key}';\nvar FEED_KEY = '${f.key}';`;
  loaders.sheet = async () => { $('feed-config').value = feedText(await api('/api/admin/feed')); };
  $('copy-feed').addEventListener('click', async () => {
    $('feed-config').select();
    try { await navigator.clipboard.writeText($('feed-config').value); toast('Copied', 'ok'); } catch { document.execCommand('copy'); }
  });
  $('rotate-feed').addEventListener('click', async () => {
    if (!confirm('Generate a new feed key? Google Sheets will stop updating until you paste the new settings into the script.')) return;
    try {
      $('feed-config').value = feedText(await api('/api/admin/feed/rotate', { method: 'POST' }));
      toast('New feed key generated', 'ok');
    } catch (ex) { toast(ex.message, 'error'); }
  });

  // ------------------------------------------------------------------ password
  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pw-err').textContent = '';
    try {
      await api('/api/auth/password', { method: 'POST', body: { current_password: e.target.current_password.value, new_password: e.target.new_password.value } });
      e.target.reset();
      toast('Password changed', 'ok');
    } catch (ex) { $('pw-err').textContent = ex.message; }
  });

  (async function init() {
    const me = await PTS.session({ manager: true });
    meId = me.user.id;
    PTS.topbar('admin', me);
    // Remember the public address so spreadsheet links point to this site.
    try {
      const s = await api('/api/admin/settings');
      if (s.app_url !== PTS.ROOT) await api('/api/admin/settings', { method: 'POST', body: { app_url: PTS.ROOT } });
    } catch { /* not critical */ }
    const tab = location.hash.slice(1);
    showTab(['lists', 'products', 'users', 'settings', 'sheet', 'account'].includes(tab) ? tab : 'lists');
  })().catch((e) => { if (e.status !== 401) toast(e.message, 'error'); });
})();
