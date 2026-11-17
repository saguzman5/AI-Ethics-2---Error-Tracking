'use strict';
// Test double for Supabase, used only by tests/online-ui-smoke.js.
// It serves the "Online Version" folder and answers the database calls the
// pages make. It also cross-checks every call against Database/supabase-setup.sql:
// unknown functions, wrong parameter names and unknown columns fail the test.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const SITE = path.join(ROOT, 'Online Version');
const SQL = fs.readFileSync(path.join(ROOT, 'Database', 'supabase-setup.sql'), 'utf8');

// ------------------------------------------------------------ schema from SQL
function parseFunctions(sql) {
  const out = {};
  const re = /create or replace function public\.(\w+)\(([\s\S]*?)\)\s*returns/g;
  let m;
  while ((m = re.exec(sql))) {
    const params = m[2].split(',').map((p) => p.trim()).filter(Boolean).map((p) => ({ name: p.split(/\s+/)[0], required: !/\bdefault\b/i.test(p) }));
    out[m[1]] = params;
  }
  return out;
}
function parseColumns(sql) {
  const out = {};
  const re = /create table if not exists public\.(\w+) \(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    out[m[1]] = m[2].split('\n').map((l) => l.trim()).filter((l) => l && !/^(primary|unique|check|constraint|foreign)/i.test(l)).map((l) => l.split(/\s+/)[0]);
  }
  const v = sql.slice(sql.indexOf('create view public.v_error_reports'), sql.indexOf('from public.error_reports r'));
  out.v_error_reports = v.split('\n').slice(2).map((l) => l.trim().replace(/,$/, '')).filter(Boolean).map((l) => {
    const a = /\bas\s+"?(\w+)"?$/.exec(l);
    if (a) return a[1];
    const c = /^\w+\.(\w+)$/.exec(l);
    return c ? c[1] : null;
  }).filter(Boolean);
  return out;
}
const FUNCS = parseFunctions(SQL);
const COLS = parseColumns(SQL);

// ------------------------------------------------------------ state
const pgNow = () => new Date().toISOString().replace('Z', '000+00:00');
const S = {
  users: [], profiles: [], tokens: new Map(), settings: { timezone: 'America/Chicago', require_photo: 'false', auto_register_products: 'true', duplicate_window_minutes: '30', app_url: '' },
  feedKey: 'feed' + crypto.randomBytes(8).toString('hex'), stages: [], categories: [], orders: [], products: [],
  reports: [], history: [], revisions: [], photos: new Map(), seq: 0, events: [], calls: [], problems: [],
};
['Raw Material Inspection', 'Cutting', 'Machining', 'Welding', 'Assembly', 'Painting / Finishing', 'Quality Inspection', 'Packaging', 'Shipping']
  .forEach((name, i) => S.stages.push({ id: i + 1, name, sort_order: (i + 1) * 10, active: true }));
['Dimensional Error', 'Surface Defect / Scratch', 'Missing Part', 'Wrong Part', 'Assembly Error', 'Weld Defect', 'Paint / Coating Defect', 'Damaged Component', 'Labeling Error', 'Packaging Damage', 'Contamination', 'Other']
  .forEach((name, i) => S.categories.push({ id: i + 1, name, sort_order: (i + 1) * 10, active: true }));

function addUser(email, password, fullName) {
  const id = crypto.randomUUID();
  S.users.push({ id, email, password });
  S.profiles.push({ id, username: email.split('@')[0], full_name: fullName, role: S.profiles.some((p) => p.role === 'manager') ? 'worker' : 'manager', active: true, created_at: pgNow() });
  return id;
}

class DbError extends Error { constructor(message, code) { super(message); this.code = code; } }
const fail = (m, c) => { throw new DbError(m, c); };

const prof = (uid) => S.profiles.find((p) => p.id === uid && p.active);
const isManager = (uid) => !!(prof(uid) && prof(uid).role === 'manager');
const local = (iso) => {
  if (!iso) return null;
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: S.settings.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(iso)).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
};
const RANK_S = { Critical: 4, High: 3, Medium: 2, Low: 1 };
const RANK_ST = { Open: 1, 'Under Review': 2, 'In Rework': 3, Resolved: 4 };

