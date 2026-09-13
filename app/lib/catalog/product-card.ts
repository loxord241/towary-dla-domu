//
// PDP read: active product by slug with category/brand/images/variants.
//

import { cachePublicRead, CATALOG_PUBLIC_READ_TTL_SECONDS, normalizeProduct, PRODUCT_SELECT, supabase } from './shared.ts';
import type { Product, ProductJoinedRow } from './shared.ts';

/**
 * Find an active product by slug with category, brand, images and variants.
 * Main image is derived from product_images.is_main (there is no
 * products.main_image column in the schema).
 * Returns null when no active product matches the slug.
 * Caching step 2 (2026-08-31): 60s Data Cache keyed by slug — the PDP read
 * is public and identical for every visitor. Failed reads stay uncached.
 */
export async function fetchProductBySlug(slug: string): Promise<Product | null> {
  return fetchProductBySlugStore(slug);
}

const fetchProductBySlugStore = cachePublicRead(
  'catalog:product-slug',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  async (slug: string): Promise<Product | null> => {
    const { data, error } = await supabase
      .from('products')
      .select(PRODUCT_SELECT)
      .eq('slug', slug)
      .eq('is_active', true)
      .returns<ProductJoinedRow[]>()
      .maybeSingle();

    if (error) {
      // A data error is not a missing product: rethrow so the route renders
      // the error boundary instead of a misleading 404.
      throw new Error(`Failed to load product by slug "${slug}": ${error.message}`);
    }

    if (!data) return null;

    return normalizeProduct(data);
  }
);
