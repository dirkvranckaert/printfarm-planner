'use strict';

// BambuLab cloud MQTT manager.
// Credentials are stored in the DB settings table (keys: bambu.token, bambu.userId, bambu.region).
// Use the Settings UI to configure the BambuLab connection.

let mqtt;
try { mqtt = require('mqtt'); } catch {
  // mqtt not installed — Bambu integration will be skipped
}

const statusMap = {};       // { [serial]: { stage, progress, remaining, nozzle_temp, bed_temp, updated_at } }
const AMS_DEBUG        = process.env.BAMBU_AMS_DEBUG === 'true';
const AMS_DEBUG_SERIAL = process.env.BAMBU_AMS_DEBUG_SERIAL || null; // e.g. "01P00A123456789"

function dbg(serial, ...args) {
  if (!AMS_DEBUG) return;
  if (AMS_DEBUG_SERIAL && serial !== AMS_DEBUG_SERIAL) return;
  console.log(`[Bambu:${serial}]`, ...args);
}
const updateCallbacks = [];

let mqttClient = null;
const subscribedSerials = new Set();
let _db = null;

function getSetting(key) {
  if (!_db) return null;
  const row = _db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

// Convert a Bambu RGBA hex string (e.g. "FF69B4FF") to CSS hex (e.g. "#FF69B4").
// Returns null for empty/unknown slots (all-zero or empty string).
function bambuColorToCss(rgba) {
  if (!rgba || rgba === '00000000' || rgba.length < 6) return null;
  return '#' + rgba.slice(0, 6).toUpperCase();
}

// Parse the AMS object from a Bambu MQTT message into a generic slots array.
// Each slot: { id, label, color, material, remainPct, k, active }
function parseAms(p) {
  const slots = [];
  const activeTray = p.ams?.tray_now != null ? String(p.ams.tray_now)
                   : p.tray_now     != null ? String(p.tray_now)
                   : null;

  const amsUnits = p.ams?.ams;
  if (Array.isArray(amsUnits)) {
    amsUnits.forEach(unit => {
      const unitIdx = Number(unit.id ?? 0);
      const unitLabel = String.fromCharCode(65 + unitIdx); // 0→A, 1→B, …
      (unit.tray || []).forEach(tray => {
        const slotIdx = Number(tray.id ?? 0);
        const id      = `${unitLabel}${slotIdx + 1}`;  // A1, A2, B1, …
        const color    = bambuColorToCss(tray.tray_color);
        const material = tray.tray_type || null;
        const isEmpty  = !material && !color;
        slots.push({
          id,
          label:     isEmpty ? 'Empty' : material,
          color:     color,
          material:  material,
          remainPct: tray.remain != null ? Number(tray.remain) : null,
          k:         tray.k     != null ? Number(tray.k)      : null,
          active:    activeTray === String(unitIdx * 4 + slotIdx),
          empty:     isEmpty,
        });
      });
    });
  }

  // External spool (vt_tray)
  if (p.vt_tray != null) {
    const vt = p.vt_tray;
    const color    = bambuColorToCss(vt.tray_color);
    const material = vt.tray_type || null;
    const isEmpty  = !material && !color;
    slots.push({
      id:        'Ext',
      label:     isEmpty ? '?' : material,
      color:     color,
      material:  material,
      remainPct: vt.remain != null ? Number(vt.remain) : null,
      k:         vt.k      != null ? Number(vt.k)      : null,
      active:    activeTray === '254',
      empty:     isEmpty,
    });
  }

  return slots.length ? slots : null;
}

function parseMessage(serial, payload) {
  try {
    const msg = JSON.parse(payload.toString());
    const p = msg.print;
    dbg(serial, '← raw print keys:', p ? Object.keys(p).join(', ') : '(no print object)');
    if (!p) return;
    if (AMS_DEBUG && (!AMS_DEBUG_SERIAL || serial === AMS_DEBUG_SERIAL) &&
        (p.ams !== undefined || p.vt_tray !== undefined || p.tray_now !== undefined)) {
      console.log(`[Bambu:${serial}] ← full print payload:`, JSON.stringify(p, null, 2));
    }

    // Merge incremental fields into existing entry (Bambu sends partial updates)
    const prev = statusMap[serial] || {};
    const next = { ...prev, updated_at: new Date().toISOString() };

    if (p.gcode_state              !== undefined) next.stage          = p.gcode_state;
    if (p.mc_percent               !== undefined) next.progress       = p.mc_percent;
    if (p.mc_remaining_time        !== undefined) next.remaining      = p.mc_remaining_time;
    if (p.nozzle_temper            !== undefined) next.nozzle_temp    = p.nozzle_temper;
    if (p.nozzle_target_temper     !== undefined) next.nozzle_target  = p.nozzle_target_temper;
    if (p.bed_temper               !== undefined) next.bed_temp       = p.bed_temper;
    if (p.bed_target_temper        !== undefined) next.bed_target     = p.bed_target_temper;
    if (p.subtask_name             !== undefined) next.job_name       = p.subtask_name;

    // Multi-color / AMS info — only update when the field is present
    if (p.ams !== undefined || p.vt_tray !== undefined) {
      dbg(serial, 'AMS print_info — tray_now:', p.tray_now,
        '| ams.tray_now:', p.ams?.tray_now,
        '| ams_status:', p.ams_status,
        '| ams:', JSON.stringify(p.ams),
        '| vt_tray:', JSON.stringify(p.vt_tray));
      const slots = parseAms(p);
      dbg(serial, 'parsed slots:', JSON.stringify(slots?.map(s => ({ id: s.id, active: s.active, material: s.material }))));
      if (slots) next.slots = slots;
    }

    // Infer RUNNING if we have remaining time but no explicit stage yet
    if (!next.stage && next.remaining > 0) next.stage = 'RUNNING';

    // Skip if we still have nothing meaningful
    if (!next.stage && !next.nozzle_temp && !next.bed_temp) return;

    statusMap[serial] = next;
    updateCallbacks.forEach(cb => cb(serial, next));
  } catch {
    // ignore parse errors
  }
}

async function connect(db) {
  if (!mqtt) {
    console.log('[Bambu] mqtt package not installed — skipping Bambu integration');
    return;
  }

  _db = db;

  const token  = getSetting('bambu.token');
  const uid    = getSetting('bambu.userId');
  const region = getSetting('bambu.region') || 'us';

  if (!token || !uid) {
    console.log('[Bambu] No credentials in DB — skipping MQTT connection');
    return;
  }

  const broker = `mqtts://${region}.mqtt.bambulab.com:8883`;

  mqttClient = mqtt.connect(broker, {
    username: `u_${uid}`,
    password: token,
    rejectUnauthorized: false,
    reconnectPeriod: 10000,
  });

  mqttClient.on('connect', () => {
    console.log('[Bambu] MQTT connected');
    subscribeAll(db);
  });

  mqttClient.on('message', (topic, payload) => {
    // topic: device/{serial}/report
    const parts = topic.split('/');
    if (parts.length === 3 && parts[0] === 'device' && parts[2] === 'report') {
      parseMessage(parts[1], payload);
    }
  });

  mqttClient.on('error', err => {
    console.error('[Bambu] MQTT error:', err.message);
  });

  mqttClient.on('offline', () => {
    console.log('[Bambu] MQTT offline — will reconnect...');
  });

  // Periodically re-request full status for all subscribed printers.
  // Covers mid-print server restarts and printers that miss the initial pushall.
  const POLL_INTERVAL = 60_000; // ms
  const pollTimer = setInterval(() => {
    if (AMS_DEBUG && (!AMS_DEBUG_SERIAL || subscribedSerials.has(AMS_DEBUG_SERIAL))) {
      console.log(`[Bambu] poll tick — requesting pushall for ${AMS_DEBUG_SERIAL ?? `${subscribedSerials.size} printer(s)`}`);
    }
    for (const serial of subscribedSerials) {
      requestPushAll(serial);
    }
  }, POLL_INTERVAL);
  // Clean up timer when the client is explicitly ended
  mqttClient.on('end', () => clearInterval(pollTimer));
}

function disconnect() {
  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }
  subscribedSerials.clear();
  console.log('[Bambu] Disconnected');
}

