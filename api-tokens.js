'use strict';

const crypto = require('crypto');

// API tokens: `pf_` + 32 random bytes (base64url). Only the SHA-256 hash is
// stored (the token is high-entropy, so a fast hash is fine), plus a short
// display prefix. No expiry; revoke = delete the row.
const PREFIX = 'pf_';
const DISPLAY_PREFIX_LEN = 8; // "pf_" + 5 chars

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Returns the raw bearer string, or null when the request has no Bearer header.
function parseBearer(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.*)$/i);
  return m ? m[1].trim() : null;
}

function create(db, { name, owner }) {
  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const info = db.prepare(
    'INSERT INTO api_tokens (name, token_hash, prefix, owner, created_at) VALUES (?,?,?,?,?)'
  ).run(name, hashToken(token), token.slice(0, DISPLAY_PREFIX_LEN), owner, now);
  return { id: Number(info.lastInsertRowid), name, prefix: token.slice(0, DISPLAY_PREFIX_LEN), created_at: now, token };
}

function list(db) {
  return db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_tokens ORDER BY id DESC').all();
}

function revoke(db, id) {
  return db.prepare('DELETE FROM api_tokens WHERE id=?').run(id);
}

// Look up by hash; stamps last_used_at. Returns the row or null.
function authenticate(db, token) {
  if (!token.startsWith(PREFIX)) return null;
  const row = db.prepare('SELECT id, name, owner FROM api_tokens WHERE token_hash=?').get(hashToken(token));
  if (!row) return null;
  db.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').run(new Date().toISOString(), row.id);
  return row;
}

module.exports = { hashToken, parseBearer, create, list, revoke, authenticate };
