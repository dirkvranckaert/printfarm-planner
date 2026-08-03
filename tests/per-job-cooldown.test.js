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
// Migration: byte-identical backfill on a real db.js upgrade.
// ---------------------------------------------------------------------------

// Deterministic tight-pack that mirrors findNextValidStart's gap model
// (gap between consecutive jobs = prevJob.cooldown + printer.warmUp). Used to
// compare the OLD (printer-field) and NEW (per-job-field) schedules.
function packSchedule(rows, warmUpMins, coolOf) {
  const sorted = [...rows].sort((a, b) => new Date(a.start) - new Date(b.start));
  const out = [];
  let cursor = null;
  for (const j of sorted) {
    const durMs = new Date(j.end) - new Date(j.start);
    const startMs = cursor == null ? new Date(j.start).getTime() : cursor;
    const endMs = startMs + durMs;
    out.push({ id: j.id, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
    cursor = endMs + (coolOf(j) + warmUpMins) * 60000;
  }
  return out;
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
    // Printer 1 (past + future + ongoing), printer 2 (future).
    insJob.run(1, 1, 'A', '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z', 'Done');
    insJob.run(2, 1, 'B', '2026-04-13T09:30:00.000Z', '2026-04-13T10:30:00.000Z', 'Printing');
    insJob.run(3, 1, 'C', '2026-04-13T11:00:00.000Z', '2026-04-13T12:00:00.000Z', 'Planned');
    insJob.run(4, 2, 'D', '2026-04-14T08:00:00.000Z', '2026-04-14T09:30:00.000Z', 'Planned');
    insJob.run(5, 2, 'E', '2026-04-14T10:00:00.000Z', '2026-04-14T11:00:00.000Z', 'Planned');
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

  test('every job is backfilled with its printer\'s current cool_down_mins', () => {
    const rows = db.prepare('SELECT id, printerId, cool_down_mins FROM jobs ORDER BY id').all();
    const printerCool = { 1: 10, 2: 25 };
    for (const r of rows) {
      expect(r.cool_down_mins).toBe(printerCool[r.printerId]);
    }
  });

  test('the recomputed schedule is byte-identical across the migration', () => {
    const printers = db.prepare('SELECT * FROM printers').all().reduce((m, p) => (m[p.id] = p, m), {});
    for (const pid of [1, 2]) {
      const jobs = db.prepare("SELECT * FROM jobs WHERE printerId=? ORDER BY start").all(pid);
      const p = printers[pid];
      // OLD behavior: every job used the live printer cool-down.
      const before = packSchedule(jobs, p.warm_up_mins, () => p.cool_down_mins);
      // NEW behavior: every job uses its own snapshotted field.
      const after = packSchedule(jobs, p.warm_up_mins, (j) => j.cool_down_mins);
      expect(after).toEqual(before);
    }
  });

  test('changing a printer\'s cool_down_mins after migration does NOT move existing jobs', () => {
    const jobs = db.prepare("SELECT * FROM jobs WHERE printerId=1 ORDER BY start").all();
    const before = packSchedule(jobs, 5, (j) => j.cool_down_mins);
    // Owner bumps the global/printer cool-down from 10 → 40 later on.
    db.prepare('UPDATE printers SET cool_down_mins=40 WHERE id=1').run();
    const jobsAfter = db.prepare("SELECT * FROM jobs WHERE printerId=1 ORDER BY start").all();
    const after = packSchedule(jobsAfter, 5, (j) => j.cool_down_mins);
    expect(after).toEqual(before); // per-job field untouched → schedule frozen
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