function viewRows() {
  return S.reports.map((r) => {
    const p = S.products.find((x) => x.box_id === r.box_id);
    const o = S.orders.find((x) => x.order_id === p.order_id);
    return {
      error_id: r.error_id, box_id: r.box_id, order_id: r.order_id,
      stage: S.stages.find((s) => s.id === r.stage_id).name, error_type: S.categories.find((c) => c.id === r.category_id).name,
      severity: r.severity, timestamp: r.reported_at, status: r.status, photo_path: r.photo_path, description: r.description,
      requires_rework: r.requires_rework, resolution_notes: r.resolution_notes, status_changed_at: r.status_changed_at,
      resolved_at: r.resolved_at, updated_at: r.updated_at, stage_id: r.stage_id, category_id: r.category_id, reported_by: r.reported_by,
      reported_by_name: S.profiles.find((u) => u.id === r.reported_by).full_name, product_name: p.product_name || o.product_name,
      produced_at: p.produced_at, severity_rank: RANK_S[r.severity], status_rank: RANK_ST[r.status],
    };
  });
}

function tableRows(table, uid) {
  if (!prof(uid) && table !== 'app_settings' && table !== 'profiles') return [];
  switch (table) {
    case 'v_error_reports': return viewRows().filter((r) => isManager(uid) || r.reported_by === uid);
    case 'error_reports': return S.reports.filter((r) => isManager(uid) || r.reported_by === uid);
    case 'profiles': return S.profiles.filter((p) => p.id === uid || isManager(uid));
    case 'app_settings': return Object.entries(S.settings).map(([key, value]) => ({ key, value }));
    case 'production_stages': return S.stages;
    case 'error_categories': return S.categories;
    case 'products': return S.products;
    case 'production_orders': return S.orders;
    default: return fail(`relation "public.${table}" does not exist`, '42P01');
  }
}

