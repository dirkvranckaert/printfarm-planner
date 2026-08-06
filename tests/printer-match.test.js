// Unit tests for the shared 3MF-printer fuzzy matcher (printer-match.js). This is
// the SAME normalise + substring rule the import dialog uses client-side, with an
// ambiguity guard: auto-bind commits without review, so only a single match binds.
const { normalizePrinterName, matchPrinter } = require('../printer-match');

describe('normalizePrinterName', () => {
  test('lowercases, strips whitespace/-/_ and drops "lab"', () => {
    expect(normalizePrinterName('Bambu Lab P1S')).toBe('bambup1s');
    expect(normalizePrinterName('X1-Carbon')).toBe('x1carbon');
    expect(normalizePrinterName(null)).toBe('');
  });
});

describe('matchPrinter', () => {
  const printers = [
    { id: 1, name: 'P1S' },
    { id: 2, name: 'X1 Carbon' },
    { id: 3, name: 'A1 mini' },
  ];

  test('binds on a single fuzzy match', () => {
    expect(matchPrinter('Bambu Lab P1S', printers)).toEqual({ id: 1, name: 'P1S' });
    expect(matchPrinter('Bambu Lab X1 Carbon', printers)).toEqual({ id: 2, name: 'X1 Carbon' });
  });

  test('returns null when nothing matches', () => {
    expect(matchPrinter('Prusa MK4', printers)).toBeNull();
  });

  test('returns null on an empty/absent printer name', () => {
    expect(matchPrinter('', printers)).toBeNull();
    expect(matchPrinter(null, printers)).toBeNull();
  });

  test('returns null when the match is ambiguous (prefer unassigned over a wrong bind)', () => {
    // Both "P1S" (p1s ⊂ bambup1s) and "Bambu" (bambu ⊂ bambup1s) fuzzy-match
    // "Bambu Lab P1S" → two hits → ambiguous → null.
    const ambiguous = [{ id: 1, name: 'P1S' }, { id: 2, name: 'Bambu' }];
    expect(matchPrinter('Bambu Lab P1S', ambiguous)).toBeNull();
  });
});
