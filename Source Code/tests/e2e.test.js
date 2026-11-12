'use strict';
// End-to-end test of the whole workflow against a real server and database:
// QR lookup -> submit (with photo) -> database -> spreadsheet feed/exports ->
// dashboard metrics -> manager status updates -> history, plus permissions,
// duplicate prevention and concurrent submissions.
//
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'Admin-Test-123';
process.env.TIMEZONE = 'America/Chicago';
process.env.DUPLICATE_WINDOW_MINUTES = '30';

const { start, stop } = require('../src/server');
const db = require('../src/db');

let server;
let base;

function pngDataUrl(size = 24) {
  const crc = (buf) => zlib.crc32(buf);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let i = 0; i < raw.length; i++) raw[i] = i % (size * 3 + 1) === 0 ? 0 : (i * 7919) % 256;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

async function call(method, url, { cookie, body, raw } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(username, password) {
  const res = await call('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(res.status, 200, res.text);
  return res.headers.get('set-cookie').split(';')[0];
}

let manager, worker, worker2, lists;
let sid = 0;
const newSid = () => `test-submission-${Date.now()}-${++sid}`;

test.before(async () => {
  server = await start({ port: 0, host: '127.0.0.1', quiet: true });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await stop(server);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('setup: manager creates workers and registers products', async () => {
  manager = await login('admin', 'Admin-Test-123');
  for (const [u, n] of [['w.one', 'Worker One'], ['w.two', 'Worker Two']]) {
    const r = await call('POST', '/api/admin/users', { cookie: manager, body: { username: u, full_name: n, role: 'worker', password: 'Worker-Pass-1' } });
    assert.equal(r.status, 201, r.text);
  }
  const p = await call('POST', '/api/admin/products', { cookie: manager, body: { order_id: 'PO-T-001', product_name: 'Test Cabinet', count: 40 } });
  assert.equal(p.status, 201, p.text);
  assert.equal(p.json.box_ids.length, 40);
  assert.equal(p.json.box_ids[0], 'BOX-PO-T-001-0001');
  const dup = await call('POST', '/api/admin/products', { cookie: manager, body: { order_id: 'PO-T-001', box_id: 'BOX-PO-T-001-0001' } });
  assert.equal(dup.status, 409, 'duplicate box must be rejected');
  worker = await login('w.one', 'Worker-Pass-1');
  worker2 = await login('w.two', 'Worker-Pass-1');
  lists = (await call('GET', '/api/lists', { cookie: worker })).json;
  assert.ok(lists.stages.length >= 5 && lists.categories.length >= 5);
});

test('QR lookup accepts plain, URL, JSON and key/value payloads', async () => {
  const codes = [
    'BOX-PO-T-001-0001',
    `${base}/app/?box=BOX-PO-T-001-0001&order=PO-T-001`,
    JSON.stringify({ box_id: 'BOX-PO-T-001-0001', order_id: 'PO-T-001' }),
    'BOX:BOX-PO-T-001-0001;ORDER:PO-T-001',
  ];
  for (const code of codes) {
    const r = await call('GET', `/api/products/lookup?code=${encodeURIComponent(code)}`, { cookie: worker });
    assert.equal(r.status, 200, `${code}: ${r.text}`);
    assert.equal(r.json.box_id, 'BOX-PO-T-001-0001');
    assert.equal(r.json.order_id, 'PO-T-001');
  }
  const mismatch = await call('GET', `/api/products/lookup?code=${encodeURIComponent('BOX:BOX-PO-T-001-0001;ORDER:PO-OTHER')}`, { cookie: worker });
  assert.equal(mismatch.status, 409);
  const unknown = await call('GET', '/api/products/lookup?code=BOX-NOPE', { cookie: worker });
  assert.equal(unknown.status, 404);
  const junk = await call('GET', `/api/products/lookup?code=${encodeURIComponent('<script>')}`, { cookie: worker });
  assert.equal(junk.status, 400);
});

let firstReport;
test('worker submits a report with photo; retry is idempotent', async () => {
  const body = {
    client_submission_id: newSid(), box_id: 'BOX-PO-T-001-0001', order_id: 'PO-T-001',
    stage_id: lists.stages[0].id, category_id: lists.categories[0].id, severity: 'Critical',
    description: 'Deep scratch on front panel', photo: pngDataUrl(),
  };
  const before = Date.now();
  const r = await call('POST', '/api/reports', { cookie: worker, body });
  assert.equal(r.status, 201, r.text);
  const rep = r.json.report;
  assert.match(rep.error_id, /^ERR-\d{6}$/);
  assert.equal(rep.status, 'Open');
  assert.equal(rep.box_id, 'BOX-PO-T-001-0001');
  assert.equal(rep.order_id, 'PO-T-001');
  assert.ok(Date.parse(rep.timestamp) >= before - 1000 && Date.parse(rep.timestamp) <= Date.now() + 1000, 'timestamp is accurate');
  assert.match(rep.timestamp_local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(rep.photo_image, /^\/api\/photos\/[0-9a-f-]{36}$/);
  firstReport = rep;

  const retry = await call('POST', '/api/reports', { cookie: worker, body });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.duplicate, true);
  assert.equal(retry.json.report.error_id, rep.error_id);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM error_reports').n, 1, 'retry must not create a second record');
  assert.equal(db.one('SELECT COUNT(*) AS n FROM photos').n, 1, 'retry must not store a second photo');
  const files = fs.readdirSync(path.join(DATA_DIR, 'photos'), { recursive: true }).filter((f) => f.endsWith('.png'));
  assert.equal(files.length, 1, 'no orphan photo files');
});

test('probable duplicates need confirmation', async () => {
  const body = {
    client_submission_id: newSid(), box_id: 'BOX-PO-T-001-0001', stage_id: lists.stages[0].id,
    category_id: lists.categories[0].id, severity: 'High', description: 'Same scratch reported again',
  };
  const r = await call('POST', '/api/reports', { cookie: worker2, body });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'POSSIBLE_DUPLICATE');
  assert.equal(r.json.error_id, firstReport.error_id);
  const ok = await call('POST', '/api/reports', { cookie: worker2, body: { ...body, confirm_duplicate: true } });
  assert.equal(ok.status, 201, ok.text);
});

test('validation rejects incomplete or invalid submissions', async () => {
  const good = { box_id: 'BOX-PO-T-001-0002', stage_id: lists.stages[1].id, category_id: lists.categories[1].id, severity: 'Low', description: 'Valid text' };
  const cases = [
    [{ stage_id: undefined }, /stage/i],
    [{ category_id: 99999 }, /error type/i],
    [{ severity: 'Huge' }, /severity/i],
    [{ description: 'x' }, /at least 3/],
    [{ box_id: '' }, /Box ID is required/],
    [{ photo: 'data:image/png;base64,' + Buffer.from('not really an image, just text padding '.repeat(5)).toString('base64') }, /not a valid/],
    [{ photo: 'data:text/html;base64,PGgxPg==' }, /JPEG, PNG or WebP/],
    [{ box_id: 'BOX-UNKNOWN' }, /not registered/],
  ];
  const countBefore = db.one('SELECT COUNT(*) AS n FROM error_reports').n;
  for (const [patch, msg] of cases) {
    const r = await call('POST', '/api/reports', { cookie: worker, body: { ...good, ...patch, client_submission_id: newSid() } });
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(patch)} -> ${r.status}`);
    assert.match(r.json.error, msg);
  }
  const bad = await call('POST', '/api/reports', { cookie: worker, body: { ...good, client_submission_id: 'bad id!' } });
  assert.equal(bad.status, 400);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM error_reports').n, countBefore, 'nothing saved');
});

test('concurrent submissions from many workers get unique IDs', async () => {
  const before = db.one('SELECT COUNT(*) AS n FROM error_reports').n;
  const reqs = [];
  for (let i = 0; i < 30; i++) {
    const box = `BOX-PO-T-001-${String(3 + (i % 30)).padStart(4, '0')}`;
    const body = { client_submission_id: newSid(), box_id: box, stage_id: lists.stages[i % 4].id, category_id: lists.categories[i % 5].id,
      severity: ['Low', 'Medium', 'High', 'Critical'][i % 4], description: `Concurrent defect ${i}` };
    reqs.push(call('POST', '/api/reports', { cookie: i % 2 ? worker : worker2, body }));
    if (i % 3 === 0) reqs.push(call('POST', '/api/reports', { cookie: worker, body })); // simultaneous retry of the same submission
  }
  const results = await Promise.all(reqs);
  for (const r of results) assert.ok(r.status === 201 || (r.status === 200 && r.json.duplicate), r.text);
  const ids = results.filter((r) => r.status === 201).map((r) => r.json.report.error_id);
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, 30, 'unique error IDs');
  assert.equal(db.one('SELECT COUNT(*) AS n FROM error_reports').n, before + 30, 'no duplicate rows from simultaneous retries');
});

test('role-based access control', async () => {
  for (const [m, u] of [['GET', '/api/reports'], ['GET', `/api/reports/${firstReport.error_id}`], ['GET', '/api/metrics'],
    ['GET', '/api/export/reports.csv'], ['GET', '/api/export/reports.xlsx'], ['GET', '/api/admin/users'], ['GET', '/api/events'], ['GET', '/api/admin/feed']]) {
    const r = await call(m, u, { cookie: worker });
    assert.equal(r.status, 403, `worker ${m} ${u}`);
  }
  const w1 = await call('POST', `/api/reports/${firstReport.error_id}/status`, { cookie: worker, body: { status: 'Resolved', note: 'x' } });
  assert.equal(w1.status, 403);
  const w2 = await call('PATCH', `/api/reports/${firstReport.error_id}`, { cookie: worker, body: { severity: 'Low' } });
  assert.equal(w2.status, 403);
  const w3 = await call('POST', '/api/admin/stages', { cookie: worker, body: { name: 'Hack' } });
  assert.equal(w3.status, 403);
  const anon = await call('POST', '/api/reports', { body: {} });
  assert.equal(anon.status, 401);
  const anonPage = await call('GET', '/dashboard/', { raw: true });
  assert.equal(anonPage.status, 302);
  const workerPage = await call('GET', '/dashboard/', { cookie: worker, raw: true });
  assert.equal(workerPage.status, 302);
  assert.equal(workerPage.headers.get('location'), '/app/');

  // Photos: uploader and managers only.
  assert.equal((await call('GET', firstReport.photo_image, { cookie: worker, raw: true })).status, 200);
  assert.equal((await call('GET', firstReport.photo_image, { cookie: manager, raw: true })).status, 200);
  assert.equal((await call('GET', firstReport.photo_image, { cookie: worker2, raw: true })).status, 403);
  assert.equal((await call('GET', firstReport.photo_image, { raw: true })).status, 401);

  // Worker sees only their own submissions.
  const mine = await call('GET', '/api/reports/mine', { cookie: worker2 });
  assert.ok(mine.json.every((r) => r.error_id !== firstReport.error_id));
  const bad = await call('POST', '/api/auth/login', { body: { username: 'w.one', password: 'wrong-password' } });
  assert.equal(bad.status, 401);
  const cross = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie: worker, origin: 'https://evil.example' } });
  assert.equal(cross.status, 403, 'cross-origin POST rejected');
});

test('manager resolution workflow keeps full history and original data', async () => {
  const id = firstReport.error_id;
  let r = await call('POST', `/api/reports/${id}/status`, { cookie: manager, body: { status: 'Under Review', note: 'Checking with paint shop' } });
  assert.equal(r.status, 200, r.text);
  const stale = await call('POST', `/api/reports/${id}/status`, { cookie: manager, body: { status: 'In Rework', expected_updated_at: firstReport.updated_at } });
  assert.equal(stale.status, 409, 'stale update rejected');
  r = await call('POST', `/api/reports/${id}/status`, { cookie: manager, body: { status: 'In Rework', note: 'Panel sent back for refinishing', expected_updated_at: r.json.updated_at } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.requires_rework, true, 'In Rework marks rework required');
  const noNote = await call('POST', `/api/reports/${id}/status`, { cookie: manager, body: { status: 'Resolved' } });
  assert.equal(noNote.status, 400, 'resolution note required');
  r = await call('POST', `/api/reports/${id}/status`, { cookie: manager, body: { status: 'Resolved', note: 'Refinished and re-inspected OK' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'Resolved');
  assert.ok(r.json.resolved_at);
  assert.equal(r.json.resolution_notes, 'Refinished and re-inspected OK');
  assert.equal(r.json.description, 'Deep scratch on front panel', 'original description unchanged');
  assert.equal(r.json.timestamp, firstReport.timestamp, 'original timestamp unchanged');
  assert.deepEqual(r.json.history.map((h) => h.to_status), ['Open', 'Under Review', 'In Rework', 'Resolved']);
  assert.ok(r.json.history.every((h) => h.changed_at && h.changed_by));

  const corr = await call('PATCH', `/api/reports/${id}`, { cookie: manager, body: { severity: 'High' } });
  assert.equal(corr.status, 200, corr.text);
  assert.equal(corr.json.severity, 'High');
  assert.equal(corr.json.revisions.at(-1).old_value, 'Critical');

  // Database-level protections.
  assert.throws(() => db.run('DELETE FROM error_reports WHERE error_id = ?', id), /cannot be deleted/);
  assert.throws(() => db.run("UPDATE error_reports SET description = 'changed' WHERE error_id = ?", id), /immutable/);
  assert.throws(() => db.run('DELETE FROM error_status_history'), /append-only/);
});

test('dashboard metrics follow the documented formulas and filters', async () => {
  const m = (await call('GET', '/api/metrics', { cookie: manager })).json;
  const total = db.one('SELECT COUNT(*) AS n FROM error_reports').n;
  const products = db.one('SELECT COUNT(*) AS n FROM products').n;
  const reworkBoxes = db.one('SELECT COUNT(DISTINCT box_id) AS n FROM error_reports WHERE requires_rework = 1').n;
  const affected = db.one('SELECT COUNT(DISTINCT box_id) AS n FROM error_reports').n;
  assert.equal(m.kpis.total_errors, total);
  assert.equal(m.kpis.resolved_errors, 1);
  assert.equal(m.kpis.unresolved_errors, total - 1);
  assert.equal(m.products.products_in_scope, products);
  assert.equal(m.products.affected_products, affected);
  assert.equal(m.products.rework_products, reworkBoxes);
  assert.equal(m.kpis.rework_rate, reworkBoxes / products);
  assert.ok(m.kpis.total_errors > m.products.affected_products, 'errors and affected products are counted separately');
  assert.equal(m.status_counts.Resolved + m.status_counts.Open + m.status_counts['Under Review'] + m.status_counts['In Rework'], total);
  assert.ok(m.resolution.avg_resolution_hours >= 0);
  assert.equal(m.errors_over_time.reduce((a, d) => a + d.count, 0), total);

  const f = (await call('GET', '/api/metrics?severity=Critical', { cookie: manager })).json;
  assert.equal(f.kpis.total_errors, db.one("SELECT COUNT(*) AS n FROM error_reports WHERE severity = 'Critical'").n);
  const box = (await call('GET', '/api/reports?box_id=BOX-PO-T-001-0001', { cookie: manager })).json;
  assert.ok(box.rows.length >= 2 && box.rows.every((r) => r.box_id === 'BOX-PO-T-001-0001'));
  const future = (await call('GET', '/api/metrics?from=2099-01-01&to=2099-01-31', { cookie: manager })).json;
  assert.equal(future.kpis.total_errors, 0);
  assert.equal(future.kpis.rework_rate, null);
  const sorted = (await call('GET', '/api/reports?sort=severity&dir=desc', { cookie: manager })).json.rows;
  assert.equal(sorted[0].severity, 'Critical');
});

test('spreadsheet feed and exports mirror the database', async () => {
  const feed = (await call('GET', '/api/admin/feed', { cookie: manager })).json;
  assert.equal((await call('GET', '/api/feed/reports.csv?key=wrong')).status, 401);
  const csv = await call('GET', new URL(feed.csv_url).pathname + new URL(feed.csv_url).search);
  assert.equal(csv.status, 200);
  const lines = csv.text.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(lines[0], 'error_ID,box_ID,order_ID,stage,error_type,severity,timestamp,status,photo_image,description,requires_rework,resolved_at,resolution_notes,reported_by');
  assert.equal(lines.length - 1, db.one('SELECT COUNT(*) AS n FROM error_reports').n, 'one row per report');
  const ids = lines.slice(1).map((l) => l.split(',')[0]);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate rows');
  const row = lines.find((l) => l.startsWith(firstReport.error_id + ','));
  assert.match(row, /,Resolved,/, 'status change reflected');
  assert.match(row, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, 'consistent date format');
  const link = row.match(/(http:\/\/[^,]+sig=[^,]+)/)[1];
  assert.equal((await fetch(link)).status, 200, 'signed photo link works without login');
  assert.equal((await fetch(link.replace(/sig=.+$/, 'sig=forged'))).status, 401);

  const x = await call('GET', '/api/export/reports.xlsx', { cookie: manager, raw: true });
  assert.equal(x.status, 200);
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  fs.writeFileSync(path.join(DATA_DIR, 'export-test.xlsx'), buf);
  process.env.PTS_TEST_XLSX = path.join(DATA_DIR, 'export-test.xlsx');
});

test('live updates are pushed to dashboards via Server-Sent Events', async () => {
  const got = new Promise((resolve, reject) => {
    const u = new URL(base + '/api/events');
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { cookie: manager } }, (res) => {
      assert.equal(res.statusCode, 200);
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const m = buf.match(/event: reports-changed\ndata: (.+)\n/);
        if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => reject(new Error('no event received')), 5000);
  });
  await new Promise((r) => setTimeout(r, 100));
  const r = await call('POST', '/api/reports', { cookie: worker, body: {
    client_submission_id: newSid(), box_id: 'BOX-PO-T-001-0040', stage_id: lists.stages[2].id, category_id: lists.categories[2].id,
    severity: 'Medium', description: 'Event test' } });
  assert.equal(r.status, 201);
  const evt = await got;
  assert.equal(evt.error_id, r.json.report.error_id);
});

test('configurable stages and error types', async () => {
  const s = await call('POST', '/api/admin/stages', { cookie: manager, body: { name: 'Final Test Bench' } });
  assert.equal(s.status, 201);
  assert.ok((await call('GET', '/api/lists', { cookie: worker })).json.stages.some((x) => x.name === 'Final Test Bench'));
  const off = await call('PATCH', `/api/admin/stages/${s.json.id}`, { cookie: manager, body: { active: false } });
  assert.equal(off.status, 200);
  assert.ok(!(await call('GET', '/api/lists', { cookie: worker })).json.stages.some((x) => x.name === 'Final Test Bench'));
  const dup = await call('POST', '/api/admin/categories', { cookie: manager, body: { name: lists.categories[0].name.toUpperCase() } });
  assert.equal(dup.status, 409);
});
