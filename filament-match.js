'use strict';

// Match a printed color (hex + optional brand/type hints) against a catalog
// of filaments from filament-manager. Pure function — same code runs server-
// side (require) and client-side (inlined into public/app.js).
//
// Matching rules (decided by user 2026-04-14):
//   1. Hex must match EXACTLY (after normalising both sides to "#rrggbb").
//   2. Tie-break, in priority order:
//      a. Highest count of matched discriminators across {brand, type}.
//         Brand and type are normalised by lowercasing and stripping all
//         whitespace + hyphens + underscores so "Bambu Lab" / "Bambulab" /
//         "bambu-lab" all hash the same way.
//      b. In-stock filaments win over out-of-stock.
//      c. Lowest `id` (oldest entry — implicitly the "default" one the user
//         added first when there's still a tie).

function normalizeHex(s) {
  if (!s) return null;
  let h = String(s).trim().toLowerCase();
  if (!h.startsWith('#')) h = '#' + h;
  if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return /^#[0-9a-f]{6}$/.test(h) ? h : null;
}

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-]+/g, '');
}

/**
 * Find the best filament match for a single color.
 *
 * @param {object} query        { color: hex, brand?: string, type?: string }
 * @param {Array}  catalog      Filament rows from filament-manager. Each row
 *                              must have at least: id, brand, colorName,
 *                              type, inStock, colorHex.
 * @returns {object|null}       The chosen filament row, or null if no
 *                              filament shares the same hex.
 */
function matchFilament(query, catalog) {
  const targetHex = normalizeHex(query?.color);
  if (!targetHex || !Array.isArray(catalog)) return null;

  const candidates = catalog.filter(f => normalizeHex(f.colorHex) === targetHex);
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const qBrand = normalizeKey(query.brand);
  const qType  = normalizeKey(query.type);

  function score(f) {
    const fBrand = normalizeKey(f.brand);
    const fType  = normalizeKey(f.type);
    const brandMatch = qBrand && fBrand && fBrand === qBrand;
    const typeMatch  = qType  && fType  && fType  === qType;
    const matched = (brandMatch ? 1 : 0) + (typeMatch ? 1 : 0);
    return [matched, f.inStock ? 1 : 0, -f.id];
  }

  let best = candidates[0];
  let bestScore = score(best);
  for (let i = 1; i < candidates.length; i++) {
    const s = score(candidates[i]);
    if (s[0] > bestScore[0] ||
        (s[0] === bestScore[0] && s[1] > bestScore[1]) ||
        (s[0] === bestScore[0] && s[1] === bestScore[1] && s[2] > bestScore[2])) {
      best = candidates[i];
      bestScore = s;
    }
  }
  return best;
}

/**
 * Convenience: enrich a colors array (the {color, name, brand, extruder}
 * shape stored on planner jobs) with matched filament-manager names. Mutates
 * each entry's `name` and `brand` IF a match exists; leaves the entry alone
 * otherwise so the caller's original ntc/hexToName fallback still applies.
 *
 * @param {Array}  colors    Mutated in place.
 * @param {Array}  catalog   Filament catalog from filament-manager.
 * @param {object} [opts]    { type?: string }   default type to apply to all colors
 * @returns {{matched: number, total: number, replacements: Array}} report
 */
function enrichColorsFromCatalog(colors, catalog, opts = {}) {
  const replacements = [];
  let matched = 0;
  for (const c of colors || []) {
    const m = matchFilament({ color: c.color, brand: c.brand, type: opts.type }, catalog);
    if (!m) continue;
    if (c.name !== m.colorName || c.brand !== m.brand) {
      replacements.push({ hex: c.color, oldName: c.name || null, oldBrand: c.brand || null, newName: m.colorName, newBrand: m.brand });
    }
    c.name = m.colorName;
    c.brand = m.brand;
    matched++;
  }
  return { matched, total: (colors || []).length, replacements };
}

module.exports = {
  normalizeHex,
  normalizeKey,
  matchFilament,
  enrichColorsFromCatalog,
};
