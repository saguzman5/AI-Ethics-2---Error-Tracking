'use strict';
const db = require('./db');
const config = require('./config');
const photos = require('./photos');
const events = require('./events');
const time = require('./time');
const { HttpError } = require('./http');
const { ID_RE } = require('./qrpayload');

const SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];
const STATUSES = ['Open', 'Under Review', 'In Rework', 'Resolved'];

// ---------------------------------------------------------------------------
// Filters (shared by dashboard, spreadsheet, exports and metrics)
// ---------------------------------------------------------------------------
const list = (v) => (v === undefined || v === null || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));

function parseFilters(q) {
  const f = {
    from: /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : null,
    to: /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : null,
    stage_id: list(q.stage_id).map(Number).filter(Number.isInteger),
    category_id: list(q.category_id).map(Number).filter(Number.isInteger),
    severity: list(q.severity).filter((s) => SEVERITIES.includes(s)),
    status: list(q.status).filter((s) => STATUSES.includes(s)),
    order_id: (q.order_id || '').trim().slice(0, 64) || null,
    box_id: (q.box_id || '').trim().slice(0, 64) || null,
  };
  return f;
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

// WHERE clause over v_error_reports.
function reportWhere(f) {
  const w = [];
  const p = [];
  if (f.from) { w.push('timestamp >= ?'); p.push(time.localMidnightUtc(f.from, config.TIMEZONE)); }
  if (f.to) { w.push('timestamp < ?'); p.push(time.localMidnightUtc(time.addDays(f.to, 1), config.TIMEZONE)); }
  const inList = (col, vals) => { if (vals.length) { w.push(`${col} IN (${vals.map(() => '?').join(',')})`); p.push(...vals); } };
  inList('stage_id', f.stage_id);
  inList('category_id', f.category_id);
  inList('severity', f.severity);
  inList('status', f.status);
  if (f.order_id) { w.push("order_id LIKE ? ESCAPE '\\'"); p.push(`%${likeEscape(f.order_id)}%`); }
  if (f.box_id) { w.push("box_id LIKE ? ESCAPE '\\'"); p.push(`%${likeEscape(f.box_id)}%`); }
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}

// WHERE clause over products for the rework-rate denominator. Only filters
// that describe products apply (date produced, order, box). Stage, type,
// severity and status describe errors, not products, so they are ignored.
function productWhere(f) {
  const w = [];
  const p = [];
  if (f.from) { w.push('produced_at >= ?'); p.push(time.localMidnightUtc(f.from, config.TIMEZONE)); }
  if (f.to) { w.push('produced_at < ?'); p.push(time.localMidnightUtc(time.addDays(f.to, 1), config.TIMEZONE)); }
  if (f.order_id) { w.push("order_id LIKE ? ESCAPE '\\'"); p.push(`%${likeEscape(f.order_id)}%`); }
  if (f.box_id) { w.push("box_id LIKE ? ESCAPE '\\'"); p.push(`%${likeEscape(f.box_id)}%`); }
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}

const SORTABLE = {
  error_id: 'error_id', box_id: 'box_id', order_id: 'order_id', stage: 'stage', error_type: 'error_type',
  severity: "CASE severity WHEN 'Critical' THEN 4 WHEN 'High' THEN 3 WHEN 'Medium' THEN 2 ELSE 1 END",
  timestamp: 'timestamp',
  status: "CASE status WHEN 'Open' THEN 1 WHEN 'Under Review' THEN 2 WHEN 'In Rework' THEN 3 ELSE 4 END",
  description: 'description', resolved_at: 'resolved_at',
};

function present(r) {
  return {
    error_id: r.error_id,
    box_id: r.box_id,
    order_id: r.order_id,
    stage: r.stage,
    error_type: r.error_type,
    severity: r.severity,
    timestamp: r.timestamp,
    timestamp_local: time.formatLocal(r.timestamp, config.TIMEZONE),
    status: r.status,
    photo_image: r.photo_image ? `/api/photos/${r.photo_image}` : null,
    description: r.description,
    requires_rework: !!r.requires_rework,
    resolution_notes: r.resolution_notes,
    status_changed_at: r.status_changed_at,
    resolved_at: r.resolved_at,
    resolved_at_local: r.resolved_at ? time.formatLocal(r.resolved_at, config.TIMEZONE) : null,
    updated_at: r.updated_at,
    stage_id: r.stage_id,
    category_id: r.category_id,
    reported_by_name: r.reported_by_name,
    product_name: r.product_name,
  };
}

function listReports(f, { sort = 'timestamp', dir = 'desc', limit = 5000, offset = 0 } = {}) {
  const where = reportWhere(f);
  const col = SORTABLE[sort] || SORTABLE.timestamp;
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const lim = Math.min(Math.max(parseInt(limit, 10) || 5000, 1), 50000);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  // error_id is zero-padded, so it is a stable tie-breaker in creation order.
  const rows = db.all(`SELECT * FROM v_error_reports ${where.sql} ORDER BY ${col} ${order}, error_id ${order} LIMIT ? OFFSET ?`,
    ...where.params, lim, off);
  const total = db.one(`SELECT COUNT(*) AS n FROM v_error_reports ${where.sql}`, ...where.params).n;
  return { total, rows: rows.map(present) };
}

function getReport(errorId) {
  const r = db.one('SELECT * FROM v_error_reports WHERE error_id = ?', errorId);
  if (!r) throw new HttpError(404, `Error report ${errorId} not found`);
  const history = db.all(
    `SELECT h.from_status, h.to_status, h.note, h.changed_at, u.full_name AS changed_by
       FROM error_status_history h JOIN users u ON u.id = h.changed_by
      WHERE h.error_id = ? ORDER BY h.changed_at, h.id`, errorId)
    .map((h) => ({ ...h, changed_at_local: time.formatLocal(h.changed_at, config.TIMEZONE) }));
  const revisions = db.all(
    `SELECT v.field, v.old_value, v.new_value, v.changed_at, u.full_name AS changed_by
       FROM error_report_revisions v JOIN users u ON u.id = v.changed_by
      WHERE v.error_id = ? ORDER BY v.changed_at, v.id`, errorId)
    .map((v) => ({ ...v, changed_at_local: time.formatLocal(v.changed_at, config.TIMEZONE) }));
  return { ...present(r), history, revisions };
}

// ---------------------------------------------------------------------------
// Creating reports
// ---------------------------------------------------------------------------
function str(v, name, { min = 0, max = 1000, required = true } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `${name} is required`);
  if (s && s.length < min) throw new HttpError(400, `${name} must be at least ${min} characters`);
  if (s.length > max) throw new HttpError(400, `${name} must be at most ${max} characters`);
  return s;
}

