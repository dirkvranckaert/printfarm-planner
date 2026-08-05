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

const MARKER_KEY = 'migration.items_backfill_v1';
const DURATION_TOLERANCE_MINS = 1;

function backfillItems({ db, uploadsDir, parse3mf, fs, path, tolerance = DURATION_TOLERANCE_MINS }) {
  const marker = db.prepare('SELECT value FROM settings WHERE key=?').get(MARKER_KEY);
  if (marker) return { ran: false, reason: 'marker-present' };

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

  for (const job of jobs) {
    try {
      // Only re-parse a real retained upload: a bare `<hex>.3mf` under uploadsDir.
      // Manual create/edit can store an arbitrary printFile string (a label, a
      // path) — those are not our files and must be skipped.
      if (job.printFile.includes('/') || !job.printFile.endsWith('.3mf')) { stats.skipped++; continue; }
      const full = path.join(uploadsDir, job.printFile);
      if (!fs.existsSync(full)) { stats.skipped++; continue; }

      const parsed = parse3mf(full);
      const plates = (parsed && parsed.plates) || [];
      if (!plates.length) { stats.skipped++; continue; }

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

      if (!chosen) { stats.ambiguous++; continue; }

      const count = chosen.objectCount;
      // A real sliced plate always has ≥1 object; treat 0/undefined as a parse
      // miss and skip rather than record a bogus 0-item job.
      if (!(Number.isInteger(count) && count > 0)) { stats.skipped++; continue; }

      setItems.run(count, chosen.plateName ?? null, job.id);
      stats.backfilled++;
      if (kind === 'single') stats.singlePlate++; else stats.multiMatched++;
    } catch {
      stats.skipped++;
    }
  }

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(MARKER_KEY, '1');
  return { ran: true, stats };
}

module.exports = { backfillItems, MARKER_KEY, DURATION_TOLERANCE_MINS };
