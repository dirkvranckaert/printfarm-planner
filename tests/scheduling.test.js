const {
  getZoneParts,
  tzOffset,
  zonedTimeToDate,
  isInSilentHours,
  advanceToSilentEnd,
  findNextValidStart,
} = require('../scheduling');

const TZ = 'Europe/Brussels';

// Helper: build a UTC Date from ISO string, to avoid any server-local parsing.
const utc = (iso) => new Date(iso);

describe('zonedTimeToDate', () => {
  test('summer wall-time 06:30 Brussels → 04:30Z (CEST, UTC+2)', () => {
    expect(zonedTimeToDate(2026, 4, 13, 6, 30, TZ).toISOString()).toBe('2026-04-13T04:30:00.000Z');
  });

  test('winter wall-time 06:30 Brussels → 05:30Z (CET, UTC+1)', () => {
    expect(zonedTimeToDate(2026, 1, 13, 6, 30, TZ).toISOString()).toBe('2026-01-13T05:30:00.000Z');
  });

  test('round-trip: zoned parts of the computed instant match the requested wall time', () => {
    const d = zonedTimeToDate(2026, 4, 13, 6, 30, TZ);
    const p = getZoneParts(d, TZ);
    expect(p).toMatchObject({ year: 2026, month: 4, day: 13, hour: 6, minute: 30 });
  });

  test('DST spring-forward: Brussels gap at 02:30 on 2026-03-29 still yields a valid UTC instant', () => {
    // 02:00-03:00 local is skipped. We accept that both 01:30Z (pre-jump) and 00:30Z (post-shift)
    // are reasonable outputs; what we care about is that it doesn't land 2h off.
    const d = zonedTimeToDate(2026, 3, 29, 2, 30, TZ);
    const diffHours = Math.abs(d.getTime() - Date.UTC(2026, 2, 29, 1, 30)) / 3600000;
    expect(diffHours).toBeLessThanOrEqual(1);
  });

  test('works for UTC timezone', () => {
    expect(zonedTimeToDate(2026, 4, 13, 6, 30, 'UTC').toISOString()).toBe('2026-04-13T06:30:00.000Z');
  });

  // Regression: the first fix I shipped had a convergence loop that re-applied the
  // tz offset on every pass (stopping when offset===0, which never happens for non-UTC).
  // That made silent-end 06:30 Brussels resolve to 04:30 Brussels, which in turn caused
  // auto-scheduled jobs to land at 22:40 *inside* the silent window. Pin it here.
  test('REGRESSION: does not double-apply TZ offset (06:30 Brussels ≠ 02:30Z or 04:30 Brussels)', () => {
    const d = zonedTimeToDate(2026, 4, 13, 6, 30, TZ);
    expect(d.toISOString()).not.toBe('2026-04-13T02:30:00.000Z');
    const parts = getZoneParts(d, TZ);
    expect(parts.hour).toBe(6);
    expect(parts.minute).toBe(30);
  });
});

describe('tzOffset', () => {
  test('Brussels is UTC+2 in July', () => {
    expect(tzOffset(Date.UTC(2026, 6, 15, 12, 0), TZ)).toBe(2 * 3600000);
  });
  test('Brussels is UTC+1 in January', () => {
    expect(tzOffset(Date.UTC(2026, 0, 15, 12, 0), TZ)).toBe(3600000);
  });
  test('UTC offset is zero', () => {
    expect(tzOffset(Date.UTC(2026, 6, 15, 12, 0), 'UTC')).toBe(0);
  });
});

describe('isInSilentHours', () => {
  test('22:40 Brussels is inside 21:00–06:30 overnight window', () => {
    // 22:40 Brussels in April = 20:40 UTC (CEST)
    const d = utc('2026-04-13T20:40:00Z');
    expect(isInSilentHours(d, '21:00', '06:30', TZ)).toBe(true);
  });

  test('15:30 Brussels is outside the silent window', () => {
    const d = utc('2026-04-13T13:30:00Z'); // 15:30 Brussels
    expect(isInSilentHours(d, '21:00', '06:30', TZ)).toBe(false);
  });

  test('06:30 Brussels (exactly silent-end) is outside the window', () => {
    const d = utc('2026-04-13T04:30:00Z'); // 06:30 Brussels
    expect(isInSilentHours(d, '21:00', '06:30', TZ)).toBe(false);
  });

  test('05:00 Brussels is inside the overnight window', () => {
    const d = utc('2026-04-13T03:00:00Z');
    expect(isInSilentHours(d, '21:00', '06:30', TZ)).toBe(true);
  });

  test('daytime window 09:00–17:00 treats 08:30 as outside, 12:00 as inside', () => {
    expect(isInSilentHours(utc('2026-04-13T06:30:00Z'), '09:00', '17:00', TZ)).toBe(false); // 08:30 local
    expect(isInSilentHours(utc('2026-04-13T10:00:00Z'), '09:00', '17:00', TZ)).toBe(true);  // 12:00 local
  });

  // Regression: the original bug used Date.getHours() which runs in the server's local TZ.
  // On a UTC VPS that caused all Brussels-time calculations to be 2h off.
  test('REGRESSION: UTC server clock does not affect Brussels silent-window detection', () => {
    // 07:00 UTC is 09:00 Brussels in summer — outside the 21:00–06:30 window.
    const d = utc('2026-04-13T07:00:00Z');
    expect(isInSilentHours(d, '21:00', '06:30', TZ)).toBe(false);
  });
});

