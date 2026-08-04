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

// Statuses/flags that make a job movable by the reshove / pull-forward planner.
// Mirrors server.js classifyForReshove: a Planned/Awaiting job that is neither
// printer-linked nor locked can be shoved; everything else is immovable.
const MOVABLE_STATUSES = new Set(['Planned', 'Awaiting']);
function isImmovableJob(j) {
  return !(MOVABLE_STATUSES.has(j.status) && j.linked_printer_id == null && !j.locked);
}

/**
 * First UNAVAILABLE instant strictly after `from` (which must itself be an
 * available/working instant). Availability is exactly what findNextValidStart
 * gates on — silent hours, closed weekdays and closure ranges — so this is the
 * soonest of: the next silent-window start, the next closed-day midnight, and the
 * next closure start. Returns a far-future instant when nothing is configured.
 * Companion to findNextValidStart (which finds the next AVAILABLE instant); the
 * two together let availableMsBetween walk working time without re-deriving the
 * timezone / silent-hours math.
 */
function nextUnavailableStart(from, restr, closures) {
  const tz = restr?.timezone || DEFAULT_TZ;
  const fromMs = from.getTime();
  const cands = [];
  if (restr?.silentStart && restr?.silentEnd) {
    const [sh, sm] = restr.silentStart.split(':').map(Number);
    const p = getZoneParts(from, tz);
    let s = zonedTimeToDate(p.year, p.month, p.day, sh, sm || 0, tz);
    if (s.getTime() <= fromMs) s = zonedTimeToDate(p.year, p.month, p.day + 1, sh, sm || 0, tz);
    cands.push(s.getTime());
  }
  if (restr?.closedDays?.length) {
    for (let d = 0; d <= 8; d++) {
      const probe = new Date(fromMs + d * 86400000);
      const pp = getZoneParts(probe, tz);
      if (restr.closedDays.includes(pp.weekday)) {
        const midnight = zonedTimeToDate(pp.year, pp.month, pp.day, 0, 0, tz);
        if (midnight.getTime() > fromMs) { cands.push(midnight.getTime()); break; }
      }
    }
  }
  for (const cl of closures || []) {
    const [sy, sm2, sd] = cl.startDate.split('-').map(Number);
    const clStart = zonedTimeToDate(sy, sm2, sd, 0, 0, tz);
    if (clStart.getTime() > fromMs) cands.push(clStart.getTime());
  }
  if (!cands.length) return new Date(fromMs + 30 * 86400000);
  return new Date(Math.min(...cands));
}

/**
 * Working-time (available) milliseconds between two instants: the wall-clock span
 * [t1, t2] MINUS any silent-hours / closed-day / closure time inside it. Reuses
 * findNextValidStart to skip non-available regions, so "available" means exactly
 * what the scheduler places jobs in.
 *
 * Used by the pull-forward "move following chain" selection: a pair of jobs
 * "closely follows" when the working gap between them is small even if a large
 * chunk of silent/closed clock time sits in between (e.g. a job ending 01:00 and
 * the next starting the following 06:30 has a ZERO working gap).
 */
function availableMsBetween(t1, t2, restr, closures) {
  const endMs = t2.getTime();
  if (endMs <= t1.getTime()) return 0;
  let total = 0;
  let cursor = t1;
  let guard = 0;
  while (cursor.getTime() < endMs && guard++ < 2000) {
    const runStart = findNextValidStart(cursor, 0, restr, closures, [], 0, 0);
    if (runStart.getTime() >= endMs) break;
    const runEnd = nextUnavailableStart(runStart, restr, closures);
    const spanEnd = Math.min(runEnd.getTime(), endMs);
    total += spanEnd - runStart.getTime();
    cursor = runEnd;
  }
  return total;
}

/**
 * Select the anchor's following "tightly-packed run" for a pull-forward block move.
 *
 * Walks the same-printer jobs AFTER the anchor in start order and returns the
 * maximal contiguous run of movable jobs where each consecutive pair's
 * working-time gap (silent hours / closed days excluded, via availableMsBetween)
 * is <= maxGapMs. Selection STOPS — and the terminator is NOT included — at the
 * first job whose working gap exceeds maxGapMs OR that is immovable (locked /
 * Printing / Awaiting Printer / printer-linked / Done / Paused). An immovable job
 * is a HARD terminator: nothing after it is selected either.
 *
 * @param {object} anchor     { start, end } of the anchor (right-clicked job).
 * @param {Array}  laterJobs  Same-printer jobs with start > anchor.start, each
 *                            carrying start/end + status/locked/linked_printer_id.
 * @param {object} restr      Scheduling restrictions.
 * @param {Array}  closures   Closure ranges.
 * @param {number} maxGapMs   Working-gap threshold (default 30 min).
 * @returns {Array} the selected followers in start order (excludes the anchor).
 */
