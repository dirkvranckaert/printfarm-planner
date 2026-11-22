// "Open in slicer" (#4055) + upload path traversal (#4052):
//  - dl-token: mint/verify/expiry/tamper/binding
//  - detectSlicer per sample 3MF Application metadata
//  - real routes via supertest: mint (auth), signed download (no session), traversal on both routes
const os     = require('os');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
process.env.NODE_ENV = 'test';
process.env.SHARED_AUTH_SECRET = 'test-shared-secret-for-dl-token';

const request = require('supertest');
const { listenLocal, closeServer } = require('./helpers/listen-local');
const dlToken = require('../dl-token');
const { detectSlicer } = require('../parse3mf');

const UPLOADS_DIR = process.env.PLANNER_UPLOADS_DIR; // per-file temp dir (tests/isolate-env.js)

// Sign an arbitrary payload with the real key derivation (SHARED_AUTH_SECRET above).
function signWithRealKey(obj) {
  const key = crypto.createHmac('sha256', process.env.SHARED_AUTH_SECRET).update('printfarm-planner:dl-token:v1').digest();
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', key).update(payload).digest('base64url')}`;
}

describe('dl-token', () => {
  test('ADMIN_PASS is never a key source (token signed from it is rejected)', () => {
    const k = crypto.createHmac('sha256', process.env.ADMIN_PASS || 'changeme').update('printfarm-planner:dl-token:v1').digest();
    const payload = Buffer.from(JSON.stringify({ f: 'abcd.3mf', e: Date.now() + 1e5 })).toString('base64url');
    const sig = crypto.createHmac('sha256', k).update(payload).digest('base64url');
    expect(dlToken.verify(`${payload}.${sig}`)).toBeNull();
  });
  test('signWithRealKey produces a valid token for a valid payload (derivation matches)', () => {
    expect(dlToken.verify(signWithRealKey({ f: 'abcd.3mf', e: Date.now() + 1e5 }))).toBe('abcd.3mf');
  });
  const F = 'abcdef0123456789.3mf';
  const T0 = 1_000_000;

  test('roundtrip returns the bound filename', () => {
    expect(dlToken.verify(dlToken.mint(F, T0), T0 + 1000)).toBe(F);
  });
  test('expires after ~5 min', () => {
    const t = dlToken.mint(F, T0);
    expect(dlToken.verify(t, T0 + 5 * 60 * 1000 - 1)).toBe(F);
    expect(dlToken.verify(t, T0 + 5 * 60 * 1000 + 1)).toBeNull();
  });
  test('tampered payload (other file / later expiry) rejected', () => {
    const [p, s] = dlToken.mint(F, T0).split('.');
    const data = JSON.parse(Buffer.from(p, 'base64url').toString());
    const other = Buffer.from(JSON.stringify({ ...data, f: 'ffff.3mf' })).toString('base64url');
    const later = Buffer.from(JSON.stringify({ ...data, e: data.e + 9e9 })).toString('base64url');
    expect(dlToken.verify(`${other}.${s}`, T0)).toBeNull();
    expect(dlToken.verify(`${later}.${s}`, T0)).toBeNull();
  });
  test('tampered / truncated / garbage signature rejected', () => {
    const t = dlToken.mint(F, T0);
    expect(dlToken.verify(t.slice(0, -2) + 'AA', T0)).toBeNull();
    expect(dlToken.verify(t.slice(0, -5), T0)).toBeNull();
    for (const bad of ['', 'x', 'a.b', 'a.b.c', null, undefined, 42, '.'.repeat(5)]) {
      expect(dlToken.verify(bad, T0)).toBeNull();
    }
  });
  test('refuses to mint for non-stored names (traversal)', () => {
    expect(() => dlToken.mint('../x.3mf')).toThrow();
    expect(() => dlToken.mint('a/b.3mf')).toThrow();
    expect(() => dlToken.mint('abc.png')).toThrow();
  });
  test('token signed with another key is rejected', () => {
    const payload = Buffer.from(JSON.stringify({ f: F, e: T0 + 1000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', 'other').update(payload).digest('base64url');
    expect(dlToken.verify(`${payload}.${sig}`, T0)).toBeNull();
  });
});

describe('detectSlicer', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slicer-detect-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Build a real zip with 3D/3dmodel.model carrying the given Application metadata.
  const make3mf = (name, application) => {
    const work = path.join(dir, name + '.d');
    fs.mkdirSync(path.join(work, '3D'), { recursive: true });
    const meta = application == null ? '' : `<metadata name="Application">${application}</metadata>`;
    fs.writeFileSync(path.join(work, '3D', '3dmodel.model'),
      `<?xml version="1.0"?><model unit="millimeter">${meta}<metadata name="Title">x</metadata></model>`);
    const out = path.join(dir, name + '.3mf');
    execFileSync('zip', ['-qr', out, '3D'], { cwd: work });
    return out;
  };

  test.each([
    ['bambustudio', 'BambuStudio-02.01.01.52', 'bambustudio'],
    ['orca', 'OrcaSlicer-2.3.1', 'orcaslicer'],
    ['prusa', 'PrusaSlicer-2.8.0', 'prusaslicer'],
    ['cura', 'Cura_SteVe', null],
    ['noapp', null, null],
  ])('%s', (name, app, expected) => {
    expect(detectSlicer(make3mf(name, app))).toBe(expected);
  });

  test('non-zip / missing file -> null', () => {
    const junk = path.join(dir, 'junk.3mf');
    fs.writeFileSync(junk, 'not a zip');
    expect(detectSlicer(junk)).toBeNull();
    expect(detectSlicer(path.join(dir, 'nope.3mf'))).toBeNull();
  });

  test('real fixture without Application -> null (no crash)', () => {
    expect(detectSlicer(path.join(__dirname, 'fixtures', 'two-plate.gcode.3mf'))).toBeNull();
  });
});

describe('routes', () => {
  let db, app, server, printerId;
  const SESSION = 'slicer-open-test-session';
  const cookie = `pf_session=${SESSION}`;
  const written = [];
  const hex = () => crypto.randomBytes(8).toString('hex');
  let tmpDir;

  const put3mf = (application) => {
    const name = `${hex()}.3mf`;
    const work = path.join(tmpDir, name + '.d');
    fs.mkdirSync(path.join(work, '3D'), { recursive: true });
    fs.writeFileSync(path.join(work, '3D', '3dmodel.model'),
      `<model><metadata name="Application">${application}</metadata></model>`);
    execFileSync('zip', ['-qr', path.join(UPLOADS_DIR, name), '3D'], { cwd: work });
    written.push(name);
    return name;
  };
  const addJob = (printFile, name = 'My Cube/1', orderNr = 'A1') =>
    db.prepare('INSERT INTO jobs (printerId, name, orderNr, start, end, status, printFile, queued) VALUES (?,?,?,?,?,?,?,?)')
      .run(printerId, name, orderNr, '2026-04-13T06:00:00Z', '2026-04-13T07:00:00Z', 'Planned', printFile, 0).lastInsertRowid;

  beforeAll(async () => {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slicer-routes-'));
    db  = require('../db');
    app = require('../server');
    server = await listenLocal(app);
    db.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)').run(SESSION, Date.now() + 3_600_000);
    printerId = db.prepare("INSERT INTO printers (name, color) VALUES ('P','#fff')").run().lastInsertRowid;
  });
  afterAll(async () => {
    await closeServer(server);
    fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('mint requires auth', async () => {
    const id = addJob(put3mf('BambuStudio-02.01'));
    expect((await request(server).post(`/api/jobs/${id}/slicer-link`)).status).toBe(401);
  });

  test('mint returns detected slicer, filename and a signed path that downloads without a session', async () => {
    const stored = put3mf('OrcaSlicer-2.3.1');
    const id = addJob(stored);
    const r = await request(server).post(`/api/jobs/${id}/slicer-link`).set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.slicer).toBe('orcaslicer');
    expect(r.body.filename).toBe('A1_My_Cube_1.3mf');
    expect(r.body.path).toMatch(/^\/api\/dl\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/A1_My_Cube_1\.3mf$/);
    expect(JSON.stringify(r.body)).not.toContain('test-shared-secret-for-dl-token');

    const dl = await request(server).get(r.body.path).buffer(true).parse((res, cb) => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('A1_My_Cube_1.3mf');
    expect(dl.headers['cache-control']).toBe('no-store');
    expect(dl.body.equals(fs.readFileSync(path.join(UPLOADS_DIR, stored)))).toBe(true);
  });

  test('mint: unknown slicer -> null; no file / unknown job -> 404', async () => {
    const id = addJob(put3mf('Cura_SteVe'));
    expect((await request(server).post(`/api/jobs/${id}/slicer-link`).set('Cookie', cookie)).body.slicer).toBeNull();
    const none = addJob(null);
    expect((await request(server).post(`/api/jobs/${none}/slicer-link`).set('Cookie', cookie)).status).toBe(404);
    expect((await request(server).post('/api/jobs/999999/slicer-link').set('Cookie', cookie)).status).toBe(404);
  });

  test('signed route: expired, tampered, non-.3mf name, no token all 404', async () => {
    const stored = put3mf('BambuStudio-02.01');
    const good = dlToken.mint(stored);
    expect((await request(server).get(`/api/dl/${good}/x.3mf`)).status).toBe(200);
    expect((await request(server).get(`/api/dl/${good}/x.png`)).status).toBe(404);
    expect((await request(server).get(`/api/dl/${dlToken.mint(stored, Date.now() - 6 * 60 * 1000)}/x.3mf`)).status).toBe(404);
    expect((await request(server).get(`/api/dl/${good.slice(0, -3)}AAA/x.3mf`)).status).toBe(404);
    expect((await request(server).get('/api/dl/garbage/x.3mf')).status).toBe(404);
    expect((await request(server).get('/api/dl/x.3mf')).status).toBe(401); // not under the signed route -> normal auth
  });

  test('signed route serves only the bound file, not path-supplied names', async () => {
    const a = put3mf('BambuStudio-02.01');
    const b = put3mf('OrcaSlicer-2.3.1');
    const r = await request(server).get(`/api/dl/${dlToken.mint(a)}/${b}`).buffer(true).parse((res, cb) => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(r.body.equals(fs.readFileSync(path.join(UPLOADS_DIR, a)))).toBe(true);
    expect(r.body.equals(fs.readFileSync(path.join(UPLOADS_DIR, b)))).toBe(false);
  });

  test('/api/uploads traversal rejected (#4052), normal file still served', async () => {
    const secret = path.join(os.tmpdir(), `secret-${hex()}.txt`);
    fs.writeFileSync(secret, 'TOPSECRET');
    const rel = path.relative(UPLOADS_DIR, secret);
    for (const evil of [encodeURIComponent(rel), rel.split(path.sep).join('%2F'), '..%2F..%2Fserver.js', '%2e%2e%2fserver.js', '..%5Cserver.js']) {
      const r = await request(server).get(`/api/uploads/${evil}`).set('Cookie', cookie);
      expect([400, 404]).toContain(r.status);
      expect(r.text || '').not.toContain('TOPSECRET');
    }
    fs.rmSync(secret, { force: true });
    const ok = put3mf('BambuStudio-02.01');
    expect((await request(server).get(`/api/uploads/${ok}`).set('Cookie', cookie)).status).toBe(200);
  });

  test('signed route traversal rejected: encoded name segment never reaches the FS', async () => {
    const stored = put3mf('BambuStudio-02.01');
    const t = dlToken.mint(stored);
    for (const evil of ['..%2F..%2Fserver.js', '..%2Fserver.js%00.3mf']) {
      const r = await request(server).get(`/api/dl/${t}/${evil}`);
      expect([200, 404]).toContain(r.status); // name is cosmetic; bound file only
      if (r.status === 200) expect(r.headers['content-disposition']).not.toContain('..');
    }
    // a hand-signed token for a traversal name is refused by verify/mint
    const payload = Buffer.from(JSON.stringify({ f: '../server.js', e: Date.now() + 1e5 })).toString('base64url');
    const sig = crypto.createHmac('sha256', 'x').update(payload).digest('base64url');
    expect((await request(server).get(`/api/dl/${payload}.${sig}/x.3mf`)).status).toBe(404);
    // correctly signed (real key) traversal token: must die on the STORED_RE check, not only the signature
    const real = signWithRealKey({ f: '../server.js', e: Date.now() + 1e5 });
    expect(dlToken.verify(real)).toBeNull();
    expect((await request(server).get(`/api/dl/${real}/x.3mf`)).status).toBe(404);
  });
});
