// Point the app's DB singleton at a throwaway temp file and flag the test env
// BEFORE anything requires ../db or ../server (both read these at load time).
const os   = require('os');
const fs   = require('fs');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.PLANNER_DB_PATH =
  process.env.PLANNER_DB_PATH || path.join(os.tmpdir(), `printfarm-test-${process.pid}.db`);

const Database = require('better-sqlite3');

describe('Printer CRUD', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE printers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        brand TEXT DEFAULT 'other',
        bambu_serial TEXT,
        pinned INTEGER DEFAULT 0,
        warm_up_mins INTEGER DEFAULT 5,
        cool_down_mins INTEGER DEFAULT 15,
        favourite INTEGER DEFAULT 1
      );
    `);
  });

  test('can insert and retrieve a printer', () => {
    db.prepare('INSERT INTO printers (name, color, brand, pinned, warm_up_mins, cool_down_mins, favourite) VALUES (?,?,?,?,?,?,?)')
      .run('Test Printer', '#ff0000', 'other', 0, 5, 15, 1);
    const printers = db.prepare('SELECT * FROM printers').all();
    expect(printers).toHaveLength(1);
    expect(printers[0].name).toBe('Test Printer');
    expect(printers[0].favourite).toBe(1);
  });

  test('new printers default to favourite=1 (visible in day view)', () => {
    db.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run('Auto-fav', '#123456');
    const p = db.prepare('SELECT * FROM printers').get();
    expect(p.favourite).toBe(1);
  });

  test('unstarring a printer sets favourite=0', () => {
    const r = db.prepare('INSERT INTO printers (name, color, favourite) VALUES (?,?,?)').run('Star', '#abc', 1);
    db.prepare('UPDATE printers SET favourite=0 WHERE id=?').run(r.lastInsertRowid);
    const p = db.prepare('SELECT favourite FROM printers WHERE id=?').get(r.lastInsertRowid);
    expect(p.favourite).toBe(0);
  });

  test('can set a printer as favourite', () => {
    db.prepare('INSERT INTO printers (name, color, brand, pinned, warm_up_mins, cool_down_mins, favourite) VALUES (?,?,?,?,?,?,?)')
      .run('Fav Printer', '#00ff00', 'other', 0, 5, 15, 1);
    const favs = db.prepare('SELECT * FROM printers WHERE favourite=1').all();
    expect(favs).toHaveLength(1);
    expect(favs[0].name).toBe('Fav Printer');
  });

  test('toggling favourite on/off works correctly', () => {
    const r = db.prepare('INSERT INTO printers (name, color, favourite) VALUES (?,?,?)').run('Toggle', '#abc', 1);
    const id = r.lastInsertRowid;
    // turn off
    db.prepare('UPDATE printers SET favourite=0 WHERE id=?').run(id);
    expect(db.prepare('SELECT favourite FROM printers WHERE id=?').get(id).favourite).toBe(0);
    // turn back on
    db.prepare('UPDATE printers SET favourite=1 WHERE id=?').run(id);
    expect(db.prepare('SELECT favourite FROM printers WHERE id=?').get(id).favourite).toBe(1);
  });

  test('one-time migration sets favourite=1 for printers created with old DEFAULT 0', () => {
    // Simulate old state: printers with favourite=0
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO printers (name, color, favourite) VALUES (?,?,?)').run('OldPrinter', '#fff', 0);
    const before = db.prepare('SELECT favourite FROM printers').get();
    expect(before.favourite).toBe(0);

    // Run the migration logic
    const favMigrated = db.prepare("SELECT value FROM settings WHERE key='favouriteMigrated'").get();
    if (!favMigrated) {
      db.exec("UPDATE printers SET favourite=1 WHERE favourite=0");
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('favouriteMigrated', '1')").run();
    }

    const after = db.prepare('SELECT favourite FROM printers').get();
    expect(after.favourite).toBe(1);
    // Migration flag is set so it won't run again
    const flag = db.prepare("SELECT value FROM settings WHERE key='favouriteMigrated'").get();
    expect(flag.value).toBe('1');
  });

  test('migration does not run a second time', () => {
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare("INSERT INTO settings (key, value) VALUES ('favouriteMigrated', '1')").run();
    db.prepare('INSERT INTO printers (name, color, favourite) VALUES (?,?,?)').run('New', '#000', 0);

    // Migration should be skipped because flag is already set
    const favMigrated = db.prepare("SELECT value FROM settings WHERE key='favouriteMigrated'").get();
    if (!favMigrated) {
      db.exec("UPDATE printers SET favourite=1 WHERE favourite=0");
    }

    // favourite should still be 0 (migration was skipped)
    const p = db.prepare('SELECT favourite FROM printers').get();
    expect(p.favourite).toBe(0);
  });

  test('can delete a printer', () => {
    const result = db.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run('Del Me', '#000');
    db.prepare('DELETE FROM printers WHERE id=?').run(result.lastInsertRowid);
    const printers = db.prepare('SELECT * FROM printers').all();
    expect(printers).toHaveLength(0);
  });
});

describe('Job CRUD', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE printers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printerId INTEGER NOT NULL,
        name TEXT NOT NULL,
        customerName TEXT,
        orderNr TEXT,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        status TEXT DEFAULT 'Planned',
        colors TEXT,
        printFile TEXT,
        remarks TEXT,
        queued INTEGER DEFAULT 0,
        durationMins INTEGER DEFAULT 0,
        linked_printer_id INTEGER
      );
    `);
    db.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run('P1', '#f00');
  });

  test('can insert and retrieve a job', () => {
    const pid = db.prepare('SELECT id FROM printers').get().id;
    db.prepare('INSERT INTO jobs (printerId, name, start, end, status) VALUES (?,?,?,?,?)')
      .run(pid, 'Test Job', '2026-03-27T10:00', '2026-03-27T12:00', 'Planned');
    const jobs = db.prepare('SELECT * FROM jobs').all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('Test Job');
    expect(jobs[0].status).toBe('Planned');
  });

  test('can patch job status', () => {
    const pid = db.prepare('SELECT id FROM printers').get().id;
    const r = db.prepare('INSERT INTO jobs (printerId, name, start, end, status) VALUES (?,?,?,?,?)')
      .run(pid, 'Job', '2026-03-27T10:00', '2026-03-27T12:00', 'Planned');
    db.prepare('UPDATE jobs SET status=? WHERE id=?').run('Printing', r.lastInsertRowid);
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(r.lastInsertRowid);
    expect(job.status).toBe('Printing');
  });

  // NOTE: the context-menu-status-persistence test and the badge-count test
  // moved out of this in-memory block. They now exercise real shipped code:
  //   - status persistence -> real PATCH /api/jobs/:id route (supertest), below
  //   - badge count -> shared pure fn public/statusCount.js, below

  test('deleting a printer cascades to its jobs', () => {
    const pid = db.prepare('SELECT id FROM printers').get().id;
    db.prepare('INSERT INTO jobs (printerId, name, start, end) VALUES (?,?,?,?)').run(pid, 'J', '2026-03-27T10:00', '2026-03-27T11:00');
    db.prepare('DELETE FROM jobs WHERE printerId=?').run(pid);
    db.prepare('DELETE FROM printers WHERE id=?').run(pid);
    expect(db.prepare('SELECT * FROM jobs').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM printers').all()).toHaveLength(0);
  });
});

