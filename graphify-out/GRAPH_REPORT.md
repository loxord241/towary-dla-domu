# Graph Report - my-shop  (2026-08-29)

## Corpus Check
- 383 files · ~473,532 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2403 nodes · 3924 edges · 211 communities (161 shown, 50 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 38 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `38335c40`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- order-payment-update.ts
- devDependencies
- tmp-audit-readonly.ts
- admin-list.ts
- isUuid
- yugcontract-content-dry-run.ts
- yugcontract-verify.ts
- compilerOptions
- content-import.ts
- Проект my-shop - Техническая документация
- import-plan.ts
- normalize.ts
- catalog/page.tsx
- yugcontract-content-images.ts
- catalog.ts
- InfoPage.tsx
- tmp-postverify-content.ts
- [orderNumber]/page.tsx
- products/page.tsx
- admin-shipments.ts
- images/route.ts
- File Structure (deliverable map)
- [slug]/page.tsx
- cart-context.tsx
- tmp-verify-stage.ts
- ReviewFormModal.tsx
- yugcontract/client.ts
- errors.ts
- final_001_initial_schema.sql
- content-dry-run.ts
- dry-run.ts
- Global Constraints
- tmp-f6-db-audit.ts
- admin-junction-search.test.ts
- admin-search-pagination.test.ts
- products/route.ts
- delivery-cost.ts
- FeedbackModal.tsx
- icons.tsx
- telegram.ts
- yugcontract/categories/route.ts
- Решения (согласованы)
- tmp-postverify-images.ts
- yugcontract-rrp-apply.ts
- yugcontract-rrp-dry-run.ts
- filter-url.ts
- tmp-liqpay-payload-check.ts
- FakeBuilder
- tmp-verify-011.ts
- [imageId]/route.ts
- content-staging.ts
- catalog-health.ts
- preview/route.ts
- liqpay-status.ts
- novapost/client.ts
- [id]/page.tsx
- checkout-delivery.ts
- yugcontract-copy-du-images.ts
- E-Commerce Database Schema
- Global Constraints
- @supabase/supabase-js
- 005_admin_role_system.sql
- createPaymentInit
- admin-shipment-planning-migration.test.ts
- lib/types.ts
- payment-routes.test.ts
- ttn/route.ts
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
- selection.ts
- feedback/page.tsx
- tmp-probe-admin-search.ts
- tmp-probe-search-grammar.ts
- (dashboard)/layout.tsx
- README.md
- orders/[id]/route.ts
- import-run.ts
- Yugcontract Sync в WSL2 (systemd timer)
- jwt.ts
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
- admin-shipment-fk-fix-migration.test.ts
- eslint.config.mjs
- csp-enforcing.test.ts
- postcss.config.mjs
- h1-invariants.test.ts
- migration-016-invariants.test.ts
- recently-viewed-storage.ts
- liqpay-config.ts
- 010_yugcontract_import_infra.sql
- 013_feedback.sql
- orders
- ProductSpecifications.tsx
- liqpay-ui.test.ts
- verify-product-categories.mjs
- nova-shipments-migration.test.ts
- liqpay-migration.test.ts
- enforceRateLimit
- checkout-customer-names.test.ts
- yugcontract-sync-workflow.test.ts
- reconciliation/page.tsx
- admin-guard-invariants.test.ts
- 019_order_shipments.sql
- shipments.ts
- admin-error-hygiene.test.ts
- admin-reconciliation.test.ts
- og-metadata.test.ts
- Yugcontract Sync на Windows ПК (Task Scheduler)
- favorites/page.tsx
- final_002_constraints_and_indexes.sql
- categories
- products
- nova-parcels-migration.test.ts
- orders/page.tsx
- seo.ts
- Nova Post API — Courier delivery: `recipient.addressParts` / `settlementId`
- novapost-streets-route.test.ts
- admin-shipment-parcel-cap-migration.test.ts
- category-tree.ts
- schema-org.ts
- rate-limit-xff.test.ts
- tmp-slugs.ts
- tmp-verify-orders-revoke.mts
- requireAdminApi
- truncate-grants-migration.test.ts
- tmp-verify-live-payment.ts
- CheckoutForm.tsx
- auth-leaked-password-doc.test.ts
- curated-selected.test.ts
- admin-shipment-courier-address-migration.test.ts
- stage2g-money.test.ts
- public.product_review_summary
- settlement-autocomplete.test.ts
- tmp-f6-premigration.ts
- paid-order-interlock.test.ts
- install-yugcontract-timer.sh
- yugcontract-sync.sh
- api/orders/route.ts
- yugcontract-failure-notify.sh
- yugcontract-health.sh
- tmp-verify-015-reviews.mts
- yugcontract-categories-preview.ts

## God Nodes (most connected - your core abstractions)
1. `requireAdminApi()` - 69 edges
2. `isUuid()` - 44 edges
3. `enforceRateLimit()` - 33 edges
4. `Проект my-shop - Техническая документация` - 28 edges
5. `dbErrorResponse()` - 26 edges
6. `strOrNull()` - 22 edges
7. `compilerOptions` - 17 edges
8. `File Structure (deliverable map)` - 17 edges
9. `numOrNull()` - 16 edges
10. `mapNovaPostFailure()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `makeClient()` --calls--> `createNovaPostClient()`  [EXTRACTED]
  tests/novapost-client.test.ts → app/lib/delivery/novapost/client.ts
- `stubClient()` --calls--> `createNovaPostClient()`  [EXTRACTED]
  tests/novapost-shipments.test.ts → app/lib/delivery/novapost/client.ts
- `mapNovaPostErrorOfKind()` --calls--> `mapNovaPostFailure()`  [EXTRACTED]
  tests/novapost-mapping.test.ts → app/lib/delivery/novapost/map-failure.ts
- `sortParamsOf()` --calls--> `buildSortSearchParams()`  [EXTRACTED]
  tests/filter-url.test.ts → app/lib/filter-url.ts
- `runPlanPreview()` --calls--> `matchContentGoodsToProducts()`  [EXTRACTED]
  scripts/yugcontract-content-fetch.ts → app/lib/yugcontract/content-dry-run.ts

## Import Cycles
- None detected.

## Communities (211 total, 50 thin omitted)

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
Nodes (34): GET(), POST(), GET(), ADMIN_LIST_DEFAULT_PAGE_SIZE, ADMIN_LIST_MAX_PAGE_SIZE, AdminListParams, BRAND_FIELDS_LIST, BRAND_SORT_KEYS (+26 more)

### Community 4 - "isUuid"
Cohesion: 0.22
Nodes (20): DELETE(), PUT(), POST(), SiblingRow, DELETE(), PUT(), POST(), GET() (+12 more)

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
Nodes (28): Checkout / Orders (миграции 006–008), Архитектура Supabase, Важные правила для будущих изменений, Етап 16: Security hardening (2026-08-27), Известные ограничения (осознанные), Интеграция Yugcontract (этап 1: read-only preview, 2026-08), Интеграция Yugcontract (этап 2: импорт выбранного ассортимента, 2026-08), Правила безопасности (не нарушать) (+20 more)

### Community 10 - "import-plan.ts"
Cohesion: 0.09
Nodes (26): bareKey(), BrandPlan, buildBrandPlan(), buildCategoryPlan(), CategoryCreateOp, CategoryPlan, CategoryUpdateOp, depthsInSelection() (+18 more)

### Community 11 - "normalize.ts"
Cohesion: 0.08
Nodes (26): CategoriesResponse, YugcontractCategoriesPage(), PreviewResponse, YugcontractAdminPage(), CATEGORY_ID_KEYS, CATEGORY_NAME_KEYS, CATEGORY_PARENT_KEYS, HISTOGRAM_FIELDS (+18 more)

### Community 12 - "catalog/page.tsx"
Cohesion: 0.16
Nodes (19): CatalogFilters(), ActiveChip, buildActiveChips(), catalogHeading(), CatalogPage(), catalogPageUrl(), firstParam(), generateMetadata() (+11 more)

### Community 13 - "yugcontract-content-images.ts"
Cohesion: 0.07
Nodes (33): IMAGE_UPDATE_FIELDS, ImageInsertOp, ImagePlan, ImagePlanInputProduct, ImageUpdateOp, isExternalImportedImage(), planImageOps(), ProductImageRow (+25 more)

### Community 14 - "catalog.ts"
Cohesion: 0.07
Nodes (38): GET(), revalidate, Home(), metadata, revalidate, buildSearchConditions(), CatalogPage, collectRelated() (+30 more)

### Community 15 - "InfoPage.tsx"
Cohesion: 0.12
Nodes (9): metadata, InfoPage(), InfoPageProps, SiteHeader(), metadata, metadata, metadata, metadata (+1 more)

### Community 16 - "tmp-postverify-content.ts"
Cohesion: 0.12
Nodes (19): byStatus, byYc, check(), client, DANGER, emptyDesc, hasDupConflict(), manual (+11 more)

### Community 17 - "[orderNumber]/page.tsx"
Cohesion: 0.11
Nodes (20): CheckoutSuccessPage(), ItemRow, OrderRow, SearchParams, supabase, ItemRow, OrderDetails, OrderDetailsCard() (+12 more)

### Community 18 - "products/page.tsx"
Cohesion: 0.07
Nodes (37): BRAND_SORT_KEYS, BrandsAdminPage(), fetchBrandList(), SORT_OPTIONS, totalPagesFor(), CategoriesAdminPage(), CATEGORY_SORT_KEYS, fetchAllCategoriesForPicker() (+29 more)

### Community 19 - "admin-shipments.ts"
Cohesion: 0.12
Nodes (23): PUT(), SHIPMENT_SELECT, CARGO_CATEGORIES, CargoCategory, isRecord(), MAX_PARCELS_PER_SHIPMENT, MAX_SHIPMENTS, parseParcel() (+15 more)

### Community 20 - "images/route.ts"
Cohesion: 0.29
Nodes (7): ALLOWED_MIME, detectImageMime(), GET(), POST(), IMAGE_EXT_BY_MIME, sanitizeUploadFileName(), root

### Community 21 - "File Structure (deliverable map)"
Cohesion: 0.10
Nodes (19): File Structure (deliverable map), Global Constraints, Storefront Features: Reviews / Recently Viewed / Popular Products — Implementation Plan, Task 10: Recently-viewed pure storage module, Task 11: Tracker + shelf components, page wiring, Task 12: Featured-limit pure module, Task 13: Storefront popular query — featured-only + homepage hides empty, Task 14: Admin API enforcement (PUT/POST + featured-count) (+11 more)

### Community 22 - "[slug]/page.tsx"
Cohesion: 0.09
Nodes (28): AddToCartButton(), AddToCartButtonProps, VariantOption, ProductDescription(), GalleryImage, ProductGallery(), dateFormatter, pluralReviews() (+20 more)

### Community 23 - "cart-context.tsx"
Cohesion: 0.11
Nodes (26): geistMono, geistSans, metadata, CartAction, CartContext, CartContextValue, CartProvider(), CartState (+18 more)

### Community 24 - "tmp-verify-stage.ts"
Cohesion: 0.12
Nodes (17): byYc, client, DANGER, dangerSamples, descPairs, descStats, headCount(), ids (+9 more)

### Community 25 - "ReviewFormModal.tsx"
Cohesion: 0.25
Nodes (11): POST(), serviceClient(), ErrorKind, Status, cleanUserString(), REVIEW_DAILY_CAP, REVIEW_MAX_LENGTH, REVIEW_MIN_LENGTH (+3 more)

### Community 26 - "yugcontract/client.ts"
Cohesion: 0.15
Nodes (20): authUrl(), CachedAuthToken, categoriesUrl(), contentUrl(), FetchLike, getAuthToken(), getContentGoods(), getContentGoodsWithMeta() (+12 more)

### Community 28 - "errors.ts"
Cohesion: 0.11
Nodes (22): GET(), isNovaPostError(), KINDS, NovaPostError, NovaPostErrorKind, mapNovaPostFailure(), MESSAGES, NOVA_POST_MESSAGES (+14 more)

### Community 29 - "final_001_initial_schema.sql"
Cohesion: 0.23
Nodes (12): attribute_values, attribute_values_translations, attributes, attributes_translations, brands, brands_translations, product_attribute_values, update_updated_at_column (+4 more)

### Community 30 - "content-dry-run.ts"
Cohesion: 0.08
Nodes (27): buildDescriptionStats(), buildImagesStats(), buildParamsStats(), coerceParams(), coercePictures(), ContentIssue, DedupeResult, DescriptionStats (+19 more)

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
Nodes (16): ALLOWED_AVAILABILITY, GET(), isValidCurrency(), PUT(), fetchAllJoined(), GET(), POST(), parseCategoryIds() (+8 more)

### Community 37 - "delivery-cost.ts"
Cohesion: 0.15
Nodes (20): POST(), POST(), buildCalculationInput(), CalcInputResult, CalcSkipReason, selectDeliveryService(), ServiceSelection, ShipmentForCalc (+12 more)

### Community 38 - "FeedbackModal.tsx"
Cohesion: 0.17
Nodes (11): POST(), serviceClient(), ErrorKind, FeedbackModal(), Status, FEEDBACK_DAILY_CAP, FEEDBACK_MAX_LENGTH, FEEDBACK_MIN_LENGTH (+3 more)

### Community 39 - "icons.tsx"
Cohesion: 0.13
Nodes (21): CartBadge(), FavoritesBadge(), base(), BoxIcon(), CartIcon(), ChevronDownIcon(), ChevronRightIcon(), FilterIcon() (+13 more)

### Community 40 - "telegram.ts"
Cohesion: 0.11
Nodes (21): asNumber(), asString(), asStringOrNull(), buildOrderNotificationMessage(), describeDelivery(), loadOrderNotificationData(), OrderNotificationData, OrderNotificationItem (+13 more)

### Community 41 - "yugcontract/categories/route.ts"
Cohesion: 0.36
Nodes (10): GET(), maxDuration, getCategoriesCatalog(), loadOnce(), buildCategoryTree(), deepScanForCategoryArray(), detectCategoryFields(), extractCategoryRows() (+2 more)

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
Cohesion: 0.23
Nodes (10): SORT_OPTIONS, SortSelect(), SortSelectInner(), buildFilterSearchParams(), buildFilterUrl(), buildSortSearchParams(), FilterDraft, PRESERVED_KEYS (+2 more)

### Community 47 - "tmp-liqpay-payload-check.ts"
Cohesion: 0.20
Nodes (7): data, order, payload, reencoded, root, sig, svc

### Community 49 - "tmp-verify-011.ts"
Cohesion: 0.14
Nodes (8): anon, EXPECTED_YC_CONTENT_BATCHES, EXPECTED_YC_CONTENT_GOODS, EXPECTED_YC_IMPORT_BATCHES, OasDefinition, OasProperty, root, service

### Community 50 - "[imageId]/route.ts"
Cohesion: 0.24
Nodes (8): DELETE(), PUT(), DELETE(), toStoragePath(), MainPromotionStep, planMainPromotion(), root, routeSrc

### Community 51 - "content-staging.ts"
Cohesion: 0.09
Nodes (18): YcContentGood, YcContentParam, ALLOWED_TAGS, sanitizeYcDescription(), ALLOWED_IMAGE_EXTENSIONS, ImageUrlCheck, reduceGoodsToStagedRows(), StagedContentRow (+10 more)

### Community 52 - "catalog-health.ts"
Cohesion: 0.12
Nodes (22): ageHours(), analyzeImportBatches(), buildCatalogChecks(), CatalogCounts, CatalogHealthInput, HealthCheck, HealthLevel, ImportAnalysis (+14 more)

### Community 53 - "preview/route.ts"
Cohesion: 0.20
Nodes (13): errorResponse(), fetchAllRows(), GET(), maxDuration, getPriceCatalog(), YugcontractError, brandKeys(), buildCrossAnalysis() (+5 more)

### Community 54 - "liqpay-status.ts"
Cohesion: 0.22
Nodes (8): FINAL_FAILED, FINAL_PAID, FINAL_REFUNDED, isKnownLiqPayStatus(), isKnownNonFinalLiqPayStatus(), KNOWN_NON_FINAL, PaymentStatus, INTERMEDIATE

### Community 55 - "novapost/client.ts"
Cohesion: 0.14
Nodes (16): createNovaPostClient(), authorizationHeader(), authorize(), invalidateJwt(), request(), joinUrl(), NovaPostClientDeps, ProviderErrorBody (+8 more)

### Community 56 - "[id]/page.tsx"
Cohesion: 0.11
Nodes (24): buildPlanPayload(), CalcOutcome, CARGO_CATEGORIES, emptyShipment(), fetchDivisionsApi(), fetchPlanApi(), NpDivision, NpSettlement (+16 more)

### Community 57 - "checkout-delivery.ts"
Cohesion: 0.25
Nodes (9): ALLOWED_KEYS, CheckoutDelivery, CheckoutDeliveryServiceType, displayText(), isRecord(), sanitizeDelivery(), SanitizeDeliveryResult, SERVICE_TYPES (+1 more)

### Community 58 - "yugcontract-copy-du-images.ts"
Cohesion: 0.19
Nodes (12): bases, buildOps(), client, DU_IDS, DU_TO_BASE, fail(), { inserts, perTarget }, loadExistingImages() (+4 more)

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

### Community 64 - "admin-shipment-planning-migration.test.ts"
Cohesion: 0.33
Nodes (4): code, fn, root, sql

### Community 65 - "lib/types.ts"
Cohesion: 0.20
Nodes (9): Brand, Category, MainProductImageUrlFunction, Product, ProductImage, ProductImageUrlsFunction, ProductVariant, PublicImageUrlFunction (+1 more)

### Community 66 - "payment-routes.test.ts"
Cohesion: 0.28
Nodes (6): callbackBody(), cbBody(), CFG, makeDeps(), makeGateway(), Row

### Community 67 - "ttn/route.ts"
Cohesion: 0.07
Nodes (45): DELETE(), INVALID_MESSAGES, novaPostFailureResponse(), OrderRow, parseBodyShipmentId(), POST(), providerAdapter(), readShipmentRow() (+37 more)

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

### Community 83 - "selection.ts"
Cohesion: 0.10
Nodes (13): collectExpandedIds(), ExpandableNode, ExpansionResult, flattenSelectedIds(), SELECTED_CATEGORIES, YcSelectedCategory, BatchStat, fmt() (+5 more)

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

### Community 89 - "orders/[id]/route.ts"
Cohesion: 0.43
Nodes (5): GET(), PATCH(), CancellationDecision, decideAdminCancellation(), PAID_CANCEL_REJECTION_MESSAGE

### Community 90 - "import-run.ts"
Cohesion: 0.12
Nodes (26): maxDuration, POST(), maxDuration, POST(), applyCategoryPlan(), BatchCounters, BatchOutcome, buildFullPlan() (+18 more)

### Community 91 - "Yugcontract Sync в WSL2 (systemd timer)"
Cohesion: 0.18
Nodes (10): 1. Установить таймер, 2. Проверить статус, 3. Запустить вручную (вне расписания), 4. Включить / выключить, 5. Удалить, 6. Где логи, Yugcontract Sync в WSL2 (systemd timer), Коды выхода лаунчера (+2 more)

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

### Community 125 - "admin-shipment-fk-fix-migration.test.ts"
Cohesion: 0.50
Nodes (3): code, root, sql

### Community 132 - "csp-enforcing.test.ts"
Cohesion: 0.25
Nodes (6): nextConfig, SUPABASE_HOST, allHeaders(), findHeader(), HeaderEntry, root

### Community 141 - "recently-viewed-storage.ts"
Cohesion: 0.30
Nodes (9): RecentlyViewedTracker(), MAX_RECENTLY_VIEWED, readRecentlyViewed(), RECENTLY_VIEWED_STORAGE_KEY, recordRecentlyViewed(), sanitizeRecentlyViewed(), UUID_RE, writeRecentlyViewed() (+1 more)

### Community 142 - "liqpay-config.ts"
Cohesion: 0.19
Nodes (16): POST(), supabase, parseBody(), POST(), supabase, buildCallbackUrl(), buildResultUrl(), detectLiqPayKeyMode() (+8 more)

### Community 151 - "orders"
Cohesion: 0.12
Nodes (11): public.admin_cancel_order(), public.admin_set_order_status(), public.expire_pending_orders(), public.expire_pending_orders(), public.admin_cancel_order(), public.admin_replace_shipment_plan(), public.admin_replace_shipment_plan(), public.admin_replace_shipment_plan() (+3 more)

### Community 152 - "ProductSpecifications.tsx"
Cohesion: 0.36
Nodes (5): ProductSpecifications(), ProductSpecificationsRow, sanitizeSpecRows(), componentSrc, root

### Community 153 - "liqpay-ui.test.ts"
Cohesion: 0.25
Nodes (6): btn, cb, init, orderPage, root, success

### Community 155 - "verify-product-categories.mjs"
Cohesion: 0.33
Nodes (3): count(), env, seen

### Community 156 - "nova-shipments-migration.test.ts"
Cohesion: 0.40
Nodes (3): code, root, sql

### Community 158 - "enforceRateLimit"
Cohesion: 0.10
Nodes (31): GET(), GET(), getNovaPostClient(), DIVISIONS_MAX_LIMIT, DIVISIONS_MIN_LIMIT, DivisionsQuery, findDivisions(), normalizeDivision() (+23 more)

### Community 161 - "reconciliation/page.tsx"
Cohesion: 0.24
Nodes (9): ALL_CLASSES, CLASS_LABELS, classTone(), CRITICAL_CLASSES, fetchReconciliationApi(), OrdersReconciliationAdminPage(), ReconciliationItem, ReconciliationReport (+1 more)

### Community 162 - "admin-guard-invariants.test.ts"
Cohesion: 0.29
Nodes (3): DOCUMENTED_GUARD_EXEMPTIONS, HTTP_METHODS, root

### Community 163 - "019_order_shipments.sql"
Cohesion: 0.18
Nodes (10): order_shipment_items, order_shipments, public.assert_shipments_cod_sum(), update_updated_at_column, trg_shipment_items_allocation, update_order_shipments_updated_at, order_shipment_parcels, update_updated_at_column (+2 more)

### Community 164 - "shipments.ts"
Cohesion: 0.18
Nodes (16): NovaPostClient, createShipment(), deleteShipmentByRef(), DeleteShipmentResult, findShipmentsByClientOrder(), isNovaPostError(), isRecord(), optString() (+8 more)

### Community 166 - "admin-reconciliation.test.ts"
Cohesion: 0.67
Nodes (3): pageSrc(), root, src()

### Community 168 - "Yugcontract Sync на Windows ПК (Task Scheduler)"
Cohesion: 0.18
Nodes (10): 0. Предусловия (один раз), 1. Установить задачу, 2. Проверить, что задача зарегистрирована, 3. Запустить вручную, 4. Где смотреть лог, 5. Временно отключить / включить, 6. Удалить задачу, 7. Если sync упал на полпути (+2 more)

### Community 169 - "favorites/page.tsx"
Cohesion: 0.10
Nodes (25): availabilityLabel(), CartPage(), EmptyState(), FavoriteButton(), availabilityLabel(), ProductCard(), ProductCardData, RecentProducts() (+17 more)

### Community 170 - "final_002_constraints_and_indexes.sql"
Cohesion: 0.33
Nodes (7): check_stock_update(), handle_brand_deactivation(), trigger_handle_brand_deactivation, trigger_validate_product_brand, validate_product_brand(), validate_product_stock, validate_variant_stock

### Community 171 - "categories"
Cohesion: 0.67
Nodes (3): product_categories, categories, categories_translations

### Community 172 - "products"
Cohesion: 0.16
Nodes (13): public.place_order(), case, loop, update_updated_at_column, update_orders_updated_at, public.place_order(), case, loop (+5 more)

### Community 175 - "nova-parcels-migration.test.ts"
Cohesion: 0.50
Nodes (3): code, root, sql

### Community 176 - "orders/page.tsx"
Cohesion: 0.27
Nodes (9): ALLOWED_TRANSITIONS, fetchOrderDetailsApi(), fetchOrdersApi(), formatDate(), ItemRow, OrderDetails, OrderListRow, OrdersAdminPage() (+1 more)

### Community 177 - "seo.ts"
Cohesion: 0.31
Nodes (9): buildCatalogViewMetadata(), CatalogIndexInput, CatalogViewMetadataArgs, decideCatalogIndexing(), IndexingDecision, SITE_NAME, truncateQuery(), ViewMetadata (+1 more)

### Community 178 - "Nova Post API — Courier delivery: `recipient.addressParts` / `settlementId`"
Cohesion: 0.22
Nodes (8): Evidence matrix (POST /shipments/calculations), Live-test scripts, Nova Post API — Courier delivery: `recipient.addressParts` / `settlementId`, Rules for Stage 2G (courier TTN creation), Sender address location (verified 2026-08-28, Кривий Ріг), Settlement linkage, TL;DR — working courier payload, Why plain city names fail

### Community 179 - "novapost-streets-route.test.ts"
Cohesion: 0.22
Nodes (6): g, NpTestGlobal, root, ROUTE, RouteModule, source

### Community 180 - "admin-shipment-parcel-cap-migration.test.ts"
Cohesion: 0.50
Nodes (3): code, root, sql

### Community 182 - "category-tree.ts"
Cohesion: 0.30
Nodes (10): AdminCategoryMultiSelect(), CategorySelect(), Category, buildCategoryOptions(), CategoryOption, compareCategories(), compareSiblings(), filterCategoryOptions() (+2 more)

### Community 184 - "schema-org.ts"
Cohesion: 0.21
Nodes (13): ProductJsonLd(), availabilityUrl(), BreadcrumbCategoryLike, buildProductBreadcrumbJsonLd(), buildProductJsonLd(), ProductLike, ReviewSummaryLike, serializeJsonLd() (+5 more)

### Community 186 - "rate-limit-xff.test.ts"
Cohesion: 0.33
Nodes (3): root, source, SOURCE_PATH

### Community 189 - "tmp-verify-orders-revoke.mts"
Cohesion: 0.40
Nodes (3): anon, root, service

### Community 190 - "requireAdminApi"
Cohesion: 0.13
Nodes (16): DELETE(), GET(), POST(), GET(), sanitizeSearchTerm(), STATUSES, ACTION_TO_STATUS, DELETE() (+8 more)

### Community 192 - "tmp-verify-live-payment.ts"
Cohesion: 0.40
Nodes (3): DO_LIQPAY, root, svc

### Community 193 - "CheckoutForm.tsx"
Cohesion: 0.15
Nodes (15): CheckoutForm(), DELIVERY_TYPES, DeliveryType, fetchDivisionsApi(), isLockerCategory(), NpDivision, NpSettlement, NpStreet (+7 more)

### Community 199 - "admin-shipment-courier-address-migration.test.ts"
Cohesion: 0.40
Nodes (3): code, root, sql

### Community 205 - "tmp-f6-premigration.ts"
Cohesion: 0.40
Nodes (3): c, mainCnt, rows

### Community 215 - "api/orders/route.ts"
Cohesion: 0.29
Nodes (8): POST(), supabase, POST(), SanitizedItem, sanitizeShippingInfo(), supabase, sendTelegramOrderNotification(), orderAccessToken()

### Community 220 - "tmp-verify-015-reviews.mts"
Cohesion: 0.40
Nodes (3): anon, root, service

## Knowledge Gaps
- **941 isolated node(s):** `$schema`, `.opencode/plugins/graphify.js`, `metadata`, `revalidate`, `metadata` (+936 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **50 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `requireAdminApi()` connect `requireAdminApi` to `admin-list.ts`, `isUuid`, `delivery-cost.ts`, `ttn/route.ts`, `reconciliation.ts`, `products/route.ts`, `yugcontract/categories/route.ts`, `[imageId]/route.ts`, `admin-shipments.ts`, `images/route.ts`, `preview/route.ts`, `orders/[id]/route.ts`, `import-run.ts`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Why does `enforceRateLimit()` connect `enforceRateLimit` to `delivery-cost.ts`, `FeedbackModal.tsx`, `yugcontract/categories/route.ts`, `liqpay-config.ts`, `products/page.tsx`, `preview/route.ts`, `api/orders/route.ts`, `ReviewFormModal.tsx`, `import-run.ts`, `errors.ts`, `requireAdminApi`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **Why does `CartPreviewLine` connect `favorites/page.tsx` to `CheckoutForm.tsx`, `products/page.tsx`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **What connects `$schema`, `.opencode/plugins/graphify.js`, `metadata` to the rest of the system?**
  _941 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `order-payment-update.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11384615384615385 - nodes in this community are weakly interconnected._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.04081632653061224 - nodes in this community are weakly interconnected._
- **Should `tmp-audit-readonly.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05110336817653891 - nodes in this community are weakly interconnected._