function createReport(body, user) {
  const submissionId = str(body.client_submission_id, 'client_submission_id', { max: 64 });
  if (!/^[A-Za-z0-9-]{8,64}$/.test(submissionId)) throw new HttpError(400, 'client_submission_id is invalid');

  // Idempotency: a retried submission returns the original report.
  const existing = db.one('SELECT error_id FROM error_reports WHERE client_submission_id = ?', submissionId);
  if (existing) return { duplicate: true, report: getReport(existing.error_id) };

  const boxId = str(body.box_id, 'Box ID', { max: 64 });
  if (!ID_RE.test(boxId)) throw new HttpError(400, 'Box ID contains invalid characters');
  const orderIdIn = body.order_id ? str(body.order_id, 'Order ID', { max: 64 }) : null;
  if (orderIdIn && !ID_RE.test(orderIdIn)) throw new HttpError(400, 'Order ID contains invalid characters');

  const stageId = Number(body.stage_id);
  const stage = Number.isInteger(stageId) && db.one('SELECT id, name FROM production_stages WHERE id = ? AND active = 1', stageId);
  if (!stage) throw new HttpError(400, 'Select a valid production stage');

  const categoryId = Number(body.category_id);
  const category = Number.isInteger(categoryId) && db.one('SELECT id, name FROM error_categories WHERE id = ? AND active = 1', categoryId);
  if (!category) throw new HttpError(400, 'Select a valid error type');

  if (!SEVERITIES.includes(body.severity)) throw new HttpError(400, 'Select a severity: Low, Medium, High or Critical');
  const description = str(body.description, 'Description', { min: 3, max: 1000 });

  if (!body.photo && config.REQUIRE_PHOTO) throw new HttpError(400, 'A photo is required');

  // Resolve the product (and register it if the QR code carried both IDs).
  let product = db.one('SELECT box_id, order_id FROM products WHERE box_id = ?', boxId);
  if (!product && !(config.AUTO_REGISTER_PRODUCTS && orderIdIn)) {
    throw new HttpError(404, `Box ${boxId} is not registered. Ask a manager to register it.`);
  }
  if (product && orderIdIn && product.order_id !== orderIdIn) {
    throw new HttpError(409, `Box ${boxId} belongs to order ${product.order_id}, not ${orderIdIn}`);
  }

  // Probable duplicate: same box, stage and error type still unresolved.
  if (!body.confirm_duplicate) {
    const since = new Date(Date.now() - config.DUPLICATE_WINDOW_MINUTES * 60000).toISOString();
    const dup = db.one(
      `SELECT error_id, reported_at FROM error_reports
        WHERE box_id = ? AND stage_id = ? AND category_id = ? AND status <> 'Resolved' AND reported_at >= ?
        ORDER BY reported_at DESC LIMIT 1`, boxId, stage.id, category.id, since);
    if (dup) {
      throw new HttpError(409, `A similar report (${dup.error_id}) for this box was submitted at ${time.formatLocal(dup.reported_at, config.TIMEZONE)}.`,
        { code: 'POSSIBLE_DUPLICATE', error_id: dup.error_id });
    }
  }

  const photo = body.photo ? photos.prepare(body.photo, user.id) : null;
  let errorId;
  try {
    errorId = db.tx(() => {
      // Re-check idempotency inside the write lock (two identical requests racing).
      const again = db.one('SELECT error_id FROM error_reports WHERE client_submission_id = ?', submissionId);
      if (again) return { existing: again.error_id };

      if (!product) {
        product = db.one('SELECT box_id, order_id FROM products WHERE box_id = ?', boxId);
        if (!product) {
          db.run('INSERT OR IGNORE INTO production_orders(order_id) VALUES (?)', orderIdIn);
          db.run('INSERT INTO products(box_id, order_id) VALUES (?, ?)', boxId, orderIdIn);
          product = { box_id: boxId, order_id: orderIdIn };
        }
      }
      if (photo) photo.insert();
      const seq = db.one('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM error_reports').n;
      const id = `ERR-${String(seq).padStart(6, '0')}`;
      const now = db.nowIso();
      db.run(
        `INSERT INTO error_reports(seq, error_id, client_submission_id, box_id, order_id, stage_id, category_id,
                                   severity, description, photo_id, status, reported_by, reported_at, status_changed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?)`,
        seq, id, submissionId, product.box_id, product.order_id, stage.id, category.id,
        body.severity, description, photo ? photo.id : null, user.id, now, now, now);
      db.run(`INSERT INTO error_status_history(error_id, from_status, to_status, note, changed_by, changed_at)
              VALUES (?, NULL, 'Open', 'Report submitted', ?, ?)`, id, user.id, now);
      return { created: id };
    });
  } catch (err) {
    if (photo) photo.discard();
    throw err;
  }

  if (errorId.existing) {
    if (photo) photo.discard();
    return { duplicate: true, report: getReport(errorId.existing) };
  }
  events.publish('reports-changed', { error_id: errorId.created, action: 'created' });
  return { duplicate: false, report: getReport(errorId.created) };
}

