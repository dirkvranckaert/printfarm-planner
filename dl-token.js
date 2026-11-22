'use strict';

/**
 * Short-lived signed download tokens for the "open in slicer" flow.
 *
 * A slicer fetches the 3MF with no planner session, so the (authenticated)
 * mint endpoint hands out an HMAC-signed token bound to ONE stored filename
 * with a ~5 min expiry. Token = base64url(JSON{f,e}) "." base64url(HMAC).
 * The key is derived (HMAC with a context label) from an existing server
 * secret, never the raw secret, and is never logged or returned.
 */

const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;
const STORED_RE = /^[a-f0-9]{1,64}\.3mf$/;

let cachedKey = null;
function key() {
  if (cachedKey) return cachedKey;
  // High-entropy secrets only. Never ADMIN_PASS: a leaked token would be an offline
  // dictionary oracle on the login password.
  const secret = process.env.DL_TOKEN_SECRET || process.env.SHARED_AUTH_SECRET
    || crypto.randomBytes(32).toString('hex'); // per-process; live links die on restart (<=5 min)
  cachedKey = crypto.createHmac('sha256', secret).update('printfarm-planner:dl-token:v1').digest();
  return cachedKey;
}

const b64 = buf => Buffer.from(buf).toString('base64url');
const sign = payload => crypto.createHmac('sha256', key()).update(payload).digest();

function mint(file, now = Date.now(), ttlMs = TTL_MS) {
  if (!STORED_RE.test(file)) throw new Error('bad file');
  const payload = b64(JSON.stringify({ f: file, e: now + ttlMs }));
  return `${payload}.${b64(sign(payload))}`;
}

/** @returns {string|null} stored filename when token is authentic + unexpired */
function verify(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 400) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const given = Buffer.from(sig, 'base64url');
  const expect = sign(payload);
  if (given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || typeof data.f !== 'string' || !Number.isFinite(data.e)) return null;
  if (now > data.e) return null;
  if (!STORED_RE.test(data.f)) return null;
  return data.f;
}

module.exports = { mint, verify, TTL_MS, STORED_RE };
