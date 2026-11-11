/**
 * Phones: a wide data table becomes a stack of cards (see `.dt` in index.css). The card shows each
 * cell's column name beside its value, so every cell needs a `data-label`. This copies the header
 * text onto the cells (following rowspans, which the menu table uses for items with several sizes)
 * and keeps doing so as pages render and the language changes. Desktop is untouched.
 */
function labelTable(table: HTMLTableElement): void {
  const heads = Array.from(table.tHead?.rows[0]?.cells ?? []).map(
    (th) => th.textContent?.trim() ?? '',
  );
  if (heads.length === 0) return;
  const pending: number[] = []; // rows still covered by a rowspan, per column
  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      let col = 0;
      let continued = false;
      for (const cell of Array.from(row.cells)) {
        while ((pending[col] ?? 0) > 0) {
          pending[col]! -= 1;
          if (col === 0) continued = true;
          col += 1;
        }
        const label = cell.colSpan > 1 ? '' : (heads[col] ?? '');
        if (cell.dataset.label !== label) cell.dataset.label = label;
        if (cell.rowSpan > 1)
          for (let k = 0; k < cell.colSpan; k++) pending[col + k] = cell.rowSpan - 1;
        col += cell.colSpan;
      }
      // a row whose first columns are covered by the row above is a further size of the same item
      if (continued) row.dataset.cont = '';
      else delete row.dataset.cont;
    }
  }
}

function labelAll(): void {
  document.querySelectorAll<HTMLTableElement>('.dt table').forEach(labelTable);
}

/** Starts watching the page; returns a function that stops it. */
export function watchResponsiveTables(): () => void {
  let queued = false;
  const run = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      labelAll();
    });
  };
  const observer = new MutationObserver(run);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  run();
  return () => observer.disconnect();
}
