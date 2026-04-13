'use strict';

// Live schedule re-alignment against a linked printer's reported status.
//
// When a job is linked to a printer and the printer reports its remaining
// print time via MQTT, this module:
//   - Updates the currently-printing job's `start` (on first RUNNING tick
//     after linking) and `end` (on every tick) to reflect reality.
//   - If the new predicted end is LATER than the stored end by more than a
//     threshold, cascades a push-back to every subsequent Planned/Awaiting
//     job on the same printer (re-using scheduling.pushBackChain).
//   - If the new predicted end is EARLIER, only the current job is pulled
//     back. Subsequent jobs stay put — creating a "free gap" — per the
//     explicit product decision. Pull-back does NOT cascade.
//
// Pure DB glue: inject the db and current time so tests can drive it with
// an in-memory SQLite.

const scheduling = require('./scheduling');

const DEFAULT_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const CASCADABLE_STATUSES = new Set(['Planned', 'Awaiting']);

/**
 * @param {object}  opts
 * @param {Database} opts.db               better-sqlite3 handle
 * @param {object}  opts.printer           { id, warm_up_mins, cool_down_mins }
 * @param {object}  opts.job               The linked, currently-printing job row
 * @param {number}  opts.remainingMins     Printer's reported remaining time, in minutes
 * @param {Date}    opts.now               Current time (injected for tests)
 * @param {object}  opts.restr             Scheduling restrictions (silent hours / TZ / closed days)
 * @param {boolean} [opts.snapStart=false] On first RUNNING tick, also snap job.start to `now`
 * @param {number}  [opts.thresholdMs]     Ignore deltas smaller than this (default 2 min)
 * @returns {{ changed: boolean, deltaMs: number, updated: Array<{id, start, end}> }}
 */
function realignLinkedJob({ db, printer, job, remainingMins, now, restr, snapStart = false, thresholdMs = DEFAULT_THRESHOLD_MS }) {
  if (remainingMins == null || remainingMins < 0) {
    return { changed: false, deltaMs: 0, updated: [] };
  }

  const tz = restr?.timezone || scheduling.DEFAULT_TZ;
  const warmUpMs = (printer.warm_up_mins ?? 5) * 60000;
  const coolDownMs = (printer.cool_down_mins ?? 15) * 60000;

  const currentEndDate = scheduling.parseJobTime(job.end, tz);
  if (!currentEndDate || isNaN(currentEndDate.getTime())) {
    return { changed: false, deltaMs: 0, updated: [] };
  }
  const currentEndMs = currentEndDate.getTime();
  const predictedEndMs = now.getTime() + remainingMins * 60000;
  const deltaMs = predictedEndMs - currentEndMs;

  // Nothing material changed — skip to avoid thrashing on printer jitter.
  if (!snapStart && Math.abs(deltaMs) < thresholdMs) {
    return { changed: false, deltaMs, updated: [] };
  }

  const updated = [];
  const newEndISO = new Date(predictedEndMs).toISOString();

  if (snapStart) {
    // First RUNNING tick after linking: job.start reflects when the print
    // actually began. end moves to predictedEnd regardless of threshold.
    const newStartISO = now.toISOString();
    db.prepare('UPDATE jobs SET start=?, end=? WHERE id=?').run(newStartISO, newEndISO, job.id);
    updated.push({ id: job.id, start: newStartISO, end: newEndISO });
  } else {
    db.prepare('UPDATE jobs SET end=? WHERE id=?').run(newEndISO, job.id);
    updated.push({ id: job.id, start: job.start, end: newEndISO });
  }

  // Only cascade downstream when we're running LATE. Running ahead creates
  // free gap — no automatic pull-forward on subsequent jobs.
  if (deltaMs > 0) {
    const closures = db.prepare('SELECT startDate, endDate FROM closures').all();
    const allSamePrinter = db.prepare(
      "SELECT id, name, status, start, end FROM jobs WHERE printerId=? AND queued=0 AND start!='' AND id!=?"
    ).all(printer.id, job.id);

    // Downstream chain = jobs on this printer whose current start is at or after
    // the current job's ORIGINAL stored end, in cascadable state.
    const chain = allSamePrinter
      .filter(j => {
        if (!CASCADABLE_STATUSES.has(j.status)) return false;
        const s = scheduling.parseJobTime(j.start, tz);
        return s && s.getTime() >= currentEndMs;
      })
      .sort((a, b) =>
        scheduling.parseJobTime(a.start, tz).getTime() -
        scheduling.parseJobTime(b.start, tz).getTime()
      );

    if (chain.length) {
      const chainIds = new Set(chain.map(j => j.id));
      const otherJobs = allSamePrinter.filter(j => !chainIds.has(j.id));

      // Anchor for the first chained job: current job's new end + cool + warm.
      const cascadeAnchor = new Date(predictedEndMs + coolDownMs + warmUpMs);
      const pushUpdates = scheduling.pushBackChain(
        chain, cascadeAnchor, restr, closures, otherJobs, warmUpMs, coolDownMs
      );

      const upd = db.prepare('UPDATE jobs SET start=?, end=? WHERE id=?');
      const tx = db.transaction(list => { for (const u of list) upd.run(u.start, u.end, u.id); });
      tx(pushUpdates);

      for (const u of pushUpdates) updated.push(u);
    }
  }

  return { changed: true, deltaMs, updated };
}

module.exports = { realignLinkedJob, DEFAULT_THRESHOLD_MS };