function selectFollowingChain(anchor, laterJobs, restr, closures, maxGapMs = 30 * 60000) {
  const tz = restr?.timezone || DEFAULT_TZ;
  const sorted = [...(laterJobs || [])]
    .filter(j => j.start)
    .sort((a, b) => parseJobTime(a.start, tz).getTime() - parseJobTime(b.start, tz).getTime());
  const chain = [];
  let prevEnd = parseJobTime(anchor.end, tz);
  for (const job of sorted) {
    if (isImmovableJob(job)) break; // hard terminator: stop, do not include
    const jStart = parseJobTime(job.start, tz);
    const gap = availableMsBetween(prevEnd, jStart, restr, closures);
    if (gap > maxGapMs) break;
    chain.push(job);
    prevEnd = parseJobTime(job.end, tz);
  }
  return chain;
}

/**
 * Plan a "reshove" move: place the anchor VERBATIM at `to` and push every movable
 * job from that slot onward back one-by-one so the schedule stays tightly packed.
 * Used when a timed move (push-back-to / push-forward-to / to-now) can't land at
 * the requested slot because a movable job already occupies it — the caller first
 * checks `needsReshove` to decide whether to prompt the user, then applies
 * `updates` only after they confirm.
 *
 * The anchor is the user's explicit manual override, so it lands EXACTLY at `to`
 * with NO availability check — even inside silent hours or on a closed day. That
 * is the whole point of the override. Only the CASCADED jobs are availability
 * aware: each is placed through `findNextValidStart`, so they skip forward over
 * silent hours, closed days and closures (which is what can make the cascade run
 * far past the anchor's original position). The anchor never yields to a movable
 * job (those get pushed out of the way); movable jobs still route around immovable
 * jobs (a running or printer-linked print can't be shoved) via the `fixed` set.
 *
 * @param {object} anchor      The moved job: { id, start, end, coolDownMs?, warmUpMs? }.
 * @param {Date}   to          Requested new start for the anchor (placed verbatim).
 * @param {object} restr       Scheduling restrictions { silentStart, silentEnd, closedDays, timezone }.
 * @param {Array}  closures    Closure ranges [{ startDate, endDate }].
 * @param {Array}  movable     Cascadable jobs on the printer EXCLUDING the anchor
 *                             (Planned/Awaiting, not printer-linked). Each
 *                             { id, start, end, coolDownMs?, warmUpMs? }.
 * @param {Array}  fixed       Immovable jobs on the printer (Printing / Awaiting
 *                             Printer / linked / Done / Paused). Obstacles the
 *                             cascade routes around but never moves.
 * @param {number} warmUpMs    Anchor warm-up fallback (ms).
 * @param {number} coolDownMs  Anchor cool-down fallback (ms).
 * @param {Array}  chainFollowers  OPTIONAL. The pull-forward "move following chain"
 *                             block: jobs selected by selectFollowingChain that
 *                             travel WITH the anchor (packed right behind it,
 *                             availability-aware) instead of being reshoved. They
 *                             are excluded from the reshove pool and ALWAYS move
 *                             (the user asked to pull the whole block forward), so
 *                             `needsReshove` counts only NON-chain jobs that had to
 *                             yield. Defaults to [] → classic single-anchor reshove.
 * @returns {{ needsReshove: boolean, anchorStart: string, updates: Array<{id,start,end}> }}
 *          `updates[0]` is always the anchor at its verbatim slot; then the chain
 *          followers in order; then the cascaded non-chain jobs. `needsReshove` is
 *          true iff placing the block forces at least one NON-chain movable job to
 *          move — i.e. the slot was occupied and a reshuffle is required.
 */
