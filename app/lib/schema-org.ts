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
 * schema.org/BreadcrumbList builder for product pages — PURE, same honesty
 * rules as buildProductJsonLd: every name/URL comes from real DB data, the
 * category level is emitted ONLY when the product actually has one (no
 * invented hierarchy). Four levels for a categorized product (Головна →
 * Каталог → Категорія → Товар), three otherwise. Absolute URLs reuse the
 * same siteUrl basis as buildProductJsonLd (NEXT_PUBLIC_SITE_URL via the
 * page); the category slug is encoded exactly like the visible nav link.
 */
export interface BreadcrumbCategoryLike {
  name: string;
  slug: string;
}

export function buildProductBreadcrumbJsonLd(
  product: { name: string; slug: string },
  category: BreadcrumbCategoryLike | null,
  siteUrl: string
): Record<string, unknown> {
  const base = siteUrl.replace(/\/+$/, '');
  const items: Record<string, unknown>[] = [
    { '@type': 'ListItem', position: 1, name: 'Головна', item: `${base}/` },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'Каталог',
      item: `${base}/catalog`,
    },
  ];
  if (category?.name && category?.slug) {
    items.push({
      '@type': 'ListItem',
      position: items.length + 1,
      name: category.name,
      item: `${base}/catalog?category=${encodeURIComponent(category.slug)}`,
    });
  }
  items.push({
    '@type': 'ListItem',
    position: items.length + 1,
    name: product.name,
    item: `${base}/product/${product.slug}`,
  });
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items,
  };
}

/**
 * schema.org/BreadcrumbList builder for catalog views (category level) —
 * same honesty rules as the product builder. The category level is emitted
 * ONLY when the caller actually resolved a category; both inputs come from
 * data the page already fetched (no extra DB reads). Two levels for the
 * bare catalog, three for a category view.
 */
export function buildCatalogBreadcrumbJsonLd(
  category: BreadcrumbCategoryLike | null,
  siteUrl: string
): Record<string, unknown> {
  const base = siteUrl.replace(/\/+$/, '');
  const items: Record<string, unknown>[] = [
    { '@type': 'ListItem', position: 1, name: 'Головна', item: `${base}/` },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'Каталог',
      item: `${base}/catalog`,
    },
  ];
  if (category?.name && category?.slug) {
    items.push({
      '@type': 'ListItem',
      position: items.length + 1,
      name: category.name,
      item: `${base}/catalog?category=${encodeURIComponent(category.slug)}`,
    });
  }
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items,
  };
}

/**
 * schema.org/FAQPage builder (category FAQ, 2026-09-11) — same honesty
 * rules as the other builders: only caller-supplied Q&A pairs are emitted,
 * trimmed; pairs with an empty question or answer are dropped; an empty
 * set yields null so the component renders no script at all. Serialized
 * through serializeJsonLd by FaqJsonLd.tsx.
 */
export interface FaqItemLike {
  question: string;
  answer: string;
}

export function buildFaqJsonLd(
  questions: FaqItemLike[]
): Record<string, unknown> | null {
  const mainEntity = (Array.isArray(questions) ? questions : [])
    .map((item) => ({
      '@type': 'Question',
      name: typeof item?.question === 'string' ? item.question.trim() : '',
      acceptedAnswer: {
        '@type': 'Answer',
        text: typeof item?.answer === 'string' ? item.answer.trim() : '',
      },
    }))
    .filter((item) => item.name.length > 0 && item.acceptedAnswer.text.length > 0);
  if (mainEntity.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity,
  };
}

/**
 * THE serialization invariant: escape '<' so no supplier string can emit
 * '</script>' inside the JSON-LD sink. Used by ProductJsonLd.tsx and pinned
 * by tests/seo-jsonld.test.ts.
 */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
