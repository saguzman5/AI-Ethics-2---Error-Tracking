'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const auth = require('./auth');

const DEFAULT_STAGES = ['Raw Material Inspection', 'Cutting', 'Machining', 'Welding', 'Assembly', 'Painting / Finishing', 'Quality Inspection', 'Packaging', 'Shipping'];
const DEFAULT_CATEGORIES = ['Dimensional Error', 'Surface Defect / Scratch', 'Missing Part', 'Wrong Part', 'Assembly Error', 'Weld Defect', 'Paint / Coating Defect', 'Damaged Component', 'Labeling Error', 'Packaging Damage', 'Contamination', 'Other'];

// Inserts default lists on an empty database and makes sure a manager exists.
// Returns the generated admin password when a new admin was created.
function bootstrap({ log = console.log } = {}) {
  if (!db.one('SELECT 1 FROM production_stages LIMIT 1')) {
    DEFAULT_STAGES.forEach((n, i) => db.run('INSERT INTO production_stages(name, sort_order) VALUES (?, ?)', n, (i + 1) * 10));
  }
  if (!db.one('SELECT 1 FROM error_categories LIMIT 1')) {
    DEFAULT_CATEGORIES.forEach((n, i) => db.run('INSERT INTO error_categories(name, sort_order) VALUES (?, ?)', n, (i + 1) * 10));
  }
  if (!db.one("SELECT 1 FROM users WHERE role = 'manager' AND active = 1")) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    auth.validatePassword(password);
    db.run("INSERT INTO users(username, full_name, role, password_hash) VALUES (?, 'Administrator', 'manager', ?)",
      username, auth.hashPassword(password));
    log('\n================================================================');
    log(' First run: manager account created');
    log(`   username: ${username}`);
    log(`   password: ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : password}`);
    log(' Sign in and change it under Admin > Users.');
    log('================================================================\n');
    return { username, password };
  }
  return null;
}

module.exports = { bootstrap, DEFAULT_STAGES, DEFAULT_CATEGORIES };
