// Point the app's DB singleton at a throwaway temp file BEFORE requiring
// ../db or ../server (both read PLANNER_DB_PATH at load time).
const os   = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.PLANNER_DB_PATH =
  process.env.PLANNER_DB_PATH || path.join(os.tmpdir(), `printfarm-test-${process.pid}.db`);

// Drives the REAL /api/jobs/:id/schedule-from-queue route via supertest. A
// printer-bound QUEUE job is moved onto its printer's timeline three ways:
// earliest free slot, verbatim "now", verbatim at a picked time — the last two
// reshuffling the printer's other jobs (reusing planReshove) when the slot is
// taken. An unassigned queue job is refused (no lane to schedule onto).
describe('schedule-from-queue (real route via supertest)', () => {
  const request = require('supertest');
  let app, appDb, printerId;
  const SESSION_TOKEN = 'schedule-from-queue-token';
  const authCookie = `pf_session=${SESSION_TOKEN}`;

  beforeAll(() => {
    appDb = require('../db');
    app   = require('../server');
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION_TOKEN, Date.now() + 3_600_000);
  });

  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers;');
    // Restrictions disabled → placement is pure overlap avoidance (deterministic).
    appDb.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
      .run('schedulingRestrictions', JSON.stringify({
        enabled: false, silentStart: '04:00', silentEnd: '04:01', closedDays: [], timezone: 'Europe/Brussels',
      }));
    printerId = appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('P1S', '#f00', 5, 15).lastInsertRowid;
  });

  afterAll(() => { try { appDb.exec('DELETE FROM jobs; DELETE FROM printers;'); } catch { /* ignore */ } });

  const post = (id, body) =>
    request(app).post(`/api/jobs/${id}/schedule-from-queue`).set('Cookie', authCookie).send(body);

  // Insert a queued job directly (empty start/end, queued=1).
  const queueJob = (over = {}) => {
    const { printerId: pid = printerId, durationMins = 120, name = 'Q' } = over;
    return appDb.prepare(
      "INSERT INTO jobs (printerId, name, start, end, status, queued, durationMins) VALUES (?,?,'','','Planned',1,?)"
    ).run(pid, name, durationMins).lastInsertRowid;
  };
  // Insert a scheduled (non-queued) job occupying a fixed window.
  const scheduledJob = (startISO, durationMins) => {
    const end = new Date(new Date(startISO).getTime() + durationMins * 60000).toISOString();
    return appDb.prepare(
      "INSERT INTO jobs (printerId, name, start, end, status, queued, durationMins) VALUES (?,?,?,?,'Planned',0,?)"
    ).run(printerId, 'Fixed', startISO, end, durationMins).lastInsertRowid;
  };

  test('mode=earliest: places at the next free slot, leaves the queue', async () => {
    const id = queueJob({ durationMins: 60 });
    const res = await post(id, { mode: 'earliest' });
    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(1);
    const row = appDb.prepare('SELECT queued, start, end, printerId FROM jobs WHERE id=?').get(id);
    expect(row.queued).toBe(0);
    expect(row.printerId).toBe(printerId);
    expect(row.start).not.toBe('');
    expect(row.end).not.toBe('');
  });

  test('mode=at (now) into an empty printer: schedules immediately, no reshuffle', async () => {
    const id = queueJob({ durationMins: 60 });
    const res = await post(id, { mode: 'at' }); // no `to` → server "now"
    expect(res.status).toBe(200);
    expect(res.body.reshoved).toBeFalsy();
    expect(appDb.prepare('SELECT queued FROM jobs WHERE id=?').get(id).queued).toBe(0);
  });

  test('mode=at with a collision needs a reshuffle, then reshove:true applies it', async () => {
    // Occupy a window; then schedule the queued job verbatim into that window.
    const at = '2026-05-01T10:00:00.000Z';
    const fixedId = scheduledJob(at, 120); // 10:00–12:00
    const id = queueJob({ durationMins: 60 });

    // First attempt (no reshove) reports the reshuffle and writes nothing.
    const first = await post(id, { mode: 'at', to: at });
    expect(first.status).toBe(200);
    expect(first.body.needsReshove).toBe(true);
    expect(appDb.prepare('SELECT queued FROM jobs WHERE id=?').get(id).queued).toBe(1); // still queued

    // Confirmed retry places the anchor verbatim and shoves the fixed job back.
    const second = await post(id, { mode: 'at', to: at, reshove: true });
    expect(second.status).toBe(200);
    expect(second.body.reshoved).toBe(true);
    const anchor = appDb.prepare('SELECT queued, start FROM jobs WHERE id=?').get(id);
    expect(anchor.queued).toBe(0);
    expect(new Date(anchor.start).getTime()).toBe(new Date(at).getTime()); // verbatim slot
    // The previously-fixed job was pushed to start at/after the anchor's end.
    const moved = appDb.prepare('SELECT start FROM jobs WHERE id=?').get(fixedId);
    expect(new Date(moved.start).getTime()).toBeGreaterThan(new Date(at).getTime());
  });

  test('an unassigned (null printerId) queue job is refused', async () => {
    const id = queueJob({ printerId: null });
    const res = await post(id, { mode: 'earliest' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no bound printer/i);
  });

  test('a non-queued job is refused', async () => {
    const id = scheduledJob('2026-05-01T08:00:00.000Z', 60);
    const res = await post(id, { mode: 'earliest' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not queued/i);
  });
});
