/** Menu categories form a tree (BBQ → Regular, Special). These helpers are pure so they can be tested. */
export interface Cat {
  id: string;
  parentId: string | null;
  name: string;
  nameUr?: string | null;
}

export interface CatNode<T extends Cat> {
  cat: T;
  depth: number;
  /** "BBQ › Special": what to show where the parent matters */
  path: string;
}

/**
 * The categories in reading order: each top-level one followed by its sub-categories, indented by
 * `depth`. A category whose parent does not exist counts as top-level, and a loop in the data can
 * never hang the screen (depth is capped).
 */
export function categoryTree<T extends Cat>(
  cats: readonly T[],
  label: (c: T) => string = (c) => c.name,
): CatNode<T>[] {
  const known = new Set(cats.map((c) => c.id));
  const kids = new Map<string | null, T[]>();
  for (const c of cats) {
    const key = c.parentId && known.has(c.parentId) && c.parentId !== c.id ? c.parentId : null;
    kids.set(key, [...(kids.get(key) ?? []), c]);
  }
  const out: CatNode<T>[] = [];
  const walk = (parent: string | null, depth: number, trail: string[]): void => {
    if (depth > 6) return;
    for (const c of kids.get(parent) ?? []) {
      if (out.some((n) => n.cat.id === c.id)) continue; // a loop: show each category once
      const path = [...trail, label(c)];
      out.push({ cat: c, depth, path: path.join(' › ') });
      walk(c.id, depth + 1, path);
    }
  };
  walk(null, 0, []);
  // anything left over (only a loop with no entrance) is shown at the top rather than lost
  for (const c of cats)
    if (!out.some((n) => n.cat.id === c.id)) out.push({ cat: c, depth: 0, path: label(c) });
  return out;
}

/** The category and everything below it. */
export function withDescendants(cats: readonly Cat[], id: string): Set<string> {
  const ids = new Set<string>([id]);
  for (let grew = true, guard = 0; grew && guard < 10; guard++) {
    grew = false;
    for (const c of cats) {
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** The top-level category a category belongs to (itself if it is top-level). */
export function topOf(cats: readonly Cat[], id: string | null): string | null {
  let cur = id;
  for (let i = 0; cur && i < 10; i++) {
    const parent = cats.find((c) => c.id === cur)?.parentId ?? null;
    if (!parent || !cats.some((c) => c.id === parent)) return cur;
    cur = parent;
  }
  return cur;
}

/**
 * Which categories may become the parent of `id`? Only top-level ones, never itself, and a category
 * that already has sub-categories stays top-level: the menu is kept to two levels so a cashier never
 * digs through a deep tree.
 */
export function parentChoices<T extends Cat>(cats: readonly T[], id: string | null): T[] {
  if (id && cats.some((c) => c.parentId === id)) return [];
  return cats.filter((c) => c.parentId === null && c.id !== id);
}
