'use strict';
// Time-zone helpers using only Intl. All stored timestamps are UTC ISO strings;
// these convert to and from the factory's local time zone.

const fmtCache = new Map();
function partsFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

function zonedParts(ms, tz) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

// Offset (ms) of tz from UTC at instant ms.
function tzOffset(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// "YYYY-MM-DD HH:mm:ss" in tz.
function formatLocal(iso, tz) {
  if (!iso) return '';
  const p = zonedParts(Date.parse(iso), tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// "YYYY-MM-DD" (local calendar day) in tz.
function localDateKey(iso, tz) {
  const p = zonedParts(typeof iso === 'number' ? iso : Date.parse(iso), tz);
  return `${p.year}-${p.month}-${p.day}`;
}

// UTC ISO instant for local midnight of dateStr ("YYYY-MM-DD") in tz.
function localMidnightUtc(dateStr, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  let ms = guess - tzOffset(guess, tz);
  ms = guess - tzOffset(ms, tz); // correct across DST boundaries
  return new Date(ms).toISOString();
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Excel serial date number representing the local wall-clock time in tz.
function excelSerial(iso, tz) {
  const ms = Date.parse(iso);
  return (ms + tzOffset(ms, tz)) / 86400000 + 25569;
}

module.exports = { formatLocal, localDateKey, localMidnightUtc, addDays, excelSerial, tzOffset };
