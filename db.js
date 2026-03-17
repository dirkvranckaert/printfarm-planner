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
`);

// Migrations: add columns if not present
const jobCols = db.pragma('table_info(jobs)');
if (!jobCols.some(c => c.name === 'queued')) {
  db.exec('ALTER TABLE jobs ADD COLUMN queued INTEGER NOT NULL DEFAULT 0');
}
if (!jobCols.some(c => c.name === 'durationMins')) {
  db.exec('ALTER TABLE jobs ADD COLUMN durationMins INTEGER NOT NULL DEFAULT 0');
}

const printerCols = db.pragma('table_info(printers)');
if (!printerCols.some(c => c.name === 'bambu_serial')) {
  db.exec('ALTER TABLE printers ADD COLUMN bambu_serial TEXT;');
}

module.exports = db;
