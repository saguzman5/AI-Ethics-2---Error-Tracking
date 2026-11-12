'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

// node:sqlite prints an ExperimentalWarning on Node 22; silence only that one.
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const text = typeof warning === 'string' ? warning : warning && warning.message;
  if (text && text.includes('SQLite is an experimental feature')) return;
  return origEmit.call(process, warning, ...args);
};
const { DatabaseSync } = require('node:sqlite');

let db;

function open(file = path.join(config.DATA_DIR, 'production.db')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(config.DATA_DIR, 'photos'), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(fs.readFileSync(config.SCHEMA_FILE, 'utf8'));
  ensureSetting('sheet_feed_key', () => crypto.randomBytes(24).toString('base64url'));
  ensureSetting('signing_secret', () => crypto.randomBytes(32).toString('base64url'));
  return db;
}

function get() {
  if (!db) throw new Error('Database not opened');
  return db;
}

function close() {
  if (db) { db.close(); db = undefined; }
}

const all = (sql, ...p) => get().prepare(sql).all(...p);
const one = (sql, ...p) => get().prepare(sql).get(...p);
const run = (sql, ...p) => get().prepare(sql).run(...p);

// Runs fn inside BEGIN IMMEDIATE so concurrent writers are serialized.
function tx(fn) {
  const d = get();
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

function getSetting(key) {
  const row = one('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}
function ensureSetting(key, make) {
  if (getSetting(key) === null) setSetting(key, make());
}

const nowIso = () => new Date().toISOString();

module.exports = { open, get, close, all, one, run, tx, getSetting, setSetting, nowIso };
