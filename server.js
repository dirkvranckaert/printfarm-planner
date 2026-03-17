require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const db = require('./db');

const app = express();
app.use(express.json());

// --- Session store ---
const sessions = new Set();

function parseCookieToken(req) {
  const raw = req.headers.cookie ?? '';
  const match = raw.match(/(?:^|;\s*)pf_session=([^;]+)/);
  return match ? match[1] : null;
}

// --- Auth routes (bypass middleware) ---
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.add(token);
    res.setHeader('Set-Cookie', `pf_session=${token}; HttpOnly; Path=/`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

app.get('/logout', (req, res) => {
  const token = parseCookieToken(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'pf_session=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/login');
});

// --- Session auth middleware ---
app.use((req, res, next) => {
  // Allow favicon through unauthenticated
  if (req.path === '/favicon.svg') return next();
  const token = parseCookieToken(req);
  if (token && sessions.has(token)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
});

app.use(express.static('public'));

// --- Printers ---
app.get('/api/printers', (req, res) => {
  res.json(db.prepare('SELECT * FROM printers').all());
});
app.post('/api/printers', (req, res) => {
  const { name, color } = req.body;
  const result = db.prepare('INSERT INTO printers (name, color) VALUES (?, ?)').run(name, color);
  res.status(201).json({ id: result.lastInsertRowid, name, color });
});
app.put('/api/printers/:id', (req, res) => {
  const { name, color } = req.body;
  db.prepare('UPDATE printers SET name=?, color=? WHERE id=?').run(name, color, req.params.id);
  res.json({ id: Number(req.params.id), name, color });
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
  const { printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins } = req.body;
  const isQueued = queued ? 1 : 0;
  const result = db.prepare(
    'INSERT INTO jobs (printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(printerId, name, customerName, orderNr, isQueued ? '' : (start ?? ''), isQueued ? '' : (end ?? ''), status ?? 'Planned', colors, printFile, remarks, isQueued, durationMins ?? 0);
  res.status(201).json({ id: result.lastInsertRowid, ...req.body, queued: isQueued });
});
app.put('/api/jobs/:id', (req, res) => {
  const { printerId, name, customerName, orderNr, start, end, status, colors, printFile, remarks, queued, durationMins } = req.body;
  const isQueued = queued ? 1 : 0;
  db.prepare(
    'UPDATE jobs SET printerId=?, name=?, customerName=?, orderNr=?, start=?, end=?, status=?, colors=?, printFile=?, remarks=?, queued=?, durationMins=? WHERE id=?'
  ).run(printerId, name, customerName, orderNr, isQueued ? '' : (start ?? ''), isQueued ? '' : (end ?? ''), status, colors, printFile, remarks, isQueued, durationMins ?? 0, req.params.id);
  res.json({ id: Number(req.params.id), ...req.body, queued: isQueued });
});
app.patch('/api/jobs/:id', (req, res) => {
  const allowed = ['printerId', 'name', 'customerName', 'orderNr', 'start', 'end', 'status', 'colors', 'printFile', 'remarks', 'queued', 'durationMins'];
  const fields = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'no valid fields' });
  const setClauses = fields.map(([k]) => `${k}=?`).join(', ');
  const values = [...fields.map(([, v]) => v), req.params.id];
  db.prepare(`UPDATE jobs SET ${setClauses} WHERE id=?`).run(...values);
  res.json({ id: Number(req.params.id), ...req.body });
});
app.delete('/api/jobs/:id', (req, res) => {
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
      const r = db.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run(p.name, p.color);
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

app.listen(process.env.PORT || 3000, () => {
  console.log(`PrintFarm Planner running on port ${process.env.PORT || 3000}`);
});
