'use strict';

// Orchestrates a timed move (push-back / pull-forward, custom time or to-now)
// that may require reshuffling the schedule. Shared by the browser (app.js) and
// Jest (node) so the confirm/retry payload is exercised by tests, not just the
// Express endpoints.
//
// Deps are injected so it stays DOM-free and testable:
//   - api(method, path, body): the app's fetch wrapper, resolves to parsed JSON.
//   - confirmReshove(): resolves truthy when the user confirms the reshuffle.
//
// Contract with the server:
//   - A blocked target returns { needsReshove: true, target } WITHOUT writing.
//   - The retry carries reshove:true. When the ORIGINAL request omitted `to`
//     (a to-now move), the retry MUST pin `to` to the server's returned target,
//     otherwise the server recomputes a later "now" and the anchor misses the
//     originally requested instant.
//
// Returns the server's final response, or { cancelled: true } if the user
// declined the reshuffle.
async function performTimedMove({ api, path, body, confirmReshove }) {
  let res = await api('POST', path, body);
  if (res && res.needsReshove) {
    const ok = await confirmReshove(res);
    if (!ok) return { cancelled: true };
    const retry = { ...body, reshove: true };
    if (body.to == null && res.target) retry.to = res.target;
    res = await api('POST', path, retry);
  }
  return res || {};
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { performTimedMove };
}
