'use strict';

// BambuLab brand module.
// Wraps the low-level MQTT manager (../bambu.js) and adds:
//   - Brand metadata (id, name)
//   - getPrinterKey(printer)  — returns the MQTT serial for this printer row
//   - Express router          — /api/brands/bambulab/* auth endpoints
//   - DB credential helpers   — read/write the settings table

const express = require('express');
const bambu   = require('../bambu');

const id   = 'bambulab';
const name = 'BambuLab';

// ---- DB helpers ----
let _db = null;

function getSetting(key) {
  if (!_db) return null;
  const row = _db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  _db.prepare(
    'INSERT INTO settings (key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, JSON.stringify(value));
}

// ---- Bambu cloud auth helpers ----
async function fetchToken(email, password, code) {
  const body = { account: email, password };
  if (code) body.code = code;
  const res = await fetch('https://api.bambulab.com/v1/user-service/user/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function fetchUserId(token) {
  const res = await fetch('https://api.bambulab.com/v1/design-user-service/my/preference', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`User ID fetch failed: ${res.status}`);
  const json = await res.json();
  return json.uid || json.userId || json.user_id;
}

// ---- Lifecycle ----
async function connect(db) {
  _db = db;
  await bambu.connect(db);
}

function disconnect() {
  bambu.disconnect();
}

async function reinit(db) {
  _db = db;
  await bambu.reinit(db);
}

// ---- Status ----

// Return the live-status lookup key for this printer row.
// Must match what onUpdate() returns as the key.
function getPrinterKey(printer) {
  return (printer.brand === id && printer.bambu_serial) ? printer.bambu_serial : null;
}

// Subscribe a newly added/updated printer to live updates.
function subscribeForPrinter(printer) {
  const key = getPrinterKey(printer);
  if (key) bambu.subscribeSerial(key);
}

const isConnected    = bambu.isConnected;
const getStatus      = bambu.getStatus;      // (printerKey) => statusObj | null
const getAllStatuses  = bambu.getAllStatuses; // () => { [printerKey]: statusObj }

// Register a callback; called with (printerKey, statusObj) on each MQTT update.
function onUpdate(cb) {
  bambu.onUpdate((serial, status) => cb(serial, status));
}

// ---- Express router (/api/brands/bambulab/*) ----
const router = express.Router();

router.get('/config', (req, res) => {
  const email   = getSetting('bambu.email');
  const region  = getSetting('bambu.region') || 'us';
  const token   = getSetting('bambu.token');
  res.json({ email, region, connected: !!token });
});

// Step 1: login with email + password
router.post('/connect', async (req, res) => {
  const { email, password, region } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const loginJson = await fetchToken(email, password);
    if (loginJson.loginType === 'verifyCode') {
      setSetting('bambu.pendingEmail',    email);
      setSetting('bambu.pendingPassword', password);
      setSetting('bambu.pendingRegion',   region || 'us');
      return res.json({ status: 'verifyCode' });
    }
    const token = loginJson.token || loginJson.accessToken;
    if (!token) return res.status(502).json({ error: 'No token in login response' });
    const uid = await fetchUserId(token);
    if (!uid)  return res.status(502).json({ error: 'Could not get user ID' });
    setSetting('bambu.email',  email);
    setSetting('bambu.token',  token);
    setSetting('bambu.userId', String(uid));
    setSetting('bambu.region', region || 'us');
    await reinit(_db);
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Step 2: submit email verification code
router.post('/verify', async (req, res) => {
  const { code } = req.body ?? {};
  if (!code) return res.status(400).json({ error: 'code required' });
  const email    = getSetting('bambu.pendingEmail');
  const password = getSetting('bambu.pendingPassword');
  const region   = getSetting('bambu.pendingRegion') || 'us';
  if (!email || !password) return res.status(400).json({ error: 'No pending login — call /connect first' });
  try {
    const loginJson = await fetchToken(email, password, code);
    const token = loginJson.token || loginJson.accessToken;
    if (!token) return res.status(502).json({ error: 'No token in login response' });
    const uid = await fetchUserId(token);
    if (!uid)  return res.status(502).json({ error: 'Could not get user ID' });
    setSetting('bambu.email',  email);
    setSetting('bambu.token',  token);
    setSetting('bambu.userId', String(uid));
    setSetting('bambu.region', region);
    _db.prepare("DELETE FROM settings WHERE key IN ('bambu.pendingEmail','bambu.pendingPassword','bambu.pendingRegion')").run();
    await reinit(_db);
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Disconnect: clear credentials and stop MQTT
router.delete('/connect', (req, res) => {
  _db.prepare("DELETE FROM settings WHERE key LIKE 'bambu.%'").run();
  disconnect();
  res.json({ status: 'ok' });
});

module.exports = {
  id,
  name,
  // Lifecycle
  connect,
  disconnect,
  reinit,
  isConnected,
  // Status
  getPrinterKey,
  subscribeForPrinter,
  getStatus,
  getAllStatuses,
  onUpdate,
  // Express routes
  router,
};
