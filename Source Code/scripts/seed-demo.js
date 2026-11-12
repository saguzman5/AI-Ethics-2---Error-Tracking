'use strict';
// Loads realistic demo data: orders, boxes, worker/manager accounts and ~60
// days of error reports with status histories. Safe to run once on an empty
// database; refuses to run if error reports already exist (unless --force).
//
//   npm run demo
const crypto = require('node:crypto');
const db = require('../src/db');
const auth = require('../src/auth');
const { bootstrap } = require('../src/bootstrap');

db.open();
bootstrap();

if (db.one('SELECT COUNT(*) AS n FROM error_reports').n > 0 && !process.argv.includes('--force')) {
  console.log('Error reports already exist; demo data not loaded. Use --force to add more anyway.');
  process.exit(0);
}

// Deterministic pseudo-random generator so the demo is reproducible.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let x = rand() * total;
  for (const [v, w] of pairs) { if ((x -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
};

const demoPassword = process.env.DEMO_PASSWORD || 'Demo-' + crypto.randomBytes(4).toString('hex');
auth.validatePassword(demoPassword);
const people = [
  ['m.garcia', 'Maria Garcia', 'manager'],
  ['j.chen', 'James Chen', 'worker'],
  ['a.okafor', 'Amara Okafor', 'worker'],
  ['l.novak', 'Lukas Novak', 'worker'],
  ['s.patel', 'Sofia Patel', 'worker'],
];
const users = {};
for (const [username, name, role] of people) {
  let u = db.one('SELECT id FROM users WHERE username = ?', username);
  if (!u) {
    const info = db.run('INSERT INTO users(username, full_name, role, password_hash) VALUES (?, ?, ?, ?)', username, name, role, auth.hashPassword(demoPassword));
    u = { id: Number(info.lastInsertRowid) };
  }
  users[username] = u.id;
}
const workers = ['j.chen', 'a.okafor', 'l.novak', 's.patel'].map((u) => users[u]);
const manager = users['m.garcia'];

const stages = db.all('SELECT id, name FROM production_stages WHERE active = 1');
const cats = db.all('SELECT id, name FROM error_categories WHERE active = 1');
const stageW = { Assembly: 6, Welding: 4, 'Painting / Finishing': 4, Machining: 3, Cutting: 2, 'Quality Inspection': 3, Packaging: 2, 'Raw Material Inspection': 1, Shipping: 1 };
const catW = { 'Surface Defect / Scratch': 6, 'Assembly Error': 5, 'Dimensional Error': 4, 'Missing Part': 3, 'Weld Defect': 3, 'Paint / Coating Defect': 3, 'Wrong Part': 2, 'Damaged Component': 2, 'Labeling Error': 2, 'Packaging Damage': 2, Contamination: 1, Other: 1 };
const descriptions = {
  'Surface Defect / Scratch': ['Deep scratch on front panel, approx. 4 cm', 'Dent on left side cover', 'Visible tool marks on housing'],
  'Assembly Error': ['Bracket mounted upside down', 'Fasteners not torqued to spec', 'Cable harness routed incorrectly'],
  'Dimensional Error': ['Hole position out of tolerance by 0.8 mm', 'Overall length 2 mm short', 'Flange thickness below spec'],
  'Missing Part': ['Rubber gasket missing', 'Two M6 screws missing', 'Mounting clip not installed'],
  'Weld Defect': ['Porosity on corner weld', 'Incomplete fusion on seam', 'Weld spatter on visible surface'],
  'Paint / Coating Defect': ['Paint runs on rear panel', 'Uneven coating thickness', 'Orange peel texture on lid'],
  'Wrong Part': ['Wrong revision of PCB installed', 'Blue knob fitted instead of black'],
  'Damaged Component': ['Cracked plastic cover', 'Bent connector pins'],
  'Labeling Error': ['Serial label does not match box', 'Label missing CE mark'],
  'Packaging Damage': ['Box corner crushed', 'Foam insert torn'],
  Contamination: ['Oil residue inside enclosure', 'Metal shavings found in housing'],
  Other: ['Unusual noise during function test'],
};

const DAYS = 60;
const now = Date.now();
const orders = [];
db.tx(() => {
  for (let i = 0; i < 12; i++) {
    const orderId = `PO-2026-${String(101 + i).padStart(4, '0')}`;
    const product = pick(['Control Cabinet CX-200', 'Pump Housing PH-40', 'Conveyor Frame CF-12', 'Sensor Enclosure SE-7']);
    const created = new Date(now - (DAYS - i * 5) * 86400000);
    if (db.one('SELECT 1 FROM production_orders WHERE order_id = ?', orderId)) continue;
    db.run('INSERT INTO production_orders(order_id, customer, product_name, quantity, created_at) VALUES (?, ?, ?, ?, ?)',
      orderId, pick(['Northwind Industrial', 'Contoso Energy', 'Fabrikam Logistics', 'Tailspin Water']), product, 40, created.toISOString());
    const boxes = [];
    for (let b = 1; b <= 40; b++) {
      const boxId = `BOX-${String(i + 1).padStart(2, '0')}${String(b).padStart(3, '0')}`;
      const produced = new Date(created.getTime() + Math.floor(rand() * 5 * 86400000));
      db.run('INSERT INTO products(box_id, order_id, product_name, produced_at, created_at) VALUES (?, ?, ?, ?, ?)', boxId, orderId, product, produced.toISOString(), produced.toISOString());
      boxes.push({ boxId, produced });
    }
    orders.push({ orderId, boxes });
  }
});

let seq = db.one('SELECT COALESCE(MAX(seq), 0) AS n FROM error_reports').n;
let count = 0;
db.tx(() => {
  for (const o of orders) {
    for (const box of o.boxes) {
      if (rand() > 0.32) continue; // about a third of boxes get at least one error
      const nErrors = weighted([[1, 7], [2, 2], [3, 1]]);
      for (let k = 0; k < nErrors; k++) {
        let reportedMs = box.produced.getTime() + Math.floor(rand() * 3 * 86400000);
        if (reportedMs > now - 3600000) reportedMs = now - Math.floor((1 + rand() * 30) * 3600000);
        const stage = stages.find((s) => s.name === weighted(Object.entries(stageW))) || pick(stages);
        const cat = cats.find((c) => c.name === weighted(Object.entries(catW))) || pick(cats);
        const severity = weighted([['Low', 4], ['Medium', 4], ['High', 2], ['Critical', 0.7]]);
        const id = `ERR-${String(++seq).padStart(6, '0')}`;
        const reporter = pick(workers);
        const reportedAt = new Date(reportedMs).toISOString();
        const age = (now - reportedMs) / 86400000;
        // Older reports are more likely to have progressed.
        const steps = [];
        let t = reportedMs;
        const advance = (hours) => { t = Math.min(now - 60000, t + hours * 3600000); return new Date(t).toISOString(); };
        const progress = age > 6 ? weighted([[4, 8], [3, 1], [2, 1]]) : age > 2 ? weighted([[4, 3], [3, 3], [2, 2], [1, 2]]) : weighted([[1, 6], [2, 3], [3, 1]]);
        const needsRework = rand() < 0.65;
        if (progress >= 2) steps.push(['Open', 'Under Review', 'Investigating with shift lead', advance(1 + rand() * 10)]);
        if (progress >= 3 && needsRework) steps.push(['Under Review', 'In Rework', 'Sent back to ' + stage.name + ' for correction', advance(1 + rand() * 12)]);
        if (progress >= 4) {
          const from = steps.length ? steps[steps.length - 1][1] : 'Open';
          steps.push([from, 'Resolved', needsRework ? 'Rework completed and re-inspected OK' : 'Within tolerance after review; no rework needed', advance(2 + rand() * 30)]);
        }
        const last = steps.length ? steps[steps.length - 1] : null;
        const status = last ? last[1] : 'Open';
        const rework = steps.some((s) => s[1] === 'In Rework') ? 1 : 0;
        const lastNote = [...steps].reverse().find((s) => s[2]);
        db.run(`INSERT INTO error_reports(seq, error_id, client_submission_id, box_id, order_id, stage_id, category_id, severity, description,
                  photo_id, status, requires_rework, resolution_notes, reported_by, reported_at, status_changed_at, resolved_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
          seq, id, crypto.randomUUID(), box.boxId, o.orderId, stage.id, cat.id, severity, pick(descriptions[cat.name] || descriptions.Other),
          status, rework, lastNote ? lastNote[2] : null, reporter, reportedAt, last ? last[3] : reportedAt,
          status === 'Resolved' ? last[3] : null, last ? last[3] : reportedAt);
        db.run(`INSERT INTO error_status_history(error_id, from_status, to_status, note, changed_by, changed_at) VALUES (?, NULL, 'Open', 'Report submitted', ?, ?)`, id, reporter, reportedAt);
        for (const [from, to, note, at] of steps) {
          db.run('INSERT INTO error_status_history(error_id, from_status, to_status, note, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)', id, from, to, note, manager, at);
        }
        count++;
      }
    }
  }
});

console.log(`Demo data loaded: ${orders.length} orders, ${orders.length * 40} boxes, ${count} error reports.`);
console.log('Demo accounts (all share one password):');
for (const [u, n, r] of people) console.log(`  ${u.padEnd(10)} ${r.padEnd(8)} ${n}`);
console.log(`  password: ${demoPassword}`);
db.close();
