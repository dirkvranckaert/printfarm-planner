const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { LINK_ACTIVE_STATUSES } = require('./link-transition');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// PLANNER_DB_PATH lets tests point at a throwaway temp DB. Defaults to the
// real on-disk planner.db for normal runs.
const db = new Database(process.env.PLANNER_DB_PATH || path.join(dataDir, 'planner.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS printers (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    color TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    printerId    INTEGER NOT NULL,
    name         TEXT NOT NULL,
    customerName TEXT,
    orderNr      TEXT,
    start        TEXT NOT NULL,
    end          TEXT NOT NULL,
    status       TEXT DEFAULT 'Planned',
    colors       TEXT,
    printFile    TEXT,
    remarks      TEXT
  );
  CREATE TABLE IF NOT EXISTS closures (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    startDate TEXT NOT NULL,
    endDate   TEXT NOT NULL,
    label     TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

// Migrations: add columns if not present
const jobCols = db.pragma('table_info(jobs)');
if (!jobCols.some(c => c.name === 'queued')) {
  db.exec('ALTER TABLE jobs ADD COLUMN queued INTEGER NOT NULL DEFAULT 0');
}
if (!jobCols.some(c => c.name === 'durationMins')) {
  db.exec('ALTER TABLE jobs ADD COLUMN durationMins INTEGER NOT NULL DEFAULT 0');
}
if (!jobCols.some(c => c.name === 'linked_printer_id')) {
  db.exec('ALTER TABLE jobs ADD COLUMN linked_printer_id INTEGER');
}

const printerCols = db.pragma('table_info(printers)');
if (!printerCols.some(c => c.name === 'bambu_serial')) {
  db.exec('ALTER TABLE printers ADD COLUMN bambu_serial TEXT;');
}
if (!printerCols.some(c => c.name === 'brand')) {
  db.exec("ALTER TABLE printers ADD COLUMN brand TEXT NOT NULL DEFAULT 'other';");
}
if (!printerCols.some(c => c.name === 'pinned')) {
  db.exec('ALTER TABLE printers ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
}
if (!printerCols.some(c => c.name === 'warm_up_mins')) {
  db.exec('ALTER TABLE printers ADD COLUMN warm_up_mins INTEGER NOT NULL DEFAULT 5;');
}
if (!printerCols.some(c => c.name === 'cool_down_mins')) {
  db.exec('ALTER TABLE printers ADD COLUMN cool_down_mins INTEGER NOT NULL DEFAULT 15;');
}
if (!printerCols.some(c => c.name === 'favourite')) {
  // DEFAULT 1: existing printers remain visible in day view after the upgrade
  db.exec('ALTER TABLE printers ADD COLUMN favourite INTEGER NOT NULL DEFAULT 1;');
}

// push_subscriptions table
db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);`);

// start_push_sent column for upcoming job notifications
const jobColsAfter = db.pragma('table_info(jobs)');
if (!jobColsAfter.some(c => c.name === 'start_push_sent')) {
  db.exec('ALTER TABLE jobs ADD COLUMN start_push_sent INTEGER NOT NULL DEFAULT 0');
}

// Add thumbFile and bedType columns for 3MF data
const jobColsThumb = db.pragma('table_info(jobs)');
if (!jobColsThumb.some(c => c.name === 'thumbFile')) {
  db.exec('ALTER TABLE jobs ADD COLUMN thumbFile TEXT');
}
if (!jobColsThumb.some(c => c.name === 'bedType')) {
  db.exec('ALTER TABLE jobs ADD COLUMN bedType TEXT');
}

// Pause tracking: set on RUNNING->PAUSE, cleared on PAUSE->RUNNING (or
// when the job is manually moved out of Paused). See server.js + README.
const jobColsPause = db.pragma('table_info(jobs)');
if (!jobColsPause.some(c => c.name === 'paused_at')) {
  db.exec('ALTER TABLE jobs ADD COLUMN paused_at TEXT');
}
if (!jobColsPause.some(c => c.name === 'paused_remaining_ms')) {
  db.exec('ALTER TABLE jobs ADD COLUMN paused_remaining_ms INTEGER');
}

// Per-job cool-down snapshot. Historically the inter-job cool-down came live
// from the printer's cool_down_mins, so changing that setting reshuffled every
// existing (past, future AND ongoing) job on that printer. Each job now carries
// its own cool_down_mins, snapshotted from its printer at creation; scheduling
// reads the per-job value. Backfill existing rows with their printer's CURRENT
// cool_down_mins (or the 15-min code default when the printer is missing/NULL —
// the same fallback scheduling used before), so the recomputed schedule is
// byte-identical to before this migration. Idempotent: the column is added and
// backfilled only once, and the backfill only touches NULL rows.
const jobColsCool = db.pragma('table_info(jobs)');
if (!jobColsCool.some(c => c.name === 'cool_down_mins')) {
  db.exec('ALTER TABLE jobs ADD COLUMN cool_down_mins INTEGER');
}
// Backfill runs OUTSIDE the column guard so it self-heals on every boot: a crash
// between the ALTER and this UPDATE would leave the column present but rows NULL,
// which a guarded backfill would then skip forever. Idempotent — once filled,
// `WHERE cool_down_mins IS NULL` matches nothing.
db.exec(`UPDATE jobs SET cool_down_mins =
  COALESCE((SELECT p.cool_down_mins FROM printers p WHERE p.id = jobs.printerId), 15)
  WHERE cool_down_mins IS NULL`);

// Per-job warm-up snapshot. Symmetric with cool_down_mins above: warm-up used to
// come live from the printer's warm_up_mins, so changing that setting reshuffled
// every existing job. Each job now carries its own warm_up_mins, snapshotted from
// its printer at creation. Backfill existing rows with their printer's CURRENT
// warm_up_mins (or the 5-min code default when the printer is missing/NULL — the
// same fallback scheduling used before), so the recomputed schedule is
// byte-identical to before this migration. Idempotent: added + backfilled once.
const jobColsWarm = db.pragma('table_info(jobs)');
if (!jobColsWarm.some(c => c.name === 'warm_up_mins')) {
  db.exec('ALTER TABLE jobs ADD COLUMN warm_up_mins INTEGER');
}
// Backfill runs OUTSIDE the column guard so it self-heals on every boot (see the
// cool_down_mins note above). Idempotent — once filled, the WHERE matches nothing.
db.exec(`UPDATE jobs SET warm_up_mins =
  COALESCE((SELECT p.warm_up_mins FROM printers p WHERE p.id = jobs.printerId), 5)
  WHERE warm_up_mins IS NULL`);

// Lock state. A locked job is immovable by every scheduling path (manual
// push/pull, drag, planReshove, realign cascade, pause cascade, conflict
// resolution). The ONE exception is the live printer-status end-time sync of
// the job itself (realign writes the job's own start/end directly, bypassing
// the route guards). Prod-safe guarded ALTER, mirroring cool_down_mins /
// warm_up_mins above. DEFAULT 0 → all existing rows are unlocked, so the
// recomputed schedule is byte-identical to before this migration.
const jobColsLock = db.pragma('table_info(jobs)');
if (!jobColsLock.some(c => c.name === 'locked')) {
  db.exec('ALTER TABLE jobs ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
}
// Delay-conflict notification dedup flag (Part 3). Set once we've pushed the
// "active print delayed into a locked job" notice for the CURRENTLY-active
// conflict; cleared when the conflict clears (re-arm) or suppressed (=1) at
// print-start when the overlap pre-existed. DEFAULT 0.
if (!jobColsLock.some(c => c.name === 'conflict_notified')) {
  db.exec('ALTER TABLE jobs ADD COLUMN conflict_notified INTEGER NOT NULL DEFAULT 0');
}

// Projects. A project groups jobs by a free-text name. Prod-safe: guarded
// CREATE TABLE + a nullable jobs.project_id (DEFAULT NULL). No destructive
// backfill — existing jobs stay unassigned, so the recomputed schedule is
// byte-identical to before this migration.
//   id     = lowercase(trim(name)) — the match key.
//   label  = the name in the exact casing it was FIRST entered (display name).
//   status = 'open' | 'closed'.
db.exec(`CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);`);
const jobColsProject = db.pragma('table_info(jobs)');
if (!jobColsProject.some(c => c.name === 'project_id')) {
  db.exec('ALTER TABLE jobs ADD COLUMN project_id TEXT');
}

// Item-count tracking. A job produces a physical item count, seeded from its
// 3MF plate's objectCount on import (editable manually); items_lost records
// scrapped/failed items on that job; plate_name remembers which plate of a
// multi-plate 3MF this job maps to (set on import / migration / manual reload).
// Prod-safe additive columns, mirroring locked / project_id above:
//   - items      nullable (NULL = untracked, distinct from a real 0)
//   - items_lost NOT NULL DEFAULT 0 → existing rows read as zero losses
//   - plate_name nullable
// No destructive backfill here — the guarded startup backfill (server.js)
// self-heals items from the retained 3MF where it can, everything else stays
// NULL. Scheduling never reads these columns, so the recomputed schedule is
// byte-identical to before this migration.
const jobColsItems = db.pragma('table_info(jobs)');
if (!jobColsItems.some(c => c.name === 'items')) {
  db.exec('ALTER TABLE jobs ADD COLUMN items INTEGER');
}
if (!jobColsItems.some(c => c.name === 'items_lost')) {
  db.exec('ALTER TABLE jobs ADD COLUMN items_lost INTEGER NOT NULL DEFAULT 0');
}
if (!jobColsItems.some(c => c.name === 'plate_name')) {
  db.exec('ALTER TABLE jobs ADD COLUMN plate_name TEXT');
}

// One-time backfill: heal jobs left with a STALE linked_printer_id from before
// the forward-clearing fix (server.js PUT/PATCH now null the link when a status
// change leaves LINK_ACTIVE_STATUSES). Rows already in a status OUTSIDE that set
// — e.g. a 'Post Printing' / 'Done' job carrying a link from a manual finish
// before the fix — would otherwise still count as the printer's busy/current
// link (server.js:195/258, public/app.js). Clear every such link once.
//   - Idempotent by construction: the UPDATE only touches rows with a non-NULL
//     link in a non-active status; once cleared, the WHERE matches nothing.
//   - Marker-guarded (same pattern as favouriteMigrated / migration.items_backfill_v1)
//     so it runs at most once; a crash before the marker write just re-runs the
//     same idempotent UPDATE next boot.
//   - LINK_ACTIVE_STATUSES is imported from link-transition.js — the SAME set the
//     runtime guard uses — so the backfill and the guard can never drift.
//   - Cheap single UPDATE (no file IO), so it is safe synchronously here, unlike
//     the items backfill which shells out to unzip and must run post-listen.
const staleLinkMarker = db.prepare("SELECT value FROM settings WHERE key='migration.stale_link_backfill_v1'").get();
if (!staleLinkMarker) {
  const activeStatuses = [...LINK_ACTIVE_STATUSES];
  const placeholders = activeStatuses.map(() => '?').join(',');
  db.prepare(
    `UPDATE jobs SET linked_printer_id=NULL
       WHERE linked_printer_id IS NOT NULL
         AND (status IS NULL OR status NOT IN (${placeholders}))`
  ).run(...activeStatuses);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migration.stale_link_backfill_v1', '1')").run();
}

// One-time migration: if the favourite column was previously added with DEFAULT 0
// (all printers show favourite=0), set them all to 1 so they appear in day view.
const favMigrated = db.prepare("SELECT value FROM settings WHERE key='favouriteMigrated'").get();
if (!favMigrated) {
  db.exec("UPDATE printers SET favourite=1 WHERE favourite=0");
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('favouriteMigrated', '1')").run();
}

// Relax the legacy NOT NULL on jobs.printerId. An unassigned QUEUE job is now a
// first-class state: the headless 3MF importer has no printer at slice time and
// sends printerId=null, so such jobs must land on the queue (queued=1) instead
// of crashing on insert. SQLite can't drop a column constraint in place, so
// rebuild the table once — preserving every column/type/default and all rows —
// and re-emit printerId WITHOUT the NOT NULL. Idempotent: gated on the constraint
// still being present, so it runs at most once. The schema is rebuilt
// programmatically from PRAGMA table_info, so it self-adapts to whatever columns
// this DB has migrated through. `jobs` has no FKs/indexes/triggers/views, so
// there are no dependents to recreate.
const printerIdCol = db.pragma('table_info(jobs)').find(c => c.name === 'printerId');
if (printerIdCol && printerIdCol.notnull === 1) {
  const cols = db.pragma('table_info(jobs)');
  const defs = cols.map(c => {
    const parts = [`"${c.name}"`, c.type || 'BLOB'];
    if (c.pk === 1 && /INT/i.test(c.type || '')) {
      // The integer primary key keeps AUTOINCREMENT so ids stay monotonic.
      parts.push('PRIMARY KEY AUTOINCREMENT');
    } else {
      if (c.name !== 'printerId' && c.notnull === 1) parts.push('NOT NULL');
      if (c.dflt_value !== null) parts.push(`DEFAULT ${c.dflt_value}`);
    }
    return parts.join(' ');
  }).join(', ');
  const colList = cols.map(c => `"${c.name}"`).join(', ');
  // FK enforcement can't be toggled inside a transaction; jobs has no FKs so
  // this is belt-and-braces for the DROP/RENAME step.
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE jobs_rebuild (${defs})`);
    db.exec(`INSERT INTO jobs_rebuild (${colList}) SELECT ${colList} FROM jobs`);
    db.exec('DROP TABLE jobs');
    db.exec('ALTER TABLE jobs_rebuild RENAME TO jobs');
  })();
  db.pragma('foreign_keys = ON');
}

module.exports = db;
