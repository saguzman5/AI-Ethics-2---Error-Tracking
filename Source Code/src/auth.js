'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');
const { HttpError, parseCookies } = require('./http');

const COOKIE = 'pts_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, actual);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (pw.length > 200) throw new HttpError(400, 'Password is too long');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const days = user.role === 'manager' ? config.SESSION_DAYS_MANAGER : config.SESSION_DAYS_WORKER;
  const expires = new Date(Date.now() + days * 86400000);
  db.run('DELETE FROM sessions WHERE expires_at < ?', db.nowIso());
  db.run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), user.id, expires.toISOString());
  return { token, expires };
}

function sessionCookie(req, token, expires) {
  const secure = isSecure(req) ? '; Secure' : '';
  if (!token) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires.toUTCString()}${secure}`;
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  return config.TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function userFromRequest(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db.one(
    `SELECT u.id, u.username, u.full_name, u.role, u.active, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`, sha256(token));
  if (!row || !row.active || row.expires_at < db.nowIso()) return null;
  return { id: row.id, username: row.username, full_name: row.full_name, role: row.role };
}

function destroySession(req) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

// Middleware factories -------------------------------------------------------
const requireUser = (ctx) => {
  if (!ctx.user) throw new HttpError(401, 'Please sign in');
};
const requireManager = (ctx) => {
  requireUser(ctx);
  if (ctx.user.role !== 'manager') throw new HttpError(403, 'Manager access required');
};

// Simple in-memory login throttling: 10 failed attempts per 15 min per IP+user.
const failures = new Map();
function checkThrottle(key) {
  const f = failures.get(key);
  if (f && f.count >= 10 && Date.now() - f.first < 15 * 60000) {
    throw new HttpError(429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
  }
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60000) failures.set(key, { count: 1, first: Date.now() });
  else f.count++;
}
const clearFailures = (key) => failures.delete(key);

// Signed URLs for photos used in spreadsheet feeds (no session cookie there).
function signPhoto(photoId, expiresAtMs) {
  const secret = db.getSetting('signing_secret');
  return crypto.createHmac('sha256', secret).update(`${photoId}.${expiresAtMs}`).digest('base64url');
}
function verifyPhotoSignature(photoId, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = Buffer.from(signPhoto(photoId, Number(exp)));
  const given = Buffer.from(String(sig));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = {
  hashPassword, verifyPassword, validatePassword, createSession, sessionCookie, userFromRequest,
  destroySession, requireUser, requireManager, checkThrottle, recordFailure, clearFailures,
  signPhoto, verifyPhotoSignature, sha256,
};
