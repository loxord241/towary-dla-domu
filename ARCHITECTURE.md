# ARCHITECTURE — TOWARY DLA DOMU

Фактическая архитектура репозитория по состоянию на **2026-09-16**, подтверждённая
кодом/конфигурацией/миграциями, а не пересказом старой документации. Каждый раздел
опирается на перечисленные источники. То, что не удалось подтвердить кодом, помечено
`UNKNOWN` и собрано в конце.

Правила для агентов — в [AGENTS.md](AGENTS.md); история этапов и инцидентов — в
[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md). Этот документ — про то, «как устроено», а не
«как работать».

## 1. Что это

Двухдоменный интернет-магазин (укр. контент):
- **Бытовая техника** — поставщик Yugcontract (B2B фид), витрина `/catalog`;
- **Шпалеры (обои)** — отдельный домен, sku `wc-*`, витрина `/oboi`, остатки из 1С 7.7 владельца.

Продажи 100% онлайн через LiqPay (после оплаты заказ обрабатывает менеджер).
Гостевой чекаут без регистрации; единственные пользователи Supabase Auth — админы.

## 2. Стек и runtime

Источник: `package.json`.

- **Next.js 16** (`^16.3.5`, App Router, Turbopack), React 19, TypeScript.
- **Tailwind CSS v4** (только `@tailwindcss/postcss`, без tailwind.config).
- **Supabase**: `@supabase/supabase-js` + `@supabase/ssr` (cookie-сессии).
- **sanitize-html** — единственная содержательная runtime-зависимость.
- Тесты: `node --test` (stdlib), без тестовых фреймворков.
- Скрипты: `dev` / `build` / `start` / `lint` (eslint 9) / `test` / `restart`
  (bash-обёртка `scripts/dev-restart.sh`).
- Node 24 (нативный TS strip-types используется и тестами, и CLI-скриптами).
- Dev-машина: Windows (основной чекаут `C:\projects\my-shop`), WSL Ubuntu — холодный
  резерв. Git Bash не имеет `flock` — bash-лаунчер синка падает с exit 44, на Windows
  используется PowerShell-лаунчер (см. §12).

## 3. Карта репозитория

```
app/                  App Router: витрина, админка, API, lib
  (home)/, about/, catalog/([category]), product/[slug], cart/, favorites/,
  checkout/(success), orders/(lookup,[orderNumber]), oboi/, delivery/, contacts/,
  samovyviz/, privacy/, returns/, terms/, admin/(login,(dashboard)), feeds/
  api/                см. §5; app/lib/ см. §4
components/           SiteHeader/Footer, ProductCard/Gallery, фильтры и пр.
proxy.ts              edge-функция вместо middleware (см. §6)
next.config.ts        security headers + CSP (enforcing), redirects() из
                      app/lib/du-redirects.json, images
database/migrations/  final_001–002 (базовая схема) + 003–051; применяются ВРУЧНУЮ
                      (SQL Editor); DDL из кода недоступен
scripts/              CLI: импортеры, health-check, генераторы, лаунчеры синков
tests/                node --test, 204 файлов / ~2351 теста
docs/                 аудиты, research, specs (docs/superpowers/specs/), памятки миграций
graphify-out/         граф знаний кода (в git; обновляется `graphify update .`)
vercel.json           cron: /api/cron/reconciliation 06:00 UTC, /api/cron/wallpaper-freshness 15:00 UTC
.github/workflows/    yugcontract-sync.yml — вооружён (cron 6ч), но GO-затвор
                      vars.YUGCONTRACT_SYNC_ENABLED никогда не включался: 0 успешных запусков
data/                 gitignored: ключи ingestion, CSV 1С, items-JSON
logs/                 gitignored: логи лаунчеров, baseline-ack'и health-check
```

Устаревший/нерелевантный документ: `README.md` — стоковый boilerplate
create-next-app, не описывает проект.

## 4. Server-side библиотеки (`app/lib/`)

- `catalog.ts` + `catalog/` (listing, search, filters, counts, related, shelves,
  reviews, slug-lookup, product-feed) — ЕДИНСТВЕННЫЙ источник данных витрины;
  анонимный клиент + RLS. Пагинация: `CATALOG_PAGE_SIZE=12`, cap 50, серверные
  searchParams, tiebreaker `.order('id')` на всех сортировках (уроки этапа 3/9).
