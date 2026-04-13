const Database = require('better-sqlite3');
const { realignLinkedJob } = require('../realign');

const TZ = 'Europe/Brussels';
const RESTR = {
  enabled: true,
  silentStart: '21:00',
  silentEnd: '06:30',
  closedDays: [6], // Saturday
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
      linked_printer_id INTEGER
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
  const r = db.prepare('INSERT INTO jobs (printerId, name, status, start, end, linked_printer_id) VALUES (?,?,?,?,?,?)')
    .run(printerId, name, status, start, end, linked_printer_id);
  return db.prepare('SELECT * FROM jobs WHERE id=?').get(r.lastInsertRowid);
}

const getJob = (db, id) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);

describe('realignLinkedJob — threshold and no-op cases', () => {
  test('null remainingMins → no change', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    const res = realignLinkedJob({
      db, printer, job, remainingMins: null,
      now: new Date('2026-04-13T08:30:00.000Z'), restr: RESTR,
    });
    expect(res.changed).toBe(false);
    expect(getJob(db, job.id).end).toBe('2026-04-13T09:00:00.000Z');
  });

  test('delta under 2-minute threshold → no change', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    // Job ends at 09:00. At 08:30 printer says 31 min remaining → predicted end 09:01, delta = +1 min.
    const job = addJob(db, printer.id, {
      name: 'A', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    const res = realignLinkedJob({
      db, printer, job, remainingMins: 31,
      now: new Date('2026-04-13T08:30:00.000Z'), restr: RESTR,
    });
    expect(res.changed).toBe(false);
    expect(getJob(db, job.id).end).toBe('2026-04-13T09:00:00.000Z');
  });
});

