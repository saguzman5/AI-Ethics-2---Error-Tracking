'use strict';
// Creates or resets a user from the command line (useful if every manager
// password is lost).
//   npm run add-user -- <username> <worker|manager> "<Full Name>" <password>
const db = require('../src/db');
const auth = require('../src/auth');

const [username, role, fullName, password] = process.argv.slice(2);
if (!username || !['worker', 'manager'].includes(role) || !fullName || !password) {
  console.error('Usage: npm run add-user -- <username> <worker|manager> "<Full Name>" <password>');
  process.exit(1);
}
try { auth.validatePassword(password); } catch (e) { console.error(e.message); process.exit(1); }

db.open();
const existing = db.one('SELECT id FROM users WHERE username = ?', username);
if (existing) {
  db.run('UPDATE users SET role = ?, full_name = ?, password_hash = ?, active = 1 WHERE id = ?', role, fullName, auth.hashPassword(password), existing.id);
  db.run('DELETE FROM sessions WHERE user_id = ?', existing.id);
  console.log(`Updated ${role} "${username}".`);
} else {
  db.run('INSERT INTO users(username, full_name, role, password_hash) VALUES (?, ?, ?, ?)', username, fullName, role, auth.hashPassword(password));
  console.log(`Created ${role} "${username}".`);
}
db.close();
