const { listenLocal, closeServer } = require('./helpers/listen-local');
process.env.NODE_ENV = 'test';

describe('GET /health (DB probe)', () => {
  const request = require('supertest');
  let server, db;

  beforeAll(async () => {
    db = require('../db');
    server = await listenLocal(require('../server'));
  });
  afterAll(() => closeServer(server));
  afterEach(() => jest.restoreAllMocks());

  test('200 {ok:true} when the DB works, with no cookie and no token', async () => {
    const res = await request(server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('503 {ok:false,error:"db"} when DB access throws, without leaking details', async () => {
    jest.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('boom /secret/path/planner.db NODE_MODULE_VERSION 115');
    });
    const res = await request(server).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'db' });
    expect(res.text).not.toMatch(/boom|secret|NODE_MODULE_VERSION|\.db/);
  });

  test('does not redirect to /login and other routes still require auth', async () => {
    const health = await request(server).get('/health');
    expect(health.status).not.toBe(302);
    const other = await request(server).get('/api/printers');
    expect(other.status).toBe(401);
  });
});
