import type { Product, ReviewSummary } from '@/app/lib/catalog';

/**
 * schema.org/Product builder — PURE and dependency-free at runtime
 * (type-only imports are erased, so node:test loads this without Supabase).
 *
 * Honesty rules (spec F of the SEO package): every emitted value originates
 * in the database — no invented availability, ratings, counts, brands or
 * SKUs. Offers require a positive finite price; aggregateRating requires
 * REAL published totals (>0 reviews with a computed average).
 */

export type ProductLike = Pick<
  Product,
  | 'name'
  | 'slug'
  | 'sku'
  | 'price'
  | 'currency'
  | 'availability_status'
> & {
  description?: string | null;
  short_description?: string | null;
  images: { image_url: string }[];
  brand?: { name: string } | null;
};

export type ReviewSummaryLike = ReviewSummary;

/** HTML → plain text: drop tags, decode the entities suppliers actually use. */
export function stripHtmlToText(
  html: string | null | undefined,
  cap = 5000
): string {
  if (!html) return '';
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, cap);
}

/** Stored currency → ISO 4217. Symbol/word forms map to the hryvnia code. */
export function toIsoCurrency(currency: string | null | undefined): string {
  const c = (currency ?? '').trim();
  if (/^[a-z]{3}$/i.test(c)) return c.toUpperCase();
  return 'UAH';
}

function availabilityUrl(status: string): string {
  if (status === 'in_stock') return 'https://schema.org/InStock';
  if (status === 'out_of_stock') return 'https://schema.org/OutOfStock';
  return 'https://schema.org/LimitedAvailability';
}

export function buildProductJsonLd(
  product: ProductLike,
  summary: ReviewSummaryLike | null,
  siteUrl: string
): Record<string, unknown> | null {
  const base: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    sku: product.sku,
  };

  const image = (product.images ?? [])
    .map((img) => img.image_url)
    .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url));
  if (image.length > 0) base.image = image;

  const description =
    stripHtmlToText(product.description) ||
    stripHtmlToText(product.short_description);
  if (description) base.description = description;

  if (product.brand?.name) {
    base.brand = { '@type': 'Brand', name: product.brand.name };
  }

  if (Number.isFinite(product.price) && product.price > 0) {
    base.offers = {
      '@type': 'Offer',
      url: `${siteUrl.replace(/\/+$/, '')}/product/${product.slug}`,
      price: String(product.price),
      priceCurrency: toIsoCurrency(product.currency),
      availability: availabilityUrl(product.availability_status),
    };
  }

  if (
    summary &&
    summary.total > 0 &&
    summary.average !== null &&
    Number.isFinite(summary.average)
  ) {
    base.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: String(summary.average),
      ratingCount: summary.total,
    };
  }

  return base;
}

/**
 * THE serialization invariant: escape '<' so no supplier string can emit
 * '</script>' inside the JSON-LD sink. Used by ProductJsonLd.tsx and pinned
 * by tests/seo-jsonld.test.ts.
 */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
