'use strict';

// One-time backfill of jobs.items / jobs.plate_name from each job's retained
// 3MF. Runs once at startup (guarded by a settings marker so it never re-parses
// every boot) and only ever touches jobs whose items is still NULL — it never
// overwrites a value a user already set, and never fabricates a count.
//
// Mapping rules (decided with Dirk):
//   - single-plate 3MF      → items = plate.objectCount, plate_name = plate.plateName
//   - multi-plate 3MF       → match plates to the job by print DURATION; backfill
//                             ONLY when EXACTLY ONE plate matches (unique). 0 or
//                             >1 matches → leave items NULL (manual reload later).
//
// Duration match tolerance: ±1 minute. Import stores durationMins as
// Math.round(printTimeMinutes), so the round-trip is normally exact; ±1 absorbs
// any rounding drift without risking a wrong plate on realistic prints (whose
// durations differ by far more than a minute).
//
// Prod-safe: every job is wrapped in try/catch so one unreadable/GC'd/non-3MF
// file can neither abort the migration nor crash startup. All deps are injected
// so the logic is unit-testable against a temp dir + fake parser.
//
// TWO entry points share one per-job body (processJob):
//   - backfillItems       — synchronous, used by the unit tests.
//   - backfillItemsAsync  — yields to the event loop every YIELD_EVERY jobs so a
//                           large prod backlog cannot monopolise node's single
//                           thread. server.js runs THIS one after the port is
//                           bound, so parsing dozens of retained 3MFs never
//                           delays the port bind or blocks the deploy health
//                           check (the boot failure this file caused).

const MARKER_KEY = 'migration.items_backfill_v1';
const DURATION_TOLERANCE_MINS = 1;
const YIELD_EVERY = 1;

// Read the marker + the candidate job set + prepared UPDATE. Returns null when
// the marker is already present (nothing to do). Shared by both entry points.
function prepare(db) {
  const marker = db.prepare('SELECT value FROM settings WHERE key=?').get(MARKER_KEY);
  if (marker) return null;

  const jobs = db.prepare(
    "SELECT id, printFile, durationMins FROM jobs WHERE items IS NULL AND printFile IS NOT NULL AND printFile != ''"
  ).all();

  const stats = {
    scanned: jobs.length,
    singlePlate: 0,   // backfilled from a single-plate 3MF
    multiMatched: 0,  // backfilled from a multi-plate 3MF via unique duration match
    ambiguous: 0,     // multi-plate, 0 or >1 duration matches → left NULL
    skipped: 0,       // missing/GC'd/non-3MF file, parse failure, or empty plate
    backfilled: 0,    // total rows written
  };

  const setItems = db.prepare('UPDATE jobs SET items=?, plate_name=? WHERE id=?');
  return { jobs, stats, setItems };
}

// Process one job. Never throws — a bad file only bumps stats.skipped.
function processJob(job, { uploadsDir, parse3mf, fs, path, tolerance, setItems, stats }) {
  try {
    // Only re-parse a real retained upload: a bare `<hex>.3mf` under uploadsDir.
    // Manual create/edit can store an arbitrary printFile string (a label, a
    // path) — those are not our files and must be skipped.
    if (job.printFile.includes('/') || !job.printFile.endsWith('.3mf')) { stats.skipped++; return; }
    const full = path.join(uploadsDir, job.printFile);
    if (!fs.existsSync(full)) { stats.skipped++; return; }

    const parsed = parse3mf(full);
    const plates = (parsed && parsed.plates) || [];
    if (!plates.length) { stats.skipped++; return; }

    let chosen = null;
    let kind = null;
    if (plates.length === 1) {
      chosen = plates[0];
      kind = 'single';
    } else {
      const matches = plates.filter(
        p => Math.abs(Math.round(p.printTimeMinutes || 0) - (job.durationMins || 0)) <= tolerance
      );
      if (matches.length === 1) { chosen = matches[0]; kind = 'multi'; }
    }

    if (!chosen) { stats.ambiguous++; return; }

    const count = chosen.objectCount;
    // A real sliced plate always has ≥1 object; treat 0/undefined as a parse
    // miss and skip rather than record a bogus 0-item job.
    if (!(Number.isInteger(count) && count > 0)) { stats.skipped++; return; }

    setItems.run(count, chosen.plateName ?? null, job.id);
    stats.backfilled++;
    if (kind === 'single') stats.singlePlate++; else stats.multiMatched++;
  } catch {
    stats.skipped++;
  }
}

function finish(db) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(MARKER_KEY, '1');
}

// Synchronous backfill (unit-tested path). Behaviour unchanged.
function backfillItems({ db, uploadsDir, parse3mf, fs, path, tolerance = DURATION_TOLERANCE_MINS }) {
  const p = prepare(db);
  if (!p) return { ran: false, reason: 'marker-present' };

  const ctx = { uploadsDir, parse3mf, fs, path, tolerance, setItems: p.setItems, stats: p.stats };
  for (const job of p.jobs) processJob(job, ctx);

  finish(db);
  return { ran: true, stats: p.stats };
}

// Non-blocking backfill for startup: identical result, but yields to the event
// loop every YIELD_EVERY jobs so incoming HTTP (e.g. the deploy health check)
// is served while a large retained-3MF backlog is scanned. Each setItems.run is
// its own autocommit statement, so yielding between jobs never straddles an open
// transaction. If the process dies mid-scan the marker is never written and the
// next boot resumes — the backfill is idempotent (only touches items-IS-NULL).
async function backfillItemsAsync({ db, uploadsDir, parse3mf, fs, path, tolerance = DURATION_TOLERANCE_MINS }) {
  const p = prepare(db);
  if (!p) return { ran: false, reason: 'marker-present' };

  const ctx = { uploadsDir, parse3mf, fs, path, tolerance, setItems: p.setItems, stats: p.stats };
  let i = 0;
  for (const job of p.jobs) {
    processJob(job, ctx);
    if (++i % YIELD_EVERY === 0) await new Promise(resolve => setImmediate(resolve));
  }

  finish(db);
  return { ran: true, stats: p.stats };
}

module.exports = { backfillItems, backfillItemsAsync, MARKER_KEY, DURATION_TOLERANCE_MINS };
