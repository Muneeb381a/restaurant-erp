export interface CategoryNode {
  id: string;
  parentId: string | null;
}

/**
 * True if moving `categoryId` under `newParentId` would make the tree cyclic
 * (the new parent is the category itself or one of its descendants).
 */
export function wouldCreateCycle(
  categories: readonly CategoryNode[],
  categoryId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
  const visited = new Set<string>();
  let cursor: string | null | undefined = newParentId;
  while (cursor) {
    if (cursor === categoryId) return true;
    if (visited.has(cursor)) return true; // pre-existing cycle: refuse to make it worse
    visited.add(cursor);
    cursor = parentOf.get(cursor);
  }
  return false;
}
