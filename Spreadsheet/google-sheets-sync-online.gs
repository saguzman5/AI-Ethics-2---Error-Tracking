/**
 * Google Sheets live sync for the ONLINE version (Supabase).
 *
 * Mirrors all error reports from the online database into the
 * "Error Reports" tab every minute. The tab is rebuilt on every sync, so it
 * always has exactly one row per report with the latest status.
 *
 * Setup (once):
 *   1. Google Sheet -> Extensions -> Apps Script. Replace the editor contents
 *      with this file.
 *   2. Replace the three settings lines below with the ones shown in the app
 *      under Admin -> Spreadsheet connection -> Copy settings. Save.
 *   3. Select the function "setup" and click Run. Approve the permissions.
 */

var SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
var SUPABASE_KEY = 'PASTE-PUBLISHABLE-KEY';
var FEED_KEY = 'PASTE-FEED-KEY';

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
  if (!lock.tryLock(20000)) return;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var response = UrlFetchApp.fetch(SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/sheet_feed', {
      method: 'post',
      contentType: 'application/json',
      headers: { apikey: SUPABASE_KEY },
      payload: JSON.stringify({ p_key: FEED_KEY }),
      muteHttpExceptions: true,
    });
    if (response.getResponseCode() !== 200) {
      writeInfo(ss, 'ERROR ' + response.getResponseCode() + ': ' + response.getContentText().slice(0, 300));
      return;
    }
    var data = JSON.parse(response.getContentText('UTF-8'));
    if (!data || !data.length) { writeInfo(ss, 'ERROR: empty feed'); return; }

    var header = data[0];
    var photoCol = header.indexOf('photo_image');
    var sevCol = header.indexOf('severity');
    var statusCol = header.indexOf('status');
    var descCol = header.indexOf('description');
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME, 0);

    // Keep the user's column filters across refreshes.
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
    var rows = data.map(function (r) { return r.map(function (v) { return v === null ? '' : String(v); }); });
    var range = sheet.getRange(1, 1, rows.length, header.length);
    range.setNumberFormat('@'); // plain text: typed descriptions can never become formulas
    range.setValues(rows);
    if (photoCol >= 0 && rows.length > 1) {
      var links = rows.slice(1).map(function (r) {
        var u = r[photoCol];
        return [u ? '=HYPERLINK("' + u.replace(/"/g, '""') + '","View photo")' : 'No photo'];
      });
      var photoRange = sheet.getRange(2, photoCol + 1, rows.length - 1, 1);
      photoRange.setNumberFormat('General');
      photoRange.setValues(links);
    }

    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#1e293b').setFontColor('#ffffff');
    if (rows.length > 1) {
      var sev = sheet.getRange(2, sevCol + 1, rows.length - 1, 1);
      sev.setBackgrounds(rows.slice(1).map(function (r) { return [SEVERITY_COLORS[r[sevCol]] || null]; }));
      sev.setFontColors(rows.slice(1).map(function (r) { return [r[sevCol] === 'Critical' ? '#ffffff' : '#0f172a']; }));
      sheet.getRange(2, statusCol + 1, rows.length - 1, 1)
        .setBackgrounds(rows.slice(1).map(function (r) { return [STATUS_COLORS[r[statusCol]] || null]; }));
    }
    if (descCol >= 0) sheet.setColumnWidth(descCol + 1, 380);
    sheet.autoResizeColumns(1, Math.max(1, descCol));

    var newFilter = sheet.getRange(1, 1, Math.max(rows.length, 2), header.length).createFilter();
    Object.keys(criteria).forEach(function (c) { newFilter.setColumnFilterCriteria(Number(c), criteria[c]); });

    writeInfo(ss, 'OK - ' + (rows.length - 1) + ' error reports');
  } finally {
    lock.releaseLock();
  }
}

function writeInfo(ss, message) {
  var info = ss.getSheetByName(INFO_SHEET) || ss.insertSheet(INFO_SHEET);
  info.getRange('A1:B3').setValues([
    ['Last sync', new Date()],
    ['Result', message],
    ['Source', 'Online database (authoritative). Do not edit the Error Reports tab; changes are overwritten.'],
  ]);
  info.getRange('A1:A3').setFontWeight('bold');
}
