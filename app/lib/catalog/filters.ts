//
// Catalog filter contract shared by the listing modules.
//

export type CatalogSort = 'newest' | 'price_asc' | 'price_desc' | 'name_asc';

export interface CatalogFilters {
  categorySlug?: string;
  brandSlug?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  sort?: CatalogSort;
  page?: number;
  /** page size for the catalog grid (server-enforced cap) */
  size?: number;
}

export const CATALOG_PAGE_SIZE = 12;
export const CATALOG_MAX_PAGE_SIZE = 50;
