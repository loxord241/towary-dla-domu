/**
 * Pure page-window builder for the numbered catalog pagination.
 *
 * Contract (Audit 2026-09-05, low UX batch): show the current page with
 * ±2 neighbours plus the first and last page; gaps collapse to «…» and a
 * single skipped page is shown in full instead of an ellipsis. The result
 * never exceeds 9 items, so the bar stays one row on desktop.
 *
 * Page 1 and maxPage are always present, so the window is anchored even
 * at the edges. The caller keeps prev/next semantics and the disabled
 * span contract in app/catalog/page.tsx (P3-R2) — this helper only
 * decides WHICH numbers exist, never their URLs.
 */

export type PageWindowItem = number | 'ellipsis';

export function buildPageWindow(page: number, maxPage: number): PageWindowItem[] {
  const wanted = new Set<number>([1, maxPage]);
  for (let p = page - 2; p <= page + 2; p++) {
    if (p >= 1 && p <= maxPage) wanted.add(p);
  }

  const sorted = [...wanted].sort((a, b) => a - b);
  const out: PageWindowItem[] = [];
  let prev = 0;
  for (const p of sorted) {
    const gap = p - prev;
    if (gap === 2) out.push(prev + 1);
    else if (gap > 2) out.push('ellipsis');
    out.push(p);
    prev = p;
  }
  return out;
}
