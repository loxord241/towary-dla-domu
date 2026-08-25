/**
 * Shared price formatting for the storefront (2026-08 UX audit): catalog
 * cards and the product page render integer prices («7399 UAH»), and the
 * cart previously used toFixed(2) («7399.00 UAH»). This helper keeps one
 * canonical shape: integers stay integers, genuine fractions get 2
 * decimals, and floating-point noise is rounded away.
 */
export function formatPrice(value: number, currency: string | null | undefined): string {
  const rounded = Math.round(value * 100) / 100;
  const display = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2);
  return currency ? `${display} ${currency}` : display;
}
