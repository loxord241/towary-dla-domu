# SEO-пакет storefront — дизайн (2026-08-26)

## Контекст и цель

Закрыть SEO-пробелы storefront TOWARY DLA DOMU: уникальные metadata, canonical/noindex
политика, расширение sitemap, robots, H1-invariants, настоящий HTTP 404 (F14),
Product JSON-LD, тесты. Бизнес-логика, БД (0 записей), importer, checkout, orders,
auth, cart, RLS — не затрагиваются.

## Фактическое состояние (проверено live next start + curl 2026-08-26)

Уже работает:
- `/product/[nonexistent]` → **HTTP 404** (блокирующий рендер, нет loading/Suspense
  в сегменте → notFound() успевает выставить статус до стрима). F14 для товаров
  уже закрыт; заметка в PROJECT_CONTEXT «HTTP 200» устарела.
- Product page: generateMetadata с санитизацией description, H1 = name.
- Catalog: generateMetadata per-view + один H1 per view.
- robots.ts (static+categories в sitemap.ts), info-страницы с уникальными title,
  глобальный not-found (404 на /no-such-route).

Пробелы: home наследует общий layout-title; canonical отсутствует везде;
search/filter/pagination индексируются свободно; sitemap без брендов/товаров;
robots не закрывает /cart и /favorites; cart/favorites/orders/lookup ('use client')
без noindex; JSON-LD нет; /catalog?category=bogus → 200 пустой сетки без hygiene.

## Решения (согласованы)

### A. Семантика невалидного category/brand slug → 200 empty-state
Category/brand — параметры фильтра существующего ресурса /catalog (отдельных
маршрутов нет). Задача допускает empty-state 200 для фильтров. Технический довод:
у /catalog есть loading.tsx → ответ стримится со статусом 200 до выполнения кода
страницы; настоящий 404 потребовал бы DB-проверку в proxy (latency на каждый
листинг) или удаление loading-UI (UX-регрессия) — отвергнуто. Индексная гигиена —
через canonical/noindex (решение B).

### B. Canonical/noindex политика (pure-функции app/lib/seo.ts)
Индексируемый набор ≡ набор URL в sitemap:

| URL | canonical | robots |
|---|---|---|
| / | self | index |
| /catalog | self | index |
| /catalog?category=X | self | index (валидный slug, page≤1, без прочих фильтров) |
| /catalog?brand=Y   | self | index (аналогично) |
| ?q=… непустой      | —    | noindex, follow |
| любые комбинации (2+ фильтра, price, stock, sort≠default, page>1) | — | noindex, follow |
| невалидный/inactive slug категории/бренда | — | noindex, follow |

Правило: canonical эмитируется ТОЛЬКО на индексируемых страницах (на noindex
страницах Google его игнорирует — не эмитим во избежание противоречивых сигналов).
Search query в metadata: sanitizeSearchTerm() + strip контрольных символов +
обрезка (title ≤ ~60 суммарно, q ≤ 50); React экранирует text-children (XSS-safe).

### C. Sitemap: static + категории + бренды + товары
- Товары: paged SELECT окнами ≤1000, `.order('id')` tiebreaker, whitelist колонок
  `slug, updated_at`, eligibility зеркалит storefront (`images:product_images!inner(id)`,
  `is_active=true`). Скрытые (без фото)/неактивные товары НЕ попадают.
- Бренды: fetchActiveBrands → `/catalog?brand=<slug>`.
- Категории: существующая логика `/catalog?category=<slug>`.
- ~4600 URL < 50000 → один файл без generateSitemaps.
- Пагинация вынесена в `app/lib/seo-sitemap.ts` с инжект-функцией fetchPage
  (unit-testable без Supabase); sitemap.ts только wire-ит реальный клиент.
- lastmod из реальных updated_at.