// ---------------------------------------------------------------------------
// Manager updates
// ---------------------------------------------------------------------------
function checkVersion(current, expected) {
  if (expected && expected !== current.updated_at) {
    throw new HttpError(409, 'This report was changed by someone else. Reload it and try again.', { code: 'STALE' });
  }
}

function changeStatus(errorId, body, user) {
  const to = body.status;
  if (!STATUSES.includes(to)) throw new HttpError(400, 'Invalid status');
  const note = str(body.note, 'Note', { required: false, max: 2000 });

  const result = db.tx(() => {
    const cur = db.one('SELECT * FROM error_reports WHERE error_id = ?', errorId);
    if (!cur) throw new HttpError(404, `Error report ${errorId} not found`);
    checkVersion(cur, body.expected_updated_at);
    if (cur.status === to && !note) throw new HttpError(400, `Report is already "${to}"`);
    if (to === 'Resolved' && !note) throw new HttpError(400, 'Add a resolution note describing the corrective action');
    if (cur.status === 'Resolved' && to !== 'Resolved' && !note) throw new HttpError(400, 'Add a note explaining why the report is being reopened');

    const now = db.nowIso();
    let requiresRework = cur.requires_rework;
    if (to === 'In Rework') requiresRework = 1;
    if (typeof body.requires_rework === 'boolean') requiresRework = body.requires_rework ? 1 : 0;
    if (to === 'In Rework' && !requiresRework) throw new HttpError(400, '"In Rework" always means rework is required');
    if (requiresRework !== cur.requires_rework) {
      db.run('INSERT INTO error_report_revisions(error_id, field, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
        errorId, 'requires_rework', cur.requires_rework ? 'Yes' : 'No', requiresRework ? 'Yes' : 'No', user.id, now);
    }
    const statusChanged = cur.status !== to;
    const resolvedAt = to === 'Resolved' ? (statusChanged ? now : cur.resolved_at) : null;
    db.run(
      `UPDATE error_reports
          SET status = ?, requires_rework = ?, resolution_notes = COALESCE(?, resolution_notes),
              status_changed_at = ?, resolved_at = ?, updated_at = ?
        WHERE error_id = ?`,
      to, requiresRework, note || null, statusChanged ? now : cur.status_changed_at, resolvedAt, now, errorId);
    db.run('INSERT INTO error_status_history(error_id, from_status, to_status, note, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
      errorId, cur.status, to, note || null, user.id, now);
    return getReport(errorId);
  });
  events.publish('reports-changed', { error_id: errorId, action: 'status' });
  return result;
}

