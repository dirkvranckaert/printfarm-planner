// Jest setupFiles: runs once per test file, before the test module loads. Gives every
// test file its own throwaway DB and uploads dir so parallel workers (and suites run
// back to back in one worker) never share state. Suites that set PLANNER_DB_PATH /
// PLANNER_UPLOADS_DIR themselves still win (they assign after this file ran).
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printfarm-test-'));
process.env.PLANNER_TEST_TMP = dir; // removed by isolate-env-cleanup.js
process.env.PLANNER_DB_PATH = path.join(dir, 'planner.db');
process.env.PLANNER_UPLOADS_DIR = path.join(dir, 'uploads');
