const { listenLocal, closeServer } = require('./helpers/listen-local');
const os   = require('os');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.PLANNER_DB_PATH =
  process.env.PLANNER_DB_PATH || path.join(os.tmpdir(), `printfarm-test-${process.pid}.db`);
process.env.ADMIN_USER = 'dirk';
process.env.CALCULATOR_URL = 'https://calc.test'; // allowed cross-app origin (read at server load)

describe('API tokens (real routes via supertest)', () => {
  const request = require('supertest');
  let server, app, db;
  const SESSION = 'api-token-test-session';
  const cookie = `pf_session=${SESSION}`;

  afterAll(() => closeServer(server));
  beforeAll(async () => {
    db  = require('../db');
    app = require('../server');
    server = await listenLocal(app);
    db.prepare('INSERT OR REPLACE INTO sessions (token, expires_at) VALUES (?,?)')
      .run(SESSION, Date.now() + 3_600_000);
  });
  beforeEach(() => { db.exec('DELETE FROM api_tokens; DELETE FROM jobs;'); });

  const mint = async (name = 'Uploader') =>
    (await request(server).post('/api/tokens').set('Cookie', cookie).send({ name })).body;
  const schedule = encodeURIComponent(JSON.stringify({ mode: 'queue', plates: [{ name: 'P', printerId: null }] }));

  test('create: full token shown once, only hash stored', async () => {
    const res = await request(server).post('/api/tokens').set('Cookie', cookie).send({ name: 'Mac' });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^pf_[A-Za-z0-9_-]{43}$/);
    const row = db.prepare('SELECT * FROM api_tokens').get();
    expect(row.token_hash).not.toContain(res.body.token);
    expect(row.token_hash).toBe(require('../api-tokens').hashToken(res.body.token));
    expect(row.prefix).toBe(res.body.token.slice(0, 8));
    expect(row.owner).toBe('dirk');
    const list = await request(server).get('/api/tokens').set('Cookie', cookie);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(res.body.token);
    expect(list.body[0]).toMatchObject({ name: 'Mac', prefix: res.body.token.slice(0, 8), last_used_at: null });
  });

  test('create requires a name', async () => {
    const res = await request(server).post('/api/tokens').set('Cookie', cookie).send({ name: '  ' });
    expect(res.status).toBe(400);
  });

  test('Bearer auth works on the upload endpoint (no cookie)', async () => {
    const { token } = await mint();
    const res = await request(server).post('/api/import-3mf-schedule')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Schedule', schedule)
      .send(Buffer.from('not-a-real-3mf'));
    expect(res.status).toBe(201);
    expect(db.prepare('SELECT COUNT(*) c FROM jobs').get().c).toBe(1);
    expect(db.prepare('SELECT last_used_at FROM api_tokens').get().last_used_at).not.toBeNull();
  });

  test('verify returns user + tokenName', async () => {
    const { token } = await mint('Studio Mac');
    const res = await request(server).get('/api/token/verify').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: 'dirk', tokenName: 'Studio Mac' });
  });

  test('unknown token -> 401 JSON, no redirect', async () => {
    // incl. routes that bypass auth (/api/config) or sit before it (/logout)
    for (const p of ['/api/token/verify', '/api/jobs', '/api/config', '/logout']) {
      const res = await request(server).get(p).set('Authorization', 'Bearer pf_nope');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_token' });
    }
  });

  test('bad Bearer + malformed JSON body -> 401, not 400 parse error', async () => {
    const res = await request(server).post('/api/jobs')
      .set('Authorization', 'Bearer pf_nope').set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_token' });
  });

  test('invalid Bearer 401 keeps CORS headers for an allowed origin', async () => {
    const res = await request(server).get('/api/jobs')
      .set('Origin', 'https://calc.test').set('Authorization', 'Bearer pf_nope');
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe('https://calc.test');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });

  test('empty Bearer credential -> 401, not cookie fall-through', async () => {
    for (const h of ['Bearer', 'Bearer ', 'bearer   ']) {
      const res = await request(server).get('/api/jobs').set('Cookie', cookie).set('Authorization', h);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_token' });
    }
  });

  test('bad Bearer does not fall back to a valid cookie', async () => {
    const res = await request(server).get('/api/jobs').set('Cookie', cookie).set('Authorization', 'Bearer pf_nope');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_token' });
  });

  test('revoked token -> 401 invalid_token', async () => {
    const t = await mint();
    expect((await request(server).get('/api/token/verify').set('Authorization', `Bearer ${t.token}`)).status).toBe(200);
    const del = await request(server).delete(`/api/tokens/${t.id}`).set('Cookie', cookie);
    expect(del.status).toBe(200);
    const res = await request(server).get('/api/token/verify').set('Authorization', `Bearer ${t.token}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_token' });
    expect((await request(server).delete(`/api/tokens/${t.id}`).set('Cookie', cookie)).status).toBe(404);
  });

  test('cookie auth unaffected; no creds still 401 / redirect', async () => {
    expect((await request(server).get('/api/jobs').set('Cookie', cookie)).status).toBe(200);
    const anon = await request(server).get('/api/jobs');
    expect(anon.status).toBe(401);
    expect(anon.body).toEqual({ error: 'Unauthorized' });
    expect((await request(server).get('/')).status).toBe(302);
  });

  test('cookie session on verify -> 401 (verify is token-only)', async () => {
    const res = await request(server).get('/api/token/verify').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });

  test('a token cannot manage tokens', async () => {
    const { token } = await mint();
    const h = { Authorization: `Bearer ${token}` };
    expect((await request(server).get('/api/tokens').set(h)).status).toBe(403);
    expect((await request(server).post('/api/tokens').set(h).send({ name: 'x' })).status).toBe(403);
    expect((await request(server).delete('/api/tokens/1').set(h)).status).toBe(403);
  });
});
