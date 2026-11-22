// Start the Express app on an ephemeral port bound to 127.0.0.1 and resolve once it is
// listening. Use with supertest: `server = await listenLocal(app)` in beforeAll,
// `request(server)` in tests, `await closeServer(server)` in afterAll.
//
// Why not `request(app)`: supertest then does `app.listen(0)` (wildcard bind) but
// connects to 127.0.0.1:<port>. On macOS a foreign process holding that port on
// 127.0.0.1 only does not block the wildcard bind, so the request is answered by the
// foreign server (stray 401/404). Binding to 127.0.0.1 makes the kernel skip such ports.
const http = require('http');

async function listenLocal(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

function closeServer(server) {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

module.exports = { listenLocal, closeServer };
