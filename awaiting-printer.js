'use strict';

// "Link when printer starts" pending-link pipeline.
//
// A job can be pre-linked to a printer BEFORE that printer is printing: the
// user picks "Link when printer starts" while the printer is still idle /
// preparing. The job enters status 'Awaiting Printer' with linked_printer_id
// set. When the printer flips to RUNNING (see the SSE stage-transition handler
// in server.js), the existing linked-job path flips it to 'Printing' — that IS
// the auto-link. This module only owns the *entry* into the pending state and
// the two invariants around it:
//
//   1. Start-time window: the pending job's start must be within WINDOW_MS of
//      now on either side (past OR future). Guards against auto-linking a job
//      that is scheduled far ahead or is long stale. Checked both when the user
//      sets the pending state AND again at the RUNNING transition (relative to
//      that moment), so a printer that starts a *different* print doesn't sweep
//      up an out-of-window pending job.
//   2. One pending job per printer: at most one job may sit in 'Awaiting
//      Printer' for a given printer at a time.
//
// Pure DB glue: all functions take the db handle explicitly so they can be
// driven by an in-memory SQLite in tests.

const STATUS = 'Awaiting Printer';
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * True when `startISO` is eligible for auto-linking relative to `now`:
 * within WINDOW_MS of now on either side (past or future). Empty/invalid
 * start times (e.g. queued jobs) are never eligible.
 */
function isWithinStartWindow(startISO, now) {
  if (!startISO) return false;
  const startMs = new Date(startISO).getTime();
  if (Number.isNaN(startMs)) return false;
  const nowMs = now.getTime();
  return startMs >= nowMs - WINDOW_MS && startMs <= nowMs + WINDOW_MS;
}

/**
 * Enter the 'Awaiting Printer' pending state for a job.
 * Enforces the start-time window + one-pending-per-printer invariant.
 * Returns { ok: true } on success, or { ok: false, code, error } describing
 * why it was rejected (caller maps `code` to an HTTP status).
 */
function assignPending({ db, jobId, printerId, now }) {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!job) return { ok: false, code: 404, error: 'Job not found' };
  if (!printerId) return { ok: false, code: 400, error: 'No printer to link to' };
  if (!isWithinStartWindow(job.start, now)) {
    return {
      ok: false,
      code: 400,
      error: 'Job start time must be within 24 hours of now to auto-link.',
    };
  }
  const existing = db.prepare(
    'SELECT id FROM jobs WHERE linked_printer_id=? AND status=? AND id!=?'
  ).get(printerId, STATUS, jobId);
  if (existing) {
    return {
      ok: false,
      code: 409,
      error: 'This printer already has a job waiting to auto-link. Cancel that one first.',
    };
  }
  db.prepare('UPDATE jobs SET status=?, linked_printer_id=? WHERE id=?')
    .run(STATUS, printerId, jobId);
  return { ok: true };
}

module.exports = { STATUS, WINDOW_MS, isWithinStartWindow, assignPending };
