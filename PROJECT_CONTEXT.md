# Проект my-shop - Техническая документация

> **Как читать (2026-09-16):** текущее состояние архитектуры —
> [ARCHITECTURE.md](ARCHITECTURE.md) (по коду, с проверкой фактов).
> Правила работы агентов — [AGENTS.md](AGENTS.md). Этот документ —
> исторический журнал этапов: записи датированы и описывают состояние НА
> СВОЙ МОМЕНТ; часть утверждений позже изменилась (пример: «place_order
> доступен anon» этапа 12 отозвано миграцией 036). Не используй старую
> запись как описание текущего поведения без сверки с кодом.

## Стек проекта
- Next.js 16.3.1 (Turbopack, App Router, proxy.ts вместо deprecated middleware)
- TypeScript, React 19
- Tailwind CSS v4
- Supabase (PostgreSQL + RLS, Auth, Storage)
- Тесты: node:test (`npm test`), без внешних зависимостей

## Структура основных папок и файлов
```
proxy.ts                       # Auth-guard для /admin/* (async cookies API), matcher: /admin/:path*
next.config.ts                 # allowedDevOrigins (*.loca.lt для LocalTunnel-dev), security headers
app/
├── layout.tsx                 # RootLayout: CartProvider > FavoritesProvider; metadataBase из NEXT_PUBLIC_SITE_URL
├── robots.ts / sitemap.ts     # Индексация: static + НЕпустые категории/бренды + ВСЕ eligible-товары (ISR 86400); admin/api/checkout/orders закрыты
├── page.tsx                   # Главная (featured + категории, ISR 60с)
├── catalog/                   # Каталог: фильтры/поиск/сортировка через searchParams (серверные)
├── product/[slug]/page.tsx    # Страница товара (notFound() для отсутствующих slug)
├── cart/page.tsx              # Корзина (client): localStorage ids -> /api/cart-preview -> цены с сервера
├── favorites/page.tsx         # Избранное (client): localStorage ids -> /api/cart-preview
├── checkout/                  # CheckoutForm (client) + success (HMAC-token view)
├── orders/lookup, [orderNumber]  # Гостевой просмотр заказа по паре номер+email / номер+token
├── admin/login + (dashboard)/ # Логин Supabase Auth; layout проверяет user + admin_users
│   │   │                        # (страница /admin/translations и uk-блоки в формах УДАЛЕНЫ)
├── components/                # SiteHeader/Footer, ProductCard/Gallery, badges, EmptyState и др.
├── api/
│   ├── cart-preview/route.ts  # POST: batch lookup товаров по id (anon + RLS, rate-limit 120/min)
│   ├── orders/route.ts        # POST: checkout через place_order() RPC (rate-limit 3/min, 10/h)
│   ├── orders/lookup/route.ts # POST: поиск заказа номер+email (rate-limit 5/min, 20/h)
│   └── admin/*                # ВСЕ через requireAdminApi(); service role только server-side
└── lib/
    ├── catalog.ts             # Storefront-запросы (анонимный клиент + RLS) — единственный источник данных storefront
    ├── admin-api.ts           # requireAdminApi(), валидаторы, dbErrorResponse (без утечки internals)
    ├── cart-context.tsx       # CartProvider: reducer, hydration всегда завершается
    ├── favorites-context.tsx  # FavoritesProvider: аналогично
    ├── cart-storage.ts / favorites-storage.ts  # Чистые санитайзеры localStorage (unit-tested)
    ├── cart-preview.ts        # Общий клиентский fetch с таймаутом 12с + dispose(); never-stuck инвариант
    ├── order-token.ts         # HMAC-SHA256 capability token для гостевых страниц заказов
    ├── rate-limit.ts          # In-process sliding window (IP+route); см. ограничения ниже
    ├── supabase-storage.ts    # getPublicImageUrl(): публичные URL bucket product_images
    └── types.ts               # Общие типы сущностей
tests/                         # node --test: санитайзеры корзины/избранного, fetchCartPreview, order-token
database/migrations/           # SQL схемы; сверены с живой БД
```

## Архитектура Supabase
- PostgreSQL c RLS: аноним читает только активные сущности; запись — только service role server-side
- Auth: сессии в cookies через @supabase/ssr (getAll/setAll), проверка только через getUser()
- Storage bucket: product_images (публичное чтение, запись закрыта)

## Существующие таблицы (проверено по живой БД)
products (+brand_id), categories, brands, product_images,
product_variants, attributes, attribute_values, product_attribute_values,
admin_users, customers, orders (+order_number,
email, expires_at, payment_status, paid_at, liqpay_payment_id, liqpay_order_id,
payment_method, payment_error, prepayment_amount), order_items (+variant_name/sku),
product_stock_history

## Checkout / Orders (миграции 006–008)
- place_order(payload jsonb) — SECURITY DEFINER: lock -> validate -> цены ТОЛЬКО из БД ->
  customer upsert -> order + items -> декремент стока -> audit history. Клиент шлёт только
  идентификаторы, количество и контактные строки.
- Номер заказа ORD-YYYYMMDD-XXXXXX, уникальный индекс, collision-retry.
- Админ-RPC: admin_set_order_status (forward-only map), admin_cancel_order (атомарный
  возврат стока, double-restock невозможен), expire_pending_orders (SKIP LOCKED,
  pg_cron каждые 10 минут — job 'expire-pending-orders', исключает paid-заказы).
  EXECUTE только у service_role.
- Оплата: 100% онлайн через LiqPay. После place_order клиент перенаправляется в
  LiqPay; успешный callback (проверка подписи) атомарно ставит payment_status='paid'
  (B1 interlock: отменённый заказ никогда не станет paid; гонка с
  expire_pending_orders закрыта условным UPDATE с .neq('status','cancelled')).
- Истечение pending через 24ч: pg_cron (включить в Dashboard) или POST /api/admin/orders/expire.

