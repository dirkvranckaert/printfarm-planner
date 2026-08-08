'use strict';

// Printer link-transition logic — single source of truth for how a printer's
// live stage transitions (RUNNING / PAUSE) move a LINKED job's status, and for
// which statuses keep a `linked_printer_id` meaningful.
//
// Extracted out of server.js so the Jest regression suite exercises the SAME
// eligibility + transition code the SSE stage-transition handler runs in
// production — not a hand-copied mirror. server.js layers the push / realign /
// broadcast side-effects on top of the job lists these appliers return.
//
// Pure DB glue: every function takes the db handle explicitly so it can be
// driven by an in-memory SQLite in tests.

const awaitingPrinter = require('./awaiting-printer');
const pause = require('./pause');

// Statuses for which a job's linked_printer_id is meaningful. An explicit
// status change that leaves this set (→ Post Printing / Done / Planned /
// Awaiting) clears the stale link so the printer is no longer shown busy and
// the SSE/pause paths never re-grab the job.
const LINK_ACTIVE_STATUSES = new Set([awaitingPrinter.STATUS, 'Printing', 'Paused']);

/**
 * Is a linked job eligible to (re)start printing on the printer's RUNNING edge?
 * A pending 'Awaiting Printer' job (only if its start is still within the
 * link window at `now`) or a 'Paused' job resuming. A job that already finished
 * its print ('Post Printing' / 'Done' / anything else) with a stale link is
 * NEVER re-grabbed when the printer starts its NEXT print.
 */
function eligibleToStart(job, now) {
  if (job.status === 'Paused') return true;
  if (job.status === awaitingPrinter.STATUS) {
    return awaitingPrinter.isWithinStartWindow(job.start, now);
  }
  return false;
}

/**
 * Is a linked job eligible to be paused on the printer's PAUSE edge? Only a
 * genuinely-'Printing' job. A stale 'Post Printing' (or any non-printing) job
 * must NOT be flipped to 'Paused' — otherwise the PAUSE→RUNNING resume would
 * re-admit it and overwrite it back to 'Printing' (the corruption bug).
 */
function eligibleToPause(job) {
  return job.status === 'Printing';
}

/**
 * Apply the RUNNING-edge status flips for every job linked to a printer.
 * Flips each eligible 'Awaiting Printer' / 'Paused' job to 'Printing' (clearing
 * its pause snapshot), leaves everything else untouched. Returns the pre-flip
 * rows it started so the caller can run realign / push side-effects.
 *
 * @returns {{ started: Array<object> }}
 */
function applyRunningTransition({ db, printerId, now }) {
  const linked = db.prepare(
    "SELECT * FROM jobs WHERE linked_printer_id=? AND status != 'Done'"
  ).all(printerId);
  const started = [];
  for (const job of linked) {
    if (job.status === 'Printing') continue;
    if (!eligibleToStart(job, now)) continue;
    if (job.status === 'Paused') pause.endPause({ db, jobId: job.id });
    db.prepare(
      "UPDATE jobs SET status='Printing', paused_at=NULL, paused_remaining_ms=NULL WHERE id=?"
    ).run(job.id);
    started.push(job);
  }
  return { started };
}

/**
 * Apply the PAUSE-edge status flips: snapshot + flip to 'Paused' ONLY jobs that
 * are genuinely 'Printing'. Returns the pre-pause rows it paused so the caller
 * can run push side-effects.
 *
 * @returns {{ paused: Array<object> }}
 */
function applyPauseTransition({ db, printerId, now }) {
  const linked = db.prepare(
    "SELECT * FROM jobs WHERE linked_printer_id=? AND status != 'Done'"
  ).all(printerId);
  const paused = [];
  for (const job of linked) {
    if (!eligibleToPause(job)) continue;
    pause.beginPause({ db, jobId: job.id, now });
    paused.push(job);
  }
  return { paused };
}

module.exports = {
  LINK_ACTIVE_STATUSES,
  eligibleToStart,
  eligibleToPause,
  applyRunningTransition,
  applyPauseTransition,
};
