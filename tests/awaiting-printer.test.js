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
const linkTransition = require('../link-transition');

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
      linked_printer_id INTEGER,
      paused_at TEXT,
      paused_remaining_ms INTEGER
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

// Drive the ACTUAL production transition appliers (link-transition.js) that the
// server.js SSE stage-transition handler calls — NOT a hand-copied mirror. So a
// guard reverted in the real module fails these tests. The MQTT/SSE plumbing and
// push/realign side-effects stay in server.js; the eligibility + status flips
// under test are exactly the production code path.
const runRunning = (db, printerId, now) =>
  linkTransition.applyRunningTransition({ db, printerId, now });
const runPause = (db, printerId, now) =>
  linkTransition.applyPauseTransition({ db, printerId, now });

describe('auto-link on RUNNING transition (production applier)', () => {
  let db, printerId, now;
  beforeEach(() => {
    db = makeDb();
    printerId = addPrinter(db);
    now = new Date('2026-07-29T12:00:00Z');
  });

  test('in-window pending job flips to Printing when the printer starts', () => {
    const id = addJob(db, printerId, { status: STATUS, start: iso(now.getTime() + 20 * 60 * 1000), linked_printer_id: printerId });
    runRunning(db, printerId, now);
    expect(getJob(db, id).status).toBe('Printing');
  });

  test('past-start pending job flips to Printing when the printer starts', () => {
    const id = addJob(db, printerId, { status: STATUS, start: iso(now.getTime() - 10 * 60 * 1000), linked_printer_id: printerId });
    runRunning(db, printerId, now);
    expect(getJob(db, id).status).toBe('Printing');
  });

  test('far-ahead pending job is NOT swept up when the printer starts', () => {
    // start became far-future relative to the actual moment the printer started
    const id = addJob(db, printerId, { status: STATUS, start: iso(now.getTime() + 25 * 60 * 60 * 1000), linked_printer_id: printerId });
    runRunning(db, printerId, now);
    expect(getJob(db, id).status).toBe(STATUS);
  });

  test('stale pending job (>24h in the past) is NOT swept up when the printer starts', () => {
    // start fell outside the now-WINDOW_MS lower bound by the time the printer started
    const id = addJob(db, printerId, { status: STATUS, start: iso(now.getTime() - 25 * 60 * 60 * 1000), linked_printer_id: printerId });
    runRunning(db, printerId, now);
    expect(getJob(db, id).status).toBe(STATUS);
  });

  // Regression: a job left in 'Post Printing' with a STALE linked_printer_id
  // (e.g. finished manually, which does not clear the link) must never be
  // re-grabbed and overwritten to 'Printing' when the printer's NEXT print
  // starts. FAILS if link-transition.eligibleToStart is reverted to admit a
  // non-pending/non-paused job.
  test('finished Post Printing job with a stale link is NOT re-grabbed when the printer restarts', () => {
    const stale = addJob(db, printerId, {
      status: 'Post Printing',
      start: iso(now.getTime() - 60 * 60 * 1000),
      linked_printer_id: printerId,
    });
    runRunning(db, printerId, now);
    expect(getJob(db, stale).status).toBe('Post Printing');
  });

  test('printer starting its next print links the NEW job, never the previous Post Printing one', () => {
    // Job A: printed, then finished manually -> 'Post Printing' but link left intact.
    const a = addJob(db, printerId, {
      status: STATUS,
      start: iso(now.getTime() - 30 * 60 * 1000),
      linked_printer_id: printerId,
    });
    runRunning(db, printerId, now);                      // A starts -> Printing
    expect(getJob(db, a).status).toBe('Printing');
    // Manual finish path leaves linked_printer_id set (the bug's precondition).
    db.prepare("UPDATE jobs SET status='Post Printing' WHERE id=?").run(a);

    // Job B: the new print, pre-linked to the same printer.
    const b = addJob(db, printerId, {
      status: STATUS,
      start: iso(now.getTime() + 5 * 60 * 1000),
      linked_printer_id: printerId,
    });
    runRunning(db, printerId, now);                       // next print starts

    expect(getJob(db, b).status).toBe('Printing');        // new job linked
    expect(getJob(db, a).status).toBe('Post Printing');   // old job untouched
  });
});