## Правила безопасности (не нарушать)
- Service role ключ — только в server-side коде; в client bundle не попадает
- Все /api/admin/* начинаются с requireAdminApi() (401/403/200)
- Email-проверка админа — case-insensitive (ilike), т.к. Auth нормализует email
- Загрузка изображений: MIME allow-list + магические байты + лимит 5 МБ + санитизация имени файла
- Гостевые страницы заказов: HMAC token от service key (order-token.ts), verify constant-time
- Ошибки БД наружу: dbErrorResponse маппит коды; сырой error.message клиенту не возвращается
- Security headers в next.config.ts (headers(), ~:112-155): nosniff, Referrer-Policy,
  X-Frame-Options, Permissions-Policy + CSP ENFORCING (buildCsp), HSTS
  (max-age=31536000; includeSubDomains), COOP same-origin, CORP cross-origin

## Текущий функционал
- Storefront: главная, каталог (фильтры: категория, бренд, цена, наличие, поиск, сортировка;
  СЕРВЕРНАЯ пагинация: CATALOG_PAGE_SIZE=12 / cap size 50 в app/lib/catalog.ts:928-929,
  clamp out-of-range → последняя страница; UI prev/next + оконная нумерация в
  app/catalog/page.tsx), страница товара, корзина, избранное, checkout, success,
  guest order lookup/view
- Корзина/избранное: localStorage хранит ТОЛЬКО productId+variantId+quantity (корзина);
  все цены/наличие — с сервера (/api/cart-preview). Финальный авторитет цен — place_order().
- Admin: логин/логаут, товары (+изображения с загрузкой в Storage, варианты),
  бренды, категории, заказы (список/детали/статусы/отмена/истечение/платежи)

## Система uk-переводов (удалена из кода 2026-08)
- Весь контент сайта и данные поставщика на украинском — переводы признаны избыточными.
- Из кода удалены: overlay-запросы в catalog.ts (было +3 запроса на страницу),
  поиск по translations, uk-блоки в формах админки, /admin/translations, /api/admin/translations.
- ТАБЛИЦЫ products/categories/brands_translations ОСТАВЛЕНЫ в БД (пустые, не мешают).
  Если когда-нибудь понадобится второй язык — восстановить по истории git.

## Известные ограничения (осознанные)
- Оплата РЕАЛИЗОВАНА: 100% онлайн через LiqPay (payment_status='paid'; колбэки LiqPay
  обновляют заказ автоматически). После успешной оплаты заказ обрабатывается менеджером.
- Rate-limit: с миграции 047 (2026-09-13) АВТОРИТЕТНОЕ решение в Postgres
  (rate_limit_hits + RPC, IP хранится как HMAC) — cross-instance; in-process
  limiter остался как быстрый префильтр. Осознанный остаточный риск: fail-open
  при недоступности Supabase (checkout не блокируется сбоем лимитера).
- Полный e2e-цикл доставки Nova Post на реальном заказе НЕ проводился (реальных
  заказов в магазине ещё не было) — детали в разделе Nova Post ниже

## Sitemap (актуально: Task #14, 2026-09) — app/sitemap.ts
- ISR revalidate=86400 (URL-набор детерминирован по slug, staleness до суток
  приемлем; до этого был force-dynamic — полный скан на каждый hit краулера).
- Состав: static (8 страниц) + категории + бренды + ВСЕ eligible-товары
  (is_active + ≥1 фото через product_images!inner — тот же eligibility-контракт
  что и витрина). Товары/факты non-empty категорий/брендов собираются одним
  paged-чтением (brand_id + product_categories embed добавлены к images!inner,
  qualifying-набор товаров НЕ изменён).
- НЕпустые вью: категория попадает в sitemap только если в её поддереве есть
  ≥1 eligible-назначение (collectNonEmptyCategoryIds), бренд — если ≥1 eligible
  товар несёт его brand_id (collectNonEmptyBrandIds) — пустые вью noindex'ятся
  seo.ts, инвариант «indexable set = sitemap set».
- _du-редиректы (DU_REDIRECT_SLUGS, app/lib/du-redirects) исключены из product
  URL (301 на base); price-diff _du и сироты остаются.
- Контракт сбоя: ошибка чтения товаров → fetchEligibleProducts возвращает null →
  категории/бренды шипятся ВСЕГДА (не режутся из-за транзиентного сбоя чтения).
- Пагинация чтений: app/lib/seo-sitemap.ts collectPaged — окна ≤1000 c
  .order('id'), maxRows cap 100k.

## Nova Post — состояние модуля доставки (2026-09)
- Nova Post РЕАЛИЗОВАН как модуль доставки: data layer + admin API + расчёт
  стоимости + ТТН (складские отправления) + курьерская доставка. НО полный
  e2e-цикл на РЕАЛЬНОМ заказе НЕ проводился — реальных заказов в магазине
  ещё не было. Неверифицированное в production: живой заказ → планирование →
  расчёт → ТТН → передача/трекинг.
- Data layer (миграции применены вручную): 019 order_shipments +
  order_shipment_items (+ COD/allocation триггеры assert_shipments_cod_sum,
  assert_shipment_items_allocation), 020 order_shipment_parcels + integrity,
  021 RPC admin_replace_shipment_plan (атомарный replace-all план, одна
  транзакция, DEFERRABLE триггеры оценивают финальное состояние), 022 fix
  composite FK, 023 shipment_plan_parcel_cap, 026 courier-адрес
  (order_shipments.street_name/building/flat + обновлённый RPC).
- Клиент: app/lib/delivery/novapost/ (server-only): client.ts (auth GET
  /clients/authorization?apiKey → JWT ~1ч), config.ts (ключ NOVA_POST_API_KEY,
  sender division/name/phone — server-side env, fail-closed),
  settlements/divisions/streets/delivery-cost/shipments/errors/map-failure.
  Парсинг ответов — strict whitelist (провайдеру НЕ доверяем). Runtime
  baseUrl — production api.novapost.com/v.1.0/ (константа без env-
  переключателя); контракт POST/GET /shipments + DELETE /shipments/{ref}
  верифицирован live в sandbox api-stage.novapost.com (2026-08-27,
  см. шапку app/lib/delivery/novapost/shipments.ts).
- API под /api/admin/orders/[id]/shipments/ (всё через requireAdminApi()):
  - GET/PUT route.ts — планирование отгрузок (Stage 2D): PUT = полный
    replace-all план через admin_replace_shipment_plan; редактирование
    запрещено, когда любая отгрузка ушла из 'planned' или имеет ТТН.
  - POST calculate/route.ts — расчёт стоимости (Stage 2E+2G): read-only
    POST /shipments/calculations, персистится ТОЛЬКО delivery_cost_estimated;
    fail-closed (курьер без street/building пропускается; цитата обязана
    содержать ровно одну валидную service-строку).
  - POST/DELETE ttn/route.ts — создание/откат ТТН (Stage 2F).
- ТТН для складских отправлений (Stage 2F, .../shipments/ttn/route.ts) —
  защита от дублей ТТН (sandbox-verified контракт): (1) pre-check GET
  /shipments?clientOrder — активная ТТН от прошлой попытки ADOPTится, не
  пересоздаётся; (2) POST /shipments ровно один раз, неизвестные исходы
  (timeout/503) НЕ ретраятся слепо — reconcile через clientOrder; (3) после
  201 planned→created атомарно (conditional UPDATE … WHERE status='planned'
  AND ttn_ref IS NULL; проигравший гонку удаляет только что созданный
  дубликат документа); (4) 422-отказы провайдера персистятся в
  np_last_error_code/np_last_error для админ-ретраев. DELETE = rollback:
  удаление документа по Ref у провайдера, затем сброс строки в 'planned'.
- Курьерская доставка (Stage 2G): получатель строится ТОЛЬКО из
  settlementId (city_ref) + структурированных адресных частей (миграция
  026), локатор live-verified (app/lib/admin-shipments-ttn.ts:163).
  ВАЖНО: POST /shipments в courier-ветке НЕ live-тестировался — первая
  курьерская ТТН должна пройти через sandbox (201 → DB → clientOrder
  reconcile → rollback DELETE по ttn_ref) до production-использования.
- Текущая оплата остаётся 100% онлайн через LiqPay → обработка менеджером.
- COD / 20% prepayment + 80% наложенный платёж НЕ является текущим
  бизнес-требованием и НЕ реализуется — не планировать на основании старого
  контекста.
- orders.prepayment_amount — историческое/заготовленное поле (nullable,
  никогда не записывается кодом); его наличие в схеме НЕ означает
  использование 20% предоплаты.

## Telegram-уведомления о заказах (работают)
- Точка подключения: app/api/orders/route.ts (~:278) — строго ПОСЛЕ commit
  place_order() через next/server after():
  after(() => sendTelegramOrderNotification(orderNumber)); только для
  реально созданных заказов — идемпотентный replay (created=false)
  повторно НЕ шлёт.
- app/lib/notifications/telegram.ts — server-only: читает заказ из БД,
  шлёт plain-text (без parse_mode) в Telegram. Env: TELEGRAM_BOT_TOKEN +
  TELEGRAM_ORDER_CHAT_ID (comma-separated список получателей). Никогда не
  бросает — сбой Telegram не влияет на заказ/checkout/платёж; at-most-once
  на заказ на получателя (без retry-loop).
- Владелец подтверждает: уведомления о новых заказах приходят.

## Состояние 2026-09-05: инцидент поставщика Yugcontract
- Фид Yugcontract схлопнулся: ~326 товаров, 9 категорий (дерево
  get-categories схлопнулось до 9 узлов), id сменились
  (scripts/yugcontract-mark-missing-oos.ts,
  scripts/yugcontract-exposure-report.ts).
- 4773 фантомных товара (активные YC-товары, отсутствующие в свежем фиде и
  in_stock) переведены в out_of_stock (stock_quantity=0) скриптом
  scripts/yugcontract-mark-missing-oos.ts --apply (scope: только is_active +
  yugcontract_id NOT NULL + нет в фиде; manual-товары не тронуты; qty=0
  строки фида — территория обычного синка). Снимок отката:
  logs/oos-batch-2026-09-05.json — единственный артефакт отката
  (--revert --snapshot logs/oos-batch-2026-09-05.json).
- Восстановление — штатный синк по команде владельца
  (scripts/wsl/yugcontract-sync.sh, при необходимости --force против 48h
  gate). Авто-синк ВЫКЛЮЧЕН: systemd timer yugcontract-sync.timer disabled
  (проверено systemctl is-enabled; вкл/выкл — docs/wsl-sync.md раздел 3).
- Новые id категорий Юга потребуют разового ремапа categories.yugcontract_id.
- scripts/catalog-health-check.ts — инцидент ЗАКРЫТ (2026-09-16, RESULT
  PASS exit 0): «перекос новинки = OOS» 7% (PASS), feed-liveness 85.1%
  in_stock — фид здоров; ack инцидента — logs/feed-liveness-baseline.json
  (baseline 85.1%; файл локальный, logs/ в .gitignore). Дрейф
  _du-allowlist после синков 09-14/15 закрыт регенерацией 2026-09-16:
  10 allowlist-пар + 1 сирота удалены из БД ВНЕ импортера (импортер не
  удаляет — причина удаления не установлена), 6895802_du обрела базу,
  7220883_du сравнялась в ценах; итог 293 redirect / 19 price-diff /
  38 сиріт.
- Дрейф _du-allowlist после синка 2026-09-18 закрыт регенерацией
  2026-09-18 (реаудит живой БД: пары 293 и сироты 38 — наборы
  идентичны 09-16, новых сирот нет): 74 пары same→diff (волна
  repricing поставщика, base подорожал), 7220883_du вернулась в diff
  (32999 vs 33999); итог 293 redirect (не изменился) / 93 price-diff /
  38 сиріт. Health по _du-дрейфу: PASS.

## Наблюдаемость (2026-09-05)
- Аналитика поиска: событие `search` несёт boolean hasResults
  (app/lib/analytics.ts buildSearchEventPayload; query проходит
  sanitizeSearchQuery — PII-фильтр, cap 100; количества результатов наружу
  не уходят). Эмитится из каталога через app/components/SearchViewTracker.tsx
  (app/catalog/page.tsx: hasResults = total > 0). Исторические события флага
  НЕ имеют (в OData — eventData/hasResults eq null).
- scripts/catalog-health-check.ts — read-only health (PASS/WARN/FAIL,
  exit 0/1/2); секция «новинки» (2026-09-05): доля OOS среди топ-100
  активных по created_at desc — WARN ≥20%, FAIL ≥50% (<20 товаров —
  advisory). Ловит перекос «первый экран витрины из отсутствующих товаров».
- scripts/zero-result-report.ts — read-only отчёт «что искали и не нашли»
  (сигнал для закупок): Vercel Web Analytics API (GET
  /v1/query/web-analytics/events/aggregate, filter=eventName eq 'search');
  для событий без hasResults — faithful replay против prod DB (service-role,
  только SELECT, PURE-хелперы app/lib/catalog.ts в порядке
  fetchCatalogProducts). ВАЖНО: голые boolean-литералы в OData-фильтре
  (`eq false`) дают HTTP 500 от API — использовать только кавыченные
  (`eq 'false'`) (проверено 2026-09-05).
- scripts/yugcontract-exposure-report.ts — read-only диагностика экспозиции
  каталога: один get-price с cats:[] как ground truth «что поставщик ещё
  листит» + selection-scoped view (approved категории из
  app/lib/yugcontract/selection.ts, развёрнутые по живому дереву) с теми же
  skip-правилами mapFeedProducts. Ничего не пишет.
- Fuzzy display fix: identifyAppliedSearch (app/lib/catalog.ts:784) —
  правило выбора отображаемого термина после fuzzy-поиска: (1) оригинальный
  токен показывается verbatim, если он совпал хоть с одной строкой; (2) иначе
  длиннейший совпавший кандидат (читаемость); (3) при равенстве длины —
  первый по эмиссии. null → notice «показаны результаты по …» не рендерится.

## Важные правила для будущих изменений
- Данные storefront получать только через функции app/lib/catalog.ts
- Новые admin API — только через requireAdminApi(); вход валидировать (isUuid, nonNegNumOrNull)
- Для изображений использовать getPublicImageUrl(); пути в БД хранятся как относительные объектные пути
- Клиентские fetch к /api/cart-preview — только через lib/cart-preview.ts (таймаут+dispose инвариант)
- При добавлении таблиц вносить изменения в catalog.ts и соответствующие функции

## Интеграция Yugcontract (этап 1: read-only preview, 2026-08)
- app/lib/yugcontract/ — server-only клиент B2B API:
  jwt.ts (HS256 через node:crypto, без зависимостей), client.ts
  (authToken + memory-cache ~1ч с margin 5мин; при 401 — refresh + ОДИН retry;
  429/5xx → типизированные ошибки без частичного результата),
  normalize.ts (runtime-коэрция полей фида + статистика), types.ts.
- Credentials YUGCONTRACT_USER_KEY / YUGCONTRACT_SECRET — server-side env only,
  никогда не логируются и не попадают в ответы/бандл (проверено по .next/static).
- GET /api/admin/yugcontract/preview — requireAdminApi() + rate-limit 3/10мин.
  Читает полный get-price фид (~200k строк), считает статистику и сравнивает
  с нашей БД (только SELECT). НИЧЕГО не пишет. maxDuration=60 на Vercel.
- GET /api/admin/yugcontract/categories + страница /admin/yugcontract/categories —
  read-only превью дерева get-categories: автоопределение формы ответа
  (arrayPath + ключи id/name/parent), статистика уровней, поиск с сохранением
  предков. rate-limit 6/10мин. НИЧЕГО не пишет.
- scripts/yugcontract-categories-preview.ts — локальный CLI-вывод дерева
  категорий (читает .env.local, печатает ID/названия, без секретов).
- ПОДТВЕРЖДЕНО реальным вызовом (2026-08): get-categories отдаёт массив
  прямо в content[]; ключи id/name/parent_id; 524 узла, корней 9,
  глубина до L3 (L0:9 L1:59 L2:252 L3:204), сирот нет. ВАЖНО для импорта:
  фид товаров содержит только cat_top/cat_2l/cat (+2 id), а дерево имеет
  4 уровня — часть листьев живёт на L3.
- Страница /admin/yugcontract — рендер статистики (укр. строки).
- Импорт НЕ реализован: нужен migration products.yugcontract_id TEXT UNIQUE
  (предложен, не применён), batch-based idempotent импортер. Сопоставление
  товаров — ТОЛЬКО по внешнему id, не по name/slug/brand/price.

## Интеграция Yugcontract (этап 2: импорт выбранного ассортимента, 2026-08)
- Миграции применены (вручную через SQL Editor): 009 products.yugcontract_id
  TEXT + partial unique idx; 010 categories.yugcontract_id TEXT + partial
  unique idx + служебная таблица yc_import_batches (RLS on, без policies —
  только service role). DDL недоступен из кода: psql/CLI/DATABASE_URL нет.
- app/lib/yugcontract/import-plan.ts — pure планировщики (unit-tested):
  категории (depth-sorted creates, minimal updates, конфликты slug),
  бренды (exact normalized match; lookalikes НЕ сливаются — только отчёт),
  товары (rrp>price→old_price, qty clamp ≥0, availability по stock).
- app/lib/yugcontract/import-run.ts — исполнение: deps (live tree +
  leaf-only cats батчи ≤40), checkpoint CRUD, executeBatch/runUntilDone,
  buildFullPlan (read-only план перед записью). Идемпотентность:
  identity=yugcontract_id, split insert/update по diff, slug/is_active
  существующих не трогаются. Пустой фид батча → failed (не 'done').
- API: /api/admin/yugcontract/import/{start,run,status} — requireAdminApi,
  rate-limit, maxDuration=60; run выполняет РОВНО один батч за вызов.
- scripts/yugcontract-import-run.ts --plan|--run[--resume ID] — тот же
  код-путь локально (свежий deps на фазу исполнения!). 
- scripts/yugcontract-verify.ts — регрессия: целостность БД + storefront
  + cart-preview + реальный place_order→cancel (сток восстанавливается).
- ФАКТ импорта 2026-08: 205 категорий (11 корней, depth≤3), 69 брендов,
  4322 товара (все с price/brand/category; old_price у 4226). Run
  yc-2026-08-24-11-26-25, все батчи done. Уроки: API get-price разворачивает
  родительские cats в поддерево → запрашивать ТОЛЬКО листья; parent_id
  категорий резолвить per-chunk после вставки родителей.
- Будущие синки: повторный --run идемпотентен (обновит price/old_price/
  stock/name; history source='yugcontract' при изменении стока).

## Этап 3: фиксы каталога + цена=РРЦ + research get-content-goods (2026-08-24)
- КАТАЛОГ ROOT CAUSE: фильтры `.eq('category.slug',…)`/`.eq('brand.slug',…)`
  не работают в PostgREST: embed-фильтр требует embed в select, а без
  `!inner` деградирует до left-join (все строки). Count-запрос падал
  целиком → витрина показывала пустой результат. ФИКС (catalog.ts):
  slug→UUID lookup + фильтры по FK-колонкам category_id/brand_id;
  всем сортировкам добавлен tiebreaker `.order('id')` (у импорта
  одинаковые created_at по 200 шт → страницы пересекались).
- ЦЕНА=РРЦ: mapFeedProducts теперь price=round2(rrp), old_price ВСЕГДА
  null (поставщицкий price — НЕ доказанная скидка; знижки не показуем).
  Нет RRP: новые товары НЕ создаются (unresolvedRefs), у существующих
  цена не трогается (stock/name синкаются). Массово применено
  scripts/yugcontract-rrp-apply.ts (--yes): 4242 price→rrp,
  old_price очищен у всех 4322 YC-товаров; 7 без RRP и 67 без фида
  не тронуты. Dry-run: scripts/yugcontract-rrp-dry-run.ts.
- get-content-goods РЕАЛЬНО: POST /api/catalog/get-content-goods
  (тот же authToken; отдельного токена НЕТ). ФИЛЬТРАЦИИ НЕТ — всегда
  полный дамп ~9k товаров, 28–37MB, сервер собирает ~70с.
  content.goods[]: {id, categoryId, name, brand, EAN, artikul,
  description(HTML, uk), pictures[](URL-строки), params[]({name,value,id,
  rozetka_id}), foto[], video[], file_energy_label, file_info_list}.
  Покрытие наших 4322: 4118 (95%); desc avg 1269 симв (82% HTML);
  фото avg 5.8/товар; params avg 11.4/товар (~600 уник. имён).
  Картинки ПУБЛИЧНЫ без auth (b2b.yugcontract.ua/fileslibrary/products/...).
- Импорт контента НЕ реализован; миграций для контента НЕ делали
  (кандидат: products.specifications JSONB; EAV attributes/* уже есть,
  но тяжёлый; product_images хранит относительные Storage-пути —
  getPublicImageUrl не умеет внешние URL).

## Этап 4: подготовка content import (2026-08-24, НЕ применено к production)
- CONTENT DRY-RUN (реальный вызов 2026-08-24): dump 35.3 MB / ~75 с,
  raw 9043 → unique 8824 (219 дублей-id, правило first-wins). Наши
  товары: 4323 (4322 YC-linked + 1 manual); matched 4131 = 95.58%,
  unmatched 191. Описания: у matched 3399 с описом/732 пустых, 99.99%
  HTML, опасное: iframe=1, style=336, script/on*/javascript:/data:=0.
  Params: 4082 товара, 46802 шт, avg 11.3, max 84, 639 уник. назв;
  одинаковый name с разными values: 10 matched (115 в фиде) → формат
  specifications = JSON ARRAY [{name,value}]. Картинки: у 100% goods,
  matched 23863 URL, host только b2b.yugcontract.ua, .pdf внутри
  pictures[] присутствуют; sample HEAD 20/20 OK, avg ≈1 MB, оценка
  полного объёма ≈12–22 GB → hotlink вместо зеркалирования.
