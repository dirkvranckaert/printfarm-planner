const {
  getZoneParts,
  tzOffset,
  zonedTimeToDate,
  isInSilentHours,
  advanceToSilentEnd,
  findNextValidStart,
  pushBackChain,
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

  // Regression: production job rows contain two string formats side-by-side:
  //   - proper ISO with Z suffix ('2026-04-13T04:30:00.000Z')
  //   - naked datetime-local without TZ ('2026-04-13T06:30')
  // On a UTC server, the naked form used to be parsed as UTC, which shifted
  // Brussels-local jobs 2h later and made the overlap check miss them entirely.
  // Naked strings must be interpreted in the configured timezone.
  test('REGRESSION: naked datetime-local strings on jobs are parsed in the configured TZ', () => {
    // 06:30 Brussels, stored naked. Scheduler must treat this as 04:30Z.
    const jobs = [{ start: '2026-04-13T06:30', end: '2026-04-13T14:13' }];
    // Candidate is also 06:30 Brussels (04:30Z) — should detect overlap and advance.
    const cand = utc('2026-04-13T04:30:00Z');
    const result = findNextValidStart(cand, 30, restr, [], jobs, warmUp, coolDown);
    // Must land AFTER the existing job ends at 14:13 Brussels (12:13Z) + 15m cool + 5m warm = 12:33Z
    expect(result.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-04-13T12:33:00Z'));
  });

  // Regression: the exact production state from the pm2 logs.
  test('REGRESSION: Henriegga/Sleutelhanger production scenario — Groen does not land on Henriegga Body', () => {
    const jobs = [
      { start: '2026-04-13T06:30', end: '2026-04-13T14:13' },  // Henriegga Body, naked format
      { start: '2026-04-13T14:33', end: '2026-04-13T15:22' },  // Henriegga Legs, naked format
    ];
    // "First available" at 22:55 Brussels → advances to 06:30 Brussels (04:30Z).
    const cand = utc('2026-04-12T20:55:00Z');
    const result = findNextValidStart(cand, 30, restr, [], jobs, warmUp, coolDown);
    // Must NOT land at 04:30Z (06:30 Brussels) — that would overlap Henriegga Body.
    expect(result.toISOString()).not.toBe('2026-04-13T04:30:00.000Z');
    // Must land after Henriegga Legs ends (15:22 Brussels = 13:22Z) + 20m buffer.
    expect(result.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-04-13T13:42:00Z'));
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

describe('pushBackChain', () => {
  const restr = {
    enabled: true,
    silentStart: '21:00',
    silentEnd: '06:30',
    closedDays: [6],
    timezone: TZ,
  };
  const warmUp = 5 * 60000;
  const coolDown = 15 * 60000;

  // Helper: build a job stored as proper ISO with Z suffix.
  const job = (id, startISO, endISO) => ({ id, start: startISO, end: endISO, status: 'Planned' });

  test('single-job chain: pushes anchor to the requested time', () => {
    const chain = [job(1, '2026-04-13T04:30:00.000Z', '2026-04-13T05:30:00.000Z')]; // 06:30–07:30 Brussels
    const to = utc('2026-04-13T08:00:00.000Z'); // 10:00 Brussels
    const updates = pushBackChain(chain, to, restr, [], [], warmUp, coolDown);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: 1,
      start: '2026-04-13T08:00:00.000Z',
      end: '2026-04-13T09:00:00.000Z',
    });
  });

  test('push to "now" respects silent hours (22:40 → next 06:30 Brussels)', () => {
    const chain = [job(1, '2026-04-13T04:30:00.000Z', '2026-04-13T05:30:00.000Z')];
    const now = utc('2026-04-13T20:40:00.000Z'); // 22:40 Brussels (inside silent window)
    const updates = pushBackChain(chain, now, restr, [], [], warmUp, coolDown);
    expect(updates).toHaveLength(1);
    const p = getZoneParts(new Date(updates[0].start), TZ);
    expect(p).toMatchObject({ year: 2026, month: 4, day: 14, hour: 6, minute: 30 });
  });

  test('cascade: job2 is pushed when its start falls inside the new anchor window', () => {
    // Anchor 08:00–09:00, job2 09:10–10:10 (gap of only 10m, less than warm+cool buffer)
    const chain = [
      job(1, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z'),
      job(2, '2026-04-13T09:10:00.000Z', '2026-04-13T10:10:00.000Z'),
    ];
    const to = utc('2026-04-13T10:00:00.000Z'); // push anchor 2h later
    const updates = pushBackChain(chain, to, restr, [], [], warmUp, coolDown);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ id: 1, start: '2026-04-13T10:00:00.000Z', end: '2026-04-13T11:00:00.000Z' });
    // job2 candidate = anchorEnd + cool+warm = 11:00 + 20m = 11:20
    expect(updates[1]).toMatchObject({ id: 2, start: '2026-04-13T11:20:00.000Z', end: '2026-04-13T12:20:00.000Z' });
  });

  test('cascade stops: gap absorbs the push, later job stays put', () => {
    // Anchor 08:00–09:00, job2 at 14:00–15:00. Pushing anchor by 1h still leaves plenty of gap.
    const chain = [
      job(1, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z'),
      job(2, '2026-04-13T14:00:00.000Z', '2026-04-13T15:00:00.000Z'),
    ];
    const to = utc('2026-04-13T09:00:00.000Z');
    const updates = pushBackChain(chain, to, restr, [], [], warmUp, coolDown);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(1);
  });

  test('cascade: three-job chain pushes in sequence and stops when the gap is big enough', () => {
    const chain = [
      job(1, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z'),
      job(2, '2026-04-13T09:20:00.000Z', '2026-04-13T10:20:00.000Z'), // back-to-back
      job(3, '2026-04-13T14:00:00.000Z', '2026-04-13T14:30:00.000Z'), // big gap
    ];
    const to = utc('2026-04-13T10:00:00.000Z'); // push anchor by 2h
    const updates = pushBackChain(chain, to, restr, [], [], warmUp, coolDown);
    expect(updates.map(u => u.id)).toEqual([1, 2]); // job3 stays put
    expect(updates[1].start).toBe('2026-04-13T11:20:00.000Z');
  });

  test('cascade respects pre/post-processing buffers (5m warm + 15m cool = 20m gap)', () => {
    const chain = [
      job(1, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z'),
      job(2, '2026-04-13T09:19:00.000Z', '2026-04-13T10:19:00.000Z'), // 19m gap — not enough
    ];
    const to = utc('2026-04-13T08:01:00.000Z'); // trivial 1-minute push on anchor
    const updates = pushBackChain(chain, to, restr, [], [], warmUp, coolDown);
    // Anchor pushed by 1m → job2 must be re-fitted with 20m buffer → starts at 09:21
    expect(updates).toHaveLength(2);
    expect(updates[1].start).toBe('2026-04-13T09:21:00.000Z');
  });

  test('cascade crosses midnight into silent hours → job pushed to next-day 06:30', () => {
    // Anchor 19:00–20:00 Brussels (17:00–18:00 UTC, winter would differ). Use summer.
    // 19:00 Brussels CEST = 17:00 UTC.
    const chain = [
      job(1, '2026-04-13T17:00:00.000Z', '2026-04-13T18:00:00.000Z'), // 19:00–20:00 Brussels
      job(2, '2026-04-13T18:20:00.000Z', '2026-04-13T20:20:00.000Z'), // 20:20–22:20 Brussels
    ];
    // Push anchor to 20:30 Brussels = 18:30 UTC
    const to = utc('2026-04-13T18:30:00.000Z');
    const updates = pushBackChain(chain, to, restr, [], [], warmUp, coolDown);
    expect(updates).toHaveLength(2);
    // Anchor: 20:30–21:30 Brussels — but 21:30 is inside silent window for a job that STARTS
    //         at 20:30? No, silent-hours check is on the START only. So anchor stays at 20:30.
    //         Wait — 20:30 is outside the 21:00–06:30 window at the start. OK anchor = 20:30 Brussels.
    expect(getZoneParts(new Date(updates[0].start), TZ).hour).toBe(20);
    // job2 candidate = anchorEnd (21:30 Brussels) + 20m = 21:50 Brussels → inside silent window →
    // advance to next-day 06:30 Brussels.
    const j2p = getZoneParts(new Date(updates[1].start), TZ);
    expect(j2p).toMatchObject({ day: 14, hour: 6, minute: 30 });
  });

  test('otherJobs are respected: pushed job skips a Printing job on the same printer', () => {
    const chain = [job(1, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z')];
    // Another printing job occupying 10:00–11:00.
    const otherJobs = [{ start: '2026-04-13T10:00:00.000Z', end: '2026-04-13T11:00:00.000Z' }];
    const to = utc('2026-04-13T10:00:00.000Z'); // right on top of the Printing job
    const updates = pushBackChain(chain, to, restr, [], otherJobs, warmUp, coolDown);
    // Anchor must skip past the Printing job. Printing end + cool+warm = 11:00 + 20m = 11:20.
    expect(updates[0].start).toBe('2026-04-13T11:20:00.000Z');
  });

  test('no-op when "to" is earlier than the current anchor start', () => {
    const chain = [job(1, '2026-04-13T10:00:00.000Z', '2026-04-13T11:00:00.000Z')];
    const to = utc('2026-04-13T08:00:00.000Z'); // earlier than 10:00
    const updates = pushBackChain(chain, to, restr, [], [], warmUp, coolDown);
    expect(updates).toHaveLength(0);
  });
});