- `admin-api.ts` — `requireAdminApi()` (401/403/200), валидаторы, `dbErrorResponse`
  (без утечки internals). ВСЕ `/api/admin/*` начинаются с него.
- `admin-list.ts` — общий пайплайн админ-списков (поиск ДО пагинации, sort-whitelist).
- `cart-*` / `favorites-*` — санитайзеры localStorage (unit-tested) + контексты;
  `cart-preview.ts` — клиентский fetch с таймаутом 12с + dispose (never-stuck).
- `order-token.ts` — HMAC-SHA256 capability-токены гостевых страниц заказов.
- `rate-limit.ts` — in-process sliding window (IP+route): быстрый префильтр.
- `rate-limit-shared.ts` — АВТОРИТЕТНЫЙ cross-instance лимитер (миграция 047,
  2026-09-13, owner-approved «общий лимитер»): решение в Postgres
  (rate_limit_hits + RPC), вместо IP хранится его HMAC; при сбое RPC —
  fail-open, решение остаётся за in-process слоем.
- `payment/` — LiqPay: config, signature, status/status-api, order-payment-update,
  reconciliation + reconciliation-scan.
- `delivery/` — `novapost/` (server-only клиент, strict whitelist парсинг, fail-closed)
  и `ukrposhta/` (клиент, classifier-парсеры, delivery-cost).
- `yugcontract/` — jwt (HS256, node:crypto), client (token-cache ~1ч, retry при 401),
  normalize (runtime-коэрция), selection (категории), import-plan/import-run,
  content-{dry-run,sanitize,staging,import,images}, category-remap, content-du-mapping.
- `wallpapers/` — parse (1C CSV), categories, import-plan, photo-sources (slav-правило),
  roll-math (расчёт рулонов), filters, title.
- `monitoring/catalog-health.ts` — пороги/анализ для `scripts/catalog-health-check.ts`.
- `notifications/telegram.ts` — уведомления о заказах (server-only, never-throw).
- `seo.ts` / `seo-sitemap.ts` / `schema-org.ts` — canonical/noindex-политика,
  пагинированный sitemap, JSON-LD.
- `du-redirects.ts` + `du-redirects.json` — СГЕНЕРИРОВАНЫ
  `scripts/yugcontract-du-redirect-allowlist.ts` (не редактировать руками).
- `domains.ts` — единый источник «шпалеры vs техника» (sku-префикс `wc-`).
- `description-generator.ts` — локальная текстовая генерация описаний/черновиков,
  БЕЗ внешних AI API (ключей в env нет).
- `merchant-feed.ts` — данные для `/feeds/google-merchant.xml` (ISR 3600).

## 5. API routes (`app/api/**/route.ts`) — фактический список

Публичные: `cart-preview`, `catalog-dictionaries` (ISR 300), `search/suggest`,
`reviews`, `feedback`, `products/callback-request`, `products/restock-notify`,
`orders` (checkout POST), `orders/lookup`, `orders/[orderNumber]/payment`,
`payment/liqpay/callback`, `delivery/novapost/{delivery-cost,divisions,settlements,streets}`,
`delivery/ukrposhta/{delivery-cost,offices,settlements}`, `telegram/webhook`,
`feeds/google-merchant.xml`, `ingest/1c-wallpaper` (bearer `WALLPAPER_INGEST_SECRET`),
`cron/{reconciliation,wallpaper-freshness}` (bearer `CRON_SECRET`).

Админские (все через `requireAdminApi()`): `admin/{announcements,brands,brands/[id],
categories,categories/[id],categories/[id]/order,descriptions,feedback,orders,
orders/[id],orders/[id]/mark-paid,orders/[id]/shipments(+calculate,ttn,manual-ttn),
orders/expire,orders/reconciliation,products,products/[id],products/[id]/images(+[imageId]),
products/[id]/variants(+[variantId]),reviews,reviews/[id],yugcontract/{categories,preview,
import/{start,run,status}}}`.

## 6. Роутинг, рендеринг, кэш

Источник: страницы в `app/`, `proxy.ts`, grep `revalidate`.

