'use strict';

/**
 * Stream a raw request body straight to a file on disk (#4051). Replaces
 * `express.raw({limit:'500mb'})`, which buffered the whole upload in memory
 * (up to 500 MB against PM2 `max_memory_restart` 256M). Memory stays flat.
 *
 * Resolves `{ size }`; rejects with `err.status` 413 (over `limit`) or 400
 * (empty body). The partial file is always removed on failure.
 */

const fs = require('fs');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_LIMIT = 500 * 1024 * 1024;

async function streamToFile(req, destPath, limit = DEFAULT_LIMIT) {
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('Upload too large');
        err.status = 413;
        return cb(err);
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(destPath));
  } catch (err) {
    await fs.promises.rm(destPath, { force: true });
    throw err;
  }
  if (size === 0) {
    await fs.promises.rm(destPath, { force: true });
    const err = new Error('Empty body');
    err.status = 400;
    throw err;
  }
  return { size };
}

module.exports = { streamToFile, DEFAULT_LIMIT };