const cmp = (a, b) => (a === b ? 0 : a === null || a === undefined ? 1 : b === null || b === undefined ? -1 : a < b ? -1 : 1);
const tsLike = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
function likeToRe(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) { re += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (c === '%' || c === '*') re += '.*'; else if (c === '_') re += '.'; else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function checkCols(table, names) {
  const known = COLS[table];
  if (!known) return S.problems.push(`No columns known for ${table}`);
  for (const n of names) if (n !== '*' && !known.includes(n)) S.problems.push(`Column "${n}" does not exist in ${table} (check SQL vs backend.js)`);
}

function query(op, uid) {
  const t = op.table;
  if (op.action === 'insert' || op.action === 'update') {
    if (!['production_stages', 'error_categories'].includes(t)) fail(`permission denied for table ${t}`, '42501');
    const list = t === 'production_stages' ? S.stages : S.categories;
    checkCols(t, Object.keys(op.values));
    if (!isManager(uid)) { if (op.action === 'insert') fail('new row violates row-level security policy', '42501'); return { data: [] }; }
    if (op.action === 'insert') {
      if (list.some((x) => x.name.toLowerCase() === op.values.name.toLowerCase())) fail('duplicate key value violates unique constraint', '23505');
      const row = { id: Math.max(0, ...list.map((x) => x.id)) + 1, sort_order: 0, active: true, ...op.values };
      list.push(row);
      return { data: op.single ? row : [row] };
    }
    const rows = list.filter((x) => op.filters.every(([k, c, v]) => k === 'eq' && x[c] === v));
    for (const r of rows) {
      if (op.values.name && list.some((x) => x !== r && x.name.toLowerCase() === op.values.name.toLowerCase())) fail('duplicate key value violates unique constraint', '23505');
      Object.assign(r, op.values);
    }
    return { data: rows };
  }
  let rows = tableRows(t, uid).map((r) => ({ ...r }));
  const cols = String(op.cols || '*').split(',').map((s) => s.trim());
  checkCols(t, cols);
  checkCols(t, op.filters.map((f) => f[1]));
  checkCols(t, op.order.map((o) => o[0]));
  for (const [kind, c, v] of op.filters) {
    rows = rows.filter((r) => {
      const x = r[c];
      if (kind === 'eq') return x === v || String(x) === String(v);
      if (kind === 'in') return v.map(String).includes(String(x));
      if (kind === 'gte' || kind === 'lt') {
        const a = tsLike(x) ? Date.parse(x) : x;
        const b = tsLike(v) ? Date.parse(v) : v;
        return kind === 'gte' ? a >= b : a < b;
      }
      if (kind === 'ilike') return likeToRe(v).test(String(x ?? ''));
      return fail(`unsupported filter ${kind}`);
    });
  }
  if (op.order.length) {
    rows.sort((a, b) => {
      for (const [c, asc] of op.order) {
        const x = tsLike(a[c]) ? Date.parse(a[c]) : a[c];
        const y = tsLike(b[c]) ? Date.parse(b[c]) : b[c];
        const d = cmp(x, y);
        if (d) return asc ? d : -d;
      }
      return 0;
    });
  }
  const count = rows.length;
  if (op.range) rows = rows.slice(op.range[0], op.range[1] + 1);
  if (op.limit) rows = rows.slice(0, op.limit);
  if (!cols.includes('*')) rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  const res = { count: op.opts && op.opts.count ? count : null };
  if (op.opts && op.opts.head) return { ...res, data: null };
  if (op.single || op.maybe) {
    if (rows.length > 1 || (op.single && !rows.length)) fail('JSON object requested, multiple (or no) rows returned', 'PGRST116');
    return { ...res, data: rows[0] || null };
  }
  return { ...res, data: rows };
}

// ------------------------------------------------------------ functions
const summary = (r, dup) => ({ result: dup ? 'existing' : 'created', error_id: r.error_id, box_id: r.box_id, order_id: r.order_id, status: r.status, timestamp: r.reported_at, timestamp_local: local(r.reported_at) });
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const needMgr = (uid) => { if (!isManager(uid)) fail('Manager access required', '42501'); };
const event = (r) => S.events.push({ at: S.events.length + 1, error_id: r.error_id, type: 'UPDATE' });

const RPC = {
  product_info({ p_box }, uid) {
    if (!prof(uid)) fail('Please sign in again', '42501');
    const p = S.products.find((x) => x.box_id === p_box);
    if (!p) return null;
    const o = S.orders.find((x) => x.order_id === p.order_id);
    const open = viewRows().filter((r) => r.box_id === p_box && r.status !== 'Resolved').slice(-5).reverse()
      .map((r) => ({ error_id: r.error_id, stage: r.stage, error_type: r.error_type, severity: r.severity, status: r.status, reported_at: r.timestamp, reported_at_local: local(r.timestamp) }));
    return { box_id: p.box_id, order_id: p.order_id, product_name: p.product_name || o.product_name, customer: o.customer, registered: true, open_errors: open };
  },
  submit_report(a, uid) {
    if (!prof(uid)) fail('Please sign in again', '42501');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(a.p_submission_id || '')) fail('client_submission_id is invalid');
    const ex = S.reports.find((r) => r.client_submission_id === a.p_submission_id);
    if (ex) return summary(ex, true);
    const box = String(a.p_box_id || '').trim();
    if (!box) fail('Box ID is required');
    if (!S.stages.some((s) => s.id === a.p_stage_id && s.active)) fail('Select a valid production stage');
    if (!S.categories.some((s) => s.id === a.p_category_id && s.active)) fail('Select a valid error type');
    if (!RANK_S[a.p_severity]) fail('Select a severity: Low, Medium, High or Critical');
    const desc = String(a.p_description || '').trim();
    if (desc.length < 3) fail('Description must be at least 3 characters');
    if (a.p_photo_path) {
      if (!new RegExp(`^${uid}/[0-9a-f-]{36}\\.(jpg|png|webp)$`).test(a.p_photo_path)) fail('Invalid photo reference');
      if (!S.photos.has(a.p_photo_path)) fail('The photo upload did not complete. Please try again.');
    }
    let p = S.products.find((x) => x.box_id === box);
    if (!p) {
      if (!a.p_order_id) fail(`Box ${box} is not registered. Ask a manager to register it.`);
      if (!S.orders.some((o) => o.order_id === a.p_order_id)) S.orders.push({ order_id: a.p_order_id, created_at: pgNow() });
      p = { box_id: box, order_id: a.p_order_id, produced_at: pgNow() };
      S.products.push(p);
    } else if (a.p_order_id && a.p_order_id !== p.order_id) fail(`Box ${box} belongs to order ${p.order_id}, not ${a.p_order_id}`);
    if (!a.p_confirm_duplicate) {
      const since = Date.now() - Number(S.settings.duplicate_window_minutes) * 60000;
      const dup = S.reports.filter((r) => r.box_id === box && r.stage_id === a.p_stage_id && r.category_id === a.p_category_id && r.status !== 'Resolved' && Date.parse(r.reported_at) >= since).pop();
      if (dup) return { result: 'possible_duplicate', error_id: dup.error_id, reported_at_local: local(dup.reported_at) };
    }
    const now = pgNow();
    const seq = ++S.seq;
    const r = { seq, error_id: `ERR-${String(seq).padStart(6, '0')}`, client_submission_id: a.p_submission_id, box_id: box, order_id: p.order_id,
      stage_id: a.p_stage_id, category_id: a.p_category_id, severity: a.p_severity, description: desc, photo_path: a.p_photo_path || null,
      status: 'Open', requires_rework: false, resolution_notes: null, reported_by: uid, reported_at: now, status_changed_at: now, resolved_at: null, updated_at: now };
    S.reports.push(r);
    S.history.push({ id: S.history.length + 1, error_id: r.error_id, from_status: null, to_status: 'Open', note: 'Report submitted', changed_by: uid, changed_at: now });
    S.events.push({ at: S.events.length + 1, error_id: r.error_id, type: 'INSERT' });
    return summary(r, false);
  },
  change_status(a, uid) {
    needMgr(uid);
    const cur = S.reports.find((r) => r.error_id === a.p_error_id);
    if (!cur) fail(`Error report ${a.p_error_id} not found`);
    if (a.p_expected_updated_at && a.p_expected_updated_at !== cur.updated_at) fail('This report was changed by someone else. Reload it and try again.');
    const note = (a.p_note || '').trim() || null;
    if (!RANK_ST[a.p_status]) fail('Invalid status');
    if (cur.status === a.p_status && !note) fail(`Report is already "${a.p_status}"`);
    if (a.p_status === 'Resolved' && !note) fail('Add a resolution note describing the corrective action');
    let rw = cur.requires_rework;
    if (a.p_status === 'In Rework') rw = true;
    if (typeof a.p_requires_rework === 'boolean') rw = a.p_requires_rework;
    const now = pgNow();
    if (rw !== cur.requires_rework) S.revisions.push({ id: S.revisions.length + 1, error_id: cur.error_id, field: 'requires_rework', old_value: cur.requires_rework ? 'Yes' : 'No', new_value: rw ? 'Yes' : 'No', changed_by: uid, changed_at: now });
    const changed = cur.status !== a.p_status;
    S.history.push({ id: S.history.length + 1, error_id: cur.error_id, from_status: cur.status, to_status: a.p_status, note, changed_by: uid, changed_at: now });
    Object.assign(cur, { status: a.p_status, requires_rework: rw, resolution_notes: note || cur.resolution_notes,
      status_changed_at: changed ? now : cur.status_changed_at, resolved_at: a.p_status === 'Resolved' ? (changed ? now : cur.resolved_at) : null, updated_at: now });
    event(cur);
    return null;
  },
  correct_report(a, uid) {
    needMgr(uid);
    const cur = S.reports.find((r) => r.error_id === a.p_error_id);
    if (!cur) fail('not found');
    const now = pgNow();
    let n = 0;
    if (a.p_stage_id && a.p_stage_id !== cur.stage_id) { cur.stage_id = a.p_stage_id; n++; }
    if (a.p_category_id && a.p_category_id !== cur.category_id) { cur.category_id = a.p_category_id; n++; }
    if (a.p_severity && a.p_severity !== cur.severity) { S.revisions.push({ id: S.revisions.length + 1, error_id: cur.error_id, field: 'severity', old_value: cur.severity, new_value: a.p_severity, changed_by: uid, changed_at: now }); cur.severity = a.p_severity; n++; }
    if (typeof a.p_requires_rework === 'boolean' && a.p_requires_rework !== cur.requires_rework) { cur.requires_rework = a.p_requires_rework; n++; }
    if (!n) fail('No changes to save');
    cur.updated_at = now;
    event(cur);
    return null;
  },
  report_history({ p_error_id }, uid) {
    needMgr(uid);
    const name = (id) => S.profiles.find((p) => p.id === id).full_name;
    return {
      history: S.history.filter((h) => h.error_id === p_error_id).map((h) => ({ ...h, changed_at_local: local(h.changed_at), changed_by: name(h.changed_by) })),
      revisions: S.revisions.filter((h) => h.error_id === p_error_id).map((h) => ({ ...h, changed_at_local: local(h.changed_at), changed_by: name(h.changed_by) })),
    };
  },
  history_for_reports({ p_error_ids }, uid) {
    needMgr(uid);
    return S.history.filter((h) => p_error_ids.includes(h.error_id)).map((h) => ({ ...h, changed_by: S.profiles.find((p) => p.id === h.changed_by).full_name }));
  },
  admin_lists(a, uid) {
    needMgr(uid);
    const used = (k, id) => S.reports.filter((r) => r[k] === id).length;
    return {
      stages: S.stages.map((s) => ({ ...s, active: s.active ? 1 : 0, used: used('stage_id', s.id) })).sort((x, y) => x.sort_order - y.sort_order),
      categories: S.categories.map((s) => ({ ...s, active: s.active ? 1 : 0, used: used('category_id', s.id) })).sort((x, y) => x.sort_order - y.sort_order),
    };
  },
  admin_orders(a, uid) {
    needMgr(uid);
    return S.orders.map((o) => ({ ...o, boxes: S.products.filter((p) => p.order_id === o.order_id).length, errors: S.reports.filter((r) => r.order_id === o.order_id).length }));
  },
  admin_products({ p_q, p_order_id }, uid) {
    needMgr(uid);
    return S.products.filter((p) => (!p_q || p.box_id.toLowerCase().includes(p_q.toLowerCase()) || p.order_id.toLowerCase().includes(p_q.toLowerCase())) && (!p_order_id || p.order_id === p_order_id))
      .map((p) => ({ ...p, produced_at_local: local(p.produced_at), errors: S.reports.filter((r) => r.box_id === p.box_id).length }));
  },
  admin_register_products(a, uid) {
    needMgr(uid);
    if (!ID_RE.test(a.p_order_id || '')) fail('Order ID is required (letters, numbers, . _ - /)');
    let boxes;
    if (a.p_box_id) boxes = [a.p_box_id];
    else {
      if (!a.p_count) fail('Enter a Box ID or a quantity between 1 and 1000');
      const start = S.products.filter((p) => p.order_id === a.p_order_id).length + 1;
      const prefix = a.p_box_prefix || `BOX-${a.p_order_id}`;
      boxes = Array.from({ length: a.p_count }, (_, i) => `${prefix}-${String(start + i).padStart(4, '0')}`);
    }
    if (!S.orders.some((o) => o.order_id === a.p_order_id)) S.orders.push({ order_id: a.p_order_id, product_name: a.p_product_name, customer: a.p_customer, created_at: pgNow() });
    for (const b of boxes) {
      if (S.products.some((p) => p.box_id === b)) fail(`Box ${b} already exists`);
      S.products.push({ box_id: b, order_id: a.p_order_id, product_name: a.p_product_name, produced_at: pgNow() });
    }
    return { order_id: a.p_order_id, box_ids: boxes };
  },
  admin_users(a, uid) {
    needMgr(uid);
    return S.profiles.map((p) => ({ ...p, active: p.active ? 1 : 0, email: S.users.find((u) => u.id === p.id).email, reports: S.reports.filter((r) => r.reported_by === p.id).length }));
  },
  admin_update_user(a, uid) {
    needMgr(uid);
    const p = S.profiles.find((x) => x.id === a.p_id);
    if (!p) fail('User not found');
    if (a.p_full_name) p.full_name = a.p_full_name;
    if (a.p_role) p.role = a.p_role;
    if (typeof a.p_active === 'boolean') p.active = a.p_active;
    return null;
  },
  admin_save_settings({ p_settings }, uid) {
    needMgr(uid);
    for (const [k, v] of Object.entries(p_settings)) {
      if (typeof v !== 'string') S.problems.push(`admin_save_settings: ${k} is not a string`);
      if (!(k in S.settings)) fail(`Unknown setting ${k}`);
      if (k === 'timezone') { try { new Intl.DateTimeFormat('en', { timeZone: v }); } catch { fail(`Unknown time zone "${v}"`); } }
      S.settings[k] = v;
    }
    return null;
  },
  feed_key({ p_rotate }, uid) {
    needMgr(uid);
    if (p_rotate) S.feedKey = 'feed' + crypto.randomBytes(8).toString('hex');
    return S.feedKey;
  },
  sheet_feed({ p_key }) {
    if (p_key !== S.feedKey) fail('Invalid feed key', '42501');
    return [['error_ID'], ...viewRows().map((r) => [r.error_id])];
  },
};

