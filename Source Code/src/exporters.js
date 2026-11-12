'use strict';
const config = require('./config');
const auth = require('./auth');
const time = require('./time');
const db = require('./db');
const { buildXlsx } = require('./xlsx');

// The 10 required spreadsheet columns, followed by resolution-tracking columns.
const COLUMNS = [
  { key: 'error_id', header: 'error_ID', width: 13 },
  { key: 'box_id', header: 'box_ID', width: 14 },
  { key: 'order_id', header: 'order_ID', width: 15 },
  { key: 'stage', header: 'stage', width: 18 },
  { key: 'error_type', header: 'error_type', width: 22 },
  { key: 'severity', header: 'severity', width: 10 },
  { key: 'timestamp', header: 'timestamp', width: 20 },
  { key: 'status', header: 'status', width: 14 },
  { key: 'photo_image', header: 'photo_image', width: 14 },
  { key: 'description', header: 'description', width: 50 },
  { key: 'requires_rework', header: 'requires_rework', width: 15 },
  { key: 'resolved_at', header: 'resolved_at', width: 20 },
  { key: 'resolution_notes', header: 'resolution_notes', width: 40 },
  { key: 'reported_by', header: 'reported_by', width: 18 },
];

function baseUrl(req) {
  if (config.PUBLIC_URL) return config.PUBLIC_URL;
  const proto = req.socket.encrypted ? 'https'
    : (config.TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()) || 'http';
  const host = String(req.headers.host || `localhost:${config.PORT}`).replace(/[^A-Za-z0-9.:\-[\]]/g, '');
  return `${proto}://${host}`;
}

// Signed links let spreadsheet users open photos without a session cookie.
function photoUrl(req, photoPath) {
  if (!photoPath) return '';
  const id = photoPath.split('/').pop();
  const exp = Date.now() + config.PHOTO_LINK_DAYS * 86400000;
  return `${baseUrl(req)}/api/photos/${id}?exp=${exp}&sig=${auth.signPhoto(id, exp)}`;
}

function flatRows(req, reports) {
  return reports.map((r) => ({
    error_id: r.error_id,
    box_id: r.box_id,
    order_id: r.order_id,
    stage: r.stage,
    error_type: r.error_type,
    severity: r.severity,
    timestamp: r.timestamp,
    status: r.status,
    photo_image: photoUrl(req, r.photo_image),
    description: r.description,
    requires_rework: r.requires_rework ? 'Yes' : 'No',
    resolved_at: r.resolved_at || '',
    resolution_notes: r.resolution_notes || '',
    reported_by: r.reported_by_name,
  }));
}

// Neutralise spreadsheet formula injection in text typed by users.
const safeCell = (v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

function toCsv(req, reports) {
  const rows = flatRows(req, reports);
  const esc = (v) => {
    const s = safeCell(String(v ?? ''));
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.map((c) => c.header).join(',')];
  for (const r of rows) {
    lines.push(COLUMNS.map((c) => {
      let v = r[c.key];
      if ((c.key === 'timestamp' || c.key === 'resolved_at') && v) v = time.formatLocal(v, config.TIMEZONE);
      return esc(v);
    }).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function toXlsx(req, reports) {
  const rows = flatRows(req, reports);
  const tz = config.TIMEZONE;
  const sheetRows = rows.map((r) => COLUMNS.map((c) => {
    const v = r[c.key];
    if (c.key === 'timestamp' || c.key === 'resolved_at') return v ? { v: time.excelSerial(v, tz), t: 'date' } : null;
    if (c.key === 'photo_image') return v ? { v: 'View photo', t: 'link', href: v } : 'No photo';
    if (c.key === 'severity') return { v, t: 'str', s: v };
    if (c.key === 'description' || c.key === 'resolution_notes') return { v: String(v), t: 'str', s: 'wrap' };
    return { v: String(v ?? ''), t: 'str' };
  }));

  const ids = reports.map((r) => r.error_id);
  const history = ids.length ? db.all(
    `SELECT h.error_id, h.from_status, h.to_status, h.note, h.changed_at, u.full_name
       FROM error_status_history h JOIN users u ON u.id = h.changed_by
      WHERE h.error_id IN (SELECT value FROM json_each(?)) ORDER BY h.error_id, h.changed_at, h.id`, JSON.stringify(ids)) : [];

  return buildXlsx([
    { name: 'Error Reports', columns: COLUMNS, rows: sheetRows },
    {
      name: 'Status History',
      columns: [
        { header: 'error_ID', width: 13 }, { header: 'from_status', width: 14 }, { header: 'to_status', width: 14 },
        { header: 'changed_at', width: 20 }, { header: 'changed_by', width: 18 }, { header: 'note', width: 60 },
      ],
      rows: history.map((h) => [h.error_id, h.from_status || '', h.to_status, { v: time.excelSerial(h.changed_at, tz), t: 'date' },
        h.full_name, { v: h.note || '', t: 'str', s: 'wrap' }]),
    },
    {
      name: 'About',
      autoFilter: false,
      columns: [{ header: 'Item', width: 22 }, { header: 'Value', width: 70 }],
      rows: [
        ['Generated', time.formatLocal(new Date().toISOString(), tz)],
        ['Time zone', tz],
        ['Source', 'Centralized database (authoritative). This file is a snapshot.'],
        ['Records', String(reports.length)],
        ['Photo links', `Signed links valid for ${config.PHOTO_LINK_DAYS} days from generation.`],
      ],
    },
  ]);
}

module.exports = { COLUMNS, toCsv, toXlsx, flatRows, baseUrl };
