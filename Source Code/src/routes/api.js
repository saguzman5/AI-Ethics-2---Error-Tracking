'use strict';
const fs = require('node:fs');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const reports = require('../reports');
const photos = require('../photos');
const events = require('../events');
const exporters = require('../exporters');
const qrcode = require('../qrcode');
const qrpayload = require('../qrpayload');
const time = require('../time');
const { Router, HttpError, readJson, sendJson, send } = require('../http');

const r = new Router();
const { requireUser, requireManager } = auth;

const publicUser = (u) => u && { id: u.id, username: u.username, full_name: u.full_name, role: u.role };

// ---------------------------------------------------------------- auth
r.post('/api/auth/login', async (ctx) => {
  const body = await readJson(ctx.req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) throw new HttpError(400, 'Enter your username and password');
  const key = `${ctx.ip}|${username.toLowerCase()}`;
  auth.checkThrottle(key);
  const user = db.one('SELECT * FROM users WHERE username = ?', username);
  if (!user || !user.active || !auth.verifyPassword(password, user.password_hash)) {
    auth.recordFailure(key);
    throw new HttpError(401, 'Incorrect username or password');
  }
  auth.clearFailures(key);
  const { token, expires } = auth.createSession(user);
  ctx.res.setHeader('Set-Cookie', auth.sessionCookie(ctx.req, token, expires));
  sendJson(ctx.res, 200, { user: publicUser(user) });
});

r.post('/api/auth/logout', (ctx) => {
  auth.destroySession(ctx.req);
  ctx.res.setHeader('Set-Cookie', auth.sessionCookie(ctx.req, null));
  sendJson(ctx.res, 200, { ok: true });
});

r.get('/api/auth/me', requireUser, (ctx) => {
  sendJson(ctx.res, 200, { user: publicUser(ctx.user), timezone: config.TIMEZONE, require_photo: config.REQUIRE_PHOTO });
});

r.post('/api/auth/password', requireUser, async (ctx) => {
  const body = await readJson(ctx.req);
  const row = db.one('SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
  if (!auth.verifyPassword(String(body.current_password || ''), row.password_hash)) throw new HttpError(400, 'Current password is incorrect');
  auth.validatePassword(body.new_password);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(body.new_password), ctx.user.id);
  sendJson(ctx.res, 200, { ok: true });
});

// ---------------------------------------------------------------- lookup lists
r.get('/api/lists', requireUser, (ctx) => {
  sendJson(ctx.res, 200, {
    stages: db.all('SELECT id, name FROM production_stages WHERE active = 1 ORDER BY sort_order, name'),
    categories: db.all('SELECT id, name FROM error_categories WHERE active = 1 ORDER BY sort_order, name'),
    severities: reports.SEVERITIES,
    statuses: reports.STATUSES,
  });
});

r.get('/api/admin/lists', requireManager, (ctx) => {
  sendJson(ctx.res, 200, {
    stages: db.all(`SELECT s.id, s.name, s.sort_order, s.active, (SELECT COUNT(*) FROM error_reports e WHERE e.stage_id = s.id) AS used
                      FROM production_stages s ORDER BY s.sort_order, s.name`),
    categories: db.all(`SELECT c.id, c.name, c.sort_order, c.active, (SELECT COUNT(*) FROM error_reports e WHERE e.category_id = c.id) AS used
                          FROM error_categories c ORDER BY c.sort_order, c.name`),
  });
});

