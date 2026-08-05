// Item-count tracking — schema migration, import passthrough, manual
// create/edit + items_lost validation, projects aggregation (losses subtracted
// from BOTH done and total), auto-migration backfill, the reload-from-3MF route,
// and the UI wiring.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const projects = require('../projects');
const itemsMigration = require('../itemsMigration');

// ---------------------------------------------------------------------------
// A. Schema migration — additive, guarded, idempotent
// ---------------------------------------------------------------------------
describe('schema migration (jobs.items / items_lost / plate_name)', () => {
  // Mirror of db.js's guarded-ALTER block for these three columns. Kept in sync
  // with the source (see db.js "Item-count tracking"): running it against an
  // already-migrated table must be a no-op, never a duplicate-column error.
  function migrateItemsColumns(db) {
    const cols = db.pragma('table_info(jobs)');
    if (!cols.some(c => c.name === 'items'))      db.exec('ALTER TABLE jobs ADD COLUMN items INTEGER');
    if (!cols.some(c => c.name === 'items_lost')) db.exec('ALTER TABLE jobs ADD COLUMN items_lost INTEGER NOT NULL DEFAULT 0');
    if (!cols.some(c => c.name === 'plate_name')) db.exec('ALTER TABLE jobs ADD COLUMN plate_name TEXT');
  }

  function legacyDb() {
    const db = new Database(':memory:');
    // Pre-migration jobs shape (no item columns).
    db.exec(`CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, status TEXT DEFAULT 'Planned'
    );`);
    db.prepare("INSERT INTO jobs (name, status) VALUES ('legacy', 'Done')").run();
    return db;
  }

  test('adds the three columns with the right nullability/defaults', () => {
    const db = legacyDb();
    migrateItemsColumns(db);
    const cols = db.pragma('table_info(jobs)');
    const items = cols.find(c => c.name === 'items');
    const lost  = cols.find(c => c.name === 'items_lost');
    const pname = cols.find(c => c.name === 'plate_name');
    expect(items).toMatchObject({ notnull: 0 });          // nullable
    expect(lost).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(pname).toMatchObject({ notnull: 0 });
    // Existing row: items untracked (NULL), items_lost defaulted to 0.
    const row = db.prepare('SELECT * FROM jobs WHERE name=?').get('legacy');
    expect(row.items).toBeNull();
    expect(row.items_lost).toBe(0);
    expect(row.plate_name).toBeNull();
  });

  test('running the migration twice is a no-op and leaves existing rows untouched', () => {
    const db = legacyDb();
    migrateItemsColumns(db);
    // Set a value, then re-run: the guard must not fire an ALTER again nor wipe data.
    db.prepare("UPDATE jobs SET items=7, items_lost=2, plate_name='Plate A' WHERE name='legacy'").run();
    expect(() => migrateItemsColumns(db)).not.toThrow();
    const cols = db.pragma('table_info(jobs)').filter(c => c.name === 'items');
    expect(cols).toHaveLength(1); // not duplicated
    const row = db.prepare('SELECT * FROM jobs WHERE name=?').get('legacy');
    expect(row).toMatchObject({ items: 7, items_lost: 2, plate_name: 'Plate A' });
  });
});

