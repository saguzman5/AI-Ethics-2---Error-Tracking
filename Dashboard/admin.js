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
    if (loaders[name]) loaders[name]();
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
      <td><a class="btn sm" href="/dashboard/labels.html?order=${encodeURIComponent(o.order_id)}" target="_blank">Labels</a></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">No orders yet</td></tr>';
    $('products').innerHTML = products.map((p) => `<tr><td class="mono">${esc(p.box_id)}</td><td class="mono">${esc(p.order_id)}</td><td>${esc(p.product_name || '')}</td>
      <td class="nowrap">${esc(p.produced_at_local)}</td><td>${p.errors}</td>
      <td><a class="btn sm" href="/dashboard/labels.html?boxes=${encodeURIComponent(p.box_id)}" target="_blank">Label</a></td></tr>`).join('')
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
      window.open(`/dashboard/labels.html?boxes=${encodeURIComponent(res.box_ids.join(','))}`, '_blank');
    } catch (ex) { $('prod-err').textContent = ex.message; }
  });

  // ------------------------------------------------------------------ users
  let meId = null;
  loaders.users = async () => {
    const users = await api('/api/admin/users');
    $('users').innerHTML = users.map((u) => `
      <tr class="${u.active ? '' : 'inactive'}" data-id="${u.id}">
        <td>${esc(u.full_name)}</td><td class="mono">${esc(u.username)}</td>
        <td><select class="input role" ${u.id === meId ? 'disabled' : ''}><option value="worker" ${u.role === 'worker' ? 'selected' : ''}>worker</option><option value="manager" ${u.role === 'manager' ? 'selected' : ''}>manager</option></select></td>
        <td>${u.reports}</td>
        <td><input type="checkbox" class="uactive" ${u.active ? 'checked' : ''} ${u.id === meId ? 'disabled' : ''} aria-label="Active"></td>
        <td class="nowrap"><button class="btn sm usave">Save</button> <button class="btn sm ureset">Reset password</button></td>
      </tr>`).join('');
  };
  $('users').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    try {
      if (e.target.classList.contains('usave')) {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { role: tr.querySelector('.role').value, active: tr.querySelector('.uactive').checked } });
        toast('User saved', 'ok');
        loaders.users();
      } else if (e.target.classList.contains('ureset')) {
        const pw = prompt('New password for this user (min 8 characters):');
        if (!pw) return;
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { password: pw } });
        toast('Password reset. The user must sign in again.', 'ok');
      }
    } catch (ex) { toast(ex.message, 'error'); }
  });
  $('add-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('user-err').textContent = '';
    try {
      await api('/api/admin/users', { method: 'POST', body: { full_name: f.full_name.value.trim(), username: f.username.value.trim(), role: f.role.value, password: f.password.value } });
      toast('User created', 'ok');
      f.reset();
      loaders.users();
    } catch (ex) { $('user-err').textContent = ex.message; }
  });

  // ------------------------------------------------------------------ spreadsheet feed
  loaders.sheet = async () => {
    const feed = await api('/api/admin/feed');
    $('feed-url').value = feed.csv_url;
  };
  $('copy-feed').addEventListener('click', async () => {
    $('feed-url').select();
    try { await navigator.clipboard.writeText($('feed-url').value); toast('Copied', 'ok'); } catch { document.execCommand('copy'); }
  });
  $('rotate-feed').addEventListener('click', async () => {
    if (!confirm('Generate a new feed key? Existing Google Sheets / Excel connections will stop updating until you paste the new URL.')) return;
    const feed = await api('/api/admin/feed/rotate', { method: 'POST' });
    $('feed-url').value = feed.csv_url;
    toast('New feed key generated', 'ok');
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
    const me = await PTS.session();
    meId = me.user.id;
    PTS.topbar('admin', me);
    const tab = location.hash.slice(1);
    showTab(['lists', 'products', 'users', 'sheet', 'account'].includes(tab) ? tab : 'lists');
  })().catch((e) => { if (e.status !== 401) toast(e.message, 'error'); });
})();