describe('realignLinkedJob — pull back current job only (running ahead)', () => {
  test('current job shifted earlier (same duration); subsequent jobs stay put (free gap)', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    // Current job 08:00–09:00 (60 min), next job 09:30–10:30 (30 min gap).
    const current = addJob(db, printer.id, {
      name: 'Current', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    const next = addJob(db, printer.id, {
      name: 'Next', status: 'Planned',
      start: '2026-04-13T09:30:00.000Z', end: '2026-04-13T10:30:00.000Z',
    });

    // At 08:30 printer says 15 min remaining → predicted end 08:45 (15 min early).
    const res = realignLinkedJob({
      db, printer, job: current, remainingMins: 15,
      now: new Date('2026-04-13T08:30:00.000Z'), restr: RESTR,
    });

    expect(res.changed).toBe(true);
    expect(res.deltaMs).toBe(-15 * 60000);
    // Block shifted 15 min earlier, same 60 min duration.
    const updated = getJob(db, current.id);
    expect(updated.start).toBe('2026-04-13T07:45:00.000Z');
    expect(updated.end).toBe('2026-04-13T08:45:00.000Z');
    // Next job untouched.
    expect(getJob(db, next.id).start).toBe('2026-04-13T09:30:00.000Z');
    expect(getJob(db, next.id).end).toBe('2026-04-13T10:30:00.000Z');
    expect(res.updated.map(u => u.id)).toEqual([current.id]);
  });
});

describe('realignLinkedJob — push back cascade (running late)', () => {
  test('current job shifted later (same duration); next job pushed to avoid overlap', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const current = addJob(db, printer.id, {
      name: 'Current', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    const next = addJob(db, printer.id, {
      name: 'Next', status: 'Planned',
      start: '2026-04-13T09:20:00.000Z', end: '2026-04-13T10:20:00.000Z', // back-to-back with warm+cool
    });

    // At 08:30, printer says 60 min remaining → predicted end 09:30 (+30 min late).
    const res = realignLinkedJob({
      db, printer, job: current, remainingMins: 60,
      now: new Date('2026-04-13T08:30:00.000Z'), restr: RESTR,
    });

    expect(res.changed).toBe(true);
    expect(res.deltaMs).toBe(30 * 60000);
    // Block shifted 30 min later, same 60 min duration.
    const curr = getJob(db, current.id);
    expect(curr.start).toBe('2026-04-13T08:30:00.000Z');
    expect(curr.end).toBe('2026-04-13T09:30:00.000Z');
    // Next job cascaded to current_end + cool(15) + warm(5) = 09:50
    expect(getJob(db, next.id).start).toBe('2026-04-13T09:50:00.000Z');
    expect(getJob(db, next.id).end).toBe('2026-04-13T10:50:00.000Z');
  });

  test('cascade stops when gap absorbs the delay', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const current = addJob(db, printer.id, {
      name: 'Current', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    const next = addJob(db, printer.id, {
      name: 'Next', status: 'Planned',
      start: '2026-04-13T14:00:00.000Z', end: '2026-04-13T15:00:00.000Z', // big gap
    });

    // 10 minutes late
    const res = realignLinkedJob({
      db, printer, job: current, remainingMins: 70,
      now: new Date('2026-04-13T08:00:00.000Z'), restr: RESTR,
    });

    expect(res.changed).toBe(true);
    const curr = getJob(db, current.id);
    expect(curr.start).toBe('2026-04-13T08:10:00.000Z');
    expect(curr.end).toBe('2026-04-13T09:10:00.000Z');
    // Next untouched
    expect(getJob(db, next.id).start).toBe('2026-04-13T14:00:00.000Z');
  });

  test('cascade does not touch Printing or Done jobs', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const current = addJob(db, printer.id, {
      name: 'Current', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    // A "sibling" that is already Printing on the same printer (shouldn't happen but defensively)
    const siblingPrinting = addJob(db, printer.id, {
      name: 'Sibling', status: 'Printing',
      start: '2026-04-13T09:15:00.000Z', end: '2026-04-13T10:00:00.000Z',
    });
    const done = addJob(db, printer.id, {
      name: 'Done one', status: 'Done',
      start: '2026-04-13T06:00:00.000Z', end: '2026-04-13T07:00:00.000Z',
    });

    const res = realignLinkedJob({
      db, printer, job: current, remainingMins: 90,
      now: new Date('2026-04-13T08:00:00.000Z'), restr: RESTR,
    });

    expect(res.changed).toBe(true);
    const curr = getJob(db, current.id);
    expect(curr.start).toBe('2026-04-13T08:30:00.000Z');
    expect(curr.end).toBe('2026-04-13T09:30:00.000Z');
    // Non-cascadable statuses untouched.
    expect(getJob(db, siblingPrinting.id).start).toBe('2026-04-13T09:15:00.000Z');
    expect(getJob(db, done.id).start).toBe('2026-04-13T06:00:00.000Z');
  });

  test('cascade honors silent hours — push across 21:00 lands at next-day 06:30', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    // Current job scheduled 19:00–20:00 Brussels (17:00–18:00 UTC in CEST).
    const current = addJob(db, printer.id, {
      name: 'Current', status: 'Printing',
      start: '2026-04-13T17:00:00.000Z', end: '2026-04-13T18:00:00.000Z',
      linked_printer_id: printer.id,
    });
    // Next job 20:20–21:00 Brussels = 18:20–19:00 UTC — starts outside silent window.
    const next = addJob(db, printer.id, {
      name: 'Next', status: 'Planned',
      start: '2026-04-13T18:20:00.000Z', end: '2026-04-13T19:00:00.000Z',
    });

    // Current is 90 min late — predicted end 19:30 UTC = 21:30 Brussels.
    // cascade anchor = 19:50 UTC + warm(5)+cool(15) already added → 19:50Z
    // 19:50Z = 21:50 Brussels which is inside silent window → job pushed to next-day 06:30 Brussels.
    const res = realignLinkedJob({
      db, printer, job: current, remainingMins: 150,
      now: new Date('2026-04-13T17:00:00.000Z'), restr: RESTR,
    });

    expect(res.changed).toBe(true);
    const curr = getJob(db, current.id);
    // Duration was 60 min (17:00Z–18:00Z). End now 19:30Z, start = 18:30Z.
    expect(curr.start).toBe('2026-04-13T18:30:00.000Z');
    expect(curr.end).toBe('2026-04-13T19:30:00.000Z');
    // Next job lands at 06:30 Brussels (CEST = 04:30 UTC) on 2026-04-14
    expect(getJob(db, next.id).start).toBe('2026-04-14T04:30:00.000Z');
  });
});

describe('realignLinkedJob — snapStart on first RUNNING tick', () => {
  test('bypasses threshold and shifts the block by the delay (same duration)', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'Current', status: 'Printing',
      start: '2026-04-13T08:00:00.000Z', end: '2026-04-13T09:00:00.000Z',
      linked_printer_id: printer.id,
    });
    // Actually started 15 min late, printer says 60 min remaining.
    const res = realignLinkedJob({
      db, printer, job, remainingMins: 60,
      now: new Date('2026-04-13T08:15:00.000Z'), restr: RESTR,
      snapStart: true,
    });
    expect(res.changed).toBe(true);
    // Block shifted 15 min later; duration still 60 min.
    const updated = getJob(db, job.id);
    expect(updated.start).toBe('2026-04-13T08:15:00.000Z');
    expect(updated.end).toBe('2026-04-13T09:15:00.000Z');
  });
});

describe('realignLinkedJob — naked datetime strings in job.end (legacy rows)', () => {
  test('interprets naked start/end as Brussels local time and shifts block same-size', () => {
    const db = makeDb();
    const printer = addPrinter(db);
    const job = addJob(db, printer.id, {
      name: 'Current', status: 'Printing',
      // Naked: 08:00–11:00 Brussels = 06:00Z–09:00Z (3h duration).
      start: '2026-04-13T08:00', end: '2026-04-13T11:00',
      linked_printer_id: printer.id,
    });
    // At 09:15 Brussels (07:15 UTC), printer says 30 min remaining → predicted end 09:45 Brussels (07:45Z).
    const res = realignLinkedJob({
      db, printer, job, remainingMins: 30,
      now: new Date('2026-04-13T07:15:00.000Z'), restr: RESTR,
    });
    expect(res.changed).toBe(true);
    const updated = getJob(db, job.id);
    // 3h duration preserved: end=07:45Z, start=04:45Z.
    expect(updated.start).toBe('2026-04-13T04:45:00.000Z');
    expect(updated.end).toBe('2026-04-13T07:45:00.000Z');
  });
});
