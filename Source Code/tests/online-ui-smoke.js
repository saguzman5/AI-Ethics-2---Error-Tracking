'use strict';
// Browser test of the ONLINE version against a Supabase test double
// (tests/online-mock.js). Checks the page wiring, the calls made to the
// database (function names, parameters and columns are cross-checked
// against Database/supabase-setup.sql) and the full workflow.
//
//   CHROME=/path/to/chrome node tests/online-ui-smoke.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const mock = require('./online-mock');

const CHROME = process.env.CHROME || ['/usr/local/bin/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-online-'));

function testPng(file) {
  const w = 200, h = 120;
  const raw = Buffer.alloc((w * 3 + 1) * h, 120);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) listeners.forEach((l) => l(msg));
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); }),
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

(async () => {
  if (!CHROME) { console.log('Chrome not found; set CHROME=/path/to/chrome'); process.exit(0); }
  const { S, addUser, pgNow } = mock;
  const PW = 'Online-Test-1';
  const manager = addUser('m.garcia@factory.test', PW, 'Maria Garcia');
  const worker = addUser('j.chen@factory.test', PW, 'James Chen');
  const worker2 = addUser('a.okafor@factory.test', PW, 'Amara Okafor');
  S.orders.push({ order_id: 'PO-2026-0101', product_name: 'Pump Housing PH-40', customer: 'Northwind', created_at: pgNow() });
  for (let i = 1; i <= 20; i++) S.products.push({ box_id: `BOX-${String(i).padStart(4, '0')}`, order_id: 'PO-2026-0101', product_name: null, produced_at: pgNow() });
  const sev = ['Low', 'Medium', 'High', 'Critical'];
  // Calls a database function as a given user through the test double.
  async function RPC(name, args, uid) {
    const token = 'direct-' + uid;
    S.tokens.set(token, uid);
    const r = await fetch(base + '/mock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'rpc', name, args, token }) });
    return r.json();
  }

  const { server, base } = await mock.start();
  for (let i = 0; i < 12; i++) {
    await RPC('submit_report', { p_submission_id: `seed-${i}-0000-0000`, p_box_id: `BOX-${String(5 + i).padStart(4, '0')}`, p_order_id: null,
      p_stage_id: 1 + (i % 5), p_category_id: 1 + (i % 6), p_severity: sev[i % 4], p_description: `Seed defect ${i}`, p_photo_path: null, p_confirm_duplicate: false }, i % 2 ? worker : worker2);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-zygote', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  const wsBrowser = await new Promise((resolve, reject) => {
    chrome.stderr.on('data', (d) => { log += d; const m = String(d).match(/ws:\/\/[^\s]+/); if (m) resolve(m[0]); });
    setTimeout(() => reject(new Error('Chrome did not start: ' + log.slice(0, 300))), 20000);
  });
  const port = new URL(wsBrowser).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = await cdp(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  const browser = await cdp(wsBrowser);
  const problems = [];
  page.on(async (m) => {
    if (m.method === 'Runtime.exceptionThrown') problems.push('JS exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon|vibrate|jsqr/i.test(m.params.entry.text + (m.params.entry.url || ''))) problems.push('Console: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    if (m.method === 'Fetch.requestPaused') {
      const u = m.params.request.url;
      if (/supabase-js/.test(u)) await page.send('Fetch.continueRequest', { requestId: m.params.requestId, url: base + '/cdn/supabase.js' });
      else await page.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' });
    }
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://cdn.jsdelivr.net/*' }] });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('DOM.enable');
  const dl = path.join(TMP, 'downloads');
  fs.mkdirSync(dl);
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });

  const evaluate = async (expr) => {
    const r = await page.send('Runtime.evaluate', { expression: `(() => { return eval(${JSON.stringify(expr)}); })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expr}\n${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expr, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evaluate(expr)) return; } catch { /* loading */ } await sleep(100); }
    throw new Error('Timed out waiting for: ' + expr);
  };
  const go = async (rel) => { await page.send('Page.navigate', { url: 'about:blank' }); await sleep(100); await page.send('Page.navigate', { url: base + '/site/' + rel }); await sleep(400); await waitFor('document.readyState === "complete"'); };
  const check = (cond, msg) => { if (!cond) { problems.push('FAILED: ' + msg); console.log('  FAIL', msg); } else console.log('  ok  ', msg); };
  const login = async (user) => {
    await go('');
    await waitFor(`document.getElementById('form') && !document.getElementById('username').disabled`);
    await evaluate(`document.getElementById('username').value=${JSON.stringify(user)};document.getElementById('password').value=${JSON.stringify(PW)};document.getElementById('form').requestSubmit();true`);
    await sleep(1200);
  };
  const SHOTS = path.join(__dirname, '..', '..', 'Documentation', 'screenshots');
  const shot = async (name) => { const { data } = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64')); };

  try {
    console.log('Worker (phone)');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await login('wrong.user');
    check(/Incorrect/.test(await evaluate(`document.getElementById('err').textContent`)), 'wrong login rejected');
    await login('j.chen');
    check((await evaluate('location.pathname')) === '/site/app/', 'worker signs in with username and lands on app/');
    await waitFor('!document.getElementById("view-scan").hidden');
    await evaluate(`document.getElementById('manual-code').value='BOX-0003';document.getElementById('manual-form').requestSubmit();true`);
    await waitFor('!document.getElementById("view-form").hidden');
    check((await evaluate('document.getElementById("p-order").textContent')) === 'PO-2026-0101', 'box lookup shows Order ID');
    await evaluate(`localStorage.removeItem('pts.lastStage');document.getElementById('report-form').requestSubmit();true`);
    await sleep(300);
    check((await evaluate(`[...document.querySelectorAll('.field-err')].filter(e=>e.textContent).length`)) >= 3, 'incomplete submission blocked');
    await evaluate(`document.querySelector('#stages .chip:nth-child(5)').click();document.querySelector('#categories .chip:nth-child(2)').click();document.querySelector('.sev[data-sev="Critical"]').click();
      const d=document.getElementById('description'); d.value='Deep scratch on door panel'; d.dispatchEvent(new Event('input'));true`);
    const img = path.join(TMP, 'p.png');
    testPng(img);
    const { root } = await page.send('DOM.getDocument');
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-gallery' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [img] });
    await evaluate(`document.getElementById('file-gallery').dispatchEvent(new Event('change'));true`);
    await waitFor('!document.getElementById("photo-preview").hidden');
    await evaluate(`document.getElementById('report-form').requestSubmit();true`);
    await waitFor('!document.getElementById("view-done").hidden', 10000);
    const errorId = await evaluate('document.getElementById("d-id").textContent');
    check(/^ERR-\d{6}$/.test(errorId), `report submitted as ${errorId}`);
    check(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(await evaluate('document.getElementById("d-time").textContent')), 'local timestamp shown');
    check(S.photos.size === 1 && [...S.photos.keys()][0].startsWith(worker + '/'), 'photo stored in the worker folder');
    check(S.reports.find((r) => r.error_id === errorId).photo_path !== null, 'report linked to photo');
    await shot('online-01-worker-confirmation.png');

    // Same box/stage/type again -> duplicate warning
    await evaluate(`document.getElementById('btn-same').click();true`);
    await waitFor('!document.getElementById("view-form").hidden');
    await evaluate(`document.querySelector('#stages .chip:nth-child(5)').click();document.querySelector('#categories .chip:nth-child(2)').click();document.querySelector('.sev[data-sev="High"]').click();
      const d=document.getElementById('description'); d.value='Same scratch again'; d.dispatchEvent(new Event('input')); document.getElementById('report-form').requestSubmit();true`);
    await waitFor('!document.getElementById("dup-warning").hidden', 6000);
    check(true, 'possible duplicate warning shown');
    await evaluate(`document.getElementById('btn-dup-confirm').click();true`);
    await waitFor('!document.getElementById("view-done").hidden', 6000);
    check(true, 'confirmed duplicate submitted');

    await evaluate(`document.getElementById('btn-mine').click();true`);
    await waitFor('document.querySelectorAll(".mine-item").length > 0');
    check(await evaluate(`document.getElementById('mine-list').textContent.includes(${JSON.stringify(errorId)})`), 'My reports lists the report');
    check(!(await evaluate(`document.getElementById('mine-list').textContent.includes('Seed defect 0')`)), 'worker does not see other workers\' reports');

    await go('dashboard/');
    await sleep(1500);
    check((await evaluate('location.pathname')) === '/site/app/', 'worker is sent away from the dashboard');

    await page.send('Page.navigate', { url: base + '/site/app/?box=BOX-0010&order=PO-2026-0101' });
    await waitFor('!document.getElementById("view-form").hidden && document.getElementById("p-box").textContent === "BOX-0010"');
    check(true, 'QR label link opens the form with the box selected');
    await evaluate(`document.getElementById('btn-logout').click();true`);
    await sleep(800);
    check((await evaluate('location.pathname')) === '/site/', 'sign out returns to the login page');

    console.log('Manager (desktop)');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await login('m.garcia@factory.test');
    check((await evaluate('location.pathname')) === '/site/dashboard/', 'manager lands on the dashboard');
    await waitFor(`document.querySelector('#table tr[data-id]') !== null`);
    check(await evaluate(`document.getElementById('table').textContent.includes(${JSON.stringify(errorId)})`), 'new report in dashboard table');
    check(Number(await evaluate(`document.getElementById('k-total').textContent`)) === S.reports.length, 'total errors KPI matches the database');
    const rr = await evaluate(`document.getElementById('k-rr').textContent`);
    check(rr === '0.0%', `rework rate shown (${rr})`);
    await waitFor(`document.getElementById('live').classList.contains('on')`);
    check(true, 'live indicator on');
    await shot('online-02-dashboard.png');

    const before = Number(await evaluate(`document.getElementById('k-total').textContent`));
    await RPC('submit_report', { p_submission_id: 'live-0000-0000-0001', p_box_id: 'BOX-0019', p_order_id: null, p_stage_id: 2, p_category_id: 3,
      p_severity: 'High', p_description: 'Live update check', p_photo_path: null, p_confirm_duplicate: false }, worker2);
    await waitFor(`Number(document.getElementById('k-total').textContent) === ${before + 1}`, 6000);
    check(true, 'dashboard updates live after a new submission');

    await evaluate(`const s=document.querySelector('[data-k="severity"]');s.value='Critical';s.dispatchEvent(new Event('input',{bubbles:true}));true`);
    await sleep(900);
    const sevs = await evaluate(`[...document.querySelectorAll('#table tbody tr td:nth-child(6)')].map(t=>t.textContent.trim())`);
    check(sevs.length === S.reports.filter((r) => r.severity === 'Critical').length && sevs.every((s) => s === 'Critical'), `severity filter (${sevs.length} rows)`);
    check(Number(await evaluate(`document.getElementById('k-total').textContent`)) === sevs.length, 'KPIs follow the filter');
    await evaluate(`document.querySelector('[data-k="reset"]').click();true`);
    await sleep(700);

    await evaluate(`document.querySelector('#table tr[data-id=${JSON.stringify(errorId)}]').click();true`);
    await waitFor(`document.getElementById('status-form') !== null`);
    await waitFor(`document.querySelector('.evidence') && document.querySelector('.evidence').complete && document.querySelector('.evidence').naturalWidth > 0`);
    check(true, 'photo displays in the report panel');
    for (const [status, note] of [['Under Review', 'Inspecting'], ['In Rework', 'Sent to refinishing'], ['Resolved', 'Refinished and approved']]) {
      await evaluate(`const f=document.getElementById('status-form');f.status.value=${JSON.stringify(status)};f.status.dispatchEvent(new Event('change'));f.note.value=${JSON.stringify(note)};f.requestSubmit();true`);
      await waitFor(`document.getElementById('panel-title').textContent.includes(${JSON.stringify(status)})`, 6000);
    }
    check((await evaluate(`document.querySelectorAll('.timeline li').length`)) === 4, 'history shows 4 entries');
    const rep = S.reports.find((r) => r.error_id === errorId);
    check(rep.status === 'Resolved' && rep.requires_rework && rep.resolved_at, 'database has Resolved + rework + resolved_at');
    await shot('online-03-report-panel.png');
    await evaluate(`const f=document.getElementById('correct-form');f.severity.value='High';f.requestSubmit();true`);
    await waitFor(`document.getElementById('panel-title').textContent.includes('High')`, 5000);
    check(S.revisions.some((v) => v.field === 'severity'), 'classification correction logged');
    await evaluate(`document.getElementById('panel-close').click();true`);
    await sleep(1000);
    check((await evaluate(`document.getElementById('k-rr').textContent`)) === '5.0%', 'rework rate = 1 reworked box / 20 products');

    // Exports
    await evaluate(`document.getElementById('exp-csv').click();true`);
    await sleep(1500);
    const xerr = await evaluate(`PTS_BACKEND.exportReports('xlsx', '').then(() => 'ok', (e) => e.message)`);
    if (xerr !== 'ok') problems.push('xlsx export error: ' + xerr);
    const end = Date.now() + 8000;
    let files = [];
    while (Date.now() < end) { files = fs.readdirSync(dl).filter((f) => !f.endsWith('.crdownload')); if (files.length >= 2) break; await sleep(200); }
    const csv = files.find((f) => f.endsWith('.csv'));
    const xlsx = files.find((f) => f.endsWith('.xlsx'));
    check(csv && fs.readFileSync(path.join(dl, csv), 'utf8').replace(/^\uFEFF/, '').startsWith('error_ID,box_ID,order_ID,stage,error_type,severity,timestamp,status,photo_image,description'), 'CSV export downloaded with required columns');
    check(xlsx && fs.readFileSync(path.join(dl, xlsx)).subarray(0, 2).toString() === 'PK', 'Excel export downloaded');
    if (xlsx) fs.copyFileSync(path.join(dl, xlsx), path.join(TMP, 'export.xlsx'));
    if (xlsx) console.log('  xlsx file:', path.join(TMP, 'export.xlsx'));

    console.log('Spreadsheet');
    await go('spreadsheet/');
    await waitFor(`document.querySelectorAll('table.grid tbody tr').length > 0`);
    const headers = await evaluate(`[...document.querySelectorAll('table.grid thead tr:first-child th')].slice(1,11).map(t=>t.textContent.replace(/[▲▼]/g,''))`);
    check(headers.join(',') === 'error_ID,box_ID,order_ID,stage,error_type,severity,timestamp,status,photo_image,description', 'required columns');
    check(Number((await evaluate(`document.getElementById('count').textContent`)).split(' ')[0]) === S.reports.length, 'one row per report');
    const row = await evaluate(`[...document.querySelectorAll('table.grid tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(errorId)}))?.innerHTML`);
    check(row && row.includes('Resolved') && row.includes('/mockphoto/'), 'status and photo link in spreadsheet');

    console.log('Admin');
    await go('dashboard/admin.html#lists');
    await waitFor(`document.querySelectorAll('#stages tr').length > 0`);
    await evaluate(`const f=document.getElementById('add-stage');f.name.value='Final Test Bench';f.requestSubmit();true`);
    await waitFor(`document.getElementById('stages').innerHTML.includes('Final Test Bench')`, 5000);
    check(true, 'stage added');
    await evaluate(`const f=document.getElementById('add-category');f.name.value='surface defect / scratch';f.requestSubmit();true`);
    await sleep(800);
    check(S.categories.length === 12, 'duplicate error type rejected');
    check(S.settings.app_url === base + '/site/', 'site address saved for spreadsheet links');

    await go('dashboard/admin.html#products');
    await waitFor(`document.querySelectorAll('#orders tr').length > 0`);
    await evaluate(`window.open=()=>null;const f=document.getElementById('add-products');f.order_id.value='PO-NEW-1';f.count.value='3';f.requestSubmit();true`);
    await sleep(1000);
    check(S.products.filter((p) => p.order_id === 'PO-NEW-1').length === 3, 'batch of boxes registered');
    await go('dashboard/labels.html?order=PO-NEW-1');
    await waitFor(`document.querySelectorAll('.label img').length === 3 && [...document.querySelectorAll('.label img')].every(i=>i.complete&&i.naturalWidth>0)`);
    check(true, 'QR labels rendered');

    await go('dashboard/admin.html#users');
    await waitFor(`document.querySelectorAll('#users tr[data-id]').length === 3`);
    await evaluate(`const tr=document.querySelector('#users tr[data-id=${JSON.stringify(worker2)}]');tr.querySelector('.uactive').checked=false;tr.querySelector('.usave').click();true`);
    await sleep(800);
    check(S.profiles.find((p) => p.id === worker2).active === false, 'user deactivated');

    await go('dashboard/admin.html#settings');
    await waitFor(`document.getElementById('settings-form').timezone.value !== ''`);
    await evaluate(`const f=document.getElementById('settings-form');f.timezone.value='Europe/Madrid';f.require_photo.checked=true;f.requestSubmit();true`);
    await sleep(800);
    check(S.settings.timezone === 'Europe/Madrid' && S.settings.require_photo === 'true', 'settings saved');

    await go('dashboard/admin.html#sheet');
    await waitFor(`document.getElementById('feed-config').value.includes('FEED_KEY')`);
    check(await evaluate(`document.getElementById('feed-config').value.includes(${JSON.stringify(S.feedKey)})`), 'Google Sheets settings shown');

    await go(`dashboard/?report=${errorId}`);
    await waitFor(`document.getElementById('panel') && document.getElementById('panel').classList.contains('open') && document.getElementById('status-form') !== null`);
    check(true, 'spreadsheet photo link opens the report');
  } catch (e) {
    problems.push('ERROR: ' + e.message);
    try { problems.push('Toasts on screen: ' + await evaluate(`(document.getElementById('toasts')||{}).textContent || '(none)'`)); } catch { /* ignore */ }
  } finally {
    page.close();
    chrome.kill();
    server.close();
    await sleep(500);
  }
  problems.push(...S.problems.map((p) => 'SQL/backend mismatch: ' + p));
  if (problems.length) { console.log('\nProblems:\n' + [...new Set(problems)].join('\n')); process.exit(1); }
  console.log(`\nOnline UI test passed. Functions in SQL: ${Object.keys(mock.FUNCS).length}; calls made: ${new Set(S.calls).size} kinds.`);
})();
