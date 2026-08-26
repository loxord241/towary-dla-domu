/**
 * Shared price formatting for the storefront — THE single presentation
 * point for prices on every surface (P3-R1 2026-08-26): catalog cards,
 * product page, variants, related/recent shelves and the cart all render
 * through this helper. uk-UA locale: thousands grouping with a non-breaking
 * space («17 599 UAH»), comma decimals for genuine fractions («99,50 UAH»).
 * Display only — DB values, cart totals and discount math are untouched.
 */
const intFormat = new Intl.NumberFormat('uk-UA', {
  maximumFractionDigits: 0,
});
const fracFormat = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPrice(value: number, currency: string | null | undefined): string {
  const rounded = Math.round(value * 100) / 100;
  // Integers stay integer («17 599»); genuine fractions keep EXACTLY two
  // decimals («99,50») — the pre-P3 cart contract, now uk-UA everywhere.
  const display = Number.isInteger(rounded)
    ? intFormat.format(rounded)
    : fracFormat.format(rounded);
  return currency ? `${display} ${currency}` : display;
}
