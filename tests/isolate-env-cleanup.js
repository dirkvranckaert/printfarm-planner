// Jest setupFilesAfterEnv: drop the per-file temp dir created by isolate-env.js.
const fs = require('fs');

afterAll(() => {
  const dir = process.env.PLANNER_TEST_TMP;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// supertest binds each request's server to a wildcard ephemeral port but connects to
// 127.0.0.1:<port>. On macOS another process holding that port on 127.0.0.1 only (dev
// servers, other jest runs: dozens on a busy dev box) silently receives the request and
// answers with a stray 401/404 from a foreign app. Random port, so one retry clears it.
// Not an app bug and absent on CI; retry is the cheap guard (cannot be bound away sync).
jest.retryTimes(2);
