require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const db = require('./db');
const bambu = require('./bambu');

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

// --- Bambu helpers ---
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}
async function fetchBambuToken(email, password, code) {
  const body = { account: email, password };
  if (code) body.code = code;
  const res = await fetch('https://api.bambulab.com/v1/user-service/user/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed: ${res.status} ${text}`);
  }
  return res.json();
}
async function fetchBambuUserId(token) {
  const res = await fetch('https://api.bambulab.com/v1/design-user-service/my/preference', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`User ID fetch failed: ${res.status}`);
  const json = await res.json();
  return json.uid || json.userId || json.user_id;
}

// --- Bambu live status (SSE) ---
const sseClients = new Set();

bambu.connect(db).catch(err => console.error('[Bambu] connect error:', err.message));
bambu.onUpdate((serial, status) => {
  const data = `data: ${JSON.stringify({ [serial]: status })}\n\n`;
  sseClients.forEach(res => res.write(data));
});

// --- Bambu auth API ---
app.get('/api/bambu/config', (req, res) => {
  const email  = getSetting('bambu.email');
  const region = getSetting('bambu.region') || 'us';
  const token  = getSetting('bambu.token');
  res.json({ email, region, connected: !!token });
});

app.post('/api/bambu/connect', async (req, res) => {
  const { email, password, region } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const loginJson = await fetchBambuToken(email, password);
    if (loginJson.loginType === 'verifyCode') {
      setSetting('bambu.pendingEmail',    email);
      setSetting('bambu.pendingPassword', password);
      setSetting('bambu.pendingRegion',   region || 'us');
      return res.json({ status: 'verifyCode' });
    }
    const token = loginJson.token || loginJson.accessToken;
    if (!token) return res.status(502).json({ error: 'No token in login response' });
    const uid = await fetchBambuUserId(token);
    if (!uid) return res.status(502).json({ error: 'Could not get user ID' });
    setSetting('bambu.email',  email);
    setSetting('bambu.token',  token);
    setSetting('bambu.userId', String(uid));
    setSetting('bambu.region', region || 'us');
    await bambu.reinit(db);
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/bambu/verify', async (req, res) => {
  const { code } = req.body ?? {};
  if (!code) return res.status(400).json({ error: 'code required' });
  const email    = getSetting('bambu.pendingEmail');
  const password = getSetting('bambu.pendingPassword');
  const region   = getSetting('bambu.pendingRegion') || 'us';
  if (!email || !password) return res.status(400).json({ error: 'No pending login — call /api/bambu/connect first' });
  try {
    const loginJson = await fetchBambuToken(email, password, code);
    const token = loginJson.token || loginJson.accessToken;
    if (!token) return res.status(502).json({ error: 'No token in login response' });
    const uid = await fetchBambuUserId(token);
    if (!uid) return res.status(502).json({ error: 'Could not get user ID' });
    setSetting('bambu.email',  email);
    setSetting('bambu.token',  token);
    setSetting('bambu.userId', String(uid));
    setSetting('bambu.region', region);
    db.prepare("DELETE FROM settings WHERE key IN ('bambu.pendingEmail','bambu.pendingPassword','bambu.pendingRegion')").run();
    await bambu.reinit(db);
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.delete('/api/bambu/connect', (req, res) => {
  db.prepare("DELETE FROM settings WHERE key LIKE 'bambu.%'").run();
  bambu.disconnect();
  res.json({ status: 'ok' });
});

app.get('/api/printers/status/stream', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.flushHeaders();

  // Send current snapshot immediately
  const snapshot = bambu.getAllStatuses();
  if (Object.keys(snapshot).length > 0) {
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  }

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// --- Printers ---
app.get('/api/printers', (req, res) => {
  res.json(db.prepare('SELECT * FROM printers').all());
});
app.post('/api/printers', (req, res) => {
  const { name, color, bambu_serial } = req.body;
  const result = db.prepare('INSERT INTO printers (name, color, bambu_serial) VALUES (?, ?, ?)').run(name, color, bambu_serial || null);
  if (bambu_serial) bambu.subscribeSerial(bambu_serial);
  res.status(201).json({ id: result.lastInsertRowid, name, color, bambu_serial: bambu_serial || null });
});
app.put('/api/printers/:id', (req, res) => {
  const { name, color, bambu_serial } = req.body;
  db.prepare('UPDATE printers SET name=?, color=?, bambu_serial=? WHERE id=?').run(name, color, bambu_serial || null, req.params.id);
  if (bambu_serial) bambu.subscribeSerial(bambu_serial);
  res.json({ id: Number(req.params.id), name, color, bambu_serial: bambu_serial || null });
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

app.listen(process.env.PORT || 3000, () => {
  console.log(`PrintFarm Planner running on port ${process.env.PORT || 3000}`);
});