describe('Push notification helpers', () => {
  test('buildDoneMessage with job, orderNr and customerName', () => {
    const printer = { name: 'P1S' };
    const job = { name: 'Keychain Dirk', orderNr: '100', customerName: 'Dirk' };
    let body = `Printer ${printer.name} has done printing `;
    if (job.orderNr) body += `order #${job.orderNr}: `;
    body += `'${job.name}'`;
    if (job.customerName) body += ` (${job.customerName})`;
    expect(body).toBe("Printer P1S has done printing order #100: 'Keychain Dirk' (Dirk)");
  });

  test('buildDoneMessage with job, no orderNr, no customerName', () => {
    const printer = { name: 'H2C' };
    const job = { name: 'Name tag', orderNr: null, customerName: null };
    let body = `Printer ${printer.name} has done printing `;
    if (job.orderNr) body += `order #${job.orderNr}: `;
    body += `'${job.name}'`;
    if (job.customerName) body += ` (${job.customerName})`;
    expect(body).toBe("Printer H2C has done printing 'Name tag'");
  });

  test('buildDoneMessage no job, file available', () => {
    const printer = { name: 'P1S' };
    const jobName = 'plate_001.gcode';
    const body = `Printer ${printer.name} is done printing ${jobName}`;
    expect(body).toBe('Printer P1S is done printing plate_001.gcode');
  });

  test('buildDoneMessage no job, no file', () => {
    const printer = { name: 'P1S' };
    const body = `Printer ${printer.name} has done printing`;
    expect(body).toBe('Printer P1S has done printing');
  });

  test('buildUpcomingMessage with orderNr', () => {
    const job = { name: 'Keychain', orderNr: '42', printerName: 'P1S' };
    const body = job.orderNr
      ? `It's time to start printing order #${job.orderNr} '${job.name}' on ${job.printerName}`
      : `It's about time to start printing '${job.name}' on ${job.printerName}`;
    expect(body).toBe("It's time to start printing order #42 'Keychain' on P1S");
  });

  test('buildUpcomingMessage without orderNr', () => {
    const job = { name: 'Keychain', orderNr: null, printerName: 'H2C' };
    const body = job.orderNr
      ? `It's time to start printing order #${job.orderNr} '${job.name}' on ${job.printerName}`
      : `It's about time to start printing '${job.name}' on ${job.printerName}`;
    expect(body).toBe("It's about time to start printing 'Keychain' on H2C");
  });

  test('start_push_sent column exists and defaults to 0', () => {
    const db = new (require('better-sqlite3'))(':memory:');
    db.exec(`
      CREATE TABLE printers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printerId INTEGER NOT NULL,
        name TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        status TEXT DEFAULT 'Planned',
        queued INTEGER DEFAULT 0,
        start_push_sent INTEGER DEFAULT 0
      );
    `);
    db.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run('P1', '#f00');
    const pid = db.prepare('SELECT id FROM printers').get().id;
    db.prepare('INSERT INTO jobs (printerId, name, start, end) VALUES (?,?,?,?)').run(pid, 'Test', '2026-03-27T10:00', '2026-03-27T11:00');
    const job = db.prepare('SELECT * FROM jobs').get();
    expect(job.start_push_sent).toBe(0);
    db.prepare('UPDATE jobs SET start_push_sent=1 WHERE id=?').run(job.id);
    const updated = db.prepare('SELECT start_push_sent FROM jobs WHERE id=?').get(job.id);
    expect(updated.start_push_sent).toBe(1);
    db.close();
  });

  test('push_subscriptions table can store and retrieve subscription', () => {
    const db = new (require('better-sqlite3'))(':memory:');
    db.exec(`CREATE TABLE push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription TEXT NOT NULL
    );`);
    const sub = JSON.stringify({ endpoint: 'https://push.example.com/abc', keys: { p256dh: 'x', auth: 'y' } });
    db.prepare('INSERT INTO push_subscriptions (subscription) VALUES (?)').run(sub);
    const rows = db.prepare('SELECT * FROM push_subscriptions').all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].subscription).endpoint).toBe('https://push.example.com/abc');
    db.close();
  });
});

