/**
 * @jest-environment jsdom
 *
 * Linking a job to a printer (job actually starts) while the previous job's
 * COOL-DOWN has not expired is not a conflict: cool-down is only an estimate.
 * The previous job's persisted cool_down_mins is trimmed so its cool-down ends
 * where the new job's buffered interval begins. Overlap with the previous PRINT
 * stays a real conflict. Everything else (planning, push/pull, drags) keeps the
 * full cool-down — only the link/start path calls the trim.
 *
 * Server side drives the production modules (cooldown-trim, awaiting-printer,
 * link-transition, realign) on an in-memory SQLite; the conflict signal is the
 * production client detectConflicts, fed the rows read back from the DB.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const awaitingPrinter = require('../awaiting-printer');
const linkTransition = require('../link-transition');
const { trimPrevCoolDown } = require('../cooldown-trim');
const { realignLinkedJob } = require('../realign');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const RESHOVE = fs.readFileSync(path.join(__dirname, '..', 'public', 'reshoveMove.js'), 'utf8');

let T;
beforeAll(() => {
  document.open(); document.write(HTML); document.close();
  window.fetch = () => Promise.resolve({ ok: true, status: 200, text: async () => '', json: async () => [] });
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = cb => setTimeout(cb, 0);
  window.EventSource = class { close() {} addEventListener() {} };
  window.eval(RESHOVE + ';' + APP + `;window.__T__ = { detectConflicts,
    neutralize(){
      init = function(){}; initImport3mf = function(){}; initAttach3mf = function(){};
      renderMobilePrinterSwitcher = function(){}; applyMobilePrinterFilter = function(){};
      attachMobileDayViewSwipe = function(){}; scrollToNow = function(){};
      renderCalendar = async function(){};
    } };`);
  T = window.__T__;
  T.neutralize();
});

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, color TEXT,
      warm_up_mins INTEGER DEFAULT 5, cool_down_mins INTEGER DEFAULT 15);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, printerId INTEGER NOT NULL, name TEXT,
      status TEXT DEFAULT 'Planned', start TEXT NOT NULL, end TEXT NOT NULL, queued INTEGER NOT NULL DEFAULT 0,
      linked_printer_id INTEGER, paused_at TEXT, paused_remaining_ms INTEGER,
      cool_down_mins INTEGER, warm_up_mins INTEGER, locked INTEGER NOT NULL DEFAULT 0,
      conflict_notified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE closures (id INTEGER PRIMARY KEY AUTOINCREMENT, startDate TEXT, endDate TEXT);
  `);
  return db;
}

const T0 = Date.parse('2026-11-25T10:00:00.000Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();

// Screenshot case: previous job (DONE) ends at 0, cool-down 30 min; next job
// is linked/started at +10 (cool-down only half over). Warm-up 0 on both.
function setup({ prevEnd = 0, prevCd = 30, nextStart = 10, nextStatus = 'Planned' } = {}) {
  const db = makeDb();
  const printerId = db.prepare("INSERT INTO printers (name,color,warm_up_mins,cool_down_mins) VALUES ('P','#fff',0,30)").run().lastInsertRowid;
  const ins = db.prepare('INSERT INTO jobs (printerId,name,status,start,end,cool_down_mins,warm_up_mins) VALUES (?,?,?,?,?,?,0)');
  const prev = ins.run(printerId, 'keychain-name-geel', 'Done', iso(prevEnd - 120), iso(prevEnd), prevCd).lastInsertRowid;
  const next = ins.run(printerId, 'keychain-name-roze', nextStatus, iso(nextStart), iso(nextStart + 120), 30).lastInsertRowid;
  return { db, printerId, prev, next };
}
const row = (db, id) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
const conflicts = (db, printerId) => T.detectConflicts(
  db.prepare('SELECT * FROM jobs').all(),
  { [printerId]: { cool_down_mins: 30, warm_up_mins: 0 } }
);

describe('link/start trims the previous job cool-down (screenshot case)', () => {
  test('baseline: before the trim the cool-down overlap raises a conflict on both cards', () => {
    const { db, printerId, prev, next } = setup();
    const ids = conflicts(db, printerId);
    expect(ids.has(prev) && ids.has(next)).toBe(true);
  });

  test('assignPending (link) trims prev cool-down to the gap and clears the conflict', () => {
    const { db, printerId, prev, next } = setup();
    const res = awaitingPrinter.assignPending({ db, jobId: next, printerId, now: new Date(T0) });
    expect(res.ok).toBe(true);
    expect(row(db, prev).cool_down_mins).toBe(10);
    expect(conflicts(db, printerId).size).toBe(0);
  });

  test('RUNNING-edge start trims too (applyRunningTransition)', () => {
    const { db, printerId, prev, next } = setup({ nextStatus: awaitingPrinter.STATUS });
    db.prepare('UPDATE jobs SET linked_printer_id=? WHERE id=?').run(printerId, next);
    linkTransition.applyRunningTransition({ db, printerId, now: new Date(T0) });
    expect(row(db, next).status).toBe('Printing');
    expect(row(db, prev).cool_down_mins).toBe(10);
    expect(conflicts(db, printerId).size).toBe(0);
  });

  test('realign snapping the start earlier re-trims further', () => {
    const { db, printerId, prev, next } = setup({ nextStatus: 'Printing', nextStart: 25 });
    db.prepare('UPDATE jobs SET linked_printer_id=? WHERE id=?').run(printerId, next);
    trimPrevCoolDown({ db, jobId: next });
    expect(row(db, prev).cool_down_mins).toBe(25);
    // Printer reports 120 remaining at "now" = +5 -> block start snaps to +5.
    const printer = db.prepare('SELECT * FROM printers WHERE id=?').get(printerId);
    realignLinkedJob({ db, printer, job: row(db, next), remainingMins: 120, now: new Date(T0 + 5 * 60000),
      restr: { timezone: 'Europe/Brussels' }, snapStart: true });
    expect(row(db, next).start).toBe(iso(5));
    expect(row(db, prev).cool_down_mins).toBe(5);
  });

  test('next job starts right at print end: cool-down clamps to 0, no conflict', () => {
    const { db, printerId, prev, next } = setup({ nextStart: 0 });
    trimPrevCoolDown({ db, jobId: next });
    expect(row(db, prev).cool_down_mins).toBe(0);
    expect(conflicts(db, printerId).size).toBe(0);
  });

  test('warm-up of the new job is respected (cool-down ends where warm-up begins)', () => {
    const { db, printerId, prev, next } = setup();
    db.prepare('UPDATE jobs SET warm_up_mins=4 WHERE id=?').run(next);
    trimPrevCoolDown({ db, jobId: next });
    expect(row(db, prev).cool_down_mins).toBe(6);
    expect(T.detectConflicts(db.prepare('SELECT * FROM jobs').all(), { [printerId]: { cool_down_mins: 30, warm_up_mins: 0 } }).size).toBe(0);
  });
});

describe('real overlap and non-overlap stay untouched', () => {
  test('new job starts BEFORE the previous print ends: no trim, conflict stays real', () => {
    const { db, printerId, prev, next } = setup({ nextStart: -10 });
    const res = awaitingPrinter.assignPending({ db, jobId: next, printerId, now: new Date(T0) });
    expect(res.ok).toBe(true);
    expect(row(db, prev).cool_down_mins).toBe(30);
    expect(conflicts(db, printerId).has(prev)).toBe(true);
  });

  test('cool-down already over: untouched (never lengthened or shortened)', () => {
    const { db, next, prev } = setup({ nextStart: 45 });
    expect(trimPrevCoolDown({ db, jobId: next }).trimmed).toEqual([]);
    expect(row(db, prev).cool_down_mins).toBe(30);
  });

  test('a job on another printer is never trimmed', () => {
    const { db, prev, next } = setup();
    const other = db.prepare("INSERT INTO printers (name,color) VALUES ('Q','#000')").run().lastInsertRowid;
    db.prepare('UPDATE jobs SET printerId=? WHERE id=?').run(other, next);
    trimPrevCoolDown({ db, jobId: next });
    expect(row(db, prev).cool_down_mins).toBe(30);
  });
});
