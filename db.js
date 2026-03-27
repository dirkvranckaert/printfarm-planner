const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'planner.db'));

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

// One-time migration: if the favourite column was previously added with DEFAULT 0
// (all printers show favourite=0), set them all to 1 so they appear in day view.
const favMigrated = db.prepare("SELECT value FROM settings WHERE key='favouriteMigrated'").get();
if (!favMigrated) {
  db.exec("UPDATE printers SET favourite=1 WHERE favourite=0");
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('favouriteMigrated', '1')").run();
}

module.exports = db;
