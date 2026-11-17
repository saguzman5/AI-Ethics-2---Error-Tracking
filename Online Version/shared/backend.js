/* Data layer of the online version. The pages call PTS.api('/api/...')
   exactly like the server version; this file answers those calls with the
   Supabase database, storage and auth. All permission checks happen inside
   the database (row-level security and functions in supabase-setup.sql). */
(function () {
  'use strict';
  const { ApiError, sb } = PTS;

  const SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];
  const STATUSES = ['Open', 'Under Review', 'In Rework', 'Resolved'];
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}$/;
  const PAGE = 1000;

  // ------------------------------------------------------------------ errors
  function toApiError(err) {
    if (err instanceof ApiError) return err;
    const msg = String((err && (err.message || err.error_description || err.error)) || err || 'Unknown error');
    const code = err && err.code;
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
      return new ApiError(0, { error: 'Cannot reach the online database. Check your Wi-Fi or mobile data connection.' });
    }
    if (/JWT|not authenticated|Please sign in|Auth session missing|refresh token/i.test(msg) || code === 'PGRST301') {
      return new ApiError(401, { error: 'Please sign in again' });
    }
    if (/changed by someone else/.test(msg)) return new ApiError(409, { error: msg, code: 'STALE' });
    if (code === '23505' || /duplicate key/i.test(msg)) return new ApiError(409, { error: 'An item with this name already exists' });
    if (code === '42501' || /Manager access required|permission denied|row-level security/i.test(msg)) {
      return new ApiError(403, { error: /Manager access/.test(msg) ? msg : 'You do not have permission to do this' });
    }
    if (/not found/i.test(msg) || /not registered/.test(msg)) return new ApiError(404, { error: msg });
    if (/belongs to order|already exists|is taken/.test(msg)) return new ApiError(409, { error: msg });
    return new ApiError(400, { error: msg });
  }

  async function run(query) {
    let res;
    try { res = await query; } catch (e) { throw toApiError(e); }
    if (res.error) throw toApiError(res.error);
    return res;
  }
  async function rpc(name, args) {
    return (await run(sb().rpc(name, args || {}))).data;
  }

  // ------------------------------------------------------------------ session
  let uid = null;
  let email = null;
  let settings = null;

  async function requireSession() {
    let session;
    try { session = (await sb().auth.getSession()).data.session; } catch (e) { throw toApiError(e); }
    if (!session) throw new ApiError(401, { error: 'Please sign in' });
    uid = session.user.id;
    email = session.user.email;
    return session;
  }

  async function loadSettings(force) {
    if (settings && !force) return settings;
    const { data } = await run(sb().from('app_settings').select('key,value'));
    settings = Object.fromEntries(data.map((r) => [r.key, r.value]));
    return settings;
  }

  async function me() {
    await requireSession();
    const { data: profile } = await run(sb().from('profiles').select('id,username,full_name,role,active').eq('id', uid).maybeSingle());
    if (!profile) throw new ApiError(403, { error: 'This login has no profile yet. Ask a manager to run supabase-setup.sql again.' });
    if (!profile.active) {
      await sb().auth.signOut();
      throw new ApiError(403, { error: 'Your account is deactivated. Ask a manager.' });
    }
    const s = await loadSettings(true);
    return {
      user: { id: profile.id, username: profile.username, full_name: profile.full_name, role: profile.role, email },
      timezone: s.timezone || 'UTC',
      require_photo: s.require_photo === 'true',
      auto_register_products: s.auto_register_products !== 'false',
    };
  }

  async function login(body) {
    let id = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!id || !password) throw new ApiError(400, { error: 'Enter your username and password' });
    if (!id.includes('@')) {
      const domain = String(PTS.cfg.LOGIN_EMAIL_DOMAIN || '').trim().replace(/^@/, '');
      if (!domain) throw new ApiError(400, { error: 'Enter the email address of your login' });
      id = `${id}@${domain}`;
    }
    const { error } = await sb().auth.signInWithPassword({ email: id.toLowerCase(), password });
    if (error) {
      if (/invalid login|invalid credentials/i.test(error.message)) throw new ApiError(401, { error: 'Incorrect username or password' });
      throw toApiError(error);
    }
    return { user: (await me()).user };
  }

  async function changePassword(body) {
    await requireSession();
    const next = String(body.new_password || '');
    if (next.length < 8) throw new ApiError(400, { error: 'Password must be at least 8 characters' });
    const check = await sb().auth.signInWithPassword({ email, password: String(body.current_password || '') });
    if (check.error) throw new ApiError(400, { error: 'Current password is incorrect' });
    const { error } = await sb().auth.updateUser({ password: next });
    if (error) throw toApiError(error);
    return { ok: true };
  }

  // ------------------------------------------------------------------ QR payload
  function cleanId(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return ID_RE.test(s) ? s : null;
  }
  function parseCode(raw) {
    const text = String(raw || '').trim();
    if (!text || text.length > 2000) return null;
    if (text.startsWith('{')) {
      try {
        const o = JSON.parse(text);
        const box = cleanId(o.box_id ?? o.boxId ?? o.box);
        return box ? { box_id: box, order_id: cleanId(o.order_id ?? o.orderId ?? o.order) } : null;
      } catch { return null; }
    }
    if (/^https?:\/\//i.test(text)) {
      try {
        const u = new URL(text);
        const box = cleanId(u.searchParams.get('box') ?? u.searchParams.get('box_id'));
        return box ? { box_id: box, order_id: cleanId(u.searchParams.get('order') ?? u.searchParams.get('order_id')) } : null;
      } catch { return null; }
    }
    if (/[;|]/.test(text) || /^box(_id)?\s*[:=]/i.test(text)) {
      const kv = {};
      for (const part of text.split(/[;|]/)) {
        const m = /^\s*([A-Za-z_]+)\s*[:=]\s*(.+?)\s*$/.exec(part);
        if (m) kv[m[1].toLowerCase()] = m[2];
      }
      const box = cleanId(kv.box ?? kv.box_id);
      return box ? { box_id: box, order_id: cleanId(kv.order ?? kv.order_id) } : null;
    }
    const box = cleanId(text);
    return box ? { box_id: box, order_id: null } : null;
  }

  async function lookup(code) {
    const parsed = parseCode(code);
    if (!parsed) throw new ApiError(400, { error: 'This QR code does not contain a valid Box ID' });
    const p = await rpc('product_info', { p_box: parsed.box_id });
    if (p) {
      if (parsed.order_id && parsed.order_id !== p.order_id) {
        throw new ApiError(409, { error: `QR code says order ${parsed.order_id}, but box ${p.box_id} is registered to order ${p.order_id}. Report this label to a manager.` });
      }
      return p;
    }
    const s = await loadSettings();
    if (parsed.order_id && s.auto_register_products !== 'false') {
      return { box_id: parsed.box_id, order_id: parsed.order_id, product_name: null, registered: false, open_errors: [] };
    }
    throw new ApiError(404, { error: `Box ${parsed.box_id} is not registered. Ask a manager to register it.` });
  }

  // ------------------------------------------------------------------ photos
  const signedCache = new Map(); // path -> { url, until }
  async function signPhotos(paths, seconds = 3600, useCache = true) {
    const out = new Map();
    const todo = [];
    for (const p of new Set(paths.filter(Boolean))) {
      const c = useCache && signedCache.get(p);
      if (c && c.until > Date.now()) out.set(p, c.url); else todo.push(p);
    }
    for (let i = 0; i < todo.length; i += 500) {
      const chunk = todo.slice(i, i + 500);
      const { data } = await run(sb().storage.from('photos').createSignedUrls(chunk, seconds));
      for (const d of data || []) {
        if (d.signedUrl) {
          out.set(d.path, d.signedUrl);
          if (useCache) signedCache.set(d.path, { url: d.signedUrl, until: Date.now() + (seconds - 600) * 1000 });
        }
      }
    }
    return out;
  }

  function dataUrlToBlob(dataUrl) {
    const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(dataUrl || '');
    if (!m) throw new ApiError(400, { error: 'Photo must be a JPEG, PNG or WebP image' });
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length > 8 * 1024 * 1024) throw new ApiError(413, { error: 'Photo is too large (max 8 MB)' });
    return { blob: new Blob([bytes], { type: m[1] }), ext: m[2] === 'jpeg' ? 'jpg' : m[2] };
  }

  // ------------------------------------------------------------------ reports
  async function submit(body) {
    await requireSession();
    const sid = String(body.client_submission_id || '').toLowerCase();
    let photoPath = null;
    if (body.photo) {
      const { blob, ext } = dataUrlToBlob(body.photo);
      photoPath = `${uid}/${sid}.${ext}`;
      const up = await sb().storage.from('photos').upload(photoPath, blob, { contentType: blob.type, upsert: false });
      // "already exists" means a retry of this same submission: the photo is there.
      if (up.error && !/exist|duplicate|409/i.test(`${up.error.message} ${up.error.statusCode || ''} ${up.error.error || ''}`)) {
        throw toApiError(up.error);
      }
    }
    const res = await rpc('submit_report', {
      p_submission_id: sid,
      p_box_id: body.box_id || '',
      p_order_id: body.order_id || null,
      p_stage_id: Number(body.stage_id) || null,
      p_category_id: Number(body.category_id) || null,
      p_severity: body.severity || null,
      p_description: body.description || '',
      p_photo_path: photoPath,
      p_confirm_duplicate: !!body.confirm_duplicate,
    });
    if (res.result === 'possible_duplicate') {
      throw new ApiError(409, {
        error: `A similar report (${res.error_id}) for this box was submitted at ${res.reported_at_local}.`,
        code: 'POSSIBLE_DUPLICATE', error_id: res.error_id,
      });
    }
    return { duplicate: res.result === 'existing', report: { ...res, timestamp_local: PTS.fmt(res.timestamp) } };
  }

  async function mine() {
    await requireSession();
    const { data } = await run(sb().from('v_error_reports')
      .select('error_id,box_id,order_id,stage,error_type,severity,timestamp,status')
      .eq('reported_by', uid).order('timestamp', { ascending: false }).limit(20));
    return data.map((r) => ({ ...r, timestamp_local: PTS.fmt(r.timestamp) }));
  }

  const list = (v) => (v === undefined || v === null || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean));
  function parseFilters(q) {
    return {
      from: /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : null,
      to: /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : null,
      stage_id: list(q.stage_id).map(Number).filter(Number.isInteger),
      category_id: list(q.category_id).map(Number).filter(Number.isInteger),
      severity: list(q.severity).filter((s) => SEVERITIES.includes(s)),
      status: list(q.status).filter((s) => STATUSES.includes(s)),
      order_id: (q.order_id || '').trim().slice(0, 64) || null,
      box_id: (q.box_id || '').trim().slice(0, 64) || null,
    };
  }
  const likeEsc = (s) => s.replace(/[\\%_*]/g, (c) => '\\' + c);

  function reportFilters(query, f) {
    let q = query;
    if (f.from) q = q.gte('timestamp', PTS.localMidnightUtc(f.from));
    if (f.to) q = q.lt('timestamp', PTS.localMidnightUtc(PTS.addDays(f.to, 1)));
    if (f.stage_id.length) q = q.in('stage_id', f.stage_id);
    if (f.category_id.length) q = q.in('category_id', f.category_id);
    if (f.severity.length) q = q.in('severity', f.severity);
    if (f.status.length) q = q.in('status', f.status);
    if (f.order_id) q = q.ilike('order_id', `%${likeEsc(f.order_id)}%`);
    if (f.box_id) q = q.ilike('box_id', `%${likeEsc(f.box_id)}%`);
    return q;
  }
  // Only filters that describe products apply to the product count.
  function productFilters(query, f) {
    let q = query;
    if (f.from) q = q.gte('produced_at', PTS.localMidnightUtc(f.from));
    if (f.to) q = q.lt('produced_at', PTS.localMidnightUtc(PTS.addDays(f.to, 1)));
    if (f.order_id) q = q.ilike('order_id', `%${likeEsc(f.order_id)}%`);
    if (f.box_id) q = q.ilike('box_id', `%${likeEsc(f.box_id)}%`);
    return q;
  }

  const SORT = { error_id: 'error_id', box_id: 'box_id', order_id: 'order_id', stage: 'stage', error_type: 'error_type',
    severity: 'severity_rank', timestamp: 'timestamp', status: 'status_rank', description: 'description', resolved_at: 'resolved_at' };

  // Fetches up to `limit` rows in pages (Supabase returns 1000 rows per request).
  async function fetchAll(make, limit) {
    const rows = [];
    let total = null;
    for (let from = 0; from < limit; from += PAGE) {
      const to = Math.min(from + PAGE, limit) - 1;
      const res = await run(make(from === 0).range(from, to));
      if (from === 0) total = res.count;
      rows.push(...res.data);
      if (res.data.length < to - from + 1) break;
    }
    return { rows, total: total ?? rows.length };
  }

  function present(r, urls) {
    return {
      error_id: r.error_id, box_id: r.box_id, order_id: r.order_id, stage: r.stage, error_type: r.error_type,
      severity: r.severity, timestamp: r.timestamp, timestamp_local: PTS.fmt(r.timestamp), status: r.status,
      photo_path: r.photo_path, photo_image: r.photo_path ? (urls.get(r.photo_path) || null) : null,
      description: r.description, requires_rework: !!r.requires_rework, resolution_notes: r.resolution_notes,
      status_changed_at: r.status_changed_at, resolved_at: r.resolved_at,
      resolved_at_local: r.resolved_at ? PTS.fmt(r.resolved_at) : null, updated_at: r.updated_at,
      stage_id: r.stage_id, category_id: r.category_id, reported_by_name: r.reported_by_name, product_name: r.product_name,
    };
  }

  async function listReports(f, { sort = 'timestamp', dir = 'desc', limit = 5000 } = {}, photoSeconds) {
    await requireSession();
    const col = SORT[sort] || 'timestamp';
    const asc = String(dir).toLowerCase() === 'asc';
    const lim = Math.min(Math.max(parseInt(limit, 10) || 5000, 1), 50000);
    const { rows, total } = await fetchAll((first) => reportFilters(
      sb().from('v_error_reports').select('*', first ? { count: 'exact' } : undefined), f)
      .order(col, { ascending: asc }).order('error_id', { ascending: asc }), lim);
    const urls = await signPhotos(rows.map((r) => r.photo_path), photoSeconds || 3600, !photoSeconds);
    return { total, rows: rows.map((r) => present(r, urls)) };
  }

  async function getReport(errorId) {
    await requireSession();
    const { data } = await run(sb().from('v_error_reports').select('*').eq('error_id', errorId).maybeSingle());
    if (!data) throw new ApiError(404, { error: `Error report ${errorId} not found` });
    const urls = await signPhotos([data.photo_path]);
    const h = await rpc('report_history', { p_error_id: errorId });
    return { ...present(data, urls), history: h.history || [], revisions: h.revisions || [] };
  }

  async function changeStatus(errorId, body) {
    await rpc('change_status', {
      p_error_id: errorId,
      p_status: body.status,
      p_note: body.note || null,
      p_requires_rework: typeof body.requires_rework === 'boolean' ? body.requires_rework : null,
      p_expected_updated_at: body.expected_updated_at || null,
    });
    return getReport(errorId);
  }

  async function correctReport(errorId, body) {
    await rpc('correct_report', {
      p_error_id: errorId,
      p_stage_id: body.stage_id !== undefined ? Number(body.stage_id) : null,
      p_category_id: body.category_id !== undefined ? Number(body.category_id) : null,
      p_severity: body.severity !== undefined ? body.severity : null,
      p_requires_rework: typeof body.requires_rework === 'boolean' ? body.requires_rework : null,
      p_expected_updated_at: body.expected_updated_at || null,
    });
    return getReport(errorId);
  }

  // ------------------------------------------------------------------ metrics
  // Formulas: Documentation/METRICS.md.
  async function metrics(f) {
    await requireSession();
    const { rows } = await fetchAll(() => reportFilters(sb().from('v_error_reports')
      .select('error_id,box_id,stage,error_type,severity,status,timestamp,resolved_at,requires_rework'), f)
      .order('timestamp', { ascending: true }).order('error_id', { ascending: true }), 200000);
    const { count: productsInScope } = await run(productFilters(sb().from('products').select('box_id', { count: 'exact', head: true }), f));

    const count = (pred) => rows.filter(pred).length;
    const tally = (key) => {
      const m = new Map();
      for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + 1);
      return [...m.entries()].map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    };
    const affected = new Set(rows.map((r) => r.box_id));
    const reworkBoxes = new Set(rows.filter((r) => r.requires_rework).map((r) => r.box_id));
    const resolved = rows.filter((r) => r.status === 'Resolved' && r.resolved_at);
    const hrs = resolved.map((r) => (Date.parse(r.resolved_at) - Date.parse(r.timestamp)) / 3600000);
    const avg = hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null;
    const sorted = [...hrs].sort((a, b) => a - b);
    const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;

    const byDay = new Map();
    for (const r of rows) { const k = PTS.dateKey(r.timestamp); byDay.set(k, (byDay.get(k) || 0) + 1); }
    const days = [...byDay.keys()].sort();
    const start = f.from || days[0];
    const end = f.to || days[days.length - 1];
    const overTime = [];
    if (start && end && start <= end) {
      for (let d = start, i = 0; d <= end && i < 1000; d = PTS.addDays(d, 1), i++) overTime.push({ date: d, count: byDay.get(d) || 0 });
    }

    const combos = new Map();
    for (const r of rows) {
      const k = `${r.error_type}\u0000${r.stage}`;
      const c = combos.get(k) || { error_type: r.error_type, stage: r.stage, count: 0, critical_high: 0, last: r.timestamp };
      c.count++;
      if (r.severity === 'High' || r.severity === 'Critical') c.critical_high++;
      if (Date.parse(r.timestamp) > Date.parse(c.last)) c.last = r.timestamp;
      combos.set(k, c);
    }
    const topIssues = [...combos.values()].sort((a, b) => b.count - a.count || b.critical_high - a.critical_high).slice(0, 10)
      .map((c) => ({ ...c, share: rows.length ? c.count / rows.length : 0, last_local: PTS.fmt(c.last) }));

    const ratio = (a, b) => (b ? a / b : null);
    const products = productsInScope || 0;
    return {
      timezone: PTS.tz(),
      kpis: {
        total_errors: rows.length,
        unresolved_errors: count((r) => r.status !== 'Resolved'),
        high_critical_errors: count((r) => r.severity === 'High' || r.severity === 'Critical'),
        critical_errors: count((r) => r.severity === 'Critical'),
        resolved_errors: resolved.length,
        rework_rate: ratio(reworkBoxes.size, products),
      },
      status_counts: Object.fromEntries(STATUSES.map((s) => [s, count((r) => r.status === s)])),
      severity_counts: Object.fromEntries(SEVERITIES.map((s) => [s, count((r) => r.severity === s)])),
      products: { products_in_scope: products, affected_products: affected.size, rework_products: reworkBoxes.size, errors_requiring_rework: count((r) => r.requires_rework) },
      rates: {
        rework_rate: ratio(reworkBoxes.size, products),
        product_error_rate: ratio(affected.size, products),
        errors_per_affected_product: ratio(rows.length, affected.size),
        rework_share_of_errors: ratio(count((r) => r.requires_rework), rows.length),
        resolution_rate: ratio(resolved.length, rows.length),
      },
      resolution: { resolved_count: resolved.length, avg_resolution_hours: avg, median_resolution_hours: median },
      errors_over_time: overTime,
      by_stage: tally('stage'),
      by_type: tally('error_type'),
      top_issues: topIssues,
    };
  }

  async function changeMarker() {
    const res = await run(sb().from('error_reports').select('updated_at', { count: 'exact' }).order('updated_at', { ascending: false }).limit(1));
    return `${res.count}|${res.data[0] ? res.data[0].updated_at : ''}`;
  }

  // ------------------------------------------------------------------ exports
  const COLUMNS = [
    ['error_id', 'error_ID', 13], ['box_id', 'box_ID', 14], ['order_id', 'order_ID', 15], ['stage', 'stage', 18],
    ['error_type', 'error_type', 22], ['severity', 'severity', 10], ['timestamp', 'timestamp', 20], ['status', 'status', 14],
    ['photo_image', 'photo_image', 14], ['description', 'description', 50], ['requires_rework', 'requires_rework', 15],
    ['resolved_at', 'resolved_at', 20], ['resolution_notes', 'resolution_notes', 40], ['reported_by_name', 'reported_by', 18],
  ];
  const PHOTO_LINK_DAYS = 30;
  const safeCell = (v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  const stamp = () => PTS.fmt(Date.now()).replace(/[: ]/g, '-');

  async function exportReports(format, qs) {
    const query = Object.fromEntries(new URLSearchParams(qs));
    const { rows } = await listReports(parseFilters(query), { ...query, limit: 50000 }, PHOTO_LINK_DAYS * 86400);
    if (format === 'csv') {
      const esc = (v) => { const s = safeCell(String(v ?? '')); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const lines = [COLUMNS.map((c) => c[1]).join(',')];
      for (const r of rows) {
        lines.push(COLUMNS.map(([k]) => {
          if (k === 'timestamp' || k === 'resolved_at') return esc(r[k] ? PTS.fmt(r[k]) : '');
          if (k === 'requires_rework') return r.requires_rework ? 'Yes' : 'No';
          return esc(r[k]);
        }).join(','));
      }
      PTS.download(new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), `error-reports-${stamp()}.csv`);
      return;
    }
    const sheetRows = rows.map((r) => COLUMNS.map(([k]) => {
      const v = r[k];
      if (k === 'timestamp' || k === 'resolved_at') return v ? { v: PTS.excelSerial(v), t: 'date' } : null;
      if (k === 'photo_image') return v ? { v: 'View photo', t: 'link', href: v } : 'No photo';
      if (k === 'severity') return { v, t: 'str', s: v };
      if (k === 'requires_rework') return v ? 'Yes' : 'No';
      if (k === 'description' || k === 'resolution_notes') return { v: String(v || ''), t: 'str', s: 'wrap' };
      return { v: String(v ?? ''), t: 'str' };
    }));
    const history = [];
    const ids = rows.map((r) => r.error_id);
    for (let i = 0; i < ids.length; i += 500) history.push(...(await rpc('history_for_reports', { p_error_ids: ids.slice(i, i + 500) })));
    const blob = PTS.buildXlsx([
      { name: 'Error Reports', columns: COLUMNS.map(([, header, width]) => ({ header, width })), rows: sheetRows },
      {
        name: 'Status History',
        columns: [{ header: 'error_ID', width: 13 }, { header: 'from_status', width: 14 }, { header: 'to_status', width: 14 },
          { header: 'changed_at', width: 20 }, { header: 'changed_by', width: 18 }, { header: 'note', width: 60 }],
        rows: history.map((h) => [h.error_id, h.from_status || '', h.to_status, { v: PTS.excelSerial(h.changed_at), t: 'date' }, h.changed_by, { v: h.note || '', t: 'str', s: 'wrap' }]),
      },
      {
        name: 'About', autoFilter: false,
        columns: [{ header: 'Item', width: 22 }, { header: 'Value', width: 70 }],
        rows: [['Generated', PTS.fmt(Date.now())], ['Time zone', PTS.tz()], ['Source', 'Online database (authoritative). This file is a snapshot.'],
          ['Records', String(rows.length)], ['Photo links', `Valid for ${PHOTO_LINK_DAYS} days from generation.`]],
      },
    ]);
    PTS.download(blob, `error-reports-${stamp()}.xlsx`);
  }

  // ------------------------------------------------------------------ admin
  async function listsPublic() {
    await requireSession();
    const [stages, categories] = await Promise.all([
      run(sb().from('production_stages').select('id,name').eq('active', true).order('sort_order').order('name')),
      run(sb().from('error_categories').select('id,name').eq('active', true).order('sort_order').order('name')),
    ]);
    return { stages: stages.data, categories: categories.data, severities: SEVERITIES, statuses: STATUSES };
  }

  async function addListItem(table, body) {
    const name = String(body.name || '').trim();
    if (name.length < 2 || name.length > 60) throw new ApiError(400, { error: 'Name must be 2-60 characters' });
    const { data: last } = await run(sb().from(table).select('sort_order').order('sort_order', { ascending: false }).limit(1));
    const sort = Number.isInteger(body.sort_order) ? body.sort_order : ((last[0] && last[0].sort_order) || 0) + 10;
    return (await run(sb().from(table).insert({ name, sort_order: sort }).select().single())).data;
  }
  async function updateListItem(table, id, body) {
    const patch = {};
    if (body.name !== undefined) {
      patch.name = String(body.name).trim();
      if (patch.name.length < 2 || patch.name.length > 60) throw new ApiError(400, { error: 'Name must be 2-60 characters' });
    }
    if (Number.isInteger(body.sort_order)) patch.sort_order = body.sort_order;
    if (typeof body.active === 'boolean') patch.active = body.active;
    const { data } = await run(sb().from(table).update(patch).eq('id', id).select());
    if (!data.length) throw new ApiError(403, { error: 'Not saved: manager access required' });
    return data[0];
  }

  async function updateUser(id, body) {
    if (body.password) throw new ApiError(400, { error: 'Reset passwords in Supabase: Authentication > Users > (user) > Send password recovery, or delete and re-create the login.' });
    await rpc('admin_update_user', {
      p_id: id,
      p_full_name: body.full_name ?? null,
      p_role: body.role ?? null,
      p_active: typeof body.active === 'boolean' ? body.active : null,
      p_username: body.username ?? null,
    });
    return { ok: true };
  }

  async function feed(rotate) {
    const key = await rpc('feed_key', { p_rotate: !!rotate });
    return { key, supabase_url: PTS.cfg.SUPABASE_URL, supabase_key: PTS.cfg.SUPABASE_KEY };
  }

  async function saveSettings(body) {
    const p = {};
    for (const [k, v] of Object.entries(body)) p[k] = typeof v === 'boolean' ? String(v) : String(v ?? '');
    await rpc('admin_save_settings', { p_settings: p });
    return loadSettings(true);
  }

  // ------------------------------------------------------------------ router
  const routes = [
    ['POST', /^\/api\/auth\/login$/, (m, q, b) => login(b), true],
    ['POST', /^\/api\/auth\/logout$/, async () => { await sb().auth.signOut(); return { ok: true }; }, true],
    ['GET', /^\/api\/auth\/me$/, () => me()],
    ['POST', /^\/api\/auth\/password$/, (m, q, b) => changePassword(b)],
    ['GET', /^\/api\/lists$/, () => listsPublic()],
    ['GET', /^\/api\/admin\/lists$/, () => rpc('admin_lists')],
    ['POST', /^\/api\/admin\/stages$/, (m, q, b) => addListItem('production_stages', b)],
    ['PATCH', /^\/api\/admin\/stages\/(\d+)$/, (m, q, b) => updateListItem('production_stages', Number(m[1]), b)],
    ['POST', /^\/api\/admin\/categories$/, (m, q, b) => addListItem('error_categories', b)],
    ['PATCH', /^\/api\/admin\/categories\/(\d+)$/, (m, q, b) => updateListItem('error_categories', Number(m[1]), b)],
    ['GET', /^\/api\/products\/lookup$/, (m, q) => lookup(q.code)],
    ['GET', /^\/api\/admin\/orders$/, () => rpc('admin_orders')],
    ['GET', /^\/api\/admin\/products$/, (m, q) => rpc('admin_products', { p_q: q.q || null, p_order_id: q.order_id || null })],
    ['POST', /^\/api\/admin\/products$/, (m, q, b) => rpc('admin_register_products', {
      p_order_id: b.order_id || '', p_product_name: b.product_name || null, p_customer: b.customer || null,
      p_box_id: b.box_id || null, p_count: Number.isInteger(b.count) ? b.count : null, p_box_prefix: b.box_prefix || null })],
    ['POST', /^\/api\/reports$/, (m, q, b) => submit(b)],
    ['GET', /^\/api\/reports\/mine$/, () => mine()],
    ['GET', /^\/api\/reports$/, (m, q) => listReports(parseFilters(q), q)],
    ['GET', /^\/api\/reports\/([^/]+)$/, (m) => getReport(decodeURIComponent(m[1]))],
    ['POST', /^\/api\/reports\/([^/]+)\/status$/, (m, q, b) => changeStatus(decodeURIComponent(m[1]), b)],
    ['PATCH', /^\/api\/reports\/([^/]+)$/, (m, q, b) => correctReport(decodeURIComponent(m[1]), b)],
    ['GET', /^\/api\/metrics$/, (m, q) => metrics(parseFilters(q))],
    ['GET', /^\/api\/admin\/feed$/, () => feed(false)],
    ['POST', /^\/api\/admin\/feed\/rotate$/, () => feed(true)],
    ['GET', /^\/api\/admin\/users$/, () => rpc('admin_users')],
    ['PATCH', /^\/api\/admin\/users\/([0-9a-f-]{36})$/, (m, q, b) => updateUser(m[1], b)],
    ['GET', /^\/api\/admin\/settings$/, () => loadSettings(true)],
    ['POST', /^\/api\/admin\/settings$/, (m, q, b) => saveSettings(b)],
  ];

  async function handle(path, { method = 'GET', body } = {}) {
    const url = new URL(path, 'https://local.invalid');
    const query = Object.fromEntries(url.searchParams);
    for (const [verb, re, fn, isAuthRoute] of routes) {
      const m = url.pathname.match(re);
      if (!m || verb !== method) continue;
      try {
        return await fn(m, query, body || {});
      } catch (e) {
        const err = toApiError(e);
        if (err.status === 401 && !isAuthRoute) PTS.toLogin();
        throw err;
      }
    }
    throw new ApiError(404, { error: `Unknown request ${method} ${url.pathname}` });
  }

  window.PTS_BACKEND = { handle, exportReports, changeMarker, parseCode, parseFilters };
})();
