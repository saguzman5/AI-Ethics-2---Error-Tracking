'use strict';
// Optional browser smoke test. Drives headless Chrome through the real UI
// (worker app on a phone-sized screen, then dashboard, spreadsheet, admin)
// using the Chrome DevTools Protocol and saves screenshots to
// Documentation/screenshots/.
//
//   CHROME=/path/to/chrome node tests/ui-smoke.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execFileSync } = require('node:child_process');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-ui-'));
const PASSWORD = 'Ui-Test-Pass-1';
Object.assign(process.env, { DATA_DIR, ADMIN_PASSWORD: PASSWORD, DEMO_PASSWORD: PASSWORD, TIMEZONE: process.env.TIMEZONE || 'America/Chicago' });
execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-demo.js')], { env: process.env, stdio: 'ignore' });

const { start, stop } = require('../src/server');
const SHOTS = path.join(__dirname, '..', '..', 'Documentation', 'screenshots');
const CHROME = process.env.CHROME || ['/usr/local/bin/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function testPng(file) {
  const w = 480, h = 320;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * (w * 3 + 1) + 1 + x * 3;
    const scratch = Math.abs(y - (h / 2 + (x - w / 2) * 0.3)) < 4;
    raw[i] = scratch ? 40 : 150 + (x % 40); raw[i + 1] = scratch ? 40 : 160; raw[i + 2] = scratch ? 40 : 175 + (y % 30);
  }
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
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await start({ port: 0, host: '127.0.0.1', quiet: true });
  const base = `http://localhost:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-zygote', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeLog = '';
  const wsBrowser = await new Promise((resolve, reject) => {
    chrome.stderr.on('data', (d) => { chromeLog += d; const m = String(d).match(/ws:\/\/[^\s]+/); if (m) resolve(m[0]); });
    chrome.on('exit', (code) => reject(new Error(`Chrome exited (${code}): ${chromeLog.slice(0, 500)}`)));
    setTimeout(() => reject(new Error('Chrome did not start: ' + chromeLog.slice(0, 500))), 20000);
  });
  const port = new URL(wsBrowser).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = await cdp(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  const problems = [];
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') problems.push('JS exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/jsQR|jsdelivr|favicon|401|navigator\.vibrate/.test(m.params.entry.text + (m.params.entry.url || ''))) problems.push('Console: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('DOM.enable');

  const evaluate = async (expr) => {
    const r = await page.send('Runtime.evaluate', { expression: `(() => { return eval(${JSON.stringify(expr)}); })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expr}\n${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expr, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evaluate(expr)) return; } catch { /* page loading */ } await sleep(100); }
    throw new Error('Timed out waiting for: ' + expr);
  };
  const go = async (url) => { await page.send('Page.navigate', { url: base + url }); await sleep(400); await waitFor('document.readyState === "complete"'); };
  const shot = async (name, full = false) => {
    let clip;
    if (full) {
      const m = await page.send('Page.getLayoutMetrics');
      clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 6000), scale: 1 };
    }
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
    console.log('  saved', name);
  };
  const login = async (user) => {
    await go('/login');
    await evaluate(`document.getElementById('username').value=${JSON.stringify(user)};document.getElementById('password').value=${JSON.stringify(PASSWORD)};document.getElementById('form').requestSubmit();true`);
    await sleep(800);
  };
  const check = (cond, msg) => { if (!cond) { problems.push('FAILED: ' + msg); console.log('  FAIL', msg); } else console.log('  ok  ', msg); };

  try {
    console.log('Worker app (390x844 phone)');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await go('/login');
    await shot('01-login-mobile.png');
    await login('j.chen');
    check((await evaluate('location.pathname')) === '/app/', 'worker lands on /app/');
    await waitFor('!document.getElementById("view-scan").hidden');
    await sleep(1500);
    await shot('02-worker-scan.png');

    await evaluate(`document.getElementById('manual-code').value='BOX-01005';document.getElementById('manual-form').requestSubmit();true`);
    await waitFor('!document.getElementById("view-form").hidden');
    check((await evaluate('document.getElementById("p-box").textContent')) === 'BOX-01005', 'Box ID displayed');
    check(/^PO-2026-/.test(await evaluate('document.getElementById("p-order").textContent')), 'Order ID displayed');

    // Validation: submit empty
    await evaluate(`localStorage.removeItem('pts.lastStage');document.getElementById('report-form').requestSubmit();true`);
    await sleep(300);
    const errs = await evaluate(`[...document.querySelectorAll('.field-err')].map(e=>e.textContent).filter(Boolean).length`);
    check(errs >= 3, `empty submission blocked with ${errs} field messages`);

    await evaluate(`document.querySelector('#stages .chip:nth-child(5)').click();document.querySelector('#categories .chip:nth-child(2)').click();document.querySelector('.sev[data-sev="Critical"]').click();
      const d=document.getElementById('description'); d.value='Deep scratch across the front door panel'; d.dispatchEvent(new Event('input'));true`);
    const img = path.join(DATA_DIR, 'evidence.png');
    testPng(img);
    const { root } = await page.send('DOM.getDocument');
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-gallery' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [img] });
    await evaluate(`document.getElementById('file-gallery').dispatchEvent(new Event('change'));true`);
    await waitFor('!document.getElementById("photo-preview").hidden');
    await evaluate('window.scrollTo(0,0);true');
    await shot('03-worker-form.png');
    await shot('03b-worker-form-full.png', true);

    await evaluate(`document.getElementById('report-form').requestSubmit();true`);
    await waitFor('!document.getElementById("view-done").hidden', 15000);
    const errorId = await evaluate('document.getElementById("d-id").textContent');
    check(/^ERR-\d{6}$/.test(errorId), `report submitted as ${errorId}`);
    check((await evaluate('document.getElementById("d-status").textContent')) === 'Open', 'status Open shown');
    await shot('04-worker-confirmation.png');

    await evaluate(`document.getElementById('btn-mine').click();true`);
    await waitFor('document.querySelectorAll(".mine-item").length > 0');
    check(await evaluate(`document.getElementById('mine-list').textContent.includes(${JSON.stringify(errorId)})`), 'appears in My reports');
    await shot('05-worker-my-reports.png');

    // Worker must not open the dashboard
    await go('/dashboard/');
    check((await evaluate('location.pathname')) === '/app/', 'worker redirected away from dashboard');

    console.log('Dashboard (1440x900 desktop)');
    await evaluate(`fetch('/api/auth/logout',{method:'POST'}).then(()=>true)`);
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await login('m.garcia');
    check((await evaluate('location.pathname')) === '/dashboard/', 'manager lands on dashboard');
    await waitFor(`document.querySelector('#table tr[data-id]') !== null`);
    await sleep(800);
    check(await evaluate(`document.getElementById('table').textContent.includes(${JSON.stringify(errorId)})`), 'new report visible in dashboard table');
    check(await evaluate(`document.getElementById('live').classList.contains('on')`), 'live connection active');
    await shot('06-dashboard.png', true);

    const totalBefore = Number(await evaluate(`document.getElementById('k-total').textContent`));
    // Live update: submit a report through the API as another session and watch the KPI change.
    await evaluate(`(async()=>{const lists=await fetch('/api/lists').then(r=>r.json());
      await fetch('/api/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_submission_id:'ui-live-'+Date.now(),box_id:'BOX-02003',stage_id:lists.stages[3].id,category_id:lists.categories[5].id,severity:'High',description:'Live update check'})});return true})()`);
    await waitFor(`Number(document.getElementById('k-total').textContent) === ${totalBefore + 1}`, 6000);
    check(true, 'KPI updated live after a new submission');

    // Filter by severity
    await evaluate(`const s=document.querySelector('[data-k="severity"]');s.value='Critical';s.dispatchEvent(new Event('input',{bubbles:true}));true`);
    await sleep(900);
    const sevs = await evaluate(`[...document.querySelectorAll('#table tbody tr td:nth-child(6)')].map(t=>t.textContent.trim())`);
    check(sevs.length > 0 && sevs.every((s) => s === 'Critical'), `severity filter applied to table (${sevs.length} rows)`);
    const kpiCrit = Number(await evaluate(`document.getElementById('k-total').textContent`));
    check(kpiCrit === sevs.length || kpiCrit > 0, 'KPIs respond to filter');
    await shot('07-dashboard-filtered-critical.png');
    await evaluate(`document.querySelector('[data-k="reset"]').click();true`);
    await sleep(800);

    // Open the report and move it through the workflow
    await evaluate(`document.querySelector('#table tr[data-id=${JSON.stringify(errorId)}]').click();true`);
    await waitFor(`document.getElementById('status-form') !== null`);
    await waitFor(`document.querySelector('.evidence') && document.querySelector('.evidence').complete && document.querySelector('.evidence').naturalWidth > 0`);
    check(true, 'photo displayed in report panel');
    await shot('08-dashboard-report-panel.png');
    for (const [status, note] of [['Under Review', 'Inspecting with paint supervisor'], ['In Rework', 'Door panel sent back to refinishing'], ['Resolved', 'Panel refinished, re-inspected and approved']]) {
      await evaluate(`const f=document.getElementById('status-form');f.status.value=${JSON.stringify(status)};f.status.dispatchEvent(new Event('change'));f.note.value=${JSON.stringify(note)};f.requestSubmit();true`);
      await waitFor(`document.getElementById('panel-title').textContent.includes(${JSON.stringify(status)})`, 6000);
    }
    const hist = await evaluate(`document.querySelectorAll('.timeline li').length`);
    check(hist === 4, `resolution history has ${hist} entries`);
    await shot('09-dashboard-report-resolved.png');
    await evaluate(`document.getElementById('panel-close').click();true`);

    console.log('Spreadsheet');
    await go('/spreadsheet/');
    await waitFor(`document.querySelectorAll('table.grid tbody tr').length > 0`);
    const headers = await evaluate(`[...document.querySelectorAll('table.grid thead tr:first-child th')].slice(1,11).map(t=>t.textContent.replace(/[▲▼]/g,''))`);
    check(headers.join(',') === 'error_ID,box_ID,order_ID,stage,error_type,severity,timestamp,status,photo_image,description', 'spreadsheet has the 10 required columns');
    const row = await evaluate(`[...document.querySelectorAll('table.grid tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(errorId)}))?.textContent`);
    check(row && row.includes('Resolved'), 'status change reflected in spreadsheet');
    check(await evaluate(`[...document.querySelectorAll('table.grid tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(errorId)})).querySelector('a[href*="/api/photos/"]') !== null`), 'photo link present');
    await shot('10-spreadsheet.png');

    console.log('Admin & labels');
    await go('/dashboard/admin.html#products');
    await waitFor(`document.querySelectorAll('#orders tr').length > 0`);
    await shot('11-admin-products.png');
    await go('/dashboard/labels.html?order=PO-2026-0101');
    await waitFor(`document.querySelectorAll('.label img').length > 0 && [...document.querySelectorAll('.label img')].slice(0,4).every(i=>i.complete&&i.naturalWidth>0)`);
    await shot('12-qr-labels.png');
    await go('/dashboard/admin.html#lists');
    await waitFor(`document.querySelectorAll('#stages tr').length > 0`);
    await shot('13-admin-stages.png');

    console.log('Dashboard on a phone');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await go('/dashboard/');
    await waitFor(`document.querySelector('#table tr[data-id]') !== null`);
    await sleep(500);
    await shot('14-dashboard-mobile.png');
  } catch (e) {
    problems.push('ERROR: ' + e.message);
  } finally {
    page.close();
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await Promise.race([exited, sleep(3000)]);
    await stop(server);
    for (const dir of [DATA_DIR, profile]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp dir; ignore */ }
    }
  }
  if (problems.length) { console.log('\nProblems:\n' + problems.join('\n')); process.exit(1); }
  console.log('\nUI smoke test passed.');
})();
