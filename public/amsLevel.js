// Shared, pure AMS spool-level math (fill height + tooltip) for the slot tiles.
// Browser -> global `amsLevel`; Node/Jest -> module.exports. app.js and the
// Jest test use THIS module, so the test exercises the shipped logic.
//
// remainPct: percent from Bambu MQTT `tray.remain` (-1 / null / NaN = unknown).
// trayWeight: nominal spool grams from `tray.tray_weight` (<=0 / null = unknown).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.amsLevel = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN_BAND = 12; // % of tile height always coloured, so a near-empty spool keeps its colour

  function knownPct(remainPct) {
    if (remainPct == null || !Number.isFinite(Number(remainPct)) || Number(remainPct) < 0) return null;
    return Math.min(100, Number(remainPct));
  }

  // Height (percent of tile) of the coloured fill. Unknown -> 100 (full).
  function fillPct(remainPct) {
    const p = knownPct(remainPct);
    return p == null ? 100 : Math.max(p, MIN_BAND);
  }

  // Grams left, or null when percent or spool weight is unknown.
  function grams(remainPct, trayWeight) {
    const p = knownPct(remainPct);
    const w = Number(trayWeight);
    if (p == null || !Number.isFinite(w) || w <= 0) return null;
    return Math.round(p / 100 * w);
  }

  // "PLA · 42% · ~420 g" | "PLA · 42%" | "PLA · remaining unknown"
  function tooltip(material, remainPct, trayWeight) {
    const p = knownPct(remainPct);
    const parts = [material || '?'];
    if (p == null) {
      parts.push('remaining unknown');
    } else {
      parts.push(`${Math.round(p)}%`);
      const g = grams(remainPct, trayWeight);
      if (g != null) parts.push(`~${g} g`);
    }
    return parts.join(' · ');
  }

  return { MIN_BAND, fillPct, grams, tooltip };
});
