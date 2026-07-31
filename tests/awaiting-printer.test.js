// Tests for the "Link when printer starts" pending-link feature.
//
//   1. awaiting-printer module — start-time window guard + assignPending
//      invariants (one-pending-per-printer, window enforcement).
//   2. Auto-link on the RUNNING transition — modelled against the SAME shipped
//      guard (awaitingPrinter.isWithinStartWindow) the server.js SSE handler
//      uses to decide whether to flip a pending job to 'Printing'. The MQTT/SSE
//      path itself needs a live broker, so the flip is reproduced here with the
//      real guard.
//   3. Entry via the REAL Express PATCH /api/jobs/:id route (supertest): window
//      rejection (400) and the one-pending-per-printer invariant (409).

const os   = require('os');
const fs   = require('fs');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.PLANNER_DB_PATH =
  process.env.PLANNER_DB_PATH || path.join(os.tmpdir(), `printfarm-awaiting-${process.pid}.db`);

const Database = require('better-sqlite3');
const awaitingPrinter = require('../awaiting-printer');

const { STATUS, WINDOW_MS, isWithinStartWindow, assignPending } = awaitingPrinter;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printerId INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'Planned',
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      linked_printer_id INTEGER
    );
  `);
  return db;
}

function addPrinter(db, name = 'P1S') {
  const r = db.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run(name, '#fff');
  return r.lastInsertRowid;
}

function addJob(db, printerId, { status = 'Planned', start, end = start, linked_printer_id = null } = {}) {
  const r = db.prepare(
    'INSERT INTO jobs (printerId, name, status, start, end, linked_printer_id) VALUES (?,?,?,?,?,?)'
  ).run(printerId, 'Job', status, start, end, linked_printer_id);
  return r.lastInsertRowid;
}

const getJob = (db, id) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
const iso = ms => new Date(ms).toISOString();

describe('awaitingPrinter.isWithinStartWindow', () => {
  const now = new Date('2026-07-29T12:00:00Z');

  test('start 1h in the past (interior) is eligible', () => {
    expect(isWithinStartWindow(iso(now.getTime() - 60 * 60 * 1000), now)).toBe(true);
  });

  test('start exactly now is eligible', () => {
    expect(isWithinStartWindow(iso(now.getTime()), now)).toBe(true);
  });

  test('start 59 min in the future (interior) is eligible', () => {
    expect(isWithinStartWindow(iso(now.getTime() + 59 * 60 * 1000), now)).toBe(true);
  });

  test('start exactly WINDOW_MS in the future is eligible (inclusive)', () => {
    expect(isWithinStartWindow(iso(now.getTime() + WINDOW_MS), now)).toBe(true);
  });

  test('start just beyond WINDOW_MS in the future is rejected', () => {
    expect(isWithinStartWindow(iso(now.getTime() + WINDOW_MS + 60 * 1000), now)).toBe(false);
  });

  test('start exactly WINDOW_MS in the past is eligible (inclusive)', () => {
    expect(isWithinStartWindow(iso(now.getTime() - WINDOW_MS), now)).toBe(true);
  });

  test('start just beyond WINDOW_MS in the past is rejected', () => {
    expect(isWithinStartWindow(iso(now.getTime() - WINDOW_MS - 60 * 1000), now)).toBe(false);
  });

  test('empty start is rejected', () => {
    expect(isWithinStartWindow('', now)).toBe(false);
  });

  test('invalid start is rejected', () => {
    expect(isWithinStartWindow('not-a-date', now)).toBe(false);
  });
});

describe('awaitingPrinter.assignPending', () => {
  let db, printerId, now;
  beforeEach(() => {
    db = makeDb();
    printerId = addPrinter(db);
    now = new Date('2026-07-29T12:00:00Z');
  });

  test('sets status + linked_printer_id for an in-window job', () => {
    const id = addJob(db, printerId, { start: iso(now.getTime() + 30 * 60 * 1000) });
    const res = assignPending({ db, jobId: id, printerId, now });
    expect(res.ok).toBe(true);
    const job = getJob(db, id);
    expect(job.status).toBe(STATUS);
    expect(job.linked_printer_id).toBe(printerId);
  });

  test('rejects a job scheduled beyond the window ahead (window guard)', () => {
    const id = addJob(db, printerId, { start: iso(now.getTime() + 25 * 60 * 60 * 1000) });
    const res = assignPending({ db, jobId: id, printerId, now });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(400);
    expect(getJob(db, id).status).toBe('Planned');
    expect(getJob(db, id).linked_printer_id).toBeNull();
  });

  test('rejects a second pending job for the same printer (one-per-printer)', () => {
    const a = addJob(db, printerId, { start: iso(now.getTime()) });
    const b = addJob(db, printerId, { start: iso(now.getTime()) });
    expect(assignPending({ db, jobId: a, printerId, now }).ok).toBe(true);
    const res = assignPending({ db, jobId: b, printerId, now });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(409);
    expect(getJob(db, b).status).toBe('Planned');
  });

  test('allows a pending job on a different printer', () => {
    const other = addPrinter(db, 'P2');
    const a = addJob(db, printerId, { start: iso(now.getTime()) });
    const b = addJob(db, other, { start: iso(now.getTime()) });
    expect(assignPending({ db, jobId: a, printerId, now }).ok).toBe(true);
    expect(assignPending({ db, jobId: b, printerId: other, now }).ok).toBe(true);
  });

  test('returns 404 for an unknown job', () => {
    const res = assignPending({ db, jobId: 9999, printerId, now });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(404);
  });
});

// Reproduces the server.js SSE branch: on a printer's RUNNING transition, a
// linked non-Printing job is flipped to 'Printing' UNLESS it is an out-of-window
// 'Awaiting Printer' job, in which case it is left pending. Uses the shipped
// guard so this stays in lockstep with the real handler.
function simulateRunningTransition(db, printerId, now) {
  const linked = db.prepare("SELECT * FROM jobs WHERE linked_printer_id=? AND status != 'Done'").all(printerId);
  for (const job of linked) {
    if (job.status !== 'Printing') {
      if (job.status === STATUS && !isWithinStartWindow(job.start, now)) continue;
      db.prepare("UPDATE jobs SET status='Printing' WHERE id=?").run(job.id);
    }
  }
}

describe('auto-link on RUNNING transition (shipped guard)', () => {
  let db, printerId, now;
  beforeEach(() => {
    db = makeDb();
    printerId = addPrinter(db);
    now = new Date('2026-07-29T12:00:00Z');
  });

  test('in-window pending job flips to Printing when the printer starts', () => {
    const id = addJob(db, printerId, { status: STATUS, start: iso(now.getTime() + 20 * 60 * 1000), linked_printer_id: printerId });
    simulateRunningTransition(db, printerId, now);
    expect(getJob(db, id).status).toBe('Printing');
  });

  test('past-start pending job flips to Printing when the printer starts', () => {
    const id = addJob(db, printerId, { status: STATUS, start: iso(now.getTime() - 10 * 60 * 1000), linked_printer_id: printerId });
    simulateRunningTransition(db, printerId, now);
    expect(getJob(db, id).status).toBe('Printing');
  });

  test('far-ahead pending job is NOT swept up when the printer starts', () => {
    // start became far-future relative to the actual moment the printer started
    const id = addJob(db, printerId, { status: STATUS, start: iso(now.getTime() + 25 * 60 * 60 * 1000), linked_printer_id: printerId });
    simulateRunningTransition(db, printerId, now);
    expect(getJob(db, id).status).toBe(STATUS);
  });

  test('stale pending job (>24h in the past) is NOT swept up when the printer starts', () => {
    // start fell outside the now-WINDOW_MS lower bound by the time the printer started
    const id = addJob(db, printerId, { status: STATUS, start: iso(now.getTime() - 25 * 60 * 60 * 1000), linked_printer_id: printerId });
    simulateRunningTransition(db, printerId, now);
    expect(getJob(db, id).status).toBe(STATUS);
  });
});

describe('PATCH /api/jobs/:id — "Link when printer starts" entry (real route)', () => {
  const request = require('supertest');
  let app, appDb, printerId;
  const SESSION_TOKEN = 'awaiting-test-token';
  const authCookie = `pf_session=${SESSION_TOKEN}`;

  beforeAll(() => {
    appDb = require('../db');
    app   = require('../server');
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION_TOKEN, Date.now() + 3_600_000);
  });

  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers;');
    printerId = appDb.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run('P1', '#f00').lastInsertRowid;
  });

  afterAll(() => {
    try { appDb.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(process.env.PLANNER_DB_PATH); } catch { /* ignore */ }
  });

  function insertJob(startMs) {
    return appDb.prepare('INSERT INTO jobs (printerId, name, start, end, status) VALUES (?,?,?,?,?)')
      .run(printerId, 'Job', iso(startMs), iso(startMs + 3_600_000), 'Planned').lastInsertRowid;
  }

  test('in-window job enters Awaiting Printer and links to its printer', async () => {
    const id = insertJob(Date.now() + 15 * 60 * 1000);
    const res = await request(app).patch(`/api/jobs/${id}`).set('Cookie', authCookie)
      .send({ status: STATUS, linked_printer_id: printerId });
    expect(res.status).toBe(200);
    const job = appDb.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    expect(job.status).toBe(STATUS);
    expect(job.linked_printer_id).toBe(printerId);
  });

  test('job scheduled beyond the window ahead is rejected (400) and left unchanged', async () => {
    const id = insertJob(Date.now() + 25 * 60 * 60 * 1000);
    const res = await request(app).patch(`/api/jobs/${id}`).set('Cookie', authCookie)
      .send({ status: STATUS, linked_printer_id: printerId });
    expect(res.status).toBe(400);
    expect(appDb.prepare('SELECT status FROM jobs WHERE id=?').get(id).status).toBe('Planned');
  });

  test('second pending job for the same printer is rejected (409)', async () => {
    const a = insertJob(Date.now());
    const b = insertJob(Date.now());
    const r1 = await request(app).patch(`/api/jobs/${a}`).set('Cookie', authCookie)
      .send({ status: STATUS, linked_printer_id: printerId });
    expect(r1.status).toBe(200);
    const r2 = await request(app).patch(`/api/jobs/${b}`).set('Cookie', authCookie)
      .send({ status: STATUS, linked_printer_id: printerId });
    expect(r2.status).toBe(409);
    expect(appDb.prepare('SELECT status FROM jobs WHERE id=?').get(b).status).toBe('Planned');
  });
});
