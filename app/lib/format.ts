/**
 * Shared price formatting for the storefront — THE single presentation
 * point for prices on every surface (P3-R1 2026-08-26): catalog cards,
 * product page, variants, related/recent shelves and the cart all render
 * through this helper. uk-UA locale: thousands grouping with a non-breaking
 * space, comma decimals for genuine fractions («99,50»).
 * Display only — DB values, cart totals and discount math are untouched.
 *
 * Currency label (audit P2): the DB stores ISO codes (UAH) but the
 * storefront speaks Ukrainian — «17 599 грн», not «17 599 UAH». Unknown
 * codes fall through verbatim (never invent a symbol).
 */
const CURRENCY_LABELS: Record<string, string> = {
  UAH: 'грн',
};

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
  if (!currency) return display;
  return `${display} ${CURRENCY_LABELS[currency] ?? currency}`;
}

/**
 * Ukrainian pluralization for products:
 * 1 товар (21 товар, 101 товар, але 11 товарів)
 * 2-4 товари (22-24 товари, але 12-14 товарів)
 * 5-0 товарів (5, 6, 7, 8, 9, 10, 11-14, 20 товарів)
 */
export function pluralProducts(count: number): string {
  const abs = Math.abs(count);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} товар`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} товари`;
  return `${count} товарів`;
}

