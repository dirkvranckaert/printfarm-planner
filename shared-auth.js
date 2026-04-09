'use strict';

/**
 * Shared Auth — Optional JWT-based cross-app authentication for Printseed tools.
 *
 * When SHARED_AUTH_SECRET is set in .env, this module:
 * - Issues a JWT cookie (shared_session, Domain=.app3.be) on login alongside the app's own session
 * - Accepts the shared JWT cookie as valid authentication in the middleware
 * - Enables cross-app API calls using the same JWT
 *
 * When SHARED_AUTH_SECRET is NOT set, this module is a no-op — the app works standalone.
 */

let jwt;
try { jwt = require('jsonwebtoken'); } catch { jwt = null; }

const COOKIE_NAME = 'shared_session';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function isEnabled() {
  return !!(process.env.SHARED_AUTH_SECRET && jwt);
}

/**
 * Generate a shared JWT cookie header string.
 * Call this on successful login to set the shared cookie alongside the app's own cookie.
 * Returns the Set-Cookie string, or null if shared auth is disabled.
 */
function createSharedCookie(username) {
  if (!isEnabled()) return null;
  const token = jwt.sign(
    { sub: username, iss: 'printseed' },
    process.env.SHARED_AUTH_SECRET,
    { expiresIn: TTL_SECONDS }
  );
  const domain = process.env.SHARED_AUTH_DOMAIN || '';
  const domainPart = domain ? `Domain=${domain}; ` : '';
  const secure = process.env.NODE_ENV === 'production' ? 'Secure; ' : '';
  return `${COOKIE_NAME}=${token}; ${domainPart}Path=/; Max-Age=${TTL_SECONDS}; HttpOnly; ${secure}SameSite=Lax`;
}

/**
 * Clear the shared cookie. Call on logout.
 * Returns the Set-Cookie string, or null if shared auth is disabled.
 */
function clearSharedCookie() {
  if (!isEnabled()) return null;
  const domain = process.env.SHARED_AUTH_DOMAIN || '';
  const domainPart = domain ? `Domain=${domain}; ` : '';
  return `${COOKIE_NAME}=; ${domainPart}Path=/; Max-Age=0; HttpOnly`;
}

/**
 * Validate the shared JWT from the request cookies.
 * Returns the decoded payload { sub, iss, iat, exp } if valid, or null.
 */
function validateSharedToken(req) {
  if (!isEnabled()) return null;
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + '='));
  if (!match) return null;
  const token = match.split('=')[1];
  try {
    const decoded = jwt.verify(token, process.env.SHARED_AUTH_SECRET, { issuer: 'printseed' });
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Discovery: check if another Printseed app is reachable.
 * Returns { available: true, name, version } or { available: false }.
 */
async function discoverApp(url) {
  if (!url) return { available: false };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${url.replace(/\/$/, '')}/api/config`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) return { available: false };
    const data = await res.json();
    return { available: true, version: data.version || null, url, publicUrl: data.publicUrl || null };
  } catch {
    return { available: false, url };
  }
}

module.exports = { isEnabled, createSharedCookie, clearSharedCookie, validateSharedToken, discoverApp, COOKIE_NAME };
