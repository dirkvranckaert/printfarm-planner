require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const db     = require('./db');
const brands = require('./brands');
const push   = require('./push');
const { parse3mf, extractThumbnails } = require('./parse3mf');
const sharedAuth = require('./shared-auth');

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
app.use(express.json());

// --- CORS for cross-app requests (optional, only when sibling URLs configured) ---
const ALLOWED_ORIGINS = [
  process.env.CALCULATOR_URL, process.env.FILAMENT_URL,
  process.env.CALCULATOR_PUBLIC_URL, process.env.FILAMENT_PUBLIC_URL,
].filter(Boolean);
if (ALLOWED_ORIGINS.length) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Schedule,X-Plate-Index');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
}

// --- Session store ---
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

function parseCookieToken(req) {
  const raw = req.headers.cookie ?? '';
  const match = raw.match(/(?:^|;\s*)pf_session=([^;]+)/);
  return match ? match[1] : null;
}

function isValidSession(token) {
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token=?').get(token);
  if (!row) return false;
  if (Date.now() > row.expires_at) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); return false; }
  return true;
}

// --- Auth routes (bypass middleware) ---
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?,?)').run(token, Date.now() + SESSION_TTL);
    const cookies = [`pf_session=${token}; HttpOnly; Path=/; Max-Age=604800`];
    const sharedCookie = sharedAuth.createSharedCookie(username);
    if (sharedCookie) cookies.push(sharedCookie);
    res.setHeader('Set-Cookie', cookies);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

app.get('/logout', (req, res) => {
  const token = parseCookieToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  const cookies = ['pf_session=; HttpOnly; Path=/; Max-Age=0'];
  const clearShared = sharedAuth.clearSharedCookie();
  if (clearShared) cookies.push(clearShared);
  res.setHeader('Set-Cookie', cookies);
  res.redirect('/login');
});