- **`proxy.ts`** (замена deprecated middleware) делает ТРИ вещи:
  1) канонизирующие 308-редиректы и ISR-рерайты категорий `/catalog` (включая
     фильтрованные view на ISR-страницу через `catalog-paths.ts`);
  2) ISR-рерайты `/oboi`;
  3) auth-гейт `/admin/:path*` (сессия Supabase через cookie client).
  КАЖДЫЙ не-admin путь обязан вернуть ответ ДО админ-гейта.
- ISR: home `revalidate=60`, `/catalog/[category]` `60`, sitemap `86400`,
  merchant feed `3600`, dictionaries API `300`. Инвалидация — `revalidateTag
  ('catalog-public-reads', 'max')` из админ-мутаций.
- Пагинация каталога — серверная (searchParams); `notFound()` на несуществующих
  slug отдаёт настоящий HTTP 404 (сегмент без loading/Suspense).
- `robots.ts`: закрыты admin/api/checkout/orders/cart/favorites; sitemap —
  static + непустые категории/бренды + ВСЕ eligible-товары
  (is_active + ≥1 фото, контракт «indexable set = sitemap set»).

## 7. Supabase / PostgreSQL

Источник: `database/migrations/` (final_001–002 + 003–051), PROJECT_CONTEXT (сверено с живой БД 2026-08/09).

- **Два клиента**: анонимный (RLS) для витрины — только через `app/lib/catalog.ts`;
  service-role — только server-side (API routes, CLI-скрипты), никогда в `'use client'`.
- **RLS/гранты — текущая позиция (миграции 014, 024, 032, 033, 035, 036, 039)**:
  anon/authenticated имеют SELECT только по публичному каталогу (RLS-политики
  «активные сущности»); DML/TRUNCATE отозваны на всех таблицах; SELECT на
  orders/order_items/customers/product_stock_history отозван (42501); EXECUTE на
  place_order отозван (см. §8). Новые таблицы: сразу RLS + явные гранты — миграция
  final_001 содержит `ALTER DEFAULT PRIVILEGES ... GRANT SELECT TO public` (footgun).
- **Основные таблицы**: products (+brand_id, yugcontract_id UNIQUE partial,
  specifications JSONB array, availability_status), categories, brands,
  product_categories (junction, 016), product_images (UNIQUE (product_id, image_url),
  012; external URL hotlink b2b.yugcontract.ua), product_variants,
  product_stock_history (каскад по products), product_reviews (015) +
  product_review_summary RPC (029), feedback (013), store_announcements (031, 039),
  restock_requests (042, FK-cascade 043), rate_limit_hits (047),
  np_status_cache (048), category_seo_texts (049/051),
  description_drafts (050), admin_users, customers, orders (+order_number UNIQUE,
  payment_status, liqpay_payment_id UNIQUE 034, prepayment_amount — заготовка,
  кодом не пишется), order_items, liqpay_payments (017), order_shipments(+items,
  parcels; 019–023, 026, 038 ukrposhta), yc_import_batches, yc_content_goods,
  yc_content_batches (010/011), wallpaper_stock_staging (041), attributes /
  attribute_values / product_attribute_values (унаследованный EAV из final_001;
  витриной и импортом не используются — контент живёт в products.specifications).
- **Миграции применяются вручную** через SQL Editor (psp/CLI/DATABASE_URL нет);
  `database/migrations` сверены с живой БД.

## 8. Checkout / Orders / Payments

Источник: `app/api/orders/route.ts`, `app/lib/payment/`, миграции 006–008, 017, 018,
030, 034, 045; PROJECT_CONTEXT (live-верификации 2026-08).

- POST `/api/orders` принимает ТОЛЬКО контакты + идентификаторы/количество;
  цены/сток/итоги считает исключительно `place_order()` (SECURITY DEFINER,
  lock → validate → цены из БД → upsert customer → order+items → декремент стока
  → stock history). Опциональный `Idempotency-Key` (030).
- **С 036 RPC зовётся SERVICE-ROLE клиентом из route** (rate-limit 3/min, 10/h по IP
  живёт в route; прямой анонимный вызов RPC закрыт REVOKE). Deploy-порядок «код до
  036» задокументирован в самом route.
- Оплата: LiqPay 100% онлайн. Callback `payment/liqpay/callback` проверяет подпись
  и атомарно (conditional UPDATE `.neq('status','cancelled')`) ставит paid —
  interlock 018 исключает paid у отменённых и гонку с expiration. Есть LIQPAY_SANDBOX
  флаг, status API, reconciliation (cron 06:00 + admin/reconciliation).
