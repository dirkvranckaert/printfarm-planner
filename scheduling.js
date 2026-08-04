// Pure scheduling helpers — no DB, no Express. Imported by server.js and tests.

const DEFAULT_TZ = 'Europe/Brussels';
const MAX_COPIES = 50;

/**
 * Expand a plate list by each plate's `copies` count, preserving array order.
 * Copy 1 keeps the plate's name; copies 2..N get a " (copy k)" suffix so they
 * stay distinguishable in the planner. The scheduling loop then treats each
 * expanded entry exactly like a separate plate — so copies cascade back-to-back
 * on the plate's printer, inheriting the same cool-down/warm-up inter-job gap
 * as multi-plate scheduling.
 *
 * A missing/undefined `copies` means 1 (so N=1 payloads are unchanged). Invalid
 * (non-integer, < 1) or oversized (> maxCopies) values throw — the caller maps
 * that to a 400 so copies are never silently dropped or clamped server-side.
 *
 * @param {Array<object>} plates    Plate payloads (each may carry `copies`).
 * @param {number}        maxCopies Hard cap per plate.
 * @returns {Array<object>} Flat, order-preserving list with `copies` stripped.
 */
function expandPlateCopies(plates, maxCopies = MAX_COPIES) {
  const out = [];
  for (const pl of plates || []) {
    const copies = pl.copies == null ? 1 : pl.copies;
    if (!Number.isInteger(copies) || copies < 1) {
      throw new Error(`Invalid copies for plate ${pl.plateIndex ?? '?'}: must be an integer >= 1`);
    }
    if (copies > maxCopies) {
      throw new Error(`Too many copies for plate ${pl.plateIndex ?? '?'}: max ${maxCopies}`);
    }
    for (let k = 1; k <= copies; k++) {
      const copy = { ...pl };
      delete copy.copies;
      if (copies > 1 && k > 1) {
        copy.name = `${pl.name || `Plate ${pl.plateIndex}`} (copy ${k})`;
      }
      out.push(copy);
    }
  }
  return out;
}

function timeToMinutes(timeStr) {
  const [h, m] = (timeStr || '00:00').split(':').map(Number);
  return h * 60 + (m || 0);
}

// Wall-clock parts of `date` in the given IANA timezone.
function getZoneParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: wd };
}

