'use strict';

// Fuzzy-match a 3MF's embedded printer name (BambuStudio `printer_model`) against
// the farm's defined printers. Pure function — the SAME normalise + substring
// rule the import dialog runs client-side (mirrored in public/app.js, the
// "Fuzzy match printer name" block). Extracted here so the server can auto-bind
// a headless import to a printer using exactly the match the dialog would show.
//
// Rule: normalise both sides (lowercase, strip whitespace/-/_, drop "lab" so
// "Bambu Lab P1S" ~ "P1S"), then a printer matches when either normalised string
// contains the other.
//
// The one deliberate difference from the dialog: `matchPrinter` binds ONLY on a
// single, unambiguous match. The dialog can pick the first of several fuzzy hits
// because a human sees the choice and can correct it; an unattended auto-bind
// commits without review, so zero matches OR more than one both yield null
// (leave unassigned) rather than risk binding the wrong printer.

function normalizePrinterName(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_]+/g, '').replace('lab', '');
}

/**
 * @param {string} printerName  The 3MF's embedded printer name (parse3mf .printerName).
 * @param {Array<{id:number, name:string}>} printers  Defined farm printers.
 * @returns {object|null}  The single matched printer row, or null when there is
 *                         no name, no printers, no match, or an ambiguous match.
 */
function matchPrinter(printerName, printers) {
  if (!printerName || !Array.isArray(printers)) return null;
  const pNorm = normalizePrinterName(printerName);
  if (!pNorm) return null;
  const matches = printers.filter(pr => {
    const n = normalizePrinterName(pr.name);
    return n && (pNorm.includes(n) || n.includes(pNorm));
  });
  return matches.length === 1 ? matches[0] : null;
}

module.exports = { normalizePrinterName, matchPrinter };