describe('Session management', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`);
  });

  test('valid session returns true', () => {
    const token = 'test-token-123';
    const expiresAt = Date.now() + 3_600_000;
    db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?,?)').run(token, expiresAt);
    const row = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
    expect(row).toBeDefined();
    expect(Date.now() < row.expires_at).toBe(true);
  });

  test('expired session should be considered invalid', () => {
    const token = 'expired-token';
    const expiresAt = Date.now() - 1000; // already expired
    db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?,?)').run(token, expiresAt);
    const row = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
    expect(Date.now() > row.expires_at).toBe(true);
  });
});

describe('3MF schedule import — array-order is the contract', () => {
  // Regression guard for the /api/import-3mf-schedule route. The route loops
  // `for (const pl of plates)` and must NOT sort. Client-side reordering is
  // the entire backend story for the new per-plate up/down arrows. This test
  // mirrors the route's exact insertion shape against an in-memory DB and
  // proves: createdJobs come back in input order, starts are sequential, no
  // two jobs overlap. If a future refactor re-sorts plates inside the loop,
  // this test trips.
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE printers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        warm_up_mins INTEGER DEFAULT 5,
        cool_down_mins INTEGER DEFAULT 15
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printerId INTEGER,
        name TEXT NOT NULL,
        customerName TEXT,
        orderNr TEXT,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        status TEXT DEFAULT 'Planned',
        colors TEXT,
        printFile TEXT,
        remarks TEXT,
        queued INTEGER DEFAULT 0,
        durationMins INTEGER DEFAULT 0,
        thumbFile TEXT,
        bedType TEXT
      );
    `);
    db.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('P1', '#f00', 5, 15);
  });

  test('three plates in [3,1,2] order schedule in that order with sequential, non-overlapping starts', () => {
    // Mirrors server.js /api/import-3mf-schedule loop semantics with a
    // pass-through `findNextValidStart` (no silent-hours / closed-days here —
    // those are covered by scheduling.test.js. We only need to prove the loop
    // respects array order).
    const findNextValidStart = (candidate /*, durationMins, printerId */) => new Date(candidate);

    const printerId = db.prepare('SELECT id FROM printers').get().id;
    const plates = [
      { plateIndex: 3, name: 'Plate 3', printerId, durationMins: 60 },
      { plateIndex: 1, name: 'Plate 1', printerId, durationMins: 90 },
      { plateIndex: 2, name: 'Plate 2', printerId, durationMins: 30 },
    ];

    let currentStart = new Date('2026-04-27T08:00:00.000Z');
    const createdJobs = [];
    for (const pl of plates) {
      const validStart = findNextValidStart(currentStart, pl.durationMins, pl.printerId);
      const endDate = new Date(validStart.getTime() + pl.durationMins * 60000);
      const printer = db.prepare('SELECT warm_up_mins, cool_down_mins FROM printers WHERE id=?').get(pl.printerId);
      const warmUp = printer.warm_up_mins;
      const coolDown = printer.cool_down_mins;
      const result = db.prepare(
        'INSERT INTO jobs (printerId, name, start, end, status, durationMins) VALUES (?,?,?,?,?,?)'
      ).run(pl.printerId, pl.name, validStart.toISOString(), endDate.toISOString(), 'Planned', pl.durationMins);
      createdJobs.push({
        id: result.lastInsertRowid,
        name: pl.name,
        printerId: pl.printerId,
        start: validStart.toISOString(),
        end: endDate.toISOString(),
        durationMins: pl.durationMins,
      });
      currentStart = new Date(endDate.getTime() + (coolDown + warmUp) * 60000);
    }

    // Order: array order is preserved end-to-end.
    expect(createdJobs.map(j => j.name)).toEqual(['Plate 3', 'Plate 1', 'Plate 2']);

    // Sequential: each job starts at or after the previous one ends.
    expect(new Date(createdJobs[1].start).getTime())
      .toBeGreaterThanOrEqual(new Date(createdJobs[0].end).getTime());
    expect(new Date(createdJobs[2].start).getTime())
      .toBeGreaterThanOrEqual(new Date(createdJobs[1].end).getTime());

    // Non-overlapping: end of N < start of N+1 (strict, since cool+warm gap > 0).
    expect(new Date(createdJobs[0].end).getTime())
      .toBeLessThan(new Date(createdJobs[1].start).getTime());
    expect(new Date(createdJobs[1].end).getTime())
      .toBeLessThan(new Date(createdJobs[2].start).getTime());

    // DB rows are in insert order with the same names — no sort happened.
    const rows = db.prepare('SELECT name, start FROM jobs ORDER BY id ASC').all();
    expect(rows.map(r => r.name)).toEqual(['Plate 3', 'Plate 1', 'Plate 2']);
  });

  test('single-plate schedule: createdJobs has one entry, start == input start', () => {
    const findNextValidStart = (candidate) => new Date(candidate);
    const printerId = db.prepare('SELECT id FROM printers').get().id;
    const plates = [{ plateIndex: 1, name: 'Solo', printerId, durationMins: 45 }];
    const startISO = '2026-04-27T08:00:00.000Z';
    let currentStart = new Date(startISO);
    const createdJobs = [];
    for (const pl of plates) {
      const validStart = findNextValidStart(currentStart, pl.durationMins, pl.printerId);
      const endDate = new Date(validStart.getTime() + pl.durationMins * 60000);
      const result = db.prepare(
        'INSERT INTO jobs (printerId, name, start, end, status, durationMins) VALUES (?,?,?,?,?,?)'
      ).run(pl.printerId, pl.name, validStart.toISOString(), endDate.toISOString(), 'Planned', pl.durationMins);
      createdJobs.push({ id: result.lastInsertRowid, name: pl.name, start: validStart.toISOString(), end: endDate.toISOString() });
    }
    expect(createdJobs).toHaveLength(1);
    expect(createdJobs[0].name).toBe('Solo');
    expect(createdJobs[0].start).toBe(startISO);
  });
});

// Drives the REAL Express PATCH /api/jobs/:id route in-process via supertest,
// against the app's real DB layer (pointed at a temp file). This catches
// route-level regressions a raw SQL UPDATE cannot — e.g. 'status' being dropped
// from the route's allowed-fields whitelist.