- НАЙДЕН БАГ ПЕЙДЖИНГА: Supabase молча режет range до 1000 строк —
  fetchAllRows(PAGE=5000) вернул 1000 из 4323. CLI content-dry-run
  пейджит по 1000. ОТДЕЛЬНЫЙ будущий фикс: fetchAllRows в import-run.ts
  (используют import/status), свой PAGE_SIZE=5000 в preview route.
- РЕШЕНО: specifications JSONB array (не object, не EAV); описание →
  products.description через allowlist sanitizer (sanitize-html,
  content-sanitize.ts) НА ЭТАПЕ FETCH (raw HTML нигде не хранится);
  картинки — HOTLINK внешних URL из существующей product_images
  (getPublicImageUrl теперь пропускает http(s) как есть;
  storagePathFromImageUrl/toStoragePath возвращают '' для внешних →
  delete-flow пропускает Storage.remove; все <Image> unoptimized).
  Валидация external URL (content-staging.ts): http/https + host
  b2b.yugcontract.ua + расширение jpg/jpeg/png/webp/gif (pdf отклонён).
- МИГРАЦИЯ database/migrations/011_content_import.sql СОЗДАНА, НЕ
  ПРИМЕНЕНА: products.specifications JSONB + CHECK jsonb_typeof=array
  (без GIN), staging yc_content_goods (description УЖЕ санitized,
  pictures/params JSONB, PK=yugcontract_id), чекпоинты yc_content_batches
  (phase description|images; независима от yc_import_batches; RLS on без
  policies = только service role).