- Ручные методы оплаты (manual-paid-methods.ts) → админский `mark-paid`.
- Истечение pending 24ч: pg_cron job `expire-pending-orders` (008, SKIP LOCKED) +
  admin/orders/expire. Номер заказа `ORD-YYYYMMDD-XXXXXX`, collision-retry.
- Отмена: `admin_cancel_order` — атомарный возврат стока, double-restock невозможен;
  forward-only карта статусов `admin_set_order_status`.

## 9. Delivery

- **Nova Post** (019–023, 026): планирование отгрузок (PUT replace-all через
  `admin_replace_shipment_plan`), расчёт стоимости (persist только
  `delivery_cost_estimated`), ТТН склад/курьер с защитой от дублей (pre-check GET
  по clientOrder → POST 1 раз → reconcile; rollback DELETE по Ref). Курьерский
  POST /shipments НЕ live-тестировался (sandbox-репетиция обязательна до первого
  реального курьерского заказа).
- **Ukrposhta** (038): клиент + classifier-парсеры, delivery-cost/offices/settlements
  роуты, поля укрпочты в order_shipments.
- **Самовывоз** (samovyviz) — страница витрины.

## 10. Auth & Admin

- Supabase Auth, сессии в cookies через `@supabase/ssr` (getAll/setAll), проверка
  только `getUser()`; email админа — case-insensitive (ilike).
- Гейт: `proxy.ts` для `/admin/*` + `requireAdminApi()` на каждом admin-handler +
  `(dashboard)/layout.tsx` проверяет user ∈ admin_users.
- Leaked Password Protection включена владельцем 2026-09-16 (Dashboard →
  Providers → Email; Pro-фича, программно состояние не экспонируется).
- Разделы админки: announcements, brands, categories, descriptions, feedback,
  images, orders, products (+images, variants), variants, yugcontract.
  **Модерация отзывов — только через API** (`admin/reviews`), UI-страницы в
  админке нет (проверено find по app/).

## 11. Витрина: отзывы, объявления, restock

- Отзывы: публичный POST `/api/reviews` + `ProductReviews`/`ItemReviewForm`;
  агрегат — RPC `product_review_summary` (только при total>0 попадает в JSON-LD).
- Store announcements (031): админский CRUD + `revalidateTag`; таблица закрыта
  грантами (039).
- Restock (042): «сообщить о появлении» + cron-независимый notify.
- Обратный звонок: `products/callback-request`.

## 12. Поставщики: импорт и синк

### Yugcontract (техника)
- B2B API: `app/lib/yugcontract/{jwt,client,normalize,types}.ts`; ключи только
  server-side env (`YUGCONTRACT_*`).
- **Фаза 1 товары/цены**: `scripts/yugcontract-import-run.ts --plan|--run[--resume]`
  (тот же код-путь, что admin API import/start|run|status); чекпоинты
  yc_import_batches; identity = yugcontract_id; slug/is_active существующих не
  трогаются; 48h-гейт по последнему 'done' батчу внутри import-run.
- **Фаза 2 контент**: fetch → staging (санитизация sanitize-html на этапе FETCH,
  сырой HTML нигде не хранится) → apply батчами ≤200 (description + specifications).
- **Фаза 3 изображения**: hotlink внешних URL (host b2b.yugcontract.ua, allow-list
  расширений) в product_images; is_main-переупорядочивание demote-before-promote.
- **Категории**: дерево get-categories, remap-инфраструктура
  (category-remap.ts), журнал вставок категорий мониторится health-check'ом.
- **`_du`-дубли**: allowlist генерируется скриптом (см. §17), все пары 301-редиректят
  на базу; price-diff подмножество документируется в DU_PRICE_DIFF_PAIRS.
- **Лаунчеры**: WSL `bash scripts/wsl/yugcontract-sync.sh` (flock+лог+48h stamp) и
  Windows `scripts/windows/yugcontract-sync.ps1` (File::Open lock, тот же stamp).
  Ручной режим — по команде владельца; авто-синк отключён с инцидента 2026-09-05.

