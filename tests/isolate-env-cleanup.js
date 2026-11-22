// Jest setupFilesAfterEnv: drop the per-file temp dir created by isolate-env.js.
// Root-level afterAll runs after every suite-level afterAll, so servers closed there
// (tests/helpers/listen-local.js) are already down when the dir goes.
const fs = require('fs');

afterAll(() => {
  const dir = process.env.PLANNER_TEST_TMP;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
