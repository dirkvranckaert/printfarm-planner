require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const db     = require('./db');
const brands = require('./brands');
const push   = require('./push');
const { parse3mf, extractThumbnails } = require('./parse3mf');

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
app.use(express.json());

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
    res.setHeader('Set-Cookie', `pf_session=${token}; HttpOnly; Path=/; Max-Age=604800`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

app.get('/logout', (req, res) => {
  const token = parseCookieToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.setHeader('Set-Cookie', 'pf_session=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/login');
});

// --- Session auth middleware ---
app.use((req, res, next) => {
  // Allow PWA assets through unauthenticated
  if (req.path === '/favicon.svg' || req.path === '/manifest.json' || req.path === '/sw.js') return next();
  const token = parseCookieToken(req);
  if (token && isValidSession(token)) return next();
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

// Broadcast every live-status update to SSE clients.
// brandKey is namespaced: "bambulab:01P00A123456789"
brands.onUpdate((brandKey, status) => {
  const data = `data: ${JSON.stringify({ [brandKey]: status })}\n\n`;
  sseClients.forEach(res => res.write(data));

  const prev = prevStage.get(brandKey);
  const curr = status.stage;
  if (curr && curr !== prev) {
    const serial = brandKey.includes(':') ? brandKey.split(':')[1] : null;
    if (serial) {
      const printer = db.prepare('SELECT id, name FROM printers WHERE bambu_serial=?').get(serial);
      if (printer) {
        const linked = db.prepare(
          "SELECT * FROM jobs WHERE linked_printer_id=? AND status != 'Done'"
        ).all(printer.id);

        linked.forEach(job => {
          if (curr === 'RUNNING' && job.status !== 'Printing') {
            db.prepare("UPDATE jobs SET status='Printing' WHERE id=?").run(job.id);
            sseClients.forEach(res => res.write(`data: ${JSON.stringify({ jobsUpdated: true })}\n\n`));
            // Push: started printing
            if (push.isEnabled('started')) {
              push.sendToAll({ title: 'PrintFarm', body: `Printer ${printer.name} has started printing`, tag: `started-${printer.id}` });
            }
          }
          if ((curr === 'FINISH' || curr === 'IDLE') && prev === 'RUNNING' && job.status === 'Printing') {
            db.prepare("UPDATE jobs SET status='Post Printing', linked_printer_id=NULL WHERE id=?").run(job.id);
            sseClients.forEach(res => res.write(`data: ${JSON.stringify({ jobsUpdated: true })}\n\n`));
            // Push: done printing (with job info)
            if (push.isEnabled('done')) {
              let body = `Printer ${printer.name} has done printing `;
              if (job.orderNr) body += `order #${job.orderNr}: `;
              body += `'${job.name}'`;
              if (job.customerName) body += ` (${job.customerName})`;
              push.sendToAll({ title: 'PrintFarm', body, tag: `done-${printer.id}` });
            }
          }
        });

        // No linked job: push for stage transitions
        if (linked.length === 0) {
          if (curr === 'RUNNING' && prev !== 'RUNNING') {
            if (push.isEnabled('started')) {
              push.sendToAll({ title: 'PrintFarm', body: `Printer ${printer.name} has started printing`, tag: `started-${printer.id}` });
            }
          }
          if ((curr === 'FINISH' || curr === 'IDLE') && prev === 'RUNNING') {
            if (push.isEnabled('done')) {
              const body = status.job_name
                ? `Printer ${printer.name} is done printing ${status.job_name}`
                : `Printer ${printer.name} has done printing`;
              push.sendToAll({ title: 'PrintFarm', body, tag: `done-${printer.id}` });
            }
          }
        }
      }
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
    push.sendToAll({ title: 'PrintFarm', body, tag: `upcoming-${job.id}` });
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

// --- App config (read-only, driven by env vars) ---
const { version } = require('./package.json');

app.get('/api/config', (req, res) => {
  res.json({
    version,
    topbarPrinterLimit: parseInt(process.env.TOPBAR_PRINTER_LIMIT, 10) || 3,
  });
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
app.get('/api/jobs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json(null);
  res.json(row);
});
app.post('/api/jobs', (req, res) => {
  const { printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins, bedType } = req.body;
  const isQueued = queued ? 1 : 0;
  const result = db.prepare(
    'INSERT INTO jobs (printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins, bedType) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(printerId, name, customerName, orderNr, isQueued ? '' : (start ?? ''), isQueued ? '' : (end ?? ''), status ?? 'Planned', colors, printFile, remarks, isQueued, durationMins ?? 0, bedType ?? null);
  res.status(201).json({ id: result.lastInsertRowid, ...req.body, queued: isQueued });
});
app.put('/api/jobs/:id', (req, res) => {
  const { printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins, bedType } = req.body;
  const isQueued = queued ? 1 : 0;
  db.prepare(
    'UPDATE jobs SET printerId=?, name=?, customerName=?, orderNr=?, start=?, end=?, status=?, colors=?, printFile=?, remarks=?, queued=?, durationMins=?, bedType=? WHERE id=?'
  ).run(printerId, name, customerName, orderNr, isQueued ? '' : (start ?? ''), isQueued ? '' : (end ?? ''), status, colors, printFile, remarks, isQueued, durationMins ?? 0, bedType ?? null, req.params.id);
  res.json({ id: Number(req.params.id), ...req.body, queued: isQueued });
});
app.patch('/api/jobs/:id', (req, res) => {
  const allowed = ['printerId', 'name', 'customerName', 'orderNr', 'start', 'end', 'status', 'colors', 'printFile', 'remarks', 'queued', 'durationMins', 'linked_printer_id', 'bedType'];
  const fields = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  const setClauses = fields.map(([k]) => `${k}=?`).join(', ');
  const values = [...fields.map(([, v]) => v), req.params.id];
  db.prepare(`UPDATE jobs SET ${setClauses} WHERE id=?`).run(...values);
  res.json({ id: Number(req.params.id), ...req.body });
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
    const schedule = JSON.parse(req.headers['x-schedule'] || '{}');
    const { plates, startDate, startTime } = schedule;
    if (!plates?.length || !startDate) return res.status(400).json({ error: 'plates and startDate required' });

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

    // Schedule jobs sequentially from the start date/time
    let currentStart = new Date(`${startDate}T${startTime || '08:00'}:00`);
    const createdJobs = [];

    for (const pl of plates) {
      const durationMins = pl.durationMins || 0;
      const endDate = new Date(currentStart.getTime() + durationMins * 60 * 1000);

      const warmUp = 5; // default warm-up
      const coolDown = 15; // default cool-down

      const thumbFile = thumbMap[pl.plateIndex] || null;
      const colorsStr = pl.colors ? JSON.stringify(pl.colors) : null;

      const result = db.prepare(
        'INSERT INTO jobs (printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins, thumbFile, bedType) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        pl.printerId || null,
        pl.name || `Plate ${pl.plateIndex}`,
        pl.customerName || null,
        pl.orderNr || null,
        currentStart.toISOString(),
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
        start: currentStart.toISOString(),
        end: endDate.toISOString(),
        durationMins,
        thumbFile,
      });

      // Next job starts after cool-down gap
      currentStart = new Date(endDate.getTime() + coolDown * 60 * 1000);
    }

    res.status(201).json({ jobs: createdJobs, file: storedName });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Attach a 3MF to an existing job (pick a plate)
app.post('/api/jobs/:id/attach-3mf', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const plateIndex = parseInt(req.headers['x-plate-index'] || '1');

    // Save the 3MF file
    const fileId = crypto.randomBytes(8).toString('hex');
    const storedName = `${fileId}.3mf`;
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), req.body);

    // Parse it
    const parsed = parse3mf(req.body);
    const plate = parsed.plates.find(p => p.index === plateIndex) || parsed.plates[0];

    // Extract thumbnail for this plate
    const thumbs = extractThumbnails(req.body);
    const thumb = thumbs.find(t => t.plateIndex === plateIndex) || thumbs[0];
    let thumbFile = null;
    if (thumb) {
      thumbFile = crypto.randomBytes(8).toString('hex') + '.png';
      fs.writeFileSync(path.join(UPLOADS_DIR, thumbFile), thumb.buffer);
    }

    // Build colors (names will be resolved client-side via ntc.js)
    const colors = plate ? plate.filaments.map(f => {
      const profile = parsed.filamentProfiles?.[f.id - 1];
      return {
        color: f.color || '#888888',
        name: '',
        brand: profile?.vendor && profile.vendor !== 'Generic' ? profile.vendor : '',
      };
    }) : [];

    // Update job
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
