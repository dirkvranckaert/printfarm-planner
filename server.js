require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const db     = require('./db');
const brands = require('./brands');
const push   = require('./push');
const pause  = require('./pause');
const projects = require('./projects');
const awaitingPrinter = require('./awaiting-printer');
const linkTransition = require('./link-transition');
const itemsMigration = require('./itemsMigration');
const { parse3mf, extractThumbnails } = require('./parse3mf');
const { matchPrinter } = require('./printer-match');
const sharedAuth = require('./shared-auth');

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Remove upload artifacts (the imported `<hex>.3mf` and plate thumbnail PNGs)
// for jobs that have just been deleted. A single 3MF backs every plate/copy
// job from one import, and copies of a plate share one thumbnail, so a file is
// only unlinked once NO surviving job row still references it. Must run AFTER
// the job rows are deleted so the reference count reflects the post-delete
// state. Never throws: a missing file (ENOENT) or any unlink failure is logged
// and swallowed, so file cleanup can't turn a successful delete into a 500.
function cleanupOrphanUploads(fileNames) {
  const names = new Set(fileNames.filter(Boolean));
  for (const name of names) {
    const ref = db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE printFile=? OR thumbFile=?').get(name, name);
    if (ref.c > 0) continue; // still referenced by a surviving job — keep it
    try {
      fs.unlinkSync(path.join(UPLOADS_DIR, name));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[job-delete] could not unlink ${name}: ${err.message}`);
    }
  }
}

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

// Connect all brand integrations on startup.
// Skipped under NODE_ENV=test (Jest) so importing the app for supertest does
// not open MQTT connections or leave timers running.
if (process.env.NODE_ENV !== 'test') {
  brands.connectAll(db);
  push.init(db);
}

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
    // Part 3: an active printing job's runtime delay has extended it into a
    // locked (immovable) job. Notify once per active conflict.
    if (result.notifyLockedConflict && push.isEnabled('conflict')) {
      let body = `Printer ${printer.name}'s active print is delayed and now conflicts with the next job`;
      if (result.conflictJob?.name) body += ` '${result.conflictJob.name}'`;
      push.sendToAll({
        title: 'PrintFarm',
        body,
        tag: `conflict-${printer.id}`,
        requireInteraction: true,
        url: `/#job/${job.id}`,
      });
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
    // Piggy-back an explicit event so the client always re-renders the
    // calendar on a real stage transition, even if partial frames after
    // resume carry over the old stage (see bambu.js:128-160).
    sseClients.forEach(res => res.write(`data: ${JSON.stringify({ stageChanged: brandKey, from: prev, to: curr })}\n\n`));
    const linked = db.prepare(
      "SELECT * FROM jobs WHERE linked_printer_id=? AND status != 'Done'"
    ).all(printer.id);

    // RUNNING edge: flip every eligible linked job to 'Printing'. Eligibility +
    // the DB flip live in link-transition.applyRunningTransition (single source
    // of truth, shared with the Jest suite); here we layer realign + push on
    // the jobs it started. A finished 'Post Printing' job with a stale link is
    // never re-grabbed — that guard is inside the applier.
    if (curr === 'RUNNING') {
      const { started } = linkTransition.applyRunningTransition({ db, printerId: printer.id, now: new Date() });
      for (const job of started) {
        const refreshed = db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
        tryRealign(printer, refreshed, status.remaining, { snapStart: true });
        broadcastJobsUpdated();
        if (push.isEnabled('started')) {
          push.sendToAll({ title: 'PrintFarm', body: `Printer ${printer.name} has started printing`, tag: `started-${printer.id}`, url: `/#job/${job.id}` });
        }
      }
    }

    linked.forEach(job => {
      if ((curr === 'FINISH' || curr === 'IDLE')
          && (prev === 'RUNNING' || prev === 'PAUSE')
          && (job.status === 'Printing' || job.status === 'Paused')) {
        // PAUSE -> FINISH/IDLE happens when the user cancels a paused print
        // directly on the printer touchscreen. Clear the stale pause snapshot
        // before flipping to Post Printing -- the print is actually stopping,
        // not continuing, so 'end' must NOT be bumped forward.
        if (job.status === 'Paused') {
          pause.finishFromPause({ db, jobId: job.id });
        } else {
          db.prepare("UPDATE jobs SET status='Post Printing', linked_printer_id=NULL WHERE id=?").run(job.id);
        }
        broadcastJobsUpdated();
        if (push.isEnabled('done')) {
          let body = `Printer ${printer.name} has done printing `;
          if (job.orderNr) body += `order #${job.orderNr}: `;
          body += `'${job.name}'`;
          if (job.customerName) body += ` (${job.customerName})`;
          push.sendToAll({ title: 'PrintFarm', body, tag: `done-${printer.id}`, url: `/#job/${job.id}` });
        }
      }
    });

    // PAUSE edge: snapshot + flip ONLY genuinely-'Printing' jobs to 'Paused'
    // (eligibility + DB write in link-transition.applyPauseTransition, shared
    // with the Jest suite). A stale 'Post Printing' job is left untouched — it
    // must never become 'Paused' and then be re-admitted to 'Printing' on
    // resume. Push notifications layer on the jobs it paused.
    if (curr === 'PAUSE' && prev === 'RUNNING') {
      const { paused } = linkTransition.applyPauseTransition({ db, printerId: printer.id, now: new Date() });
      for (const job of paused) {
        broadcastJobsUpdated();
        if (push.isEnabled('paused')) {
          let body = `Printer ${printer.name} PAUSED`;
          if (job.orderNr || job.name) body += ` — '${job.name || ''}${job.orderNr ? ` #${job.orderNr}` : ''}'`;
          push.sendToAll({ title: 'PrintFarm', body, tag: `paused-${printer.id}`, requireInteraction: true, url: `/#job/${job.id}` });
        }
      }
    }

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

// --- Background timers ---
// Skipped under NODE_ENV=test so importing the app for supertest leaves no
// open handles / running intervals.
if (process.env.NODE_ENV !== 'test') {
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

// --- Pause drift tick ---
// Every 60s, for every job currently paused, bump its end forward to
// (now + paused_remaining_ms) so the day-view bar drifts with wall-clock.
// Cascade downstream Planned/Awaiting jobs via scheduling.pushBackChain.
setInterval(() => {
  try {
    const res = pause.pauseTick({ db, now: new Date(), restr: getSchedulingRestrictions() });
    if (res.updated.length) broadcastJobsUpdated();
  } catch (err) {
    console.error('[pauseTick] error:', err.message);
  }
}, 60_000);
} // end NODE_ENV !== 'test' background timers

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
const { readReleaseInfo } = require('./lib/release-info');

// Read release.env once at startup (deploy pipeline writes it into the
// release dir; it never changes at runtime for a given process).
const deployInfo = readReleaseInfo(__dirname);

app.get('/api/config', (req, res) => {
  res.json({
    version,
    deploy: deployInfo,
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
  // Deleting a printer cascades to its jobs — clean up their upload artifacts too.
  const jobs = db.prepare('SELECT printFile, thumbFile FROM jobs WHERE printerId=?').all(req.params.id);
  db.prepare('DELETE FROM jobs WHERE printerId=?').run(req.params.id);
  db.prepare('DELETE FROM printers WHERE id=?').run(req.params.id);
  cleanupOrphanUploads(jobs.flatMap(j => [j.printFile, j.thumbFile]));
  res.status(204).end();
});

// --- Jobs ---
app.get('/api/jobs', (req, res) => {
  // Resolve each job's project label (null when unassigned) so the day-view
  // card can show it alongside customer/orderNr, same as those ride the payload.
  res.json(db.prepare(
    'SELECT jobs.*, projects.label AS project FROM jobs LEFT JOIN projects ON jobs.project_id = projects.id'
  ).all());
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
    // A queued job has no start (start=''), so a start-derived end would be
    // `new Date('')` -> NaN -> throw. Keep end empty for queued jobs.
    const newEnd = job.start ? new Date(new Date(job.start).getTime() + durationMins * 60 * 1000).toISOString() : '';
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
// List the plates of a job's retained 3MF, for the "reload items from 3MF"
// action in the edit dialog. Read-only: re-parses the existing on-disk file, no
// writes. Returns [] (200) when the job has no valid/retained 3MF so the client
// can show a friendly "no 3MF" message rather than an error.
app.get('/api/jobs/:id/3mf-plates', (req, res) => {
  const job = db.prepare('SELECT printFile FROM jobs WHERE id=?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const pf = job.printFile;
  // Only a bare `<hex>.3mf` under UPLOADS_DIR is one of our retained uploads.
  if (!pf || pf.includes('/') || !pf.endsWith('.3mf')) return res.json([]);
  const full = path.join(UPLOADS_DIR, pf);
  if (!fs.existsSync(full)) return res.json([]);
  try {
    const parsed = parse3mf(full);
    const plates = (parsed && parsed.plates) || [];
    res.json(plates.map(p => ({
      name: p.plateName ?? null,
      objectCount: Number.isInteger(p.objectCount) ? p.objectCount : 0,
      durationMins: Math.round(p.printTimeMinutes || 0),
    })));
  } catch (err) {
    res.status(400).json({ error: 'Failed to parse 3MF: ' + err.message });
  }
});
// Resolve the cool-down (minutes) to persist on a job. A valid explicit client
// value (manual override) wins; otherwise fall back to `fallback` when given
// (e.g. the job's existing snapshot on edit), else snapshot the printer's
// current cool_down_mins (or the 15-min default) — the create-time snapshot.
function resolveJobCoolDown(explicit, printerId, fallback) {
  // Only a real numeric value counts as an explicit override. null / '' /
  // undefined all mean "not provided" — without this guard Number(null) and
  // Number('') both coerce to 0 and get stored as a bogus 0-min override
  // instead of falling back to the snapshot / printer / 15-min default.
  if (explicit != null && explicit !== '') {
    const n = Number(explicit);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  if (fallback != null) return fallback;
  const p = printerId ? db.prepare('SELECT cool_down_mins FROM printers WHERE id=?').get(printerId) : null;
  return p?.cool_down_mins ?? 15;
}
// Symmetric with resolveJobCoolDown: snapshot / validate a job's warm-up. Default
// 5 matches the printer-column default and the scheduling fallback used before
// the per-job snapshot existed.
function resolveJobWarmUp(explicit, printerId, fallback) {
  if (explicit != null && explicit !== '') {
    const n = Number(explicit);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  if (fallback != null) return fallback;
  const p = printerId ? db.prepare('SELECT warm_up_mins FROM printers WHERE id=?').get(printerId) : null;
  return p?.warm_up_mins ?? 5;
}
// Normalise the item-count fields for a create/edit. `items` is optional: a
// valid non-negative integer means "tracked" (0 allowed); null / '' / undefined
// / a bad value all mean "untracked" → stored NULL. `items_lost` defaults to 0
// and is clamped into [0, items] when items is tracked, so losses can never
// exceed the produced count (the client also rejects that up-front — see
// public/app.js saveJob; the server clamp is defense-in-depth).
function resolveJobItems(rawItems, rawLost) {
  let items = null;
  if (rawItems != null && rawItems !== '') {
    const n = Number(rawItems);
    if (Number.isInteger(n) && n >= 0) items = n;
  }
  let lost = 0;
  if (rawLost != null && rawLost !== '') {
    const n = Number(rawLost);
    if (Number.isInteger(n) && n >= 0) lost = n;
  }
  if (items == null) lost = 0;          // untracked plate → no losses counted
  else if (lost > items) lost = items;  // clamp into [0, items]
  return { items, items_lost: lost };
}
// Resolve a free-text project name for a job, set jobs.project_id, and fire the
// first-create push (behind the `project` toggle). `name` undefined = field not
// supplied -> leave the job's project untouched. `name` explicit '' = clear it.
// Returns the resolve result (or null) for callers that want the created flag.
function applyProjectToJob(jobId, name) {
  if (name === undefined) return null;
  const result = projects.resolveProject({ db, name });
  if (!result) {
    // Blank name -> detach the job from any project.
    db.prepare('UPDATE jobs SET project_id=NULL WHERE id=?').run(jobId);
    return null;
  }
  db.prepare('UPDATE jobs SET project_id=? WHERE id=?').run(result.id, jobId);
  if (result.created && push.isEnabled('project')) {
    push.sendToAll({
      title: 'PrintFarm',
      body: `New project created: ${result.label}`,
      tag: `project-${result.id}`,
      url: '/',
    });
  }
  return result;
}
app.post('/api/jobs', (req, res) => {
  const { printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins, bedType } = req.body;
  const isQueued = queued ? 1 : 0;
  const normStart = isQueued ? '' : (normalizeJobTime(start) ?? '');
  const normEnd = isQueued ? '' : (normalizeJobTime(end) ?? '');
  const coolDownMins = resolveJobCoolDown(req.body.cool_down_mins, printerId);
  const warmUpMins = resolveJobWarmUp(req.body.warm_up_mins, printerId);
  const { items, items_lost } = resolveJobItems(req.body.items, req.body.items_lost);
  const result = db.prepare(
    'INSERT INTO jobs (printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins, bedType, cool_down_mins, warm_up_mins, items, items_lost, plate_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(printerId, name, customerName, orderNr, normStart, normEnd, status ?? 'Planned', colors, printFile, remarks, isQueued, durationMins ?? 0, bedType ?? null, coolDownMins, warmUpMins, items, items_lost, req.body.plate_name ?? null);
  applyProjectToJob(result.lastInsertRowid, req.body.project);
  const projectId = db.prepare('SELECT project_id FROM jobs WHERE id=?').get(result.lastInsertRowid)?.project_id ?? null;
  res.status(201).json({ id: result.lastInsertRowid, ...req.body, start: normStart, end: normEnd, queued: isQueued, cool_down_mins: coolDownMins, warm_up_mins: warmUpMins, project_id: projectId });
});
app.put('/api/jobs/:id', (req, res) => {
  const { name, customerName, orderNr, status, colors, printFile, remarks, queued, durationMins, bedType } = req.body;
  const existing = db.prepare('SELECT start, end, printerId, cool_down_mins, warm_up_mins, locked FROM jobs WHERE id=?').get(req.params.id);
  const isQueued = queued ? 1 : 0;
  // A locked job is immovable: the edit dialog (this PUT) can change any field
  // EXCEPT its schedule. Preserve the stored start/end/printerId when locked so
  // editing name/remarks/etc. never repositions it. Lock is NOT toggled here.
  let { printerId, start, end } = req.body;
  if (existing && existing.locked) {
    printerId = existing.printerId;
    start = existing.start;
    end = existing.end;
  }
  const normStart = isQueued ? '' : (normalizeJobTime(start) ?? '');
  const normEnd = isQueued ? '' : (normalizeJobTime(end) ?? '');
  const coolDownMins = resolveJobCoolDown(req.body.cool_down_mins, printerId, existing?.cool_down_mins);
  const warmUpMins = resolveJobWarmUp(req.body.warm_up_mins, printerId, existing?.warm_up_mins);
  const { items, items_lost } = resolveJobItems(req.body.items, req.body.items_lost);
  // An explicit status change that leaves the link-active set (Awaiting Printer
  // / Printing / Paused) — i.e. moves to Post Printing / Done / Planned — clears
  // any stale linked_printer_id, so the printer stops being shown busy and the
  // SSE/pause paths never re-grab the job. Keeps the manual path consistent with
  // the SSE finish and pause.finishFromPause (both already null the link).
  // ATOMIC: the unlink is folded into the SAME UPDATE as the status change, never
  // a follow-up autocommit write. A crash between two separate statements would
  // strand a stale link that the one-time migration.stale_link_backfill_v1 can no
  // longer heal (its marker is already set after the first boot).
  const clearLink = status !== undefined && !linkTransition.LINK_ACTIVE_STATUSES.has(status);
  db.prepare(
    'UPDATE jobs SET printerId=?, name=?, customerName=?, orderNr=?, start=?, end=?, status=?, colors=?, printFile=?, remarks=?, queued=?, durationMins=?, bedType=?, cool_down_mins=?, warm_up_mins=?, items=?, items_lost=?'
    + (clearLink ? ', linked_printer_id=NULL' : '')
    + ' WHERE id=?'
  ).run(printerId, name, customerName, orderNr, normStart, normEnd, status, colors, printFile, remarks, isQueued, durationMins ?? 0, bedType ?? null, coolDownMins, warmUpMins, items, items_lost, req.params.id);
  // If the user moves a job out of 'Paused' via the edit dialog, clear the
  // stale pause snapshot so it does not drift on the next tick.
  if (status !== 'Paused') pause.clearPauseFields({ db, jobId: Number(req.params.id) });
  applyProjectToJob(Number(req.params.id), req.body.project);
  const projectId = db.prepare('SELECT project_id FROM jobs WHERE id=?').get(req.params.id)?.project_id ?? null;
  res.json({ id: Number(req.params.id), ...req.body, start: normStart, end: normEnd, queued: isQueued, cool_down_mins: coolDownMins, warm_up_mins: warmUpMins, project_id: projectId });
});
app.patch('/api/jobs/:id', (req, res) => {
  // "Link when printer starts": enter the 'Awaiting Printer' pending state.
  // The start-time window + one-pending-per-printer invariant are enforced
  // here, at the point the user sets it. The auto-link on RUNNING reuses the
  // existing linked_printer_id transition in the SSE handler above.
  if (req.body.status === awaitingPrinter.STATUS) {
    const id = Number(req.params.id);
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const printerId = req.body.linked_printer_id ?? job.printerId;
    const result = awaitingPrinter.assignPending({ db, jobId: id, printerId, now: new Date() });
    if (!result.ok) return res.status(result.code).json({ error: result.error });
    return res.json(db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
  }
  // Lock state guards. The toggle is only allowed via this route (the context
  // menu), never while the job is Printing / Awaiting Printer. And a locked job
  // is immovable: strip start/end/printerId from any PATCH so a drag, resize,
  // conflict "next day" / "move printer" can't reposition it. The live printer
  // sync moves the job's own end via realign.js (direct UPDATE), not this route,
  // so that exception is unaffected.
  const lockRow = db.prepare('SELECT status, locked FROM jobs WHERE id=?').get(req.params.id);
  if ('locked' in req.body && lockRow
      && (lockRow.status === 'Printing' || lockRow.status === 'Awaiting Printer')) {
    return res.status(409).json({ error: 'Cannot change lock state while the job is Printing or Awaiting Printer' });
  }
  // Effective lock state after this PATCH: honour an incoming unlock in the same
  // request, otherwise use the stored value.
  const willBeLocked = 'locked' in req.body
    ? Number(req.body.locked) === 1
    : !!(lockRow && lockRow.locked);
  const MOVE_FIELDS = new Set(['start', 'end', 'printerId']);
  const allowed = ['printerId', 'name', 'customerName', 'orderNr', 'start', 'end', 'status', 'colors', 'printFile', 'remarks', 'queued', 'durationMins', 'linked_printer_id', 'bedType', 'cool_down_mins', 'warm_up_mins', 'locked', 'items', 'items_lost', 'plate_name'];
  const fields = Object.entries(req.body)
    .filter(([k]) => allowed.includes(k))
    .filter(([k]) => !(willBeLocked && MOVE_FIELDS.has(k)))
    // Defense-in-depth: cool_down_mins / warm_up_mins are written raw here,
    // bypassing the resolve* helpers. Drop either unless it's a valid
    // non-negative integer so a bad value (null/''/negative/non-numeric) can't
    // overwrite the snapshot — an invalid PATCH keeps the job's existing value.
    .filter(([k, v]) => (k !== 'cool_down_mins' && k !== 'warm_up_mins') || (v != null && v !== '' && Number.isInteger(Number(v)) && Number(v) >= 0))
    .map(([k, v]) => {
      if ((k === 'start' || k === 'end') && v) return [k, normalizeJobTime(v)];
      if (k === 'cool_down_mins' || k === 'warm_up_mins') return [k, Number(v)];
      // Coerce lock to 0/1 — SQLite binds reject a raw boolean.
      if (k === 'locked') return [k, v ? 1 : 0];
      // items: '' / null / bad value → NULL (untracked); a valid non-negative
      // integer is stored as-is. items_lost: bad value → 0.
      if (k === 'items') {
        if (v == null || v === '') return [k, null];
        const n = Number(v);
        return [k, (Number.isInteger(n) && n >= 0) ? n : null];
      }
      if (k === 'items_lost') {
        const n = Number(v);
        return [k, (Number.isInteger(n) && n >= 0) ? n : 0];
      }
      return [k, v];
    });
  // Clamp items_lost against the EFFECTIVE items whenever this PATCH touches items
  // or items_lost. Effective items = the incoming items if present, else the job's
  // currently stored items. Effective loss = incoming items_lost if present, else
  // the stored items_lost. A loss only makes sense on a tracked plate, so effective
  // items === null forces items_lost to 0 (including the case where this PATCH turns
  // a tracked job untracked while leaving items_lost untouched); otherwise items_lost
  // is capped at items. Never persist items_lost > items (the map above already
  // floored a bad incoming value at 0).
  const lostField  = fields.find(([k]) => k === 'items_lost');
  const itemsField = fields.find(([k]) => k === 'items');
  if (lostField || itemsField) {
    const current = db.prepare('SELECT items, items_lost FROM jobs WHERE id=?').get(req.params.id);
    const effectiveItems = itemsField ? itemsField[1] : (current?.items ?? null);
    let lost = lostField ? lostField[1] : (current?.items_lost ?? 0);
    if (effectiveItems == null) lost = 0;
    else if (lost > effectiveItems) lost = effectiveItems;
    if (lostField) lostField[1] = lost;
    else if (lost !== (current?.items_lost ?? 0)) fields.push(['items_lost', lost]);
  }
  // An explicit status change that leaves the link-active set (Awaiting Printer
  // / Printing / Paused) clears any stale linked_printer_id — same rule as the
  // PUT edit path — so a job finished via a manual status change no longer marks
  // its printer busy or gets re-grabbed by the SSE/pause paths.
  // ATOMIC: the unlink is merged into the field list, so it lands in the SAME
  // UPDATE as the status change instead of a follow-up autocommit write. A crash
  // between two separate statements would strand a stale link that the one-time
  // migration.stale_link_backfill_v1 can no longer heal (marker already set).
  // A linked_printer_id sent in the same body is overwritten, not duplicated —
  // same end state as the old two-statement order, and the echoed response now
  // reports the NULL the row actually holds.
  const patchedStatus = Object.fromEntries(fields).status;
  if (patchedStatus !== undefined && !linkTransition.LINK_ACTIVE_STATUSES.has(patchedStatus)) {
    const linkField = fields.find(([k]) => k === 'linked_printer_id');
    if (linkField) linkField[1] = null;
    else fields.push(['linked_printer_id', null]);
  }
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  const setClauses = fields.map(([k]) => `${k}=?`).join(', ');
  const values = [...fields.map(([, v]) => v), req.params.id];
  db.prepare(`UPDATE jobs SET ${setClauses} WHERE id=?`).run(...values);
  // Status moving out of 'Paused' via a PATCH: clear the pause snapshot.
  if (patchedStatus !== undefined && patchedStatus !== 'Paused') {
    pause.clearPauseFields({ db, jobId: Number(req.params.id) });
  }
  res.json({ id: Number(req.params.id), ...req.body, ...Object.fromEntries(fields) });
});
// --- Shared helpers for the timed-move routes (push-back / pull-forward) ---

// Load every scheduled (non-queued) job on a printer, with each job's own
// warm-up/cool-down resolved to ms (falling back to the printer's, then the
// 5/15-min defaults). `linked_printer_id` is included so the reshove classifier
// can tell printer-anchored jobs apart.
function loadPrinterJobs(printerId, printer) {
  return db.prepare(
    "SELECT id, name, status, start, end, cool_down_mins, warm_up_mins, linked_printer_id, locked FROM jobs WHERE printerId=? AND queued=0 AND start!=''"
  ).all(printerId).map(j => ({
    ...j,
    coolDownMs: (j.cool_down_mins ?? printer?.cool_down_mins ?? 15) * 60000,
    warmUpMs: (j.warm_up_mins ?? printer?.warm_up_mins ?? 5) * 60000,
  }));
}

// Split a printer's jobs (excluding the anchor) into the sets scheduling.planReshove
// needs: `movable` = jobs the cascade may push back (Planned/Awaiting, not linked
// to a printer, not locked); `fixed` = everything else (Printing, Awaiting Printer,
// Done, Paused, printer-linked, or locked) — obstacles the reshove routes around
// but never moves. A locked job joins the fixed bucket exactly like a Printing job.
const RESHOVE_MOVABLE_STATUSES = new Set(['Planned', 'Awaiting']);
function classifyForReshove(allSamePrinter, anchorId) {
  const movable = [];
  const fixed = [];
  for (const j of allSamePrinter) {
    if (j.id === anchorId) continue;
    if (RESHOVE_MOVABLE_STATUSES.has(j.status) && j.linked_printer_id == null && !j.locked) movable.push(j);
    else fixed.push(j);
  }
  return { movable, fixed };
}

// Build the anchor descriptor planReshove expects from a full job row.
function buildReshoveAnchor(anchor, printer) {
  return {
    id: anchor.id,
    start: anchor.start,
    end: anchor.end,
    coolDownMs: (anchor.cool_down_mins ?? printer?.cool_down_mins ?? 15) * 60000,
    warmUpMs: (anchor.warm_up_mins ?? printer?.warm_up_mins ?? 5) * 60000,
  };
}

// Persist a list of { id, start, end } schedule updates in one transaction.
function applyJobUpdates(updates) {
  const upd = db.prepare('UPDATE jobs SET start=?, end=? WHERE id=?');
  const tx = db.transaction((list) => { for (const u of list) upd.run(u.start, u.end, u.id); });
  tx(updates);
}

// Shared response for the verbatim-anchor reshove path (push-back, and the
// pull-forward forced/fallback paths). When a movable job blocks the target and
// the caller hasn't confirmed, report needsReshove WITHOUT writing; otherwise
// apply the plan. `activeConflict` rides along so the client can warn when the
// anchor lands on a running/immovable print (which is never moved).
function respondToReshovePlan(res, req, plan) {
  if (plan.needsReshove && !req.body?.reshove) {
    return res.json({
      needsReshove: true, updatedCount: 0, updates: [],
      target: plan.anchorStart, activeConflict: plan.activeConflict,
    });
  }
  applyJobUpdates(plan.updates);
  return res.json({
    updatedCount: plan.updates.length, updates: plan.updates,
    reshoved: plan.needsReshove, activeConflict: plan.activeConflict,
  });
}

// Push back a job (and any jobs after it on the same printer) to a later start time.
// Body: { to?: ISO-or-datetime-local string, reshove?: boolean }. If `to` is omitted,
// defaults to "now". When the target slot is occupied by a movable job the route
// returns { needsReshove: true } without writing, unless `reshove` is set — then the
// whole schedule is re-shoved to make room. Otherwise the cascade stops at the first
// downstream job whose current start is still free.
app.post('/api/jobs/:id/push-back', (req, res) => {
  const id = Number(req.params.id);
  const anchor = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!anchor || anchor.queued || !anchor.start) {
    return res.status(400).json({ error: 'Job is not scheduled' });
  }
  // A locked job is immovable — never moved by a manual push-back either.
  if (anchor.locked) return res.json({ updatedCount: 0, updates: [] });
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

  const allSamePrinter = loadPrinterJobs(anchor.printerId, printer);

  const anchorStartMs = parseJobTime(anchor.start, tz).getTime();

  // Push-back only ever moves a job LATER. Preserve the legacy no-op gate for an
  // EXPLICIT wrong-direction target (to <= current start) BEFORE planning, so a
  // reshove:true retry can never drag the anchor earlier. Omitted `to` (to-now)
  // stays ungated — "now" may legitimately be earlier for a future-dated job.
  if (toRaw != null && toDate.getTime() <= anchorStartMs) {
    return res.json({ updatedCount: 0, updates: [] });
  }

  // Place the anchor verbatim at the target; reshove the movable jobs behind it.
  const { movable, fixed } = classifyForReshove(allSamePrinter, anchor.id);
  const anchorObj = buildReshoveAnchor(anchor, printer);
  const plan = scheduling.planReshove(anchorObj, toDate, restr, closures, movable, fixed, warmUpMs, coolDownMs);
  return respondToReshovePlan(res, req, plan);
});

// Pull a job FORWARD to an earlier time. Two modes, chosen by whether the client
// sends a `windowEnd` (the move dialog's optional end-time toggle):
//   - NO windowEnd (default): FORCE the anchor to `to` verbatim (even inside
//     silent hours / a closed day) and reshove every movable job behind it. Same
//     verbatim-anchor + availability-aware cascade path as push-back.
//   - windowEnd given: try to place the anchor in a clean gap within
//     [to, windowEnd] and tight-pack the downstream jobs (quick, no cascade). If
//     no gap big enough exists in the window, fall back to the window start (`to`)
//     verbatim and reshove.
// Body: { to?: ISO/local, windowEnd?: ISO/local, reshove?: boolean }
//   - to defaults to "now"
app.post('/api/jobs/:id/pull-forward', (req, res) => {
  const id = Number(req.params.id);
  const anchor = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!anchor || anchor.queued || !anchor.start) {
    return res.status(400).json({ error: 'Job is not scheduled' });
  }
  // A locked job is immovable — never moved by a manual pull-forward either.
  if (anchor.locked) return res.json({ updatedCount: 0, updates: [] });
  const restr = getSchedulingRestrictions();
  const tz = restr.timezone || DEFAULT_TZ;
  const toRaw = req.body?.to;
  const toDate = toRaw ? parseJobTime(toRaw, tz) : new Date();
  if (!toDate || isNaN(toDate.getTime())) {
    return res.status(400).json({ error: 'Invalid "to" timestamp' });
  }
  const windowEndRaw = req.body?.windowEnd;
  const hasWindow = windowEndRaw != null && windowEndRaw !== '';
  const windowEnd = hasWindow ? parseJobTime(windowEndRaw, tz) : null;
  if (hasWindow && (!windowEnd || isNaN(windowEnd.getTime()))) {
    return res.status(400).json({ error: 'Invalid "windowEnd" timestamp' });
  }

  const printer = db.prepare('SELECT warm_up_mins, cool_down_mins FROM printers WHERE id=?').get(anchor.printerId);
  const warmUpMs = (printer?.warm_up_mins ?? 5) * 60000;
  const coolDownMs = (printer?.cool_down_mins ?? 15) * 60000;
  const closures = db.prepare('SELECT startDate, endDate FROM closures').all();

  const allSamePrinter = loadPrinterJobs(anchor.printerId, printer);

  const anchorStartMs = parseJobTime(anchor.start, tz).getTime();

  // Pull-forward only ever moves a job EARLIER. Preserve the legacy no-op gate for
  // an EXPLICIT wrong-direction target (to >= current start) BEFORE planning, so a
  // reshove:true retry can't shove the anchor later. Omitted `to` (to-now) stays
  // ungated — "now" is earlier than a future job's start by definition.
  if (toRaw != null && toDate.getTime() >= anchorStartMs) {
    return res.json({ updatedCount: 0, updates: [] });
  }

  const { movable, fixed } = classifyForReshove(allSamePrinter, anchor.id);
  const anchorObj = buildReshoveAnchor(anchor, printer);
  const anchorRow = allSamePrinter.find(j => j.id === anchor.id);

  // "Move following chain" toggle (default OFF). When ON, the anchor drags its
  // tightly-packed following run forward with it: the maximal contiguous run of
  // movable jobs whose consecutive working-time gaps (silent hours / closed days
  // excluded) stay <= 30 min, terminated only at the first bigger gap. Immovable
  // jobs in the run are skipped (they stay put) but do NOT break the chain — the
  // movers route around them via the `fixed` obstacle bucket.
  const moveChain = req.body?.moveChain === true;
  let followers = [];
  if (moveChain && anchorRow) {
    const laterJobs = allSamePrinter.filter(j =>
      j.id !== anchor.id && parseJobTime(j.start, tz).getTime() > anchorStartMs
    );
    followers = scheduling.selectFollowingChain(anchorRow, laterJobs, restr, closures);
  }
  const followerIds = new Set(followers.map(f => f.id));

  // Window mode: if the anchor fits in a clean gap inside [to, windowEnd] without
  // disturbing any other job, place it there and tight-pack the downstream jobs.
  if (hasWindow) {
    const anchorDurMins = Math.round((parseJobTime(anchor.end, tz).getTime() - anchorStartMs) / 60000);
    // Chain followers travel with the anchor, so they must NOT count against the
    // clean-fit check (they will move out of the way themselves).
    const others = allSamePrinter.filter(j => j.id !== anchor.id && !followerIds.has(j.id));
    const fitStart = scheduling.findNextValidStart(
      toDate, anchorDurMins, restr, closures, others, anchorObj.warmUpMs, anchorObj.coolDownMs
    );
    if (fitStart.getTime() <= windowEnd.getTime()) {
      // Clean fit — no reshuffle. With the toggle ON the chain is the selected
      // following run; otherwise it's the anchor + downstream cascadable,
      // non-linked, UNLOCKED jobs inside the window. Linked or locked jobs are
      // immovable → they stay in otherJobs as obstacles, never tight-packed.
      const windowEndMs = windowEnd.getTime();
      const CASCADABLE_STATUSES = new Set(['Planned', 'Awaiting']);
      const chain = moveChain
        ? [anchorRow, ...followers]
        : allSamePrinter
            .filter(j => {
              if (j.id === anchor.id) return true;
              if (!CASCADABLE_STATUSES.has(j.status) || j.linked_printer_id != null || j.locked) return false;
              const s = parseJobTime(j.start, tz).getTime();
              return s > anchorStartMs && s <= windowEndMs;
            })
            .sort((a, b) => parseJobTime(a.start, tz).getTime() - parseJobTime(b.start, tz).getTime());
      const chainIds = new Set(chain.map(j => j.id));
      const otherJobs = allSamePrinter.filter(j => !chainIds.has(j.id));
      const updates = scheduling.pullForwardChain(chain, toDate, restr, closures, otherJobs, warmUpMs, coolDownMs);
      applyJobUpdates(updates);
      return res.json({ updatedCount: updates.length, updates });
    }
    // No gap in the window → fall through to the forced verbatim + reshove path.
  }

  // Forced path (no window, or window had no gap): anchor verbatim at `to`, the
  // selected chain pulled forward behind it, other movable jobs reshoved behind
  // the block. `followers` is [] when the toggle is off → classic single-anchor.
  const plan = scheduling.planReshove(anchorObj, toDate, restr, closures, movable, fixed, warmUpMs, coolDownMs, followers);
  return respondToReshovePlan(res, req, plan);
});

// Schedule a QUEUED, printer-bound job onto its printer's timeline. Only jobs
// with a printerId are schedulable this way (an unassigned queue job has no lane
// to go to — the caller must set a printer first or drag it onto one). Body:
//   { mode: 'earliest' | 'at', to?: ISO/local, reshove?: boolean }
//   - 'earliest': place at the next free, availability-aware slot on the printer
//     (findNextValidStart) — never displaces another job, so no reshuffle.
//   - 'at': place verbatim at `to` (default now) and reshove the movable jobs
//     behind it, exactly like push-back. Returns { needsReshove } without writing
//     when a movable job blocks the slot and `reshove` isn't set.
// On success the job leaves the queue (queued=0) with a real start/end — the
// empty-start invariant only ever held WHILE it was queued.
app.post('/api/jobs/:id/schedule-from-queue', (req, res) => {
  const id = Number(req.params.id);
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!job || !job.queued) return res.status(400).json({ error: 'Job is not queued' });
  if (job.printerId == null) return res.status(400).json({ error: 'Job has no bound printer' });

  const durationMins = job.durationMins || 0;
  const restr = getSchedulingRestrictions();
  const tz = restr.timezone || DEFAULT_TZ;
  const printer = db.prepare('SELECT warm_up_mins, cool_down_mins FROM printers WHERE id=?').get(job.printerId);
  const mode = req.body?.mode || 'earliest';

  if (mode === 'earliest') {
    const start = findNextValidStart(new Date(), durationMins, job.printerId);
    const end = new Date(start.getTime() + durationMins * 60000);
    db.prepare("UPDATE jobs SET start=?, end=?, queued=0 WHERE id=?")
      .run(start.toISOString(), end.toISOString(), id);
    return res.json({ updatedCount: 1, scheduled: true, start: start.toISOString(), end: end.toISOString(), printerId: job.printerId });
  }

  // mode === 'at' — verbatim placement + reshove cascade (reuses planReshove).
  const toRaw = req.body?.to;
  const toDate = toRaw ? parseJobTime(toRaw, tz) : new Date();
  if (!toDate || isNaN(toDate.getTime())) return res.status(400).json({ error: 'Invalid "to" timestamp' });

  const warmUpMs = (printer?.warm_up_mins ?? 5) * 60000;
  const coolDownMs = (printer?.cool_down_mins ?? 15) * 60000;
  const closures = db.prepare('SELECT startDate, endDate FROM closures').all();
  const allSamePrinter = loadPrinterJobs(job.printerId, printer);
  const { movable, fixed } = classifyForReshove(allSamePrinter, id);
  // Synthetic anchor: the queued job spans durationMins from the target slot.
  const anchorObj = {
    id,
    start: toDate.toISOString(),
    end: new Date(toDate.getTime() + durationMins * 60000).toISOString(),
    coolDownMs, warmUpMs,
  };
  const plan = scheduling.planReshove(anchorObj, toDate, restr, closures, movable, fixed, warmUpMs, coolDownMs);
  if (plan.needsReshove && !req.body?.reshove) {
    return res.json({ needsReshove: true, updatedCount: 0, updates: [], target: plan.anchorStart, activeConflict: plan.activeConflict });
  }
  applyJobUpdates(plan.updates);        // updates[0] is the anchor at its verbatim slot
  db.prepare('UPDATE jobs SET queued=0 WHERE id=?').run(id); // and it leaves the queue
  return res.json({ updatedCount: plan.updates.length, updates: plan.updates, reshoved: plan.needsReshove, activeConflict: plan.activeConflict, target: plan.anchorStart });
});

// Server-side proxy for the filament-manager catalog. The browser cannot fetch
// the sibling app directly (cross-origin, no CORS, auth cookies don't travel).
// This endpoint does a server-to-server fetch using shared-auth, just like
// /api/admin/remap-colors already does, and returns the catalog to the client.
app.get('/api/filament-catalog', async (req, res) => {
  const filamentUrl = process.env.FILAMENT_URL || '';
  if (!filamentUrl) return res.json([]);
  try {
    const headers = {};
    const setCookie = sharedAuth.createSharedCookie('catalog-proxy');
    if (setCookie) headers.Cookie = setCookie.split(';')[0];
    const r = await fetch(`${filamentUrl}/api/filaments`, { headers });
    if (!r.ok) return res.json([]);
    const list = await r.json();
    res.json(Array.isArray(list) ? list : []);
  } catch {
    res.json([]);
  }
});

// One-shot admin endpoint to remap historic colors[*].name + .brand against
// the filament-manager catalog. Default is DRY RUN — pass ?commit=1 to write.
// Reuses filament-match.js so the logic matches the live import path.
app.post('/api/admin/remap-colors', async (req, res) => {
  const commit = req.query.commit === '1' || req.body?.commit === true;
  const filamentMatch = require('./filament-match');

  // Fetch the filament catalog from the sibling app via shared-auth. The
  // createSharedCookie helper returns a full Set-Cookie header string so we
  // grab just the `name=value` portion for the outbound Cookie request header.
  const filamentUrl = process.env.FILAMENT_URL || '';
  if (!filamentUrl) return res.status(503).json({ error: 'FILAMENT_URL not configured' });
  let catalog;
  try {
    const headers = {};
    const setCookie = sharedAuth.createSharedCookie('admin-remap');
    if (setCookie) headers.Cookie = setCookie.split(';')[0];
    const r = await fetch(`${filamentUrl}/api/filaments`, { headers });
    if (!r.ok) return res.status(502).json({ error: `filament-manager ${r.status}` });
    catalog = await r.json();
  } catch (e) {
    return res.status(502).json({ error: 'filament-manager unreachable: ' + e.message });
  }

  const rows = db.prepare("SELECT id, name, customerName, start, colors FROM jobs WHERE colors IS NOT NULL AND colors != '' AND colors != '[]'").all();

  const report = { commit, totalJobs: rows.length, jobsTouched: 0, colorsTotal: 0, colorsMatched: 0, colorsReplaced: 0, unmatchedHexes: {}, replacements: [] };

  const upd = db.prepare('UPDATE jobs SET colors=? WHERE id=?');
  const tx = db.transaction((items) => { for (const it of items) upd.run(it.colors, it.id); });
  const writeBatch = [];

  for (const job of rows) {
    let colors;
    try { colors = JSON.parse(job.colors); } catch { continue; }
    if (!Array.isArray(colors)) continue;
    let touched = false;
    for (const c of colors) {
      report.colorsTotal++;
      const m = filamentMatch.matchFilament({ color: c.color, brand: c.brand }, catalog);
      if (!m) {
        const hex = filamentMatch.normalizeHex(c.color) || c.color || '?';
        report.unmatchedHexes[hex] = (report.unmatchedHexes[hex] || 0) + 1;
        continue;
      }
      report.colorsMatched++;
      const sameName  = c.name && String(c.name).toLowerCase() === String(m.colorName).toLowerCase();
      const sameBrand = filamentMatch.normalizeKey(c.brand) === filamentMatch.normalizeKey(m.brand);
      if (!sameName || !sameBrand) {
        report.colorsReplaced++;
        if (report.replacements.length < 200) {
          report.replacements.push({
            jobId: job.id, jobName: job.name, hex: c.color,
            old: { name: c.name || null, brand: c.brand || null },
            new: { name: m.colorName, brand: m.brand },
          });
        }
        c.name = m.colorName;
        c.brand = m.brand;
        touched = true;
      }
    }
    if (touched) {
      report.jobsTouched++;
      writeBatch.push({ id: job.id, colors: JSON.stringify(colors) });
    }
  }

  if (commit && writeBatch.length) tx(writeBatch);

  res.json(report);
});

app.delete('/api/jobs/:id', (req, res) => {
  // Capture the job's files, delete the row, then unlink any file no surviving
  // job still references (shared 3MF across plates, shared thumbnail across copies).
  const job = db.prepare('SELECT printFile, thumbFile FROM jobs WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM jobs WHERE id=?').run(req.params.id);
  if (job) cleanupOrphanUploads([job.printFile, job.thumbFile]);
  res.status(204).end();
});

// ---- Projects ----
// Sorted summary list: active projects first (most active first), completed
// below, closed at the very bottom. Each carries { toPrint, busy, done, total }.
app.get('/api/projects', (req, res) => {
  res.json(projects.summaries(db));
});
// Project detail: the project row + all its jobs (for the grouped-by-status
// detail view, which reuses the Job Status Overview rendering client-side).
app.get('/api/projects/:id', (req, res) => {
  const id = projects.normalizeId(req.params.id);
  const project = db.prepare('SELECT id, label, status, created_at FROM projects WHERE id=?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const jobs = db.prepare('SELECT * FROM jobs WHERE project_id=?').all(id);
  res.json({ project, jobs });
});
// Manual close (from the project detail dialog). A later matching job auto-reopens
// it (see resolveProject).
app.post('/api/projects/:id/close', (req, res) => {
  const id = projects.normalizeId(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id=?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  db.prepare("UPDATE projects SET status='closed' WHERE id=?").run(id);
  res.json({ id, status: 'closed' });
});
// Delete an EMPTY project (no job references it). Never cascades — refuses with
// 409 while any job still points at it.
app.delete('/api/projects/:id', (req, res) => {
  const result = projects.deleteIfEmpty({ db, projectId: req.params.id });
  if (!result.ok) {
    if (result.code === 404) return res.status(404).json({ error: 'Project not found' });
    return res.status(409).json({ error: 'Project heeft nog jobs en kan niet verwijderd worden' });
  }
  res.status(204).end();
});
// Context-menu assign: attach a job to an EXISTING project only (never creates).
app.post('/api/jobs/:id/assign-project', (req, res) => {
  const jobId = Number(req.params.id);
  const job = db.prepare('SELECT id FROM jobs WHERE id=?').get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  // Clear sentinel: detach the job from any project (project_id -> NULL). Never
  // creates a project, and never deletes the now-emptied project.
  if (req.body.projectId === '__none__') {
    db.prepare('UPDATE jobs SET project_id=NULL WHERE id=?').run(jobId);
    return res.json({ id: jobId, project_id: null, reopened: false });
  }
  const result = projects.assignExisting({ db, jobId, projectId: req.body.projectId });
  if (!result.ok) {
    return res.status(result.code).json({ error: result.code === 404 ? 'Project not found' : 'projectId required' });
  }
  res.json({ id: jobId, project_id: result.id, reopened: result.reopened });
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
    ? db.prepare("SELECT start, end, cool_down_mins, warm_up_mins FROM jobs WHERE printerId=? AND queued=0 AND start!='' ORDER BY start").all(printerId)
        .map(j => ({ ...j, coolDownMs: (j.cool_down_mins ?? printer?.cool_down_mins ?? 15) * 60000, warmUpMs: (j.warm_up_mins ?? printer?.warm_up_mins ?? 5) * 60000 }))
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

// One-time item-count backfill from retained 3MFs. Guarded by a settings marker
// (runs once, never re-parses on later boots) and only touches items-IS-NULL
// jobs. Wrapped so a parse/IO error can never abort startup. See itemsMigration.js.
//
// CRITICAL: this is a SYNCHRONOUS scan that shells out to `unzip` once per
// retained 3MF. On a prod backlog of many jobs it blocks the event loop for
// seconds — so it MUST run AFTER app.listen() has bound the port, never before.
// Running it pre-listen delayed the port bind past the deploy health-check
// window, so the new process never answered and the deploy auto-rolled back.
// It is invoked from the app.listen callback below (so the port is already
// bound) via backfillItemsAsync, which yields the event loop between jobs so the
// scan never starves incoming HTTP. Wrapped so any throw (including a bad
// require, if it ever reaches here) is logged and the server stays up.
async function runItemsBackfill() {
  try {
    const r = await itemsMigration.backfillItemsAsync({ db, uploadsDir: UPLOADS_DIR, parse3mf, fs, path });
    if (r.ran) {
      console.log(`[migration] items backfill: scanned ${r.stats.scanned}, backfilled ${r.stats.backfilled} `
        + `(single ${r.stats.singlePlate}, multi ${r.stats.multiMatched}), ambiguous ${r.stats.ambiguous}, skipped ${r.stats.skipped}`);
    }
  } catch (err) {
    console.error('[migration] items backfill failed (non-fatal):', err.message);
  }
}

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
    // Queue mode (the web default): jobs land on the queue with no fixed start.
    const isQueue = mode === 'queue';
    if (!plates?.length) return res.status(400).json({ error: 'plates required' });
    if (!isQueue && !isFirstAvailable && !startISO && !startDate) return res.status(400).json({ error: 'plates and start time required' });

    // Resolve the (optional) batch project ONCE, so every imported job shares
    // the same project_id and the first-create push fires at most once.
    const proj = schedule.project ? projects.resolveProject({ db, name: schedule.project }) : null;

    // Expand each plate by its `copies` count (default 1), preserving order.
    // Validate up-front so an invalid/oversized count rejects before any file
    // IO — copies are never silently dropped. Copies cascade back-to-back on
    // the plate's printer via the same loop that handles multiple plates.
    const expandedPlates = scheduling.expandPlateCopies(plates);

    // Auto-bind unassigned plates to the printer embedded in the 3MF. The
    // headless uploader always posts printerId:null (no printer is picked at
    // slice time), so without this every headless job lands unassigned. Uses the
    // SAME fuzzy match the import dialog shows (printer-match.js). Only a single,
    // unambiguous match binds; no match or an ambiguous one leaves the job
    // unassigned (a wrong bind is worse than an unassigned queue job). An
    // explicit printerId from the caller (web user picked one) is never touched.
    if (expandedPlates.some(pl => pl.printerId == null)) {
      const embeddedName = parse3mf(req.body).printerName;
      const bound = matchPrinter(embeddedName, db.prepare('SELECT id, name FROM printers').all());
      if (bound) {
        for (const pl of expandedPlates) {
          if (pl.printerId == null) pl.printerId = bound.id;
        }
      }
    }

    // Validate every plate's printer BEFORE any file IO or insert, so a bad
    // printer on a later plate can never leave a partial import behind (orphan
    // jobs + a stored 3MF). A null printerId is allowed: it is an unassigned
    // QUEUE job (the headless importer has no printer at slice time). Any
    // non-null id must resolve to a real printer. The lookups are cached so the
    // insert loop reuses them (per-job warm-up/cool-down snapshot).
    const printerCache = new Map();
    for (const pl of expandedPlates) {
      if (pl.printerId == null) continue;
      if (!printerCache.has(pl.printerId)) {
        const p = db.prepare('SELECT warm_up_mins, cool_down_mins FROM printers WHERE id=?').get(pl.printerId);
        if (!p) return res.status(400).json({ error: `Unknown printer: ${pl.printerId}` });
        printerCache.set(pl.printerId, p);
      }
    }

    // Save the 3MF file + thumbnails. Tracked in `writtenFiles` so a failed
    // insert transaction can remove them — no orphan artifacts on rollback.
    const fileId = crypto.randomBytes(8).toString('hex');
    const storedName = `${fileId}.3mf`;
    const writtenFiles = [storedName];
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), req.body);

    const thumbs = extractThumbnails(req.body);
    const thumbMap = {};
    for (const t of thumbs) {
      const imgId = crypto.randomBytes(8).toString('hex') + '.png';
      fs.writeFileSync(path.join(UPLOADS_DIR, imgId), t.buffer);
      writtenFiles.push(imgId);
      thumbMap[t.plateIndex] = imgId;
    }

    // Schedule jobs sequentially, respecting silent hours/closed days/overlaps.
    // Queue mode skips all time-slotting entirely: jobs are inserted with
    // queued=1 and empty start/end, so no `new Date('')` is ever computed.
    const importTz = getSchedulingRestrictions().timezone || DEFAULT_TZ;
    let currentStart = null;
    if (!isQueue) {
      if (isFirstAvailable) {
        currentStart = new Date();
      } else if (startISO) {
        currentStart = new Date(startISO);
      } else {
        const [dy, dmo, dda] = startDate.split('-').map(Number);
        const [sh, smi] = (startTime || '08:00').split(':').map(Number);
        currentStart = zonedTimeToDate(dy, dmo, dda, sh, smi || 0, importTz);
      }
    }
    const createdJobs = [];

    // All inserts run in ONE transaction: any throw rolls back every prior
    // insert, so the import is all-or-nothing. Files written above are cleaned
    // up in the catch below if the transaction fails.
    const runInserts = db.transaction(() => {
      for (const pl of expandedPlates) {
        const durationMins = pl.durationMins || 0;

        const printer = pl.printerId != null ? printerCache.get(pl.printerId) : null;
        const warmUp = printer?.warm_up_mins ?? 5;
        const coolDown = printer?.cool_down_mins ?? 15;

        const thumbFile = thumbMap[pl.plateIndex] || null;
        const colorsStr = pl.colors ? JSON.stringify(pl.colors) : null;

        // Item count forwarded by the calculator (plate objectCount). Null-safe:
        // a missing/invalid value leaves items NULL (untracked). plate_name
        // remembers which plate this job came from for later display + reload.
        const plItems = Number.isInteger(pl.items) && pl.items >= 0 ? pl.items : null;
        const plateName = pl.name || null;

        // Time-slotted only when not queueing. Queue mode leaves start/end empty.
        let startStr = '';
        let endStr = '';
        if (!isQueue) {
          const validStart = findNextValidStart(currentStart, durationMins, pl.printerId);
          const endDate = new Date(validStart.getTime() + durationMins * 60000);
          startStr = validStart.toISOString();
          endStr = endDate.toISOString();
          // Next plate candidate: after this job's end + cool-down + warm-up
          currentStart = new Date(endDate.getTime() + (coolDown + warmUp) * 60000);
        }

        const result = db.prepare(
          'INSERT INTO jobs (printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins, thumbFile, bedType, cool_down_mins, warm_up_mins, items, plate_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(
          pl.printerId || null,
          pl.name || `Plate ${pl.plateIndex}`,
          pl.customerName || null,
          pl.orderNr || null,
          startStr,
          endStr,
          'Planned',
          colorsStr,
          storedName,
          null,
          isQueue ? 1 : 0,
          durationMins,
          thumbFile || null,
          pl.bedType || null,
          coolDown,
          warmUp,
          plItems,
          plateName
        );

        if (proj) db.prepare('UPDATE jobs SET project_id=? WHERE id=?').run(proj.id, result.lastInsertRowid);

        createdJobs.push({
          id: result.lastInsertRowid,
          name: pl.name,
          printerId: pl.printerId ?? null,
          start: startStr,
          end: endStr,
          durationMins,
          thumbFile,
          queued: isQueue ? 1 : 0,
        });
      }
    });

    try {
      runInserts();
    } catch (insertErr) {
      // Roll back the stored artifacts too — the DB already rolled back.
      for (const f of writtenFiles) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch { /* best effort */ }
      }
      throw insertErr;
    }

    // First-create push (once per batch), behind the `project` toggle.
    if (proj?.created && push.isEnabled('project')) {
      push.sendToAll({
        title: 'PrintFarm',
        body: `New project created: ${proj.label}`,
        tag: `project-${proj.id}`,
        url: '/',
      });
    }

    res.status(201).json({ jobs: createdJobs, file: storedName, project_id: proj?.id ?? null });
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

// Only bind a port when run directly (node server.js). Under supertest the app
// is imported and driven in-process, so listening is skipped.
if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => {
    console.log(`PrintFarm Planner running on port ${process.env.PORT || 3000}`);
    // Kick the one-time items backfill only after the port is bound. It yields
    // the event loop between jobs (backfillItemsAsync), so even a large retained
    // -3MF backlog never blocks incoming HTTP — the port answers immediately and
    // the backfill self-heals in the background. See runItemsBackfill above.
    runItemsBackfill();
  });
}

module.exports = app;
