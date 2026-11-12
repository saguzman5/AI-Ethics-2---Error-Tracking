'use strict';
// Renders QR codes as SVG using the vendored MIT-licensed encoder by
// Kazuhiko Arase (vendor/qrcode).
const QRCode = require('../vendor/qrcode');
const QRErrorCorrectLevel = require('../vendor/qrcode/QRErrorCorrectLevel');

function toSvg(text, { size = 220, margin = 4 } = {}) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const dim = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin},${r + margin}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${size}" height="${size}" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

module.exports = { toSvg };