// ---------------------------------------------------------------------------
// D. Projects aggregation — item sums + losses subtracted from BOTH
// ---------------------------------------------------------------------------
describe('projects aggregation — item counts + losses', () => {
  function makeDb() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000));
      CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT,
        status TEXT DEFAULT 'Planned', queued INTEGER NOT NULL DEFAULT 0,
        project_id TEXT, items INTEGER, items_lost INTEGER NOT NULL DEFAULT 0, plate_name TEXT);
    `);
    return db;
  }
  const addJob = (db, { status, items = null, lost = 0, project = 'p', queued = 0 }) =>
    db.prepare('INSERT INTO jobs (name, status, items, items_lost, project_id, queued) VALUES (?,?,?,?,?,?)')
      .run('J', status, items, lost, project, queued).lastInsertRowid;

  test('itemsTotal/Done/Busy sum only tracked jobs; NULL items contribute nothing', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'P' });
    addJob(db, { status: 'Done', items: 4 });
    addJob(db, { status: 'Done', items: 3 });
    addJob(db, { status: 'Printing', items: 5 });
    addJob(db, { status: 'Planned', items: 2 });
    addJob(db, { status: 'Planned', items: null }); // untracked -> ignored
    const c = projects.countsByProject(db)['p'];
    expect(c.itemsTotal).toBe(14); // 4+3+5+2
    expect(c.itemsDone).toBe(7);   // 4+3
    expect(c.itemsBusy).toBe(5);   // Printing
  });

  test('losses subtract from BOTH done and total (floored at 0) via summaries()', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'P' });
    addJob(db, { status: 'Done', items: 10, lost: 3 });
    addJob(db, { status: 'Planned', items: 5 });
    const s = projects.summaries(db).find(x => x.id === 'p');
    expect(s.itemsTotal).toBe(15);
    expect(s.itemsDone).toBe(10);
    expect(s.itemsLost).toBe(3);
    expect(s.itemsDoneAdj).toBe(7);   // 10 - 3
    expect(s.itemsTotalAdj).toBe(12); // 15 - 3
  });

  test('adjusted figures never go negative (loss exceeds tracked done)', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'P' });
    addJob(db, { status: 'Done', items: 2, lost: 5 });
    const s = projects.summaries(db).find(x => x.id === 'p');
    expect(s.itemsDoneAdj).toBe(0);
    expect(s.itemsTotalAdj).toBe(0);
  });

  test('items_lost on an untracked (items NULL) job still counts as a loss', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'P' });
    addJob(db, { status: 'Done', items: null, lost: 2 });
    const c = projects.countsByProject(db)['p'];
    expect(c.itemsTotal).toBe(0);
    expect(c.itemsLost).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// E. Auto-migration backfill (itemsMigration.backfillItems)
// ---------------------------------------------------------------------------
describe('auto-migration backfill', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'items-mig-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function makeDb() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT,
        printFile TEXT, durationMins INTEGER DEFAULT 0,
        items INTEGER, items_lost INTEGER NOT NULL DEFAULT 0, plate_name TEXT);
    `);
    return db;
  }
  const touch = (name) => { fs.writeFileSync(path.join(dir, name), 'x'); return name; };
  const addJob = (db, { printFile, durationMins = 0, items = null }) =>
    db.prepare('INSERT INTO jobs (name, printFile, durationMins, items) VALUES (?,?,?,?)')
      .run('J', printFile, durationMins, items).lastInsertRowid;
  // Fake parser keyed by filename → plate array.
  const makeParser = (byFile) => (full) => byFile[path.basename(full)] || { plates: [] };

  test('single-plate 3MF → backfills items + plate_name', () => {
    const db = makeDb();
    const id = addJob(db, { printFile: touch('aa.3mf') });
    const parse3mf = makeParser({ 'aa.3mf': { plates: [{ objectCount: 6, plateName: 'Dino', printTimeMinutes: 120 }] } });
    const r = itemsMigration.backfillItems({ db, uploadsDir: dir, parse3mf, fs, path });
    expect(r.ran).toBe(true);
    expect(r.stats.singlePlate).toBe(1);
    const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    expect(row).toMatchObject({ items: 6, plate_name: 'Dino' });
  });

  test('multi-plate with EXACTLY ONE duration match → backfills from that plate', () => {
    const db = makeDb();
    const id = addJob(db, { printFile: touch('bb.3mf'), durationMins: 90 });
    const parse3mf = makeParser({ 'bb.3mf': { plates: [
      { objectCount: 3, plateName: 'A', printTimeMinutes: 30 },
      { objectCount: 8, plateName: 'B', printTimeMinutes: 90.2 }, // rounds to 90 → unique match
    ] } });
    const r = itemsMigration.backfillItems({ db, uploadsDir: dir, parse3mf, fs, path });
    expect(r.stats.multiMatched).toBe(1);
    const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    expect(row).toMatchObject({ items: 8, plate_name: 'B' });
  });

  test('multi-plate with 0 or >1 duration matches → left NULL (ambiguous)', () => {
    const db = makeDb();
    const idNone = addJob(db, { printFile: touch('cc.3mf'), durationMins: 999 });
    const idDup  = addJob(db, { printFile: touch('dd.3mf'), durationMins: 60 });
    const parse3mf = makeParser({
      'cc.3mf': { plates: [{ objectCount: 3, printTimeMinutes: 30 }, { objectCount: 4, printTimeMinutes: 40 }] },
      'dd.3mf': { plates: [{ objectCount: 3, printTimeMinutes: 60 }, { objectCount: 4, printTimeMinutes: 60 }] }, // two matches
    });
    const r = itemsMigration.backfillItems({ db, uploadsDir: dir, parse3mf, fs, path });
    expect(r.stats.ambiguous).toBe(2);
    expect(db.prepare('SELECT items FROM jobs WHERE id=?').get(idNone).items).toBeNull();
    expect(db.prepare('SELECT items FROM jobs WHERE id=?').get(idDup).items).toBeNull();
  });

  test('missing file / non-3MF printFile / parse failure are skipped, never fabricated', () => {
    const db = makeDb();
    const idMissing = addJob(db, { printFile: 'gone.3mf' });        // file not on disk
    const idLabel   = addJob(db, { printFile: '/some/label.txt' }); // arbitrary string
    const idEmpty   = addJob(db, { printFile: touch('ee.3mf') });   // parses to no plates
    const parse3mf  = makeParser({ 'ee.3mf': { plates: [] } });
    const r = itemsMigration.backfillItems({ db, uploadsDir: dir, parse3mf, fs, path });
    expect(r.stats.backfilled).toBe(0);
    expect(r.stats.skipped).toBe(3);
    for (const id of [idMissing, idLabel, idEmpty]) {
      expect(db.prepare('SELECT items FROM jobs WHERE id=?').get(id).items).toBeNull();
    }
  });

  test('never overwrites an already-set items value', () => {
    const db = makeDb();
    const id = addJob(db, { printFile: touch('ff.3mf'), items: 99 });
    const parse3mf = makeParser({ 'ff.3mf': { plates: [{ objectCount: 1, printTimeMinutes: 10 }] } });
    const r = itemsMigration.backfillItems({ db, uploadsDir: dir, parse3mf, fs, path });
    expect(r.stats.scanned).toBe(0); // items-NOT-NULL rows are never scanned
    expect(db.prepare('SELECT items FROM jobs WHERE id=?').get(id).items).toBe(99);
  });

  test('marker prevents a second run', () => {
    const db = makeDb();
    addJob(db, { printFile: touch('gg.3mf') });
    const parse3mf = makeParser({ 'gg.3mf': { plates: [{ objectCount: 2, printTimeMinutes: 10 }] } });
    expect(itemsMigration.backfillItems({ db, uploadsDir: dir, parse3mf, fs, path }).ran).toBe(true);
    // A new NULL job added after the first run is NOT touched on a second call.
    addJob(db, { printFile: touch('hh.3mf') });
    const parse2 = makeParser({ 'hh.3mf': { plates: [{ objectCount: 5, printTimeMinutes: 10 }] } });
    const r2 = itemsMigration.backfillItems({ db, uploadsDir: dir, parse3mf: parse2, fs, path });
    expect(r2).toEqual({ ran: false, reason: 'marker-present' });
    expect(db.prepare("SELECT value FROM settings WHERE key=?").get(itemsMigration.MARKER_KEY).value).toBe('1');
  });

  test('a throwing parser on one job does not abort the whole migration', () => {
    const db = makeDb();
    const idBad  = addJob(db, { printFile: touch('bad.3mf') });
    const idGood = addJob(db, { printFile: touch('good.3mf') });
    const parse3mf = (full) => {
      if (path.basename(full) === 'bad.3mf') throw new Error('boom');
      return { plates: [{ objectCount: 4, plateName: 'G', printTimeMinutes: 10 }] };
    };
    const r = itemsMigration.backfillItems({ db, uploadsDir: dir, parse3mf, fs, path });
    expect(r.stats.skipped).toBe(1);
    expect(db.prepare('SELECT items FROM jobs WHERE id=?').get(idBad).items).toBeNull();
    expect(db.prepare('SELECT items FROM jobs WHERE id=?').get(idGood).items).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// B/C/F. Route-level integration (supertest)
// ---------------------------------------------------------------------------
describe('item-count routes (integration)', () => {
  process.env.NODE_ENV = 'test';
  process.env.PLANNER_DB_PATH =
    process.env.PLANNER_DB_PATH || path.join(os.tmpdir(), `printfarm-items-test-${process.pid}.db`);
  const request = require('supertest');
  let app, appDb, printerId, UPLOADS_DIR;
  const SESSION_TOKEN = 'items-session-token';
  const authCookie = `pf_session=${SESSION_TOKEN}`;

  beforeAll(() => {
    appDb = require('../db');
    app   = require('../server');
    UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION_TOKEN, Date.now() + 3_600_000);
  });
  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers; DELETE FROM projects;');
    printerId = appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('P1', '#f00', 5, 15).lastInsertRowid;
  });
  afterAll(() => { try { appDb.exec('DELETE FROM jobs; DELETE FROM printers; DELETE FROM projects;'); } catch {} });

  const post = (url, body) => request(app).post(url).set('Cookie', authCookie).send(body);
  const put  = (url, body) => request(app).put(url).set('Cookie', authCookie).send(body);

  // --- C. Manual create + edit + items_lost validation ---
  test('POST /api/jobs stores items + items_lost', async () => {
    const r = await post('/api/jobs', { printerId, name: 'J', start: '2026-08-04T08:00', end: '2026-08-04T09:00', items: 8, items_lost: 2 });
    expect(r.status).toBe(201);
    const row = appDb.prepare('SELECT items, items_lost FROM jobs WHERE id=?').get(r.body.id);
    expect(row).toMatchObject({ items: 8, items_lost: 2 });
  });

  test('POST /api/jobs with empty items stores NULL (untracked)', async () => {
    const r = await post('/api/jobs', { printerId, name: 'J', start: '2026-08-04T08:00', end: '2026-08-04T09:00', items: null });
    const row = appDb.prepare('SELECT items, items_lost FROM jobs WHERE id=?').get(r.body.id);
    expect(row.items).toBeNull();
    expect(row.items_lost).toBe(0);
  });

  test('server clamps items_lost to items when it would exceed it', async () => {
    const r = await post('/api/jobs', { printerId, name: 'J', start: '2026-08-04T08:00', end: '2026-08-04T09:00', items: 3, items_lost: 10 });
    expect(appDb.prepare('SELECT items_lost FROM jobs WHERE id=?').get(r.body.id).items_lost).toBe(3);
  });

  test('PUT /api/jobs/:id edits items + items_lost', async () => {
    const c = await post('/api/jobs', { printerId, name: 'J', start: '2026-08-04T08:00', end: '2026-08-04T09:00', items: 4 });
    await put(`/api/jobs/${c.body.id}`, { printerId, name: 'J', start: '2026-08-04T08:00', end: '2026-08-04T09:00', items: 9, items_lost: 1 });
    expect(appDb.prepare('SELECT items, items_lost FROM jobs WHERE id=?').get(c.body.id)).toMatchObject({ items: 9, items_lost: 1 });
  });

  // --- B. Import passthrough ---
  test('POST /api/import-3mf-schedule sets items + plate_name from the plate; missing items → NULL', async () => {
    const before = new Set(fs.readdirSync(UPLOADS_DIR));
    const plates = [
      { plateIndex: 1, name: 'Dino Plate', printerId, durationMins: 60, items: 6 },
      { plateIndex: 2, name: 'No Items Plate', printerId, durationMins: 30 }, // no items field
    ];
    const hdr = encodeURIComponent(JSON.stringify({ plates, startISO: '2026-08-04T08:00:00.000Z', mode: 'manual' }));
    const res = await request(app).post('/api/import-3mf-schedule')
      .set('Cookie', authCookie)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Schedule', hdr)
      .send(Buffer.from('not-a-real-3mf'));
    expect(res.status).toBe(201);
    const rows = appDb.prepare('SELECT name, items, plate_name FROM jobs ORDER BY id').all();
    expect(rows[0]).toMatchObject({ items: 6, plate_name: 'Dino Plate' });
    expect(rows[1].items).toBeNull();
    expect(rows[1].plate_name).toBe('No Items Plate');
    // Clean up the stored 3MF this import wrote so tests leave no junk behind.
    for (const f of fs.readdirSync(UPLOADS_DIR)) if (!before.has(f)) fs.unlinkSync(path.join(UPLOADS_DIR, f));
  });

  // --- F. Reload route ---
  test('GET /api/jobs/:id/3mf-plates returns [] when the job has no retained 3MF', async () => {
    const c = await post('/api/jobs', { printerId, name: 'J', start: '2026-08-04T08:00', end: '2026-08-04T09:00', printFile: '/a/label.txt' });
    const r = await request(app).get(`/api/jobs/${c.body.id}/3mf-plates`).set('Cookie', authCookie);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  test('GET /api/jobs/:id/3mf-plates lists real plates parsed from a retained 3MF', () => {
    // Build a genuine 2-plate sliced 3MF (a ZIP of Metadata/*) and let the real
    // parse3mf read it — the route destructures parse3mf at require time, so a
    // module spy can't reach it; a real fixture exercises the true code path.
    const { execSync } = require('child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '3mf-'));
    fs.mkdirSync(path.join(tmp, 'Metadata'), { recursive: true });
    const sliceInfo = `<?xml version="1.0"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="2724"/>
    <object name="l1.stl" id="1"/>
    <object name="l2.stl" id="2"/>
    <object name="l3.stl" id="3"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="prediction" value="7200"/>
    <object name="r1.stl" id="1"/>
    <object name="r2.stl" id="2"/>
    <object name="r3.stl" id="3"/>
    <object name="r4.stl" id="4"/>
    <object name="r5.stl" id="5"/>
  </plate>
</config>`;
    const modelSettings = `<?xml version="1.0"?>
<config>
  <plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Left"/></plate>
  <plate><metadata key="plater_id" value="2"/><metadata key="plater_name" value="Right"/></plate>
</config>`;
    fs.writeFileSync(path.join(tmp, 'Metadata', 'slice_info.config'), sliceInfo);
    fs.writeFileSync(path.join(tmp, 'Metadata', 'model_settings.config'), modelSettings);
    fs.writeFileSync(path.join(tmp, 'Metadata', 'plate_1.json'), JSON.stringify({ bbox_objects: [], bed_type: 'textured' }));
    fs.writeFileSync(path.join(tmp, 'Metadata', 'plate_2.json'), JSON.stringify({ bbox_objects: [], bed_type: 'textured' }));
    const stored = 'realfixture.3mf';
    const outPath = path.join(UPLOADS_DIR, stored);
    execSync(`cd "${tmp}" && zip -qr "${outPath}" Metadata`);
    fs.rmSync(tmp, { recursive: true, force: true });

    return post('/api/jobs', { printerId, name: 'J', start: '2026-08-04T08:00', end: '2026-08-04T09:00' })
      .then(c => {
        appDb.prepare('UPDATE jobs SET printFile=? WHERE id=?').run(stored, c.body.id);
        return request(app).get(`/api/jobs/${c.body.id}/3mf-plates`).set('Cookie', authCookie);
      })
      .then(r => {
        expect(r.status).toBe(200);
        expect(r.body).toEqual([
          { name: 'Left', objectCount: 3, durationMins: 45 },   // 2724s → 45.4 → round 45
          { name: 'Right', objectCount: 5, durationMins: 120 }, // 7200s → 120
        ]);
      })
      .finally(() => { try { fs.unlinkSync(outPath); } catch {} });
  });
});

// ---------------------------------------------------------------------------
// G. UI wiring (index.html + app.js)
// ---------------------------------------------------------------------------
describe('items UI wiring', () => {
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  test('job dialog has Items + Items-lost inputs and the reload button', () => {
    expect(HTML).toContain('id="job-items"');
    expect(HTML).toContain('id="job-items-lost"');
    expect(HTML).toContain('id="btn-reload-items-3mf"');
    expect(HTML).toContain('Herlaad items uit 3MF');
  });

  test('saveJob validates non-negative integers and rejects loss > items', () => {
    expect(APP).toContain("getElementById('job-items')");
    expect(APP).toContain("getElementById('job-items-lost')");
    expect(APP).toContain('Verlies kan niet groter zijn dan het aantal items');
    expect(APP).toContain('items_lost: itemsLost');
  });

  test('project counter renders an items line with a verlies badge', () => {
    expect(APP).toContain('items ${p.itemsDoneAdj}/${p.itemsTotalAdj}');
    expect(APP).toContain('verlies');
    expect(APP).toContain('p.itemsTotal > 0'); // only when tracked
  });

  test('reload-from-3MF fetches plates and PATCHes items + plate_name', () => {
    expect(APP).toContain('/3mf-plates');
    expect(APP).toContain('function reloadItemsFrom3mf');
    expect(APP).toContain('plate_name: plate.name');
  });
});
