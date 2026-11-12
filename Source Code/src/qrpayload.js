'use strict';
// Parses the text inside a product QR code. Accepted formats:
//   1. Plain box ID ............................ BOX-000123
//   2. JSON .................................... {"box_id":"BOX-000123","order_id":"PO-2026-001"}
//   3. URL with query parameters ............... https://any.host/p?box=BOX-000123&order=PO-2026-001
//   4. Key/value pairs ......................... BOX:BOX-000123;ORDER:PO-2026-001
// Labels printed by this system use format 3 pointing at this server.

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}$/;

function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return ID_RE.test(s) ? s : null;
}

function parse(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 2000) return null;

  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text);
      const box = clean(o.box_id ?? o.boxId ?? o.box);
      return box ? { box_id: box, order_id: clean(o.order_id ?? o.orderId ?? o.order) } : null;
    } catch { return null; }
  }

  if (/^https?:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      const box = clean(u.searchParams.get('box') ?? u.searchParams.get('box_id'));
      return box ? { box_id: box, order_id: clean(u.searchParams.get('order') ?? u.searchParams.get('order_id')) } : null;
    } catch { return null; }
  }

  if (/[;|]/.test(text) || /^box(_id)?\s*[:=]/i.test(text)) {
    const kv = {};
    for (const part of text.split(/[;|]/)) {
      const m = /^\s*([A-Za-z_]+)\s*[:=]\s*(.+?)\s*$/.exec(part);
      if (m) kv[m[1].toLowerCase()] = m[2];
    }
    const box = clean(kv.box ?? kv.box_id);
    return box ? { box_id: box, order_id: clean(kv.order ?? kv.order_id) } : null;
  }

  const box = clean(text);
  return box ? { box_id: box, order_id: null } : null;
}

module.exports = { parse, ID_RE };
