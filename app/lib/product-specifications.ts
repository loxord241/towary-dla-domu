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
 *  - PURELY-NUMERIC values lose their trailing zeros for display
 *    («1000.00» → «1000», «0.80» → «0.8»); the decimal separator itself is
 *    NOT touched and non-numeric values («20 м²», «1,7», «10x15») pass
 *    through verbatim;
 *  - returns [] when specifications is absent/empty → caller hides block.
 */

export interface ProductSpecificationsRow {
  name: string;
  value: string;
}

/**
 * Display-only trailing-zero trim for purely numeric values. A value
 * qualifies only when it is digits with an optional dot-fraction — no units,
 * commas, signs or other characters — so «1.50» becomes «1.5» while «1,50»,
 * «-1.50» and «10x15» stay verbatim.
 */
function trimTrailingZeros(value: string): string {
  if (!/^\d+(?:\.\d+)$/.test(value)) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
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
    const v = trimTrailingZeros(value.trim());
    if (n === '' || v === '') continue;
    out.push({ name: n, value: v });
  }
  return out;
}