- КОД: app/lib/yugcontract/content-{sanitize,staging,import}.ts (pure
  планировщик diff-aware: пишет ТОЛЬКО description/specifications —
  assertContentFields guard + тесты; second run no-op; идемпотентность;
  stale-running recovery как в price import). CLI:
  scripts/yugcontract-content-fetch.ts (--plan|--stage; 1 вызов API,
  sanitize+validate→upsert staging) и scripts/yugcontract-content-apply.ts
  (--plan|--run[--resume]; читает ТОЛЬКО staging, батчи ≤200 id).
- ЗАПУЩЕНО ТОЛЬКО unit-тесты (119 pass): sanitize adversarial fixtures,
  image URL validation/passthrough, planner idempotency/isolation/batches.
  Реальные --stage/--run НЕ выполнялись; миграция не применялась;
  production data не изменялись (0 записей). Фаза images в executor
  пока явно падает 'failed: ще не реалізована'.

## Этап 5: content import ПРИМЕНЁН к products (2026-08-24)
- Миграция 011 применена вручную (SQL Editor); verification: 14 PASS /
  0 FAIL (scripts/tmp-verify-011.ts — OpenAPI+head-count read-only).
- --stage (15:50): 1 вызов API 35.4MB/79.7s → yc_content_goods 8827
  строк (first-wins), sanitized desc 6796, отклонено 3×.pdf; верификация
  staging FAIL=0 (нет опасного HTML/дублей/невалидных URL; сентинелы
  ДО=ПОСЛЕ). scripts/tmp-verify-stage.ts (--sentinels для быстрой пробы).
- apply --run (15:58, run=ycc-2026-08-24-15-58-40): 45/45 батчей done,
  updated=4130, skipped=4697, errors=0, 396.7с. Записаны ТОЛЬКО
  products.description (3399 заполнений) + products.specifications
  (4081 товаров, JSON array). overwrite непустых описаний = 0.
- ИЗОЛЯЦИЯ ДОКАЗАНА SHA-256 сентинелами (scripts/tmp-sentinel.ts):
  fingerprint защищённых полей products (price/old_price/stock/name/
  slug/is_active/is_featured/category_id/brand_id/sku/currency),
  product_images, yc_import_batches, product_stock_history,
  yc_content_goods(ids) и счётчики orders/order_items/customers —
  НЕИЗМЕННЫ до/после; сдвинулся только products.max(updated_at) и
  появился 45 чекпоинтов.
- Пост-верификация (scripts/tmp-postverify-content.ts): YC-linked с
  описанием 3399 / пустых 923 / со specifications 4081; manual товар
  не тронут; спот-чеки A/B/C — sanitized HTML в БД, specifications
  валидный JSON array, повторяющиеся name с разными values СОХРАНЕНЫ
  (YC-6703075: "Рекомендована площа…" → ["20...25","25"]); глобальный
  скан опасных конструкций по 3399 описаниям = 0.
- Идемпотентность подтверждена живой БД: повторный apply --plan даёт
  potential UPDATE = 0, no-op = 3399 (+731 без описа получают specs при
  изменении фида), unmatched 4697.
- Product page ПОКА рендерит description как plain text (без
  dangerouslySetInnerHTML) — переключение отдельным GO. Images остаются
  hotlink (products.specifications/pictures в staging готовы к будущему
  images-этапу через product_images external URL passthrough).

## Этап 6: HTML-рендер description на product page (2026-08-24)
- app/components/ProductDescription.tsx — ЕДИНСТВЕННОЕ в проекте место
  с dangerouslySetInnerHTML (инвариант закреплён тестом
  tests/product-description.test.ts: ровно 1 usage во всём app/,
  sanitize-html импортируется только content-sanitize.ts, компонент не
  импортирует санитайзер). Pure-fallback в app/lib/product-description.ts:
  description(HTML) → short_description(text) → «Опис відсутній».
- Типографика scoped через Tailwind arbitrary variants (без глобального
  CSS): таблицы border+collapse внутри overflow-x-auto обёртки,
  img max-w-full h-auto, списки/заголовки/emphasis.
- Реальная SSR-проверка на живых данных (next start + curl):
  YC-40360 → <p>… отрендерен как HTML (&lt;p&gt; отсутствует);
  YC-5969101 → «Опис відсутній»; manual fgdfgdfgdfdsa → plain text.
  Визуальный browser-check НЕ выполнялся (нет браузера в среде).
- Product page БОЛЬШЕ НЕ показывает теги как текст. Images/orders/
  price-import/БД-схема не затронуты; записи products не менялись.

## Этап 7: images hotlink — PLAN готов, --run ждёт GO (2026-08-24)
- app/lib/yugcontract/content-images.ts — pure-планировщик: identity =
  (product_id, image_url) БЕЗ unique index (diff-aware reconciliation,
  single-runner); imported-vs-manual дискриминатор = absolute http(s)+
  b2b host URL (admin upload всегда пишет относительный Storage путь);
  DELETE свідомо не реализован (stale imported только отчёт).
