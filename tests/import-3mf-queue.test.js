// Point the app's DB singleton at a throwaway temp file BEFORE requiring
// ../db or ../server (both read PLANNER_DB_PATH at load time).
const os   = require('os');
const fs   = require('fs');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.PLANNER_DB_PATH =
  process.env.PLANNER_DB_PATH || path.join(os.tmpdir(), `printfarm-test-${process.pid}.db`);

// Drives the REAL Express /api/import-3mf-schedule and /api/jobs/:id/attach-3mf
// routes in-process via supertest. Queue mode is the web default: imported
// plates must land on the queue (queued=1) with empty start/end, one job per
// plate, carrying the per-plate item count — and must NOT throw on the empty
// `start` (the `new Date('')` trap).
describe('import-3mf-schedule — queue mode (real route via supertest)', () => {
  const request = require('supertest');
  let app, appDb, printerId;
  const SESSION_TOKEN = 'queue-import-session-token';
  const authCookie = `pf_session=${SESSION_TOKEN}`;
  const uploadsDir = path.join(__dirname, '..', 'data', 'uploads');
  const createdFiles = [];

  // Non-zip dummy body: the route trusts the X-Schedule `plates` array for job
  // data and only uses the body for storage + thumbnail extraction (which
  // safely yields none for a non-zip buffer).
  const dummyBody = Buffer.from('not-a-real-3mf');

  const schedule = (obj) => encodeURIComponent(JSON.stringify(obj));

  beforeAll(() => {
    appDb = require('../db');
    app   = require('../server');
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION_TOKEN, Date.now() + 3_600_000);
  });

  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers;');
    const r = appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('P1S', '#f00', 5, 15);
    printerId = r.lastInsertRowid;
  });

  afterAll(() => {
    try { appDb.exec('DELETE FROM jobs; DELETE FROM printers;'); } catch { /* ignore */ }
    // Remove the dummy uploads this suite wrote.
    for (const f of createdFiles) { try { fs.unlinkSync(path.join(uploadsDir, f)); } catch { /* ignore */ } }
  });

  const post = (scheduleObj) =>
    request(app)
      .post('/api/import-3mf-schedule')
      .set('Cookie', authCookie)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Schedule', schedule(scheduleObj))
      .send(dummyBody);

  test('queue mode: every plate becomes a separate queued job with empty start/end and carried items', async () => {
    const plates = [
      { plateIndex: 1, name: 'Dino body', printerId, durationMins: 120, items: 4 },
      { plateIndex: 2, name: 'Dino feet', printerId, durationMins: 45, items: 2 },
    ];
    const res = await post({ plates, mode: 'queue' });
    if (res.body.file) createdFiles.push(res.body.file);

    expect(res.status).toBe(201);
    expect(res.body.jobs).toHaveLength(2);
    // One job per plate, in input order.
    expect(res.body.jobs.map(j => j.name)).toEqual(['Dino body', 'Dino feet']);
    // Response flags queue mode + empty schedule.
    for (const j of res.body.jobs) {
      expect(j.queued).toBe(1);
      expect(j.start).toBe('');
      expect(j.end).toBe('');
    }

    // Persisted rows: queued, empty start/end, item count carried through.
    const rows = appDb.prepare('SELECT name, queued, start, end, items, printerId FROM jobs ORDER BY id ASC').all();
    expect(rows).toEqual([
      { name: 'Dino body', queued: 1, start: '', end: '', items: 4, printerId },
      { name: 'Dino feet', queued: 1, start: '', end: '', items: 2, printerId },
    ]);
  });

  test('queue mode needs no start time (no plates+start-required rejection)', async () => {
    const res = await post({ plates: [{ plateIndex: 1, name: 'Solo', printerId, durationMins: 30 }], mode: 'queue' });
    if (res.body.file) createdFiles.push(res.body.file);
    expect(res.status).toBe(201);
    expect(res.body.jobs).toHaveLength(1);
  });

  test('empty plates array is still rejected', async () => {
    const res = await post({ plates: [], mode: 'queue' });
    expect(res.status).toBe(400);
  });

  test('attach-3mf on a queued (empty-start) job does not throw and keeps end empty', async () => {
    // Create a queued job first.
    const imp = await post({ plates: [{ plateIndex: 1, name: 'Q', printerId, durationMins: 60, items: 1 }], mode: 'queue' });
    if (imp.body.file) createdFiles.push(imp.body.file);
    const jobId = imp.body.jobs[0].id;

    const res = await request(app)
      .post(`/api/jobs/${jobId}/attach-3mf`)
      .set('Cookie', authCookie)
      .set('Content-Type', 'application/octet-stream')
      .send(dummyBody);

    if (res.body.printFile) createdFiles.push(res.body.printFile);
    expect(res.status).toBe(200);
    // start stayed empty -> end must stay empty (never new Date('') -> throw).
    expect(res.body.start).toBe('');
    expect(res.body.end).toBe('');
  });
});