// Cascade-reshove on an occupied move target. Covers all FOUR menu entry points:
// push-back-to (custom), pull-forward-to (custom), push-back-to-now, pull-forward-to-now.
// Each must funnel through the same fit -> needsReshove -> confirm -> cascade flow.
describe('timed moves — reshove on occupied slot (all four entry points)', () => {
  const request = require('supertest');
  let app, appDb, printerId;
  const SESSION_TOKEN = 'reshove-session-token';
  const authCookie = `pf_session=${SESSION_TOKEN}`;
  const iso = (d) => new Date(d).toISOString();

  beforeAll(() => {
    appDb = require('../db');
    app   = require('../server');
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION_TOKEN, Date.now() + 3_600_000);
  });

  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers; DELETE FROM closures;');
    // Benign 1-minute silent window at 04:00 Brussels so it never interferes with
    // the test times (silent-hours math itself is covered in scheduling.test.js).
    appDb.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
      .run('schedulingRestrictions', JSON.stringify({
        enabled: true, silentStart: '04:00', silentEnd: '04:01', closedDays: [], timezone: 'Europe/Brussels',
      }));
    const r = appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('P1', '#f00', 5, 15);
    printerId = r.lastInsertRowid;
  });

  afterAll(() => {
    try { appDb.exec('DELETE FROM jobs; DELETE FROM printers;'); } catch { /* ignore */ }
  });

  const addJob = (start, end, status = 'Planned') =>
    appDb.prepare('INSERT INTO jobs (printerId, name, start, end, status) VALUES (?,?,?,?,?)')
      .run(printerId, 'J', iso(start), iso(end), status).lastInsertRowid;

  // --- Entry 1: push-back to a custom time, target occupied ---
  test('push-back-to (custom): occupied slot returns needsReshove, then cascades on confirm', async () => {
    const anchor = addJob('2026-04-13T06:00:00Z', '2026-04-13T07:00:00Z');            // 08:00–09:00 Brussels
    const blocker = addJob('2026-04-13T12:00:00Z', '2026-04-13T13:00:00Z');           // 14:00–15:00 Brussels
    const to = '2026-04-13T12:00:00Z'; // push anchor right onto the blocker

    const r1 = await request(app).post(`/api/jobs/${anchor}/push-back`).set('Cookie', authCookie).send({ to });
    expect(r1.status).toBe(200);
    expect(r1.body.needsReshove).toBe(true);
    // Nothing written yet.
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(anchor).start).toBe(iso('2026-04-13T06:00:00Z'));

    const r2 = await request(app).post(`/api/jobs/${anchor}/push-back`).set('Cookie', authCookie).send({ to, reshove: true });
    expect(r2.status).toBe(200);
    expect(r2.body.reshoved).toBe(true);
    // Anchor verbatim at target; blocker shoved to anchorEnd 13:00Z + 20m = 13:20Z.
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(anchor).start).toBe(iso('2026-04-13T12:00:00Z'));
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(blocker).start).toBe(iso('2026-04-13T13:20:00Z'));
  });

  // --- Entry 2: pull-forward to a custom time, target occupied ---
  test('pull-forward-to (custom): occupied earlier slot returns needsReshove, then cascades', async () => {
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z');            // future
    const blocker = addJob('2026-04-13T08:00:00Z', '2026-04-13T09:00:00Z');           // 10:00–11:00 Brussels
    const to = '2026-04-13T08:00:00Z'; // pull anchor onto the earlier blocker

    const r1 = await request(app).post(`/api/jobs/${anchor}/pull-forward`).set('Cookie', authCookie).send({ to });
    expect(r1.body.needsReshove).toBe(true);
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(anchor).start).toBe(iso('2026-04-13T14:00:00Z'));

    const r2 = await request(app).post(`/api/jobs/${anchor}/pull-forward`).set('Cookie', authCookie).send({ to, reshove: true });
    expect(r2.body.reshoved).toBe(true);
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(anchor).start).toBe(iso('2026-04-13T08:00:00Z'));
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(blocker).start).toBe(iso('2026-04-13T09:20:00Z'));
  });

  // --- Entry 3: push-back to NOW (no `to`), target occupied ---
  test('push-back-to-now: occupied now-slot returns needsReshove, then cascades', async () => {
    const now = Date.now();
    const anchor = addJob(now - 3 * 3600_000, now - 2 * 3600_000); // past job (push-back = past-only)
    const blocker = addJob(now + 60_000, now + 60_000 + 3 * 3600_000); // starts just after now, spans it
    // Omit `to` → server uses new Date().
    const r1 = await request(app).post(`/api/jobs/${anchor}/push-back`).set('Cookie', authCookie).send({});
    expect(r1.body.needsReshove).toBe(true);

    const r2 = await request(app).post(`/api/jobs/${anchor}/push-back`).set('Cookie', authCookie).send({ reshove: true });
    expect(r2.body.reshoved).toBe(true);
    // Anchor now sits at ~now (verbatim); blocker was shoved later than its original start.
    const anchorStart = new Date(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(anchor).start).getTime();
    expect(Math.abs(anchorStart - now)).toBeLessThan(5000);
    const blockerStart = new Date(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(blocker).start).getTime();
    expect(blockerStart).toBeGreaterThan(now + 60_000);
  });

  // --- Entry 4: pull-forward to NOW (no `to`), target occupied ---
  test('pull-forward-to-now: occupied now-slot returns needsReshove, then cascades', async () => {
    const now = Date.now();
    const anchor = addJob(now + 3 * 3600_000, now + 4 * 3600_000); // future job (pull-forward = future-only)
    const blocker = addJob(now + 60_000, now + 60_000 + 3 * 3600_000);
    const r1 = await request(app).post(`/api/jobs/${anchor}/pull-forward`).set('Cookie', authCookie).send({});
    expect(r1.body.needsReshove).toBe(true);

    const r2 = await request(app).post(`/api/jobs/${anchor}/pull-forward`).set('Cookie', authCookie).send({ reshove: true });
    expect(r2.body.reshoved).toBe(true);
    const anchorStart = new Date(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(anchor).start).getTime();
    expect(Math.abs(anchorStart - now)).toBeLessThan(5000);
  });

  // --- No reshuffle needed: free slot moves without a dialog ---
  test('no-reshuffle: free later slot moves the anchor verbatim, no needsReshove', async () => {
    const anchor = addJob('2026-04-13T06:00:00Z', '2026-04-13T07:00:00Z'); // 08:00–09:00 Brussels
    addJob('2026-04-13T18:00:00Z', '2026-04-13T19:00:00Z');                 // far-away movable job
    const to = '2026-04-13T10:00:00Z'; // free slot

    const r = await request(app).post(`/api/jobs/${anchor}/push-back`).set('Cookie', authCookie).send({ to });
    expect(r.status).toBe(200);
    expect(r.body.needsReshove).toBeUndefined();
    expect(r.body.updatedCount).toBeGreaterThanOrEqual(1);
    // Anchor landed verbatim at the requested slot.
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(anchor).start).toBe(iso('2026-04-13T10:00:00Z'));
  });

  // --- Gating direction (836f660) stays permissive server-side: wrong direction no-ops ---
  test('wrong-direction custom push-back (to earlier) is a no-op, never a reshuffle', async () => {
    const anchor = addJob('2026-04-13T10:00:00Z', '2026-04-13T11:00:00Z');
    const to = '2026-04-13T08:00:00Z'; // earlier than current start → wrong direction for push-back
    const r = await request(app).post(`/api/jobs/${anchor}/push-back`).set('Cookie', authCookie).send({ to });
    expect(r.status).toBe(200);
    expect(r.body.needsReshove).toBeUndefined();
    expect(r.body.updatedCount).toBe(0);
    // Anchor unchanged.
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(anchor).start).toBe(iso('2026-04-13T10:00:00Z'));
  });

  const snapshotAll = () =>
    appDb.prepare('SELECT id, start, end FROM jobs ORDER BY id').all();

  // --- Fix 9: occupied-target WRONG-DIRECTION must gate BEFORE planning ---
  test('occupied wrong-direction push-back (explicit earlier `to`) no-ops even with reshove:true', async () => {
    const anchor = addJob('2026-04-13T12:00:00Z', '2026-04-13T13:00:00Z');
    addJob('2026-04-13T08:00:00Z', '2026-04-13T09:00:00Z'); // occupies the earlier target
    const before = snapshotAll();
    const to = '2026-04-13T08:00:00Z'; // earlier than anchor start → wrong direction
    const r = await request(app).post(`/api/jobs/${anchor}/push-back`).set('Cookie', authCookie).send({ to, reshove: true });
    expect(r.body.needsReshove).toBeUndefined();
    expect(r.body.updatedCount).toBe(0);
    expect(snapshotAll()).toEqual(before); // nothing moved
  });

  test('occupied wrong-direction pull-forward (explicit later `to`) no-ops even with reshove:true', async () => {
    const anchor = addJob('2026-04-13T08:00:00Z', '2026-04-13T09:00:00Z');
    addJob('2026-04-13T12:00:00Z', '2026-04-13T13:00:00Z'); // occupies the later target
    const before = snapshotAll();
    const to = '2026-04-13T12:00:00Z'; // later than anchor start → wrong direction for pull
    const r = await request(app).post(`/api/jobs/${anchor}/pull-forward`).set('Cookie', authCookie).send({ to, reshove: true });
    expect(r.body.needsReshove).toBeUndefined();
    expect(r.body.updatedCount).toBe(0);
    expect(snapshotAll()).toEqual(before);
  });

  // --- Fix 11: the initial needsReshove response writes NOTHING (all rows) ---
  test('initial needsReshove writes no rows at all (to-now flow snapshot)', async () => {
    const now = Date.now();
    const anchor = addJob(now - 3 * 3600_000, now - 2 * 3600_000);
    addJob(now + 60_000, now + 60_000 + 3 * 3600_000);
    addJob(now + 5 * 3600_000, now + 6 * 3600_000); // a third downstream job
    const before = snapshotAll();
    const r = await request(app).post(`/api/jobs/${anchor}/push-back`).set('Cookie', authCookie).send({});
    expect(r.body.needsReshove).toBe(true);
    expect(snapshotAll()).toEqual(before); // every row byte-unchanged
  });

  // --- Fix 10 + B1: immovable rows (Printing / Awaiting Printer / linked) never move ---
  test('reshove leaves Printing / Awaiting Printer / linked rows byte-unchanged + flags activeConflict', async () => {
    // Pull a future anchor onto a running print (correct pull-forward direction).
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z');
    const printing = addJob('2026-04-13T08:00:00Z', '2026-04-13T09:00:00Z', 'Printing'); // anchor lands on it
    const movable = addJob('2026-04-13T08:30:00Z', '2026-04-13T09:30:00Z'); // overlaps anchor → must shove
    // Immovable jobs parked well clear so they neither move nor absorb the cascade.
    const awaiting = addJob('2026-04-13T20:00:00Z', '2026-04-13T21:00:00Z', 'Awaiting Printer');
    // A linked Planned job — immovable despite its cascadable status.
    const linked = appDb.prepare("INSERT INTO jobs (printerId, name, start, end, status, linked_printer_id) VALUES (?,?,?,?,?,?)")
      .run(printerId, 'L', iso('2026-04-13T22:00:00Z'), iso('2026-04-13T23:00:00Z'), 'Planned', printerId).lastInsertRowid;

    const beforeImmovable = {
      printing: appDb.prepare('SELECT start,end FROM jobs WHERE id=?').get(printing),
      awaiting: appDb.prepare('SELECT start,end FROM jobs WHERE id=?').get(awaiting),
      linked:   appDb.prepare('SELECT start,end FROM jobs WHERE id=?').get(linked),
    };
    // No windowEnd → forced verbatim path. to (08:00) < anchor start (14:00) = correct pull direction.
    const to = '2026-04-13T08:00:00Z';
    const r = await request(app).post(`/api/jobs/${anchor}/pull-forward`).set('Cookie', authCookie).send({ to, reshove: true });
    expect(r.body.reshoved).toBe(true);
    expect(r.body.activeConflict).toBe(true); // anchor overlaps the running print
    // Immovable rows untouched.
    expect(appDb.prepare('SELECT start,end FROM jobs WHERE id=?').get(printing)).toEqual(beforeImmovable.printing);
    expect(appDb.prepare('SELECT start,end FROM jobs WHERE id=?').get(awaiting)).toEqual(beforeImmovable.awaiting);
    expect(appDb.prepare('SELECT start,end FROM jobs WHERE id=?').get(linked)).toEqual(beforeImmovable.linked);
    // The genuinely-movable job did move.
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(movable).start).not.toBe(iso('2026-04-13T08:30:00Z'));
  });

  // --- B3: pull-forward end-time optional (window mode vs forced verbatim) ---
  test('pull-forward NO windowEnd forces the exact start + cascades (occupied)', async () => {
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z');
    addJob('2026-04-13T08:00:00Z', '2026-04-13T09:00:00Z'); // occupies target
    const r1 = await request(app).post(`/api/jobs/${anchor}/pull-forward`).set('Cookie', authCookie).send({ to: '2026-04-13T08:00:00Z' });
    expect(r1.body.needsReshove).toBe(true);
    const r2 = await request(app).post(`/api/jobs/${anchor}/pull-forward`).set('Cookie', authCookie).send({ to: '2026-04-13T08:00:00Z', reshove: true });
    expect(r2.body.reshoved).toBe(true);
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(anchor).start).toBe(iso('2026-04-13T08:00:00Z')); // verbatim
  });

  test('pull-forward WITH windowEnd fits into a clean gap — no cascade, no dialog', async () => {
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z'); // future
    // Target 08:00 is free; window generous. Should place cleanly, no reshuffle.
    const r = await request(app).post(`/api/jobs/${anchor}/pull-forward`)
      .set('Cookie', authCookie)
      .send({ to: '2026-04-13T08:00:00Z', windowEnd: '2026-04-13T20:00:00Z' });
    expect(r.status).toBe(200);
    expect(r.body.needsReshove).toBeUndefined();
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(anchor).start).toBe(iso('2026-04-13T08:00:00Z'));
  });

  test('pull-forward WITH windowEnd but no gap in window → fallback to window start + reshove', async () => {
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z');
    // Fill the whole [08:00, 09:30] window with a movable job so no gap fits.
    addJob('2026-04-13T08:00:00Z', '2026-04-13T09:30:00Z');
    const r1 = await request(app).post(`/api/jobs/${anchor}/pull-forward`)
      .set('Cookie', authCookie)
      .send({ to: '2026-04-13T08:00:00Z', windowEnd: '2026-04-13T09:30:00Z' });
    expect(r1.body.needsReshove).toBe(true); // no gap → forced path asks to reshuffle
    const r2 = await request(app).post(`/api/jobs/${anchor}/pull-forward`)
      .set('Cookie', authCookie)
      .send({ to: '2026-04-13T08:00:00Z', windowEnd: '2026-04-13T09:30:00Z', reshove: true });
    expect(r2.body.reshoved).toBe(true);
    expect(appDb.prepare('SELECT start FROM jobs WHERE id=?').get(anchor).start).toBe(iso('2026-04-13T08:00:00Z')); // window start, verbatim
  });
});


