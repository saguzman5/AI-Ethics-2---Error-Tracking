'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Project root = the "AI Ethics" folder (two levels above this file).
const ROOT = path.resolve(__dirname, '..', '..');

// Minimal .env loader (KEY=VALUE lines). Real environment variables win.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(ROOT, 'Source Code', '.env'));

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

const config = {
  ROOT,
  PORT: Number(env.PORT || 3000),
  HOST: env.HOST || '0.0.0.0',
  DATA_DIR: path.resolve(env.DATA_DIR || path.join(ROOT, 'Database', 'data')),
  SCHEMA_FILE: path.join(ROOT, 'Database', 'schema.sql'),
  // Public base URL used in spreadsheet photo links, e.g. https://qa.example.com
  PUBLIC_URL: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // Factory time zone used for every displayed date/time and day grouping.
  TIMEZONE: env.TIMEZONE || 'UTC',
  TLS_KEY_FILE: env.TLS_KEY_FILE || '',
  TLS_CERT_FILE: env.TLS_CERT_FILE || '',
  TRUST_PROXY: bool(env.TRUST_PROXY, false),
  REQUIRE_PHOTO: bool(env.REQUIRE_PHOTO, false),
  // Create unknown products automatically when the QR code carries both IDs.
  AUTO_REGISTER_PRODUCTS: bool(env.AUTO_REGISTER_PRODUCTS, true),
  // Window used to warn workers about a probable duplicate report.
  DUPLICATE_WINDOW_MINUTES: Number(env.DUPLICATE_WINDOW_MINUTES || 30),
  MAX_PHOTO_BYTES: Number(env.MAX_PHOTO_BYTES || 8 * 1024 * 1024),
  SESSION_DAYS_WORKER: Number(env.SESSION_DAYS_WORKER || 30),
  SESSION_DAYS_MANAGER: Number(env.SESSION_DAYS_MANAGER || 1),
  // Days a signed photo link in the spreadsheet feed stays valid.
  PHOTO_LINK_DAYS: Number(env.PHOTO_LINK_DAYS || 30),
  // CDN fallback for the jsQR decoder when it is not installed locally.
  JSQR_CDN: env.JSQR_CDN || 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
};

// Validate the time zone early so a typo fails loudly.
try { new Intl.DateTimeFormat('en-US', { timeZone: config.TIMEZONE }); }
catch { throw new Error(`Invalid TIMEZONE "${config.TIMEZONE}". Use an IANA name such as America/Chicago.`); }

module.exports = config;