- Семантика: чистый товар → pictures[0] sort_order=0+is_main=true;
  есть foreign(manual) изображения → hotlink аппендится после max
  foreign sort_order, все is_main=false при чужом main; reorder в
  pure-imported наборе каноничен (0..n-1) и переключает main корректно;
  ревалидация URL на выходе из staging обязательна (executor flow).
- executeImagesBatch встроен в runContentUntilDone (phase='images',
  те же чекпоинты yc_content_batches). CLI:
  scripts/yugcontract-content-images.ts --plan|--run[--resume].
- --plan (16:45): matched 4130 (все с картинками), 45049 URL после
  ревалидации (0 невалидных), product_images у matched сейчас 0
  (единственная manual-картинка принадлежит manual-товару вне YC),
  INSERT 23848 / UPDATE 0 / NOOP 0 / DELETE 0 / stale 0 / дубли 0 /
  аномалий нет / батчей 45. Урок: .in() чанк ≤200 UUID (длинные GET
  URL → PostgREST Bad Request). Production НЕ менялся; --run по GO.

## Этап 7 (продолжение): images --run ВЫПОЛНЕН + верифицирован (2026-08-24)
- run=ycci-2026-08-24-16-51-16: 45/45 done, вставлено 23848 external
  URL в product_images, errors=0, 70.6с. products НЕ тронуты вообще
  (max(updated_at) не сдвинулся); manual-строка байт-идентична;
  yc_import_batches/stock/orders fingerprints неизменны.
- Верификация FAIL=0: дубликатов (product_id,image_url)=0; все URL
  http(s)+b2b host+image-ext; ≤1 main на товар; pure-imported наборы
  каноничны 0..N-1 с main на 0; спот-чеки max-pictures(49)/one-picture.
- SSR: карточка каталога, gallery (49 уникальных b2b URL на странице),
  cart-preview imageUrl — работают через passthrough getPublicImageUrl.
- НОВЫЙ УРОК 1000-CAP: лимит 1000 строк действует и на .in() запросы
  БЕЗ явного .range() → loadProductImagesFor + images-CLI молча видели
  20232/23848 строк (ложные 3616 INSERT при ре-плане). ФИКС: явная
  пагинация внутри каждого .in чанка. Повторный --plan: INSERT=0,
  NOOP=23848 — идемпотентность подтверждена живой БД.

## Этап 8: hardening silent-truncation (2026-08-24)
- P0: import-run.fetchAllRows PAGE 5000→1000 + .order('id'); preview
  PAGE_SIZE 5000→1000 (+.order('id')); admin/products GET default ветка
  больше НЕ unbounded — единая пагинация page/size (cap 100) с total/
  page/size всегда в ответе; UI всегда шлёт ?page&size; маскирующий
  fallback `total ?? rows.length` убран (throw при отсутствии total).
- P1: tiebreaker .order('id') в paged admin products/orders; legacy
  scripts/yugcontract-dry-run.ts PAGE_SIZE→1000; selectBatches/
  selectContentBatches — защитная пагинация 1000 (семантика чекпоинтов
  не изменена).
- Тесты tests/pagination-hardening.test.ts: mock-Supabase с реальным
  cap-поведением (2500→3 req, 1001→2 req, exactly-1000 требует холостой
  probe-запрос следующей страницы), contiguous windows без off-by-one;
  статические инварианты: ни одного объявления PAGE>1000 в app/+scripts/,
  preview пагинируется, tiebreakers на месте, UI-fallback удалён.
- Остаточные latent: verify.ts inline categories loop (4999 literals,
  таблица 205 строк); admin products actions featured/active unbounded;
  storefront categories/brands/featured unbounded; order_items.eq(order_id)
  теоретический. Production data не менялись.