async function reinit(db) {
  disconnect();
  await connect(db);
}

function subscribeAll(db) {
  try {
    const printers = db.prepare(
      "SELECT bambu_serial FROM printers WHERE bambu_serial IS NOT NULL AND bambu_serial != ''"
    ).all();
    for (const { bambu_serial } of printers) {
      subscribeSerial(bambu_serial);
    }
  } catch (e) {
    console.error('[Bambu] subscribeAll error:', e.message);
  }
}

function requestPushAll(serial) {
  if (!mqttClient || !mqttClient.connected) return;
  dbg(serial, '→ sending pushall');
  mqttClient.publish(
    `device/${serial}/request`,
    JSON.stringify({ pushing: { command: 'pushall', push_target: 1, sequence_id: '1' } })
  );
}

function subscribeSerial(serial) {
  if (!mqttClient || subscribedSerials.has(serial)) return;
  mqttClient.subscribe(`device/${serial}/report`, err => {
    if (err) {
      console.error(`[Bambu] Subscribe error for ${serial}:`, err.message);
    } else {
      subscribedSerials.add(serial);
      console.log(`[Bambu] Subscribed to ${serial}`);
      // Request a full status dump immediately so we get current state (e.g. mid-print after restart)
      requestPushAll(serial);
    }
  });
}

function isConnected() {
  return mqttClient !== null && mqttClient.connected;
}

function getStatus(serial) {
  return statusMap[serial] ?? null;
}

function getAllStatuses() {
  return { ...statusMap };
}

function onUpdate(cb) {
  updateCallbacks.push(cb);
}

module.exports = { connect, disconnect, reinit, subscribeSerial, isConnected, getStatus, getAllStatuses, onUpdate };