function planReshove(anchor, to, restr, closures, movable, fixed, warmUpMs, coolDownMs, chainFollowers = []) {
  const tz = restr?.timezone || DEFAULT_TZ;
  const aWarmMs = anchor.warmUpMs != null ? anchor.warmUpMs : warmUpMs;
  const aCoolMs = anchor.coolDownMs != null ? anchor.coolDownMs : coolDownMs;
  const aStartMs = parseJobTime(anchor.start, tz).getTime();
  const aEndMs = parseJobTime(anchor.end, tz).getTime();
  const aDurMs = aEndMs - aStartMs;

  const toMs = to.getTime();
  const startMs = (j) => parseJobTime(j.start, tz).getTime();
  const endMsOf = (j) => parseJobTime(j.end, tz).getTime();
  const coolOf = (j) => (j.coolDownMs != null ? j.coolDownMs : coolDownMs);
  const warmOf = (j) => (j.warmUpMs != null ? j.warmUpMs : warmUpMs);

  // Chain followers travel WITH the anchor as one pulled-forward block. Exclude
  // them from the reshove pool so they are never double-counted as movers.
  const followers = chainFollowers || [];
  const followerIds = new Set(followers.map((f) => f.id));
  const movableList = (movable || []).filter((j) => !followerIds.has(j.id));

  // Obstacles the cascade routes around but never moves. Block followers avoid
  // these too — an immovable job can never be packed over.
  const obstacles = [...(fixed || [])];

  // The anchor's own buffered footprint at the requested slot.
  const aBufStart = toMs - aWarmMs;
  const aBufEnd = toMs + aDurMs + aCoolMs;
  // A job's buffered interval [start - warmUp, end + coolDown].
  const bufInterval = (j) => [startMs(j) - warmOf(j), endMsOf(j) + coolOf(j)];
  const overlapsAnchor = (j) => {
    const [s, e] = bufInterval(j);
    return aBufStart < e && aBufEnd > s;
  };

  // Anchor: verbatim at the requested slot. No availability snap — manual override.
  const anchorStart = new Date(toMs);
  const anchorEnd = new Date(toMs + aDurMs);
  const updates = [{ id: anchor.id, start: anchorStart.toISOString(), end: anchorEnd.toISOString() }];

  // Lay the selected followers down right behind the anchor, availability-aware.
  // They ALWAYS move (pull the whole block forward), so — unlike the reshove
  // cascade below — there is no "gap absorbed it" early-out here.
  let prevEndMs = anchorEnd.getTime();
  let prevCoolMs = aCoolMs;
  for (const job of followers) {
    const myCoolMs = coolOf(job);
    const myWarmMs = warmOf(job);
    const durMs = endMsOf(job) - startMs(job);
    const durMins = Math.round(durMs / 60000);
    const candidate = new Date(prevEndMs + prevCoolMs + myWarmMs);
    const newStart = findNextValidStart(candidate, durMins, restr, closures, obstacles, myWarmMs, myCoolMs);
    const newEnd = new Date(newStart.getTime() + durMs);
    updates.push({ id: job.id, start: newStart.toISOString(), end: newEnd.toISOString() });
    prevEndMs = newEnd.getTime();
    prevCoolMs = myCoolMs;
  }
  // The placed block's buffered footprint end (anchor alone when no followers).
  const blockBufEnd = prevEndMs + prevCoolMs;
  const overlapsBlock = (j) => {
    const [s, e] = bufInterval(j);
    return aBufStart < e && blockBufEnd > s;
  };

  // Partition the remaining (non-chain) movable jobs into MOVERS (must reshove)
  // and OBSTACLES (stay put). A job moves if it starts at/after the target OR its
  // buffered print interval intersects the placed block's buffered footprint — a
  // job that starts before `to` but spans it is in the way and must be shoved.
  const movers = [];
  for (const j of movableList) {
    if (!j.start) { obstacles.push(j); continue; }
    if (startMs(j) >= toMs || overlapsBlock(j)) movers.push(j);
    else obstacles.push(j);
  }
  movers.sort((a, b) => startMs(a) - startMs(b));

  // Cascade: pack each mover right behind the block. Each placement is
  // availability-aware. Stop once a job's tight-packed slot lands at or before its
  // current start — the gap absorbed the shove and nothing further needs to move.
  const blockLen = updates.length; // anchor + followers
  for (const job of movers) {
    const myCoolMs = coolOf(job);
    const myWarmMs = warmOf(job);
    const jStartMs = startMs(job);
    const durMs = endMsOf(job) - jStartMs;
    const durMins = Math.round(durMs / 60000);

    const candidate = new Date(prevEndMs + prevCoolMs + myWarmMs);
    const newStart = findNextValidStart(candidate, durMins, restr, closures, obstacles, myWarmMs, myCoolMs);
    if (newStart.getTime() <= jStartMs) break;

    const newEnd = new Date(newStart.getTime() + durMs);
    updates.push({ id: job.id, start: newStart.toISOString(), end: newEnd.toISOString() });
    prevEndMs = newEnd.getTime();
    prevCoolMs = myCoolMs;
  }

  // A reshuffle (confirm dialog) is needed exactly when placing the block forced
  // at least one NON-chain movable job to move. The block itself moving is the
  // user's explicit intent, not a surprise reshuffle.
  const needsReshove = updates.length > blockLen;
  // The verbatim anchor may overlap an ACTIVE/immovable job (a running or
  // printer-linked print). That job is never moved; flag it so the caller can
  // surface a conflict notice.
  const activeConflict = (fixed || []).some(j =>
    j.start && (j.status === 'Printing' || j.status === 'Awaiting Printer' || j.linked_printer_id != null) && overlapsAnchor(j)
  );
  return { needsReshove, anchorStart: anchorStart.toISOString(), updates, activeConflict };
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
  planReshove,
  isImmovableJob,
  nextUnavailableStart,
  availableMsBetween,
  selectFollowingChain,
};
