//
// Paged full-row product feed (PRODUCT_SELECT) behind the home shelves.
//

import { LINOLEUM_SKU_LIKE, normalizeProduct, PRODUCT_SELECT, supabase, WALLPAPER_SKU_LIKE } from './shared.ts';
import type { Product, ProductJoinedRow } from './shared.ts';

export async function fetchProducts(options: {
  featuredOnly?: boolean;
  selectedOnly?: boolean;
}): Promise<Product[]> {
  // Full read via paged windows: PostgREST caps ANY single response at
  // 1000 rows, so the previous unbounded select would silently truncate
  // the set once featured/active products exceed that cap. The home page
  // renders the WHOLE returned array — the contract is "all of them".
  // The query chain is rebuilt INSIDE the loop: supabase-js builders
  // accumulate repeated .order() calls (url searchParams append), so a
  // shared builder corrupts ordering on page 2+. `id desc` is a
  // deterministic tiebreaker for bulk-imported rows sharing created_at.
  const products: Product[] = [];
  let from = 0;
  for (;;) {
    const PAGE = 1000; // PostgREST max_rows cap per response
    let query = supabase
      .from('products')
      .select(PRODUCT_SELECT)
      .eq('is_active', true)
      // Home shelves never surface the wallpaper domain (owner task
      // 2026-09-10): wc-* products render on /oboi only. The linoleum
      // domain (ln-*, owner plan 2026-09-17) is excluded the same way.
      .not('sku', 'like', WALLPAPER_SKU_LIKE)
      .not('sku', 'like', LINOLEUM_SKU_LIKE);
    if (options.featuredOnly) {
      query = query.eq('is_featured', true);
    }
    if (options.selectedOnly) {
      query = query.eq('is_selected', true);
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1)
      .returns<ProductJoinedRow[]>();

    if (error) {
      // Never serve a partial set as if it were complete — and never serve
      // an empty set as if the catalog were empty: a data error must reach
      // app/error.tsx (honest failure), not masquerade as "no products".
      throw new Error(`Failed to load products: ${error.message}`);
    }

    const rows = data ?? [];
    products.push(...rows.map(normalizeProduct));
    if (rows.length < PAGE) return products;
    from += PAGE;
  }
}