describe('advanceToSilentEnd', () => {
  test('22:40 Brussels advances to next-day 06:30 Brussels', () => {
    const d = utc('2026-04-13T20:40:00Z'); // Mon 22:40 Brussels (CEST)
    const next = advanceToSilentEnd(d, '06:30', TZ);
    const p = getZoneParts(next, TZ);
    expect(p).toMatchObject({ year: 2026, month: 4, day: 14, hour: 6, minute: 30 });
  });

  test('03:00 Brussels advances to same-day 06:30 Brussels', () => {
    const d = utc('2026-04-13T01:00:00Z'); // 03:00 Brussels
    const next = advanceToSilentEnd(d, '06:30', TZ);
    const p = getZoneParts(next, TZ);
    expect(p).toMatchObject({ year: 2026, month: 4, day: 13, hour: 6, minute: 30 });
  });

  // Regression: original fix produced 08:30 Brussels because it used server-local setHours
  // on a UTC VPS — silent-end 06:30 was being applied in UTC.
  test('REGRESSION: silent-end 06:30 lands at 06:30 Brussels, not 08:30', () => {
    const d = utc('2026-04-13T20:40:00Z');
    const next = advanceToSilentEnd(d, '06:30', TZ);
    const p = getZoneParts(next, TZ);
    expect(p.hour).toBe(6);
    expect(p.hour).not.toBe(8);
  });
});

describe('findNextValidStart', () => {
  const restr = {
    enabled: true,
    silentStart: '21:00',
    silentEnd: '06:30',
    closedDays: [6], // Saturday
    timezone: TZ,
  };
  const warmUp = 5 * 60000;
  const coolDown = 15 * 60000;

  test('candidate at 15:30 Brussels Monday with no jobs → returned as-is', () => {
    const cand = utc('2026-04-13T13:30:00Z'); // Mon 15:30 Brussels
    const result = findNextValidStart(cand, 60, restr, [], [], warmUp, coolDown);
    expect(result.toISOString()).toBe(cand.toISOString());
  });

  test('candidate at 22:40 Brussels → advanced to next-day 06:30 Brussels', () => {
    const cand = utc('2026-04-13T20:40:00Z'); // Mon 22:40 Brussels
    const result = findNextValidStart(cand, 60, restr, [], [], warmUp, coolDown);
    const p = getZoneParts(result, TZ);
    expect(p).toMatchObject({ year: 2026, month: 4, day: 14, hour: 6, minute: 30 });
  });

  test('candidate on Saturday (closed day) → advanced to Sunday 06:30 Brussels', () => {
    const cand = utc('2026-04-11T08:00:00Z'); // Sat 10:00 Brussels
    const result = findNextValidStart(cand, 60, restr, [], [], warmUp, coolDown);
    const p = getZoneParts(result, TZ);
    expect(p.weekday).toBe(0); // Sunday
    expect(p.hour).toBe(6);
    expect(p.minute).toBe(30);
  });

  test('overlap with existing job advances past it', () => {
    const cand = utc('2026-04-13T08:00:00Z'); // Mon 10:00 Brussels
    const jobs = [{ start: '2026-04-13T09:00:00Z', end: '2026-04-13T10:00:00Z' }];
    const result = findNextValidStart(cand, 60, restr, [], jobs, warmUp, coolDown);
    // Advances to jobEnd + coolDown + warmUp = 10:00Z + 15m + 5m = 10:20Z
    expect(result.toISOString()).toBe('2026-04-13T10:20:00.000Z');
  });

  test('closure blocks candidate and advances to day after closure end at silent-end', () => {
    const cand = utc('2026-04-13T08:00:00Z'); // Mon 10:00 Brussels
    const closures = [{ startDate: '2026-04-13', endDate: '2026-04-14' }];
    const result = findNextValidStart(cand, 60, restr, closures, [], warmUp, coolDown);
    const p = getZoneParts(result, TZ);
    expect(p).toMatchObject({ year: 2026, month: 4, day: 15, hour: 6, minute: 30 });
  });

  // Regression: this is the exact production bug — jobs auto-scheduled at 22:40
  // while silent hours said 21:00–06:30. The scheduler must never return a start
  // that is inside the configured silent window.
  test('REGRESSION: never returns a start inside the silent window', () => {
    // Candidates sampled across a full day in Brussels.
    for (let h = 0; h < 24; h++) {
      const cand = zonedTimeToDate(2026, 4, 13, h, 0, TZ);
      const result = findNextValidStart(cand, 60, restr, [], [], warmUp, coolDown);
      expect(isInSilentHours(result, '21:00', '06:30', TZ)).toBe(false);
    }
  });

  // Regression: on a UTC VPS, silent-end 06:30 used to resolve to 08:30 Brussels
  // because setHours() used the server's local TZ.
  test('REGRESSION: silent-end produces a start at 06:30 Brussels (not 08:30) regardless of server TZ', () => {
    const cand = utc('2026-04-13T20:40:00Z'); // in silent window
    const result = findNextValidStart(cand, 60, restr, [], [], warmUp, coolDown);
    expect(getZoneParts(result, TZ).hour).toBe(6);
  });
});
