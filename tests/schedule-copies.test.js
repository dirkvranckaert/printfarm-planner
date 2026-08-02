/**
 * Unit tests for `expandPlateCopies` — the per-plate copies expansion used by
 * the /api/import-3mf-schedule route. The route feeds the expanded list into
 * the existing back-to-back scheduling loop, so proving the expansion is
 * order-preserving, correctly counted, and correctly validated is enough to
 * guarantee the cascade behaviour (the loop itself is covered by the
 * "array-order is the contract" suite in server.test.js).
 */

const { expandPlateCopies, MAX_COPIES } = require('../scheduling');

describe('expandPlateCopies', () => {
  test('missing copies means 1 — N=1 payload is unchanged', () => {
    const plates = [{ plateIndex: 1, name: 'Solo', printerId: 7, durationMins: 45 }];
    const out = expandPlateCopies(plates);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Solo');
    // copies stripped from the outgoing entry
    expect(out[0]).not.toHaveProperty('copies');
    // all other fields preserved
    expect(out[0]).toMatchObject({ plateIndex: 1, printerId: 7, durationMins: 45 });
  });

  test('copies: 1 explicitly behaves identically to omitting it', () => {
    const out = expandPlateCopies([{ plateIndex: 2, name: 'One', copies: 1 }]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('One');
  });

  test('N>1 clones the plate N times, first bare, rest suffixed', () => {
    const out = expandPlateCopies([{ plateIndex: 3, name: 'Widget', printerId: 5, durationMins: 60, copies: 3 }]);
    expect(out.map(p => p.name)).toEqual(['Widget', 'Widget (copy 2)', 'Widget (copy 3)']);
    // every copy carries the same printer + duration + plate mapping
    for (const p of out) {
      expect(p.printerId).toBe(5);
      expect(p.durationMins).toBe(60);
      expect(p.plateIndex).toBe(3);
    }
  });

  test('copies expand IN PLACE, preserving multi-plate order (B x2, A x3 -> B,B,A,A,A)', () => {
    const plates = [
      { plateIndex: 2, name: 'B', printerId: 1, durationMins: 30, copies: 2 },
      { plateIndex: 1, name: 'A', printerId: 1, durationMins: 30, copies: 3 },
    ];
    const out = expandPlateCopies(plates);
    expect(out.map(p => p.name)).toEqual(['B', 'B (copy 2)', 'A', 'A (copy 2)', 'A (copy 3)']);
  });

  test('interleave order is exactly B, B, A, A, A', () => {
    const plates = [
      { plateIndex: 2, name: 'B', copies: 2 },
      { plateIndex: 1, name: 'A', copies: 3 },
    ];
    const names = expandPlateCopies(plates).map(p => p.name.replace(/ \(copy \d+\)$/, ''));
    expect(names).toEqual(['B', 'B', 'A', 'A', 'A']);
  });

  test('does not mutate the input plates', () => {
    const plates = [{ plateIndex: 1, name: 'X', copies: 2 }];
    expandPlateCopies(plates);
    expect(plates).toEqual([{ plateIndex: 1, name: 'X', copies: 2 }]);
  });

  test('rejects copies < 1', () => {
    expect(() => expandPlateCopies([{ plateIndex: 1, name: 'X', copies: 0 }])).toThrow(/Invalid copies/);
  });

  test('rejects non-integer copies', () => {
    expect(() => expandPlateCopies([{ plateIndex: 1, name: 'X', copies: 2.5 }])).toThrow(/Invalid copies/);
    expect(() => expandPlateCopies([{ plateIndex: 1, name: 'X', copies: '3' }])).toThrow(/Invalid copies/);
  });

  test('rejects oversized copies (> MAX_COPIES)', () => {
    expect(() => expandPlateCopies([{ plateIndex: 1, name: 'X', copies: MAX_COPIES + 1 }])).toThrow(/Too many copies/);
  });

  test('accepts copies exactly at the cap', () => {
    const out = expandPlateCopies([{ plateIndex: 1, name: 'X', copies: MAX_COPIES }]);
    expect(out).toHaveLength(MAX_COPIES);
  });
});
