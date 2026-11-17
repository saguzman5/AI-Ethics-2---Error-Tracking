(async function () {
  'use strict';
  const { api, esc } = PTS;
  try { await PTS.session({ manager: true }); } catch (e) { if (e.status !== 401) PTS.toast(e.message, 'error'); return; }
  const params = new URLSearchParams(location.search);
  const order = params.get('order');
  const boxes = (params.get('boxes') || '').split(',').filter(Boolean);
  let products = [];
  try {
    if (order) products = await api(`/api/admin/products?order_id=${encodeURIComponent(order)}`);
    else if (boxes.length) {
      const all = await Promise.all(boxes.map((b) => api(`/api/admin/products?q=${encodeURIComponent(b)}`)));
      products = all.flat().filter((p) => boxes.includes(p.box_id));
    }
  } catch (e) { PTS.toast(e.message, 'error'); }
  products.sort((a, b) => a.box_id.localeCompare(b.box_id));
  document.getElementById('title').textContent = `${products.length} QR label${products.length === 1 ? '' : 's'}${order ? ` · order ${order}` : ''}`;
  document.getElementById('sheet').innerHTML = products.map((p) => `
    <div class="label">
      <img src="${PTS.qrDataUrl(PTS.labelUrl(p.box_id, p.order_id))}" alt="QR code for ${esc(p.box_id)}">
      <div class="box">${esc(p.box_id)}</div>
      <div class="order">Order ${esc(p.order_id)}</div>
      <div class="name">${esc(p.product_name || '')}</div>
    </div>`).join('') || '<p class="empty">No products found.</p>';
  document.getElementById('print').addEventListener('click', () => window.print());
})();
