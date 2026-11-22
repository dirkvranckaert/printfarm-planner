// DELETE /api/queue (#4067): clears all queued jobs in one go, skips Processing
// placeholders, leaves scheduled jobs alone, removes files ref-counted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { listenLocal, closeServer } = require('./helpers/listen-local');

describe('DELETE /api/queue', () => {
  const TOKEN = 'queue-clear-session-token';
  const cookie = `pf_session=${TOKEN}`;
  const uploadsDir = process.env.PLANNER_UPLOADS_DIR;
  let server, app, appDb, printerId;
  const hex = () => crypto.randomBytes(8).toString('hex');
  const mk = (ext) => { const n = `${hex()}.${ext}`; fs.writeFileSync(path.join(uploadsDir, n), 'X'); return n; };
  const exists = (n) => fs.existsSync(path.join(uploadsDir, n));
  const ins = (o) => appDb.prepare(
    'INSERT INTO jobs (printerId, name, start, end, status, printFile, thumbFile, original_file, queued) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(o.queued ? null : printerId, o.name || 'J', o.queued ? '' : '2026-04-13T06:00:00Z', o.queued ? '' : '2026-04-13T07:00:00Z',
    o.status || 'Planned', o.printFile || null, o.thumbFile || null, o.original || null, o.queued ? 1 : 0).lastInsertRowid;
  const count = (q) => appDb.prepare(`SELECT COUNT(*) c FROM jobs WHERE ${q}`).get().c;

  beforeAll(async () => {
    fs.mkdirSync(uploadsDir, { recursive: true });
    appDb = require('../db');
    app = require('../server');
    server = await listenLocal(app);
    appDb.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)').run(TOKEN, Date.now() + 3_600_000);
  });
  afterAll(() => closeServer(server));
  beforeEach(() => {
    appDb.exec('DELETE FROM jobs; DELETE FROM printers; DELETE FROM split_orphans;');
    printerId = appDb.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)').run('P1', '#f00', 5, 15).lastInsertRowid;
  });

  test('mixed queue: deletes normal + split siblings, skips Processing, keeps scheduled, cleans files', async () => {
    const original = mk('3mf');           // shared by two split siblings + the scheduled job
    const orphanOriginal = mk('3mf');     // shared by two queued siblings only
    const n = { print: mk('3mf'), thumb: mk('png') };
    const s1 = { print: mk('3mf'), thumb: mk('png') };
    const s2 = { print: mk('3mf'), thumb: mk('png') };
    const sched = { print: mk('3mf'), thumb: mk('png') };
    const proc = { print: mk('3mf') };
    ins({ queued: 1, printFile: n.print, thumbFile: n.thumb });
    ins({ queued: 1, printFile: s1.print, thumbFile: s1.thumb, original: orphanOriginal });
    ins({ queued: 1, printFile: s2.print, thumbFile: s2.thumb, original: orphanOriginal });
    const procId = ins({ queued: 1, status: 'Processing', printFile: proc.print });
    const schedId = ins({ queued: 0, printFile: sched.print, thumbFile: sched.thumb, original });
    ins({ queued: 1, printFile: mk('3mf'), original }); // queued sibling sharing scheduled job's original

    const res = await request(server).delete('/api/queue').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 4, skipped: 1 });
    expect(count('queued=1')).toBe(1);
    expect(appDb.prepare('SELECT id FROM jobs WHERE queued=1').get().id).toBe(procId);
    expect(appDb.prepare('SELECT id FROM jobs WHERE id=?').get(schedId)).toBeTruthy();

    expect(exists(n.print) || exists(n.thumb)).toBe(false);
    expect(exists(s1.print) || exists(s1.thumb) || exists(s2.print) || exists(s2.thumb)).toBe(false);
    expect(exists(orphanOriginal)).toBe(false);   // last reference gone
    expect(exists(original)).toBe(true);          // still used by the scheduled job
    expect(exists(sched.print) && exists(sched.thumb)).toBe(true);
    expect(exists(proc.print)).toBe(true);        // Processing untouched
  });

  test('empty queue: nothing deleted, 200 with zeros', async () => {
    ins({ queued: 0 });
    const res = await request(server).delete('/api/queue').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 0, skipped: 0 });
    expect(count('1=1')).toBe(1);
  });

  test('requires auth', async () => {
    const res = await request(server).delete('/api/queue');
    expect([401, 302, 403]).toContain(res.status);
  });
});