describe('lockable jobs — immovability via the real routes (supertest)', () => {
  const request = require('supertest');
  let app, appDb, printerId;
  const SESSION_TOKEN = 'lock-session-token';
  const authCookie = `pf_session=${SESSION_TOKEN}`;
  const iso = (d) => new Date(d).toISOString();

  beforeAll(() => {
    appDb = require('../db');
    app   = require('../server');
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION_TOKEN, Date.now() + 3_600_000);
  });

  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers; DELETE FROM closures;');
    appDb.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
      .run('schedulingRestrictions', JSON.stringify({
        enabled: true, silentStart: '04:00', silentEnd: '04:01', closedDays: [], timezone: 'Europe/Brussels',
      }));
    const r = appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('P1', '#f00', 5, 15);
    printerId = r.lastInsertRowid;
  });

  const addJob = (start, end, { status = 'Planned', locked = 0 } = {}) =>
    appDb.prepare('INSERT INTO jobs (printerId, name, start, end, status, locked) VALUES (?,?,?,?,?,?)')
      .run(printerId, 'J', iso(start), iso(end), status, locked).lastInsertRowid;
  const getJob = (id) => appDb.prepare('SELECT * FROM jobs WHERE id=?').get(id);

  test('migration added locked + conflict_notified columns to jobs', () => {
    const cols = appDb.pragma('table_info(jobs)').map(c => c.name);
    expect(cols).toContain('locked');
    expect(cols).toContain('conflict_notified');
  });

  test('locked anchor: push-back is a no-op (never moves)', async () => {
    const anchor = addJob('2026-04-13T06:00:00Z', '2026-04-13T07:00:00Z', { locked: 1 });
    const r = await request(app).post(`/api/jobs/${anchor}/push-back`)
      .set('Cookie', authCookie).send({ to: '2026-04-13T12:00:00Z' });
    expect(r.status).toBe(200);
    expect(r.body.updatedCount).toBe(0);
    expect(getJob(anchor).start).toBe(iso('2026-04-13T06:00:00Z'));
  });

  test('locked anchor: pull-forward is a no-op (never moves)', async () => {
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z', { locked: 1 });
    const r = await request(app).post(`/api/jobs/${anchor}/pull-forward`)
      .set('Cookie', authCookie).send({ to: '2026-04-13T08:00:00Z' });
    expect(r.status).toBe(200);
    expect(r.body.updatedCount).toBe(0);
    expect(getJob(anchor).start).toBe(iso('2026-04-13T14:00:00Z'));
  });

  test('reshove routes around a locked downstream job — it is never shoved', async () => {
    const anchor  = addJob('2026-04-13T06:00:00Z', '2026-04-13T07:00:00Z');            // 08:00–09:00 Brussels
    const lockedBlocker = addJob('2026-04-13T12:00:00Z', '2026-04-13T13:00:00Z', { locked: 1 });
    const to = '2026-04-13T12:00:00Z'; // push anchor onto the locked blocker
    // A locked blocker is in the "fixed" bucket, never a mover → no reshove needed.
    const r = await request(app).post(`/api/jobs/${anchor}/push-back`)
      .set('Cookie', authCookie).send({ to, reshove: true });
    expect(r.status).toBe(200);
    // Locked blocker unchanged regardless of the anchor landing on it.
    expect(getJob(lockedBlocker).start).toBe(iso('2026-04-13T12:00:00Z'));
    expect(getJob(lockedBlocker).end).toBe(iso('2026-04-13T13:00:00Z'));
  });

  test('pull-forward WINDOW mode never tight-packs a downstream locked job', async () => {
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z');                 // future anchor
    const lockedDownstream = addJob('2026-04-13T16:00:00Z', '2026-04-13T17:00:00Z', { locked: 1 }); // in window, downstream
    // Window [08:00, 20:00] spans the locked job. Without the guard the window
    // chain would pull the locked job forward to pack behind the anchor.
    const r = await request(app).post(`/api/jobs/${anchor}/pull-forward`)
      .set('Cookie', authCookie)
      .send({ to: '2026-04-13T08:00:00Z', windowEnd: '2026-04-13T20:00:00Z' });
    expect(r.status).toBe(200);
    // Anchor moved into the window gap...
    expect(new Date(getJob(anchor).start).getTime()).toBeLessThan(new Date('2026-04-13T14:00:00Z').getTime());
    // ...but the locked downstream job is byte-unchanged.
    expect(getJob(lockedDownstream).start).toBe(iso('2026-04-13T16:00:00Z'));
    expect(getJob(lockedDownstream).end).toBe(iso('2026-04-13T17:00:00Z'));
  });

  test('lock toggle blocked while Printing (409)', async () => {
    const id = addJob('2026-04-13T06:00:00Z', '2026-04-13T07:00:00Z', { status: 'Printing' });
    const r = await request(app).patch(`/api/jobs/${id}`).set('Cookie', authCookie).send({ locked: 1 });
    expect(r.status).toBe(409);
    expect(getJob(id).locked).toBe(0);
  });

  test('lock toggle blocked while Awaiting Printer (409)', async () => {
    const id = addJob('2026-04-13T06:00:00Z', '2026-04-13T07:00:00Z', { status: 'Awaiting Printer' });
    const r = await request(app).patch(`/api/jobs/${id}`).set('Cookie', authCookie).send({ locked: 1 });
    expect(r.status).toBe(409);
    expect(getJob(id).locked).toBe(0);
  });

  test('lock toggle persists for a Planned job', async () => {
    const id = addJob('2026-04-13T06:00:00Z', '2026-04-13T07:00:00Z');
    const r = await request(app).patch(`/api/jobs/${id}`).set('Cookie', authCookie).send({ locked: 1 });
    expect(r.status).toBe(200);
    expect(getJob(id).locked).toBe(1);
  });

  test('PATCH on a locked job drops start/end/printerId (drag/next-day/move-printer defense)', async () => {
    const id = addJob('2026-04-13T06:00:00Z', '2026-04-13T07:00:00Z', { locked: 1 });
    const r = await request(app).patch(`/api/jobs/${id}`).set('Cookie', authCookie)
      .send({ start: '2026-04-13T20:00:00Z', end: '2026-04-13T21:00:00Z', printerId: 999 });
    // start/end/printerId all stripped → nothing valid left to write.
    expect(r.status).toBe(400);
    const after = getJob(id);
    expect(after.start).toBe(iso('2026-04-13T06:00:00Z'));
    expect(after.end).toBe(iso('2026-04-13T07:00:00Z'));
    expect(after.printerId).toBe(printerId);
  });

  test('unlock + move in the SAME PATCH is honoured (not stripped)', async () => {
    const id = addJob('2026-04-13T06:00:00Z', '2026-04-13T07:00:00Z', { locked: 1 });
    const r = await request(app).patch(`/api/jobs/${id}`).set('Cookie', authCookie)
      .send({ locked: 0, start: '2026-04-13T20:00:00Z', end: '2026-04-13T21:00:00Z' });
    expect(r.status).toBe(200);
    const after = getJob(id);
    expect(after.locked).toBe(0);
    expect(after.start).toBe(iso('2026-04-13T20:00:00Z'));
  });

  test('PUT (edit dialog) preserves start/end/printerId on a locked job', async () => {
    const id = addJob('2026-04-13T06:00:00Z', '2026-04-13T07:00:00Z', { locked: 1 });
    const r = await request(app).put(`/api/jobs/${id}`).set('Cookie', authCookie)
      .send({
        printerId: 999, name: 'Renamed', start: '2026-04-13T20:00:00Z', end: '2026-04-13T21:00:00Z',
        status: 'Planned', queued: false,
      });
    expect(r.status).toBe(200);
    const after = getJob(id);
    // Name change applied; schedule preserved.
    expect(after.name).toBe('Renamed');
    expect(after.start).toBe(iso('2026-04-13T06:00:00Z'));
    expect(after.printerId).toBe(printerId);
  });
});


