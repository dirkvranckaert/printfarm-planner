'use strict';

const webpush = require('web-push');
let _db = null;

function init(db) {
  _db = db;
  let pub = _get('vapid.publicKey');
  let priv = _get('vapid.privateKey');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    _set('vapid.publicKey', pub);
    _set('vapid.privateKey', priv);
  }
  // VAPID `sub` must be a valid mailto: or https: URL backed by a real
  // domain. Apple Push rejects `admin@localhost`, `admin@.local`, bare IPs,
  // etc. with BadJwtToken. Pick from (in order): explicit VAPID_CONTACT env,
  // the public planner URL, a sensible hardcoded fallback.
  const publicHostFrom = (u) => {
    try {
      const h = new URL(u).hostname;
      if (!h || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.endsWith('.local')) return null;
      return h;
    } catch { return null; }
  };
  const publicHost = publicHostFrom(process.env.PLANNER_PUBLIC_URL)
                  || publicHostFrom(process.env.PUBLIC_URL)
                  || publicHostFrom(process.env.PLANNER_URL);
  const contact = process.env.VAPID_CONTACT
    || (publicHost && `mailto:admin@${publicHost}`)
    || 'mailto:admin@app3.be';
  console.log(`[push] VAPID contact: ${contact}`);
  webpush.setVapidDetails(contact, pub, priv);
  return pub;
}

function _get(key) {
  const row = _db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function _set(key, value) {
  _db.prepare('INSERT INTO settings (key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

function getPublicKey() {
  return _get('vapid.publicKey');
}

function isEnabled(type) {
  const row = _db.prepare(`SELECT value FROM settings WHERE key=?`).get(`push.notify.${type}`);
  if (!row) return true; // default enabled
  try { return JSON.parse(row.value) !== false; } catch { return true; }
}

function sendToAll(payload) {
  if (!_db) return;
  const subs = _db.prepare('SELECT * FROM push_subscriptions').all();
  for (const row of subs) {
    let sub;
    try { sub = JSON.parse(row.subscription); } catch { continue; }
    const host = sub.endpoint ? new URL(sub.endpoint).hostname : '?';
    webpush.sendNotification(sub, JSON.stringify(payload))
      .then(() => {
        console.log(`[push] ✓ delivered to ${host} (sub ${row.id})`);
      })
      .catch(err => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`[push] ✗ ${host} gone (${err.statusCode}) — removing sub ${row.id}`);
          _db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.id);
        } else {
          console.error(`[push] ✗ ${host} sub ${row.id}: ${err.statusCode || '?'} ${err.message}${err.body ? ' — ' + err.body : ''}`);
        }
      });
  }
}

module.exports = { init, getPublicKey, isEnabled, sendToAll };