### D. robots.ts
Добавить `Disallow: /cart`, `/favorites`. Остальное (/admin, /api/, /checkout,
/orders/) уже закрыто; CSS/JS/images не блокируются (allow /).

### E. noindex технических маршрутов
- checkout/page.tsx (+ success): добавить `robots:{index:false,follow:false}`.
- admin/(dashboard)/layout.tsx + admin/login: то же.
- client-страницы cart, favorites, orders/*: минимальные segment-layout.tsx
  с тем же metadata (канонический App Router способ). Для /orders достаточно
  ОДНОГО app/orders/layout.tsx — он покрывает и lookup, и [orderNumber]
  (layout применяется ко всем вложенным сегментам).

### F. Structured data: Product JSON-LD
- `app/lib/schema-org.ts`: pure buildProductJsonLd(product, reviewSummary|null)
  → объект или null. Только реальные поля БД: name, image (getPublicImageUrls),
  plain-text description (strip HTML, cap 5000), sku, brand.name (если есть),
  offers при Number.isFinite(price)&&price>0: price, priceCurrency (значение
  products.currency как в БД), availability-маппинг реальных статусов
  (in_stock→InStock, out_of_stock→OutOfStock, иначе LimitedAvailability),
  url = canonical товара. aggregateRating ТОЛЬКО при summary.total>0 &&
  average!=null (ratingValue=average, ratingCount=total).
- `app/components/ProductJsonLd.tsx`: <script type="application/ld+json">
  dangerouslySetInnerHTML = JSON.stringify(...).replace(/</g,'\\u003c') —
  защита от </script>-breakout. Инвариант-тест product-description («ровно 1
  usage») обновляется на allowlist ровно 2 санкционированных sink'ов
  (ProductDescription, ProductJsonLd).
- Не выдумываем: availability/rating/count/brand/sku/priceCurrency значения.

### G. Metadata-полировка
- home: экспорт metadata — уникальный title/description/openGraph (uk строки).
- category: `${name} — купити в E-Shop`; brand: `${name} — купити в E-Shop`;
  description из реального имени, без выдуманных характеристик.
- search title: `Пошук: «<sanitized≤50>» | E-Shop`.
- product OG: добавить locale/siteName (сейчас теряются shallow-merge'ом).
- catalog base: title/description сохраняются.

### H. H1-invariants
Существующие H1 корректны (home=1, catalog per-view, product=name). Закрепляются
статическими тестами: по одному `<h1` литералу в (home)/page, catalog/page,
product/[slug]/page, not-found; InfoPage — единственный h1-источник info-страниц.

## Файлы

Новые: app/lib/seo.ts, app/lib/seo-sitemap.ts, app/components/ProductJsonLd.tsx,
app/cart/layout.tsx, app/favorites/layout.tsx, app/orders/layout.tsx,
tests/seo-*.test.ts.
Изменяемые: app/(home)/page.tsx, app/catalog/page.tsx, app/product/[slug]/page.tsx,
app/sitemap.ts, app/robots.ts, app/checkout/page.tsx, app/checkout/success/page.tsx
(или layout), app/admin/(dashboard)/layout.tsx, app/admin/login/page.tsx,
tests/product-description.test.ts, PROJECT_CONTEXT.md (отчётный этап).

## Ограничения

- Playwright недоступен в среде (нет chrome/system libs) — верификация через
  next start + curl (status/title/canonical/H1/robots/JSON-LD), честно отражено.
- Стриминговые soft-404 (200+noindex) остаются возможными для будущих
  Suspense-wrapped страниц — задокументировано в спецификации Next этой версии.
- БД: 0 INSERT/UPDATE/DELETE/migrations; только read-only SELECT anon-клиентом.

## Верификация

npm test; npx tsc --noEmit; npm run lint; npm run build; next start +
curl-матрица: /, /catalog, ?q=, ?category=valid, ?brand=valid, /product/valid,
/product/nonexistent, технические страницы, robots.txt, sitemap.xml.