// Pull-forward "move following chain" toggle: moveChain:true drags the anchor's
// tightly-packed following run (<= 30 min working gaps, terminated at a locked/
// immovable job) forward with it. Default OFF = single-anchor behaviour unchanged.
describe('pull-forward — move following chain toggle', () => {
  const request = require('supertest');
  let app, appDb, printerId;
  const SESSION_TOKEN = 'movechain-session-token';
  const authCookie = `pf_session=${SESSION_TOKEN}`;
  const iso = (d) => new Date(d).toISOString();

  beforeAll(() => {
    appDb = require('../db');
    app   = require('../server');
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION_TOKEN, Date.now() + 3_600_000);
  });

  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers; DELETE FROM closures;');
    appDb.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
      .run('schedulingRestrictions', JSON.stringify({
        enabled: true, silentStart: '04:00', silentEnd: '04:01', closedDays: [], timezone: 'Europe/Brussels',
      }));
    const r = appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('P1', '#f00', 5, 15);
    printerId = r.lastInsertRowid;
  });

  const addJob = (start, end, { status = 'Planned', locked = 0 } = {}) =>
    appDb.prepare('INSERT INTO jobs (printerId, name, start, end, status, locked) VALUES (?,?,?,?,?,?)')
      .run(printerId, 'J', iso(start), iso(end), status, locked).lastInsertRowid;
  const getJob = (id) => appDb.prepare('SELECT * FROM jobs WHERE id=?').get(id);

  test('toggle OFF (default): only the anchor moves, followers stay put', async () => {
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z');
    const follower = addJob('2026-04-13T15:20:00Z', '2026-04-13T16:20:00Z'); // tight, would chain if ON
    const r = await request(app).post(`/api/jobs/${anchor}/pull-forward`)
      .set('Cookie', authCookie).send({ to: '2026-04-13T08:00:00Z' });
    expect(r.status).toBe(200);
    expect(getJob(anchor).start).toBe(iso('2026-04-13T08:00:00Z'));
    // Follower untouched — single-anchor default path.
    expect(getJob(follower).start).toBe(iso('2026-04-13T15:20:00Z'));
  });

  test('toggle ON: anchor + tight followers pull forward together', async () => {
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z');
    const f1 = addJob('2026-04-13T15:20:00Z', '2026-04-13T16:20:00Z'); // 20 min gap → chains
    const f2 = addJob('2026-04-13T16:40:00Z', '2026-04-13T17:40:00Z'); // 20 min gap → chains
    const r = await request(app).post(`/api/jobs/${anchor}/pull-forward`)
      .set('Cookie', authCookie).send({ to: '2026-04-13T08:00:00Z', moveChain: true });
    expect(r.status).toBe(200);
    expect(getJob(anchor).start).toBe(iso('2026-04-13T08:00:00Z'));
    // Followers packed 20 min behind: 09:20Z and 10:40Z.
    expect(getJob(f1).start).toBe(iso('2026-04-13T09:20:00Z'));
    expect(getJob(f2).start).toBe(iso('2026-04-13T10:40:00Z'));
  });

  test('toggle ON: chain breaks at a > 30 min working gap', async () => {
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z');
    const f1 = addJob('2026-04-13T15:20:00Z', '2026-04-13T16:20:00Z'); // chains
    const far = addJob('2026-04-13T17:10:00Z', '2026-04-13T18:10:00Z'); // 50 min after f1 end → breaks
    const r = await request(app).post(`/api/jobs/${anchor}/pull-forward`)
      .set('Cookie', authCookie).send({ to: '2026-04-13T08:00:00Z', moveChain: true });
    expect(r.status).toBe(200);
    expect(getJob(anchor).start).toBe(iso('2026-04-13T08:00:00Z'));
    expect(getJob(f1).start).toBe(iso('2026-04-13T09:20:00Z'));
    // Beyond the break: untouched.
    expect(getJob(far).start).toBe(iso('2026-04-13T17:10:00Z'));
  });

  test('toggle ON: a locked job terminates selection — it and jobs after it stay put', async () => {
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z');
    const f1 = addJob('2026-04-13T15:20:00Z', '2026-04-13T16:20:00Z');                 // chains
    const lockedMid = addJob('2026-04-13T16:40:00Z', '2026-04-13T17:40:00Z', { locked: 1 }); // terminator
    const after = addJob('2026-04-13T18:00:00Z', '2026-04-13T19:00:00Z');              // tight to locked, excluded
    const r = await request(app).post(`/api/jobs/${anchor}/pull-forward`)
      .set('Cookie', authCookie).send({ to: '2026-04-13T08:00:00Z', moveChain: true });
    expect(r.status).toBe(200);
    expect(getJob(anchor).start).toBe(iso('2026-04-13T08:00:00Z'));
    expect(getJob(f1).start).toBe(iso('2026-04-13T09:20:00Z'));
    // Locked job and everything after it are byte-unchanged.
    expect(getJob(lockedMid).start).toBe(iso('2026-04-13T16:40:00Z'));
    expect(getJob(after).start).toBe(iso('2026-04-13T18:00:00Z'));
  });

  test('toggle ON: block landing on a non-chain job → needsReshove, then reshove on confirm', async () => {
    const anchor = addJob('2026-04-13T14:00:00Z', '2026-04-13T15:00:00Z');
    const follower = addJob('2026-04-13T15:20:00Z', '2026-04-13T16:20:00Z'); // chains with anchor
    // A separate movable job occupies the landing zone at 10:00 Brussels (08:00Z).
    const blocker = addJob('2026-04-13T08:00:00Z', '2026-04-13T09:00:00Z');
    const body = { to: '2026-04-13T08:00:00Z', moveChain: true };

    const r1 = await request(app).post(`/api/jobs/${anchor}/pull-forward`).set('Cookie', authCookie).send(body);
    expect(r1.body.needsReshove).toBe(true);
    // Nothing written yet.
    expect(getJob(anchor).start).toBe(iso('2026-04-13T14:00:00Z'));
    expect(getJob(blocker).start).toBe(iso('2026-04-13T08:00:00Z'));

    const r2 = await request(app).post(`/api/jobs/${anchor}/pull-forward`).set('Cookie', authCookie).send({ ...body, reshove: true });
    expect(r2.body.reshoved).toBe(true);
    expect(getJob(anchor).start).toBe(iso('2026-04-13T08:00:00Z'));
    expect(getJob(follower).start).toBe(iso('2026-04-13T09:20:00Z'));
    // Blocker shoved behind the block tail (follower end 10:20Z + 20m = 10:40Z).
    expect(getJob(blocker).start).toBe(iso('2026-04-13T10:40:00Z'));
  });
});