describe('PAUSE / resume transition (production applier)', () => {
  let db, printerId, now;
  beforeEach(() => {
    db = makeDb();
    printerId = addPrinter(db);
    now = new Date('2026-07-29T12:00:00Z');
  });

  // A genuinely-printing job pauses, then resumes cleanly on the next RUNNING.
  test('a Printing job pauses on PAUSE and resumes to Printing on RUNNING', () => {
    const id = addJob(db, printerId, {
      status: 'Printing',
      start: iso(now.getTime() - 10 * 60 * 1000),
      end: iso(now.getTime() + 20 * 60 * 1000),
      linked_printer_id: printerId,
    });
    runPause(db, printerId, now);
    expect(getJob(db, id).status).toBe('Paused');
    expect(getJob(db, id).paused_at).not.toBeNull();
    runRunning(db, printerId, now);
    expect(getJob(db, id).status).toBe('Printing');
    expect(getJob(db, id).paused_at).toBeNull();
  });

  // CRITICAL regression (Codex round 1, server.js PAUSE route): a stale
  // 'Post Printing' job A with an intact link must NOT be paused on the PAUSE
  // edge — otherwise the PAUSE->RUNNING resume re-admits it to 'Printing'. The
  // genuinely-printing new job B must pause+resume normally. FAILS if
  // link-transition.eligibleToPause is reverted to pause any linked job.
  test('stale-A / printing-B: printer RUNNING->PAUSE->RUNNING leaves A Post Printing, B pauses+resumes', () => {
    const a = addJob(db, printerId, {
      status: 'Post Printing',
      start: iso(now.getTime() - 60 * 60 * 1000),
      end: iso(now.getTime() - 30 * 60 * 1000),
      linked_printer_id: printerId,          // stale link left intact
    });
    const b = addJob(db, printerId, {
      status: 'Printing',
      start: iso(now.getTime() - 5 * 60 * 1000),
      end: iso(now.getTime() + 25 * 60 * 1000),
      linked_printer_id: printerId,
    });

    runPause(db, printerId, now);            // RUNNING -> PAUSE
    expect(getJob(db, a).status).toBe('Post Printing');   // A untouched
    expect(getJob(db, b).status).toBe('Paused');          // only B paused

    runRunning(db, printerId, now);          // PAUSE -> RUNNING
    expect(getJob(db, a).status).toBe('Post Printing');   // A still untouched
    expect(getJob(db, b).status).toBe('Printing');        // B resumed
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

  // Stale-link clearing via the REAL PUT / PATCH handlers. Each job starts linked
  // (linked_printer_id set) in an ACTIVE status; a status change decides the link's
  // fate. FAILS if the clear at server.js:680 (PUT) / server.js:777 (PATCH) is
  // removed — the pure link-transition tests above stay green even then, so these
  // route tests are the ones that pin the clear to the shipped handler.
  const linkJob = (startMs, status) => {
    const id = insertJob(startMs);
    appDb.prepare('UPDATE jobs SET status=?, linked_printer_id=? WHERE id=?').run(status, printerId, id);
    return id;
  };
  const linkOf = id => appDb.prepare('SELECT linked_printer_id FROM jobs WHERE id=?').get(id).linked_printer_id;

  test('PUT: status change to an INACTIVE status (Post Printing) clears linked_printer_id', async () => {
    const id = linkJob(Date.now(), 'Printing');
    const res = await request(app).put(`/api/jobs/${id}`).set('Cookie', authCookie)
      .send({ printerId, name: 'Job', start: iso(Date.now()), end: iso(Date.now() + 3_600_000), status: 'Post Printing' });
    expect(res.status).toBe(200);
    expect(linkOf(id)).toBeNull();
  });

  test('PUT: status change to an ACTIVE status (Paused) retains linked_printer_id', async () => {
    const id = linkJob(Date.now(), 'Printing');
    const res = await request(app).put(`/api/jobs/${id}`).set('Cookie', authCookie)
      .send({ printerId, name: 'Job', start: iso(Date.now()), end: iso(Date.now() + 3_600_000), status: 'Paused' });
    expect(res.status).toBe(200);
    expect(linkOf(id)).toBe(printerId);
  });

  test('PATCH: status change to an INACTIVE status (Done) clears linked_printer_id', async () => {
    const id = linkJob(Date.now(), 'Printing');
    const res = await request(app).patch(`/api/jobs/${id}`).set('Cookie', authCookie).send({ status: 'Done' });
    expect(res.status).toBe(200);
    expect(linkOf(id)).toBeNull();
  });

  test('PATCH: status change to an ACTIVE status (Printing) retains linked_printer_id', async () => {
    const id = linkJob(Date.now(), 'Paused');
    const res = await request(app).patch(`/api/jobs/${id}`).set('Cookie', authCookie).send({ status: 'Printing' });
    expect(res.status).toBe(200);
    expect(linkOf(id)).toBe(printerId);
  });
});

// The db.js one-time backfill that HEALS pre-existing stale links (rows already
// in a non-active status carrying a linked_printer_id from before the forward-
// clearing fix). A throwaway DB is pre-seeded with stale + active linked rows,
// then db.js is required in isolation so its startup migrations — including the
// backfill — run against that seed. FAILS if the backfill in db.js is removed.
describe('db.js stale linked_printer_id backfill (migration.stale_link_backfill_v1)', () => {
  let tmpPath, savedEnv;

  function seed() {
    tmpPath = path.join(os.tmpdir(), `printfarm-backfill-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const s = new Database(tmpPath);
    // printerId nullable so db.js's NOT-NULL-relax table rebuild does NOT fire.
    s.exec(`
      CREATE TABLE printers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printerId INTEGER,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'Planned',
        start TEXT,
        end TEXT,
        linked_printer_id INTEGER
      );
    `);
    s.prepare('INSERT INTO printers (name,color) VALUES (?,?)').run('P1', '#fff'); // id 1
    const ins = s.prepare('INSERT INTO jobs (printerId,name,status,linked_printer_id) VALUES (?,?,?,?)');
    ins.run(1, 'stale-post', 'Post Printing', 1); // stale -> must be cleared
    ins.run(1, 'stale-done', 'Done', 1);          // stale -> must be cleared
    ins.run(1, 'active-print', 'Printing', 1);    // active -> must be retained
    ins.run(1, 'active-pause', 'Paused', 1);      // active -> must be retained
    s.close();
  }

  const requireDbFresh = () => {
    let fresh;
    jest.isolateModules(() => { fresh = require('../db'); });
    return fresh;
  };

  beforeEach(() => {
    savedEnv = process.env.PLANNER_DB_PATH;
    seed();
    process.env.PLANNER_DB_PATH = tmpPath;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PLANNER_DB_PATH;
    else process.env.PLANNER_DB_PATH = savedEnv;
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  });

  test('nulls links on inactive-status rows, retains them on active-status rows, sets marker', () => {
    const db = requireDbFresh();
    const linkOf = n => db.prepare('SELECT linked_printer_id FROM jobs WHERE name=?').get(n).linked_printer_id;
    expect(linkOf('stale-post')).toBeNull();
    expect(linkOf('stale-done')).toBeNull();
    expect(linkOf('active-print')).toBe(1);
    expect(linkOf('active-pause')).toBe(1);
    expect(db.prepare("SELECT value FROM settings WHERE key='migration.stale_link_backfill_v1'").get()).toBeTruthy();
    db.close();
  });

  test('re-running init on the same DB is a no-op (idempotent, marker guards it)', () => {
    const db1 = requireDbFresh();
    db1.close();
    // Second boot: marker present -> backfill skipped, links unchanged, marker still single.
    const db2 = requireDbFresh();
    expect(db2.prepare('SELECT linked_printer_id FROM jobs WHERE name=?').get('active-print').linked_printer_id).toBe(1);
    expect(db2.prepare('SELECT linked_printer_id FROM jobs WHERE name=?').get('stale-post').linked_printer_id).toBeNull();
    expect(db2.prepare("SELECT COUNT(*) c FROM settings WHERE key='migration.stale_link_backfill_v1'").get().c).toBe(1);
    db2.close();
  });
});