## Этап 9: P1/F1 stable pagination + F3 search sanitization (2026-08-24)
- F1 ИСПРАВЛЕН: все multi-page `.range()` readers получили явный
  `.order(<unique key>)` (content-import loadProductImagesFor;
  content-images staging+existing; content-apply staging ids;
  content-fetch products; legacy dry-run/rrp-*/verify pageAll+categories;
  tmp-* верификаторы). Причина: OFFSET-пагинация без ORDER BY даёт
  нестабильные окна — live-воспроизведение: 3 идентичных reada
  23848 строк → (72 dup + 73 missed + 17 фантомных multi-main) ×1,
  чисто ×2; images --plan выдавал ложные INSERT=163/21 multi-main.
  Инвариант закреплён статическим тестом (каждый multi-page .range()
  обязан иметь .order(); allowlist: catalog progressive builder,
  verify pageAll с order от caller'ов). Повторные images --plan ×3:
  байт-идентично INSERT=0/UPDATE=0/NOOP=23848/stale=0/аномалий нет.
- F3 ИСПРАВЛЕН (с корректировкой аудита): запятая УЖЕ стрипалась
  классом [%,()] — аудиторский тезис «comma не удаляется» был ошибкой
  чтения regex. Реальный подтверждённый вред (live-пробы PostgREST):
  `"` молча поглощается как value-quoting синтаксис и ИСКАЖАЕТ ilike-
  паттерн — товар `Ніж … поварський6" (24010/106)` был ненайден по
  собственному имени; `,` без санитайзера даёт жёсткий PGRST100.
  FIX: sanitizeSearchTerm = replace(/[%,()"]/g,' ') + collapse
  внутренних пробелов; экспортирован для тестов. Точка/дефис/апостроф/
  кавычка-как-литерал в данных безопасны — НЕ тронуты. SSR-проверка
  (next start): щітка,TEFAL≡щітка TEFAL (=5), "парова"≡парова (=28),
  F3-товар найден (=1), все HTTP 200. Тесты tests/catalog-search.test.ts
  (9). Итого 161 test pass; tsc/lint(2 pre-existing warnings)/build OK.
  DB не менялась.
- F4/F5 ИСПРАВЛЕНЫ: unbounded full-set SELECT'ы переведены на пагинацию
  ≤1000 с tiebreaker .order('id' desc): admin products action=featured/
  active (helper fetchAllJoined; ВЕТКИ МЕРТВЫЕ — UI зовёт только
  ?page&size, но контракт «полный набор» сохранён; live-факт: active
  возвращал 1000 из 4323!) и catalog fetchProducts/home featured
  (единственный caller рендерит ВСЁ). Урок supabase-js: builder НЕЛЬЗЯ
  переиспользовать между страницами — .order() аппендится в url, окна
  ломаются; chain строится внутри каждой итерации. Инварианты в
  pagination-hardening.test.ts + runtime-тест через реальный HTTP fake-
  PostgREST (offset/limit query params — НЕ Range header): 2500 строк →
  offsets [0,1000,2000], все получены. SSR до/после идентичен (home=1,
  каталог=19); action=active теперь 4323/4323 детерминированно. Итого
  164 test pass. DB не менялась.
- F11 ЗАКРЫТ: categories-loop в verify.ts (окна range(from,+4999),
  termination <5000, шаг +=5000 — при cap≤1000 loop всегда останавливался
  после страницы 1 → тихая обрезка любой таблицы >1000 строк; сейчас
  categories=205, потому баг не проявлялся) переведён на каноническую
  форму PAGE=1000 + .order('id') + termination <PAGE. pageAll (уже
  PAGE_WINDOW=1000) защищён regression-тестами; статический скан
  запрещает литералы окон >1000 в verify.ts. Live: old/new формы дали
  идентичные 205 строк/порядок; boundary-регресс 999/1000(probe)/1001/
  2500 OK. Итого 166 test pass; tsc/lint/build OK. DB не менялась.
  Pagination-рисков в проекте НЕ ОСТАЛОСЬ (F2/F6–F10 вне пагинации).
- F12 ИСПРАВЛЕН (до F6-миграции): planImageOps теперь выдаёт updates в
  фазовом порядке [demotes(is_main=false) → neutral(sort-only) →
  promotes(is_main=true)] — частичный UNIQUE main-per-product больше не
  даёт 23505 при reorder уже импортированного набора. Плюс: stale-строка
  с is_main=true получает flag-only demote (deletion по-прежнему НЕ
  реализована; иначе полный replacement фото падал на INSERT нового
  main). Executor применяет строго последовательно — транзакционный
  слой не нужен; transient zero-main окно легально. Тесты +7: симулятор
  partial unique, sequence-regression demote-before-promote, zero-main,
  manual-main, same-main NO-OP, stale-main, idempotency после reorder.
  Итого 173 pass; tsc/lint/build OK; images --plan ×2 байт-идентичны
  (INSERT=0/UPDATE=0/NOOP=23848/stale=0). DB не менялась.
  F6 UNIQUE INDEX по-прежнему НЕ создан — отдельный GO.
- F6 ПРИМЕНЁН (миграция 012, вручную через SQL Editor):
  CREATE UNIQUE INDEX CONCURRENTLY idx_product_images_product_url
  ON public.product_images(product_id, image_url). Pre-scan: dups=0,
  baseline совпал. Post-verify ALL PASS: duplicate-INSERT отклоняется
  23505 (constraint probe, net-zero), 23849/23849 unique pairs,
  NULL/empty=0, external=23848/manual=1 (manual row intact),
  multi-main=0; fingerprints products/orders/staging не сдвинулись.
  images --plan ×2: INSERT=0/UPDATE=0/NOOP=23848/stale=0. Executor
  ON CONFLICT не использует — 23505 → errors → batch failed → resume
  NOOP-safe. Rollback: DROP INDEX CONCURRENTLY
  idx_product_images_product_url.
- F2 UX РЕШЁН (storefront-only): критерий eligible = «есть ≥1 фото»
  через PRODUCT_SELECT с images:product_images!inner(*) — единая точка
  для каталога/поиска/category/brand/featured/slug; count-запрос
  каталога зеркалит join (ELIGIBLE_COUNT_SELECT). Проверено live:
  PostgREST НЕ раздувает count на one-to-many inner join (4131 ==
  distinct products-with-images). Скрыто ровно 192 placeholder-товара;
  ~700 товаров без description, но с фото — ОСТАЮТСЯ видимыми (описание
  — необязательное поле). Admin API (свой SELECT без !inner) видит всех;
  cart-preview не фильтруется; importer/data layer не тронуты — при
  будущих импортах товары появляются автоматически. Прямой slug скрытого
  → not-found-страница (как у несуществующих; HTTP 200 вместо 404 —
  pre-existing особенность Next, помечено F14, вне scope).
  Live: /catalog 4323→4131, поиск 19→13, пагинация 345 стр., last page
  3 карточки, home=1. Тесты tests/storefront-visibility.test.ts (+6):
  границы admin/cart-preview/importer защищены. Итого 179 pass;
  tsc/lint/build OK. products.is_active и все данные НЕ менялись.
- F7 ЗАКРЫТ: блок «Характеристики товару» на странице товара.
  app/components/ProductSpecifications.tsx (+ pure-хелпер
  app/lib/product-specifications.ts): table-fixed w-full +
  [overflow-wrap:anywhere]/break-words (без горизонтального overflow),
  порядок поставщика сохранён, duplicate names НЕ схлопываются,
  пустые/битые записи пропускаются, пустой set → блок не рендерится,
  значения — React text children (никакого HTML-sink). В Product type
  добавлено specifications?: {name,value}[] (select '*' уже отдавал
  поле). Тесты tests/product-specifications.test.ts (+7: helper unit +
  статические инварианты разметки/XSS; .tsx не импортируется в
  node:test — JSX не стрипается). Live SSR: 6703075 рендерит блок с
  дубликатом «Рекомендована площа», manual без specs — блока нет.
  Итого 185 pass; tsc/lint/build OK. DB не менялась.
- F13 ЗАКРЫТ: admin PUT make-main переведён на demote-before-promote
  (partial UNIQUE main-per-product больше не отдаёт нерелевантную
  ошибку про SKU/slug). app/lib/admin-image-main.ts — pure
  planMainPromotion (already-main → no flag churn; иначе [demote old,
  promote]); PUT: ownership+state одним guarded read, plain-patch путь
  сохранён, все updates ограничены .eq(id)+.eq(product_id), promote
  fields = whitelist baseFields + is_main, 23505 → 409 «У товарі вже є
  головне зображення» (достижимо только при race двух параллельных
  PUT). Тесты tests/admin-image-main.test.ts (+7: decision-матрица +
  статические инварианты маршрута incl. запрет DELETE/INSERT в PUT).
  Итого 192 pass; tsc/lint/build OK. Live endpoint-проверка с записью
  не выполнялась (нужна admin-сессия + production mutation) — честно
  отмечено. DB не менялась.

## Этап 10: admin search ДО пагинации — товары/бренды/категории (2026-08-25)
- ROOT CAUSE: поиск в админке был client-side по УЖЕ загруженным 20 строкам
  (products/page.tsx visibleProducts-memo); бренды/категории грузились целиком
  unbounded SELECT'ом и фильтровались на клиенте (нарушение F-инвариантов,
  нет total/pagination). Товар на позиции 1500 был ненайден.
- LIVE-ПРОБА PostgREST (scripts/tmp-probe-admin-search.ts, read-only):
  embed-пути ВНУТРИ or= (`brands.name.ilike`) НЕ ПАРСЯТСЯ живым сервисом
  («failed to parse logic tree»); рабочий шейп = резолв UUID заранее +
  `or=(name|sku|slug|yugcontract_id.ilike.%tok%, brand_id.in.(…),
  category_id.in.(…))` — подтверждено с COUNT(head)+range, большими in()
  (34 uuid), мульти-токеном AND (два .or()), пустыми ветками.
- app/lib/admin-list.ts (единый пайплайн для 3 списков):
  sanitizeSearchTerm РЕИСПОЛЬЗОВАН из catalog.ts (F3 не тронут);
  parseAdminListParams (page/size int-only, size≤100 default 20, sort-
  whitelist); search→DB or=→COUNT(filtered)→clamp page→range; все сортировки
  серверные с id-tiebreaker (products: name/price/stock+default created_at;
  brands: name/slug; categories: name/slug/sort_order). fetchAll{Brands,
  Categories} — bounded full-set (?action=all) для дропдаунов форм.
- Роуты: products/brands/categories GET default → lib (ответ {items,total,
  page,size}); action=active НЕ тронуты; brands/categories получили новый
  action=all. Products UI dropdown loaders + parent-picker категорий
  переключены на action=all (иначе селекты видели бы только страницу 1).
- UI (3 страницы): клиентский фильтр/сортировку УДАЛЕНЫ; поиск/sort/page в
  URL через app/lib/use-admin-list-state.ts (pushState/popstate, debounce
  300мс, НОВЫЙ поиск сбрасывает page=1, refresh/Back/Forward сохраняют
  состояние, stale-response guard); empty state различает «ничего не найдено
  по запросу»; пагинация считается от filtered total; PAGE_SIZE=20 сохранён;
  storefront/catalog pagination НЕ тронуты.
- Тесты tests/admin-search-pagination.test.ts (+18): runtime fake-PostgREST
  (реальный supabase-js) доказывает ПОИСК ДО ПАГИНАЦИИ — товар на позиции 33
  находится на странице 1 поиска, count-запрос несёт тот же or=, окна
  offset/limit режут отфильтрованный набор; санитайзер не пускает ,"( )%
  в паттерны; clamp/zero-match/no-filter/multi-token; статические инварианты.
- LIVE READ-ONLY верификация production БД (scripts/tmp-verify-admin-search-
  live.ts, service-client SELECT only): 19/19 PASS — «Мультипіч TEFAL
  EY501A10» (вне первых 20) найден поиском на странице 1, total=106 ==
  независимый COUNT; бренд TIKI (позиция ≥41) и категория blendery-1402
  аналогично; страница 2 без дублей; page=9999→6; очистка→4322/71/205.
- Playwright browser-верификация НЕВОЗМОЖНА в среде: нет chrome-канала
  (sudo недоступен) и системных libs для chromium; HTTP-проверки next start:
  /admin/* → 307 login (guard цел), новые query params доходят до роутов
  (401 pre-auth), /catalog 200. Auth не обходился; DB writes = 0.
- Итого 278 test pass (было 260); tsc/lint(2 pre-existing warnings)/build OK.

## Этап 11: storefront UI/UX — популярные товары + mobile-фильтры + категории (2026-08-25)
- «Популярні товари» на главной: fetchPopularProducts(limit=8) в catalog.ts —
  featured-first (is_featured=true, created_at desc/id desc) + добор новейших
  is_featured=false до лимита; оба чтения bounded range(0..n-1). Честная
  семантика: реального сигнала продаж нет (order_items пуст/недоступен,
  stock_history RLS-blocked), «популярність» — презентационная формулировка.
- Каталог mobile: фильтры вынесены в правый sheet за кнопкой «Фільтри»
  (+badge активных) по механике NavDrawer (portal, transition, focus trap,
  scroll lock, motion-reduce); desktop sidebar md:block не изменён;
  закрытие ✕/overlay/Escape/успешный «Застосувати». ФИКС latent-бага:
  «Застосувати» теперь СОХРАНЯЕТ q+sort и сбрасывает page (раньше теряла).
  Pure-модуль app/lib/filter-url.ts (unit-tested).
- Категории: native select (205 опций, 7 дублей имён) заменён на
  CategorySelect (поиск по полному набору + дерево путей «Корень → …»);
  pure app/lib/category-tree.ts: buildCategoryOptions (DFS из parent_id,
  сироты→корни, циклы безопасны) + filterCategoryOptions. URL contract
  category=slug не тронут; 0 новых DB reads.
- Тесты +43: filter-url(7), category-tree(7), popular-products(9),
  category-select(10), mobile-filter-drawer(10); ux-fixes P7 обновлён под
  sheet-контракт. Playwright недоступен в среде (нет chrome/libnspr4.so,
  sudo нет) — SSR-проверки next start вместо браузера, честно помечено.
  DB writes = 0.

## Этап 12: READ-ONLY RLS/security аудит заказов + P2 hardening (2026-08-26)
- РАЗРЕШЕНИЕ АНОМАЛИИ: «anon SELECT order_items → success, rows=0» — это НЕ
  пустая таблица и НЕ утечка, а invisible-table семантика RLS: в БД ЕСТЬ
  данные (service-counts: orders=4, order_items=4, customers=5), но anon не
  видит ни строки, ни count (head-count → 0). product_stock_history даёт
  42501 потому, что у него явно отозвана GRANT SELECT (006) — другой механизм.
- Эмпирика anon: все проекции/embeds/enumeration (ilike ORD-%, range-окна,
  fake-id фильтры) → 0 строк; кардинальность не утекает. RPC: place_order
  доступен anon (по дизайну; probe невалидным payload → собственная P0400),
  admin_set_order_status/admin_cancel_order/expire_pending_orders → 42501.
  OpenAPI-introspection /rest/v1/ для anon → 401 (surface не перечисляется).
- Код: lookup API — POST-only, rate-limit 5/min+20/h, generic-404 без
  оракула, проекция только order_number; view-страницы проверяют HMAC токен
  ДО любого чтения, белые списки колонок; service-role не попадает ни в один
  'use client' файл; admin routes — requireAdminApi на каждый handler.
- НАЙДЕНО P2: на orders/order_items/customers осталась GRANT SELECT для
  anon/authenticated — единственный слой защиты это RLS-without-policy;
  случайное DISABLE RLS или широкая политика молча открыли бы весь PII.
  МИГРАЦИЯ 014_orders_revoke_anon_select.sql ПОДГОТОВЛЕНА, НЕ ПРИМЕНЕНА
  (DDL из кода недоступен): revoke select on orders/order_items/customers
  from anon, authenticated. Безопасно: place_order SECURITY DEFINER,
  lookup/view через service-role. После применения: anon SELECT на этих
  таблицах должен стать 42501 (как stock_history). Верификатор:
  scripts/tmp-verify-orders-revoke.mts (read-only; сейчас честно FAIL
  до применения). Статические инварианты миграции: tests/
  orders-revoke-migration.test.ts. Footgun задокументирован в самой
  миграции: final_001 содержит ALTER DEFAULT PRIVILEGES ... GRANT SELECT
  ON TABLES TO public (авто-грант на будущие таблицы postgres).
- Аудит выполнен БЕЗ единой записи: 0 INSERT/UPDATE/DELETE/migrations/policy
  changes; RPC-пробы — только с невалидными аргументами (fail до данных).
  Итого 341 test pass; tsc/lint/build OK.
- ПРИМЕНЕНО (вручную SQL Editor, 2026-08-26): миграция 014. Верификация
  scripts/tmp-verify-orders-revoke.mts → ALL CHECKS PASSED: anon SELECT на
  orders/order_items/customers теперь 42501 (как stock_history), baselines
  не тронуты (products читаем), place_order EXECUTE жив, service-counts
  4/4/5 без изменений (0 записей). P2 ЗАКРЫТ. Напоминание на будущее:
  новые PII-таблицы — сразу RLS + явные гранты, не полагаться на
  DEFAULT PRIVILEGES GRANT SELECT TO public из final_001.

## Этап 13: SEO-пакет storefront (2026-08-26)
- F14 ФАКТ (live curl production-build): /product/[несуществующий] уже
  отдает НАСТОЯЩИЙ HTTP 404 — у сегмента нет loading/Suspense, рендер
  блокирующий, notFound() успевает выставить статус. Заметка этапа 9
  «HTTP 200» устарела. Механика по докам этой версии Next: notFound()
  дает 200+noindex ТОЛЬКО если стриминг уже начался (loading.tsx /
  Suspense-fallback) — см. node_modules/next/dist/docs (loading.md,
  Status Codes). /catalog?category=bogus СОЗНАТЕЛЬНО остается 200
  empty-state: это фильтр существующего ресурса (отдельных маршрутов
  нет), а loading.tsx каталога делает честный 404 невозможным без
  DB-проверки в proxy (отказ по latency).
- CANONICAL/NOINDEX ПОЛИТИКА — pure-слой app/lib/seo.ts (unit-tested):
  индексируемый набор ≡ sitemap: / , /catalog , /catalog?category=X ,
  /catalog?brand=Y (валидный slug, page=1, sort=default, без др.
  фильтров). Все остальные комбинации + ?q= + невалидный slug →
  noindex,follow БЕЗ canonical (на noindex страницах canonical
  игнорируется — не эмитим противоречивые сигналы). Search query в
  metadata: truncateQuery (контрол-символы/PostgREST-спецы стрипаются,
  cap 50) — XSS проверен live (<script> приходит &lt;-escaped от React).
- HOME получил собственные metadata (раньше наследовал общий layout-title);
  category/brand titles по паттерну «X — купити в E-Shop»; product:
  +self-canonical + og:url/locale/site_name (shallow merge терял их).
- ROBOTS.TXT: +Disallow /cart, /favorites. SITEMAP РАСШИРЕН до 4414 URL:
  static(8) + категории(205) + бренды(71) + товары(4130 = точный eligible-
  набор storefront: is_active + ≥1 фото через images!inner, whitelist
  slug/updated_at, окна ≤1000 c .order('id') через seo-sitemap.collectPaged
  (inject-fetcher, unit-tested; maxRows cap 100k). Приватных URL в
  выдаче 0 (проверено grep). Категории/бренды в sitemap → их /catalog?
  view'ы каноничны сами на себя.
- NOINDEX ТЕХНИЧЕСКИХ МАРШРУТОВ: новые segment-layouts cart/favorites/
  orders (один на lookup+[orderNumber])/checkout (один на flow+success) с
  robots index:false; + metadata в admin/(dashboard)/layout и admin/login.
  Live: все отдают <meta name="robots" content="noindex, nofollow"/>.
- PRODUCT JSON-LD: app/lib/schema-org.ts (pure, type-only импорт типов —
  node:test грузит без Supabase) + components/ProductJsonLd.tsx — ВТОРОЙ
  санкционированный dangerouslySetInnerHTML (инвариант-тест обновлен:
  ровно 2 sink'а allowlist'ом). Честность: только реальные поля БД;
  offers при price>0 (price/currency→ISO4217/availability-маппинг трех
  реальных статусов); aggregateRating ТОЛЬКО при total>0 опубликованных
  отзывов (fallback summary total=0 сам снимает его); сериализация
  JSON.stringify().replace(/</g,'\\u003c') — </script>-breakout исключен.
- H1-invariants закреплены статически: ровно один <h1> в home/catalog/
  product/not-found (+ InfoPage для info-страниц); catalog heading через
  единственную переменную catalogHeading.
- Тесты +34 (389→423): seo-metadata(14), seo-robots+noindex(3),
  seo-jsonld(8), seo-sitemap(5), h1-invariants(6)... npm test/tsc/lint
  (2 pre-existing warnings)/build OK. Live-матрица next start: все
  статусы/metadata/canonical/H1/JSON-LD подтверждены (см. этап выше).
  Playwright недоступен в среде (нет chrome/system libs) — браузерная
  проверка НЕ выполнялась, консольные ошибки клиента не снимались.
- DB: 0 INSERT/UPDATE/DELETE/migrations; только read-only SELECT anon.
  Бизнес-логика/importer/checkout/orders/auth/cart/RLS не тронуты.

## Этап 14: Priority 2 UX/UI — mobile catalog + product page (2026-08-26)
- ПРОВЕРКА GO-ПУНКТОВ: mobile sheet-фильтры (этап 11) и CategorySelect
  уже реализованы — НЕ тронуты. Ссылки бренд/категория на product page
  уже были; gallery main image уже priority (ux-fixes тест).
- «СХОЖІ ТОВАРИ»: catalog.ts → RELATED_LIMIT=8 + collectRelated (PURE
  слияние групп: категория → бренд → новейшие; dedupe по id; пропуск
  текущего) + fetchRelatedProducts (до 3 ПАРАЛЛЕЛЬНЫХ bounded-чтений,
  окно range(0,limit-1) каждое, PRODUCT_SELECT зеркало eligibility,
  neq id в SQL, tiebreaker created_at desc/id desc). Размещение блока —
  В КОНЦЕ catalog.ts: существующий popular-products тест режет файл
  по границе fetchPopularProducts→fetchActiveCategories и считает
  .range( — вставка между ними ломала его счётчик (перенос = фикс без
  правки чужого теста). RelatedProducts.tsx (server, h2, grid-cols-2
  lg:4, return null при пустом). Product page: try/catch деградация
  (паттерн отзывов), блок между «Варіанти» и «Відгуки».
- DELIVERY-CTA: компактный блок под AddToCartButton со ссылкой /delivery;
  никаких выдуманных фактов об оплате (тест инспектирует ТОЛЬКО наш блок,
  не весь HTML — supplier-описания могут содержать любые слова).
- LCP КАРТОЧЕК: ProductCard + опциональный priority=false prop;
  home featured idx<4, каталог idx<6. Live-факт этой версии next/image:
  unoptimized+priority рендерится БЕЗ loading/fetchpriority атрибутов
  на img, но добавляет <link rel="preload" as="image"> в head (6 шт на
  /catalog) и ОТСУТСТВИЕ loading == eager по HTML-спеке; остальные
  карточки loading="lazy". Миниатюры галереи lazy.
- LANDMARK-пины: product page ровно один <main>; header/footer без main.
- Тесты 423→437 (+14: related-data 6, related-component/page 2,
  delivery-CTA 1, LCP/landmark 5). npm test/tsc/lint(2 pre-existing)/
  build OK. Live: related=8 карточек category-first, CTA, main×1,
  preloads/eager/lazy распределение. Playwright недоступен в среде
  (нет chrome/system libs).
- DB: 0 writes; только read-only SELECT (3 окна ≤8 строк на товар).
  SEO/checkout/orders/auth/importer/reviews/recently-viewed не тронуты.

## Этап 15: Priority 3 UX fixes (2026-08-26)
- R1 ЦЕНЫ: format.ts — единственная точка рендера цен; Intl.NumberFormat
  uk-UA: целые с NBSP-группировкой («17 599 UAH»), дробные РОВНО 2 знака
  через запятую («99,50» — прежний cart-контракт сохранён; первый вариант
  min/max=0 давал «99,5» — поймано тестом). Переведены ProductCard,
  product page (main/old price + варианты → product.currency вместо ₴),
  label фильтра «Ціна (UAH)». Related/Recent наследуют через ProductCard.
  Расчёты скидок/корзины/заказов не тронуты (old_price! как в формуле %).
- N1 RecentProducts: внешний container mx-auto px-4 wrapper УДАЛЕН —
  секция выровнена с соседями внутри main.container (данные/localStorage
  не тронуты).
- R2 ПАГИНАЦИЯ каталога: общий класс geometry для prev/next; disabled —
  span aria-disabled="true" (единый стиль aria-disabled:* вариантами);
  URL/clamp/logic без изменений. Live: page=1 → ровно 1 aria-disabled.
- R3 КАТЕГОРИИ ГЛАВНОЙ: подпись «Переглянути товари →» всегда видима
  (hover-only удалён); 5-я карточка col-span-2 sm:col-span-1 — без сироты
  в mobile grid. Кол-во категорий (5) и ссылки не менялись.
- N2 СЕТКИ: Related/Recent/Popular получили md:grid-cols-3 между
  grid-cols-2 и lg:grid-cols-4. Максимумы (8) и порядок данных не тронуты.
- R4 THUMBNAILS: Playwright недоступен (браузер скачан, но нет системных
  libs/sudo) — clipping НЕ подтверждён и НЕ исправлен (честно, по GO).
- Тесты 437→446 (+9 p3-ux pins; format-price переписан под uk-UA;
  mobile-filter-drawer: label-regex обновлён на «Ціна (UAH)» — интент
  теста «поле цены живёт в shared form» сохранён). tsc/lint(2 pre-
  existing)/build OK. Live: «17 599 UAH» c NBSP, ₴=0 на catalog/product,
  hover-only=0, col-span фикс, md-ступень в HTML, aria-disabled работает.
  DB: 0 writes.


## Етап 16: Security hardening (2026-08-27)
- TRUNCATE: міграція 024 revoke truncate on all tables in schema public
  from anon, authenticated (застосована через migration runner; live-аудит
  information_schema: після — TRUNCATE лише у postgres/service_role).
  RLS не захищає від TRUNCATE — це не row-level операція.
- XFF/rate-limit: clientIpOf НЕ змінено. Vercel edge перезаписує
  x-forwarded-for і не пропускає зовнішні значення (anti-spoofing,
  vercel.com/docs/headers/request-headers); перший елемент XFF = 
  edge-verified IP. Припущення задокументовано в rate-limit.ts + тести
  tests/rate-limit-xff.test.ts. УВАГА: за іншим proxy — перевірити знову.
- CSP: enforcing (Content-Security-Policy у next.config.ts). 'unsafe-inline'
  залишено у script-src/style-src З ДОКУМЕНТОВАНОЮ причиною: nonce вимагає
  динамічного рендерингу ВСІХ сторінок (ISR/static вимкнено — офіційні
  docs Next). 'unsafe-eval' лише в dev. Тести tests/csp-enforcing.test.ts.
- Storage product_images: file_size_limit=5242880 (5MB),
  allowed_mime_types=[jpeg,png,webp,gif,avif] (міграція 025). 
  sanitizeFileName → app/lib/upload-filename.ts: розширення з whitelist,
  примусово = магічно верифікованому MIME (svg/html неможливі). Тести
  tests/storage-hardening.test.ts. public=true збережено (не змінювалось).
- Auth Leaked Password Protection: УВІМКНЕНО власником 2026-09-16 —
  Dashboard → Authentication → Providers → Email → секція налаштувань
  пароля → "Prevent the use of leaked passwords" (HaveIBeenPwned).
  Примітки: старий шлях «Authentication → Policies» більше не існує;
  налаштування dashboard-only — програмно стан не експонується
  (/auth/v1/settings та admin config API), єдиний спосіб перевірки —
  очима в дашборді. Application auth flow не змінюється (перевірка лише
  при signup/password update).


## Етап 17: операційні синки 2026-09-18 — YUG + перший реальний экспорт лінолеуму (2026-09-18)
- YUG sync (Windows-лаунчер): exit 0, RUN_ID yc-2026-09-18-13-28-09;
  вставлено 13, оновлено 762, пропущено 9, помилок 0 (prepare 142с +
  run 204с). Health: WARN = лише advisory-беклог (280 товарів без фото,
  15 pending-замовлень >24г, _du price-drift 74 пари → health радить
  regenerate allowlist — окрема coding-задача, не зроблена).
- Шпалери: выгрузка 18.09 («Остатки 18,09.xls», 528 позицій, 4348 рулонів)
  → ingest 528 accepted / 0 rejected → run: 0 creates, 26 оновлень
  (лише stock_quantity), 2 зниклі→OOS, history 28, no-op 509; publish:
  0 опубліковано / 0 приховано (з фото 444 з 537 wc-*).
  Нюанс ключа: data/WALLPAPER_INGEST_KEY.txt — рядки 1-3 нотатки,
  токен у 5-му рядку (hex64); `cat` цілим файлом ламає header (400/401).
- Лінолеум: ПЕРШИЙ реальний экспорт («Остатки 18,09,26.xls», 54 позиції,
  всі 6 ширин). Встановлено фактом: «Ціна» в 1С = грн/м² (розбігається з
  «грн/м.п» у назвах на ширину); метри в 1С дробні (полотна/распили) —
  конвертер робить floor (1920.3 → 1895 м, 3 позиції <1м → 0). За
  тригером «пишется по первому реальному файлу» (AGENTS.md) написано
  scripts/1c-export/xls-linoleum-to-ingest-csv.py (дзеркало обоєвого).
  Ingest 54/0; run: +52 картки (+52 варіанти), 0 upd / 0 missing /
  0 conflicts, no-op 81; нові картки НЕВИДИМІ (is_active false).
- БЛОКЕР публікації лінолеуму (стан на 2026-09-18):
  data/linoleum-photos.json матчить по seed-іменах (6 дизайнів), а
  --publish активує ВСІ ln-* з фото → активувався б 7 старих seed-карток
  (плейсхолдер-ціни/наявність), реальні 52 без фото лишаються невидимими.
  Потрібне coding-рішення: matchBy під реальні імена / інша логіка
  ідентичності дизайну. До того момента --publish лінолеуму НЕ робити.