const CORRECTABLE = {
  stage_id: { label: 'stage', lookup: 'SELECT name FROM production_stages WHERE id = ?' },
  category_id: { label: 'error_type', lookup: 'SELECT name FROM error_categories WHERE id = ?' },
  severity: { label: 'severity' },
  requires_rework: { label: 'requires_rework' },
};

// Corrects classification fields. The original description, photo, box,
// order and timestamp are immutable; every change is logged as a revision.
function correctReport(errorId, body, user) {
  const result = db.tx(() => {
    const cur = db.one('SELECT * FROM error_reports WHERE error_id = ?', errorId);
    if (!cur) throw new HttpError(404, `Error report ${errorId} not found`);
    checkVersion(cur, body.expected_updated_at);
    const now = db.nowIso();
    const sets = [];
    const vals = [];
    for (const [field, meta] of Object.entries(CORRECTABLE)) {
      if (body[field] === undefined) continue;
      let next = body[field];
      if (field === 'stage_id' || field === 'category_id') {
        next = Number(next);
        const table = field === 'stage_id' ? 'production_stages' : 'error_categories';
        if (!Number.isInteger(next) || !db.one(`SELECT 1 FROM ${table} WHERE id = ?`, next)) throw new HttpError(400, `Invalid ${meta.label}`);
      } else if (field === 'severity') {
        if (!SEVERITIES.includes(next)) throw new HttpError(400, 'Invalid severity');
      } else if (field === 'requires_rework') {
        if (typeof next !== 'boolean') throw new HttpError(400, 'requires_rework must be true or false');
        if (!next && cur.status === 'In Rework') throw new HttpError(400, 'A report in rework always requires rework');
        next = next ? 1 : 0;
      }
      if (next === cur[field]) continue;
      const show = (v) => (meta.lookup ? db.one(meta.lookup, v).name : field === 'requires_rework' ? (v ? 'Yes' : 'No') : v);
      db.run('INSERT INTO error_report_revisions(error_id, field, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
        errorId, meta.label, String(show(cur[field])), String(show(next)), user.id, now);
      sets.push(`${field} = ?`);
      vals.push(next);
    }
    if (!sets.length) throw new HttpError(400, 'No changes to save');
    db.run(`UPDATE error_reports SET ${sets.join(', ')}, updated_at = ? WHERE error_id = ?`, ...vals, now, errorId);
    return getReport(errorId);
  });
  events.publish('reports-changed', { error_id: errorId, action: 'corrected' });
  return result;
}

