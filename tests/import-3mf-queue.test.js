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
  // A REAL 2-plate .gcode.3mf (Dino Body / Dino Feet) so thumbnail carry-over
  // can be proven end-to-end through the actual route.
  const fixtureBody = fs.readFileSync(path.join(__dirname, 'fixtures', 'two-plate.gcode.3mf'));

  const schedule = (obj) => encodeURIComponent(JSON.stringify(obj));

  beforeAll(() => {
    appDb = require('../db');
    app   = require('../server');
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION_TOKEN, Date.now() + 3_600_000);
  });

  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers;');
    // Benign restrictions so the time-slotted (first-available) path is
    // deterministic — silent-hours math itself is covered in scheduling.test.js.
    appDb.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
      .run('schedulingRestrictions', JSON.stringify({
        enabled: false, silentStart: '04:00', silentEnd: '04:01', closedDays: [], timezone: 'Europe/Brussels',
      }));
    const r = appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('P1S', '#f00', 5, 15);
    printerId = r.lastInsertRowid;
  });

  afterAll(() => {
    try { appDb.exec('DELETE FROM jobs; DELETE FROM printers;'); } catch { /* ignore */ }
    // Remove the dummy uploads this suite wrote.
    for (const f of createdFiles) { try { fs.unlinkSync(path.join(uploadsDir, f)); } catch { /* ignore */ } }
  });

  const post = (scheduleObj, body = dummyBody) =>
    request(app)
      .post('/api/import-3mf-schedule')
      .set('Cookie', authCookie)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Schedule', schedule(scheduleObj))
      .send(body);

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

  test('queue mode: a null printerId lands as an unassigned queued job (headless import)', async () => {
    const res = await post({ plates: [{ plateIndex: 1, name: 'Unassigned', printerId: null, durationMins: 90, items: 3 }], mode: 'queue' });
    if (res.body.file) createdFiles.push(res.body.file);
    expect(res.status).toBe(201);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].printerId).toBeNull();
    const row = appDb.prepare('SELECT printerId, queued, start, items FROM jobs WHERE id=?').get(res.body.jobs[0].id);
    expect(row).toEqual({ printerId: null, queued: 1, start: '', items: 3 });
  });

  test('auto-bind: null printerId + a 3MF whose printer matches a defined printer → job bound to it', async () => {
    // beforeEach created a printer named 'P1S'; the fixture embeds "Bambu Lab P1S".
    const res = await post({ mode: 'queue', plates: [
      { plateIndex: 1, name: 'Headless', printerId: null, durationMins: 90, items: 2 },
    ] }, fixtureBody);
    if (res.body.file) createdFiles.push(res.body.file);
    for (const j of res.body.jobs) if (j.thumbFile) createdFiles.push(j.thumbFile);
    expect(res.status).toBe(201);
    expect(res.body.jobs[0].printerId).toBe(printerId); // fuzzy-matched + bound
    const row = appDb.prepare('SELECT printerId, queued, start FROM jobs WHERE id=?').get(res.body.jobs[0].id);
    expect(row).toEqual({ printerId, queued: 1, start: '' }); // still queued, empty start preserved
  });

  test('auto-bind: null printerId + NO matching printer → job stays unassigned', async () => {
    appDb.exec('DELETE FROM printers;');
    appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('Prusa MK4', '#00f', 5, 15); // does not match "Bambu Lab P1S"
    const res = await post({ mode: 'queue', plates: [
      { plateIndex: 1, name: 'Headless', printerId: null, durationMins: 90, items: 2 },
    ] }, fixtureBody);
    if (res.body.file) createdFiles.push(res.body.file);
    for (const j of res.body.jobs) if (j.thumbFile) createdFiles.push(j.thumbFile);
    expect(res.status).toBe(201);
    expect(res.body.jobs[0].printerId).toBeNull(); // no confident match → left unassigned
  });

  test('auto-bind: an explicit printerId is never overridden by the 3MF embed', async () => {
    // A second printer; pass IT explicitly even though the 3MF embeds "P1S".
    const other = appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('X1 Carbon', '#0a0', 5, 15).lastInsertRowid;
    const res = await post({ mode: 'queue', plates: [
      { plateIndex: 1, name: 'Manual', printerId: other, durationMins: 90, items: 2 },
    ] }, fixtureBody);
    if (res.body.file) createdFiles.push(res.body.file);
    for (const j of res.body.jobs) if (j.thumbFile) createdFiles.push(j.thumbFile);
    expect(res.status).toBe(201);
    expect(res.body.jobs[0].printerId).toBe(other); // caller's pick wins, not the P1S embed
  });

  test('an unknown printer is rejected up-front with NO partial import (transaction + validation)', async () => {
    const res = await post({ mode: 'queue', plates: [
      { plateIndex: 1, name: 'Good', printerId, durationMins: 60, items: 1 },
      { plateIndex: 2, name: 'Bad', printerId: 999999, durationMins: 30, items: 1 }, // no such printer
    ] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown printer/);
    // Neither plate persisted — the whole import rolled back / never started.
    expect(appDb.prepare('SELECT COUNT(*) c FROM jobs').get().c).toBe(0);
    // No stored 3MF artifact was left behind (validation ran before any write).
    expect(res.body.file).toBeUndefined();
  });

  test('first-available (time-slotted) path still works: populated start/end, queued=0, sequential', async () => {
    const res = await post({ mode: 'first-available', plates: [
      { plateIndex: 1, name: 'A', printerId, durationMins: 60 },
      { plateIndex: 2, name: 'B', printerId, durationMins: 30 },
    ] });
    if (res.body.file) createdFiles.push(res.body.file);
    expect(res.status).toBe(201);
    expect(res.body.jobs).toHaveLength(2);
    for (const j of res.body.jobs) {
      expect(j.queued).toBe(0);
      expect(j.start).not.toBe('');
      expect(j.end).not.toBe('');
    }
    // Sequential + non-overlapping (cool-down + warm-up gap between plates).
    expect(new Date(res.body.jobs[1].start).getTime())
      .toBeGreaterThanOrEqual(new Date(res.body.jobs[0].end).getTime());
    const rows = appDb.prepare("SELECT queued, start FROM jobs WHERE start != '' ORDER BY id").all();
    expect(rows.map(r => r.queued)).toEqual([0, 0]);
  });

  test('queue mode carries each plate render through from a real 3MF body', async () => {
    // Real fixture body -> the route extracts plate_1.png / plate_2.png and
    // attaches a thumbFile per matching plateIndex.
    const res = await post({ mode: 'queue', plates: [
      { plateIndex: 1, name: 'Dino Body', printerId, durationMins: 120, items: 1 },
      { plateIndex: 2, name: 'Dino Feet', printerId, durationMins: 45, items: 2 },
    ] }, fixtureBody);
    if (res.body.file) createdFiles.push(res.body.file);
    for (const j of res.body.jobs) if (j.thumbFile) createdFiles.push(j.thumbFile);
    expect(res.status).toBe(201);
    expect(res.body.jobs).toHaveLength(2);
    // Both plates got their own render carried over.
    for (const j of res.body.jobs) expect(j.thumbFile).toBeTruthy();
    expect(res.body.jobs[0].thumbFile).not.toBe(res.body.jobs[1].thumbFile);
  });
});
