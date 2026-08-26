# Graph Report - my-shop  (2026-08-26)

## Corpus Check
- 265 files · ~310,085 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1681 nodes · 2731 edges · 151 communities (117 shown, 34 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 21 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5cc49268`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- category-tree.ts
- devDependencies
- tmp-audit-readonly.ts
- admin-list.ts
- requireAdminApi
- yugcontract-content-dry-run.ts
- yugcontract-verify.ts
- compilerOptions
- content-import.ts
- Проект my-shop - Техническая документация
- import-plan.ts
- yugcontract/types.ts
- catalog/page.tsx
- yugcontract-content-images.ts
- catalog.ts
- InfoPage.tsx
- tmp-postverify-content.ts
- [orderNumber]/page.tsx
- products/page.tsx
- import-run.ts
- (dashboard)/categories/page.tsx
- File Structure (deliverable map)
- [slug]/page.tsx
- cart-context.tsx
- tmp-verify-stage.ts
- enforceRateLimit
- client.ts
- content-images.ts
- admin-api.ts
- final_001_initial_schema.sql
- content-dry-run.ts
- dry-run.ts
- Global Constraints
- tmp-f6-db-audit.ts
- admin-junction-search.test.ts
- admin-search-pagination.test.ts
- products/route.ts
- FeedbackModal.tsx
- cart/page.tsx
- icons.tsx
- yugcontract-content-fetch.ts
- normalize.ts
- Решения (согласованы)
- tmp-postverify-images.ts
- yugcontract-rrp-apply.ts
- yugcontract-rrp-dry-run.ts
- CatalogFilters.tsx
- orders/page.tsx
- ReviewFormModal.tsx
- tmp-verify-011.ts
- fetchActiveCategories
- content-staging.ts
- [imageId]/route.ts
- yugcontract/categories/route.ts
- preview/route.ts
- ProductCard.tsx
- favorites-context.tsx
- runProductsBatch
- selection.ts
- E-Commerce Database Schema
- Global Constraints
- @supabase/supabase-js
- 005_admin_role_system.sql
- admin/orders/route.ts
- seo.ts
- lib/types.ts
- yugcontract-content-apply.ts
- splitProductWrites
- Global Constraints
- yugcontract-import-run.ts
- (home)/page.tsx
- getAuthToken
- Priority 2 UX/UI: Mobile Catalog + Product Page — дизайн (2026-08-26)
- pagination-hardening.test.ts
- tmp-verify-f6.ts
- public.product_reviews
- 011_content_import.sql
- Global Constraints
- favorites/page.tsx
- tmp-audit-orders-rls.mts
- tmp-sentinel.ts
- tmp-verify-admin-search-live.ts
- tmp-verify-rrp.ts
- yugcontract-dry-run.ts
- feedback/page.tsx
- tmp-probe-admin-search.ts
- tmp-probe-search-grammar.ts
- (dashboard)/layout.tsx
- README.md
- tmp-f6-premigration.ts
- tmp-slugs.ts
- tmp-verify-015-reviews.mts
- tmp-verify-orders-revoke.mts
- yugcontract-client.test.ts
- login/page.tsx
- opencode.json
- proxy.ts
- yugcontract-categories-preview.ts
- category-select.test.ts
- mobile-filter-drawer.test.ts
- storefront-icons.test.ts
- yugcontract-runtime.test.ts
- This is NOT the Next.js you know
- cart/layout.tsx
- checkout/layout.tsx
- favorites/layout.tsx
- orders/layout.tsx
- robots.ts
- graphify.js
- dev-restart.sh
- tmp-verify-009.ts
- admin-feedback.test.ts
- catalog-errors.test.ts
- discount-ui.test.ts
- nav-drawer.test.ts
- order-security.test.ts
- orders-revoke-migration.test.ts
- popular-products.test.ts
- reviews-security.test.ts
- storefront-visibility.test.ts
- ux-fixes.test.ts
- yugcontract-categories.test.ts
- eslint.config.mjs
- next.config.ts
- postcss.config.mjs
- h1-invariants.test.ts
- migration-016-invariants.test.ts
- api/orders/route.ts
- 010_yugcontract_import_infra.sql
- 013_feedback.sql

## God Nodes (most connected - your core abstractions)
1. `requireAdminApi()` - 59 edges
2. `isUuid()` - 35 edges
3. `Проект my-shop - Техническая документация` - 27 edges
4. `dbErrorResponse()` - 26 edges
5. `enforceRateLimit()` - 23 edges
6. `strOrNull()` - 22 edges
7. `compilerOptions` - 17 edges
8. `File Structure (deliverable map)` - 17 edges
9. `numOrNull()` - 16 edges
10. `Global Constraints` - 14 edges

## Surprising Connections (you probably didn't know these)
- `runPlanPreview()` --calls--> `matchContentGoodsToProducts()`  [EXTRACTED]
  scripts/yugcontract-content-fetch.ts → app/lib/yugcontract/content-dry-run.ts
- `runPlanPreview()` --calls--> `buildDescriptionStats()`  [EXTRACTED]
  scripts/yugcontract-content-fetch.ts → app/lib/yugcontract/content-dry-run.ts
- `runPlanPreview()` --calls--> `buildParamsStats()`  [EXTRACTED]
  scripts/yugcontract-content-fetch.ts → app/lib/yugcontract/content-dry-run.ts
- `externalExisting` --calls--> `isExternalImportedImage()`  [EXTRACTED]
  scripts/yugcontract-content-images.ts → app/lib/yugcontract/content-images.ts
- `manualImages` --calls--> `isExternalImportedImage()`  [EXTRACTED]
  scripts/yugcontract-content-images.ts → app/lib/yugcontract/content-images.ts

## Import Cycles
- None detected.

## Communities (151 total, 34 thin omitted)

### Community 0 - "category-tree.ts"
Cohesion: 0.24
Nodes (12): AdminCategoryMultiSelect(), CategorySelect(), Category, buildCategoryOptions(), CategoryOption, collectSubtreeIds(), compareCategories(), compareSiblings() (+4 more)

### Community 1 - "devDependencies"
Cohesion: 0.04
Nodes (44): eslint, eslint-config-next, next, dependencies, next, react, react-dom, sanitize-html (+36 more)

### Community 2 - "tmp-audit-readonly.ts"
Cohesion: 0.05
Nodes (36): anonClient, client, dangerCounts, dangerPatterns, dangerSamples, diffSamples, external, imagesByProduct (+28 more)

### Community 3 - "admin-list.ts"
Cohesion: 0.11
Nodes (31): GET(), GET(), ADMIN_LIST_DEFAULT_PAGE_SIZE, ADMIN_LIST_MAX_PAGE_SIZE, AdminListParams, BRAND_FIELDS_LIST, BRAND_SORT_KEYS, BRAND_SORTS (+23 more)

### Community 4 - "requireAdminApi"
Cohesion: 0.14
Nodes (20): DELETE(), PUT(), POST(), SiblingRow, DELETE(), DELETE(), GET(), POST() (+12 more)

### Community 5 - "yugcontract-content-dry-run.ts"
Cohesion: 0.07
Nodes (23): count(), env, seen, client, deduped, descAll, descMatched, fmtInt() (+15 more)

### Community 6 - "yugcontract-verify.ts"
Cohesion: 0.07
Nodes (25): availBad, availViolations, byUuid, check(), childlessParents, client, CountResult, { data: manual } (+17 more)

### Community 7 - "compilerOptions"
Cohesion: 0.07
Nodes (29): dom, dom.iterable, esnext, **/*.mts, .next/dev/types/**/*.ts, next-env.d.ts, .next/types/**/*.ts, node_modules (+21 more)

### Community 8 - "content-import.ts"
Cohesion: 0.14
Nodes (23): assertImageUpdateFields(), assertContentFields(), claimNextContentBatch(), CONTENT_BATCH_SIZE, CONTENT_STALE_RUNNING_MS, ContentBatchOutcome, ContentBatchRow, ContentPlan (+15 more)

### Community 9 - "Проект my-shop - Техническая документация"
Cohesion: 0.07
Nodes (27): Checkout / Orders (миграции 006–008), Архитектура Supabase, Важные правила для будущих изменений, Известные ограничения (осознанные), Интеграция Yugcontract (этап 1: read-only preview, 2026-08), Интеграция Yugcontract (этап 2: импорт выбранного ассортимента, 2026-08), Правила безопасности (не нарушать), Проект my-shop - Техническая документация (+19 more)

### Community 10 - "import-plan.ts"
Cohesion: 0.13
Nodes (22): bareKey(), BrandPlan, buildBrandPlan(), buildCategoryPlan(), CategoryCreateOp, CategoryPlan, CategoryUpdateOp, depthsInSelection() (+14 more)

### Community 11 - "yugcontract/types.ts"
Cohesion: 0.13
Nodes (15): CategoriesResponse, YugcontractCategoriesPage(), PreviewResponse, YugcontractAdminPage(), FieldTypeHistogram, FieldTypeName, YcBrandSample, YcCategoryNode (+7 more)

### Community 12 - "catalog/page.tsx"
Cohesion: 0.16
Nodes (18): ActiveChip, buildActiveChips(), catalogHeading(), CatalogPage(), catalogPageUrl(), firstParam(), generateMetadata(), parseCatalogSearchParams() (+10 more)

### Community 13 - "yugcontract-content-images.ts"
Cohesion: 0.09
Nodes (21): anomalies, batches, brokenMains, client, crossProductDups, dbIdByYc, dupUrlCounts, existingImages (+13 more)

### Community 14 - "catalog.ts"
Cohesion: 0.12
Nodes (18): buildSearchConditions(), CATALOG_PAGE_SIZE, CatalogPage, CatalogSort, collectRelated(), fetchCatalogProducts(), fetchProductBySlug(), fetchRelatedStage() (+10 more)

### Community 15 - "InfoPage.tsx"
Cohesion: 0.12
Nodes (8): metadata, InfoPage(), InfoPageProps, metadata, metadata, metadata, metadata, metadata

### Community 16 - "tmp-postverify-content.ts"
Cohesion: 0.12
Nodes (19): byStatus, byYc, check(), client, DANGER, emptyDesc, hasDupConflict(), manual (+11 more)

### Community 17 - "[orderNumber]/page.tsx"
Cohesion: 0.13
Nodes (15): CheckoutSuccessPage(), ItemRow, OrderRow, SearchParams, supabase, ItemRow, OrderDetails, OrderDetailsCard() (+7 more)

### Community 18 - "products/page.tsx"
Cohesion: 0.13
Nodes (16): AVAILABILITY_OPTIONS, draftFromVariant(), EMPTY_FORM, fetchBrandList(), fetchCategoryList(), fetchFeaturedCount(), fetchProductList(), PRODUCT_SORT_KEYS (+8 more)

### Community 19 - "import-run.ts"
Cohesion: 0.17
Nodes (17): maxDuration, POST(), maxDuration, POST(), BatchCounters, BatchOutcome, claimNextBatch(), ensureRun() (+9 more)

### Community 20 - "(dashboard)/categories/page.tsx"
Cohesion: 0.17
Nodes (16): BRAND_SORT_KEYS, BrandsAdminPage(), fetchBrandList(), SORT_OPTIONS, totalPagesFor(), CategoriesAdminPage(), CATEGORY_SORT_KEYS, fetchAllCategoriesForPicker() (+8 more)

### Community 21 - "File Structure (deliverable map)"
Cohesion: 0.10
Nodes (19): File Structure (deliverable map), Global Constraints, Storefront Features: Reviews / Recently Viewed / Popular Products — Implementation Plan, Task 10: Recently-viewed pure storage module, Task 11: Tracker + shelf components, page wiring, Task 12: Featured-limit pure module, Task 13: Storefront popular query — featured-only + homepage hides empty, Task 14: Admin API enforcement (PUT/POST + featured-count) (+11 more)

### Community 22 - "[slug]/page.tsx"
Cohesion: 0.05
Nodes (47): AddToCartButton(), AddToCartButtonProps, VariantOption, ProductDescription(), GalleryImage, ProductGallery(), ProductJsonLd(), dateFormatter (+39 more)

### Community 23 - "cart-context.tsx"
Cohesion: 0.18
Nodes (18): geistMono, geistSans, metadata, CartAction, CartContext, CartContextValue, CartProvider(), CartState (+10 more)

### Community 24 - "tmp-verify-stage.ts"
Cohesion: 0.12
Nodes (17): byYc, client, DANGER, dangerSamples, descPairs, descStats, headCount(), ids (+9 more)

### Community 25 - "enforceRateLimit"
Cohesion: 0.16
Nodes (15): CheckpointRow, GET(), POST(), supabase, PreviewRequestItem, buckets, checkRateLimit(), clientIpOf() (+7 more)

### Community 26 - "client.ts"
Cohesion: 0.17
Nodes (16): CachedAuthToken, categoriesUrl(), contentUrl(), FetchLike, getContentGoods(), getContentGoodsWithMeta(), GetContentResultWithMeta, getPriceCatalogWithMeta() (+8 more)

### Community 27 - "content-images.ts"
Cohesion: 0.13
Nodes (12): IMAGE_UPDATE_FIELDS, ImageInsertOp, ImagePlan, ImagePlanInputProduct, ImageUpdateOp, isExternalImportedImage(), planImageOps(), ProductImageRow (+4 more)

### Community 28 - "admin-api.ts"
Cohesion: 0.25
Nodes (17): POST(), PUT(), POST(), ALLOWED_MIME, detectImageMime(), GET(), POST(), sanitizeFileName() (+9 more)

### Community 29 - "final_001_initial_schema.sql"
Cohesion: 0.07
Nodes (38): case, public.place_order(), update_updated_at_column, update_orders_updated_at, public.admin_cancel_order(), public.admin_set_order_status(), public.expire_pending_orders(), product_categories (+30 more)

### Community 30 - "content-dry-run.ts"
Cohesion: 0.16
Nodes (12): buildImagesStats(), coerceParams(), coercePictures(), ContentIssue, DedupeResult, DescriptionStats, ImagesStats, MatchResult (+4 more)

### Community 31 - "dry-run.ts"
Cohesion: 0.16
Nodes (11): computeDryRunReport(), DryRunBatchMeta, DryRunDbSnapshot, DryRunReport, makeCategoryFilter(), normalizeKey(), YcProductMerger, asNumberOrNull() (+3 more)

### Community 32 - "Global Constraints"
Cohesion: 0.12
Nodes (16): Global Constraints, Product Categories M2M + Category Tree UI Implementation Plan, Self-Review (done), Task 10: AdminCategoryMultiSelect + wiring в форму товара, Task 11: Storefront CategorySelect — раскрывающееся дерево, Task 12: PRODUCTION GATE — migration apply → backfill → verification, Task 13: Финальная верификация, Task 1: Migration 016 + static-invariant test (+8 more)

### Community 33 - "tmp-f6-db-audit.ts"
Cohesion: 0.12
Nodes (15): c, counts, dups, ext, extUrls, hist, mainCnt, man (+7 more)

### Community 34 - "admin-junction-search.test.ts"
Cohesion: 0.15
Nodes (16): C_B_1, C_B_2, C_O_LEAF, C_ROOT_B, C_ROOT_O, categories, evalPredicate(), product() (+8 more)

### Community 35 - "admin-search-pagination.test.ts"
Cohesion: 0.18
Nodes (14): compareRows(), evalOr(), evalPredicate(), FakeDataset, LoggedRequest, makeDataset(), pad(), parseOrder() (+6 more)

### Community 36 - "products/route.ts"
Cohesion: 0.20
Nodes (17): ALLOWED_AVAILABILITY, isValidCurrency(), PUT(), fetchAllJoined(), GET(), POST(), parseCategoryIds(), listAdminProducts() (+9 more)

### Community 37 - "FeedbackModal.tsx"
Cohesion: 0.17
Nodes (11): POST(), serviceClient(), ErrorKind, FeedbackModal(), Status, FEEDBACK_DAILY_CAP, FEEDBACK_MAX_LENGTH, FEEDBACK_MIN_LENGTH (+3 more)

### Community 38 - "cart/page.tsx"
Cohesion: 0.15
Nodes (15): availabilityLabel(), CartPage(), CheckoutForm(), SubmitResult, metadata, EmptyState(), SiteHeader(), useCart() (+7 more)

### Community 39 - "icons.tsx"
Cohesion: 0.14
Nodes (20): CartBadge(), FavoritesBadge(), base(), BoxIcon(), CartIcon(), ChevronDownIcon(), ChevronRightIcon(), FilterIcon() (+12 more)

### Community 40 - "yugcontract-content-fetch.ts"
Cohesion: 0.12
Nodes (16): buildDescriptionStats(), buildParamsStats(), matchContentGoodsToProducts(), OurProductRow, ContentProductRow, planContentBatches(), client, deduped (+8 more)

### Community 41 - "normalize.ts"
Cohesion: 0.15
Nodes (12): brandKeys(), buildCrossAnalysis(), CATEGORY_ID_KEYS, CATEGORY_NAME_KEYS, CATEGORY_PARENT_KEYS, HISTOGRAM_FIELDS, normalizeName(), OurBrandRow (+4 more)

### Community 42 - "Решения (согласованы)"
Cohesion: 0.12
Nodes (15): A. Семантика невалидного category/brand slug → 200 empty-state, B. Canonical/noindex политика (pure-функции app/lib/seo.ts), C. Sitemap: static + категории + бренды + товары, D. robots.ts, E. noindex технических маршрутов, F. Structured data: Product JSON-LD, G. Metadata-полировка, H. H1-invariants (+7 more)

### Community 43 - "tmp-postverify-images.ts"
Cohesion: 0.13
Nodes (11): byProduct, byStatus, client, external, img, manual, orderKey(), prodByYc (+3 more)

### Community 44 - "yugcontract-rrp-apply.ts"
Cohesion: 0.13
Nodes (14): applyOne(), CONFIRMED, DbRow, dbRows, failedSkus, feed, feedById, FeedRow (+6 more)

### Community 45 - "yugcontract-rrp-dry-run.ts"
Cohesion: 0.12
Nodes (13): changedRrps, DbRow, dbRows, examples, feed, feedById, FeedRow, noRrpExamples (+5 more)

### Community 46 - "CatalogFilters.tsx"
Cohesion: 0.29
Nodes (6): CatalogFilters(), buildFilterSearchParams(), buildFilterUrl(), FilterDraft, PRESERVED_KEYS, setIfPresent()

### Community 47 - "orders/page.tsx"
Cohesion: 0.18
Nodes (13): ALLOWED_TRANSITIONS, fetchOrderDetailsApi(), fetchOrdersApi(), formatDate(), ItemRow, OrderDetails, OrderListRow, OrdersAdminPage() (+5 more)

### Community 48 - "ReviewFormModal.tsx"
Cohesion: 0.25
Nodes (11): POST(), serviceClient(), ErrorKind, Status, cleanUserString(), REVIEW_DAILY_CAP, REVIEW_MAX_LENGTH, REVIEW_MIN_LENGTH (+3 more)

### Community 49 - "tmp-verify-011.ts"
Cohesion: 0.14
Nodes (8): anon, EXPECTED_YC_CONTENT_BATCHES, EXPECTED_YC_CONTENT_GOODS, EXPECTED_YC_IMPORT_BATCHES, OasDefinition, OasProperty, root, service

### Community 50 - "fetchActiveCategories"
Cohesion: 0.27
Nodes (9): GET(), revalidate, fetchActiveBrands(), fetchActiveCategories(), collectPaged(), dynamic, fetchEligibleProducts(), sitemap() (+1 more)

### Community 51 - "content-staging.ts"
Cohesion: 0.18
Nodes (11): YcContentGood, YcContentParam, ALLOWED_TAGS, sanitizeYcDescription(), ALLOWED_IMAGE_EXTENSIONS, buildSpecificationJson(), ImageUrlCheck, reduceGoodsToStagedRows() (+3 more)

### Community 52 - "[imageId]/route.ts"
Cohesion: 0.21
Nodes (9): DELETE(), PUT(), DELETE(), toStoragePath(), MainPromotionStep, planMainPromotion(), storagePathFromImageUrl(), root (+1 more)

### Community 53 - "yugcontract/categories/route.ts"
Cohesion: 0.32
Nodes (11): GET(), maxDuration, getCategoriesCatalog(), loadOnce(), buildCategoryTree(), deepScanForCategoryArray(), detectCategoryFields(), extractCategoryRows() (+3 more)

### Community 54 - "preview/route.ts"
Cohesion: 0.26
Nodes (10): errorResponse(), fetchAllRows(), GET(), maxDuration, getPriceCatalog(), YugcontractError, buildFieldTypeHistogram(), buildPreviewStats() (+2 more)

### Community 55 - "ProductCard.tsx"
Cohesion: 0.25
Nodes (7): FavoriteButton(), availabilityLabel(), ProductCard(), ProductCardData, formatPrice(), fracFormat, intFormat

### Community 56 - "favorites-context.tsx"
Cohesion: 0.27
Nodes (8): FavoritesContext, FavoritesContextValue, FavoritesProvider(), FavoritesState, loadStoredFavorites(), FAVORITES_STORAGE_KEY, MAX_FAVORITES, sanitizeStoredFavorites()

### Community 57 - "runProductsBatch"
Cohesion: 0.27
Nodes (9): applyCategoryPlan(), buildFullPlan(), chunk(), finishBatch(), ImportDeps, insertChunked(), normalizeKeyOf(), runCategoriesBatch() (+1 more)

### Community 58 - "selection.ts"
Cohesion: 0.17
Nodes (7): collectExpandedIds(), ExpandableNode, ExpansionResult, flattenSelectedIds(), SELECTED_CATEGORIES, YcSelectedCategory, EXISTING_ROW

### Community 59 - "E-Commerce Database Schema"
Cohesion: 0.17
Nodes (11): Core Entities, Customer & Order Management, Database Design Principles, E-Commerce Database Schema, Future Considerations, Key Features, Multi-language Support, RLS Policy Details (+3 more)

### Community 60 - "Global Constraints"
Cohesion: 0.17
Nodes (11): Global Constraints, SEO Package Implementation Plan, Task 1: `app/lib/seo.ts` — indexability policy + metadata builders (pure), Task 2: Home page unique metadata, Task 3: Catalog `generateMetadata` rewired through the policy layer, Task 4: robots.ts — block /cart and /favorites, Task 5: noindex technical routes (layouts + checkout/admin metadata), Task 6: Product JSON-LD structured data (+3 more)

### Community 61 - "@supabase/supabase-js"
Cohesion: 0.17
Nodes (8): anon, cases, root, client, out, root, client, root

### Community 62 - "005_admin_role_system.sql"
Cohesion: 0.33
Nodes (5): auth.identities, admin_users, is_current_user_admin(), update_updated_at_column, update_admin_users_updated_at

### Community 63 - "admin/orders/route.ts"
Cohesion: 0.67
Nodes (3): GET(), sanitizeSearchTerm(), STATUSES

### Community 64 - "seo.ts"
Cohesion: 0.31
Nodes (9): buildCatalogViewMetadata(), CatalogIndexInput, CatalogViewMetadataArgs, decideCatalogIndexing(), IndexingDecision, SITE_NAME, truncateQuery(), ViewMetadata (+1 more)

### Community 65 - "lib/types.ts"
Cohesion: 0.20
Nodes (9): Brand, Category, MainProductImageUrlFunction, Product, ProductImage, ProductImageUrlsFunction, ProductVariant, PublicImageUrlFunction (+1 more)

### Community 66 - "yugcontract-content-apply.ts"
Cohesion: 0.20
Nodes (8): StagedContentRow, batches, client, root, runIdx, stagedIds, t0, totals

### Community 67 - "splitProductWrites"
Cohesion: 0.24
Nodes (4): ExistingProductRow, MappedProductRow, splitProductWrites(), MappedProductRowHolder

### Community 68 - "Global Constraints"
Cohesion: 0.20
Nodes (9): Global Constraints, P3 UX Fixes Implementation Plan (2026-08-26), Self-review, Task 1: formatPrice uk-UA formatting + all surfaces (P3-R1), Task 2: RecentlyViewed container (P3-N1), Task 3: Category cards (P3-R3), Task 4: Pagination disabled semantics (P3-R2), Task 5: Grid breakpoints (P3-N2) (+1 more)

### Community 69 - "yugcontract-import-run.ts"
Cohesion: 0.20
Nodes (9): allConflicts, client, deps, execDeps, planned, resumeIdx, root, t0 (+1 more)

### Community 70 - "(home)/page.tsx"
Cohesion: 0.19
Nodes (12): ImageRow(), RelatedProducts(), Home(), metadata, revalidate, fetchFeaturedProducts(), fetchPopularProducts(), fetchProducts() (+4 more)

### Community 71 - "getAuthToken"
Cohesion: 0.22
Nodes (6): authUrl(), getAuthToken(), parseJsonResponse(), readCredentials(), signHs256Jwt(), PAYLOAD

### Community 72 - "Priority 2 UX/UI: Mobile Catalog + Product Page — дизайн (2026-08-26)"
Cohesion: 0.22
Nodes (8): A. «Схожі товари» (related products), B. Delivery-CTA на странице товара, C. LCP карточек каталога/главной, D. Инварианты и тесты, Priority 2 UX/UI: Mobile Catalog + Product Page — дизайн (2026-08-26), Верификация, Границы, Область

### Community 73 - "pagination-hardening.test.ts"
Cohesion: 0.22
Nodes (3): MockState, ORDER_EXEMPT, root

### Community 74 - "tmp-verify-f6.ts"
Cohesion: 0.22
Nodes (5): c, dupErr, mainCnt, man, pairs

### Community 75 - "public.product_reviews"
Cohesion: 0.50
Nodes (3): public.product_reviews, public, public.products

### Community 77 - "Global Constraints"
Cohesion: 0.25
Nodes (7): Global Constraints, Priority 2 UX/UI: Mobile Catalog + Product Page Implementation Plan, Task 1: Related-products data layer (`RELATED_LIMIT`, `collectRelated`, `fetchRelatedProducts`), Task 2: `RelatedProducts` component + product-page wiring, Task 3: Delivery CTA on the product page, Task 4: LCP priority for first-row cards (ProductCard + home/catalog wiring), Task 5: Full verification gates + live SSR + docs

### Community 78 - "favorites/page.tsx"
Cohesion: 0.31
Nodes (7): RemoveFavoriteButton(), CONTACT_EMAIL, INFO_LINKS, SiteFooter(), SiteFooterProps, FavoritesPage(), useFavorites()

### Community 79 - "tmp-audit-orders-rls.mts"
Cohesion: 0.33
Nodes (6): anon, log(), out, probe(), root, service

### Community 80 - "tmp-sentinel.ts"
Cohesion: 0.33
Nodes (4): client, orderKey(), root, selectAll()

### Community 81 - "tmp-verify-admin-search-live.ts"
Cohesion: 0.29
Nodes (3): client, root, SCALARS

### Community 82 - "tmp-verify-rrp.ts"
Cohesion: 0.29
Nodes (5): anon, prices, root, Row, rows

### Community 83 - "yugcontract-dry-run.ts"
Cohesion: 0.38
Nodes (5): BatchStat, fmt(), humanBytes(), main(), root

### Community 84 - "feedback/page.tsx"
Cohesion: 0.47
Nodes (5): AdminFeedbackPage(), dateFormatter, deleteFeedbackApi(), FeedbackRow, fetchFeedbackApi()

### Community 85 - "tmp-probe-admin-search.ts"
Cohesion: 0.33
Nodes (3): client, root, SCALAR_FIELDS

### Community 86 - "tmp-probe-search-grammar.ts"
Cohesion: 0.33
Nodes (3): client, q1, root

### Community 87 - "(dashboard)/layout.tsx"
Cohesion: 0.60
Nodes (4): AdminLayout(), createAuthClient(), metadata, signOut()

### Community 88 - "README.md"
Cohesion: 0.40
Nodes (4): Deploy on Vercel, Getting Started, Learn More, towary-dla-domu

### Community 89 - "tmp-f6-premigration.ts"
Cohesion: 0.40
Nodes (3): c, mainCnt, rows

### Community 91 - "tmp-verify-015-reviews.mts"
Cohesion: 0.40
Nodes (3): anon, root, service

### Community 92 - "tmp-verify-orders-revoke.mts"
Cohesion: 0.40
Nodes (3): anon, root, service

### Community 95 - "opencode.json"
Cohesion: 0.50
Nodes (3): plugin, $schema, .opencode/plugins/graphify.js

### Community 98 - "category-select.test.ts"
Cohesion: 0.67
Nodes (3): root, select(), src()

### Community 99 - "mobile-filter-drawer.test.ts"
Cohesion: 0.67
Nodes (3): filters(), root, src()

### Community 101 - "yugcontract-runtime.test.ts"
Cohesion: 0.67
Nodes (3): ReceivedRequest, startServer(), withServer()

### Community 142 - "api/orders/route.ts"
Cohesion: 0.27
Nodes (7): POST(), supabase, POST(), SanitizedItem, sanitizeShippingInfo(), supabase, orderAccessToken()

## Knowledge Gaps
- **676 isolated node(s):** `$schema`, `.opencode/plugins/graphify.js`, `metadata`, `revalidate`, `metadata` (+671 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **34 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `requireAdminApi()` connect `requireAdminApi` to `admin-list.ts`, `products/route.ts`, `import-run.ts`, `[imageId]/route.ts`, `yugcontract/categories/route.ts`, `preview/route.ts`, `enforceRateLimit`, `admin-api.ts`, `admin/orders/route.ts`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Why does `enforceRateLimit()` connect `enforceRateLimit` to `FeedbackModal.tsx`, `api/orders/route.ts`, `ReviewFormModal.tsx`, `import-run.ts`, `yugcontract/categories/route.ts`, `preview/route.ts`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `Product` connect `(home)/page.tsx` to `products/page.tsx`, `admin-list.ts`, `catalog.ts`, `[slug]/page.tsx`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `$schema`, `.opencode/plugins/graphify.js`, `metadata` to the rest of the system?**
  _676 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.044444444444444446 - nodes in this community are weakly interconnected._
- **Should `tmp-audit-readonly.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05110336817653891 - nodes in this community are weakly interconnected._
- **Should `admin-list.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1140819964349376 - nodes in this community are weakly interconnected._