for (const [path, table, label] of [['stages', 'production_stages', 'Stage'], ['categories', 'error_categories', 'Error type']]) {
  r.post(`/api/admin/${path}`, requireManager, async (ctx) => {
    const body = await readJson(ctx.req);
    const name = String(body.name || '').trim();
    if (name.length < 2 || name.length > 60) throw new HttpError(400, `${label} name must be 2-60 characters`);
    if (db.one(`SELECT 1 FROM ${table} WHERE name = ?`, name)) throw new HttpError(409, `${label} "${name}" already exists`);
    const sort = Number.isInteger(body.sort_order) ? body.sort_order : (db.one(`SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM ${table}`).n);
    const info = db.run(`INSERT INTO ${table}(name, sort_order) VALUES (?, ?)`, name, sort);
    events.publish('lists-changed');
    sendJson(ctx.res, 201, db.one(`SELECT * FROM ${table} WHERE id = ?`, info.lastInsertRowid));
  });
  r.patch(`/api/admin/${path}/:id`, requireManager, async (ctx) => {
    const body = await readJson(ctx.req);
    const id = Number(ctx.params.id);
    const cur = db.one(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!cur) throw new HttpError(404, `${label} not found`);
    const name = body.name !== undefined ? String(body.name).trim() : cur.name;
    if (name.length < 2 || name.length > 60) throw new HttpError(400, `${label} name must be 2-60 characters`);
    if (name.toLowerCase() !== cur.name.toLowerCase() && db.one(`SELECT 1 FROM ${table} WHERE name = ?`, name)) throw new HttpError(409, `${label} "${name}" already exists`);
    const sort = Number.isInteger(body.sort_order) ? body.sort_order : cur.sort_order;
    const active = typeof body.active === 'boolean' ? (body.active ? 1 : 0) : cur.active;
    db.run(`UPDATE ${table} SET name = ?, sort_order = ?, active = ? WHERE id = ?`, name, sort, active, id);
    events.publish('lists-changed');
    events.publish('reports-changed', { action: 'lists' });
    sendJson(ctx.res, 200, db.one(`SELECT * FROM ${table} WHERE id = ?`, id));
  });
}

// ---------------------------------------------------------------- products
r.get('/api/products/lookup', requireUser, (ctx) => {
  const parsed = qrpayload.parse(ctx.query.code);
  if (!parsed) throw new HttpError(400, 'This QR code does not contain a valid Box ID');
  const p = db.one(`SELECT p.box_id, p.order_id, COALESCE(p.product_name, o.product_name) AS product_name, o.customer
                      FROM products p JOIN production_orders o ON o.order_id = p.order_id WHERE p.box_id = ?`, parsed.box_id);
  if (p) {
    if (parsed.order_id && parsed.order_id !== p.order_id) {
      throw new HttpError(409, `QR code says order ${parsed.order_id}, but box ${p.box_id} is registered to order ${p.order_id}. Report this label to a manager.`);
    }
    const open = db.all(`SELECT e.error_id, s.name AS stage, c.name AS error_type, e.severity, e.status, e.reported_at
                           FROM error_reports e JOIN production_stages s ON s.id = e.stage_id JOIN error_categories c ON c.id = e.category_id
                          WHERE e.box_id = ? AND e.status <> 'Resolved' ORDER BY e.reported_at DESC LIMIT 5`, p.box_id)
      .map((e) => ({ ...e, reported_at_local: time.formatLocal(e.reported_at, config.TIMEZONE) }));
    return sendJson(ctx.res, 200, { ...p, registered: true, open_errors: open });
  }
  if (parsed.order_id && config.AUTO_REGISTER_PRODUCTS) {
    return sendJson(ctx.res, 200, { box_id: parsed.box_id, order_id: parsed.order_id, product_name: null, registered: false, open_errors: [] });
  }
  throw new HttpError(404, `Box ${parsed.box_id} is not registered. Ask a manager to register it.`);
});

r.get('/api/admin/orders', requireManager, (ctx) => {
  sendJson(ctx.res, 200, db.all(`SELECT o.*, (SELECT COUNT(*) FROM products p WHERE p.order_id = o.order_id) AS boxes,
                                        (SELECT COUNT(*) FROM error_reports e WHERE e.order_id = o.order_id) AS errors
                                   FROM production_orders o ORDER BY o.created_at DESC LIMIT 500`));
});

