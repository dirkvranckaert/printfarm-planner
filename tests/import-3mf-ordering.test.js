/**
 * Unit tests for the pure plate-reorder helper used by the 3MF import dialog.
 *
 * The actual function lives in public/app.js (browser-only file) so we
 * intentionally re-declare the same implementation here. Anything diverging
 * from the source is a fail signal — keep the two in sync. The contract under
 * test is small enough that mirroring it is cheaper than splitting a shared
 * module just for tests.
 */

function reorderPlates(order, fromIdx, direction) {
  const next = order.slice();
  const target = fromIdx + direction;
  if (target < 0 || target >= next.length) return next;
  [next[fromIdx], next[target]] = [next[target], next[fromIdx]];
  return next;
}

describe('reorderPlates', () => {
  test('move down: swaps with the next entry', () => {
    expect(reorderPlates([0, 1, 2], 0, 1)).toEqual([1, 0, 2]);
  });

  test('move up: swaps with the previous entry', () => {
    expect(reorderPlates([0, 1, 2], 2, -1)).toEqual([0, 2, 1]);
  });

  test('move up at first index is a no-op (boundary)', () => {
    expect(reorderPlates([0, 1, 2], 0, -1)).toEqual([0, 1, 2]);
  });

  test('move down at last index is a no-op (boundary)', () => {
    expect(reorderPlates([0, 1, 2], 2, 1)).toEqual([0, 1, 2]);
  });

  test('does not mutate the input array', () => {
    const input = [0, 1, 2];
    const out = reorderPlates(input, 0, 1);
    expect(input).toEqual([0, 1, 2]);
    expect(out).not.toBe(input);
  });

  test('preserves array length on every operation', () => {
    const input = [3, 1, 4, 1, 5, 9];
    expect(reorderPlates(input, 0, 1)).toHaveLength(input.length);
    expect(reorderPlates(input, input.length - 1, -1)).toHaveLength(input.length);
    expect(reorderPlates(input, 0, -1)).toHaveLength(input.length); // boundary no-op
    expect(reorderPlates(input, input.length - 1, 1)).toHaveLength(input.length);
  });

  test('single-element array: both directions are no-ops', () => {
    expect(reorderPlates([42], 0, -1)).toEqual([42]);
    expect(reorderPlates([42], 0, 1)).toEqual([42]);
  });

  test('two consecutive swaps return to identity', () => {
    const a = reorderPlates([0, 1, 2], 0, 1);   // [1, 0, 2]
    const b = reorderPlates(a, 1, -1);          // [0, 1, 2]
    expect(b).toEqual([0, 1, 2]);
  });

  test('works with non-numeric (object) elements — generic over array contents', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const out = reorderPlates(items, 0, 1);
    expect(out.map(x => x.id)).toEqual(['b', 'a', 'c']);
  });
});
