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
  webpush.setVapidDetails('mailto:admin@printfarm.local', pub, priv);
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
    webpush.sendNotification(sub, JSON.stringify(payload))
      .catch(err => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          _db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.id);
        }
      });
  }
}

module.exports = { init, getPublicKey, isEnabled, sendToAll };
