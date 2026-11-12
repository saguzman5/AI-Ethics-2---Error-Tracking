'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');
const { HttpError } = require('./http');

const PHOTO_DIR = () => path.join(config.DATA_DIR, 'photos');

// Detect type from file signature; never trust the client-declared type.
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function decodeDataUrl(dataUrl) {
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'Photo must be a JPEG, PNG or WebP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > config.MAX_PHOTO_BYTES) throw new HttpError(413, `Photo is too large (max ${Math.round(config.MAX_PHOTO_BYTES / 1048576)} MB)`);
  if (buf.length < 100) throw new HttpError(400, 'Photo appears to be empty');
  return buf;
}

// Writes the file and returns a pending record. Call insert() inside the
// report transaction and discard() if the transaction fails.
function prepare(dataUrl, userId) {
  const buf = decodeDataUrl(dataUrl);
  const kind = sniff(buf);
  if (!kind) throw new HttpError(400, 'Photo content is not a valid JPEG, PNG or WebP image');
  const id = crypto.randomUUID();
  const now = new Date();
  const rel = path.posix.join(String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), `${id}.${kind.ext}`);
  const abs = path.join(PHOTO_DIR(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf, { flag: 'wx', mode: 0o640 });
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    id,
    insert() {
      db.run('INSERT INTO photos(id, file_path, mime_type, size_bytes, sha256, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
        id, rel, kind.mime, buf.length, sha, userId);
    },
    discard() { try { fs.unlinkSync(abs); } catch { /* ignore */ } },
  };
}

function load(photoId) {
  if (!/^[0-9a-f-]{36}$/.test(photoId)) return null;
  const row = db.one('SELECT * FROM photos WHERE id = ?', photoId);
  if (!row) return null;
  const abs = path.resolve(PHOTO_DIR(), row.file_path);
  if (!abs.startsWith(path.resolve(PHOTO_DIR()) + path.sep) || !fs.existsSync(abs)) return null;
  return { ...row, abs };
}

module.exports = { prepare, load, sniff };
