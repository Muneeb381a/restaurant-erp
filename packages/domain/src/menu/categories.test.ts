import { describe, expect, it } from 'vitest';
import { wouldCreateCycle } from './categories';

// BBQ ─ Tikka ─ Chicken Tikka;  Drinks
const tree = [
  { id: 'bbq', parentId: null },
  { id: 'tikka', parentId: 'bbq' },
  { id: 'chicken', parentId: 'tikka' },
  { id: 'drinks', parentId: null },
];

describe('wouldCreateCycle', () => {
  it('allows moving to root or to an unrelated branch', () => {
    expect(wouldCreateCycle(tree, 'chicken', null)).toBe(false);
    expect(wouldCreateCycle(tree, 'tikka', 'drinks')).toBe(false);
    expect(wouldCreateCycle(tree, 'chicken', 'bbq')).toBe(false);
  });

  it('rejects making a category its own parent', () => {
    expect(wouldCreateCycle(tree, 'bbq', 'bbq')).toBe(true);
  });

  it('rejects moving a category under its own descendant', () => {
    expect(wouldCreateCycle(tree, 'bbq', 'tikka')).toBe(true);
    expect(wouldCreateCycle(tree, 'bbq', 'chicken')).toBe(true);
  });

  it('refuses when the existing data already contains a cycle', () => {
    const bad = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: null },
    ];
    expect(wouldCreateCycle(bad, 'c', 'a')).toBe(true);
  });

  it('handles a parent id that is not in the list', () => {
    expect(wouldCreateCycle(tree, 'bbq', 'unknown')).toBe(false);
  });
});
