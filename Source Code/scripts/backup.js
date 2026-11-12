'use strict';
// Consistent online backup of the database plus a copy of all photos.
//   npm run backup            -> Database/backups/<timestamp>/
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const db = require('../src/db');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(config.ROOT, 'Database', 'backups', stamp);
fs.mkdirSync(dest, { recursive: true });

db.open();
// VACUUM INTO produces a consistent snapshot even while the server is running.
db.get().exec(`VACUUM INTO '${path.join(dest, 'production.db').replace(/'/g, "''")}'`);
db.close();

const photos = path.join(config.DATA_DIR, 'photos');
if (fs.existsSync(photos)) fs.cpSync(photos, path.join(dest, 'photos'), { recursive: true });
console.log(`Backup written to ${dest}`);