// --- Session auth middleware ---
app.use((req, res, next) => {
  // Allow PWA assets through unauthenticated
  if (['/favicon.svg', '/manifest.json', '/sw.js', '/apple-touch-icon.png', '/api/config'].includes(req.path)) return next();
  const token = parseCookieToken(req);
  if (token && isValidSession(token)) return next();
  // Also accept shared JWT if enabled
  if (sharedAuth.validateSharedToken(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
});

app.use(express.static('public'));

// --- Live status (SSE) ---
const sseClients = new Set();

// Connect all brand integrations on startup
brands.connectAll(db);
push.init(db);

// Track previous stage per brandKey for auto-transition logic
const prevStage = new Map();
// Throttle live realign so we don't thrash on every MQTT tick (Bambu sends updates every ~2s).
const lastRealignAt = new Map(); // printerId → epoch ms
const REALIGN_MIN_INTERVAL_MS = 60 * 1000;

function broadcastJobsUpdated() {
  sseClients.forEach(res => res.write(`data: ${JSON.stringify({ jobsUpdated: true })}\n\n`));
}

function tryRealign(printer, job, remainingMins, { snapStart = false } = {}) {
  try {
    const result = realignLinkedJob({
      db, printer, job, remainingMins,
      now: new Date(),
      restr: getSchedulingRestrictions(),
      snapStart,
    });
    if (result.changed) {
      lastRealignAt.set(printer.id, Date.now());
      broadcastJobsUpdated();
    }
    return result;
  } catch (err) {
    console.error('[realign] error:', err.message);
    return { changed: false, updated: [] };
  }
}

// Broadcast every live-status update to SSE clients.
// brandKey is namespaced: "bambulab:01P00A123456789"
brands.onUpdate((brandKey, status) => {
  const data = `data: ${JSON.stringify({ [brandKey]: status })}\n\n`;
  sseClients.forEach(res => res.write(data));

  const serial = brandKey.includes(':') ? brandKey.split(':')[1] : null;
  if (!serial) { prevStage.set(brandKey, status.stage); return; }
  const printer = db.prepare('SELECT * FROM printers WHERE bambu_serial=?').get(serial);
  if (!printer) { prevStage.set(brandKey, status.stage); return; }

  const prev = prevStage.get(brandKey);
  const curr = status.stage;

  // --- Stage-transition handling (runs only when stage changes) ---
  if (curr && curr !== prev) {
    const linked = db.prepare(
      "SELECT * FROM jobs WHERE linked_printer_id=? AND status != 'Done'"
    ).all(printer.id);

    linked.forEach(job => {
      if (curr === 'RUNNING' && job.status !== 'Printing') {
        // First RUNNING tick after linking: mark as Printing and snap start/end
        // to reflect the actual print start (may differ from scheduled start).
        db.prepare("UPDATE jobs SET status='Printing' WHERE id=?").run(job.id);
        const refreshed = db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
        tryRealign(printer, refreshed, status.remaining, { snapStart: true });
        broadcastJobsUpdated();
        if (push.isEnabled('started')) {
          push.sendToAll({ title: 'PrintFarm', body: `Printer ${printer.name} has started printing`, tag: `started-${printer.id}`, url: `/#job/${job.id}` });
        }
      }
      if ((curr === 'FINISH' || curr === 'IDLE') && prev === 'RUNNING' && job.status === 'Printing') {
        db.prepare("UPDATE jobs SET status='Post Printing', linked_printer_id=NULL WHERE id=?").run(job.id);
        broadcastJobsUpdated();
        if (push.isEnabled('done')) {
          let body = `Printer ${printer.name} has done printing `;
          if (job.orderNr) body += `order #${job.orderNr}: `;
          body += `'${job.name}'`;
          if (job.customerName) body += ` (${job.customerName})`;
          push.sendToAll({ title: 'PrintFarm', body, tag: `done-${printer.id}`, url: `/#job/${job.id}` });
        }
      }
      if (curr === 'PAUSE' && prev === 'RUNNING') {
        // Paused mid-print — alert the user. Don't touch the schedule while paused;
        // the first RUNNING tick on resume will recompute normally.
        if (push.isEnabled('paused')) {
          let body = `Printer ${printer.name} PAUSED`;
          if (job.orderNr || job.name) body += ` — '${job.name || ''}${job.orderNr ? ` #${job.orderNr}` : ''}'`;
          push.sendToAll({ title: 'PrintFarm', body, tag: `paused-${printer.id}`, requireInteraction: true, url: `/#job/${job.id}` });
        }
      }
    });

    // No linked job: push for stage transitions
    if (linked.length === 0) {
      if (curr === 'RUNNING' && prev !== 'RUNNING') {
        if (push.isEnabled('started')) {
          push.sendToAll({ title: 'PrintFarm', body: `Printer ${printer.name} has started printing`, tag: `started-${printer.id}`, url: `/#printer/${printer.id}` });
        }
      }
      if ((curr === 'FINISH' || curr === 'IDLE') && prev === 'RUNNING') {
        if (push.isEnabled('done')) {
          const body = status.job_name
            ? `Printer ${printer.name} is done printing ${status.job_name}`
            : `Printer ${printer.name} has done printing`;
          push.sendToAll({ title: 'PrintFarm', body, tag: `done-${printer.id}`, url: `/#printer/${printer.id}` });
        }
      }
      if (curr === 'PAUSE' && prev === 'RUNNING') {
        if (push.isEnabled('paused')) {
          const body = status.job_name
            ? `Printer ${printer.name} PAUSED — ${status.job_name}`
            : `Printer ${printer.name} PAUSED`;
          push.sendToAll({ title: 'PrintFarm', body, tag: `paused-${printer.id}`, requireInteraction: true, url: `/#printer/${printer.id}` });
        }
      }
    }
  }

  // --- Live realign (runs on every RUNNING tick, throttled) ---
  // Don't recompute during PAUSE: Bambu freezes remaining, but `now` keeps
  // moving, which would make predicted_end drift later every tick.
  if (curr === 'RUNNING' && status.remaining != null && status.remaining >= 0) {
    const last = lastRealignAt.get(printer.id) || 0;
    if (Date.now() - last >= REALIGN_MIN_INTERVAL_MS) {
      const job = db.prepare(
        "SELECT * FROM jobs WHERE linked_printer_id=? AND status='Printing' ORDER BY id DESC LIMIT 1"
      ).get(printer.id);
      if (job) tryRealign(printer, job, status.remaining);
    }
  }

  prevStage.set(brandKey, curr);
});

// --- Upcoming job notifications ---
setInterval(() => {
  if (!push.isEnabled('upcoming')) return;
  const now = Date.now();
  const windowStart = new Date(now).toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const windowEnd   = new Date(now + 5 * 60 * 1000).toISOString().slice(0, 16);
  const jobs = db.prepare(`
    SELECT jobs.*, printers.name AS printerName
    FROM jobs
    JOIN printers ON jobs.printerId = printers.id
    WHERE jobs.status = 'Planned'
      AND jobs.queued = 0
      AND jobs.start_push_sent = 0
      AND jobs.start >= ?
      AND jobs.start <= ?
  `).all(windowStart, windowEnd);
  for (const job of jobs) {
    let body;
    if (job.orderNr) {
      body = `It's time to start printing order #${job.orderNr} '${job.name}' on ${job.printerName}`;
    } else {
      body = `It's about time to start printing '${job.name}' on ${job.printerName}`;
    }
    const image = job.thumbFile ? `/api/uploads/${job.thumbFile}` : undefined;
    push.sendToAll({
      title: 'PrintFarm',
      body,
      tag: `upcoming-${job.id}`,
      image,
      requireInteraction: true, // upcoming jobs are actionable — keep on screen
      url: `/#job/${job.id}`,
    });
    db.prepare('UPDATE jobs SET start_push_sent=1 WHERE id=?').run(job.id);
  }
}, 60_000);

// --- Brand-specific API routers ---
// Each brand module exposes an Express router for its own auth/config endpoints.
// Mounted at /api/brands/{brand.id}/ — e.g. GET /api/brands/bambulab/config
for (const brand of brands.all) {
  if (brand.router) app.use(`/api/brands/${brand.id}`, brand.router);
}

app.get('/api/printers/status/stream', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.flushHeaders();

  // Send current snapshot immediately (keys are "brand:printerKey")
  const snapshot = brands.getAllStatuses();
  if (Object.keys(snapshot).length > 0) {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// --- Push notifications ---
app.get('/api/push/public-key', (req, res) => {
  const key = push.getPublicKey();
  if (!key) return res.status(503).json({ error: 'VAPID not initialised' });
  res.json({ publicKey: key });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const str = JSON.stringify(sub);
  // upsert by endpoint to avoid duplicates
  const existing = db.prepare("SELECT id FROM push_subscriptions WHERE subscription LIKE ?").get(`%${sub.endpoint}%`);
  if (!existing) {
    db.prepare('INSERT INTO push_subscriptions (subscription) VALUES (?)').run(str);
  }
  res.json({ ok: true });
});

app.delete('/api/push/unsubscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  db.prepare("DELETE FROM push_subscriptions WHERE subscription LIKE ?").run(`%${sub.endpoint}%`);
  res.json({ ok: true });
});

// Send a test push to all current subscriptions so the user can verify
// the full pipeline (server → VAPID → browser push → service worker →
// in-page bell via postMessage). Used by the Settings "Test push" button.
app.post('/api/push/test', (req, res) => {
  push.sendToAll({
    title: 'PrintFarm — Test',
    body: 'If you see this, push notifications are working 🎉',
    tag: 'test-push',
    requireInteraction: false,
  });
  res.json({ ok: true });
});

// --- App config (read-only, driven by env vars) ---
const { version } = require('./package.json');

app.get('/api/config', (req, res) => {
  res.json({
    version,
    appName: 'PrintFarm Planner',
    appId: 'printfarm-planner',
    publicUrl: process.env.PUBLIC_URL || null,
    sharedAuth: sharedAuth.isEnabled(),
    topbarPrinterLimit: parseInt(process.env.TOPBAR_PRINTER_LIMIT, 10) || 3,
  });
});

// App discovery endpoint
app.get('/api/discover', async (req, res) => {
  const apps = {};
  const calcUrl = process.env.CALCULATOR_URL || '';
  const filamentUrl = process.env.FILAMENT_URL || '';
  if (calcUrl) apps.calculator = await sharedAuth.discoverApp(calcUrl);
  if (filamentUrl) apps.filament = await sharedAuth.discoverApp(filamentUrl);
  res.json({ sharedAuth: sharedAuth.isEnabled(), apps });
});

// --- Printers ---
app.get('/api/printers', (req, res) => {
  res.json(db.prepare('SELECT * FROM printers').all());
});
app.post('/api/printers', (req, res) => {
  const { name, color, brand, bambu_serial, pinned, warm_up_mins, cool_down_mins, favourite } = req.body;
  const wu = warm_up_mins ?? 5;
  const cd = cool_down_mins ?? 15;
  const fav = favourite !== undefined ? (favourite ? 1 : 0) : 1; // default to visible in day view
  const result = db.prepare('INSERT INTO printers (name, color, brand, bambu_serial, pinned, warm_up_mins, cool_down_mins, favourite) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(name, color, brand || 'other', bambu_serial || null, pinned ? 1 : 0, wu, cd, fav);
  brands.subscribeForPrinter({ brand, bambu_serial });
  res.status(201).json({ id: result.lastInsertRowid, name, color, brand: brand || 'other', bambu_serial: bambu_serial || null, pinned: pinned ? 1 : 0, warm_up_mins: wu, cool_down_mins: cd, favourite: fav });
});
app.put('/api/printers/:id', (req, res) => {
  const { name, color, brand, bambu_serial, pinned, warm_up_mins, cool_down_mins, favourite } = req.body;
  const wu = warm_up_mins ?? 5;
  const cd = cool_down_mins ?? 15;
  const fav = favourite ? 1 : 0;
  db.prepare('UPDATE printers SET name=?, color=?, brand=?, bambu_serial=?, pinned=?, warm_up_mins=?, cool_down_mins=?, favourite=? WHERE id=?').run(name, color, brand || 'other', bambu_serial || null, pinned ? 1 : 0, wu, cd, fav, req.params.id);
  brands.subscribeForPrinter({ brand, bambu_serial });
  res.json({ id: Number(req.params.id), name, color, brand: brand || 'other', bambu_serial: bambu_serial || null, pinned: pinned ? 1 : 0, warm_up_mins: wu, cool_down_mins: cd, favourite: fav });
});
app.delete('/api/printers/:id', (req, res) => {
  db.prepare('DELETE FROM jobs WHERE printerId=?').run(req.params.id);
  db.prepare('DELETE FROM printers WHERE id=?').run(req.params.id);
  res.status(204).end();
});

// --- Jobs ---
app.get('/api/jobs', (req, res) => {
  res.json(db.prepare('SELECT * FROM jobs').all());
});
// Attach a 3MF to an existing job (must be before :id routes)
app.post('/api/jobs/:id/attach-3mf', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const plateIndex = parseInt(req.headers['x-plate-index'] || '1');

    const fileId = crypto.randomBytes(8).toString('hex');
    const storedName = `${fileId}.3mf`;
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), req.body);

    const parsed = parse3mf(req.body);
    const plate = parsed.plates.find(p => p.index === plateIndex) || parsed.plates[0];

    const thumbs = extractThumbnails(req.body);
    const thumb = thumbs.find(t => t.plateIndex === plateIndex) || thumbs[0];
    let thumbFile = null;
    if (thumb) {
      thumbFile = crypto.randomBytes(8).toString('hex') + '.png';
      fs.writeFileSync(path.join(UPLOADS_DIR, thumbFile), thumb.buffer);
    }

    const isDual = plate && (plate.nozzleCount || 1) >= 2;
    const colors = plate ? plate.filaments.map(f => {
      const profile = parsed.filamentProfiles?.[f.id - 1];
      return {
        color: f.color || '#888888', name: '',
        brand: profile?.vendor && profile.vendor !== 'Generic' ? profile.vendor : '',
        extruder: isDual && f.extruder ? (f.extruder === 1 ? 'L' : 'R') : null,
      };
    }) : [];

    const durationMins = plate ? Math.round(plate.printTimeMinutes) : job.durationMins;
    const colorsStr = colors.length ? JSON.stringify(colors) : job.colors;
    const newEnd = new Date(new Date(job.start).getTime() + durationMins * 60 * 1000).toISOString();
    const bedType = plate?.bedType || null;

    db.prepare('UPDATE jobs SET printFile=?, thumbFile=?, colors=?, durationMins=?, end=?, bedType=? WHERE id=?')
      .run(storedName, thumbFile, colorsStr, durationMins, newEnd, bedType, req.params.id);

    res.json(db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json(null);
  res.json(row);
});
app.post('/api/jobs', (req, res) => {
  const { printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins, bedType } = req.body;
  const isQueued = queued ? 1 : 0;
  const normStart = isQueued ? '' : (normalizeJobTime(start) ?? '');
  const normEnd = isQueued ? '' : (normalizeJobTime(end) ?? '');
  const result = db.prepare(
    'INSERT INTO jobs (printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins, bedType) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(printerId, name, customerName, orderNr, normStart, normEnd, status ?? 'Planned', colors, printFile, remarks, isQueued, durationMins ?? 0, bedType ?? null);
  res.status(201).json({ id: result.lastInsertRowid, ...req.body, start: normStart, end: normEnd, queued: isQueued });
});
app.put('/api/jobs/:id', (req, res) => {
  const { printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins, bedType } = req.body;
  const isQueued = queued ? 1 : 0;
  const normStart = isQueued ? '' : (normalizeJobTime(start) ?? '');
  const normEnd = isQueued ? '' : (normalizeJobTime(end) ?? '');
  db.prepare(
    'UPDATE jobs SET printerId=?, name=?, customerName=?, orderNr=?, start=?, end=?, status=?, colors=?, printFile=?, remarks=?, queued=?, durationMins=?, bedType=? WHERE id=?'
  ).run(printerId, name, customerName, orderNr, normStart, normEnd, status, colors, printFile, remarks, isQueued, durationMins ?? 0, bedType ?? null, req.params.id);
  res.json({ id: Number(req.params.id), ...req.body, start: normStart, end: normEnd, queued: isQueued });
});
app.patch('/api/jobs/:id', (req, res) => {
  const allowed = ['printerId', 'name', 'customerName', 'orderNr', 'start', 'end', 'status', 'colors', 'printFile', 'remarks', 'queued', 'durationMins', 'linked_printer_id', 'bedType'];
  const fields = Object.entries(req.body)
    .filter(([k]) => allowed.includes(k))
    .map(([k, v]) => (k === 'start' || k === 'end') && v ? [k, normalizeJobTime(v)] : [k, v]);
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  const setClauses = fields.map(([k]) => `${k}=?`).join(', ');
  const values = [...fields.map(([, v]) => v), req.params.id];
  db.prepare(`UPDATE jobs SET ${setClauses} WHERE id=?`).run(...values);
  res.json({ id: Number(req.params.id), ...req.body, ...Object.fromEntries(fields) });
});
// Push back a job (and any jobs after it on the same printer) to a later start time.
// Body: { to?: ISO-or-datetime-local string }. If omitted, defaults to "now".
// Cascade stops at the first downstream job whose current start is still free.
app.post('/api/jobs/:id/push-back', (req, res) => {
  const id = Number(req.params.id);
  const anchor = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!anchor || anchor.queued || !anchor.start) {
    return res.status(400).json({ error: 'Job is not scheduled' });
  }
  const restr = getSchedulingRestrictions();
  const tz = restr.timezone || DEFAULT_TZ;
  const toRaw = req.body?.to;
  const toDate = toRaw ? parseJobTime(toRaw, tz) : new Date();
  if (!toDate || isNaN(toDate.getTime())) {
    return res.status(400).json({ error: 'Invalid "to" timestamp' });
  }

  const printer = db.prepare('SELECT warm_up_mins, cool_down_mins FROM printers WHERE id=?').get(anchor.printerId);
  const warmUpMs = (printer?.warm_up_mins ?? 5) * 60000;
  const coolDownMs = (printer?.cool_down_mins ?? 15) * 60000;
  const closures = db.prepare('SELECT startDate, endDate FROM closures').all();

  const allSamePrinter = db.prepare(
    "SELECT id, name, status, start, end FROM jobs WHERE printerId=? AND queued=0 AND start!=''"
  ).all(anchor.printerId);

  const anchorStartMs = parseJobTime(anchor.start, tz).getTime();
  const CASCADABLE_STATUSES = new Set(['Planned', 'Awaiting']);

  // Chain = the anchor plus every downstream cascadable job on this printer.
  const chain = allSamePrinter
    .filter(j => {
      if (j.id === anchor.id) return true;
      const s = parseJobTime(j.start, tz).getTime();
      return s >= anchorStartMs && CASCADABLE_STATUSES.has(j.status);
    })
    .sort((a, b) => parseJobTime(a.start, tz).getTime() - parseJobTime(b.start, tz).getTime());

  const chainIds = new Set(chain.map(j => j.id));
  const otherJobs = allSamePrinter.filter(j => !chainIds.has(j.id));

  const updates = scheduling.pushBackChain(chain, toDate, restr, closures, otherJobs, warmUpMs, coolDownMs);

  const upd = db.prepare('UPDATE jobs SET start=?, end=? WHERE id=?');
  const tx = db.transaction((list) => { for (const u of list) upd.run(u.start, u.end, u.id); });
  tx(updates);

  res.json({ updatedCount: updates.length, updates });
});

// Pull a job (and downstream jobs within a time window) FORWARD — tight-pack
// them starting at `to`. Opposite of push-back: used after manual re-arranging
// to close gaps, or to insert an extra job at a chosen moment and slide
// everything after it into place. Silent hours, closed days, timezone,
// closures and printer buffers all respected.
// Body: { to?: ISO/local, windowEnd?: ISO/local }
//   - to defaults to "now"
//   - windowEnd defaults to to + 24h
app.post('/api/jobs/:id/pull-forward', (req, res) => {
  const id = Number(req.params.id);
  const anchor = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!anchor || anchor.queued || !anchor.start) {
    return res.status(400).json({ error: 'Job is not scheduled' });
  }
  const restr = getSchedulingRestrictions();
  const tz = restr.timezone || DEFAULT_TZ;
  const toRaw = req.body?.to;
  const toDate = toRaw ? parseJobTime(toRaw, tz) : new Date();
  if (!toDate || isNaN(toDate.getTime())) {
    return res.status(400).json({ error: 'Invalid "to" timestamp' });
  }
  const windowEndRaw = req.body?.windowEnd;
  const windowEnd = windowEndRaw
    ? parseJobTime(windowEndRaw, tz)
    : new Date(toDate.getTime() + 24 * 60 * 60 * 1000);
  if (!windowEnd || isNaN(windowEnd.getTime())) {
    return res.status(400).json({ error: 'Invalid "windowEnd" timestamp' });
  }

  const printer = db.prepare('SELECT warm_up_mins, cool_down_mins FROM printers WHERE id=?').get(anchor.printerId);
  const warmUpMs = (printer?.warm_up_mins ?? 5) * 60000;
  const coolDownMs = (printer?.cool_down_mins ?? 15) * 60000;
  const closures = db.prepare('SELECT startDate, endDate FROM closures').all();

  const allSamePrinter = db.prepare(
    "SELECT id, name, status, start, end FROM jobs WHERE printerId=? AND queued=0 AND start!=''"
  ).all(anchor.printerId);

  const anchorStartMs = parseJobTime(anchor.start, tz).getTime();
  const windowEndMs = windowEnd.getTime();
  const CASCADABLE_STATUSES = new Set(['Planned', 'Awaiting']);

  // Chain = the anchor plus every downstream cascadable job on this printer
  // whose current start is inside the window (anchorStart, windowEnd].
  const chain = allSamePrinter
    .filter(j => {
      if (j.id === anchor.id) return true;
      if (!CASCADABLE_STATUSES.has(j.status)) return false;
      const s = parseJobTime(j.start, tz).getTime();
      return s > anchorStartMs && s <= windowEndMs;
    })
    .sort((a, b) => parseJobTime(a.start, tz).getTime() - parseJobTime(b.start, tz).getTime());

  const chainIds = new Set(chain.map(j => j.id));
  const otherJobs = allSamePrinter.filter(j => !chainIds.has(j.id));

  const updates = scheduling.pullForwardChain(chain, toDate, restr, closures, otherJobs, warmUpMs, coolDownMs);

  const upd = db.prepare('UPDATE jobs SET start=?, end=? WHERE id=?');
  const tx = db.transaction((list) => { for (const u of list) upd.run(u.start, u.end, u.id); });
  tx(updates);

  res.json({ updatedCount: updates.length, updates });
});

app.delete('/api/jobs/:id', (req, res) => {
  // Clean up uploaded files
  const job = db.prepare('SELECT printFile, thumbFile FROM jobs WHERE id=?').get(req.params.id);
  if (job) {
    if (job.thumbFile) { try { fs.unlinkSync(path.join(UPLOADS_DIR, job.thumbFile)); } catch {} }
    // Only delete 3MF file if no other jobs reference it
    if (job.printFile) {
      const others = db.prepare('SELECT COUNT(*) as c FROM jobs WHERE printFile=? AND id!=?').get(job.printFile, req.params.id);
      if (others.c === 0) { try { fs.unlinkSync(path.join(UPLOADS_DIR, job.printFile)); } catch {} }
    }
  }
  db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id);
  res.status(204).end();
});

