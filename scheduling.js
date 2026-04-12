// Pure scheduling helpers — no DB, no Express. Imported by server.js and tests.

const DEFAULT_TZ = 'Europe/Brussels';

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
 * @param {Array<{start:string, end:string}>}         jobs      ISO start/end, ordered by start.
 * @param {number} warmUpMs      Warm-up buffer in ms.
 * @param {number} coolDownMs    Cool-down buffer in ms.
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
      const jStart = new Date(j.start).getTime() - warmUpMs;
      const jEnd = new Date(j.end).getTime() + coolDownMs;
      if (myStart < jEnd && myEnd > jStart) {
        current = new Date(new Date(j.end).getTime() + coolDownMs + warmUpMs);
        hitJob = true;
        break;
      }
    }
    if (hitJob) continue;

    return current;
  }

  return new Date(candidate.getTime() + 86400000);
}

module.exports = {
  DEFAULT_TZ,
  timeToMinutes,
  getZoneParts,
  tzOffset,
  zonedTimeToDate,
  isInSilentHours,
  advanceToSilentEnd,
  findNextValidStart,
};
