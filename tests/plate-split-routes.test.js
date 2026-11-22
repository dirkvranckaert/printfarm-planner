// Real routes via supertest for the async per-plate split (#4051): placeholder
// "Processing" -> per-plate jobs, "Split failed" + retry + fallback, 409 guards,
// naming, traversal. Isolated DB/uploads from tests/isolate-env.js.
const fs = require('fs');
const path = require('path');
const { listenLocal, closeServer } = require('./helpers/listen-local');
const { buildSliced3mf } = require('./helpers/sliced-3mf');

describe('plate split routes', () => {
  const request = require('supertest');
  const TOKEN = 'plate-split-session-token';
  const cookie = `pf_session=${TOKEN}`;
  const uploadsDir = process.env.PLANNER_UPLOADS_DIR;
  let server, app, appDb, plateSplit, srcBody;

  beforeAll(async () => {
    appDb = require('../db');
    app = require('../server');
    plateSplit = require('../plate-split');
    server = await listenLocal(app);
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)').run(TOKEN, Date.now() + 3_600_000);
    fs.mkdirSync(uploadsDir, { recursive: true });
    const p = path.join(uploadsDir, '..', 'multi-src.gcode.3mf');
    await buildSliced3mf(p, 3);
    srcBody = fs.readFileSync(p);
  });
  afterAll(() => closeServer(server));
  beforeEach(() => {
    jest.restoreAllMocks();
    appDb.exec('DELETE FROM jobs; DELETE FROM printers; DELETE FROM split_orphans;');
  });

  const sched = obj => encodeURIComponent(JSON.stringify(obj));
  const plates = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
    plateIndex: i + 1, name: `1245-keychain-name-rood ${i + 1}`, printerId: null, durationMins: 10 * (i + 1), items: 1, ...extra,
  }));
  const imp = (obj, body = srcBody, headers = {}) => {
    let r = request(server).post('/api/import-3mf-schedule').set('Cookie', cookie)
      .set('Content-Type', 'application/octet-stream').set('X-Schedule', sched(obj));
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
  };
  const jobs = () => appDb.prepare('SELECT * FROM jobs ORDER BY id').all();
  const settle = () => app.splitIdle();

  test('multi-plate import: one Processing placeholder at once, then per-plate jobs', async () => {
    const res = await imp({ plates: plates(3), mode: 'queue', fileName: 'keychain-name_order_1245.gcode.3mf' });
    expect(res.status).toBe(201);
    expect(res.body.processing).toBe(true);
    expect(res.body.jobs).toHaveLength(1); // uploader contract {jobs:[{id,name}], file} unchanged
    expect(res.body.jobs[0]).toMatchObject({ name: 'keychain-name_order_1245' });
    expect(typeof res.body.file).toBe('string');
    let rows = jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'Processing', queued: 1, original_file: res.body.file });

    await settle();
    rows = jobs();
    expect(rows).toHaveLength(3);
    // job names unchanged vs the pre-split convention: straight from the client plates[].name
    expect(rows.map(r => r.name)).toEqual(['1245-keychain-name-rood 1', '1245-keychain-name-rood 2', '1245-keychain-name-rood 3']);
    expect(rows.every(r => r.status === 'Planned' && r.queued === 1)).toBe(true);
    expect(rows.map(r => r.plate_index)).toEqual([1, 2, 3]);
    for (const r of rows) {
      expect(r.original_file).toBe(res.body.file);
      expect(r.printFile).not.toBe(r.original_file);
      expect(r.source_name).toBe('keychain-name_order_1245');
      expect(fs.existsSync(path.join(uploadsDir, r.printFile))).toBe(true);
      expect(await plateSplit.listSlicedPlates(path.join(uploadsDir, r.printFile))).toEqual([1]);
    }
    expect(fs.existsSync(path.join(uploadsDir, res.body.file))).toBe(true); // backup kept
  });

  test('copies expand per plate, every copy shares the plate file', async () => {
    await imp({ plates: [{ ...plates(3)[1], copies: 2 }], mode: 'queue' });
    await settle();
    const rows = jobs();
    expect(rows).toHaveLength(2);
    expect(rows[0].printFile).toBe(rows[1].printFile);
    expect(rows.map(r => r.plate_index)).toEqual([2, 2]);
  });

  test('download/open-in-slicer serves the single-plate file named <orig>_plate<N>.gcode.3mf', async () => {
    await imp({ plates: plates(3), mode: 'queue', fileName: 'keychain-name_order_1245.gcode.3mf' });
    await settle();
    const j = jobs()[1];
    const link = await request(server).post(`/api/jobs/${j.id}/slicer-link`).set('Cookie', cookie);
    expect(link.status).toBe(200);
    expect(link.body.filename).toBe('keychain-name_order_1245_plate2.gcode.3mf');
    const dl = await request(server).get(link.body.path).buffer(true).parse((r, cb) => {
      const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('keychain-name_order_1245_plate2.gcode.3mf');
    expect(Buffer.compare(dl.body, fs.readFileSync(path.join(uploadsDir, j.printFile)))).toBe(0);
  });

  test('fileName fallbacks: X-File-Name header, else none (names stay plate names)', async () => {
    await imp({ plates: plates(2), mode: 'queue' }, srcBody, { 'X-File-Name': encodeURIComponent('Header Name.gcode.3mf') });
    await settle();
    expect(jobs().every(r => r.source_name === 'Header Name')).toBe(true);
    appDb.exec('DELETE FROM jobs');
    await imp({ plates: plates(2), mode: 'queue' });
    expect(jobs()[0].name).toBe('1245-keychain-name-rood 1'); // placeholder falls back to first plate name
    await settle();
    expect(jobs().every(r => r.source_name === null)).toBe(true);
  });

  test('single-plate source (and unsliced fixture): no placeholder, one shared file', async () => {
    const res = await imp({ plates: plates(2), mode: 'queue' }, fs.readFileSync(path.join(__dirname, 'fixtures', 'two-plate.gcode.3mf')));
    expect(res.status).toBe(201);
    expect(res.body.processing).toBeUndefined();
    const rows = jobs();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.printFile)).size).toBe(1);
    expect(rows.every(r => r.original_file === null)).toBe(true);
  });

  test('Split failed -> retry succeeds', async () => {
    const filesBefore = new Set(fs.readdirSync(uploadsDir));
    const spy = jest.spyOn(plateSplit, 'splitPlate').mockRejectedValueOnce(new Error('boom'));
    const res = await imp({ plates: plates(2), mode: 'queue' });
    await settle();
    let rows = jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'Split failed', split_error: 'boom' });
    spy.mockRestore();

    const retry = await request(server).post(`/api/jobs/${rows[0].id}/split-retry`).set('Cookie', cookie);
    expect(retry.status).toBe(202);
    expect(jobs()[0]).toMatchObject({ status: 'Processing', split_error: null });
    await settle();
    rows = jobs();
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.status === 'Planned' && r.original_file === res.body.file)).toBe(true);
    // failed attempt left no stray split files behind
    const referenced = new Set(rows.flatMap(r => [r.printFile, r.thumbFile, r.original_file]));
    const stray = fs.readdirSync(uploadsDir).filter(f => /\.3mf$/.test(f) && !referenced.has(f) && !filesBefore.has(f));
    expect(stray).toEqual([]);
  });

  test('Split failed -> "use original, expand per plate" fallback', async () => {
    jest.spyOn(plateSplit, 'splitPlate').mockRejectedValue(new Error('nope'));
    const res = await imp({ plates: plates(3), mode: 'queue' });
    await settle();
    const ph = jobs()[0];
    expect(ph.status).toBe('Split failed');
    const fb = await request(server).post(`/api/jobs/${ph.id}/split-fallback`).set('Cookie', cookie);
    expect(fb.status).toBe(201);
    const rows = jobs();
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.printFile === res.body.file && r.original_file === null)).toBe(true);
    expect(rows.map(r => r.name)).toEqual(['1245-keychain-name-rood 1', '1245-keychain-name-rood 2', '1245-keychain-name-rood 3']);
  });

  test('retry / fallback on a job that is not Split failed -> 409; unknown id -> 404', async () => {
    const id = appDb.prepare("INSERT INTO jobs (name, start, end, status, queued) VALUES ('x','','','Planned',1)").run().lastInsertRowid;
    expect((await request(server).post(`/api/jobs/${id}/split-retry`).set('Cookie', cookie)).status).toBe(409);
    expect((await request(server).post(`/api/jobs/${id}/split-fallback`).set('Cookie', cookie)).status).toBe(409);
    expect((await request(server).post('/api/jobs/99999/split-retry').set('Cookie', cookie)).status).toBe(404);
  });

  test.each(['Processing', 'Split failed'])('placeholder (%s) is not sendable / schedulable / editable: 409', async (status) => {
    const id = appDb.prepare("INSERT INTO jobs (name, start, end, status, queued, original_file) VALUES ('ph','','',?,1,'aaaaaaaaaaaaaaaa.3mf')").run(status).lastInsertRowid;
    const c = r => r.set('Cookie', cookie);
    expect((await c(request(server).put(`/api/jobs/${id}`)).send({ name: 'n', status: 'Planned' })).status).toBe(409);
    expect((await c(request(server).patch(`/api/jobs/${id}`)).send({ status: 'Planned' })).status).toBe(409);
    expect((await c(request(server).patch(`/api/jobs/${id}`)).send({ printerId: 1 })).status).toBe(409);
    expect((await c(request(server).post(`/api/jobs/${id}/schedule-from-queue`)).send({ printerId: 1 })).status).toBe(409);
    expect((await c(request(server).post(`/api/jobs/${id}/slicer-link`))).status).toBe(409);
    expect((await c(request(server).post(`/api/jobs/${id}/attach-3mf`)).send(srcBody)).status).toBe(409);
    // harmless field edits still allowed
    expect((await c(request(server).patch(`/api/jobs/${id}`)).send({ remarks: 'note' })).status).toBe(200);
  });

  test('attach-3mf to a normal job on a multi-plate file: single-plate primary + original backup', async () => {
    const id = appDb.prepare("INSERT INTO jobs (name, start, end, status, queued) VALUES ('a','','','Planned',1)").run().lastInsertRowid;
    const res = await request(server).post(`/api/jobs/${id}/attach-3mf`).set('Cookie', cookie)
      .set('Content-Type', 'application/octet-stream').set('X-Plate-Index', '2')
      .set('X-File-Name', encodeURIComponent('src.gcode.3mf')).send(srcBody);
    expect(res.status).toBe(200);
    expect(res.body.original_file).toBeTruthy();
    expect(res.body.printFile).not.toBe(res.body.original_file);
    expect(res.body.plate_index).toBe(2);
    expect(res.body.source_name).toBe('src');
    expect(await plateSplit.listSlicedPlates(path.join(uploadsDir, res.body.printFile))).toEqual([1]);
  });

  test('empty body -> 400, no file left behind', async () => {
    const before = fs.readdirSync(uploadsDir).length;
    const res = await imp({ plates: plates(1), mode: 'queue' }, Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(fs.readdirSync(uploadsDir).length).toBe(before);
  });

  test('boot recovery: a Processing row left by a restart is re-run', async () => {
    const res = await imp({ plates: plates(2), mode: 'queue' });
    await settle();
    // simulate crash: turn the expanded result back into one Processing placeholder
    const first = jobs()[0];
    const payload = { plates: plates(2), sched: { isQueue: true }, projectId: null };
    appDb.exec('DELETE FROM jobs');
    appDb.prepare("INSERT INTO jobs (name, start, end, status, queued, original_file, split_payload, source_name, plate_index) VALUES ('rec','','','Processing',1,?,?,NULL,NULL)")
      .run(first.original_file, JSON.stringify(payload));
    expect(app.recoverSplits()).toBe(1);
    await settle();
    expect(jobs()).toHaveLength(2);
    expect(res.status).toBe(201);
  });

  // Round-2 F2: cleanup is deterministic. A crash mid-split leaves the outputs the Processing
  // row recorded in split_payload.outputs; the re-run deletes exactly those (+ their .part),
  // never an unrecorded file, however old (it may be another process's upload in flight).
  test('boot recovery deletes only the outputs the Processing job recorded, never unrecorded files', async () => {
    const hex = () => require('crypto').randomBytes(8).toString('hex');
    const up = n => path.join(uploadsDir, n);
    const old = new Date(Date.now() - 3600_000);
    const first = (await imp({ plates: plates(2), mode: 'queue' }));
    await settle();
    const orig = jobs()[0].original_file;
    const recorded = [`${hex()}.3mf`, `${hex()}.png`];
    const recordedPart = `${recorded[0]}.part`;
    for (const n of [...recorded, recordedPart]) fs.writeFileSync(up(n), 'x');
    // unrecorded: old stale-looking files an overlapping process could be writing
    const foreign = [`${hex()}.3mf`, `${hex()}.3mf.part`, `${hex()}.png`];
    for (const n of foreign) { fs.writeFileSync(up(n), 'x'); fs.utimesSync(up(n), old, old); }
    const kept = `${hex()}.3mf`; fs.writeFileSync(up(kept), 'x');
    appDb.prepare("INSERT INTO jobs (name, start, end, status, queued, printFile) VALUES ('ref','','','Planned',1,?)").run(kept);
    const outsider = 'notes.txt'; fs.writeFileSync(up(outsider), 'x');
    appDb.exec("DELETE FROM jobs WHERE name != 'ref'");
    const payload = { plates: plates(2), sched: { isQueue: true }, projectId: null, outputs: [...recorded, kept, '../planner.db', 'notes.txt'] };
    const id = appDb.prepare("INSERT INTO jobs (name, start, end, status, queued, original_file, split_payload) VALUES ('rec','','','Processing',1,?,?)")
      .run(orig, JSON.stringify(payload)).lastInsertRowid;
    app.recoverSplits();
    await settle();
    for (const n of [...recorded, recordedPart]) expect(fs.existsSync(up(n))).toBe(false);
    for (const n of [...foreign, kept, outsider]) { expect(fs.existsSync(up(n))).toBe(true); fs.unlinkSync(up(n)); }
    expect(appDb.prepare('SELECT 1 FROM jobs WHERE id=?').get(id)).toBeUndefined(); // placeholder replaced
    expect(jobs().filter(j => j.name !== 'ref')).toHaveLength(2);
    expect(first.status).toBe(201);
  });

  test('runSplit records its output names in split_payload before writing; failure removes them', async () => {
    const orig = path.join(uploadsDir, 'rec-orig.3mf');
    fs.writeFileSync(orig, fs.readFileSync(path.join(uploadsDir, '..', 'multi-src.gcode.3mf')));
    const payload = { plates: plates(2), sched: { isQueue: true }, projectId: null };
    const id = appDb.prepare("INSERT INTO jobs (name, start, end, status, queued, original_file, split_payload) VALUES ('f','','','Processing',1,'rec-orig.3mf',?)")
      .run(JSON.stringify(payload)).lastInsertRowid;
    jest.spyOn(plateSplit, 'splitPlate').mockImplementation(async (src, idx, dest) => {
      const rec = JSON.parse(appDb.prepare('SELECT split_payload FROM jobs WHERE id=?').get(id).split_payload);
      expect(rec.outputs).toContain(path.basename(dest)); // recorded before the write
      fs.writeFileSync(`${dest}.part`, 'x');
      throw new Error('boom');
    });
    const before = fs.readdirSync(uploadsDir).filter(n => /^[0-9a-f]{16}\./.test(n));
    app.recoverSplits();
    await settle();
    expect(appDb.prepare('SELECT status FROM jobs WHERE id=?').get(id).status).toBe('Split failed');
    expect(fs.readdirSync(uploadsDir).filter(n => /^[0-9a-f]{16}\./.test(n)).sort()).toEqual(before.sort());
    fs.unlinkSync(orig);
  });

  // ---- Round-3 ----
  const hexFiles = () => fs.readdirSync(uploadsDir).filter(n => /^[0-9a-f]{16}\./.test(n)).sort();
  const seedProcessing = (name = 'seed-orig.3mf', extra = {}) => {
    fs.copyFileSync(path.join(uploadsDir, '..', 'multi-src.gcode.3mf'), path.join(uploadsDir, name));
    const payload = { plates: plates(2), sched: { isQueue: true }, projectId: null, ...extra };
    return appDb.prepare("INSERT INTO jobs (name, start, end, status, queued, original_file, split_payload) VALUES ('seed','','','Processing',1,?,?)")
      .run(name, JSON.stringify(payload)).lastInsertRowid;
  };
  const rowPayload = id => JSON.parse(appDb.prepare('SELECT split_payload FROM jobs WHERE id=?').get(id).split_payload);

  // R3-F2: ownership must be durable before the first write (UPDATE changes === 1).
  test('placeholder vanishing before ownership is recorded: nothing is written', async () => {
    const id = seedProcessing();
    const before = hexFiles();
    const spy = jest.spyOn(plateSplit, 'splitPlate');
    jest.spyOn(plateSplit, 'readThumbnails').mockImplementation(async () => {
      appDb.prepare('DELETE FROM jobs WHERE id=?').run(id); // deleted during the async gap
      return [];
    });
    app.recoverSplits();
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(hexFiles()).toEqual(before);
    expect(jobs()).toHaveLength(0);
    fs.rmSync(path.join(uploadsDir, 'seed-orig.3mf'), { force: true });
  });

  // R3-F2: no route may delete the owner (placeholder) of in-flight outputs.
  test('Processing placeholder cannot be deleted / wiped (409); Split failed can', async () => {
    const id = seedProcessing();
    let r = await request(server).delete(`/api/jobs/${id}`).set('Cookie', cookie);
    expect(r.status).toBe(409);
    r = await request(server).post('/api/import').set('Cookie', cookie).send({ printers: [], jobs: [] });
    expect(r.status).toBe(409);
    expect(jobs()).toHaveLength(1);
    appDb.prepare("UPDATE jobs SET status='Split failed' WHERE id=?").run(id);
    r = await request(server).delete(`/api/jobs/${id}`).set('Cookie', cookie);
    expect(r.status).toBe(204);
    expect(jobs()).toHaveLength(0);
    fs.rmSync(path.join(uploadsDir, 'seed-orig.3mf'), { force: true });
  });

  // R4-F2: production shape. The placeholder is created by the import route (printerId NULL);
  // its printers live only in split_payload.plates.
  test('printer delete refuses while a pending split (Processing or Split failed) references it', async () => {
    const pid = appDb.prepare("INSERT INTO printers (name, color) VALUES ('p','#fff')").run().lastInsertRowid;
    const other = appDb.prepare("INSERT INTO printers (name, color) VALUES ('o','#000')").run().lastInsertRowid;
    let release;
    const gate = new Promise(r => { release = r; });
    const split = jest.spyOn(plateSplit, 'splitPlate').mockImplementation(async () => { await gate; throw new Error('boom'); });
    const res = await imp({ plates: plates(2).map(p => ({ ...p, printerId: pid })), mode: 'queue' });
    expect(res.status).toBe(201);
    const id = res.body.jobs[0].id;
    expect(appDb.prepare('SELECT printerId, status FROM jobs WHERE id=?').get(id)).toMatchObject({ printerId: null, status: 'Processing' });
    let r = await request(server).delete(`/api/printers/${pid}`).set('Cookie', cookie);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/split/i);
    // an unrelated printer is still deletable
    expect((await request(server).delete(`/api/printers/${other}`).set('Cookie', cookie)).status).toBe(204);
    release(); await settle();
    expect(appDb.prepare('SELECT status FROM jobs WHERE id=?').get(id).status).toBe('Split failed');
    r = await request(server).delete(`/api/printers/${pid}`).set('Cookie', cookie);
    expect(r.status).toBe(409); // retry / fallback would still need the printer
    expect(jobs()).toHaveLength(1);
    // once the split row is gone the printer can go
    expect((await request(server).delete(`/api/jobs/${id}`).set('Cookie', cookie)).status).toBe(204);
    expect((await request(server).delete(`/api/printers/${pid}`).set('Cookie', cookie)).status).toBe(204);
    split.mockRestore();
    appDb.exec('DELETE FROM jobs; DELETE FROM printers;');
    for (const n of hexFiles()) fs.unlinkSync(path.join(uploadsDir, n));
  });

  // R4-F1: an undeletable output never blocks the user and is never untracked: it moves to
  // split_orphans, the job proceeds, and the drain removes the file once unlink works again.
  test('undeletable outputs go to split_orphans; delete/fallback/retry/import never block; drain converges', async () => {
    const orphans = () => appDb.prepare('SELECT name, last_error FROM split_orphans').all().map(o => o.name);
    const id = seedProcessing();
    let target = null;
    const split = jest.spyOn(plateSplit, 'splitPlate').mockImplementation(async (src, idx, dest) => {
      target = target || path.basename(dest);
      fs.writeFileSync(dest, 'x');
      throw new Error('boom');
    });
    const realUnlink = fs.unlinkSync;
    const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementation(p => {
      if (target && String(p).endsWith(target)) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return realUnlink(p);
    });
    app.recoverSplits();
    await settle();
    expect(appDb.prepare('SELECT status FROM jobs WHERE id=?').get(id).status).toBe('Split failed');
    expect(rowPayload(id).outputs).toBeUndefined(); // ownership moved off the job
    expect(orphans()).toEqual([target]);
    expect(appDb.prepare('SELECT last_error FROM split_orphans').get().last_error).toMatch(/busy/);
    expect(fs.existsSync(path.join(uploadsDir, target))).toBe(true);

    // retry is not blocked (fails again, the new attempt's undeletable output is orphaned too)
    await request(server).post(`/api/jobs/${id}/split-retry`).set('Cookie', cookie);
    await settle();
    expect(split).toHaveBeenCalledTimes(2);

    // fallback / delete / import succeed even while unlink keeps failing
    expect((await request(server).post(`/api/jobs/${id}/split-fallback`).set('Cookie', cookie)).status).toBe(201);
    appDb.exec('DELETE FROM jobs');
    const id2 = seedProcessing();
    appDb.prepare("UPDATE jobs SET status='Split failed' WHERE id=?").run(id2);
    expect((await request(server).delete(`/api/jobs/${id2}`).set('Cookie', cookie)).status).toBe(204);
    expect((await request(server).post('/api/import').set('Cookie', cookie).send({ printers: [], jobs: [] })).status).toBe(200);
    expect(orphans()).toContain(target);

    // still failing: drain keeps the name; a job referencing it never has it deleted
    app.drainSplitOrphans();
    expect(orphans()).toContain(target);
    expect(fs.existsSync(path.join(uploadsDir, target))).toBe(true);

    // unlink works again: drain removes file + row
    unlink.mockRestore(); split.mockRestore();
    app.drainSplitOrphans();
    expect(orphans()).toEqual([]);
    expect(fs.existsSync(path.join(uploadsDir, target))).toBe(false);
    fs.rmSync(path.join(uploadsDir, 'seed-orig.3mf'), { force: true });
    for (const n of hexFiles()) fs.unlinkSync(path.join(uploadsDir, n));
  });

  test('drain drops an orphan name a job references, without deleting the file', () => {
    const name = `${require('crypto').randomBytes(8).toString('hex')}.3mf`;
    fs.writeFileSync(path.join(uploadsDir, name), 'x');
    appDb.prepare('INSERT INTO split_orphans (name, first_seen) VALUES (?,?)').run(name, Date.now());
    appDb.prepare("INSERT INTO jobs (name, start, end, status, queued, printFile) VALUES ('r','','','Planned',1,?)").run(name);
    app.drainSplitOrphans();
    expect(appDb.prepare('SELECT COUNT(*) c FROM split_orphans').get().c).toBe(0);
    expect(fs.existsSync(path.join(uploadsDir, name))).toBe(true);
    appDb.exec('DELETE FROM jobs');
    fs.unlinkSync(path.join(uploadsDir, name));
  });

  test('cleanup treats ENOENT as success (record cleared) and drops invalid names', async () => {
    const hex = () => require('crypto').randomBytes(8).toString('hex');
    const gone = `${hex()}.3mf`; // recorded but never written / already removed
    const id = seedProcessing('seed-orig.3mf', { outputs: [gone, 'not-a-stored-name'] });
    app.recoverSplits();
    await settle();
    expect(jobs()).toHaveLength(2); // pre-clean found nothing left, split ran
    fs.rmSync(path.join(uploadsDir, 'seed-orig.3mf'), { force: true });
    expect(id).toBeDefined();
  });

  test('Split failed row with undeletable leftovers: delete retries cleanup once, succeeds when it works', async () => {
    const hex = () => require('crypto').randomBytes(8).toString('hex');
    const name = `${hex()}.3mf`;
    fs.writeFileSync(path.join(uploadsDir, name), 'x');
    const id = seedProcessing('seed-orig.3mf', { outputs: [name] });
    appDb.prepare("UPDATE jobs SET status='Split failed' WHERE id=?").run(id);
    const r = await request(server).delete(`/api/jobs/${id}`).set('Cookie', cookie);
    expect(r.status).toBe(204);
    expect(fs.existsSync(path.join(uploadsDir, name))).toBe(false);
    fs.rmSync(path.join(uploadsDir, 'seed-orig.3mf'), { force: true });
  });

  test('traversal stays rejected: stored name with ../ never resolves (slicer-link, split)', async () => {
    const id = appDb.prepare("INSERT INTO jobs (name, start, end, status, queued, printFile) VALUES ('t','','','Planned',1,'../planner.db')").run().lastInsertRowid;
    expect((await request(server).post(`/api/jobs/${id}/slicer-link`).set('Cookie', cookie)).status).toBe(404);
    const ph = appDb.prepare("INSERT INTO jobs (name, start, end, status, queued, original_file, split_payload) VALUES ('t2','','','Processing',1,'../planner.db',?)")
      .run(JSON.stringify({ plates: plates(1), sched: { isQueue: true }, projectId: null })).lastInsertRowid;
    app.recoverSplits();
    await settle();
    expect(appDb.prepare('SELECT status, split_error FROM jobs WHERE id=?').get(ph)).toMatchObject({ status: 'Split failed', split_error: 'Original 3MF is missing' });
    const dl = await request(server).get('/api/dl/abc/..%2F..%2Fplanner.db.3mf');
    expect(dl.status).toBe(404);
  });

  test('deleting a job keeps shared files until the last reference is gone (original_file counted)', async () => {
    await imp({ plates: plates(2), mode: 'queue' });
    await settle();
    const [a, b] = jobs();
    const orig = a.original_file;
    await request(server).delete(`/api/jobs/${a.id}`).set('Cookie', cookie);
    expect(fs.existsSync(path.join(uploadsDir, orig))).toBe(true);
    await request(server).delete(`/api/jobs/${b.id}`).set('Cookie', cookie);
    expect(fs.existsSync(path.join(uploadsDir, orig))).toBe(false);
    expect(fs.existsSync(path.join(uploadsDir, b.printFile))).toBe(false);
  });
});