// --- Closures ---
app.get('/api/closures', (req, res) => {
  res.json(db.prepare('SELECT * FROM closures').all());
});
app.post('/api/closures', (req, res) => {
  const { startDate, endDate, label } = req.body;
  const result = db.prepare('INSERT INTO closures (startDate, endDate, label) VALUES (?,?,?)').run(startDate, endDate, label);
  res.status(201).json({ id: result.lastInsertRowid, startDate, endDate, label });
});
app.put('/api/closures/:id', (req, res) => {
  const { startDate, endDate, label } = req.body;
  db.prepare('UPDATE closures SET startDate=?, endDate=?, label=? WHERE id=?').run(startDate, endDate, label, req.params.id);
  res.json({ id: Number(req.params.id), startDate, endDate, label });
});
app.delete('/api/closures/:id', (req, res) => {
  db.prepare('DELETE FROM closures WHERE id=?').run(req.params.id);
  res.status(204).end();
});

// --- Settings ---
app.get('/api/settings/:key', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(req.params.key);
  if (!row) return res.status(404).json(null);
  let value = row.value;
  try { value = JSON.parse(value); } catch {}
  res.json({ key: req.params.key, value });
});
app.put('/api/settings/:key', (req, res) => {
  const { value } = req.body;
  const stored = JSON.stringify(value);
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(req.params.key, stored);
  res.json({ key: req.params.key, value });
});