### Шпалеры 1С (ежедневно, вручную от владельца)
- Владелец присылает `.xls` → конвертер (python + xlrd через PYTHONPATH) →
  POST `/api/ingest/1c-wallpaper` (CSV, X-Export-Date, bearer `WALLPAPER_INGEST_SECRET`)
  → staging (041) → `scripts/wallpaper-import.ts --plan|--run` (идемпотентный,
  diff-aware; «исчез из выгрузки» = остаток 0; is_active синком НЕ пишется) →
  `--publish` (ЕДИНСТВЕННЫЙ писатель is_active: с фото → активен).
- Фото/характеристики: `scripts/wallpaper-photos.ts` (sources: slav — единственный
  разрешённый для артикулов без латиницы без проверенного `--url-map`).
- Свежесть: cron wallpaper-freshness (15:00 UTC) — Telegram-алерт, если выгрузка
  старше 26ч.

## 13. Уведомления и наблюдаемость

- Telegram: уведомление о заказе через `after()` строго ПОСЛЕ commit place_order
  (never-throw, at-most-once); webhook `telegram/webhook` — one-tap действия по
  заказу из уведомления (secret header, всегда 200 — Telegram ретраит не-2xx).
- Health: `scripts/catalog-health-check.ts` (read-only, PASS/WARN/FAIL = 0/1/2) —
  сток-новинки, feed-liveness (+baseline ack в logs/), _du-drift, батчи, pending.
- Baseline-файлы и логи — в gitignored `logs/`.
- Аналитика: GA4 + MS Clarity (публичные id), события поиска (hasResults,
  PII-фильтр query), `scripts/zero-result-report.ts` (Vercel Web Analytics API —
  OData-фильтры только с кавыченными литералами).

## 14. Security boundaries (сводка)

- CSP enforcing + security headers (nosniff, Referrer-Policy, XFO, Permissions-Policy,
  HSTS, COOP/CORP) — `next.config.ts`; `unsafe-inline` для script/style задокументирован
  (nonce сломал бы ISR).
- Секреты — только server-side env (`.env.local`, gitignored): SUPABASE_SERVICE_ROLE_KEY,
  YUGCONTRACT_*, NOVA_POSHTA_API_KEY, TELEGRAM_*, CRON_SECRET,
  WALLPAPER_INGEST_SECRET, LIQPAY_*; публичные — NEXT_PUBLIC_*.
- Rate-limit двухслойный: in-process префильтр + авторитетный Postgres-лимитер
  (047, HMAC-IP, fail-open). Checkout 3/min+10/h, lookup 5/min+20/h, cart-preview
  120/min.
- Гостевые страницы заказов — HMAC token (constant-time verify), проекция белым
  списком колонок.
- Upload: MIME allow-list + магические байты + 5MB + санитизация имени; bucket
  product_images публичное чтение/запись закрыта (025).
- Все внешние провайдерские данные парсятся strict whitelist (Nova Post, Ukrposhta,
  Yugcontract normalize); поставщику не доверяем.

## 15. Тесты

