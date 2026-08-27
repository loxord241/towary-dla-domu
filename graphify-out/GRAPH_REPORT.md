# Graph Report - my-shop  (2026-08-27)

## Corpus Check
- 297 files · ~368,982 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1899 nodes · 3062 edges · 169 communities (130 shown, 39 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 24 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b497cba2`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- order-payment-update.ts
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
- run/route.ts
- category-tree.ts
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
- reviews.ts
- cart-preview.ts
- icons.tsx
- yugcontract-content-fetch.ts
- normalize.ts
- Решения (согласованы)
- tmp-postverify-images.ts
- yugcontract-rrp-apply.ts
- yugcontract-rrp-dry-run.ts
- filter-url.ts
- tmp-liqpay-payload-check.ts
- FakeBuilder
- tmp-verify-011.ts
- fetchActiveCategories
- content-staging.ts
- admin-image-main.ts
- yugcontract/categories/route.ts
- liqpay-status.ts
- cart/page.tsx
- favorites-context.tsx
- import-run.ts
- selection.ts
- E-Commerce Database Schema
- Global Constraints
- @supabase/supabase-js
- 005_admin_role_system.sql
- createPaymentInit
- seo.ts
- lib/types.ts
- payment-routes.test.ts
- splitProductWrites
- Global Constraints
- yugcontract-import-run.ts
- reconciliation.ts
- tmp-verify-018.mts
- Priority 2 UX/UI: Mobile Catalog + Product Page — дизайн (2026-08-26)
- pagination-hardening.test.ts
- tmp-verify-f6.ts
- public.product_reviews
- 011_content_import.sql
- Global Constraints
- yugcontract-client.test.ts
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
- reconcile-liqpay.mts
- login/page.tsx
- opencode.json
- proxy.ts
- liqpay-signature.ts
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
- RecentProducts.tsx
- liqpay-config.ts
- 010_yugcontract_import_infra.sql
- 013_feedback.sql
- SiteHeader.tsx
- order-token.ts
- liqpay-ui.test.ts
- orders/[id]/route.ts
- verify-product-categories.mjs
- paid-order-interlock.test.ts
- liqpay-migration.test.ts
- favorites/page.tsx
- ProductReviews.tsx
- orders/page.tsx
- reconciliation/page.tsx
- admin-guard-invariants.test.ts
- buildFullPlan
- tmp-verify-live-payment.ts
- admin-error-hygiene.test.ts
- admin-reconciliation.test.ts
- og-metadata.test.ts
- csp-report-only.test.ts

## God Nodes (most connected - your core abstractions)
1. `requireAdminApi()` - 61 edges
2. `isUuid()` - 35 edges
3. `Проект my-shop - Техническая документация` - 27 edges
4. `dbErrorResponse()` - 26 edges
5. `enforceRateLimit()` - 25 edges
6. `strOrNull()` - 22 edges
7. `compilerOptions` - 17 edges
8. `File Structure (deliverable map)` - 17 edges
9. `numOrNull()` - 16 edges
10. `processLiqPayCallback()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `sortParamsOf()` --calls--> `buildSortSearchParams()`  [EXTRACTED]
  tests/filter-url.test.ts → app/lib/filter-url.ts
- `runPlanPreview()` --calls--> `matchContentGoodsToProducts()`  [EXTRACTED]
  scripts/yugcontract-content-fetch.ts → app/lib/yugcontract/content-dry-run.ts
- `runPlanPreview()` --calls--> `buildDescriptionStats()`  [EXTRACTED]
  scripts/yugcontract-content-fetch.ts → app/lib/yugcontract/content-dry-run.ts
- `runPlanPreview()` --calls--> `buildParamsStats()`  [EXTRACTED]
  scripts/yugcontract-content-fetch.ts → app/lib/yugcontract/content-dry-run.ts
- `externalExisting` --calls--> `isExternalImportedImage()`  [EXTRACTED]
  scripts/yugcontract-content-images.ts → app/lib/yugcontract/content-images.ts

## Import Cycles
- None detected.

## Communities (169 total, 39 thin omitted)

### Community 0 - "order-payment-update.ts"
Cohesion: 0.11
Nodes (18): LiqPayConfig, decodeLiqPayData(), ApplyResult, buildCheckoutPayload(), CallbackDeps, CallbackOrderRow, CallbackOutcome, CheckoutPayloadInput (+10 more)

### Community 1 - "devDependencies"
Cohesion: 0.04
Nodes (48): eslint, eslint-config-next, next, allowScripts, unrs-resolver@1.12.2, dependencies, next, react (+40 more)

### Community 2 - "tmp-audit-readonly.ts"
Cohesion: 0.05
Nodes (36): anonClient, client, dangerCounts, dangerPatterns, dangerSamples, diffSamples, external, imagesByProduct (+28 more)

### Community 3 - "admin-list.ts"
Cohesion: 0.11
Nodes (31): GET(), GET(), ADMIN_LIST_DEFAULT_PAGE_SIZE, ADMIN_LIST_MAX_PAGE_SIZE, AdminListParams, BRAND_FIELDS_LIST, BRAND_SORT_KEYS, BRAND_SORTS (+23 more)

### Community 4 - "requireAdminApi"
Cohesion: 0.14
Nodes (15): POST(), SiblingRow, DELETE(), GET(), POST(), GET(), sanitizeSearchTerm(), STATUSES (+7 more)

### Community 5 - "yugcontract-content-dry-run.ts"
Cohesion: 0.09
Nodes (20): client, deduped, descAll, descMatched, fmtInt(), goodsById, imgAll, imgMatched (+12 more)

### Community 6 - "yugcontract-verify.ts"
Cohesion: 0.07
Nodes (25): availBad, availViolations, byUuid, check(), childlessParents, client, CountResult, { data: manual } (+17 more)

### Community 7 - "compilerOptions"
Cohesion: 0.07
Nodes (29): dom, dom.iterable, esnext, **/*.mts, .next/dev/types/**/*.ts, next-env.d.ts, .next/types/**/*.ts, node_modules (+21 more)

### Community 8 - "content-import.ts"
Cohesion: 0.12
Nodes (24): assertImageUpdateFields(), assertContentFields(), claimNextContentBatch(), CONTENT_BATCH_SIZE, CONTENT_STALE_RUNNING_MS, ContentBatchOutcome, ContentBatchRow, ContentPlan (+16 more)

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
Cohesion: 0.18
Nodes (18): ActiveChip, buildActiveChips(), catalogHeading(), CatalogPage(), catalogPageUrl(), firstParam(), generateMetadata(), parseCatalogSearchParams() (+10 more)

### Community 13 - "yugcontract-content-images.ts"
Cohesion: 0.09
Nodes (21): anomalies, batches, brokenMains, client, crossProductDups, dbIdByYc, dupUrlCounts, existingImages (+13 more)

### Community 14 - "catalog.ts"
Cohesion: 0.11
Nodes (23): Home(), metadata, revalidate, buildSearchConditions(), CatalogPage, collectRelated(), fetchCatalogProducts(), fetchFeaturedProducts() (+15 more)

### Community 15 - "InfoPage.tsx"
Cohesion: 0.06
Nodes (23): metadata, POST(), serviceClient(), ErrorKind, FeedbackModal(), Status, InfoPage(), InfoPageProps (+15 more)

### Community 16 - "tmp-postverify-content.ts"
Cohesion: 0.12
Nodes (19): byStatus, byYc, check(), client, DANGER, emptyDesc, hasDupConflict(), manual (+11 more)

### Community 17 - "[orderNumber]/page.tsx"
Cohesion: 0.11
Nodes (20): CheckoutSuccessPage(), ItemRow, OrderRow, SearchParams, supabase, ItemRow, OrderDetails, OrderDetailsCard() (+12 more)

### Community 18 - "products/page.tsx"
Cohesion: 0.08
Nodes (32): BRAND_SORT_KEYS, BrandsAdminPage(), fetchBrandList(), SORT_OPTIONS, totalPagesFor(), CategoriesAdminPage(), CATEGORY_SORT_KEYS, fetchAllCategoriesForPicker() (+24 more)

### Community 19 - "run/route.ts"
Cohesion: 0.27
Nodes (10): maxDuration, POST(), maxDuration, POST(), claimNextBatch(), ensureRun(), executeBatch(), makeRealDeps() (+2 more)

### Community 20 - "category-tree.ts"
Cohesion: 0.24
Nodes (12): AdminCategoryMultiSelect(), CategorySelect(), Category, buildCategoryOptions(), CategoryOption, collectSubtreeIds(), compareCategories(), compareSiblings() (+4 more)

### Community 21 - "File Structure (deliverable map)"
Cohesion: 0.10
Nodes (19): File Structure (deliverable map), Global Constraints, Storefront Features: Reviews / Recently Viewed / Popular Products — Implementation Plan, Task 10: Recently-viewed pure storage module, Task 11: Tracker + shelf components, page wiring, Task 12: Featured-limit pure module, Task 13: Storefront popular query — featured-only + homepage hides empty, Task 14: Admin API enforcement (PUT/POST + featured-count) (+11 more)

### Community 22 - "[slug]/page.tsx"
Cohesion: 0.08
Nodes (33): ImageRow(), ProductDescription(), GalleryImage, ProductGallery(), ProductJsonLd(), ProductSpecifications(), RelatedProducts(), fetchPublishedReviews() (+25 more)

### Community 23 - "cart-context.tsx"
Cohesion: 0.25
Nodes (15): CartAction, CartContext, CartContextValue, CartProvider(), CartState, loadStoredCart(), reducer(), CART_STORAGE_KEY (+7 more)

### Community 24 - "tmp-verify-stage.ts"
Cohesion: 0.12
Nodes (17): byYc, client, DANGER, dangerSamples, descPairs, descStats, headCount(), ids (+9 more)

### Community 25 - "enforceRateLimit"
Cohesion: 0.16
Nodes (15): CheckpointRow, GET(), POST(), supabase, PreviewRequestItem, buckets, checkRateLimit(), clientIpOf() (+7 more)

### Community 26 - "client.ts"
Cohesion: 0.10
Nodes (24): authUrl(), CachedAuthToken, categoriesUrl(), contentUrl(), FetchLike, getAuthToken(), getContentGoods(), getContentGoodsWithMeta() (+16 more)

### Community 27 - "content-images.ts"
Cohesion: 0.13
Nodes (12): IMAGE_UPDATE_FIELDS, ImageInsertOp, ImagePlan, ImagePlanInputProduct, ImageUpdateOp, isExternalImportedImage(), planImageOps(), ProductImageRow (+4 more)

### Community 28 - "admin-api.ts"
Cohesion: 0.17
Nodes (29): DELETE(), PUT(), POST(), DELETE(), PUT(), POST(), DELETE(), PUT() (+21 more)

### Community 29 - "final_001_initial_schema.sql"
Cohesion: 0.07
Nodes (40): case, public.place_order(), update_updated_at_column, update_orders_updated_at, public.admin_cancel_order(), public.admin_set_order_status(), public.expire_pending_orders(), product_categories (+32 more)

### Community 30 - "content-dry-run.ts"
Cohesion: 0.16
Nodes (12): buildImagesStats(), coerceParams(), coercePictures(), ContentIssue, DedupeResult, DescriptionStats, ImagesStats, MatchResult (+4 more)

### Community 31 - "dry-run.ts"
Cohesion: 0.18
Nodes (9): computeDryRunReport(), DryRunBatchMeta, DryRunDbSnapshot, DryRunReport, makeCategoryFilter(), normalizeKey(), YcProductMerger, YcProduct (+1 more)

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

### Community 37 - "reviews.ts"
Cohesion: 0.30
Nodes (9): POST(), serviceClient(), cleanUserString(), REVIEW_DAILY_CAP, REVIEW_MAX_LENGTH, REVIEW_MIN_LENGTH, REVIEW_NAME_MAX_LENGTH, ReviewValidation (+1 more)

### Community 38 - "cart-preview.ts"
Cohesion: 0.24
Nodes (7): SubmitResult, CartPreviewLine, FetchHandlers, PREVIEW_NETWORK_ERROR, PREVIEW_TIMEOUT_MS, contexts, TestCtx

### Community 39 - "icons.tsx"
Cohesion: 0.15
Nodes (17): base(), BoxIcon(), CartIcon(), ChevronDownIcon(), ChevronRightIcon(), FilterIcon(), IconProps, MenuIcon() (+9 more)

### Community 40 - "yugcontract-content-fetch.ts"
Cohesion: 0.12
Nodes (16): buildDescriptionStats(), buildParamsStats(), matchContentGoodsToProducts(), OurProductRow, ContentProductRow, planContentBatches(), client, deduped (+8 more)

### Community 41 - "normalize.ts"
Cohesion: 0.12
Nodes (23): errorResponse(), fetchAllRows(), GET(), maxDuration, getPriceCatalog(), asNumberOrNull(), brandKeys(), buildCrossAnalysis() (+15 more)

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

### Community 46 - "filter-url.ts"
Cohesion: 0.21
Nodes (11): CatalogFilters(), SORT_OPTIONS, SortSelect(), SortSelectInner(), buildFilterSearchParams(), buildFilterUrl(), buildSortSearchParams(), FilterDraft (+3 more)

### Community 47 - "tmp-liqpay-payload-check.ts"
Cohesion: 0.20
Nodes (7): data, order, payload, reencoded, root, sig, svc

### Community 49 - "tmp-verify-011.ts"
Cohesion: 0.14
Nodes (8): anon, EXPECTED_YC_CONTENT_BATCHES, EXPECTED_YC_CONTENT_GOODS, EXPECTED_YC_IMPORT_BATCHES, OasDefinition, OasProperty, root, service

### Community 50 - "fetchActiveCategories"
Cohesion: 0.27
Nodes (9): GET(), revalidate, fetchActiveBrands(), fetchActiveCategories(), collectPaged(), dynamic, fetchEligibleProducts(), sitemap() (+1 more)

### Community 51 - "content-staging.ts"
Cohesion: 0.10
Nodes (18): YcContentGood, YcContentParam, ALLOWED_TAGS, sanitizeYcDescription(), ALLOWED_IMAGE_EXTENSIONS, ImageUrlCheck, reduceGoodsToStagedRows(), StagedContentRow (+10 more)

### Community 52 - "admin-image-main.ts"
Cohesion: 0.40
Nodes (3): MainPromotionStep, root, routeSrc

### Community 53 - "yugcontract/categories/route.ts"
Cohesion: 0.25
Nodes (12): GET(), maxDuration, getCategoriesCatalog(), YugcontractError, loadOnce(), buildCategoryTree(), deepScanForCategoryArray(), detectCategoryFields() (+4 more)

### Community 54 - "liqpay-status.ts"
Cohesion: 0.22
Nodes (8): FINAL_FAILED, FINAL_PAID, FINAL_REFUNDED, isKnownLiqPayStatus(), isKnownNonFinalLiqPayStatus(), KNOWN_NON_FINAL, PaymentStatus, INTERMEDIATE

### Community 55 - "cart/page.tsx"
Cohesion: 0.22
Nodes (9): availabilityLabel(), CartPage(), EmptyState(), availabilityLabel(), ProductCard(), ProductCardData, formatPrice(), fracFormat (+1 more)

### Community 56 - "favorites-context.tsx"
Cohesion: 0.18
Nodes (11): geistMono, geistSans, metadata, FavoritesContext, FavoritesContextValue, FavoritesProvider(), FavoritesState, loadStoredFavorites() (+3 more)

### Community 57 - "import-run.ts"
Cohesion: 0.22
Nodes (14): applyCategoryPlan(), BatchCounters, BatchOutcome, chunk(), ExistingProductRowLite, finishBatch(), ImportBatchRow, ImportPlanSummary (+6 more)

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

### Community 63 - "createPaymentInit"
Cohesion: 0.36
Nodes (4): startPayment(), createPaymentInit(), InitDeps, nextAttemptOrderId()

### Community 64 - "seo.ts"
Cohesion: 0.31
Nodes (9): buildCatalogViewMetadata(), CatalogIndexInput, CatalogViewMetadataArgs, decideCatalogIndexing(), IndexingDecision, SITE_NAME, truncateQuery(), ViewMetadata (+1 more)

### Community 65 - "lib/types.ts"
Cohesion: 0.20
Nodes (9): Brand, Category, MainProductImageUrlFunction, Product, ProductImage, ProductImageUrlsFunction, ProductVariant, PublicImageUrlFunction (+1 more)

### Community 66 - "payment-routes.test.ts"
Cohesion: 0.28
Nodes (6): callbackBody(), cbBody(), CFG, makeDeps(), makeGateway(), Row

### Community 67 - "splitProductWrites"
Cohesion: 0.24
Nodes (4): ExistingProductRow, MappedProductRow, splitProductWrites(), MappedProductRowHolder

### Community 68 - "Global Constraints"
Cohesion: 0.20
Nodes (9): Global Constraints, P3 UX Fixes Implementation Plan (2026-08-26), Self-review, Task 1: formatPrice uk-UA formatting + all surfaces (P3-R1), Task 2: RecentlyViewed container (P3-N1), Task 3: Category cards (P3-R3), Task 4: Pagination disabled semantics (P3-R2), Task 5: Grid breakpoints (P3-N2) (+1 more)

### Community 69 - "yugcontract-import-run.ts"
Cohesion: 0.20
Nodes (9): allConflicts, client, deps, execDeps, planned, resumeIdx, root, t0 (+1 more)

### Community 70 - "reconciliation.ts"
Cohesion: 0.15
Nodes (16): clampInt(), GET(), parseIso(), ReconciliationOrderRow, mapLiqPayStatus(), sameMoneyCents(), classifyReconcileRow(), currencyEquals() (+8 more)

### Community 71 - "tmp-verify-018.mts"
Cohesion: 0.25
Nodes (5): anon, Cand, payCounts, root, svc

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

### Community 93 - "reconcile-liqpay.mts"
Cohesion: 0.11
Nodes (14): args, byClass, CLEAN, DEFAULT_FROM, duplicates, findings, LIMIT, NOT_FOUND (+6 more)

### Community 95 - "opencode.json"
Cohesion: 0.50
Nodes (3): plugin, $schema, .opencode/plugins/graphify.js

### Community 97 - "liqpay-signature.ts"
Cohesion: 0.36
Nodes (5): createLiqPaySignature(), encodeLiqPayData(), verifyLiqPaySignature(), fetchLiqPayProviderStatus(), NOTE: the documentation page text mentions sha3-256, but every official

### Community 98 - "category-select.test.ts"
Cohesion: 0.67
Nodes (3): root, select(), src()

### Community 99 - "mobile-filter-drawer.test.ts"
Cohesion: 0.67
Nodes (3): filters(), root, src()

### Community 101 - "yugcontract-runtime.test.ts"
Cohesion: 0.67
Nodes (3): ReceivedRequest, startServer(), withServer()

### Community 132 - "next.config.ts"
Cohesion: 0.50
Nodes (3): CSP_REPORT_ONLY, nextConfig, SUPABASE_HOST

### Community 141 - "RecentProducts.tsx"
Cohesion: 0.27
Nodes (10): RecentlyViewedTracker(), RecentProducts(), MAX_RECENTLY_VIEWED, readRecentlyViewed(), RECENTLY_VIEWED_STORAGE_KEY, recordRecentlyViewed(), sanitizeRecentlyViewed(), UUID_RE (+2 more)

### Community 142 - "liqpay-config.ts"
Cohesion: 0.19
Nodes (16): POST(), supabase, parseBody(), POST(), supabase, buildCallbackUrl(), buildResultUrl(), detectLiqPayKeyMode() (+8 more)

### Community 151 - "SiteHeader.tsx"
Cohesion: 0.22
Nodes (8): CheckoutForm(), metadata, AddToCartButton(), AddToCartButtonProps, VariantOption, CartBadge(), SiteHeader(), useCart()

### Community 152 - "order-token.ts"
Cohesion: 0.27
Nodes (7): POST(), supabase, POST(), SanitizedItem, sanitizeShippingInfo(), supabase, orderAccessToken()

### Community 153 - "liqpay-ui.test.ts"
Cohesion: 0.25
Nodes (6): btn, cb, init, orderPage, root, success

### Community 154 - "orders/[id]/route.ts"
Cohesion: 0.43
Nodes (5): GET(), PATCH(), CancellationDecision, decideAdminCancellation(), PAID_CANCEL_REJECTION_MESSAGE

### Community 155 - "verify-product-categories.mjs"
Cohesion: 0.33
Nodes (3): count(), env, seen

### Community 158 - "favorites/page.tsx"
Cohesion: 0.35
Nodes (7): FavoriteButton(), FavoritesBadge(), HeartIcon(), RemoveFavoriteButton(), FavoritesPage(), fetchCartPreview(), useFavorites()

### Community 159 - "ProductReviews.tsx"
Cohesion: 0.22
Nodes (8): dateFormatter, pluralReviews(), ProductReviews(), ErrorKind, ReviewFormModal(), Status, ReviewsPageData, ReviewSummary

### Community 160 - "orders/page.tsx"
Cohesion: 0.27
Nodes (9): ALLOWED_TRANSITIONS, fetchOrderDetailsApi(), fetchOrdersApi(), formatDate(), ItemRow, OrderDetails, OrderListRow, OrdersAdminPage() (+1 more)

### Community 161 - "reconciliation/page.tsx"
Cohesion: 0.24
Nodes (9): ALL_CLASSES, CLASS_LABELS, classTone(), CRITICAL_CLASSES, fetchReconciliationApi(), OrdersReconciliationAdminPage(), ReconciliationItem, ReconciliationReport (+1 more)

### Community 162 - "admin-guard-invariants.test.ts"
Cohesion: 0.29
Nodes (3): DOCUMENTED_GUARD_EXEMPTIONS, HTTP_METHODS, root

### Community 164 - "tmp-verify-live-payment.ts"
Cohesion: 0.40
Nodes (3): DO_LIQPAY, root, svc

### Community 166 - "admin-reconciliation.test.ts"
Cohesion: 0.67
Nodes (3): pageSrc(), root, src()

## Knowledge Gaps
- **756 isolated node(s):** `$schema`, `.opencode/plugins/graphify.js`, `metadata`, `revalidate`, `metadata` (+751 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **39 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `enforceRateLimit()` connect `enforceRateLimit` to `reviews.ts`, `normalize.ts`, `liqpay-config.ts`, `InfoPage.tsx`, `run/route.ts`, `yugcontract/categories/route.ts`, `order-token.ts`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **Why does `requireAdminApi()` connect `requireAdminApi` to `admin-list.ts`, `products/route.ts`, `reconciliation.ts`, `normalize.ts`, `run/route.ts`, `yugcontract/categories/route.ts`, `enforceRateLimit`, `orders/[id]/route.ts`, `admin-api.ts`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **Why does `Product` connect `[slug]/page.tsx` to `products/page.tsx`, `admin-list.ts`, `catalog.ts`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **What connects `$schema`, `.opencode/plugins/graphify.js`, `metadata` to the rest of the system?**
  _756 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `order-payment-update.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11384615384615385 - nodes in this community are weakly interconnected._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.04081632653061224 - nodes in this community are weakly interconnected._
- **Should `tmp-audit-readonly.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05110336817653891 - nodes in this community are weakly interconnected._