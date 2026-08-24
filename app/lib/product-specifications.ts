/**
 * Pure normalization for products.specifications (JSONB array of
 * {name,value}) before rendering. No I/O, no React — unit-testable.
 *
 * Contract:
 *  - keeps supplier ORDER (array order is the contract);
 *  - keeps DUPLICATE names (they are valid data — several values per
 *    characteristic exist in the real feed);
 *  - drops entries that are not {name:string, value:string} or whose
 *    name/value are empty after trimming (values are trimmed for display
 *    only; the stored JSONB is never mutated);
 *  - returns [] when specifications is absent/empty → caller hides block.
 */

export interface ProductSpecificationsRow {
  name: string;
  value: string;
}

export function sanitizeSpecRows(
  specifications: unknown
): ProductSpecificationsRow[] {
  if (!Array.isArray(specifications)) return [];
  const out: ProductSpecificationsRow[] = [];
  for (const entry of specifications) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, value } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    const n = name.trim();
    const v = value.trim();
    if (n === '' || v === '') continue;
    out.push({ name: n, value: v });
  }
  return out;
}
