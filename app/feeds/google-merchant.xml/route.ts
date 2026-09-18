import { createClient } from '@supabase/supabase-js';
import { fetchActiveCategories } from '@/app/lib/catalog';
import { LINOLEUM_SKU_LIKE } from '@/app/lib/domains';
import { collectPaged } from '@/app/lib/seo-sitemap';
import { getPublicImageUrl } from '@/app/lib/supabase-storage';
import {
  buildMerchantItems,
  buildMerchantFeedXml,
  pickCategoryPath,
  GOOGLE_FEED_MAX_ITEMS,
  type MerchantFeedProductRow,
} from '@/app/lib/merchant-feed';

/**
 * Google Merchant Center product feed (free listings) — public URL for the
 * scheduled fetch configured MANUALLY in Merchant Center (the feed is not
 * registered in any Google API and is deliberately NOT listed in the
 * sitemap; data on it is already public on the storefront).
 *
 * Single-file decision: feeds fetched by URL accept up to 50 000 items per
 * XML file, so the whole catalog ships as ONE document (see the file-limit
 * decision in app/lib/merchant-feed.ts). Eligibility and the honesty rules
 * live in the pure builder app/lib/merchant-feed.ts (_du aliases are dropped
 * THERE, unit-testably) — this route only owns data access, mirroring
 * app/sitemap.ts:
 *   - anonymous Supabase client, RLS decides visibility, service key never
 *     appears here;
 *   - same eligibility join as the sitemap/storefront: is_active=true +
 *     ≥1 photo via product_images!inner;
 *   - data-level exclusion (owner decision 2026-09-18): linoleum
 *     (sku ln-*, cut-to-length roll goods priced грн/пог.м vs the landing
 *     page «від X грн/м²») is filtered SQL-side via .not like
 *     LINOLEUM_SKU_LIKE — see the query below; wallpapers (wc-*) stay in;
 *   - bounded 1000-row windows with deterministic .order('id') via
 *     collectPaged (PostgREST caps responses at 1000 rows).
 *
 * ISR window of 1 hour (revalidate 3600): availability refreshes hourly —
 * tighter than the sitemap's daily window because stock status is the field
 * Google acts on. The importer runs every 6 h, so an hour of staleness
 * never contradicts the landing page longer than the data itself does.
 *
 * Failure contract (same spirit as the sitemap): a failed product read
 * degrades to an EMPTY feed with an explanatory XML comment and a 200 —
 * never a raw 500. Google re-fetches on its schedule; an empty file is
 * recoverable, a broken one is not. Categories failing to read only drop
 * g:product_type, items still ship.
 */
export const revalidate = 3600;

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000')
  .replace(/\/+$/, '');

/**
 * Resolves to null ONLY on a read failure (empty-feed degraded mode); an
 * empty list means the catalog genuinely has no eligible products.
 */
async function fetchFeedProductRows(): Promise<MerchantFeedProductRow[] | null> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Categories are read separately (dictionary read, not per-product) so the
  // g:product_type path comes from the same active-category tree the
  // storefront navigation shows. Failure only drops the optional field.
  let categories: Awaited<ReturnType<typeof fetchActiveCategories>> = [];
  try {
    categories = await fetchActiveCategories();
  } catch {
    categories = [];
  }

  try {
    return await collectPaged(async (from, limit) => {
      const { data, error } = await supabase
        .from('products')
        .select(
          'id, slug, name, price, currency, availability_status, description, short_description, ' +
            'brand:brands(name), ' +
            'images:product_images!inner(id, image_url, is_main, sort_order), ' +
            'pc:product_categories(category_id)'
        )
        .eq('is_active', true)
        // Owner decision 2026-09-18: linoleum (ln-*) is cut-to-length roll
        // goods — the feed price is грн/пог.м while the landing page shows
        // «від X грн/м²», and Google cross-checks feed against the landing
        // page, so ln-* must never enter Merchant listings (same SQL-side
        // pattern as the catalog lists). Wallpapers (wc-*) stay in the feed
        // intentionally: unit-priced, no landing-page mismatch.
        .not('sku', 'like', LINOLEUM_SKU_LIKE)
        .order('id', { ascending: true })
        .range(from, from + limit - 1);
      if (error) throw new Error(error.message);
      // The select string is assembled from parts, so supabase-js cannot
      // infer the row shape statically — the projection is pinned explicitly.
      const rows = (data ?? []) as unknown as {
        id: string;
        slug: string;
        name: string;
        price: number;
        currency: string | null;
        availability_status: string;
        description: string | null;
        short_description: string | null;
        brand: { name: string } | null;
        images: {
          image_url: string;
          is_main: boolean | null;
          sort_order: number | null;
        }[] | null;
        pc: { category_id: string }[] | null;
      }[];
      return rows.map((row): MerchantFeedProductRow => {
        const images = row.images ?? [];
        // Main image first, then the lowest sort_order — the same pick the
        // product card makes, so the feed shows the image Google sees on
        // the landing page.
        const main =
          images.find((img) => img.is_main) ??
          [...images].sort(
            (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
          )[0];
        // g:additional_image_link: every gallery image EXCEPT the picked
        // main (subtracted by reference), gallery order kept, absolutized by
        // getPublicImageUrl (hotlinks pass through). The http(s) filter and
        // the 10-element cap live in the pure builder.
        const additional = images
          .filter((img) => img !== main)
          .map((img) => getPublicImageUrl(img.image_url))
          .filter((url): url is string => url !== null);
        const categoryIds = (row.pc ?? [])
          .map((pc) => pc.category_id)
          .filter((id): id is string => typeof id === 'string');
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          price: row.price,
          currency: row.currency ?? null,
          availability_status: row.availability_status,
          description: row.description ?? null,
          short_description: row.short_description ?? null,
          brand_name: row.brand?.name ?? null,
          image_url: main ? getPublicImageUrl(main.image_url) : null,
          additional_image_urls: additional,
          category_path: pickCategoryPath(categoryIds, categories),
        };
      });
    });
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  const rows = await fetchFeedProductRows();
  const degraded = rows === null;
  const items = buildMerchantItems(rows ?? [], SITE_URL);
  const truncated = items.length >= GOOGLE_FEED_MAX_ITEMS;

  const notes: string[] = [
    `Google Merchant Center feed; items: ${items.length}`,
  ];
  if (degraded) notes.push('product read failed: feed served empty, will self-heal on next revalidation');
  if (truncated) notes.push('catalog exceeded the 50000-item scheduled-fetch cap: excess items dropped');

  const xml = buildMerchantFeedXml(items, {
    channelTitle: 'Towary dla domu — product feed',
    comment: notes.join('; '),
  });

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
