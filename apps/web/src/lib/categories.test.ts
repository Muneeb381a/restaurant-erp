import { describe, expect, it } from 'vitest';
import { categoryTree, parentChoices, topOf, withDescendants, type Cat } from './categories';

const c = (id: string, name: string, parentId: string | null = null): Cat => ({
  id,
  name,
  parentId,
});
const bbq = c('bbq', 'BBQ');
const reg = c('reg', 'Regular', 'bbq');
const spe = c('spe', 'Special', 'bbq');
const drinks = c('drinks', 'Drinks');

describe('categoryTree', () => {
  it('lists each top-level category followed by its sub-categories, with a path', () => {
    const tree = categoryTree([reg, drinks, bbq, spe]);
    expect(tree.map((n) => [n.cat.id, n.depth, n.path])).toEqual([
      ['drinks', 0, 'Drinks'],
      ['bbq', 0, 'BBQ'],
      ['reg', 1, 'BBQ › Regular'],
      ['spe', 1, 'BBQ › Special'],
    ]);
  });

  it('never hangs or loses a category when the data has a loop or a missing parent', () => {
    const a = c('a', 'A', 'b');
    const b = c('b', 'B', 'a');
    const orphan = c('o', 'Orphan', 'gone');
    const tree = categoryTree([a, b, orphan]);
    expect(tree.map((n) => n.cat.id).sort()).toEqual(['a', 'b', 'o']);
  });
});

describe('withDescendants / topOf', () => {
  const all = [bbq, reg, spe, drinks];
  it('a category includes its sub-categories; a sub-category only itself', () => {
    expect([...withDescendants(all, 'bbq')].sort()).toEqual(['bbq', 'reg', 'spe']);
    expect([...withDescendants(all, 'reg')]).toEqual(['reg']);
  });
  it('finds the main category of a dish', () => {
    expect(topOf(all, 'spe')).toBe('bbq');
    expect(topOf(all, 'drinks')).toBe('drinks');
    expect(topOf(all, null)).toBeNull();
  });
});

describe('parentChoices', () => {
  const all = [bbq, reg, spe, drinks];
  it('offers only top-level categories, never the category itself', () => {
    expect(parentChoices(all, 'reg').map((x) => x.id)).toEqual(['bbq', 'drinks']);
    expect(parentChoices(all, null).map((x) => x.id)).toEqual(['bbq', 'drinks']);
  });
  it('a category that has sub-categories cannot become one itself', () => {
    expect(parentChoices(all, 'bbq')).toEqual([]);
  });
});
