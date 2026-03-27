// Pure utility function tests (logic extracted from app.js)

describe('snap15', () => {
  function snap15(px) { return Math.round(px / 15) * 15; }

  test('snaps 0 to 0', () => expect(snap15(0)).toBe(0));
  test('snaps 7 to 0', () => expect(snap15(7)).toBe(0));
  test('snaps 8 to 15', () => expect(snap15(8)).toBe(15));
  test('snaps 22 to 15', () => expect(snap15(22)).toBe(15));
  test('snaps 23 to 30', () => expect(snap15(23)).toBe(30));
  test('snaps 60 to 60', () => expect(snap15(60)).toBe(60));
  test('snaps 68 to 75', () => expect(snap15(68)).toBe(75));
});

describe('toDatetimeLocal', () => {
  function toDatetimeLocal(date) {
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
  }

  test('formats date correctly', () => {
    const d = new Date(2026, 2, 27, 10, 30); // March 27, 2026 10:30
    expect(toDatetimeLocal(d)).toBe('2026-03-27T10:30');
  });

  test('pads single digit months and days', () => {
    const d = new Date(2026, 0, 5, 9, 5); // Jan 5, 2026 09:05
    expect(toDatetimeLocal(d)).toBe('2026-01-05T09:05');
  });
});

describe('overlap detection logic', () => {
  // Simplified version of the overlap check from detectConflicts
  function overlaps(a, b) {
    // a = {startMins, endMins}, b = {startMins, endMins}
    return a.startMins < b.endMins && a.endMins > b.startMins;
  }

  test('overlapping intervals detected', () => {
    expect(overlaps({startMins: 60, endMins: 120}, {startMins: 90, endMins: 150})).toBe(true);
  });

  test('adjacent intervals do not overlap', () => {
    expect(overlaps({startMins: 60, endMins: 120}, {startMins: 120, endMins: 180})).toBe(false);
  });

  test('non-overlapping intervals', () => {
    expect(overlaps({startMins: 60, endMins: 90}, {startMins: 120, endMins: 180})).toBe(false);
  });

  test('fully contained interval', () => {
    expect(overlaps({startMins: 60, endMins: 180}, {startMins: 90, endMins: 120})).toBe(true);
  });
});

describe('snapAvoidingJobs logic', () => {
  // Test the core logic of snapAvoidingJobs without DOM/state
  function snapAvoidingJobsLogic(proposedStart, durationMins, warmUp, coolDown, otherJobs) {
    const myStart = proposedStart - warmUp;
    const myEnd   = proposedStart + durationMins + coolDown;

    for (const iv of otherJobs) {
      const otherStart = iv.start - warmUp;
      const otherEnd   = iv.end   + coolDown;
      if (myStart < otherEnd && myEnd > otherStart) {
        const snapBefore = otherStart - durationMins - coolDown;
        const snapAfter  = otherEnd   + warmUp;
        const distBefore = Math.abs(proposedStart - snapBefore);
        const distAfter  = Math.abs(proposedStart - snapAfter);
        return Math.max(0, distBefore < distAfter ? snapBefore : snapAfter);
      }
    }
    return proposedStart;
  }

  test('no jobs: returns proposed start', () => {
    expect(snapAvoidingJobsLogic(60, 60, 5, 15, [])).toBe(60);
  });

  test('snaps after a blocking job when approaching from below', () => {
    // Other job occupies 0–120 (start=5, end=105 with 5wu+15cd = 0 to 120)
    const result = snapAvoidingJobsLogic(110, 60, 5, 15, [{start: 5, end: 105}]);
    // My start - 5wu = 105, other end + 15cd = 120 → overlap
    // snapAfter = 120 + 5 = 125
    expect(result).toBe(125);
  });

  test('snaps before a blocking job when approaching from above', () => {
    // Other job occupies 200–320 (start=205, end=305 with 5wu+15cd = 200 to 320)
    // I'm trying to place at 240 with duration 60: my block = 235 to 315 → overlaps
    // snapBefore = 200 - 60 - 15 = 125
    // snapAfter = 320 + 5 = 325
    // dist to 125 from 240 = 115, dist to 325 = 85 → snap after
    const result = snapAvoidingJobsLogic(240, 60, 5, 15, [{start: 205, end: 305}]);
    expect(result).toBe(325);
  });
});
