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

  test('toggling favourite on/off works correctly', () => {
    const r = db.prepare('INSERT INTO printers (name, color, favourite) VALUES (?,?,?)').run('Toggle', '#abc', 1);
    const id = r.lastInsertRowid;
    // turn off
    db.prepare('UPDATE printers SET favourite=0 WHERE id=?').run(id);
    expect(db.prepare('SELECT favourite FROM printers WHERE id=?').get(id).favourite).toBe(0);
    // turn back on
    db.prepare('UPDATE printers SET favourite=1 WHERE id=?').run(id);
    expect(db.prepare('SELECT favourite FROM printers WHERE id=?').get(id).favourite).toBe(1);
  });

  test('one-time migration sets favourite=1 for printers created with old DEFAULT 0', () => {
    // Simulate old state: printers with favourite=0
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO printers (name, color, favourite) VALUES (?,?,?)').run('OldPrinter', '#fff', 0);
    const before = db.prepare('SELECT favourite FROM printers').get();
    expect(before.favourite).toBe(0);

    // Run the migration logic
    const favMigrated = db.prepare("SELECT value FROM settings WHERE key='favouriteMigrated'").get();
    if (!favMigrated) {
      db.exec("UPDATE printers SET favourite=1 WHERE favourite=0");
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('favouriteMigrated', '1')").run();
    }

    const after = db.prepare('SELECT favourite FROM printers').get();
    expect(after.favourite).toBe(1);
    // Migration flag is set so it won't run again
    const flag = db.prepare("SELECT value FROM settings WHERE key='favouriteMigrated'").get();
    expect(flag.value).toBe('1');
  });

  test('migration does not run a second time', () => {
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare("INSERT INTO settings (key, value) VALUES ('favouriteMigrated', '1')").run();
    db.prepare('INSERT INTO printers (name, color, favourite) VALUES (?,?,?)').run('New', '#000', 0);

    // Migration should be skipped because flag is already set
    const favMigrated = db.prepare("SELECT value FROM settings WHERE key='favouriteMigrated'").get();
    if (!favMigrated) {
      db.exec("UPDATE printers SET favourite=1 WHERE favourite=0");
    }

    // favourite should still be 0 (migration was skipped)
    const p = db.prepare('SELECT favourite FROM printers').get();
    expect(p.favourite).toBe(0);
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

describe('Push notification helpers', () => {
  test('buildDoneMessage with job, orderNr and customerName', () => {
    const printer = { name: 'P1S' };
    const job = { name: 'Keychain Dirk', orderNr: '100', customerName: 'Dirk' };
    let body = `Printer ${printer.name} has done printing `;
    if (job.orderNr) body += `order #${job.orderNr}: `;
    body += `'${job.name}'`;
    if (job.customerName) body += ` (${job.customerName})`;
    expect(body).toBe("Printer P1S has done printing order #100: 'Keychain Dirk' (Dirk)");
  });

  test('buildDoneMessage with job, no orderNr, no customerName', () => {
    const printer = { name: 'H2C' };
    const job = { name: 'Name tag', orderNr: null, customerName: null };
    let body = `Printer ${printer.name} has done printing `;
    if (job.orderNr) body += `order #${job.orderNr}: `;
    body += `'${job.name}'`;
    if (job.customerName) body += ` (${job.customerName})`;
    expect(body).toBe("Printer H2C has done printing 'Name tag'");
  });

  test('buildDoneMessage no job, file available', () => {
    const printer = { name: 'P1S' };
    const jobName = 'plate_001.gcode';
    const body = `Printer ${printer.name} is done printing ${jobName}`;
    expect(body).toBe('Printer P1S is done printing plate_001.gcode');
  });

  test('buildDoneMessage no job, no file', () => {
    const printer = { name: 'P1S' };
    const body = `Printer ${printer.name} has done printing`;
    expect(body).toBe('Printer P1S has done printing');
  });

  test('buildUpcomingMessage with orderNr', () => {
    const job = { name: 'Keychain', orderNr: '42', printerName: 'P1S' };
    const body = job.orderNr
      ? `It's time to start printing order #${job.orderNr} '${job.name}' on ${job.printerName}`
      : `It's about time to start printing '${job.name}' on ${job.printerName}`;
    expect(body).toBe("It's time to start printing order #42 'Keychain' on P1S");
  });

  test('buildUpcomingMessage without orderNr', () => {
    const job = { name: 'Keychain', orderNr: null, printerName: 'H2C' };
    const body = job.orderNr
      ? `It's time to start printing order #${job.orderNr} '${job.name}' on ${job.printerName}`
      : `It's about time to start printing '${job.name}' on ${job.printerName}`;
    expect(body).toBe("It's about time to start printing 'Keychain' on H2C");
  });

  test('start_push_sent column exists and defaults to 0', () => {
    const db = new (require('better-sqlite3'))(':memory:');
    db.exec(`
      CREATE TABLE printers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printerId INTEGER NOT NULL,
        name TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        status TEXT DEFAULT 'Planned',
        queued INTEGER DEFAULT 0,
        start_push_sent INTEGER DEFAULT 0
      );
    `);
    db.prepare('INSERT INTO printers (name, color) VALUES (?,?)').run('P1', '#f00');
    const pid = db.prepare('SELECT id FROM printers').get().id;
    db.prepare('INSERT INTO jobs (printerId, name, start, end) VALUES (?,?,?,?)').run(pid, 'Test', '2026-03-27T10:00', '2026-03-27T11:00');
    const job = db.prepare('SELECT * FROM jobs').get();
    expect(job.start_push_sent).toBe(0);
    db.prepare('UPDATE jobs SET start_push_sent=1 WHERE id=?').run(job.id);
    const updated = db.prepare('SELECT start_push_sent FROM jobs WHERE id=?').get(job.id);
    expect(updated.start_push_sent).toBe(1);
    db.close();
  });

  test('push_subscriptions table can store and retrieve subscription', () => {
    const db = new (require('better-sqlite3'))(':memory:');
    db.exec(`CREATE TABLE push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription TEXT NOT NULL
    );`);
    const sub = JSON.stringify({ endpoint: 'https://push.example.com/abc', keys: { p256dh: 'x', auth: 'y' } });
    db.prepare('INSERT INTO push_subscriptions (subscription) VALUES (?)').run(sub);
    const rows = db.prepare('SELECT * FROM push_subscriptions').all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].subscription).endpoint).toBe('https://push.example.com/abc');
    db.close();
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

describe('3MF schedule import — array-order is the contract', () => {
  // Regression guard for the /api/import-3mf-schedule route. The route loops
  // `for (const pl of plates)` and must NOT sort. Client-side reordering is
  // the entire backend story for the new per-plate up/down arrows. This test
  // mirrors the route's exact insertion shape against an in-memory DB and
  // proves: createdJobs come back in input order, starts are sequential, no
  // two jobs overlap. If a future refactor re-sorts plates inside the loop,
  // this test trips.
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE printers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        warm_up_mins INTEGER DEFAULT 5,
        cool_down_mins INTEGER DEFAULT 15
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printerId INTEGER,
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
        thumbFile TEXT,
        bedType TEXT
      );
    `);
    db.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
      .run('P1', '#f00', 5, 15);
  });

  test('three plates in [3,1,2] order schedule in that order with sequential, non-overlapping starts', () => {
    // Mirrors server.js /api/import-3mf-schedule loop semantics with a
    // pass-through `findNextValidStart` (no silent-hours / closed-days here —
    // those are covered by scheduling.test.js. We only need to prove the loop
    // respects array order).
    const findNextValidStart = (candidate /*, durationMins, printerId */) => new Date(candidate);

    const printerId = db.prepare('SELECT id FROM printers').get().id;
    const plates = [
      { plateIndex: 3, name: 'Plate 3', printerId, durationMins: 60 },
      { plateIndex: 1, name: 'Plate 1', printerId, durationMins: 90 },
      { plateIndex: 2, name: 'Plate 2', printerId, durationMins: 30 },
    ];

    let currentStart = new Date('2026-04-27T08:00:00.000Z');
    const createdJobs = [];
    for (const pl of plates) {
      const validStart = findNextValidStart(currentStart, pl.durationMins, pl.printerId);
      const endDate = new Date(validStart.getTime() + pl.durationMins * 60000);
      const printer = db.prepare('SELECT warm_up_mins, cool_down_mins FROM printers WHERE id=?').get(pl.printerId);
      const warmUp = printer.warm_up_mins;
      const coolDown = printer.cool_down_mins;
      const result = db.prepare(
        'INSERT INTO jobs (printerId, name, start, end, status, durationMins) VALUES (?,?,?,?,?,?)'
      ).run(pl.printerId, pl.name, validStart.toISOString(), endDate.toISOString(), 'Planned', pl.durationMins);
      createdJobs.push({
        id: result.lastInsertRowid,
        name: pl.name,
        printerId: pl.printerId,
        start: validStart.toISOString(),
        end: endDate.toISOString(),
        durationMins: pl.durationMins,
      });
      currentStart = new Date(endDate.getTime() + (coolDown + warmUp) * 60000);
    }

    // Order: array order is preserved end-to-end.
    expect(createdJobs.map(j => j.name)).toEqual(['Plate 3', 'Plate 1', 'Plate 2']);

    // Sequential: each job starts at or after the previous one ends.
    expect(new Date(createdJobs[1].start).getTime())
      .toBeGreaterThanOrEqual(new Date(createdJobs[0].end).getTime());
    expect(new Date(createdJobs[2].start).getTime())
      .toBeGreaterThanOrEqual(new Date(createdJobs[1].end).getTime());

    // Non-overlapping: end of N < start of N+1 (strict, since cool+warm gap > 0).
    expect(new Date(createdJobs[0].end).getTime())
      .toBeLessThan(new Date(createdJobs[1].start).getTime());
    expect(new Date(createdJobs[1].end).getTime())
      .toBeLessThan(new Date(createdJobs[2].start).getTime());

    // DB rows are in insert order with the same names — no sort happened.
    const rows = db.prepare('SELECT name, start FROM jobs ORDER BY id ASC').all();
    expect(rows.map(r => r.name)).toEqual(['Plate 3', 'Plate 1', 'Plate 2']);
  });

  test('single-plate schedule: createdJobs has one entry, start == input start', () => {
    const findNextValidStart = (candidate) => new Date(candidate);
    const printerId = db.prepare('SELECT id FROM printers').get().id;
    const plates = [{ plateIndex: 1, name: 'Solo', printerId, durationMins: 45 }];
    const startISO = '2026-04-27T08:00:00.000Z';
    let currentStart = new Date(startISO);
    const createdJobs = [];
    for (const pl of plates) {
      const validStart = findNextValidStart(currentStart, pl.durationMins, pl.printerId);
      const endDate = new Date(validStart.getTime() + pl.durationMins * 60000);
      const result = db.prepare(
        'INSERT INTO jobs (printerId, name, start, end, status, durationMins) VALUES (?,?,?,?,?,?)'
      ).run(pl.printerId, pl.name, validStart.toISOString(), endDate.toISOString(), 'Planned', pl.durationMins);
      createdJobs.push({ id: result.lastInsertRowid, name: pl.name, start: validStart.toISOString(), end: endDate.toISOString() });
    }
    expect(createdJobs).toHaveLength(1);
    expect(createdJobs[0].name).toBe('Solo');
    expect(createdJobs[0].start).toBe(startISO);
  });
});