// --- Export ---
app.get('/api/export', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings').all().map(r => {
    let value = r.value;
    try { value = JSON.parse(value); } catch {}
    return { key: r.key, value };
  });
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    printers: db.prepare('SELECT * FROM printers').all(),
    jobs:     db.prepare('SELECT * FROM jobs').all(),
    closures: db.prepare('SELECT * FROM closures').all(),
    settings,
  };
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="printfarm-export-${date}.json"`);
  res.json(data);
});

// --- Import ---
app.post('/api/import', (req, res) => {
  const { printers = [], jobs = [], closures = [], settings = [] } = req.body;
  db.transaction(() => {
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM closures').run();
    db.prepare('DELETE FROM jobs').run();
    db.prepare('DELETE FROM printers').run();
    const idMap = {};
    for (const p of printers) {
      const r = db.prepare('INSERT INTO printers (name, color, bambu_serial) VALUES (?,?,?)').run(p.name, p.color, p.bambu_serial || null);
      idMap[p.id] = r.lastInsertRowid;
    }
    for (const j of jobs) {
      db.prepare('INSERT INTO jobs (printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(idMap[j.printerId] ?? j.printerId, j.name, j.customerName, j.orderNr, j.start, j.end, j.status, j.colors, j.printFile, j.remarks, j.queued ?? 0, j.durationMins ?? 0);
    }
    for (const c of closures) {
      db.prepare('INSERT INTO closures (startDate, endDate, label) VALUES (?,?,?)').run(c.startDate, c.endDate, c.label);
    }
    for (const s of settings) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?,?)').run(s.key, JSON.stringify(s.value));
    }
  })();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  3MF import for scheduling                                          */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  Smart scheduling: findNextValidStart                               */
/* ------------------------------------------------------------------ */
const scheduling = require('./scheduling');
const { DEFAULT_TZ, zonedTimeToDate, parseJobTime } = scheduling;
const { realignLinkedJob } = require('./realign');

// Normalize a job's start/end to a proper ISO string with Z suffix.
// Client sends datetime-local ('YYYY-MM-DDTHH:mm') which would otherwise be
// stored naked and misinterpreted on the server side.
function normalizeJobTime(s) {
  if (!s) return s;
  const tz = getSchedulingRestrictions().timezone || DEFAULT_TZ;
  const d = parseJobTime(s, tz);
  return d ? d.toISOString() : s;
}

function getSchedulingRestrictions() {
  const row = db.prepare("SELECT value FROM settings WHERE key='schedulingRestrictions'").get();
  if (!row) return { enabled: false, silentStart: '21:00', silentEnd: '06:30', closedDays: [], timezone: DEFAULT_TZ };
  try {
    const v = JSON.parse(row.value);
    if (!v.timezone) v.timezone = DEFAULT_TZ;
    return v;
  } catch { return { enabled: false, timezone: DEFAULT_TZ }; }
}

function findNextValidStart(candidate, durationMins, printerId) {
  const restr = getSchedulingRestrictions();
  const printer = printerId ? db.prepare('SELECT warm_up_mins, cool_down_mins FROM printers WHERE id=?').get(printerId) : null;
  const warmUpMs = (printer?.warm_up_mins ?? 5) * 60000;
  const coolDownMs = (printer?.cool_down_mins ?? 15) * 60000;
  const closures = db.prepare('SELECT startDate, endDate FROM closures').all();
  const jobs = printerId
    ? db.prepare("SELECT start, end FROM jobs WHERE printerId=? AND queued=0 AND start!='' ORDER BY start").all(printerId)
    : [];
  return scheduling.findNextValidStart(candidate, durationMins, restr, closures, jobs, warmUpMs, coolDownMs);
}

// One-shot migration: normalize any naked 'YYYY-MM-DDTHH:mm' job timestamps
// to proper ISO strings (interpreted in the configured timezone). Idempotent —
// rows already in ISO form are left alone.
(function migrateJobTimestamps() {
  const tz = getSchedulingRestrictions().timezone || DEFAULT_TZ;
  const rows = db.prepare("SELECT id, start, end FROM jobs WHERE start!='' AND (start NOT LIKE '%Z' AND start NOT GLOB '*[+-][0-9][0-9]:[0-9][0-9]')").all();
  if (!rows.length) return;
  const upd = db.prepare('UPDATE jobs SET start=?, end=? WHERE id=?');
  const tx = db.transaction((items) => {
    for (const r of items) {
      const s = parseJobTime(r.start, tz);
      const e = parseJobTime(r.end, tz);
      if (s && e) upd.run(s.toISOString(), e.toISOString(), r.id);
    }
  });
  tx(rows);
  console.log(`[migration] normalized ${rows.length} job timestamp(s) to ISO format`);
})();

app.post('/api/find-slot', (req, res) => {
  const { printerId, durationMins } = req.body || {};
  if (!printerId || !durationMins) return res.status(400).json({ error: 'printerId and durationMins required' });
  const start = findNextValidStart(new Date(), durationMins, printerId);
  const end = new Date(start.getTime() + durationMins * 60000);
  res.json({ start: start.toISOString(), end: end.toISOString(), printerId });
});

app.post('/api/parse-3mf', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: 'Empty body' });
    const result = parse3mf(req.body);
    const thumbs = extractThumbnails(req.body);
    result.thumbnails = {};
    for (const t of thumbs) result.thumbnails[t.plateIndex] = 'data:image/png;base64,' + t.buffer.toString('base64');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'Failed to parse 3MF: ' + err.message });
  }
});

app.post('/api/import-3mf-schedule', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
  try {
    // Parse the schedule data from headers (body is the 3MF file)
    const rawSchedule = req.headers['x-schedule'] || '{}';
    const schedule = JSON.parse(decodeURIComponent(rawSchedule));
    const { plates, startISO, startDate, startTime, mode } = schedule;
    const isFirstAvailable = mode === 'first-available';
    if (!plates?.length || (!isFirstAvailable && !startISO && !startDate)) return res.status(400).json({ error: 'plates and start time required' });

    // Save the 3MF file
    const fileId = crypto.randomBytes(8).toString('hex');
    const storedName = `${fileId}.3mf`;
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), req.body);

    // Extract thumbnails and save as images
    const thumbs = extractThumbnails(req.body);
    const thumbMap = {};
    for (const t of thumbs) {
      const imgId = crypto.randomBytes(8).toString('hex') + '.png';
      fs.writeFileSync(path.join(UPLOADS_DIR, imgId), t.buffer);
      thumbMap[t.plateIndex] = imgId;
    }

    // Schedule jobs sequentially, respecting silent hours/closed days/overlaps
    const importTz = getSchedulingRestrictions().timezone || DEFAULT_TZ;
    let currentStart;
    if (isFirstAvailable) {
      currentStart = new Date();
    } else if (startISO) {
      currentStart = new Date(startISO);
    } else {
      const [dy, dmo, dda] = startDate.split('-').map(Number);
      const [sh, smi] = (startTime || '08:00').split(':').map(Number);
      currentStart = zonedTimeToDate(dy, dmo, dda, sh, smi || 0, importTz);
    }
    const createdJobs = [];

    for (const pl of plates) {
      const durationMins = pl.durationMins || 0;

      // Run through smart scheduling to find valid start
      const validStart = findNextValidStart(currentStart, durationMins, pl.printerId);
      const endDate = new Date(validStart.getTime() + durationMins * 60000);

      // Get printer buffers for next-plate gap calculation
      const printer = pl.printerId ? db.prepare('SELECT warm_up_mins, cool_down_mins FROM printers WHERE id=?').get(pl.printerId) : null;
      const warmUp = printer?.warm_up_mins ?? 5;
      const coolDown = printer?.cool_down_mins ?? 15;

      const thumbFile = thumbMap[pl.plateIndex] || null;
      const colorsStr = pl.colors ? JSON.stringify(pl.colors) : null;

      const result = db.prepare(
        'INSERT INTO jobs (printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins, thumbFile, bedType) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        pl.printerId || null,
        pl.name || `Plate ${pl.plateIndex}`,
        pl.customerName || null,
        pl.orderNr || null,
        validStart.toISOString(),
        endDate.toISOString(),
        'Planned',
        colorsStr,
        storedName,
        null,
        0,
        durationMins,
        thumbFile || null,
        pl.bedType || null
      );

      createdJobs.push({
        id: result.lastInsertRowid,
        name: pl.name,
        printerId: pl.printerId,
        start: validStart.toISOString(),
        end: endDate.toISOString(),
        durationMins,
        thumbFile,
      });

      // Next plate candidate: after this job's end + cool-down + warm-up
      currentStart = new Date(endDate.getTime() + (coolDown + warmUp) * 60000);
    }

    res.status(201).json({ jobs: createdJobs, file: storedName });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// Serve uploaded images/thumbnails
app.get('/api/uploads/:filename', (req, res) => {
  const filepath = path.join(UPLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Not found' });
  const ext = path.extname(req.params.filename).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.3mf': 'application/octet-stream' };
  res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filepath);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`PrintFarm Planner running on port ${process.env.PORT || 3000}`);
});