// Offset (ms) of `tz` at the given instant: positive east of UTC.
function tzOffset(utcMs, tz) {
  const p = getZoneParts(new Date(utcMs), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

// Convert wall-clock time in a given timezone to a UTC Date. DST-safe.
function zonedTimeToDate(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offset1 = tzOffset(guess, tz);
  let utc = guess - offset1;
  const offset2 = tzOffset(utc, tz);
  if (offset2 !== offset1) utc = guess - offset2;
  return new Date(utc);
}

function isInSilentHours(date, silentStart, silentEnd, tz) {
  const p = getZoneParts(date, tz);
  const mins = p.hour * 60 + p.minute;
  const start = timeToMinutes(silentStart);
  const end = timeToMinutes(silentEnd);
  if (start < end) return mins >= start && mins < end; // e.g. 09:00–17:00
  return mins >= start || mins < end; // e.g. 21:00–06:30 (overnight)
}

// Parse a stored job timestamp. Handles two formats:
//   - proper ISO with a Z / ±HH:MM suffix → new Date() as-is
//   - naked 'YYYY-MM-DDTHH:mm[:ss]' without TZ → interpreted in the configured zone
// The second form exists in production because some job-write paths stored
// datetime-local values verbatim. On a UTC server, new Date('2026-04-13T06:30')
// resolves to 06:30 UTC, which is 2h off from the 06:30 Brussels the user meant.
function parseJobTime(s, tz) {
  if (!s) return null;
  // Already has explicit timezone info?
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return new Date(s); // best-effort fallback
  return zonedTimeToDate(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
}

function advanceToSilentEnd(date, silentEnd, tz) {
  const [h, m] = (silentEnd || '06:30').split(':').map(Number);
  const p = getZoneParts(date, tz);
  let result = zonedTimeToDate(p.year, p.month, p.day, h, m || 0, tz);
  if (result <= date) result = zonedTimeToDate(p.year, p.month, p.day + 1, h, m || 0, tz);
  return result;
}

/**
 * Find the next valid start instant for a job.
 *
 * @param {Date}   candidate     Earliest instant the job could start.
 * @param {number} durationMins  Job duration in minutes.
 * @param {object} restr         { silentStart, silentEnd, closedDays, timezone }
 * @param {Array<{startDate:string, endDate:string}>} closures  YYYY-MM-DD ranges (inclusive).
 * @param {Array<{start:string, end:string, coolDownMs?:number, warmUpMs?:number}>} jobs  ISO start/end,
 *                            ordered by start. Each job may carry its own `coolDownMs` and `warmUpMs`
 *                            (per-job snapshots); when absent, the scalar arguments are the fallback.
 * @param {number} warmUpMs      Warm-up buffer in ms for the job BEING placed (the candidate).
 *                            Also the fallback for any existing job in `jobs` without its own warm-up.
 * @param {number} coolDownMs    Cool-down buffer in ms for the job BEING placed (the candidate).
 *                            Also the fallback for any existing job in `jobs` without its own.
 * @returns {Date}
 */
function findNextValidStart(candidate, durationMins, restr, closures, jobs, warmUpMs, coolDownMs) {
  const tz = restr?.timezone || DEFAULT_TZ;
  const durationMs = durationMins * 60000;
  let current = new Date(candidate);
  const MAX_ITER = 500;

  for (let iterations = 0; iterations < MAX_ITER; iterations++) {
    // 1. Advance past closed days
    if (restr?.closedDays?.length) {
      let dayChecks = 0;
      while (restr.closedDays.includes(getZoneParts(current, tz).weekday) && dayChecks++ < 8) {
        const p = getZoneParts(current, tz);
        const [h, m] = (restr.silentEnd || '06:30').split(':').map(Number);
        current = zonedTimeToDate(p.year, p.month, p.day + 1, h, m || 0, tz);
      }
    }

    // 2. Advance past silent hours
    if (restr?.silentStart && restr?.silentEnd) {
      if (isInSilentHours(current, restr.silentStart, restr.silentEnd, tz)) {
        current = advanceToSilentEnd(current, restr.silentEnd, tz);
        continue; // re-check closed days
      }
    }

    // 3. Check closures
    let hitClosure = false;
    for (const cl of closures || []) {
      const [sy, sm, sd] = cl.startDate.split('-').map(Number);
      const [ey, em, ed] = cl.endDate.split('-').map(Number);
      const clStart = zonedTimeToDate(sy, sm, sd, 0, 0, tz);
      const clEnd = zonedTimeToDate(ey, em, ed, 23, 59, tz);
      if (current >= clStart && current <= clEnd) {
        const [h, m] = (restr.silentEnd || '06:30').split(':').map(Number);
        current = zonedTimeToDate(ey, em, ed + 1, h, m || 0, tz);
        hitClosure = true;
        break;
      }
    }
    if (hitClosure) continue;

    // 4. Check job overlaps (including buffers)
    const myStart = current.getTime() - warmUpMs;
    const myEnd = current.getTime() + durationMs + coolDownMs;
    let hitJob = false;
    for (const j of jobs || []) {
      if (!j.start) continue;
      const jStartDate = parseJobTime(j.start, tz);
      const jEndDate = parseJobTime(j.end, tz);
      if (!jStartDate || !jEndDate) continue;
      // The gap after an existing job uses THAT job's own cool-down (the
      // finishing print it belongs to), falling back to the candidate default.
      // Its leading warm-up buffer likewise uses THAT job's own warm-up.
      const jCoolDownMs = j.coolDownMs != null ? j.coolDownMs : coolDownMs;
      const jWarmUpMs = j.warmUpMs != null ? j.warmUpMs : warmUpMs;
      const jStart = jStartDate.getTime() - jWarmUpMs;
      const jEnd = jEndDate.getTime() + jCoolDownMs;
      if (myStart < jEnd && myEnd > jStart) {
        current = new Date(jEndDate.getTime() + jCoolDownMs + warmUpMs);
        hitJob = true;
        break;
      }
    }
    if (hitJob) continue;

    return current;
  }

  return new Date(candidate.getTime() + 86400000);
}

/**
 * Push back a chain of jobs on a single printer.
 *
 * @param {Array} chain       Jobs to push, ordered by start ascending. chain[0] is the "anchor"
 *                            (the job the user right-clicked). Each element: {id, start, end}.
 * @param {Date}  to          New start time for the anchor. Silent hours may push it further.
 * @param {object} restr      Scheduling restrictions (silent hours/days/timezone).
 * @param {Array}  closures   Closure ranges (same shape as findNextValidStart).
 * @param {Array}  otherJobs  Jobs on the same printer that are NOT in the chain. Used for
 *                            overlap avoidance (e.g. a Printing job or a job on an earlier day).
 * @param {number} warmUpMs   Pre-processing buffer in ms.
 * @param {number} coolDownMs Post-processing buffer in ms.
 * @returns {Array<{id, start, end}>} updates to persist. Chain stops at the first job that
 *                                    doesn't need to move (gap is wide enough to absorb).
 */
function pushBackChain(chain, to, restr, closures, otherJobs, warmUpMs, coolDownMs) {
  const tz = restr?.timezone || DEFAULT_TZ;
  const updates = [];
  let prevEndMs = null;
  let prevCoolDownMs = null;

  for (let i = 0; i < chain.length; i++) {
    const job = chain[i];
    const myCoolDownMs = job.coolDownMs != null ? job.coolDownMs : coolDownMs;
    const myWarmUpMs = job.warmUpMs != null ? job.warmUpMs : warmUpMs;
    const origStartMs = parseJobTime(job.start, tz).getTime();
    const origEndMs = parseJobTime(job.end, tz).getTime();
    const durationMs = origEndMs - origStartMs;
    const durationMins = Math.round(durationMs / 60000);

    const candidate = i === 0
      ? new Date(to.getTime())
      : new Date(prevEndMs + prevCoolDownMs + myWarmUpMs);

    const newStart = findNextValidStart(candidate, durationMins, restr, closures, otherJobs, myWarmUpMs, myCoolDownMs);

    // If the chained job doesn't actually need to move, the gap absorbed the push — stop.
    if (newStart.getTime() <= origStartMs) {
      break;
    }

    const newEnd = new Date(newStart.getTime() + durationMs);
    updates.push({ id: job.id, start: newStart.toISOString(), end: newEnd.toISOString() });
    prevEndMs = newEnd.getTime();
    prevCoolDownMs = myCoolDownMs;
  }

  return updates;
}

/**
 * Pull a chain of jobs FORWARD (toward earlier times) so they're tight-packed
 * starting at `to`. The user's use case is "I rearranged things manually and
 * now there are gaps" or "I'm starting an extra job during silent hours
 * because I'm working late and want everything after it to slide back into
 * place". Opposite of pushBackChain.
 *
 * @param {Array}  chain       Jobs to pull, ordered by start ascending. chain[0] is
 *                             the anchor (the right-clicked job). Each: {id, start, end}.
 * @param {Date}   to          New start time for the anchor. Silent hours / closures
 *                             may advance it later via findNextValidStart.
 * @param {object} restr       Scheduling restrictions.
 * @param {Array}  closures    Closure ranges.
 * @param {Array}  otherJobs   Jobs on the same printer not in the chain. Used for
 *                             overlap avoidance (e.g. jobs before `to`, or jobs
 *                             beyond the window that stay put).
 * @param {number} warmUpMs    Warm-up buffer in ms.
 * @param {number} coolDownMs  Cool-down buffer in ms.
 * @returns {Array<{id, start, end}>} updates to persist. The cascade stops
 *                                    at the first job that can't actually be
 *                                    pulled earlier — that happens when its
 *                                    new tight-packed slot would land at or
 *                                    after its current start (e.g. silent
 *                                    hours pushed it forward). Any jobs
 *                                    beyond that point are left alone.
 */
function pullForwardChain(chain, to, restr, closures, otherJobs, warmUpMs, coolDownMs) {
  const tz = restr?.timezone || DEFAULT_TZ;
  const updates = [];
  let prevEndMs = null;
  let prevCoolDownMs = null;

  for (let i = 0; i < chain.length; i++) {
    const job = chain[i];
    const myCoolDownMs = job.coolDownMs != null ? job.coolDownMs : coolDownMs;
    const myWarmUpMs = job.warmUpMs != null ? job.warmUpMs : warmUpMs;
    const origStartMs = parseJobTime(job.start, tz).getTime();
    const origEndMs = parseJobTime(job.end, tz).getTime();
    const durationMs = origEndMs - origStartMs;
    const durationMins = Math.round(durationMs / 60000);

    const candidate = i === 0
      ? new Date(to.getTime())
      : new Date(prevEndMs + prevCoolDownMs + myWarmUpMs);

    const newStart = findNextValidStart(
      candidate, durationMins, restr, closures, otherJobs, myWarmUpMs, myCoolDownMs
    );

    // Pull-forward only moves jobs EARLIER. If findNextValidStart ends up
    // placing this job at or after its current position (silent hours,
    // closures, other jobs in the way), stop the cascade — leave this job
    // and everything after it alone.
    if (newStart.getTime() >= origStartMs) break;

    const newEnd = new Date(newStart.getTime() + durationMs);
    updates.push({ id: job.id, start: newStart.toISOString(), end: newEnd.toISOString() });
    prevEndMs = newEnd.getTime();
    prevCoolDownMs = myCoolDownMs;
  }

  return updates;
}

module.exports = {
  DEFAULT_TZ,
  MAX_COPIES,
  expandPlateCopies,
  timeToMinutes,
  getZoneParts,
  tzOffset,
  zonedTimeToDate,
  parseJobTime,
  isInSilentHours,
  advanceToSilentEnd,
  findNextValidStart,
  pushBackChain,
  pullForwardChain,
};
