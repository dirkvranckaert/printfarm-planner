'use strict';

// Pause-tracking pipeline for jobs linked to a live printer.
//
// The Bambu RUNNING->PAUSE transition freezes `mc_remaining_time`, so live
// realign is gated off during PAUSE (see server.js). To keep the day-view
// bar from freezing in the past, we:
//
//   1. On pause: snapshot `paused_at` + `paused_remaining_ms` (= job.end - now)
//      and flip the row to status='Paused'. The bar does not move on this
//      transition itself.
//   2. On every tick while paused: bump `end` = now + paused_remaining_ms so
//      the bar drifts forward with wall-clock. Also cascade downstream Planned
//      jobs via scheduling.pushBackChain so they keep their buffer-distance.
//   3. On resume (PAUSE->RUNNING): clear the pause fields + flip status back
//      to Printing. The existing snap-start realign re-snaps to the actual
//      reported remaining.
//
// Pure DB glue: all functions take the db handle explicitly so they can be
// driven by an in-memory SQLite in tests.

const scheduling = require('./scheduling');

const CASCADABLE_STATUSES = new Set(['Planned', 'Awaiting']);

/**
 * Snapshot a job on the RUNNING->PAUSE transition.
 * Stores `paused_at`, `paused_remaining_ms` = max(0, job.end - now), and
 * flips status to 'Paused'. Does NOT touch start/end yet — the periodic
 * tick drives the visual drift.
 */
function beginPause({ db, jobId, now }) {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!job) return null;
  const endMs = new Date(job.end).getTime();
  const remainingMs = Math.max(0, endMs - now.getTime());
  db.prepare("UPDATE jobs SET paused_at=?, paused_remaining_ms=?, status='Paused' WHERE id=?")
    .run(now.toISOString(), remainingMs, jobId);
  return { id: jobId, paused_at: now.toISOString(), paused_remaining_ms: remainingMs };
}

/**
 * Clear a job on the PAUSE->RUNNING transition.
 * Wipes `paused_at` + `paused_remaining_ms` and flips status to 'Printing'
 * (only when still 'Paused' — avoids stomping a manual status change).
 */
function endPause({ db, jobId }) {
  db.prepare("UPDATE jobs SET paused_at=NULL, paused_remaining_ms=NULL, status='Printing' WHERE id=? AND status='Paused'")
    .run(jobId);
}

/**
 * Clear pause fields unconditionally. Call this from any job-mutation route
 * that moves a job out of 'Paused' (Done/Cancelled/Planned/etc.) so the row
 * does not carry a stale `paused_at` forever.
 */
function clearPauseFields({ db, jobId }) {
  db.prepare('UPDATE jobs SET paused_at=NULL, paused_remaining_ms=NULL WHERE id=?').run(jobId);
}

/**
 * Periodic tick: for every job currently paused, bump `end` forward to
 * `now + paused_remaining_ms` and cascade downstream Planned/Awaiting jobs
 * via scheduling.pushBackChain. The paused job's `start` moves with `end`
 * so the block keeps its duration.
 *
 * @returns {{ updated: Array<{id,start,end}> }}
 */
function pauseTick({ db, now, restr }) {
  const tz = restr?.timezone || scheduling.DEFAULT_TZ;
  const paused = db.prepare(
    "SELECT * FROM jobs WHERE paused_at IS NOT NULL AND status='Paused'"
  ).all();
  if (!paused.length) return { updated: [] };

  const closures = db.prepare('SELECT startDate, endDate FROM closures').all();
  const updated = [];
  const upd = db.prepare('UPDATE jobs SET start=?, end=? WHERE id=?');

  for (const job of paused) {
    const printer = db.prepare('SELECT * FROM printers WHERE id=?').get(job.printerId);
    if (!printer) continue;
    const warmUpMs = (printer.warm_up_mins ?? 5) * 60000;
    const coolDownMs = (printer.cool_down_mins ?? 15) * 60000;

    const remainingMs = Number(job.paused_remaining_ms) || 0;
    const oldStartMs = new Date(job.start).getTime();
    const oldEndMs = new Date(job.end).getTime();
    const durationMs = oldEndMs - oldStartMs;
    const newEndMs = now.getTime() + remainingMs;
    const newStartMs = newEndMs - durationMs;

    if (newEndMs === oldEndMs) continue; // no-op (paused at t=0)

    const newStartISO = new Date(newStartMs).toISOString();
    const newEndISO = new Date(newEndMs).toISOString();
    upd.run(newStartISO, newEndISO, job.id);
    updated.push({ id: job.id, start: newStartISO, end: newEndISO });

    // Cascade downstream Planned/Awaiting jobs if we drifted forward.
    if (newEndMs > oldEndMs) {
      const allSamePrinter = db.prepare(
        "SELECT id, name, status, start, end FROM jobs WHERE printerId=? AND queued=0 AND start!='' AND id!=?"
      ).all(printer.id, job.id);

      const chain = allSamePrinter
        .filter(j => {
          if (!CASCADABLE_STATUSES.has(j.status)) return false;
          const s = scheduling.parseJobTime(j.start, tz);
          return s && s.getTime() >= oldEndMs;
        })
        .sort((a, b) =>
          scheduling.parseJobTime(a.start, tz).getTime() -
          scheduling.parseJobTime(b.start, tz).getTime()
        );

      if (chain.length) {
        const chainIds = new Set(chain.map(j => j.id));
        const otherJobs = allSamePrinter.filter(j => !chainIds.has(j.id));
        const cascadeAnchor = new Date(newEndMs + coolDownMs + warmUpMs);
        const pushUpdates = scheduling.pushBackChain(
          chain, cascadeAnchor, restr, closures, otherJobs, warmUpMs, coolDownMs
        );
        const tx = db.transaction(list => { for (const u of list) upd.run(u.start, u.end, u.id); });
        tx(pushUpdates);
        for (const u of pushUpdates) updated.push(u);
      }
    }
  }

  return { updated };
}

module.exports = { beginPause, endPause, clearPauseFields, pauseTick };
