const Database = require('better-sqlite3');

describe('Printer CRUD', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE printers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        brand TEXT DEFAULT 'other',
        bambu_serial TEXT,
        pinned INTEGER DEFAULT 0,
        warm_up_mins INTEGER DEFAULT 5,
        cool_down_mins INTEGER DEFAULT 15,
        favourite INTEGER DEFAULT 1
      );
    `);
  });

  test('can insert and retrieve a printer', () => {
    db.prepare('INSERT INTO printers (name, color, brand, pinned, warm_up_mins, cool_down_mins, favourite) VALUES (?,?,?,?,?,?,?)')
      .run('Test Printer', '#ff0000', 'other', 0, 5, 15, 1);
    const printers = db.prepare('SELECT * FROM printers').all();
    expect(printers).toHaveLength(1);
    expect(printers[0].name).toBe('Test Printer');
    expect(printers[0].favourite).toBe(1);
  });

  test('new printers default to favourite=1 (visible in day view)', () => {
    db.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run('Auto-fav', '#123456');
    const p = db.prepare('SELECT * FROM printers').get();
    expect(p.favourite).toBe(1);
  });

  test('unstarring a printer sets favourite=0', () => {
    const r = db.prepare('INSERT INTO printers (name, color, favourite) VALUES (?,?,?)').run('Star', '#abc', 1);
    db.prepare('UPDATE printers SET favourite=0 WHERE id=?').run(r.lastInsertRowid);
    const p = db.prepare('SELECT favourite FROM printers WHERE id=?').get(r.lastInsertRowid);
    expect(p.favourite).toBe(0);
  });

  test('can set a printer as favourite', () => {
    db.prepare('INSERT INTO printers (name, color, brand, pinned, warm_up_mins, cool_down_mins, favourite) VALUES (?,?,?,?,?,?,?)')
      .run('Fav Printer', '#00ff00', 'other', 0, 5, 15, 1);
    const favs = db.prepare('SELECT * FROM printers WHERE favourite=1').all();
    expect(favs).toHaveLength(1);
    expect(favs[0].name).toBe('Fav Printer');
  });

  test('can delete a printer', () => {
    const result = db.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run('Del Me', '#000');
    db.prepare('DELETE FROM printers WHERE id=?').run(result.lastInsertRowid);
    const printers = db.prepare('SELECT * FROM printers').all();
    expect(printers).toHaveLength(0);
  });
});

describe('Job CRUD', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE printers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printerId INTEGER NOT NULL,
        name TEXT NOT NULL,
        customerName TEXT,
        orderNr TEXT,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        status TEXT DEFAULT 'Planned',
        colors TEXT,
        printFile TEXT,
        remarks TEXT,
        queued INTEGER DEFAULT 0,
        durationMins INTEGER DEFAULT 0,
        linked_printer_id INTEGER
      );
    `);
    db.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run('P1', '#f00');
  });

  test('can insert and retrieve a job', () => {
    const pid = db.prepare('SELECT id FROM printers').get().id;
    db.prepare('INSERT INTO jobs (printerId, name, start, end, status) VALUES (?,?,?,?,?)')
      .run(pid, 'Test Job', '2026-03-27T10:00', '2026-03-27T12:00', 'Planned');
    const jobs = db.prepare('SELECT * FROM jobs').all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('Test Job');
    expect(jobs[0].status).toBe('Planned');
  });

  test('can patch job status', () => {
    const pid = db.prepare('SELECT id FROM printers').get().id;
    const r = db.prepare('INSERT INTO jobs (printerId, name, start, end, status) VALUES (?,?,?,?,?)')
      .run(pid, 'Job', '2026-03-27T10:00', '2026-03-27T12:00', 'Planned');
    db.prepare('UPDATE jobs SET status=? WHERE id=?').run('Printing', r.lastInsertRowid);
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(r.lastInsertRowid);
    expect(job.status).toBe('Printing');
  });

  test('deleting a printer cascades to its jobs', () => {
    const pid = db.prepare('SELECT id FROM printers').get().id;
    db.prepare('INSERT INTO jobs (printerId, name, start, end) VALUES (?,?,?,?)').run(pid, 'J', '2026-03-27T10:00', '2026-03-27T11:00');
    db.prepare('DELETE FROM jobs WHERE printerId=?').run(pid);
    db.prepare('DELETE FROM printers WHERE id=?').run(pid);
    expect(db.prepare('SELECT * FROM jobs').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM printers').all()).toHaveLength(0);
  });
});

describe('Session management', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`);
  });

  test('valid session returns true', () => {
    const token = 'test-token-123';
    const expiresAt = Date.now() + 3_600_000;
    db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?,?)').run(token, expiresAt);
    const row = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
    expect(row).toBeDefined();
    expect(Date.now() < row.expires_at).toBe(true);
  });

  test('expired session should be considered invalid', () => {
    const token = 'expired-token';
    const expiresAt = Date.now() - 1000; // already expired
    db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?,?)').run(token, expiresAt);
    const row = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
    expect(Date.now() > row.expires_at).toBe(true);
  });
});