r.get('/api/admin/products', requireManager, (ctx) => {
  const q = String(ctx.query.q || '').trim();
  const order = String(ctx.query.order_id || '').trim();
  const where = [];
  const p = [];
  if (q) { where.push('(p.box_id LIKE ? OR p.order_id LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  if (order) { where.push('p.order_id = ?'); p.push(order); }
  const rows = db.all(`SELECT p.box_id, p.order_id, COALESCE(p.product_name, o.product_name) AS product_name, p.produced_at,
                              (SELECT COUNT(*) FROM error_reports e WHERE e.box_id = p.box_id) AS errors
                         FROM products p JOIN production_orders o ON o.order_id = p.order_id
                         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.produced_at DESC, p.box_id LIMIT 1000`, ...p);
  sendJson(ctx.res, 200, rows.map((x) => ({ ...x, produced_at_local: time.formatLocal(x.produced_at, config.TIMEZONE) })));
});

// Registers an order and either one box or a numbered batch of boxes.
r.post('/api/admin/products', requireManager, async (ctx) => {
  const body = await readJson(ctx.req);
  const orderId = String(body.order_id || '').trim();
  if (!qrpayload.ID_RE.test(orderId)) throw new HttpError(400, 'Order ID is required (letters, numbers, . _ - /)');
  const productName = String(body.product_name || '').trim().slice(0, 100) || null;
  const customer = String(body.customer || '').trim().slice(0, 100) || null;
  let boxIds;
  if (body.box_id) {
    const b = String(body.box_id).trim();
    if (!qrpayload.ID_RE.test(b)) throw new HttpError(400, 'Box ID contains invalid characters');
    boxIds = [b];
  } else {
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new HttpError(400, 'Enter a Box ID or a quantity between 1 and 1000');
    const prefix = String(body.box_prefix || `BOX-${orderId}`).trim();
    if (!qrpayload.ID_RE.test(prefix + '-0001')) throw new HttpError(400, 'Box prefix contains invalid characters');
    const start = db.one('SELECT COUNT(*) AS n FROM products WHERE order_id = ?', orderId).n + 1;
    boxIds = Array.from({ length: count }, (_, i) => `${prefix}-${String(start + i).padStart(4, '0')}`);
  }
  const created = db.tx(() => {
    const existing = db.one('SELECT * FROM production_orders WHERE order_id = ?', orderId);
    if (!existing) {
      db.run('INSERT INTO production_orders(order_id, customer, product_name, quantity) VALUES (?, ?, ?, ?)',
        orderId, customer, productName, Number.isInteger(body.quantity) ? body.quantity : null);
    } else if (productName || customer) {
      db.run('UPDATE production_orders SET product_name = COALESCE(product_name, ?), customer = COALESCE(customer, ?) WHERE order_id = ?', productName, customer, orderId);
    }
    for (const b of boxIds) {
      const dup = db.one('SELECT order_id FROM products WHERE box_id = ?', b);
      if (dup) throw new HttpError(409, `Box ${b} already exists (order ${dup.order_id})`);
      db.run('INSERT INTO products(box_id, order_id, product_name) VALUES (?, ?, ?)', b, orderId, productName);
    }
    return boxIds;
  });
  events.publish('reports-changed', { action: 'products' });
  sendJson(ctx.res, 201, { order_id: orderId, box_ids: created });
});

// QR label image. The code encodes a link to the worker app with both IDs,
// so phones without in-app scanning can use their built-in camera app.
r.get('/api/admin/products/:boxId/qr.svg', requireManager, (ctx) => {
  const p = db.one('SELECT box_id, order_id FROM products WHERE box_id = ?', ctx.params.boxId);
  if (!p) throw new HttpError(404, 'Box not found');
  const url = `${exporters.baseUrl(ctx.req)}/app/?box=${encodeURIComponent(p.box_id)}&order=${encodeURIComponent(p.order_id)}`;
  send(ctx.res, 200, qrcode.toSvg(url, { size: Number(ctx.query.size) || 220 }), { 'Content-Type': 'image/svg+xml' });
});

// ---------------------------------------------------------------- reports
r.post('/api/reports', requireUser, async (ctx) => {
  const body = await readJson(ctx.req, Math.ceil(config.MAX_PHOTO_BYTES * 1.4) + 64 * 1024);
  const result = reports.createReport(body, ctx.user);
  sendJson(ctx.res, result.duplicate ? 200 : 201, result);
});

r.get('/api/reports/mine', requireUser, (ctx) => {
  const rows = db.all(`SELECT error_id, box_id, order_id, stage, error_type, severity, timestamp, status
                         FROM v_error_reports WHERE reported_by = ? ORDER BY timestamp DESC LIMIT 20`, ctx.user.id);
  sendJson(ctx.res, 200, rows.map((x) => ({ ...x, timestamp_local: time.formatLocal(x.timestamp, config.TIMEZONE) })));
});

r.get('/api/reports', requireManager, (ctx) => {
  const f = reports.parseFilters(ctx.query);
  sendJson(ctx.res, 200, reports.listReports(f, ctx.query));
});

r.get('/api/reports/:id', requireManager, (ctx) => sendJson(ctx.res, 200, reports.getReport(ctx.params.id)));

r.post('/api/reports/:id/status', requireManager, async (ctx) => {
  const body = await readJson(ctx.req);
  sendJson(ctx.res, 200, reports.changeStatus(ctx.params.id, body, ctx.user));
});

r.patch('/api/reports/:id', requireManager, async (ctx) => {
  const body = await readJson(ctx.req);
  sendJson(ctx.res, 200, reports.correctReport(ctx.params.id, body, ctx.user));
});

r.get('/api/metrics', requireManager, (ctx) => sendJson(ctx.res, 200, reports.metrics(reports.parseFilters(ctx.query))));

r.get('/api/events', requireManager, (ctx) => { events.subscribe(ctx.res); ctx.keepOpen = true; });

// ---------------------------------------------------------------- photos
r.get('/api/photos/:id', (ctx) => {
  const photo = photos.load(ctx.params.id);
  if (!photo) throw new HttpError(404, 'Photo not found');
  const signed = auth.verifyPhotoSignature(photo.id, ctx.query.exp, ctx.query.sig);
  const allowed = signed || (ctx.user && (ctx.user.role === 'manager' || ctx.user.id === photo.uploaded_by));
  if (!allowed) throw new HttpError(ctx.user ? 403 : 401, 'Not allowed to view this photo');
  const body = fs.readFileSync(photo.abs);
  send(ctx.res, 200, body, {
    'Content-Type': photo.mime_type,
    'Content-Length': body.length,
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `inline; filename="${photo.id}.${photo.mime_type.split('/')[1]}"`,
  });
});

// ---------------------------------------------------------------- exports & feeds
const stamp = () => time.formatLocal(new Date().toISOString(), config.TIMEZONE).replace(/[: ]/g, '-');

r.get('/api/export/reports.csv', requireManager, (ctx) => {
  const { rows } = reports.listReports(reports.parseFilters(ctx.query), { ...ctx.query, limit: 50000 });
  send(ctx.res, 200, exporters.toCsv(ctx.req, rows), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="error-reports-${stamp()}.csv"`,
  });
});

r.get('/api/export/reports.xlsx', requireManager, (ctx) => {
  const { rows } = reports.listReports(reports.parseFilters(ctx.query), { ...ctx.query, limit: 50000 });
  send(ctx.res, 200, exporters.toXlsx(ctx.req, rows), {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="error-reports-${stamp()}.xlsx"`,
  });
});

// Read-only feed for Google Sheets / Excel Power Query, protected by a
// rotatable key instead of a session.
r.get('/api/feed/reports.csv', (ctx) => {
  const key = db.getSetting('sheet_feed_key');
  const given = Buffer.from(String(ctx.query.key || ''));
  const expected = Buffer.from(key);
  if (given.length !== expected.length || !require('node:crypto').timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid feed key');
  const { rows } = reports.listReports(reports.parseFilters(ctx.query), { sort: 'timestamp', dir: 'asc', limit: 50000 });
  send(ctx.res, 200, exporters.toCsv(ctx.req, rows), { 'Content-Type': 'text/csv; charset=utf-8' });
});

r.get('/api/admin/feed', requireManager, (ctx) => {
  const key = db.getSetting('sheet_feed_key');
  sendJson(ctx.res, 200, { key, csv_url: `${exporters.baseUrl(ctx.req)}/api/feed/reports.csv?key=${key}` });
});

r.post('/api/admin/feed/rotate', requireManager, (ctx) => {
  db.setSetting('sheet_feed_key', require('node:crypto').randomBytes(24).toString('base64url'));
  const key = db.getSetting('sheet_feed_key');
  sendJson(ctx.res, 200, { key, csv_url: `${exporters.baseUrl(ctx.req)}/api/feed/reports.csv?key=${key}` });
});

// ---------------------------------------------------------------- users
r.get('/api/admin/users', requireManager, (ctx) => {
  sendJson(ctx.res, 200, db.all(`SELECT u.id, u.username, u.full_name, u.role, u.active, u.created_at,
                                        (SELECT COUNT(*) FROM error_reports e WHERE e.reported_by = u.id) AS reports
                                   FROM users u ORDER BY u.role DESC, u.full_name`));
});

r.post('/api/admin/users', requireManager, async (ctx) => {
  const body = await readJson(ctx.req);
  const username = String(body.username || '').trim();
  const fullName = String(body.full_name || '').trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Username must be 3-40 letters, numbers, . _ or -');
  if (fullName.length < 2 || fullName.length > 80) throw new HttpError(400, 'Full name is required');
  if (!['worker', 'manager'].includes(body.role)) throw new HttpError(400, 'Role must be worker or manager');
  auth.validatePassword(body.password);
  if (db.one('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, `Username "${username}" is taken`);
  const info = db.run('INSERT INTO users(username, full_name, role, password_hash) VALUES (?, ?, ?, ?)',
    username, fullName, body.role, auth.hashPassword(body.password));
  sendJson(ctx.res, 201, { id: Number(info.lastInsertRowid), username, full_name: fullName, role: body.role, active: 1 });
});

r.patch('/api/admin/users/:id', requireManager, async (ctx) => {
  const body = await readJson(ctx.req);
  const id = Number(ctx.params.id);
  const cur = db.one('SELECT * FROM users WHERE id = ?', id);
  if (!cur) throw new HttpError(404, 'User not found');
  const role = body.role !== undefined ? body.role : cur.role;
  if (!['worker', 'manager'].includes(role)) throw new HttpError(400, 'Role must be worker or manager');
  const active = typeof body.active === 'boolean' ? (body.active ? 1 : 0) : cur.active;
  const fullName = body.full_name !== undefined ? String(body.full_name).trim() : cur.full_name;
  if (fullName.length < 2 || fullName.length > 80) throw new HttpError(400, 'Full name is required');
  if (cur.role === 'manager' && (role !== 'manager' || !active)) {
    if (id === ctx.user.id) throw new HttpError(400, 'You cannot remove your own manager access');
    const others = db.one("SELECT COUNT(*) AS n FROM users WHERE role = 'manager' AND active = 1 AND id <> ?", id).n;
    if (!others) throw new HttpError(400, 'At least one active manager is required');
  }
  let hash = cur.password_hash;
  if (body.password) { auth.validatePassword(body.password); hash = auth.hashPassword(body.password); }
  db.run('UPDATE users SET full_name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?', fullName, role, active, hash, id);
  if (!active || body.password || role !== cur.role) db.run('DELETE FROM sessions WHERE user_id = ?', id);
  sendJson(ctx.res, 200, { id, username: cur.username, full_name: fullName, role, active });
});

module.exports = r;
