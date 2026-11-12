'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const events = require('./events');
const { bootstrap } = require('./bootstrap');
const { HttpError, sendJson, redirect, serveStatic } = require('./http');
const api = require('./routes/api');

const DIRS = {
  shared: path.join(config.ROOT, 'Shared'),
  app: path.join(config.ROOT, 'Mobile Application'),
  dashboard: path.join(config.ROOT, 'Dashboard'),
  spreadsheet: path.join(config.ROOT, 'Spreadsheet'),
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    `script-src 'self' ${new URL(config.JSQR_CDN).origin}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
};

// jsQR decoder for browsers without the native BarcodeDetector API: served
// locally when installed (npm install jsqr), otherwise from a CDN.
function jsqrPath() {
  const p = path.join(config.ROOT, 'Source Code', 'node_modules', 'jsqr', 'dist', 'jsQR.js');
  return fs.existsSync(p) ? p : null;
}

async function handle(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (req.socket.encrypted) res.setHeader('Strict-Transport-Security', 'max-age=15552000');

  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;
  const ctx = {
    req, res, url, pathname,
    query: Object.fromEntries(url.searchParams),
    ip: (config.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress,
    user: auth.userFromRequest(req),
    params: {},
  };

  // Same-origin check for state-changing requests (defence in depth on top
  // of SameSite=Strict cookies).
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    let originHost = null;
    try { originHost = origin ? new URL(origin).host : null; } catch { originHost = '\u0000invalid'; }
    if (origin && originHost !== req.headers.host) throw new HttpError(403, 'Cross-origin request rejected');
  }

  if (pathname.startsWith('/api/')) {
    const m = api.match(req.method, pathname);
    if (m === 'METHOD') throw new HttpError(405, 'Method not allowed');
    if (!m) throw new HttpError(404, 'Not found');
    ctx.params = m.params;
    for (const h of m.handlers) await h(ctx);
    return;
  }

  if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
  if (pathname === '/vendor/jsQR.js') {
    const local = jsqrPath();
    if (local) return serveStatic(res, path.dirname(local), 'jsQR.js', req);
    return redirect(res, config.JSQR_CDN);
  }

  if (pathname === '/') {
    if (!ctx.user) return redirect(res, '/login');
    return redirect(res, ctx.user.role === 'manager' ? '/dashboard/' : '/app/');
  }
  if (pathname === '/login' || pathname === '/login/') return serveStatic(res, DIRS.shared, 'login.html', req) || notFound(res);

  const [, section, ...rest] = pathname.split('/');
  const rel = rest.join('/');
  if (section === 'shared') return serveStatic(res, DIRS.shared, rel, req) || notFound(res);

  if (section === 'app' || section === 'dashboard' || section === 'spreadsheet') {
    if (pathname === `/${section}`) return redirect(res, `/${section}/${url.search}`);
    const isPage = !rel || rel.endsWith('.html');
    const isPublicAsset = /\.(webmanifest|svg|png)$/.test(rel);
    if (isPage && !ctx.user) return redirect(res, `/login?next=${encodeURIComponent(pathname + url.search)}`);
    if (!isPublicAsset && section !== 'app' && ctx.user && ctx.user.role !== 'manager') return redirect(res, '/app/');
    if (!isPublicAsset && !ctx.user && !isPage) throw new HttpError(401, 'Please sign in');
    return serveStatic(res, DIRS[section], rel, req) || notFound(res);
  }
  notFound(res);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function onError(err, res) {
  if (res.headersSent) { res.end(); return; }
  if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...(err.details || {}) });
  const msg = String(err && err.message);
  if (/UNIQUE constraint failed/.test(msg)) return sendJson(res, 409, { error: 'This record already exists' });
  if (/immutable|append-only|cannot be deleted|does not match/.test(msg)) return sendJson(res, 400, { error: msg });
  if (/database is locked|SQLITE_BUSY/.test(msg)) return sendJson(res, 503, { error: 'The system is busy. Please try again.' });
  console.error(new Date().toISOString(), err);
  sendJson(res, 500, { error: 'Unexpected server error. Please try again.' });
}

function start({ port = config.PORT, host = config.HOST, quiet = false } = {}) {
  db.open();
  bootstrap({ log: quiet ? () => {} : console.log });
  const listener = (req, res) => handle(req, res).catch((err) => onError(err, res));
  const tls = config.TLS_KEY_FILE && config.TLS_CERT_FILE;
  const server = tls
    ? https.createServer({ key: fs.readFileSync(config.TLS_KEY_FILE), cert: fs.readFileSync(config.TLS_CERT_FILE) }, listener)
    : http.createServer(listener);
  server.requestTimeout = 60000;
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      if (!quiet) {
        const proto = tls ? 'https' : 'http';
        console.log(`Production Tracking System running on ${proto}://localhost:${addr.port}`);
        console.log(`  Worker app:  ${proto}://localhost:${addr.port}/app/`);
        console.log(`  Dashboard:   ${proto}://localhost:${addr.port}/dashboard/`);
        console.log(`  Spreadsheet: ${proto}://localhost:${addr.port}/spreadsheet/`);
        console.log(`  Data folder: ${config.DATA_DIR}`);
        console.log(`  Time zone:   ${config.TIMEZONE}`);
      }
      resolve(server);
    });
  });
}

function stop(server) {
  events.closeAll();
  return new Promise((resolve) => server.close(() => { db.close(); resolve(); }));
}

if (require.main === module) {
  start().then((server) => {
    const shutdown = () => stop(server).then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

module.exports = { start, stop };
