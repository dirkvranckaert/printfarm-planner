// Deleting a job (queued or scheduled) must unlink its upload artifacts — the
// imported `<hex>.3mf` and plate thumbnail PNG(s) — but only files no surviving
// job still references (one 3MF backs every plate/copy; copies share a thumb).
// Drives the REAL Express DELETE routes in-process via supertest, against the
// app's real DB layer (temp file) and real UPLOADS_DIR.

const os     = require('os');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
process.env.NODE_ENV = 'test';
process.env.PLANNER_DB_PATH =
  process.env.PLANNER_DB_PATH || path.join(os.tmpdir(), `printfarm-test-${process.pid}.db`);

const request = require('supertest');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

describe('job delete removes upload artifacts', () => {
  let appDb, app, printerId;
  const SESSION_TOKEN = 'job-delete-files-session';
  const authCookie = `pf_session=${SESSION_TOKEN}`;
  const written = new Set(); // track files we create so afterAll can sweep

  const hex = () => crypto.randomBytes(8).toString('hex');
  const upPath = (name) => path.join(UPLOADS_DIR, name);
  const exists = (name) => fs.existsSync(upPath(name));

  // Create a 3MF + thumbnail on disk with unique names; return the names.
  const makeFiles = () => {
    const printFile = `${hex()}.3mf`;
    const thumbFile = `${hex()}.png`;
    fs.writeFileSync(upPath(printFile), 'FAKE-3MF');
    fs.writeFileSync(upPath(thumbFile), 'FAKE-PNG');
    written.add(printFile); written.add(thumbFile);
    return { printFile, thumbFile };
  };

  const insertJob = ({ printFile = null, thumbFile = null, queued = 0, scheduled = true }) => {
    const start = queued || !scheduled ? '' : '2026-04-13T06:00:00Z';
    const end   = queued || !scheduled ? '' : '2026-04-13T07:00:00Z';
    return appDb.prepare(
      'INSERT INTO jobs (printerId, name, start, end, status, printFile, thumbFile, queued) VALUES (?,?,?,?,?,?,?,?)'
    ).run(queued ? null : printerId, 'J', start, end, 'Planned', printFile, thumbFile, queued).lastInsertRowid;
  };

  const del = (url) => request(app).delete(url).set('Cookie', authCookie);

  beforeAll(() => {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    appDb = require('../db');
    app   = require('../server');
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION_TOKEN, Date.now() + 3_600_000);
  });

  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers;');
    const r = appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('P1', '#f00', 5, 15);
    printerId = r.lastInsertRowid;
  });

  afterAll(() => {
    for (const name of written) { try { fs.unlinkSync(upPath(name)); } catch { /* already gone */ } }
    try { appDb.exec('DELETE FROM jobs; DELETE FROM printers;'); } catch { /* ignore */ }
  });

  test('deleting a QUEUED job unlinks its 3mf + thumbnail', async () => {
    const { printFile, thumbFile } = makeFiles();
    const id = insertJob({ printFile, thumbFile, queued: 1 });

    const r = await del(`/api/jobs/${id}`);
    expect(r.status).toBe(204);
    expect(exists(printFile)).toBe(false);
    expect(exists(thumbFile)).toBe(false);
  });

  test('deleting a SCHEDULED job unlinks its 3mf + thumbnail', async () => {
    const { printFile, thumbFile } = makeFiles();
    const id = insertJob({ printFile, thumbFile, queued: 0 });

    const r = await del(`/api/jobs/${id}`);
    expect(r.status).toBe(204);
    expect(exists(printFile)).toBe(false);
    expect(exists(thumbFile)).toBe(false);
  });

  test('shared 3MF is kept while another job still references it, unlinked with the last', async () => {
    // One import -> two plate jobs share printFile, each has its own thumbnail.
    const { printFile } = makeFiles();
    const thumbA = `${hex()}.png`; const thumbB = `${hex()}.png`;
    fs.writeFileSync(upPath(thumbA), 'A'); fs.writeFileSync(upPath(thumbB), 'B');
    written.add(thumbA); written.add(thumbB);
    const a = insertJob({ printFile, thumbFile: thumbA });
    const b = insertJob({ printFile, thumbFile: thumbB });

    expect((await del(`/api/jobs/${a}`)).status).toBe(204);
    expect(exists(printFile)).toBe(true);   // still referenced by b
    expect(exists(thumbA)).toBe(false);     // a's own thumb gone
    expect(exists(thumbB)).toBe(true);

    expect((await del(`/api/jobs/${b}`)).status).toBe(204);
    expect(exists(printFile)).toBe(false);  // last reference gone
    expect(exists(thumbB)).toBe(false);
  });

  test('shared THUMBNAIL (plate copies) is kept until the last copy is deleted', async () => {
    // Copies of one plate share BOTH the 3MF and the thumbnail.
    const { printFile, thumbFile } = makeFiles();
    const a = insertJob({ printFile, thumbFile });
    const b = insertJob({ printFile, thumbFile });

    expect((await del(`/api/jobs/${a}`)).status).toBe(204);
    expect(exists(printFile)).toBe(true);
    expect(exists(thumbFile)).toBe(true);   // still referenced by copy b

    expect((await del(`/api/jobs/${b}`)).status).toBe(204);
    expect(exists(printFile)).toBe(false);
    expect(exists(thumbFile)).toBe(false);
  });

  test('delete still succeeds (204, no throw) when the files are already missing', async () => {
    const printFile = `${hex()}.3mf`; const thumbFile = `${hex()}.png`; // never written to disk
    const id = insertJob({ printFile, thumbFile });

    const r = await del(`/api/jobs/${id}`);
    expect(r.status).toBe(204);
    expect(appDb.prepare('SELECT COUNT(*) AS c FROM jobs WHERE id=?').get(id).c).toBe(0);
  });

  test('deleting a job with no attached files succeeds (204) and unlinks nothing', async () => {
    const id = insertJob({ printFile: null, thumbFile: null });

    const r = await del(`/api/jobs/${id}`);
    expect(r.status).toBe(204);
    expect(appDb.prepare('SELECT COUNT(*) AS c FROM jobs WHERE id=?').get(id).c).toBe(0);
  });

  test('deleting a printer cascades file cleanup for its jobs', async () => {
    const { printFile, thumbFile } = makeFiles();
    insertJob({ printFile, thumbFile });

    const r = await del(`/api/printers/${printerId}`);
    expect(r.status).toBe(204);
    expect(exists(printFile)).toBe(false);
    expect(exists(thumbFile)).toBe(false);
  });
});
