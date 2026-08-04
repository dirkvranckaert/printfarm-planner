// Settings on/off switch for the `conflict` push type.
//
// The `conflict` push (active print's runtime delay overlaps a LOCKED job)
// is gated in server.js by `result.notifyLockedConflict && push.isEnabled('conflict')`.
// These tests verify the toggle end-to-end at the preference layer:
//   - switch OFF  → isEnabled('conflict') false → send skipped
//   - switch ON / unset-defaults-ON → isEnabled true → send happens
//   - existing per-type switches (started/done/paused/upcoming) unaffected.

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const push = require('../push');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, subscription TEXT NOT NULL);
  `);
  push.init(db); // generates + stores VAPID keys, wires webpush
  return db;
}

function setPref(db, type, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(`push.notify.${type}`, JSON.stringify(value));
}

// Exact replica of the send-gate in server.js (maybeRealign, ~line 133).
// Returns true when the conflict push would be sent.
function wouldSendConflict(notifyLockedConflict) {
  return !!(notifyLockedConflict && push.isEnabled('conflict'));
}

describe('conflict push type — Settings on/off switch', () => {
  test('default (no stored pref) → isEnabled ON, existing user keeps receiving', () => {
    const db = makeDb();
    expect(push.isEnabled('conflict')).toBe(true);
    // send-gate: a real conflict with the default pref sends.
    expect(wouldSendConflict(true)).toBe(true);
  });

  test('switch OFF → isEnabled false → send skipped', () => {
    const db = makeDb();
    setPref(db, 'conflict', false);
    expect(push.isEnabled('conflict')).toBe(false);
    // Even with a live conflict, the send is gated off.
    expect(wouldSendConflict(true)).toBe(false);
  });

  test('switch ON → isEnabled true → send happens', () => {
    const db = makeDb();
    setPref(db, 'conflict', true);
    expect(push.isEnabled('conflict')).toBe(true);
    expect(wouldSendConflict(true)).toBe(true);
  });

  test('no conflict present → never sends regardless of switch state', () => {
    const db = makeDb();
    setPref(db, 'conflict', true);
    expect(wouldSendConflict(false)).toBe(false);
  });

  test('sendToAll is actually invoked only when the switch is ON', () => {
    const db = makeDb();
    const spy = jest.spyOn(push, 'sendToAll').mockImplementation(() => {});
    const fire = () => { if (wouldSendConflict(true)) push.sendToAll({ title: 'x' }); };

    setPref(db, 'conflict', false);
    fire();
    expect(spy).not.toHaveBeenCalled();

    setPref(db, 'conflict', true);
    fire();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('toggling conflict does not affect started/done/paused/upcoming', () => {
    const db = makeDb();
    setPref(db, 'conflict', false);
    for (const t of ['started', 'done', 'paused', 'upcoming']) {
      expect(push.isEnabled(t)).toBe(true); // still default-ON
    }
    // And turning one of those off leaves conflict independent.
    setPref(db, 'conflict', true);
    setPref(db, 'paused', false);
    expect(push.isEnabled('conflict')).toBe(true);
    expect(push.isEnabled('paused')).toBe(false);
  });
});

describe('conflict switch — Settings UI wiring (index.html + app.js)', () => {
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  test('checkbox #push-notify-conflict exists in the notification prefs panel', () => {
    expect(HTML).toContain('id="push-notify-conflict"');
  });

  test('app.js loads the stored conflict pref and defaults it ON', () => {
    expect(APP).toContain("'/api/settings/push.notify.conflict'");
    expect(APP).toContain('cbConflict.checked = pnc?.value !== false');
  });

  test('app.js auto-saves the conflict switch on change', () => {
    expect(APP).toContain("'push-notify-conflict'");
  });
});
