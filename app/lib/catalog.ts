/**
 * Facade: implementation split into app/lib/catalog/* (2026-09 refactor,
 * behavior-preserving). Every previous public export stays importable from
 * '@/app/lib/catalog' — only the module layout changed, nothing else.
 */
export type {
  Brand,
  CatalogCardImage,
  CatalogCardProduct,
  Category,
  Product,
  ProductImage,
  ProductVariant,
} from './catalog/shared.ts';
export {
  CATALOG_DICTIONARY_TTL_SECONDS,
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  WALLPAPER_SKU_PREFIX,
  cachePublicRead,
} from './catalog/shared.ts';
export type { FuzzyFallbackPlan, SearchRankable } from './catalog/search.ts';
export {
  FALLBACK_FUZZY_URL_BUDGET_BYTES,
  FALLBACK_MAX_RETRIES,
  FALLBACK_MIN_TOKEN_LEN,
  SEARCH_RANK_SCAN_LIMIT,
  buildFuzzyFallbackPlan,
  buildSearchConditions,
  fuzzyTokenVariants,
  identifyAppliedSearch,
  mapKeyboardLayout,
  rankSearchResults,
  recoverWildcardDisplay,
  relaxSearchTerm,
  sanitizeSearchTerm,
  searchRelevanceScore,
} from './catalog/search.ts';
export type { CatalogFilters, CatalogSort } from './catalog/filters.ts';
export { CATALOG_PAGE_SIZE } from './catalog/filters.ts';
export { fetchBrandBySlug, fetchCategoryBySlug } from './catalog/slug-lookup.ts';
export { fetchBrandProductCount, fetchCategoryProductCount } from './catalog/counts.ts';
export type { CatalogPage } from './catalog/listing.ts';
export { fetchCatalogProducts } from './catalog/listing.ts';
export type { WallpaperPage } from './catalog/wallpaper-listing.ts';
export { fetchWallpaperProducts } from './catalog/wallpaper-listing.ts';
export type { ProductReview, ReviewsPageData, ReviewSummary } from './catalog/reviews.ts';
export {
  REVIEWS_PAGE_SIZE,
  fetchPublishedReviews,
  fetchReviewSummary,
} from './catalog/reviews.ts';
export {
  POPULAR_LIMIT,
  SELECTED_LIMIT,
  fetchFeaturedProducts,
  fetchPopularProducts,
  fetchSelectedProducts,
} from './catalog/shelves.ts';
export { fetchActiveBrands, fetchActiveCategories } from './catalog/categories.ts';
export { fetchProductBySlug } from './catalog/product-card.ts';
export { RELATED_LIMIT, collectRelated, fetchRelatedProducts } from './catalog/related.ts';
export {
  GLUE_CATEGORY_SLUG,
  GLUE_CROSS_SELL_LIMIT,
  fetchGlueCrossSell,
} from './catalog/glues.ts';
