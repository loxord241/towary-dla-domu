# Priority 2 UX/UI: Mobile Catalog + Product Page — дизайн (2026-08-26)

## Область

Только НОВАЯ работа. Пункты 1–5 GO (mobile sheet-фильтры, CategorySelect,
ссылки бренд/категория, main landmark, gallery priority) УЖЕ реализованы
ранее (этап 11 / UX-аудит) и проверены по коду 2026-08-26 — не трогаются.

## A. «Схожі товари» (related products)

- `app/lib/catalog.ts`:
  - `export const RELATED_LIMIT = 8`.
  - `fetchRelatedProducts(product: Pick<Product,'id'|'category_id'|'brand_id'>, limit = RELATED_LIMIT): Promise<Product[]>`
    — до ТРЁХ параллельных bounded-чтений (каждое — одно окно
    `range(0, limit-1)`): ① та же категория (`eq category_id`), ② тот же
    бренд (`eq brand_id`), ③ новейшие (без фильтра). Все стадии зеркалят
    storefront-eligibility (`PRODUCT_SELECT`, `is_active`, `images!inner`)
    и исключают текущий товар (`neq id`). Порядок внутри стадии —
    `created_at desc, id desc` (детерминизм как в F1/F4).
  - `collectRelated(groups: Product[][], currentId: string, cap = RELATED_LIMIT): Product[]`
    — PURE слияние: порядок групп = приоритет (категория → бренд → новые),
    дедуп по id, пропуск currentId, cap. Единственный источник порядка.
  - Стадии без category_id/brand_id пропускаются; ошибки чтения
    пробрасываются наверх (страница сама решает деградацию).
- `app/components/RelatedProducts.tsx` (server): h2 «Схожі товари», сетка
  `grid-cols-2 lg:grid-cols-4` (как «Популярні товари»), переиспользует
  ProductCard; `return null` при пустом списке (блок скрыт полностью).
- Product page: try/catch вокруг fetchRelatedProducts (паттерн отзывов:
  сбой чтения → пустой блок + console.error, страница живёт); вставка
  между блоком «Варіанти товару» и «Відгуки».

## B. Delivery-CTA на странице товара

Компактный блок в правой карточке товара под AddToCartButton: заголовок
«Доставка та оплата», одна строка «Умови доставки та оплати — на сторінці…»
+ Link на `/delivery`. Никаких выдуманных фактов об оплате/сроках.

## C. LCP карточек каталога/главной

`ProductCard` получает опциональный `priority?: boolean` (default false —
все прочие изображения остаются lazy). Wiring: главная — первые 4 featured;
каталог — первые 6 (два ряда на md). Popular/Related/recent — lazy.

## D. Инварианты и тесты

- Новый `tests/related-products.test.ts`: pure collectRelated (приоритет
  групп, dedupe, currentId, cap), статические bounded/eligibility
  инварианты fetchRelatedProducts, компонентные проверки (h2 не h1,
  скрытие при пустоте, переиспользование ProductCard).
- LCP: ProductCard priority-prop passthrough + wiring counts (home 4 /
  catalog 6) — source-level.
- Main landmark: ровно один `<main` в product page; SiteHeader/SiteFooter
  — ноль.
- Все существующие 423 теста сохраняются (h1-invariants и dangerouslySet-
  InnerHTML sink-инвариант не затронуты: RelatedProducts использует h2).

## Границы

БД: только read-only SELECT (≤3 окна ≤8 строк на просмотр товара), БЕЗ
миграций/RPC/новых таблиц. Не трогаются: checkout/orders/auth/RLS,
importer, отзывы, recently viewed, popular products, SEO-пакет, Priority 3.

## Верификация

npm test; npx tsc --noEmit; npm run lint; npm run build; next start +
curl (product page: блок «Схожі товари» с реальными товарами, delivery-CTA,
один main, lazy/priority разметка). Playwright недоступен в среде —
браузерная проверка не выполняется (честно в отчёте).
