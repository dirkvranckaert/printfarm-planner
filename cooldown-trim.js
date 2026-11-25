'use strict';

// Link/start-time cool-down trim.
//
// Cool-down is only an ESTIMATE of how long a printer needs to cool after a
// print. When the next job is linked to / starts on the printer before the
// previous job's cool-down expired (the printer cooled faster than planned),
// the overlap is with the cool-down buffer only — not with the previous print.
// That is not a real conflict, so we shorten the previous job's persisted
// `cool_down_mins` so its cool-down ends exactly where the new job's buffered
// interval (start minus its own warm-up) begins.
//
// Scope is deliberately narrow: only the link/start path calls this (pending
// link via assignPending, RUNNING-edge start, live realign shifting the start).
// Planning, reshuffling, push/pull and manual drags keep honouring the full
// cool-down. Reduce-only: never lengthens a cool-down. A previous job whose
// PRINT overlaps the new start (prev.end > start) is untouched — that stays a
// real conflict.
//
// Pure DB glue (db handle injected) so tests drive the production code.

const scheduling = require('./scheduling');

/**
 * @param {object}   opts
 * @param {Database} opts.db
 * @param {number}   opts.jobId   The job that is being linked / has started
 * @param {string}  [opts.tz]     Scheduling timezone (naive local strings)
 * @returns {{ trimmed: Array<{id:number, from:number, to:number}> }}
 */
function trimPrevCoolDown({ db, jobId, tz = scheduling.DEFAULT_TZ }) {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!job || !job.start || job.printerId == null) return { trimmed: [] };
  const printer = db.prepare('SELECT * FROM printers WHERE id=?').get(job.printerId) || {};

  const startDate = scheduling.parseJobTime(job.start, tz);
  if (!startDate || Number.isNaN(startDate.getTime())) return { trimmed: [] };
  // Same fallback chain as client detectConflicts (warm-up default 0 there).
  const warmUpMs = (job.warm_up_mins ?? printer.warm_up_mins ?? 0) * 60000;
  const bufferedStartMs = startDate.getTime() - warmUpMs;

  const others = db.prepare(
    "SELECT id, start, end, cool_down_mins FROM jobs WHERE printerId=? AND id!=? AND queued=0 AND start!='' AND end!=''"
  ).all(job.printerId, jobId);

  const trimmed = [];
  const upd = db.prepare('UPDATE jobs SET cool_down_mins=? WHERE id=?');
  for (const o of others) {
    const endDate = scheduling.parseJobTime(o.end, tz);
    if (!endDate || Number.isNaN(endDate.getTime())) continue;
    const endMs = endDate.getTime();
    // Real overlap with the previous PRINT itself (or it ends after we start):
    // not ours to fix — stays a conflict.
    if (endMs > startDate.getTime()) continue;
    const cdMins = o.cool_down_mins ?? printer.cool_down_mins ?? 15;
    // Only jobs whose cool-down actually reaches into the new buffered start.
    if (endMs + cdMins * 60000 <= bufferedStartMs) continue;
    const newCd = Math.max(0, Math.floor((bufferedStartMs - endMs) / 60000));
    if (newCd >= cdMins) continue; // reduce-only
    upd.run(newCd, o.id);
    trimmed.push({ id: o.id, from: cdMins, to: newCd });
  }
  return { trimmed };
}

module.exports = { trimPrevCoolDown };
