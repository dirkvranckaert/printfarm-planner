// Per-job cool-down snapshot (Feature B).
//
// Two things are proven here:
//   1. scheduling.js reads each job's own `coolDownMs` (falling back to the
//      scalar argument when absent), so an override on one job only moves that
//      job's downstream gap.
//   2. The db.js backfill migration is byte-identical: after backfilling every
//      existing job with its printer's current cool_down_mins, a schedule
//      computed from the per-job field equals the schedule the old code computed
//      from the live printer field. And it is idempotent + printer-change-proof.

const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const scheduling = require('../scheduling');
const { findNextValidStart, pushBackChain } = scheduling;

// No silent hours / closed days / closures: keep the arithmetic pure.
const RESTR = { enabled: false, timezone: 'UTC' };
const iso = (s) => new Date(s).toISOString();

describe('scheduling reads per-job cool-down', () => {
  test('findNextValidStart uses an existing job\'s own coolDownMs, not the scalar', () => {
    const warmUpMs = 5 * 60000;
    const scalarCoolMs = 15 * 60000; // candidate/fallback default
    const existing = [{
      start: '2026-04-13T10:00:00.000Z',
      end:   '2026-04-13T11:00:00.000Z',
      coolDownMs: 30 * 60000,        // this job's own, snapshotted cool-down
    }];
    // Candidate wants 11:00; existing job's 30-min cool-down + 5-min warm-up
    // pushes it to 11:35 (NOT 11:20, which the 15-min scalar would give).
    const start = findNextValidStart(
      new Date('2026-04-13T11:00:00.000Z'), 60, RESTR, [], existing, warmUpMs, scalarCoolMs
    );
    expect(start.toISOString()).toBe('2026-04-13T11:35:00.000Z');
  });

  test('findNextValidStart falls back to the scalar when a job has no coolDownMs', () => {
    const warmUpMs = 5 * 60000;
    const scalarCoolMs = 15 * 60000;
    const existing = [{
      start: '2026-04-13T10:00:00.000Z',
      end:   '2026-04-13T11:00:00.000Z',
    }];
    const start = findNextValidStart(
      new Date('2026-04-13T11:00:00.000Z'), 60, RESTR, [], existing, warmUpMs, scalarCoolMs
    );
    // 11:00 + 15 (scalar cool) + 5 (warm) = 11:20
    expect(start.toISOString()).toBe('2026-04-13T11:20:00.000Z');
  });

  test('pushBackChain gaps each chained job by the previous job\'s own cool-down', () => {
    const warmUpMs = 5 * 60000;
    const scalarCoolMs = 15 * 60000;
    const chain = [
      { id: 1, start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z', coolDownMs: 60 * 60000 },
      { id: 2, start: '2026-04-13T09:20:00.000Z', end: '2026-04-13T10:20:00.000Z', coolDownMs: 15 * 60000 },
    ];
    const to = new Date('2026-04-13T12:00:00.000Z');
    const updates = pushBackChain(chain, to, RESTR, [], [], warmUpMs, scalarCoolMs);
    expect(updates).toHaveLength(2);
    // Job 1 anchored at 12:00–13:00.
    expect(updates[0]).toMatchObject({ id: 1, start: iso('2026-04-13T12:00:00Z'), end: iso('2026-04-13T13:00:00Z') });
    // Job 2 follows: 13:00 + job1's 60-min cool + 5-min warm = 14:05.
    expect(updates[1]).toMatchObject({ id: 2, start: iso('2026-04-13T14:05:00Z'), end: iso('2026-04-13T15:05:00Z') });
  });

  test('an override moves only its own downstream gap (change-proof against the printer setting)', () => {
    const warmUpMs = 5 * 60000;
    // Same chain as above but job 1 keeps the printer default (15) — the gap
    // shrinks to 13:00 + 15 + 5 = 13:20, proving the per-job value is what moved it.
    const chain = [
      { id: 1, start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z', coolDownMs: 15 * 60000 },
      { id: 2, start: '2026-04-13T09:20:00.000Z', end: '2026-04-13T10:20:00.000Z', coolDownMs: 15 * 60000 },
    ];
    const updates = pushBackChain(chain, new Date('2026-04-13T12:00:00.000Z'), RESTR, [], [], warmUpMs, 999 * 60000);
    expect(updates[1]).toMatchObject({ id: 2, start: iso('2026-04-13T13:20:00Z') });
  });
});

// ---------------------------------------------------------------------------
// Migration: byte-identical backfill on a real db.js upgrade, verified by
// driving the REAL scheduler (pushBackChain → findNextValidStart) rather than a
// bespoke packer. OLD code fed every job the live printer cool-down (a scalar);
// NEW code feeds each job its own snapshotted cool_down_mins. After the backfill
// the two must produce the identical schedule.
// ---------------------------------------------------------------------------

const MIN = 60000;

// Recompute one printer's schedule with the real pushBackChain, pushing the
// anchor back 60 min so every downstream job is genuinely repacked.
//   mode 'old': jobs carry NO coolDownMs → the printer's live scalar applies to all.
//   mode 'new': each job carries its own cool_down_mins; a deliberately-wrong
//               sentinel scalar is passed, so any accidental fallback corrupts
//               the result and fails the test.
function runChain(rows, warmUpMins, printerCoolMins, mode) {
  const sorted = [...rows].sort((a, b) => new Date(a.start) - new Date(b.start));
  const chain = sorted.map(j => mode === 'new'
    ? { id: j.id, start: j.start, end: j.end, coolDownMs: j.cool_down_mins * MIN }
    : { id: j.id, start: j.start, end: j.end });
  const to = new Date(new Date(sorted[0].start).getTime() + 60 * MIN);
  const scalar = (mode === 'new' ? 999 : printerCoolMins) * MIN;
  return pushBackChain(chain, to, RESTR, [], [], warmUpMins * MIN, scalar);
}

describe('db.js cool_down_mins backfill migration', () => {
  const dbPath = path.join(os.tmpdir(), `printfarm-cooldown-mig-${process.pid}.db`);
  let db;

  beforeAll(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    // 1. Pre-create the OLD schema (jobs WITHOUT cool_down_mins) and seed it,
    //    exactly as a live pre-migration prod DB would look.
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
    // Two printers with DIFFERENT cool-downs, to prove the backfill reads each
    // job's own printer rather than a single global value.
    seed.prepare('INSERT INTO printers (id, name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?,?)')
      .run(1, 'P1', '#111', 5, 10);
    seed.prepare('INSERT INTO printers (id, name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?,?)')
      .run(2, 'P2', '#222', 5, 25);
    const insJob = seed.prepare('INSERT INTO jobs (id, printerId, name, start, end, status) VALUES (?,?,?,?,?,?)');
    // Printer 1 (past + ongoing + future), tight gaps so the recompute moves them.
    insJob.run(1, 1, 'A', '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z', 'Done');
    insJob.run(2, 1, 'B', '2026-04-13T09:05:00.000Z', '2026-04-13T10:05:00.000Z', 'Printing');
    insJob.run(3, 1, 'C', '2026-04-13T10:10:00.000Z', '2026-04-13T11:10:00.000Z', 'Planned');
    // Printer 2 (future).
    insJob.run(4, 2, 'D', '2026-04-14T08:00:00.000Z', '2026-04-14T09:30:00.000Z', 'Planned');
    insJob.run(5, 2, 'E', '2026-04-14T09:40:00.000Z', '2026-04-14T10:40:00.000Z', 'Planned');
    // Orphan job: printerId points at a printer that no longer exists. The
    // backfill must COALESCE to the 15-min code default — the same fallback the
    // old live-lookup scheduling used for a missing printer.
    insJob.run(6, 99, 'F', '2026-04-15T08:00:00.000Z', '2026-04-15T09:00:00.000Z', 'Planned');
    insJob.run(7, 99, 'G', '2026-04-15T09:05:00.000Z', '2026-04-15T10:05:00.000Z', 'Planned');
    seed.close();

    // 2. Boot db.js against that file → its startup migrations run, adding and
    //    backfilling cool_down_mins.
    process.env.PLANNER_DB_PATH = dbPath;
    db = require('../db');
  });

  afterAll(() => {
    try { db && db.close(); } catch { /* noop */ }
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('every job is backfilled with its printer\'s current cool_down_mins (orphan → 15)', () => {
    const rows = db.prepare('SELECT id, printerId, cool_down_mins FROM jobs ORDER BY id').all();
    const printerCool = { 1: 10, 2: 25, 99: 15 }; // 99 has no printer → 15 default
    for (const r of rows) {
      expect(r.cool_down_mins).toBe(printerCool[r.printerId]);
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
      expect(after.length).toBeGreaterThan(0); // jobs actually moved — not a vacuous pass
    }
  });

  test('orphan (deleted-printer) jobs schedule identically old-vs-new (both use 15)', () => {
    const jobs = db.prepare('SELECT * FROM jobs WHERE printerId=99 ORDER BY start').all();
    expect(jobs.every(j => j.cool_down_mins === 15)).toBe(true);
    // Orphan → the old live-lookup path fell back to warm 5 / cool 15.
    const before = runChain(jobs, 5, 15, 'old');
    const after = runChain(jobs, 5, 15, 'new');
    expect(after).toEqual(before);
    expect(after.length).toBeGreaterThan(0);
  });

  test('a finishing job\'s downstream gap uses its OWN cool_down_mins even when cross-printer-linked', () => {
    // Physically on printer 1 (cool 10), linked to printer 2 (cool 25), with an
    // explicit snapshot override of 40 — all three distinct. Inserted post-boot;
    // the db.js migration already added the linked_printer_id column.
    db.prepare(`INSERT INTO jobs (id, printerId, name, start, end, status, cool_down_mins, linked_printer_id)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(10, 1, 'LINK', '2026-04-16T08:00:00.000Z', '2026-04-16T09:00:00.000Z', 'Printing', 40, 2);
    const row = db.prepare('SELECT * FROM jobs WHERE id=10').get();
    expect(row.linked_printer_id).not.toBe(row.printerId); // genuinely cross-printer
    // Place a new candidate right after the finishing job. Its gap must use the
    // job's own 40-min snapshot, not printer1's 10 nor the linked printer2's 25.
    const finishing = [{ start: row.start, end: row.end, coolDownMs: row.cool_down_mins * MIN }];
    const start = findNextValidStart(
      new Date('2026-04-16T09:00:00.000Z'), 60, RESTR, [], finishing, 5 * MIN, 10 * MIN
    );
    // 09:00 + 40 (own cool) + 5 (warm) = 09:45.
    expect(start.toISOString()).toBe('2026-04-16T09:45:00.000Z');
    db.prepare('DELETE FROM jobs WHERE id=10').run(); // keep DB clean for later tests
  });

  test('changing a printer\'s cool_down_mins after migration does NOT move existing jobs', () => {
    const jobs = db.prepare('SELECT * FROM jobs WHERE printerId=1 ORDER BY start').all();
    const before = runChain(jobs, 5, 10, 'new');
    // Owner bumps printer 1's cool-down from 10 → 40 later on.
    db.prepare('UPDATE printers SET cool_down_mins=40 WHERE id=1').run();
    const jobsAfter = db.prepare('SELECT * FROM jobs WHERE printerId=1 ORDER BY start').all();
    const after = runChain(jobsAfter, 5, 40, 'new'); // per-job fields untouched → schedule frozen
    expect(after).toEqual(before);
  });

  test('the backfill is idempotent — re-running touches no rows', () => {
    const info = db.prepare(`UPDATE jobs SET cool_down_mins =
      COALESCE((SELECT p.cool_down_mins FROM printers p WHERE p.id = jobs.printerId), 15)
      WHERE cool_down_mins IS NULL`).run();
    expect(info.changes).toBe(0);
    // Column already present → the guarded ALTER never runs twice.
    const cols = db.pragma('table_info(jobs)');
    expect(cols.filter(c => c.name === 'cool_down_mins')).toHaveLength(1);
  });
});