function callRpc(name, args, uid) {
  const sig = FUNCS[name];
  if (!sig) { S.problems.push(`Function public.${name} is not defined in supabase-setup.sql`); fail(`Could not find the function public.${name}`, 'PGRST202'); }
  for (const k of Object.keys(args || {})) if (!sig.some((p) => p.name === k)) S.problems.push(`${name}: unknown parameter ${k}`);
  for (const p of sig) if (p.required && !(p.name in (args || {}))) S.problems.push(`${name}: missing required parameter ${p.name}`);
  if (!RPC[name]) fail(`mock has no implementation for ${name}`);
  return RPC[name](args || {}, uid);
}

// ------------------------------------------------------------ browser client
const CLIENT = String.raw`(function () {
  'use strict';
  async function call(op) {
    const res = await fetch('/mock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...op, token: localStorage.getItem('mock-token') }) });
    return res.json();
  }
  class Q {
    constructor(table) { this.op = { kind: 'query', table, filters: [], order: [], action: 'select' }; }
    select(cols, opts) { if (this.op.action === 'select') { this.op.cols = cols; this.op.opts = opts || {}; } return this; }
    insert(v) { this.op.action = 'insert'; this.op.values = v; return this; }
    update(v) { this.op.action = 'update'; this.op.values = v; return this; }
    eq(c, v) { this.op.filters.push(['eq', c, v]); return this; }
    in(c, v) { this.op.filters.push(['in', c, v]); return this; }
    gte(c, v) { this.op.filters.push(['gte', c, v]); return this; }
    lt(c, v) { this.op.filters.push(['lt', c, v]); return this; }
    ilike(c, v) { this.op.filters.push(['ilike', c, v]); return this; }
    order(c, o) { this.op.order.push([c, !(o && o.ascending === false)]); return this; }
    limit(n) { this.op.limit = n; return this; }
    range(a, b) { this.op.range = [a, b]; return this; }
    single() { this.op.single = true; return this; }
    maybeSingle() { this.op.maybe = true; return this; }
    then(res, rej) { return call(this.op).then(res, rej); }
  }
  function session() {
    const u = localStorage.getItem('mock-user');
    return u ? { access_token: localStorage.getItem('mock-token'), user: JSON.parse(u) } : null;
  }
  const handlers = [];
  let since = 0;
  setInterval(async () => {
    if (!handlers.length) return;
    const r = await call({ kind: 'events', since });
    for (const e of r.events) { since = e.at; handlers.forEach((h) => h({ eventType: e.type, new: { error_id: e.error_id } })); }
  }, 700);
  window.supabase = { createClient(url, key) {
    if (!/^https:/.test(url) || !key) throw new Error('bad config');
    return {
      from: (t) => new Q(t),
      rpc: (name, args) => call({ kind: 'rpc', name, args }),
      auth: {
        async signInWithPassword({ email, password }) {
          const r = await call({ kind: 'login', email, password });
          if (r.error) return { data: {}, error: r.error };
          localStorage.setItem('mock-token', r.token); localStorage.setItem('mock-user', JSON.stringify(r.user));
          return { data: { session: session() }, error: null };
        },
        async getSession() { return { data: { session: session() }, error: null }; },
        async signOut() { localStorage.removeItem('mock-token'); localStorage.removeItem('mock-user'); return { error: null }; },
        async updateUser(p) { return call({ kind: 'updateUser', password: p.password }); },
      },
      storage: { from: (bucket) => ({
        async upload(path, blob, opts) {
          const b64 = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
          return call({ kind: 'upload', bucket, path, data: b64, type: blob.type, upsert: opts && opts.upsert });
        },
        createSignedUrls: (paths, seconds) => call({ kind: 'sign', paths, seconds }),
      }) },
      channel: () => { const ch = { on(a, b, h) { handlers.push(h); return ch; }, subscribe(cb) { setTimeout(() => cb && cb('SUBSCRIBED'), 50); return ch; } }; return ch; },
    };
  } };
})();`;

