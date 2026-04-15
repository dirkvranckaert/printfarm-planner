const Database = require('better-sqlite3');
const pause = require('../pause');

const TZ = 'Europe/Brussels';
const RESTR = {
  enabled: true,
  silentStart: '21:00',
  silentEnd: '06:30',
  closedDays: [6],
  timezone: TZ,
};

function makeDb() {
  const db = new Database(':memory:');
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
      printerId INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'Planned',
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      queued INTEGER NOT NULL DEFAULT 0,
      linked_printer_id INTEGER,
      paused_at TEXT,
      paused_remaining_ms INTEGER
    );
    CREATE TABLE closures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      startDate TEXT NOT NULL,
      endDate TEXT NOT NULL
    );
  `);
  return db;
}

function addPrinter(db, name = 'P1S') {
  const r = db.prepare('INSERT INTO printers (name, color, warm_up_mins, cool_down_mins) VALUES (?,?,?,?)')
    .run(name, '#ffffff', 5, 15);
  return db.prepare('SELECT * FROM printers WHERE id=?').get(r.lastInsertRowid);
}

function addJob(db, printerId, { name, status = 'Planned', start, end, linked_printer_id = null }) {
  const r = db.prepare(
    'INSERT INTO jobs (printerId, name, status, start, end, linked_printer_id) VALUES (?,?,?,?,?,?)'
  ).run(printerId, name, status, start, end, linked_printer_id);
  return db.prepare('SELECT * FROM jobs WHERE id=?').get(r.lastInsertRowid);
}

const getJob = (db, id) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);

describe('pause.beginPause', () => {
  test('stores paused_at + paused_remaining_ms, flips status, leaves start/end untouched', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    const now = new Date('2026-04-13T08:30:00.000Z');
    pause.beginPause({ db, jobId: job.id, now });
    const after = getJob(db, job.id);
    expect(after.status).toBe('Paused');
    expect(after.paused_at).toBe('2026-04-13T08:30:00.000Z');
    expect(after.paused_remaining_ms).toBe(30 * 60 * 1000);
    // start/end untouched on the pause transition itself
    expect(after.start).toBe('2026-04-13T08:00:00.000Z');
    expect(after.end).toBe('2026-04-13T09:00:00.000Z');
  });

  test('clamps negative remaining to 0 when now is past end', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    pause.beginPause({ db, jobId: job.id, now: new Date('2026-04-13T10:00:00.000Z') });
    expect(getJob(db, job.id).paused_remaining_ms).toBe(0);
  });
});

describe('pause.pauseTick', () => {
  test('bumps end forward by elapsed wall-clock and keeps duration constant', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    // Pause at 08:30 with 30 min remaining.
    pause.beginPause({ db, jobId: job.id, now: new Date('2026-04-13T08:30:00.000Z') });
    // 15 minutes later — first tick.
    pause.pauseTick({ db, now: new Date('2026-04-13T08:45:00.000Z'), restr: RESTR });
    const after = getJob(db, job.id);
    // New end = 08:45 + 30 min = 09:15, duration preserved (60 min) -> start 08:15.
    expect(after.end).toBe('2026-04-13T09:15:00.000Z');
    expect(after.start).toBe('2026-04-13T08:15:00.000Z');
    expect(after.status).toBe('Paused');
  });

  test('cascades downstream Planned jobs via pushBackChain', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    // A is printing and about to be paused. B sits right after A with a small gap.
    const a = addJob(db, printer.id, {
      name: 'A', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    const b = addJob(db, printer.id, {
      name: 'B', status: 'Planned',
      start: '2026-04-13T09:30:00.000Z', end: '2026-04-13T10:00:00.000Z',
    });
    pause.beginPause({ db, jobId: a.id, now: new Date('2026-04-13T08:30:00.000Z') });
    // 60 minutes later — enough drift to overlap B (new A end = 09:30 + 30 = 10:00).
    pause.pauseTick({ db, now: new Date('2026-04-13T09:30:00.000Z'), restr: RESTR });
    const bAfter = getJob(db, b.id);
    const bStartMs = new Date(bAfter.start).getTime();
    const aEndMs = new Date(getJob(db, a.id).end).getTime();
    // B must start no earlier than A's new end + buffers (warm+cool = 20 min).
    expect(bStartMs).toBeGreaterThanOrEqual(aEndMs + 20 * 60000 - 1);
  });

  test('does not touch jobs in status != Paused', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    // Simulate stale paused_at on a Printing job — should be ignored.
    db.prepare("UPDATE jobs SET paused_at=?, paused_remaining_ms=? WHERE id=?")
      .run('2026-04-13T08:30:00.000Z', 60 * 60 * 1000, job.id);
    pause.pauseTick({ db, now: new Date('2026-04-13T09:00:00.000Z'), restr: RESTR });
    expect(getJob(db, job.id).end).toBe('2026-04-13T09:00:00.000Z');
  });

  test('server restart simulation: tick after N hours still targets now+remainingMs', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    pause.beginPause({ db, jobId: job.id, now: new Date('2026-04-13T08:30:00.000Z') });
    // "Server was down" — first tick happens 3 hours later.
    const now = new Date('2026-04-13T11:30:00.000Z');
    pause.pauseTick({ db, now, restr: RESTR });
    const after = getJob(db, job.id);
    // end = 11:30 + 30 min = 12:00
    expect(after.end).toBe('2026-04-13T12:00:00.000Z');
  });
});

describe('pause.endPause', () => {
  test('clears pause fields and flips Paused -> Printing', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    pause.beginPause({ db, jobId: job.id, now: new Date('2026-04-13T08:30:00.000Z') });
    expect(getJob(db, job.id).status).toBe('Paused');
    pause.endPause({ db, jobId: job.id });
    const after = getJob(db, job.id);
    expect(after.status).toBe('Printing');
    expect(after.paused_at).toBeNull();
    expect(after.paused_remaining_ms).toBeNull();
  });

  test('does not touch a job whose status has already moved away from Paused', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Done',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
    });
    pause.endPause({ db, jobId: job.id });
    expect(getJob(db, job.id).status).toBe('Done');
  });
});

describe('pause.finishFromPause (PAUSE -> FINISH/IDLE direct transition)', () => {
  test('PAUSE -> FINISH: clears pause fields, flips to Post Printing, unlinks printer, does not touch end', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    pause.beginPause({ db, jobId: job.id, now: new Date('2026-04-13T08:30:00.000Z') });
    // Simulate user cancelling the paused print on the touchscreen:
    // the server branch sees curr='FINISH', prev='PAUSE', job.status='Paused'.
    pause.finishFromPause({ db, jobId: job.id });
    const after = getJob(db, job.id);
    expect(after.status).toBe('Post Printing');
    expect(after.paused_at).toBeNull();
    expect(after.paused_remaining_ms).toBeNull();
    expect(after.linked_printer_id).toBeNull();
    // 'end' is NOT bumped forward -- the print is stopping, not continuing.
    expect(after.end).toBe('2026-04-13T09:00:00.000Z');
    expect(after.start).toBe('2026-04-13T08:00:00.000Z');
  });

  test('PAUSE -> IDLE: same end state (Post Printing + cleared fields)', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'B', status: 'Printing',
      start: '2026-04-13T10:00:00.000Z', end: '2026-04-13T11:00:00.000Z',
      linked_printer_id: printer.id,
    });
    pause.beginPause({ db, jobId: job.id, now: new Date('2026-04-13T10:15:00.000Z') });
    expect(getJob(db, job.id).status).toBe('Paused');
    // Same helper regardless of FINISH vs IDLE -- the server branch collapses
    // both into one path.
    pause.finishFromPause({ db, jobId: job.id });
    const after = getJob(db, job.id);
    expect(after.status).toBe('Post Printing');
    expect(after.paused_at).toBeNull();
    expect(after.paused_remaining_ms).toBeNull();
    expect(after.linked_printer_id).toBeNull();
    expect(after.end).toBe('2026-04-13T11:00:00.000Z');
  });
});

describe('pause.clearPauseFields', () => {
  test('wipes paused_at and paused_remaining_ms without touching status', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Paused',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
    });
    db.prepare("UPDATE jobs SET paused_at=?, paused_remaining_ms=? WHERE id=?")
      .run('2026-04-13T08:30:00.000Z', 30 * 60000, job.id);
    pause.clearPauseFields({ db, jobId: job.id });
    const after = getJob(db, job.id);
    expect(after.paused_at).toBeNull();
    expect(after.paused_remaining_ms).toBeNull();
    expect(after.status).toBe('Paused'); // untouched
  });
});

describe('multi-pause sequence', () => {
  test('second pause recomputes remaining from the latest end written by the tick', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    // Pause #1 at 08:30 with 30 min remaining.
    pause.beginPause({ db, jobId: job.id, now: new Date('2026-04-13T08:30:00.000Z') });
    // Tick to drift end to 09:15 (now 08:45).
    pause.pauseTick({ db, now: new Date('2026-04-13T08:45:00.000Z'), restr: RESTR });
    expect(getJob(db, job.id).end).toBe('2026-04-13T09:15:00.000Z');
    // Resume.
    pause.endPause({ db, jobId: job.id });
    // Pause #2 at 08:50 — remaining should be based on 09:15, i.e. 25 min.
    pause.beginPause({ db, jobId: job.id, now: new Date('2026-04-13T08:50:00.000Z') });
    expect(getJob(db, job.id).paused_remaining_ms).toBe(25 * 60 * 1000);
  });
});
