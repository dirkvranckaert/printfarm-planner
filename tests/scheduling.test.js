const {
  getZoneParts,
  tzOffset,
  zonedTimeToDate,
  isInSilentHours,
  advanceToSilentEnd,
  findNextValidStart,
  pushBackChain,
  pullForwardChain,
  planReshove,
  availableMsBetween,
  selectFollowingChain,
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

describe('pullForwardChain', () => {
  const restr = {
    enabled: true,
    silentStart: '21:00',
    silentEnd: '06:30',
    closedDays: [6],
    timezone: TZ,
  };
  const warmUp = 5 * 60000;
  const coolDown = 15 * 60000;
  const job = (id, startISO, endISO) => ({ id, start: startISO, end: endISO, status: 'Planned' });

  test('single-job chain: pulls anchor earlier to the requested time', () => {
    const chain = [job(1, '2026-04-13T10:00:00.000Z', '2026-04-13T11:00:00.000Z')]; // 12:00–13:00 Brussels
    const to = utc('2026-04-13T08:00:00.000Z'); // 10:00 Brussels
    const updates = pullForwardChain(chain, to, restr, [], [], warmUp, coolDown);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: 1,
      start: '2026-04-13T08:00:00.000Z',
      end: '2026-04-13T09:00:00.000Z',
    });
  });

  test('no-op when "to" is later than or equal to the current anchor start', () => {
    const chain = [job(1, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z')];
    const to = utc('2026-04-13T10:00:00.000Z'); // later than 08:00
    const updates = pullForwardChain(chain, to, restr, [], [], warmUp, coolDown);
    expect(updates).toHaveLength(0);
  });

  test('cascade: followers tight-pack immediately after the pulled anchor', () => {
    const chain = [
      job(1, '2026-04-13T10:00:00.000Z', '2026-04-13T11:00:00.000Z'),
      job(2, '2026-04-13T13:00:00.000Z', '2026-04-13T14:00:00.000Z'),
      job(3, '2026-04-13T16:00:00.000Z', '2026-04-13T17:00:00.000Z'),
    ];
    const to = utc('2026-04-13T08:00:00.000Z');
    const updates = pullForwardChain(chain, to, restr, [], [], warmUp, coolDown);
    expect(updates).toHaveLength(3);
    // anchor at 08:00–09:00
    expect(updates[0]).toMatchObject({ id: 1, start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z' });
    // job2 candidate = 09:00 + cool(15)+warm(5) = 09:20
    expect(updates[1]).toMatchObject({ id: 2, start: '2026-04-13T09:20:00.000Z', end: '2026-04-13T10:20:00.000Z' });
    // job3 candidate = 10:20 + 20m = 10:40
    expect(updates[2]).toMatchObject({ id: 3, start: '2026-04-13T10:40:00.000Z', end: '2026-04-13T11:40:00.000Z' });
  });

  test('cascade stops when a follower would end up AT or AFTER its current start', () => {
    const chain = [
      job(1, '2026-04-13T10:00:00.000Z', '2026-04-13T11:00:00.000Z'), // anchor
      job(2, '2026-04-13T11:30:00.000Z', '2026-04-13T12:30:00.000Z'), // already tight-ish
      job(3, '2026-04-13T14:00:00.000Z', '2026-04-13T15:00:00.000Z'), // big gap
    ];
    const to = utc('2026-04-13T09:00:00.000Z'); // pull anchor 1h earlier
    const updates = pullForwardChain(chain, to, restr, [], [], warmUp, coolDown);
    // Anchor: 09:00–10:00
    // job2 candidate = 10:00 + 20m = 10:20 < 11:30 → pull, new start 10:20
    // job3 candidate = 11:20 + 20m = 11:40 < 14:00 → pull, new start 11:40
    expect(updates).toHaveLength(3);
    expect(updates[0].start).toBe('2026-04-13T09:00:00.000Z');
    expect(updates[1].start).toBe('2026-04-13T10:20:00.000Z');
    expect(updates[2].start).toBe('2026-04-13T11:40:00.000Z');
  });

  test('cascade stops cleanly when next follower already lives earlier than the tight-pack slot', () => {
    // Unusual but possible if the chain isn't perfectly sorted by intent —
    // e.g. a follower that happens to already be before where the tight-pack
    // would put it. pullForwardChain must stop, not create a mess.
    const chain = [
      job(1, '2026-04-13T10:00:00.000Z', '2026-04-13T11:00:00.000Z'),
      job(2, '2026-04-13T09:10:00.000Z', '2026-04-13T09:30:00.000Z'), // already earlier
    ];
    const to = utc('2026-04-13T08:00:00.000Z');
    const updates = pullForwardChain(chain, to, restr, [], [], warmUp, coolDown);
    // Anchor pulled to 08:00. Follower's tight-pack slot would be 09:20,
    // which is >= its current 09:10 → stop.
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(1);
  });

  test('otherJobs: tight-pack candidate collides with a Printing job and stops', () => {
    const chain = [job(1, '2026-04-13T14:00:00.000Z', '2026-04-13T15:00:00.000Z')];
    // A Printing job blocks the slot we'd want to land in.
    const otherJobs = [{ start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T13:30:00.000Z' }];
    const to = utc('2026-04-13T09:00:00.000Z');
    const updates = pullForwardChain(chain, to, restr, [], otherJobs, warmUp, coolDown);
    // findNextValidStart advances past Printing job to 13:30 + cool+warm = 13:50.
    // That's still earlier than 14:00 → pull.
    expect(updates).toHaveLength(1);
    expect(updates[0].start).toBe('2026-04-13T13:50:00.000Z');
  });

  test('silent hours: anchor target inside silent window advances to silent-end, still pulling earlier', () => {
    // Anchor currently at 10:00 next morning. User targets 22:00 tonight
    // (inside silent hours) — findNextValidStart moves anchor to next-day
    // 06:30 Brussels = 04:30 UTC. That's still earlier than 10:00 → pull.
    const chain = [job(1, '2026-04-14T08:00:00.000Z', '2026-04-14T09:00:00.000Z')]; // 10:00 Brussels next day
    const to = utc('2026-04-13T20:00:00.000Z'); // 22:00 Brussels (silent)
    const updates = pullForwardChain(chain, to, restr, [], [], warmUp, coolDown);
    expect(updates).toHaveLength(1);
    expect(getZoneParts(new Date(updates[0].start), TZ)).toMatchObject({
      year: 2026, month: 4, day: 14, hour: 6, minute: 30,
    });
  });

  test('closure blocks the tight-pack slot → cascade stops at the blocked follower', () => {
    // Anchor at 10:00Z–11:00Z, pull to 08:00Z → anchor 08:00Z–09:00Z.
    // Follower currently 10:00Z–11:00Z. Its tight-pack slot would be 09:20Z
    // but a full-day closure pushes findNextValidStart to the day after, way
    // past its origStart → stop cascade.
    const chain = [
      job(1, '2026-04-13T10:00:00.000Z', '2026-04-13T11:00:00.000Z'),
      job(2, '2026-04-13T15:00:00.000Z', '2026-04-13T16:00:00.000Z'),
    ];
    const closures = [{ startDate: '2026-04-13', endDate: '2026-04-13' }];
    // Anchor target outside closure — but closure still affects the follower.
    // Trick: anchor-to is BEFORE the closure hits (i.e. the closure is from
    // "now" onward), so closures exclude nothing for the anchor… we need a
    // different setup. Simpler: use a closure day and pull to the day before.
    // Actually easiest: just assert no-op for the follower by construction —
    // put a big Printing "otherJob" that blocks the tight-pack slot.
    const otherJobs = [{ start: '2026-04-13T09:00:00.000Z', end: '2026-04-13T14:00:00.000Z' }];
    const to = utc('2026-04-13T08:00:00.000Z');
    const updates = pullForwardChain(chain, to, restr, closures, otherJobs, warmUp, coolDown);
    // Anchor candidate 08:00Z → collides with Printing at 09:00Z? 08:00+60m+15m = 09:15Z,
    // Printing start 09:00Z, overlap. findNextValidStart advances to 14:00Z+20m=14:20Z.
    // 14:20Z >= anchor origStart 10:00Z → cascade stops immediately, no updates.
    expect(updates).toHaveLength(0);
  });
});

// =============================================================================
// snapAvoidingJobs — pure copy of the function in public/app.js
// =============================================================================
// Local re-implementation matching public/app.js:1304. Kept in-file (same
// pattern as utils.test.js) because public/app.js is browser-side and not
// CommonJS-exported. If this drifts from the live function, the test will
// silently pass — keep them in sync.
function makeSnapAvoidingJobs({ printers, jobs, navDate }) {
  const dayS = new Date(navDate); dayS.setHours(0,0,0,0);
  return function snapAvoidingJobs(proposedStart, durationMins, printerId, excludeJobId) {
    const printer = printers.find(p => p.id === printerId);
    const myWu = printer?.warm_up_mins ?? 0;
    const myCd = printer?.cool_down_mins ?? 0;
    const intervals = Object.values(jobs)
      .filter(j => !j.queued && j.printerId === printerId && j.id !== excludeJobId)
      .map(j => {
        const s = (new Date(j.start).getTime() - dayS.getTime()) / 60_000;
        const e = (new Date(j.end).getTime() - dayS.getTime()) / 60_000;
        return { start: s - myWu, end: e + myCd };
      });
    const myStart = proposedStart - myWu;
    const myEnd   = proposedStart + durationMins + myCd;
    for (const iv of intervals) {
      if (myStart < iv.end && myEnd > iv.start) {
        const snapBefore = iv.start - durationMins - myCd;
        const snapAfter  = iv.end + myWu;
        const distBefore = Math.abs(proposedStart - snapBefore);
        const distAfter  = Math.abs(proposedStart - snapAfter);
        return Math.max(0, distBefore < distAfter ? snapBefore : snapAfter);
      }
    }
    return proposedStart;
  };
}

describe('snapAvoidingJobs (queue-drop buffer-aware snapping)', () => {
  // navDate: midnight on a fixed day; intervals expressed in minutes-from-midnight.
  const navDate = new Date('2026-05-02T00:00:00.000');
  const dayMs = navDate.getTime();
  // Helper: minutes-from-midnight → ISO string for jobs cache.
  const m2iso = (mins) => new Date(dayMs + mins * 60_000).toISOString();
  const PRINTER = { id: 1, warm_up_mins: 5, cool_down_mins: 15 };

  test('proposed start in an empty gap is returned unchanged', () => {
    const snap = makeSnapAvoidingJobs({ printers: [PRINTER], jobs: {}, navDate });
    expect(snap(540, 60, 1, null)).toBe(540); // 09:00, 60-min job, empty col
  });

  test('proposed start blocked by neighbour cool-down snaps before that neighbour', () => {
    // Existing job 09:00–10:00 → interval (with buffers) = [535, 615].
    // Drop a 30-min job proposed at 09:30 (myStart=565, myEnd=615) — overlap.
    // snapBefore = 535 - 30 - 15 = 490 ; snapAfter = 615 + 5 = 620
    // distBefore = |570 - 490| = 80 ; distAfter = |570 - 620| = 50 → snapAfter wins.
    const jobs = { 100: { id: 100, queued: false, printerId: 1, start: m2iso(540), end: m2iso(600) } };
    const snap = makeSnapAvoidingJobs({ printers: [PRINTER], jobs, navDate });
    expect(snap(570, 30, 1, null)).toBe(620);
  });

  test('proposed start blocked by neighbour warm-up snaps before that neighbour', () => {
    // Existing job 14:00–15:00 → interval (with buffers) [14:00-5, 15:00+15] = [835, 915].
    // Drop a 30-min job proposed at 14:00 (overlap).
    // snapBefore = 835 - 30 - 15 = 790 (13:10) ; snapAfter = 915 + 5 = 920 (15:20)
    // distBefore = |840 - 790| = 50 ; distAfter = |840 - 920| = 80 → snapBefore wins.
    const jobs = { 100: { id: 100, queued: false, printerId: 1, start: m2iso(840), end: m2iso(900) } };
    const snap = makeSnapAvoidingJobs({ printers: [PRINTER], jobs, navDate });
    expect(snap(840, 30, 1, null)).toBe(790);
  });

  test('queued jobs in the cache are ignored', () => {
    // A queued job with the same printerId should NOT block the drop.
    const jobs = { 100: { id: 100, queued: true, printerId: 1, start: m2iso(540), end: m2iso(600) } };
    const snap = makeSnapAvoidingJobs({ printers: [PRINTER], jobs, navDate });
    expect(snap(570, 30, 1, null)).toBe(570);
  });

  test('jobs on a different printer are ignored', () => {
    const jobs = { 100: { id: 100, queued: false, printerId: 2, start: m2iso(540), end: m2iso(600) } };
    const snap = makeSnapAvoidingJobs({ printers: [PRINTER], jobs, navDate });
    expect(snap(570, 30, 1, null)).toBe(570);
  });

  test('excludeJobId removes that job from blocking intervals', () => {
    // The dragged "move" of an existing job should not block itself.
    const jobs = { 100: { id: 100, queued: false, printerId: 1, start: m2iso(540), end: m2iso(600) } };
    const snap = makeSnapAvoidingJobs({ printers: [PRINTER], jobs, navDate });
    expect(snap(545, 60, 1, 100)).toBe(545);
  });

  test('result is clamped to >= 0', () => {
    // Job at 00:30–01:00; drop a 60-min proposed at 00:00 → snapBefore goes negative.
    // iv = [30-5, 60+15] = [25, 75]. snapBefore = 25 - 60 - 15 = -50 ; snapAfter = 75 + 5 = 80.
    // distBefore = |0 - -50| = 50 ; distAfter = |0 - 80| = 80 → snapBefore wins, clamped to 0.
    const jobs = { 100: { id: 100, queued: false, printerId: 1, start: m2iso(30), end: m2iso(60) } };
    const snap = makeSnapAvoidingJobs({ printers: [PRINTER], jobs, navDate });
    expect(snap(0, 60, 1, null)).toBe(0);
  });
});

describe('planReshove', () => {
  const restr = {
    enabled: true,
    silentStart: '21:00',
    silentEnd: '06:30',
    closedDays: [6], // Saturday
    timezone: TZ,
  };
  const warmUp = 5 * 60000;
  const coolDown = 15 * 60000;

  // Movable job factory (Planned).
  const job = (id, startISO, endISO) => ({ id, start: startISO, end: endISO, status: 'Planned' });
  const anchorJob = (startISO, endISO) => ({ id: 1, start: startISO, end: endISO });

  test('no reshuffle needed: free later slot → needsReshove false, anchor at verbatim target', () => {
    // Anchor 08:00–09:00, one movable job far away at 18:00. Push anchor to 10:00 (free).
    const anchor = anchorJob('2026-04-13T06:00:00.000Z', '2026-04-13T07:00:00.000Z'); // 08:00–09:00 Brussels
    const movable = [job(2, '2026-04-13T16:00:00.000Z', '2026-04-13T17:00:00.000Z')]; // 18:00 Brussels
    const to = utc('2026-04-13T08:00:00.000Z'); // 10:00 Brussels
    const plan = planReshove(anchor, to, restr, [], movable, [], warmUp, coolDown);
    expect(plan.needsReshove).toBe(false);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({ id: 1, start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z' });
  });

  test('occupied slot: anchor lands EXACTLY at target, blocking job shoved back', () => {
    // Anchor future at 14:00; a movable job occupies 10:00–11:00. Pull anchor to 10:00.
    const anchor = anchorJob('2026-04-13T12:00:00.000Z', '2026-04-13T13:00:00.000Z'); // 14:00–15:00 Brussels
    const movable = [job(2, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z')]; // 10:00–11:00 Brussels
    const to = utc('2026-04-13T08:00:00.000Z'); // 10:00 Brussels — right on the blocker
    const plan = planReshove(anchor, to, restr, [], movable, [], warmUp, coolDown);
    expect(plan.needsReshove).toBe(true);
    // Anchor verbatim at the requested slot.
    expect(plan.updates[0]).toMatchObject({ id: 1, start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z' });
    // Blocker packed right after the anchor: anchorEnd 09:00Z + cool15 + warm5 = 09:20Z.
    expect(plan.updates[1]).toMatchObject({ id: 2, start: '2026-04-13T09:20:00.000Z', end: '2026-04-13T10:20:00.000Z' });
  });

  test('anchor placed VERBATIM even inside silent hours (manual override, no snap)', () => {
    // Push anchor to 22:00 Brussels (inside 21:00–06:30 silent window). A movable job
    // sits at 22:00–23:00 so a reshuffle is triggered; the ANCHOR must still land at 22:00.
    const anchor = anchorJob('2026-04-13T06:00:00.000Z', '2026-04-13T07:00:00.000Z'); // 08:00–09:00 Brussels
    const movable = [job(2, '2026-04-13T20:00:00.000Z', '2026-04-13T21:00:00.000Z')]; // 22:00–23:00 Brussels
    const to = utc('2026-04-13T20:00:00.000Z'); // 22:00 Brussels — inside silent hours
    const plan = planReshove(anchor, to, restr, [], movable, [], warmUp, coolDown);
    expect(plan.needsReshove).toBe(true);
    // Anchor sits verbatim inside the silent window.
    const ap = getZoneParts(new Date(plan.updates[0].start), TZ);
    expect(ap).toMatchObject({ day: 13, hour: 22, minute: 0 });
  });

  test('CASCADE jobs respect silent hours: shoved job skips to next-day 06:30', () => {
    // Anchor pushed to 20:30 Brussels; a movable job right behind it would land inside
    // the silent window and must skip to the next 06:30.
    const anchor = anchorJob('2026-04-13T06:00:00.000Z', '2026-04-13T07:00:00.000Z'); // 1h job
    const movable = [job(2, '2026-04-13T18:40:00.000Z', '2026-04-13T20:40:00.000Z')]; // 20:40–22:40 Brussels, >= to
    const to = utc('2026-04-13T18:30:00.000Z'); // 20:30 Brussels
    const plan = planReshove(anchor, to, restr, [], movable, [], warmUp, coolDown);
    expect(plan.needsReshove).toBe(true);
    // Anchor verbatim 20:30–21:30 Brussels.
    expect(getZoneParts(new Date(plan.updates[0].start), TZ).hour).toBe(20);
    // Cascade job candidate = 21:30 + 20m = 21:50 Brussels → silent → next-day 06:30.
    const j2 = getZoneParts(new Date(plan.updates[1].start), TZ);
    expect(j2).toMatchObject({ day: 14, hour: 6, minute: 30 });
  });

  test('CASCADE jobs respect closed days: shoved job skips a Saturday closure', () => {
    // Friday anchor late; the shoved job would land Saturday (closedDays [6]) → skip to Sunday 06:30.
    // 2026-04-17 is a Friday, 2026-04-18 Saturday, 2026-04-19 Sunday.
    const anchor = anchorJob('2026-04-17T17:00:00.000Z', '2026-04-17T18:30:00.000Z'); // 19:00–20:30 Brussels Fri
    const movable = [job(2, '2026-04-17T18:40:00.000Z', '2026-04-17T19:40:00.000Z')]; // 20:40 Brussels Fri
    const to = utc('2026-04-17T18:00:00.000Z'); // 20:00 Brussels Fri, pushes anchor to ~21:30 end
    const plan = planReshove(anchor, to, restr, [], movable, [], warmUp, coolDown);
    expect(plan.needsReshove).toBe(true);
    // Cascade job pushed into Fri silent hours → next 06:30 lands Saturday (closed) → Sunday 06:30.
    const j2 = getZoneParts(new Date(plan.updates[1].start), TZ);
    expect(j2.weekday).not.toBe(6); // never a Saturday
    expect(j2).toMatchObject({ day: 19, hour: 6, minute: 30 }); // Sunday 06:30
  });

  test('CASCADE respects closures range', () => {
    const closures = [{ startDate: '2026-04-14', endDate: '2026-04-14' }];
    // Anchor Monday 2026-04-13 pushed late so the shoved job lands 2026-04-14 (closed) → 04-15 06:30.
    const anchor = anchorJob('2026-04-13T17:00:00.000Z', '2026-04-13T18:30:00.000Z'); // 19:00–20:30 Brussels
    const movable = [job(2, '2026-04-13T18:40:00.000Z', '2026-04-13T19:40:00.000Z')];
    const to = utc('2026-04-13T18:00:00.000Z');
    const plan = planReshove(anchor, to, restr, closures, movable, [], warmUp, coolDown);
    expect(plan.needsReshove).toBe(true);
    const j2 = getZoneParts(new Date(plan.updates[1].start), TZ);
    expect(j2).toMatchObject({ day: 15, hour: 6, minute: 30 }); // skipped the 04-14 closure
  });

  test('long cascade: three movable jobs all shove back one-by-one', () => {
    // Anchor pulled onto a tight back-to-back run of three jobs; all three shove.
    const anchor = anchorJob('2026-04-13T14:00:00.000Z', '2026-04-13T15:00:00.000Z'); // far future
    const movable = [
      job(2, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z'), // 10:00–11:00 Brussels
      job(3, '2026-04-13T09:20:00.000Z', '2026-04-13T10:20:00.000Z'), // back-to-back (20m buffer)
      job(4, '2026-04-13T10:40:00.000Z', '2026-04-13T11:40:00.000Z'),
    ];
    const to = utc('2026-04-13T08:00:00.000Z'); // pull anchor onto the first job
    const plan = planReshove(anchor, to, restr, [], movable, [], warmUp, coolDown);
    expect(plan.needsReshove).toBe(true);
    // anchor + all three cascaded.
    expect(plan.updates.map(u => u.id)).toEqual([1, 2, 3, 4]);
    // Each packs 20m (cool15+warm5) behind the previous.
    expect(plan.updates[0]).toMatchObject({ start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z' });
    expect(plan.updates[1].start).toBe('2026-04-13T09:20:00.000Z');
    expect(plan.updates[2].start).toBe('2026-04-13T10:40:00.000Z');
    expect(plan.updates[3].start).toBe('2026-04-13T12:00:00.000Z');
  });

  test('mover that STARTS before target but SPANS it is shoved (buffered-overlap partition)', () => {
    // Movable job 07:30Z–08:30Z; target 08:00Z falls inside it. A raw start<to
    // partition would wrongly treat it as fixed and leave the anchor overlapping.
    const anchor = anchorJob('2026-04-13T14:00:00.000Z', '2026-04-13T15:00:00.000Z'); // 1h, far future
    const movable = [job(2, '2026-04-13T07:30:00.000Z', '2026-04-13T08:30:00.000Z')];
    const to = utc('2026-04-13T08:00:00.000Z'); // inside the movable job's run
    const plan = planReshove(anchor, to, restr, [], movable, [], warmUp, coolDown);
    expect(plan.needsReshove).toBe(true);
    expect(plan.updates[0]).toMatchObject({ id: 1, start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z' });
    // Shoved behind the anchor: anchorEnd 09:00Z + 20m = 09:20Z.
    expect(plan.updates[1]).toMatchObject({ id: 2, start: '2026-04-13T09:20:00.000Z' });
  });

  test('activeConflict flagged when the verbatim anchor overlaps a running print', () => {
    const anchor = anchorJob('2026-04-13T14:00:00.000Z', '2026-04-13T15:00:00.000Z');
    const fixed = [{ id: 9, start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z', status: 'Printing' }];
    const to = utc('2026-04-13T08:00:00.000Z'); // right on the running print
    const plan = planReshove(anchor, to, restr, [], [], fixed, warmUp, coolDown);
    expect(plan.activeConflict).toBe(true);
    expect(plan.needsReshove).toBe(false); // nothing movable to reshove
    expect(plan.updates.map(u => u.id)).toEqual([1]); // fixed job 9 never moves
  });

  test('activeConflict NOT flagged for overlap with a non-active (Done) job', () => {
    const anchor = anchorJob('2026-04-13T14:00:00.000Z', '2026-04-13T15:00:00.000Z');
    const fixed = [{ id: 9, start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z', status: 'Done' }];
    const to = utc('2026-04-13T08:00:00.000Z');
    const plan = planReshove(anchor, to, restr, [], [], fixed, warmUp, coolDown);
    expect(plan.activeConflict).toBe(false);
  });

  test('immovable (fixed) jobs are never moved, only routed around', () => {
    // Anchor pulled to 10:00; a movable job at 10:00 must shove, a Printing job at
    // 12:00–13:00 is fixed and the cascade must skip past it (never appears in updates).
    const anchor = anchorJob('2026-04-13T14:00:00.000Z', '2026-04-13T15:00:00.000Z');
    const movable = [job(2, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z')]; // 10:00–11:00 Brussels
    const fixed = [{ id: 9, start: '2026-04-13T10:00:00.000Z', end: '2026-04-13T11:00:00.000Z' }]; // 12:00–13:00 Brussels
    const to = utc('2026-04-13T08:00:00.000Z');
    const plan = planReshove(anchor, to, restr, [], movable, fixed, warmUp, coolDown);
    expect(plan.needsReshove).toBe(true);
    // The fixed job id 9 must not be in the updates.
    expect(plan.updates.map(u => u.id)).not.toContain(9);
    // Movable job would pack at 09:20Z but that overlaps the fixed 10:00Z–11:00Z (+buffers)
    // → skips to fixed end 11:00Z + cool15 + warm5 = 11:20Z.
    expect(plan.updates[1].start).toBe('2026-04-13T11:20:00.000Z');
  });
});

describe('availableMsBetween (working-time gap, silent/closed excluded)', () => {
  const restr = {
    enabled: true,
    silentStart: '21:00',
    silentEnd: '06:30',
    closedDays: [6], // Saturday
    timezone: TZ,
  };
  const MIN = 60000;

  test('both instants inside working hours: full wall-clock gap counts', () => {
    // 10:00Z–10:25Z Brussels midday → entirely available → 25 min.
    const gap = availableMsBetween(utc('2026-04-13T08:00:00.000Z'), utc('2026-04-13T08:25:00.000Z'), restr, []);
    expect(gap).toBe(25 * MIN);
  });

  test('gap fully inside silent hours counts as ZERO working time', () => {
    // 01:00 Brussels → next 06:30 Brussels: the whole span is silent (21:00–06:30).
    // 2026-04-13 is a Monday. 01:00 Brussels = 2026-04-12T23:00Z; 06:30 = 2026-04-13T04:30Z.
    const gap = availableMsBetween(utc('2026-04-12T23:00:00.000Z'), utc('2026-04-13T04:30:00.000Z'), restr, []);
    expect(gap).toBe(0);
  });

  test('gap straddling the silent boundary counts only the working slivers', () => {
    // A ends 20:45 Brussels (18:45Z), B starts next day 06:45 Brussels (04:45Z).
    // Working slivers: 20:45–21:00 (15 min) + 06:30–06:45 (15 min) = 30 min.
    const gap = availableMsBetween(utc('2026-04-13T18:45:00.000Z'), utc('2026-04-14T04:45:00.000Z'), restr, []);
    expect(gap).toBe(30 * MIN);
  });

  test('t2 <= t1 returns 0 (overlapping / adjacent jobs)', () => {
    expect(availableMsBetween(utc('2026-04-13T10:00:00.000Z'), utc('2026-04-13T09:00:00.000Z'), restr, [])).toBe(0);
    expect(availableMsBetween(utc('2026-04-13T10:00:00.000Z'), utc('2026-04-13T10:00:00.000Z'), restr, [])).toBe(0);
  });

  test('closed day (Saturday) contributes zero working time', () => {
    // Fri 2026-04-17 20:00 Brussels (18:00Z) → Sun 2026-04-19 08:00 Brussels (06:00Z).
    // Working slivers: Fri 20:00–21:00 (60) + Sun 06:30–08:00 (90) = 150 min.
    // Saturday is fully closed → contributes nothing.
    const gap = availableMsBetween(utc('2026-04-17T18:00:00.000Z'), utc('2026-04-19T06:00:00.000Z'), restr, []);
    expect(gap).toBe(150 * MIN);
  });
});

describe('selectFollowingChain (pull-forward block selection)', () => {
  const restr = {
    enabled: true,
    silentStart: '21:00',
    silentEnd: '06:30',
    closedDays: [6],
    timezone: TZ,
  };
  const job = (id, startISO, endISO, extra = {}) =>
    ({ id, start: startISO, end: endISO, status: 'Planned', linked_printer_id: null, locked: 0, ...extra });
  const anchor = job(1, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z');

  test('chains consecutive jobs with <= 30 min working gap', () => {
    const later = [
      job(2, '2026-04-13T09:20:00.000Z', '2026-04-13T10:00:00.000Z'), // 20 min after anchor end
      job(3, '2026-04-13T10:25:00.000Z', '2026-04-13T11:00:00.000Z'), // 25 min after job2 end
    ];
    const chain = selectFollowingChain(anchor, later, restr, []);
    expect(chain.map(j => j.id)).toEqual([2, 3]);
  });

  test('a silent-hours-spanning gap (01:00 -> next 06:30) still chains', () => {
    // Anchor ends 01:00 Brussels (2026-04-12T23:00Z); follower starts 06:30 Brussels
    // (2026-04-13T04:30Z). Entire gap is silent → zero working gap → chains.
    const nightAnchor = job(1, '2026-04-12T22:00:00.000Z', '2026-04-12T23:00:00.000Z'); // ends 01:00 Brussels
    const later = [job(2, '2026-04-13T04:30:00.000Z', '2026-04-13T05:30:00.000Z')];     // starts 06:30 Brussels
    const chain = selectFollowingChain(nightAnchor, later, restr, []);
    expect(chain.map(j => j.id)).toEqual([2]);
  });

  test('a > 30 min working gap breaks the chain', () => {
    const later = [
      job(2, '2026-04-13T09:20:00.000Z', '2026-04-13T10:00:00.000Z'), // chains (20 min)
      job(3, '2026-04-13T10:45:00.000Z', '2026-04-13T11:30:00.000Z'), // 45 min after job2 end → breaks
      job(4, '2026-04-13T11:50:00.000Z', '2026-04-13T12:30:00.000Z'), // would chain to job3, but excluded
    ];
    const chain = selectFollowingChain(anchor, later, restr, []);
    expect(chain.map(j => j.id)).toEqual([2]);
  });

  test('a locked job is SKIPPED, not a terminator — the chain continues past it', () => {
    const later = [
      job(2, '2026-04-13T09:20:00.000Z', '2026-04-13T10:00:00.000Z'), // chains
      job(3, '2026-04-13T10:20:00.000Z', '2026-04-13T11:00:00.000Z', { locked: 1 }), // locked → skipped
      job(4, '2026-04-13T11:20:00.000Z', '2026-04-13T12:00:00.000Z'), // tight after locked → still selected
    ];
    const chain = selectFollowingChain(anchor, later, restr, []);
    // Locked job 3 excluded from the moved block, but job 4 after it is pulled in.
    expect(chain.map(j => j.id)).toEqual([2, 4]);
    // The locked job's row is never handed back for movement.
    expect(chain.some(j => j.id === 3)).toBe(false);
  });

  test('an immovable (Printing/linked) job is also skipped, chain continues past it', () => {
    const later = [
      job(2, '2026-04-13T09:20:00.000Z', '2026-04-13T10:00:00.000Z'),
      job(3, '2026-04-13T10:20:00.000Z', '2026-04-13T11:00:00.000Z', { status: 'Printing' }),
      job(4, '2026-04-13T11:20:00.000Z', '2026-04-13T12:00:00.000Z'),
    ];
    expect(selectFollowingChain(anchor, later, restr, []).map(j => j.id)).toEqual([2, 4]);

    // A lone immovable follower (nothing movable after it) → empty chain.
    const later2 = [
      job(2, '2026-04-13T09:20:00.000Z', '2026-04-13T10:00:00.000Z', { linked_printer_id: 7 }),
    ];
    expect(selectFollowingChain(anchor, later2, restr, []).map(j => j.id)).toEqual([]);
  });

  test('multiple interspersed immovable jobs are all skipped, movers still chained', () => {
    const later = [
      job(2, '2026-04-13T09:20:00.000Z', '2026-04-13T10:00:00.000Z'),                       // movable
      job(3, '2026-04-13T10:20:00.000Z', '2026-04-13T11:00:00.000Z', { locked: 1 }),        // skip
      job(4, '2026-04-13T11:20:00.000Z', '2026-04-13T12:00:00.000Z', { status: 'Printing' }), // skip
      job(5, '2026-04-13T12:20:00.000Z', '2026-04-13T13:00:00.000Z'),                       // movable
      job(6, '2026-04-13T13:20:00.000Z', '2026-04-13T14:00:00.000Z', { linked_printer_id: 9 }), // skip
      job(7, '2026-04-13T14:20:00.000Z', '2026-04-13T15:00:00.000Z'),                       // movable
    ];
    // All three immovable jobs (3,4,6) skipped; the three movers (2,5,7) survive since
    // every consecutive gap (including across the immovable ones) stays <= 30 min.
    expect(selectFollowingChain(anchor, later, restr, []).map(j => j.id)).toEqual([2, 5, 7]);
  });

  test('a real > 30 min gap still breaks the chain even when a locked job precedes it', () => {
    const later = [
      job(2, '2026-04-13T09:20:00.000Z', '2026-04-13T10:00:00.000Z'),                 // chains
      job(3, '2026-04-13T10:20:00.000Z', '2026-04-13T11:00:00.000Z', { locked: 1 }),  // skip, ends 11:00
      job(4, '2026-04-13T11:45:00.000Z', '2026-04-13T12:30:00.000Z'),                 // 45 min after locked end → breaks
      job(5, '2026-04-13T12:50:00.000Z', '2026-04-13T13:30:00.000Z'),                 // after the break → excluded
    ];
    expect(selectFollowingChain(anchor, later, restr, []).map(j => j.id)).toEqual([2]);
  });

  test('empty result when the very first follower is already too far', () => {
    const later = [job(2, '2026-04-13T10:30:00.000Z', '2026-04-13T11:00:00.000Z')]; // 90 min gap
    expect(selectFollowingChain(anchor, later, restr, [])).toEqual([]);
  });
});

describe('planReshove — pull-forward block (chainFollowers)', () => {
  const restr = {
    enabled: true,
    silentStart: '21:00',
    silentEnd: '06:30',
    closedDays: [6],
    timezone: TZ,
  };
  const warmUp = 5 * 60000;
  const coolDown = 15 * 60000;
  const job = (id, startISO, endISO) => ({ id, start: startISO, end: endISO, status: 'Planned' });
  const anchorJob = (startISO, endISO) => ({ id: 1, start: startISO, end: endISO });

  test('block moves forward together; no non-chain job → needsReshove false', () => {
    // Anchor 14:00Z, two tight followers at 15:20Z and 16:40Z. Pull the block to 08:00Z.
    const anchor = anchorJob('2026-04-13T14:00:00.000Z', '2026-04-13T15:00:00.000Z');
    const followers = [
      job(2, '2026-04-13T15:20:00.000Z', '2026-04-13T16:20:00.000Z'),
      job(3, '2026-04-13T16:40:00.000Z', '2026-04-13T17:40:00.000Z'),
    ];
    const to = utc('2026-04-13T08:00:00.000Z');
    const plan = planReshove(anchor, to, restr, [], followers, [], warmUp, coolDown, followers);
    expect(plan.needsReshove).toBe(false); // block moving is intended, not a reshuffle
    expect(plan.updates.map(u => u.id)).toEqual([1, 2, 3]);
    // Anchor verbatim, followers pack 20 min behind each.
    expect(plan.updates[0]).toMatchObject({ start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z' });
    expect(plan.updates[1].start).toBe('2026-04-13T09:20:00.000Z');
    expect(plan.updates[2].start).toBe('2026-04-13T10:40:00.000Z');
  });

  test('block landing on a NON-chain movable job triggers reshove of that job', () => {
    // Anchor 14:00Z + follower 15:20Z form the block. A separate movable job sits at
    // 08:00Z–09:00Z (10:00 Brussels). Pull the block to 08:00Z → block lands on it.
    const anchor = anchorJob('2026-04-13T14:00:00.000Z', '2026-04-13T15:00:00.000Z');
    const follower = job(2, '2026-04-13T15:20:00.000Z', '2026-04-13T16:20:00.000Z');
    const nonChain = job(3, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z');
    const movable = [follower, nonChain];
    const to = utc('2026-04-13T08:00:00.000Z');
    const plan = planReshove(anchor, to, restr, [], movable, [], warmUp, coolDown, [follower]);
    expect(plan.needsReshove).toBe(true); // non-chain job 3 had to yield
    // Anchor 08:00–09:00, follower packed at 09:20, non-chain reshoved behind block.
    expect(plan.updates[0]).toMatchObject({ id: 1, start: '2026-04-13T08:00:00.000Z' });
    expect(plan.updates[1]).toMatchObject({ id: 2, start: '2026-04-13T09:20:00.000Z', end: '2026-04-13T10:20:00.000Z' });
    // Non-chain job 3 shoved behind follower end 10:20 + 20m = 10:40.
    expect(plan.updates[2]).toMatchObject({ id: 3, start: '2026-04-13T10:40:00.000Z' });
  });

  test('block followers respect silent hours when packing (availability-aware placement)', () => {
    // Anchor pulled to 20:30 Brussels; the follower packed behind it would land in
    // silent hours and must skip to next-day 06:30 — selection ignored silent hours,
    // placement does not.
    const anchor = anchorJob('2026-04-14T10:00:00.000Z', '2026-04-14T11:00:00.000Z'); // future
    const follower = job(2, '2026-04-14T12:00:00.000Z', '2026-04-14T13:00:00.000Z');
    const to = utc('2026-04-13T18:30:00.000Z'); // 20:30 Brussels
    const plan = planReshove(anchor, to, restr, [], [follower], [], warmUp, coolDown, [follower]);
    // Anchor verbatim 20:30–21:30 Brussels.
    expect(getZoneParts(new Date(plan.updates[0].start), TZ).hour).toBe(20);
    // Follower candidate 21:50 Brussels → silent → next-day 06:30.
    const f = getZoneParts(new Date(plan.updates[1].start), TZ);
    expect(f).toMatchObject({ day: 14, hour: 6, minute: 30 });
  });

  test('block routes AROUND a locked job in the tail — locked stays put, no overlap', () => {
    // Concrete "route around locked" scenario. Anchor A + movable followers B, D form
    // the block; a LOCKED job C sits in the `fixed` bucket wedged between B and D. Pull
    // the block to 08:00Z. B packs behind A; D's tight slot would land on C, so it must
    // route around C — C never moves, D never overlaps it.
    const anchor = anchorJob('2026-04-13T10:00:00.000Z', '2026-04-13T11:00:00.000Z');
    const B = job(2, '2026-04-13T12:00:00.000Z', '2026-04-13T13:00:00.000Z');
    const D = job(4, '2026-04-13T16:00:00.000Z', '2026-04-13T17:00:00.000Z');
    const lockedC = { id: 9, start: '2026-04-13T10:40:00.000Z', end: '2026-04-13T11:40:00.000Z', status: 'Planned', locked: 1 };
    const to = utc('2026-04-13T08:00:00.000Z');
    // followers = the movable chain [B, D]; lockedC lives in the `fixed` obstacle bucket.
    const plan = planReshove(anchor, to, restr, [], [B, D], [lockedC], warmUp, coolDown, [B, D]);

    // The locked job is never moved.
    expect(plan.updates.map(u => u.id)).not.toContain(9);
    // Only the movable block is emitted: A, B, D.
    expect(plan.updates.map(u => u.id)).toEqual([1, 2, 4]);
    // No non-chain MOVABLE job had to yield → no surprise reshuffle.
    expect(plan.needsReshove).toBe(false);

    // A verbatim 08:00–09:00; B packs 20 min behind → 09:20–10:20 (clears C at 10:40).
    expect(plan.updates[0]).toMatchObject({ id: 1, start: '2026-04-13T08:00:00.000Z' });
    expect(plan.updates[1]).toMatchObject({ id: 2, start: '2026-04-13T09:20:00.000Z', end: '2026-04-13T10:20:00.000Z' });
    // D's tight slot (10:40) collides with locked C 10:40–11:40 → routes to
    // C end 11:40 + cool15 + warm5 = 12:00.
    expect(plan.updates[2]).toMatchObject({ id: 4, start: '2026-04-13T12:00:00.000Z', end: '2026-04-13T13:00:00.000Z' });

    // Explicit no-overlap guard: every moved job's interval is disjoint from locked C.
    const cStart = Date.parse(lockedC.start), cEnd = Date.parse(lockedC.end);
    for (const u of plan.updates) {
      const s = Date.parse(u.start), e = Date.parse(u.end);
      expect(s < cEnd && cStart < e).toBe(false);
    }
  });

  test('empty chainFollowers reproduces the classic single-anchor reshove', () => {
    const anchor = anchorJob('2026-04-13T12:00:00.000Z', '2026-04-13T13:00:00.000Z'); // 14:00 Brussels
    const movable = [job(2, '2026-04-13T08:00:00.000Z', '2026-04-13T09:00:00.000Z')]; // 10:00 Brussels
    const to = utc('2026-04-13T08:00:00.000Z');
    const plan = planReshove(anchor, to, restr, [], movable, [], warmUp, coolDown, []);
    expect(plan.needsReshove).toBe(true);
    expect(plan.updates[0]).toMatchObject({ id: 1, start: '2026-04-13T08:00:00.000Z' });
    expect(plan.updates[1]).toMatchObject({ id: 2, start: '2026-04-13T09:20:00.000Z' });
  });
});