function handleMock(body) {
  const uid = S.tokens.get(body.token) || null;
  S.calls.push(body.kind + ':' + (body.name || body.table || ''));
  try {
    switch (body.kind) {
      case 'login': {
        const u = S.users.find((x) => x.email === body.email && x.password === body.password);
        if (!u) return { error: { message: 'Invalid login credentials' } };
        const token = crypto.randomBytes(12).toString('hex');
        S.tokens.set(token, u.id);
        return { token, user: { id: u.id, email: u.email } };
      }
      case 'updateUser': S.users.find((x) => x.id === uid).password = body.password; return { data: {}, error: null };
      case 'query': if (!uid) fail('JWT expired'); return { ...query(body, uid), error: null };
      case 'rpc': if (!uid && body.name !== 'sheet_feed') fail('JWT expired'); return { data: callRpc(body.name, body.args, uid), error: null };
      case 'upload': {
        if (body.bucket !== 'photos') fail('Bucket not found');
        if (body.path.split('/')[0] !== uid) return { data: null, error: { message: 'new row violates row-level security policy', statusCode: '403' } };
        if (S.photos.has(body.path)) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
        S.photos.set(body.path, { type: body.type, data: Buffer.from(body.data, 'base64') });
        return { data: { path: body.path }, error: null };
      }
      case 'sign': return { data: body.paths.map((p) => ({ path: p, signedUrl: `${base}/mockphoto/${encodeURIComponent(p)}`, error: null })), error: null };
      case 'events': return { events: S.events.filter((e) => e.at > body.since) };
      default: return fail('unknown op');
    }
  } catch (e) {
    return { data: null, error: { message: e.message, code: e.code } };
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
let base = '';
function start() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/mock') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(handleMock(JSON.parse(b)))); });
      return;
    }
    if (u.pathname === '/cdn/supabase.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(CLIENT); }
    if (u.pathname.startsWith('/mockphoto/')) {
      const p = S.photos.get(decodeURIComponent(u.pathname.slice(11)));
      if (!p) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': p.type }); return res.end(p.data);
    }
    if (u.pathname.startsWith('/site/')) {
      let rel = decodeURIComponent(u.pathname.slice(6)) || 'index.html';
      if (rel.endsWith('/')) rel += 'index.html';
      if (rel === 'config.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end("window.PTS_CONFIG = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_KEY: 'sb_publishable_test', LOGIN_EMAIL_DOMAIN: 'factory.test' };");
      }
      const file = path.resolve(SITE, rel);
      if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404); res.end();
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => { base = `http://localhost:${server.address().port}`; ok({ server, base }); }));
}

module.exports = { start, S, addUser, FUNCS, COLS, pgNow };