// ---------------------------------------------------------------------------
// Metrics. Formulas are documented in Documentation/METRICS.md.
// ---------------------------------------------------------------------------
function metrics(f) {
  const where = reportWhere(f);
  const rows = db.all(`SELECT error_id, box_id, stage, error_type, severity, status, timestamp, resolved_at, requires_rework
                         FROM v_error_reports ${where.sql}`, ...where.params);
  const pw = productWhere(f);
  const productsInScope = db.one(`SELECT COUNT(*) AS n FROM products ${pw.sql}`, ...pw.params).n;

  const count = (pred) => rows.filter(pred).length;
  const tally = (key) => {
    const m = new Map();
    for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + 1);
    return [...m.entries()].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };

  const affected = new Set(rows.map((r) => r.box_id));
  const reworkBoxes = new Set(rows.filter((r) => r.requires_rework).map((r) => r.box_id));
  const resolved = rows.filter((r) => r.status === 'Resolved' && r.resolved_at);
  const resolutionHours = resolved.map((r) => (Date.parse(r.resolved_at) - Date.parse(r.timestamp)) / 3600000);
  const avg = resolutionHours.length ? resolutionHours.reduce((a, b) => a + b, 0) / resolutionHours.length : null;
  const sorted = [...resolutionHours].sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;

  // Errors over time, bucketed by local calendar day (gaps filled with 0).
  const byDay = new Map();
  for (const r of rows) {
    const k = time.localDateKey(r.timestamp, config.TIMEZONE);
    byDay.set(k, (byDay.get(k) || 0) + 1);
  }
  const days = [...byDay.keys()].sort();
  const start = f.from || days[0];
  const end = f.to || (days.length ? days[days.length - 1] : null);
  const overTime = [];
  if (start && end && start <= end) {
    for (let d = start, i = 0; d <= end && i < 1000; d = time.addDays(d, 1), i++) overTime.push({ date: d, count: byDay.get(d) || 0 });
  }

  // Most common issues: error type at a stage, ranked by frequency.
  const combos = new Map();
  for (const r of rows) {
    const k = `${r.error_type}\u0000${r.stage}`;
    const c = combos.get(k) || { error_type: r.error_type, stage: r.stage, count: 0, critical_high: 0, last: r.timestamp };
    c.count++;
    if (r.severity === 'High' || r.severity === 'Critical') c.critical_high++;
    if (r.timestamp > c.last) c.last = r.timestamp;
    combos.set(k, c);
  }
  const topIssues = [...combos.values()].sort((a, b) => b.count - a.count || b.critical_high - a.critical_high).slice(0, 10)
    .map((c) => ({ ...c, share: rows.length ? c.count / rows.length : 0, last_local: time.formatLocal(c.last, config.TIMEZONE) }));

  const ratio = (a, b) => (b ? a / b : null);
  return {
    timezone: config.TIMEZONE,
    kpis: {
      total_errors: rows.length,
      unresolved_errors: count((r) => r.status !== 'Resolved'),
      high_critical_errors: count((r) => r.severity === 'High' || r.severity === 'Critical'),
      critical_errors: count((r) => r.severity === 'Critical'),
      resolved_errors: resolved.length,
      rework_rate: ratio(reworkBoxes.size, productsInScope),
    },
    status_counts: Object.fromEntries(STATUSES.map((s) => [s, count((r) => r.status === s)])),
    severity_counts: Object.fromEntries(SEVERITIES.map((s) => [s, count((r) => r.severity === s)])),
    products: {
      products_in_scope: productsInScope,
      affected_products: affected.size,
      rework_products: reworkBoxes.size,
      errors_requiring_rework: count((r) => r.requires_rework),
    },
    rates: {
      rework_rate: ratio(reworkBoxes.size, productsInScope),
      product_error_rate: ratio(affected.size, productsInScope),
      errors_per_affected_product: ratio(rows.length, affected.size),
      rework_share_of_errors: ratio(count((r) => r.requires_rework), rows.length),
      resolution_rate: ratio(resolved.length, rows.length),
    },
    resolution: {
      resolved_count: resolved.length,
      avg_resolution_hours: avg,
      median_resolution_hours: median,
    },
    errors_over_time: overTime,
    by_stage: tally('stage'),
    by_type: tally('error_type'),
    top_issues: topIssues,
  };
}

module.exports = { SEVERITIES, STATUSES, parseFilters, listReports, getReport, createReport, changeStatus, correctReport, metrics };