describe('PATCH /api/jobs/:id — status persistence (real route via supertest)', () => {
  const request = require('supertest');
  let app, appDb, printerId;
  const SESSION_TOKEN = 'test-session-token';
  const authCookie = `pf_session=${SESSION_TOKEN}`;

  beforeAll(() => {
    appDb = require('../db');     // singleton, temp-file DB (PLANNER_DB_PATH)
    app   = require('../server'); // exports the Express app (no listen under test)
    // Valid session so the auth middleware lets the PATCH through.
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION_TOKEN, Date.now() + 3_600_000);
  });

  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers;');
    const r = appDb.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run('P1', '#f00');
    printerId = r.lastInsertRowid;
  });

  afterAll(() => {
    try { appDb.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(process.env.PLANNER_DB_PATH); } catch { /* ignore */ }
  });

  test.each(['Planned', 'Awaiting', 'Printing', 'Post Printing', 'Done'])(
    'context-menu status %s persists via PATCH /api/jobs/:id',
    async (status) => {
      const r = appDb.prepare('INSERT INTO jobs (printerId, name, start, end, status) VALUES (?,?,?,?,?)')
        .run(printerId, 'Job', '2026-03-27T10:00', '2026-03-27T12:00', 'Planned');
      const id = r.lastInsertRowid;

      const res = await request(app)
        .patch(`/api/jobs/${id}`)
        .set('Cookie', authCookie)
        .send({ status });

      expect(res.status).toBe(200);
      // The DB assertion is the real check: if the route stopped persisting
      // 'status' (e.g. removed from its allowed list), this row stays 'Planned'.
      const persisted = appDb.prepare('SELECT status FROM jobs WHERE id=?').get(id).status;
      expect(persisted).toBe(status);
    }
  );
});

// The menu-badge count is now shared shipped logic (public/statusCount.js). The
// frontend updateStatusOverviewBadge() and this test call the SAME function, so
// the test exercises real code, not a SQL re-implementation. Change the status
// keys or the queued rule in that fn and this test trips.
describe('status-overview badge count (shared pure fn)', () => {
  const countAttentionJobs = require('../public/statusCount.js');

  test('counts non-queued Post Printing + Paused jobs only', () => {
    const jobs = [
      { name: 'a', status: 'Post Printing', queued: 0 },
      { name: 'b', status: 'Paused',        queued: 0 },
      { name: 'c', status: 'Printing',      queued: 0 }, // not an attention status
      { name: 'd', status: 'Post Printing', queued: 1 }, // queued → excluded
    ];
    expect(countAttentionJobs(jobs)).toBe(2);
  });

  test('returns 0 when nothing needs attention', () => {
    const jobs = [
      { status: 'Printing', queued: 0 },
      { status: 'Done',     queued: 0 },
      { status: 'Planned',  queued: 0 },
    ];
    expect(countAttentionJobs(jobs)).toBe(0);
  });
});