- `npm test` = `node --test tests/*.test.ts`: 204 файла, ~2351 теста, ~6с.
- Три стиля: pure-юниты (планировщики, санитайзеры), статические инварианты
  (regex-пины исходников: pagination, CSP, h1, dangerouslySetInnerHTML allowlist —
  ровно 4 sink'а), runtime-тесты против fake-PostgREST (реальный supabase-js).
- Браузерные e2e в CI НЕТ; Playwright используется ad-hoc (chromium установлен
  локально).

## 16. Established decisions (фактические, не предлагать «улучшения» без GO)

1. Единая точка данных витрины — `app/lib/catalog.ts` (аноним + RLS); service-role
   только server-side.
2. place_order — единственный писатель заказов; цены только из БД; с 036 вызывается
   service-ролью из route.
3. «is_active» витрины шпалер пишет только `wallpaper-import --publish`.
4. Изображения Yugcontract — hotlink (не зеркалирование); getPublicImageUrl
   пропускает http(s) как есть.
5. specifications — JSONB array; описания — sanitized HTML, рендер ровно в 4
   санкционированных dangerouslySetInnerHTML (ProductDescription,
   ProductJsonLd, FaqJsonLd, OrganizationJsonLd — allowlist закреплён
   инвариант-тестом).
6. Pagination ≤1000 + `.order(id)` tiebreaker на всех multi-page чтениях
   (инвариант-тесты; урок молчаливого cap 1000).
7. Поиск: sanitizeSearchTerm (PostgREST-спецсимволы), embed-фильтры не работают
   внутри or= (резолв UUID заранее) — этап 10.
8. `_du`-политика 2026-09-12: ВСЕ пары редиректят на базу; allowlist только
   генерацией.
9. Цена = РРЦ (rrp), old_price всегда null; товары без RRP не создаются.
10. Переводы (uk-таблицы) удалены из кода 2026-08; таблицы в БД оставлены пустыми.
11. Migrations применяются вручную (SQL Editor), файлы нумеруются последовательно.
12. Авто-синк Yugcontract отключён с 2026-09-05 (после инцидента поставщика);
    синк по команде через лаунчеры с 48h-гейтом.
13. window caching: ISR-интервалы из §6 + revalidateTag('catalog-public-reads').
14. Rate-limit: авторитетное решение в Postgres (047), in-process — префильтр;
    fail-open при недоступности БД (checkout не должен падать от сбоя лимитера).
15. SEO-пакет 2026-09-16: непустые combo-вьюхи «категория+бренд» каталога
    индексируются — canonical `/catalog/<cat>?brand=<brand>`, joint-count
    гейтит совместно-пустые пары (fetchCategoryBrandProductCount); инвариант
    «indexable set = sitemap set» временно сужен до «sitemap ⊆ indexable»
    (включение combo в sitemap — решение владельца pending; при отказе combo
    возвращаются в noindex). Также: hasMerchantReturnPolicy в Product JSON-LD,
    WebSite-сущность (Google Site names), g:additional_image_link (до 10) в
    Merchant-фиде.

## 17. Constraints / Do not change casually

Без доказанной необходимости и явного GO владельца не трогать:

- **RLS/гранты/EXECUTE** (014, 024, 032, 033, 035, 036, 039) — каждое изменение
  = security boundary; final_001 auto-grant SELECT TO public — известный footgun.
- **place_order() и контракт POST /api/orders** — money path; клиент шлёт только
  идентификаторы.
- **LiqPay callback** — условный UPDATE + interlock с отменой/expiration (018, 034).
- **Декремент/возврат стока** — только через place_order/admin_cancel_order;
  history-строки обязательны.
- **Пагинационные инварианты** (≤1000 + order) — нарушают молча.
- **dangerouslySetInnerHTML — только 4 sink'а allowlist'ом** и sanitize на
  этапе fetch — XSS-граница.
- **Rate-limit'ы checkout/lookup** (036 связан с ними).
- **next.config redirects() ↔ du-redirects.json** — только регенерацией скрипта.
- ** eligibility-контракт витрины/sitemap** (is_active + ≥1 фото images!inner).
- **Порядок deploy**: код чекаута до применения revoke-миграций (см. шапку 036).
- **Kлючи в `data/` и `.env.local`** — не печатать в чат/логи (инцидент с PAT).

## 18. UNKNOWN (не подтверждено кодом на дату аудита)

- План Supabase (Free/Pro) — влияет только на доступность Pro-фич дашборда;
  Leaked Password Protection владельцем включена, значит Pro или выше. INFERENCE.
- Кто удалил 21 товар (_du пары) 12–15.09.2026 — технически возможен только
  admin DELETE (единственный путь в коде); владелец не помнит. Записано в шапке
  `scripts/yugcontract-du-redirect-allowlist.ts`.
- EAV-таблицы (attributes/*) — заполняются ли чем-либо помимо final_001, не проверено.
- Мониторинг-алерты владельцу кроме Telegram-уведомлений заказов и
  wallpaper-freshness (например, алерты health-check по расписанию) — не настроены
  в репо; если существуют — вне репозитория.

## 19. Источники аудита

`package.json`; `vercel.json`; `proxy.ts`; `next.config.ts`; `app/api/**` (find route.ts);
`database/migrations/` (final_001–002 + 003–051; имена + шапки 032/033/035/036/047);
`app/lib/*` (ls + выборочно
orders route, telegram-order-actions, description-generator, catalog-health,
liqpay-config, rate-limit-shared);
`scripts/*` (du-redirect-allowlist, catalog-health-check, лаунчеры wsl/windows);
`tests/` (ls, 204 файла); grep `revalidate`/`process.env` по app/ и scripts/;
`AGENTS.md`, `PROJECT_CONTEXT.md`, `docs/`; живые проверки этой сессии: catalog-health
PASS, npm test 2351/0, GitHub Actions runs API, WSL systemd state.
