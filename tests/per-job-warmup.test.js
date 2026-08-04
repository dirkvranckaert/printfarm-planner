// Per-job warm-up snapshot (mirror of per-job-cooldown.test.js).
//
// Two things are proven here:
//   1. scheduling.js reads each job's own `warmUpMs` (falling back to the scalar
//      argument when absent), so an override on one job only moves that job's
//      leading gap.
//   2. The db.js backfill migration is byte-identical: after backfilling every
//      existing job with its printer's current warm_up_mins, a schedule computed
//      from the per-job field equals the schedule the old code computed from the
//      live printer field. And it is idempotent + printer-change-proof.

const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const scheduling = require('../scheduling');
const { findNextValidStart, pushBackChain } = scheduling;

const RESTR = { enabled: false, timezone: 'UTC' };
const iso = (s) => new Date(s).toISOString();
const MIN = 60000;

describe('scheduling reads per-job warm-up', () => {
  test('findNextValidStart uses an existing job\'s own warmUpMs leading buffer', () => {
    const scalarWarmMs = 5 * MIN;   // candidate/fallback default
    const coolMs = 15 * MIN;
    // Existing job 12:00–13:00 with a big 30-min warm-up → its blocked zone
    // starts at 11:30. A 20-min candidate at 11:20 ends at 11:40, landing inside
    // that warm-up buffer → must be pushed past the job (13:00 + 15 cool + 5 warm).
    const existing = [{
      start: '2026-04-13T12:00:00.000Z',
      end:   '2026-04-13T13:00:00.000Z',
      warmUpMs: 30 * MIN,
      coolDownMs: coolMs,
    }];
    const start = findNextValidStart(
      new Date('2026-04-13T11:20:00.000Z'), 20, RESTR, [], existing, scalarWarmMs, coolMs
    );
    expect(start.toISOString()).toBe('2026-04-13T13:20:00.000Z');
  });

  test('with only the default 5-min warm-up the same candidate fits before the job', () => {
    const scalarWarmMs = 5 * MIN;
    const coolMs = 15 * MIN;
    // No per-job warmUpMs → 5-min scalar → blocked zone starts 11:55, candidate
    // ends 11:40, no overlap → candidate stays put at 11:20.
    const existing = [{
      start: '2026-04-13T12:00:00.000Z',
      end:   '2026-04-13T13:00:00.000Z',
      coolDownMs: coolMs,
    }];
    const start = findNextValidStart(
      new Date('2026-04-13T11:20:00.000Z'), 20, RESTR, [], existing, scalarWarmMs, coolMs
    );
    expect(start.toISOString()).toBe('2026-04-13T11:20:00.000Z');
  });

  test('pushBackChain gaps a chained job by ITS OWN warm-up', () => {
    const scalarWarmMs = 5 * MIN;
    const coolMs = 15 * MIN;
    const chain = [
      { id: 1, start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z', coolDownMs: coolMs },
      { id: 2, start: '2026-04-13T09:20:00.000Z', end: '2026-04-13T10:20:00.000Z', coolDownMs: coolMs, warmUpMs: 60 * MIN },
    ];
    const updates = pushBackChain(chain, new Date('2026-04-13T12:00:00.000Z'), RESTR, [], [], scalarWarmMs, coolMs);
    expect(updates).toHaveLength(2);
    // Job 1 anchored at 12:00–13:00.
    expect(updates[0]).toMatchObject({ id: 1, start: iso('2026-04-13T12:00:00Z'), end: iso('2026-04-13T13:00:00Z') });
    // Job 2 gap = job1 cool 15 + job2's OWN warm 60 → 13:00 + 75 = 14:15.
    expect(updates[1]).toMatchObject({ id: 2, start: iso('2026-04-13T14:15:00Z'), end: iso('2026-04-13T15:15:00Z') });
  });

  test('an override moves only its own leading gap (falls back to scalar otherwise)', () => {
    const coolMs = 15 * MIN;
    // Job 2 keeps the default 5-min warm → gap = 15 + 5 → 13:20 (proves the
    // per-job value, not a scalar sentinel, is what moved it in the test above).
    const chain = [
      { id: 1, start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z', coolDownMs: coolMs },
      { id: 2, start: '2026-04-13T09:20:00.000Z', end: '2026-04-13T10:20:00.000Z', coolDownMs: coolMs },
    ];
    const updates = pushBackChain(chain, new Date('2026-04-13T12:00:00.000Z'), RESTR, [], [], 5 * MIN, coolMs);
    expect(updates[1]).toMatchObject({ id: 2, start: iso('2026-04-13T13:20:00Z') });
  });
});

// ---------------------------------------------------------------------------
// Migration: byte-identical backfill on a real db.js upgrade, driving the REAL
// scheduler. OLD code fed every job the live printer warm-up (a scalar); NEW
// code feeds each job its own snapshotted warm_up_mins. After the backfill the
// two must produce the identical schedule.
// ---------------------------------------------------------------------------

// mode 'old': jobs carry NO warmUpMs → the printer's live scalar applies to all.
// mode 'new': each job carries its own warm_up_mins; a deliberately-wrong
//             sentinel warm scalar is passed, so any accidental fallback corrupts
//             the result and fails the test. Cool-down is constant via scalar.
function runChain(rows, printerWarmMins, printerCoolMins, mode) {
  const sorted = [...rows].sort((a, b) => new Date(a.start) - new Date(b.start));
  const chain = sorted.map(j => mode === 'new'
    ? { id: j.id, start: j.start, end: j.end, warmUpMs: j.warm_up_mins * MIN }
    : { id: j.id, start: j.start, end: j.end });
  const to = new Date(new Date(sorted[0].start).getTime() + 60 * MIN);
  const warmScalar = (mode === 'new' ? 999 : printerWarmMins) * MIN;
  return pushBackChain(chain, to, RESTR, [], [], warmScalar, printerCoolMins * MIN);
}

describe('db.js warm_up_mins backfill migration', () => {
  const dbPath = path.join(os.tmpdir(), `printfarm-warmup-mig-${process.pid}.db`);
  let db;

  beforeAll(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    // Pre-create the OLD schema (jobs WITHOUT warm_up_mins), as a live
    // pre-migration prod DB would look.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE printers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        warm_up_mins INTEGER NOT NULL DEFAULT 5,
        cool_down_mins INTEGER NOT NULL DEFAULT 15
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printerId INTEGER NOT NULL,
        name TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        status TEXT DEFAULT 'Planned'
      );
    `);
    // Two printers with DIFFERENT warm-ups (constant cool-down), proving the
    // backfill reads each job's own printer.
    seed.prepare('INSERT INTO printers (id, name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?,?)')
      .run(1, 'P1', '#111', 5, 15);
    seed.prepare('INSERT INTO printers (id, name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?,?)')
      .run(2, 'P2', '#222', 20, 15);
    const insJob = seed.prepare('INSERT INTO jobs (id, printerId, name, start, end, status) VALUES (?,?,?,?,?,?)');
    // Printer 1, tight gaps so the recompute moves them.
    insJob.run(1, 1, 'A', '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z', 'Done');
    insJob.run(2, 1, 'B', '2026-04-13T09:05:00.000Z', '2026-04-13T10:05:00.000Z', 'Printing');
    insJob.run(3, 1, 'C', '2026-04-13T10:10:00.000Z', '2026-04-13T11:10:00.000Z', 'Planned');
    // Printer 2 (bigger warm-up).
    insJob.run(4, 2, 'D', '2026-04-14T08:00:00.000Z', '2026-04-14T09:30:00.000Z', 'Planned');
    insJob.run(5, 2, 'E', '2026-04-14T09:40:00.000Z', '2026-04-14T10:40:00.000Z', 'Planned');
    // Orphan job: printer no longer exists → backfill COALESCEs to the 5-min
    // default, the same fallback the old live-lookup scheduling used.
    insJob.run(6, 99, 'F', '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z', 'Planned');
    insJob.run(7, 99, 'G', '2026-04-15T09:05:00.000Z', '2026-04-15T10:05:00.000Z', 'Planned');
    seed.close();

    // Boot db.js against that file → its startup migrations add + backfill.
    process.env.PLANNER_DB_PATH = dbPath;
    db = require('../db');
  });

  afterAll(() => {
    try { db && db.close(); } catch { /* noop */ }
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('every job is backfilled with its printer\'s current warm_up_mins (orphan → 5)', () => {
    const rows = db.prepare('SELECT id, printerId, warm_up_mins FROM jobs ORDER BY id').all();
    const printerWarm = { 1: 5, 2: 20, 99: 5 };
    for (const r of rows) {
      expect(r.warm_up_mins).toBe(printerWarm[r.printerId]);
    }
  });

  test('the recomputed schedule is byte-identical across the migration (real scheduler)', () => {
    const printers = db.prepare('SELECT * FROM printers').all().reduce((m, p) => (m[p.id] = p, m), {});
    for (const pid of [1, 2]) {
      const jobs = db.prepare('SELECT * FROM jobs WHERE printerId=? ORDER BY start').all(pid);
      const p = printers[pid];
      const before = runChain(jobs, p.warm_up_mins, p.cool_down_mins, 'old'); // live printer scalar
      const after = runChain(jobs, p.warm_up_mins, p.cool_down_mins, 'new');  // per-job snapshot
      expect(after).toEqual(before);
      expect(after.length).toBeGreaterThan(0); // jobs actually moved — not vacuous
    }
  });

  test('orphan (deleted-printer) jobs schedule identically old-vs-new (both use 5)', () => {
    const jobs = db.prepare('SELECT * FROM jobs WHERE printerId=99 ORDER BY start').all();
    expect(jobs.every(j => j.warm_up_mins === 5)).toBe(true);
    const before = runChain(jobs, 5, 15, 'old');
    const after = runChain(jobs, 5, 15, 'new');
    expect(after).toEqual(before);
    expect(after.length).toBeGreaterThan(0);
  });

  test('changing a printer\'s warm_up_mins after migration does NOT move existing jobs', () => {
    const jobs = db.prepare('SELECT * FROM jobs WHERE printerId=2 ORDER BY start').all();
    const before = runChain(jobs, 20, 15, 'new');
    // Owner bumps printer 2's warm-up 20 → 45 later on.
    db.prepare('UPDATE printers SET warm_up_mins=45 WHERE id=2').run();
    const jobsAfter = db.prepare('SELECT * FROM jobs WHERE printerId=2 ORDER BY start').all();
    const after = runChain(jobsAfter, 45, 15, 'new'); // per-job fields untouched → frozen
    expect(after).toEqual(before);
  });

  test('the backfill is idempotent — re-running touches no rows', () => {
    const info = db.prepare(`UPDATE jobs SET warm_up_mins =
      COALESCE((SELECT p.warm_up_mins FROM printers p WHERE p.id = jobs.printerId), 5)
      WHERE warm_up_mins IS NULL`).run();
    expect(info.changes).toBe(0);
    const cols = db.pragma('table_info(jobs)');
    expect(cols.filter(c => c.name === 'warm_up_mins')).toHaveLength(1);
  });
});
