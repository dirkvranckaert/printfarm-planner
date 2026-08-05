// Projects feature — resolve/create/reopen, counts/buckets, sort order,
// context-menu assign (existing-only), first-create push toggle, project detail
// grouping, and the Settings + UI wiring.

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const projects = require('../projects');
const push = require('../push');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT,
      status TEXT DEFAULT 'Planned', queued INTEGER NOT NULL DEFAULT 0,
      project_id TEXT,
      items INTEGER, items_lost INTEGER NOT NULL DEFAULT 0, plate_name TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, subscription TEXT NOT NULL);
  `);
  return db;
}

const addJob = (db, status, projectId = null, queued = 0) =>
  db.prepare('INSERT INTO jobs (name, status, queued, project_id) VALUES (?,?,?,?)')
    .run('J', status, queued, projectId).lastInsertRowid;

describe('resolveProject — auto-create / reuse / reopen', () => {
  test('first use creates a row: id=lowercase(trim), label=casing preserved', () => {
    const db = makeDb();
    const r = projects.resolveProject({ db, name: '  Dino Batch ' });
    expect(r).toMatchObject({ id: 'dino batch', label: 'Dino Batch', created: true, reopened: false });
    const row = db.prepare('SELECT * FROM projects WHERE id=?').get('dino batch');
    expect(row.label).toBe('Dino Batch');
    expect(row.status).toBe('open');
  });

  test('reuse of an existing name does NOT duplicate and keeps the original label', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'Giraffe' });
    const r2 = projects.resolveProject({ db, name: 'GIRAFFE' }); // different casing, same id
    expect(r2).toMatchObject({ id: 'giraffe', label: 'Giraffe', created: false });
    expect(db.prepare('SELECT COUNT(*) c FROM projects').get().c).toBe(1);
    expect(db.prepare('SELECT label FROM projects WHERE id=?').get('giraffe').label).toBe('Giraffe');
  });

  test('a closed project auto-reopens on a matching name', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'Keychains' });
    db.prepare("UPDATE projects SET status='closed' WHERE id=?").run('keychains');
    const r = projects.resolveProject({ db, name: 'keychains' });
    expect(r).toMatchObject({ created: false, reopened: true });
    expect(db.prepare('SELECT status FROM projects WHERE id=?').get('keychains').status).toBe('open');
  });

  test('blank name resolves to null (no project)', () => {
    const db = makeDb();
    expect(projects.resolveProject({ db, name: '   ' })).toBeNull();
    expect(projects.resolveProject({ db, name: '' })).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM projects').get().c).toBe(0);
  });
});

describe('assignExisting — context-menu assign (existing only)', () => {
  test('rejects an unknown project id with 404 and never creates', () => {
    const db = makeDb();
    const jobId = addJob(db, 'Planned');
    const r = projects.assignExisting({ db, jobId, projectId: 'ghost' });
    expect(r).toEqual({ ok: false, code: 404 });
    expect(db.prepare('SELECT COUNT(*) c FROM projects').get().c).toBe(0);
    expect(db.prepare('SELECT project_id FROM jobs WHERE id=?').get(jobId).project_id).toBeNull();
  });

  test('assigns to an existing project', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'Alpha' });
    const jobId = addJob(db, 'Planned');
    const r = projects.assignExisting({ db, jobId, projectId: 'Alpha' });
    expect(r).toMatchObject({ ok: true, id: 'alpha' });
    expect(db.prepare('SELECT project_id FROM jobs WHERE id=?').get(jobId).project_id).toBe('alpha');
  });

  test('assigning to a closed project reopens it (gives it an active task)', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'Beta' });
    db.prepare("UPDATE projects SET status='closed' WHERE id=?").run('beta');
    const jobId = addJob(db, 'Planned');
    const r = projects.assignExisting({ db, jobId, projectId: 'beta' });
    expect(r).toMatchObject({ ok: true, reopened: true });
    expect(db.prepare('SELECT status FROM projects WHERE id=?').get('beta').status).toBe('open');
  });
});

describe('deleteIfEmpty — delete only an empty project', () => {
  test('deletes a project that has no linked jobs', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'Empties' });
    const r = projects.deleteIfEmpty({ db, projectId: 'Empties' });
    expect(r).toEqual({ ok: true });
    expect(db.prepare('SELECT COUNT(*) c FROM projects WHERE id=?').get('empties').c).toBe(0);
  });

  test('refuses (409) while a job still references it and leaves it intact', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'Linked' });
    const jobId = addJob(db, 'Planned', 'linked');
    const r = projects.deleteIfEmpty({ db, projectId: 'linked' });
    expect(r).toMatchObject({ ok: false, code: 409, jobs: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM projects WHERE id=?').get('linked').c).toBe(1);
    // never cascades: the job is untouched.
    expect(db.prepare('SELECT project_id FROM jobs WHERE id=?').get(jobId).project_id).toBe('linked');
  });

  test('a queued-only project is NOT empty: still refuses (409)', () => {
    // Queued jobs also hold a project_id, so they block the delete. The button
    // gate mirrors this by counting data.jobs unfiltered (incl. queued).
    const db = makeDb();
    projects.resolveProject({ db, name: 'QueuedOnly' });
    addJob(db, 'Planned', 'queuedonly', 1); // queued
    const r = projects.deleteIfEmpty({ db, projectId: 'queuedonly' });
    expect(r).toMatchObject({ ok: false, code: 409, jobs: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM projects WHERE id=?').get('queuedonly').c).toBe(1);
  });

  test('unknown id -> 404', () => {
    const db = makeDb();
    expect(projects.deleteIfEmpty({ db, projectId: 'ghost' })).toEqual({ ok: false, code: 404 });
  });
});

describe('counts / buckets', () => {
  test('bucketOf maps statuses to to-print / busy / done', () => {
    for (const s of ['Planned', 'Awaiting', 'Awaiting Printer', 'Paused']) expect(projects.bucketOf(s)).toBe('toprint');
    for (const s of ['Printing', 'Post Printing']) expect(projects.bucketOf(s)).toBe('busy');
    expect(projects.bucketOf('Done')).toBe('done');
  });

  test('countsByProject computes done/total + busy correctly', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'P' });
    addJob(db, 'Done', 'p');
    addJob(db, 'Done', 'p');
    addJob(db, 'Printing', 'p');
    addJob(db, 'Planned', 'p');
    addJob(db, 'Awaiting Printer', 'p');
    const c = projects.countsByProject(db)['p'];
    expect(c).toMatchObject({ toPrint: 2, busy: 1, done: 2, total: 5 });
  });

  test('queued jobs are excluded from counts', () => {
    const db = makeDb();
    projects.resolveProject({ db, name: 'Q' });
    addJob(db, 'Planned', 'q', 1); // queued
    addJob(db, 'Planned', 'q', 0);
    const c = projects.countsByProject(db)['q'];
    expect(c.total).toBe(1);
  });
});

describe('summaries — sort order', () => {
  test('active (most active first) -> completed -> closed at very bottom', () => {
    const db = makeDb();
    // active-lo: 1 to-print
    projects.resolveProject({ db, name: 'ActiveLo' });
    addJob(db, 'Planned', 'activelo');
    // active-hi: 3 active jobs
    projects.resolveProject({ db, name: 'ActiveHi' });
    addJob(db, 'Planned', 'activehi'); addJob(db, 'Printing', 'activehi'); addJob(db, 'Awaiting', 'activehi');
    // completed: only Done
    projects.resolveProject({ db, name: 'Completed' });
    addJob(db, 'Done', 'completed');
    // closed: has active jobs but is closed -> still bottom
    projects.resolveProject({ db, name: 'ClosedOne' });
    addJob(db, 'Planned', 'closedone');
    db.prepare("UPDATE projects SET status='closed' WHERE id=?").run('closedone');

    const order = projects.summaries(db).map(p => p.id);
    expect(order).toEqual(['activehi', 'activelo', 'completed', 'closedone']);
  });
});

describe('first-create push — project toggle', () => {
  function setPref(db, value) {
    db.prepare('INSERT INTO settings (key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('push.notify.project', JSON.stringify(value));
  }

  test('default (no stored pref) -> isEnabled ON', () => {
    const db = makeDb();
    push.init(db);
    expect(push.isEnabled('project')).toBe(true);
  });

  test('switch OFF -> isEnabled false -> send gated off', () => {
    const db = makeDb();
    push.init(db);
    setPref(db, false);
    expect(push.isEnabled('project')).toBe(false);
  });

  test('push fires ONCE on genuine first-create and respects the toggle', () => {
    const db = makeDb();
    push.init(db);
    const spy = jest.spyOn(push, 'sendToAll').mockImplementation(() => {});
    // Mirror the server-side gate: fire only when created && enabled.
    const fire = (name) => {
      const r = projects.resolveProject({ db, name });
      if (r?.created && push.isEnabled('project')) push.sendToAll({ title: 'x', body: r.label });
    };
    fire('Gamma');           // first create -> ON -> sends
    fire('Gamma');           // reuse -> not created -> no send
    expect(spy).toHaveBeenCalledTimes(1);

    setPref(db, false);
    fire('Delta');           // first create but toggle OFF -> no send
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('reopen does not fire the first-create push', () => {
    const db = makeDb();
    push.init(db);
    const spy = jest.spyOn(push, 'sendToAll').mockImplementation(() => {});
    const fire = (name) => {
      const r = projects.resolveProject({ db, name });
      if (r?.created && push.isEnabled('project')) push.sendToAll({ title: 'x' });
    };
    fire('Epsilon');
    db.prepare("UPDATE projects SET status='closed' WHERE id=?").run('epsilon');
    fire('Epsilon');         // reopen, not create
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// ---- Route-level integration (supertest) ----
describe('project routes (integration)', () => {
  const os = require('os');
  process.env.NODE_ENV = 'test';
  process.env.PLANNER_DB_PATH =
    process.env.PLANNER_DB_PATH || path.join(os.tmpdir(), `printfarm-projects-test-${process.pid}.db`);
  const request = require('supertest');
  let app, appDb, printerId;
  const SESSION_TOKEN = 'projects-session-token';
  const authCookie = `pf_session=${SESSION_TOKEN}`;

  beforeAll(() => {
    appDb = require('../db');
    app   = require('../server');
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION_TOKEN, Date.now() + 3_600_000);
  });

  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers; DELETE FROM projects;');
    const r = appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('P1', '#f00', 5, 15);
    printerId = r.lastInsertRowid;
  });

  afterAll(() => {
    try { appDb.exec('DELETE FROM jobs; DELETE FROM printers; DELETE FROM projects;'); } catch { /* ignore */ }
  });

  const post = (url, body) => request(app).post(url).set('Cookie', authCookie).send(body);

  test('POST /api/jobs with a project name creates the project and assigns it', async () => {
    const r = await post('/api/jobs', {
      printerId, name: 'J1', start: '2026-08-04T08:00', end: '2026-08-04T09:00', project: 'Dino',
    });
    expect(r.status).toBe(201);
    expect(r.body.project_id).toBe('dino');
    const proj = appDb.prepare('SELECT * FROM projects WHERE id=?').get('dino');
    expect(proj.label).toBe('Dino');
  });

  test('a second job with the same name reuses the project (no duplicate)', async () => {
    await post('/api/jobs', { printerId, name: 'A', start: '2026-08-04T08:00', end: '2026-08-04T09:00', project: 'Shared' });
    await post('/api/jobs', { printerId, name: 'B', start: '2026-08-04T10:00', end: '2026-08-04T11:00', project: 'shared' });
    expect(appDb.prepare('SELECT COUNT(*) c FROM projects').get().c).toBe(1);
  });

  test('editing a job onto a closed project auto-reopens it', async () => {
    const c = await post('/api/jobs', { printerId, name: 'C', start: '2026-08-04T08:00', end: '2026-08-04T09:00', project: 'Reopenable' });
    appDb.prepare("UPDATE projects SET status='closed' WHERE id=?").run('reopenable');
    const jobId = c.body.id;
    const r = await request(app).put(`/api/jobs/${jobId}`).set('Cookie', authCookie)
      .send({ printerId, name: 'C', start: '2026-08-04T08:00', end: '2026-08-04T09:00', project: 'reopenable' });
    expect(r.status).toBe(200);
    expect(appDb.prepare('SELECT status FROM projects WHERE id=?').get('reopenable').status).toBe('open');
  });

  test('assign-project route rejects a non-existing project (404) and never creates', async () => {
    const c = await post('/api/jobs', { printerId, name: 'D', start: '2026-08-04T08:00', end: '2026-08-04T09:00' });
    const r = await post(`/api/jobs/${c.body.id}/assign-project`, { projectId: 'nope' });
    expect(r.status).toBe(404);
    expect(appDb.prepare('SELECT COUNT(*) c FROM projects').get().c).toBe(0);
  });

  test('assign-project route clears the project (project_id -> NULL) on the __none__ sentinel', async () => {
    const c = await post('/api/jobs', { printerId, name: 'E', start: '2026-08-04T08:00', end: '2026-08-04T09:00', project: 'Detachable' });
    expect(appDb.prepare('SELECT project_id FROM jobs WHERE id=?').get(c.body.id).project_id).toBe('detachable');
    const r = await post(`/api/jobs/${c.body.id}/assign-project`, { projectId: '__none__' });
    expect(r.status).toBe(200);
    expect(r.body.project_id).toBeNull();
    expect(appDb.prepare('SELECT project_id FROM jobs WHERE id=?').get(c.body.id).project_id).toBeNull();
    // Clearing never deletes the now-emptied project.
    expect(appDb.prepare('SELECT status FROM projects WHERE id=?').get('detachable').status).toBe('open');
  });

  test('GET /api/projects/:id returns the project + its jobs (for grouped detail)', async () => {
    await post('/api/jobs', { printerId, name: 'X1', start: '2026-08-04T08:00', end: '2026-08-04T09:00', project: 'Grouped' });
    await post('/api/jobs', { printerId, name: 'X2', start: '2026-08-04T10:00', end: '2026-08-04T11:00', project: 'Grouped' });
    const r = await request(app).get('/api/projects/grouped').set('Cookie', authCookie);
    expect(r.status).toBe(200);
    expect(r.body.project.label).toBe('Grouped');
    expect(r.body.jobs).toHaveLength(2);
  });

  test('GET /api/projects returns sorted summaries with counts', async () => {
    await post('/api/jobs', { printerId, name: 'Y1', start: '2026-08-04T08:00', end: '2026-08-04T09:00', project: 'Counts' });
    const r = await request(app).get('/api/projects').set('Cookie', authCookie);
    expect(r.status).toBe(200);
    const p = r.body.find(x => x.id === 'counts');
    expect(p).toMatchObject({ total: 1, done: 0, busy: 0, active: true });
  });

  test('DELETE /api/projects/:id removes an empty project', async () => {
    const c = await post('/api/jobs', { printerId, name: 'W1', start: '2026-08-04T08:00', end: '2026-08-04T09:00', project: 'Emptyable' });
    // Detach the only job so the project is empty, then delete it.
    await post(`/api/jobs/${c.body.id}/assign-project`, { projectId: '__none__' });
    const r = await request(app).delete('/api/projects/emptyable').set('Cookie', authCookie);
    expect(r.status).toBe(204);
    expect(appDb.prepare('SELECT COUNT(*) c FROM projects WHERE id=?').get('emptyable').c).toBe(0);
  });

  test('DELETE /api/projects/:id refuses (409) while a job still references it', async () => {
    const c = await post('/api/jobs', { printerId, name: 'W2', start: '2026-08-04T08:00', end: '2026-08-04T09:00', project: 'Keepme' });
    const r = await request(app).delete('/api/projects/keepme').set('Cookie', authCookie);
    expect(r.status).toBe(409);
    expect(appDb.prepare('SELECT COUNT(*) c FROM projects WHERE id=?').get('keepme').c).toBe(1);
    // Never cascades: the job keeps its project link.
    expect(appDb.prepare('SELECT project_id FROM jobs WHERE id=?').get(c.body.id).project_id).toBe('keepme');
  });

  test('DELETE /api/projects/:id on an unknown id is 404', async () => {
    const r = await request(app).delete('/api/projects/ghost').set('Cookie', authCookie);
    expect(r.status).toBe(404);
  });

  test('POST /api/projects/:id/close sets status=closed', async () => {
    await post('/api/jobs', { printerId, name: 'Z1', start: '2026-08-04T08:00', end: '2026-08-04T09:00', project: 'Closable' });
    const r = await post('/api/projects/closable/close', {});
    expect(r.status).toBe(200);
    expect(appDb.prepare('SELECT status FROM projects WHERE id=?').get('closable').status).toBe('closed');
  });
});

// ---- Settings + UI wiring ----
describe('project push switch + UI wiring (index.html + app.js)', () => {
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const APP  = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  test('Projecten button, project field, assign item + modals exist', () => {
    expect(HTML).toContain('id="btn-projects"');
    expect(HTML).toContain('id="job-project"');
    expect(HTML).toContain('id="project-suggestions"');
    expect(HTML).toContain('id="ctx-assign-project"');
    expect(HTML).toContain('id="bs-assign-project"');
    expect(HTML).toContain('id="projects-modal"');
    expect(HTML).toContain('id="project-detail-modal"');
    expect(HTML).toContain('id="assign-project-modal"');
    expect(HTML).toContain('id="push-notify-project"');
  });

  test('assign-to-project is wired on both desktop ctx-menu and tablet bottom sheet', () => {
    expect(APP).toContain("getElementById('ctx-assign-project').addEventListener");
    expect(APP).toContain("getElementById('bs-assign-project').addEventListener");
    // both paths open the same existing-only picker
    expect(APP.match(/openAssignProject\(id\)/g).length).toBeGreaterThanOrEqual(2);
  });

  test('assign picker offers a "Geen project" clear option and preselects the current project', () => {
    // Clear option at the top of the list.
    expect(APP).toContain('<option value="__none__">Geen project</option>');
    // Preselect reads the job's current project from the cache.
    expect(APP).toContain('jobsCache[jobId]?.project_id');
    expect(APP).toContain("sel.value = current || '__none__'");
  });

  test('app.js loads the stored project pref (default ON) and auto-saves it', () => {
    expect(APP).toContain("'/api/settings/push.notify.project'");
    expect(APP).toContain('cbProject.checked  = pnpr?.value !== false');
    expect(APP).toContain("'push-notify-project'");
  });

  test('project detail reuses the shared status-grouped renderer', () => {
    expect(APP).toContain('function renderStatusGroups(');
    expect(APP).toContain('renderStatusGroups(document.getElementById(\'project-detail-body\')');
  });

  test('counter format done/total + busy badge is emitted', () => {
    expect(APP).toContain('bezig');
    expect(APP).toContain('${p.done}/${p.total}');
  });

  test('context-menu job mutations refresh whichever project modal is open, in place', () => {
    // One shared helper drives both the detail modal and the Projecten list.
    expect(APP).toContain('function refreshOpenProjectViews(');
    expect(APP).toContain('function refreshProjectDetailIfOpen(');
    expect(APP).toContain('function refreshProjectsModalIfOpen(');
    // Routed from the desktop ctx-menu status handler, the tablet bottom-sheet
    // status handler, and the assign-project confirm path (>= 3 call sites).
    expect(APP.match(/refreshOpenProjectViews\(\)/g).length).toBeGreaterThanOrEqual(3);
    // Each refresh is gated to its own modal being open.
    expect(APP).toContain("getElementById('project-detail-modal')");
    expect(APP).toContain("getElementById('projects-modal')");
  });

  test('empty project is deletable via a gated Verwijder project control', () => {
    expect(HTML).toContain('id="btn-delete-project"');
    expect(APP).toContain("getElementById('btn-delete-project').addEventListener");
    expect(APP).toContain('function deleteCurrentProject(');
    // Delete control gated on the UNFILTERED job count (incl. queued) so it
    // matches deleteIfEmpty's all-jobs guard — a queued-only project is not
    // deletable and must not show the button.
    expect(APP).toContain("classList.toggle('hidden', data.jobs.length > 0)");
    // Backend guards the delete: empty-only, never cascades.
    expect(APP).toContain("api('DELETE', `/api/projects/");
  });
});
