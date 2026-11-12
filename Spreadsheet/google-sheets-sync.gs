/**
 * Google Sheets live sync for the Production Error Reporting System.
 *
 * The central database stays the source of truth. This script mirrors the
 * read-only CSV feed into the "Error Reports" tab every minute, replacing the
 * tab's contents each time, so the sheet always shows exactly one row per
 * error report (no duplicates) with the latest status.
 *
 * Setup (once):
 *   1. Open your Google Sheet -> Extensions -> Apps Script.
 *   2. Replace the editor contents with this file and save.
 *   3. Set FEED_URL below to the URL shown in Dashboard -> Admin ->
 *      Spreadsheet connection (it contains a secret key; keep it private).
 *   4. Select the function "setup" and click Run. Approve the permissions.
 *   The sheet now refreshes every minute. Use the "Production Quality" menu
 *   to refresh on demand.
 *
 * Requirements: the server must be reachable from the internet over HTTPS
 * (Google fetches the feed from its own servers).
 */

var FEED_URL = 'https://YOUR-SERVER/api/feed/reports.csv?key=PASTE-KEY-HERE';
var SHEET_NAME = 'Error Reports';
var INFO_SHEET = 'Sync Info';

var SEVERITY_COLORS = { Low: '#e0f2fe', Medium: '#fef3c7', High: '#ffedd5', Critical: '#dc2626' };
var STATUS_COLORS = { 'Open': '#e0e7ff', 'Under Review': '#f3e8ff', 'In Rework': '#ccfbf1', 'Resolved': '#dcfce7' };

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Production Quality')
    .addItem('Refresh now', 'syncReports')
    .addItem('Install auto-refresh (every minute)', 'setup')
    .addToUi();
}

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncReports') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncReports').timeBased().everyMinutes(1).create();
  syncReports();
}

function syncReports() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) return; // a sync is already running
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var response = UrlFetchApp.fetch(FEED_URL, { muteHttpExceptions: true, followRedirects: true });
    if (response.getResponseCode() !== 200) {
      writeInfo(ss, 'ERROR ' + response.getResponseCode() + ': ' + response.getContentText().slice(0, 200));
      return;
    }
    var text = response.getContentText('UTF-8').replace(/^\uFEFF/, '');
    var data = Utilities.parseCsv(text);
    if (!data.length) { writeInfo(ss, 'ERROR: empty feed'); return; }

    var header = data[0];
    var photoCol = header.indexOf('photo_image');
    var sevCol = header.indexOf('severity');
    var statusCol = header.indexOf('status');

    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME, 0);

    // Remember the user's filter so a refresh does not wipe it.
    var filter = sheet.getFilter();
    var criteria = {};
    if (filter) {
      for (var c = 1; c <= header.length; c++) {
        var cr = filter.getColumnFilterCriteria(c);
        if (cr) criteria[c] = cr;
      }
      filter.remove();
    }

    sheet.clearContents();
    sheet.clearFormats();
    var rows = data.map(function (row, i) {
      if (i === 0 || photoCol < 0 || !row[photoCol]) return row;
      var copy = row.slice();
      copy[photoCol] = '=HYPERLINK("' + row[photoCol].replace(/"/g, '""') + '","View photo")';
      return copy;
    });
    // Text columns are written as plain text so user-typed descriptions can
    // never be interpreted as formulas.
    var range = sheet.getRange(1, 1, rows.length, header.length);
    range.setNumberFormat('@');
    range.setValues(rows);
    if (photoCol >= 0 && rows.length > 1) {
      sheet.getRange(2, photoCol + 1, rows.length - 1, 1).setNumberFormat('General');
      var formulas = rows.slice(1).map(function (r) { return [String(r[photoCol]).indexOf('=HYPERLINK(') === 0 ? r[photoCol] : 'No photo']; });
      sheet.getRange(2, photoCol + 1, rows.length - 1, 1).setValues(formulas);
    }

    // Formatting
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#1e293b').setFontColor('#ffffff');
    if (rows.length > 1) {
      var sev = sheet.getRange(2, sevCol + 1, rows.length - 1, 1);
      sev.setBackgrounds(data.slice(1).map(function (r) { return [SEVERITY_COLORS[r[sevCol]] || null]; }));
      sev.setFontColors(data.slice(1).map(function (r) { return [r[sevCol] === 'Critical' ? '#ffffff' : '#0f172a']; }));
      sheet.getRange(2, statusCol + 1, rows.length - 1, 1)
        .setBackgrounds(data.slice(1).map(function (r) { return [STATUS_COLORS[r[statusCol]] || null]; }));
    }
    var descCol = header.indexOf('description');
    if (descCol >= 0) sheet.setColumnWidth(descCol + 1, 380);
    sheet.autoResizeColumns(1, Math.max(1, descCol));

    var newFilter = sheet.getRange(1, 1, Math.max(rows.length, 2), header.length).createFilter();
    Object.keys(criteria).forEach(function (c) { newFilter.setColumnFilterCriteria(Number(c), criteria[c]); });

    writeInfo(ss, 'OK – ' + (rows.length - 1) + ' error reports');
  } finally {
    lock.releaseLock();
  }
}

function writeInfo(ss, message) {
  var info = ss.getSheetByName(INFO_SHEET) || ss.insertSheet(INFO_SHEET);
  info.getRange('A1:B4').setValues([
    ['Last sync', new Date()],
    ['Result', message],
    ['Source', 'Central database (authoritative). Do not edit the Error Reports tab; changes are overwritten.'],
    ['Feed', FEED_URL.replace(/key=[^&]+/, 'key=***')],
  ]);
  info.getRange('A1:A4').setFontWeight('bold');
}
