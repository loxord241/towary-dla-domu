# Проект my-shop - Техническая документация

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
├── robots.ts / sitemap.ts     # Индексация: публичные страницы; admin/api/checkout/orders закрыты
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
email, expires_at, payment_status), order_items (+variant_name/sku), product_stock_history

## Checkout / Orders (миграции 006–008)
- place_order(payload jsonb) — SECURITY DEFINER: lock -> validate -> цены ТОЛЬКО из БД ->
  customer upsert -> order + items -> декремент стока -> audit history. Клиент шлёт только
  идентификаторы, количество и контактные строки.
- Номер заказа ORD-YYYYMMDD-XXXXXX, уникальный индекс, collision-retry.
- Админ-RPC: admin_set_order_status (forward-only map), admin_cancel_order (атомарный
  возврат стока, double-restock невозможен), expire_pending_orders (SKIP LOCKED).
  EXECUTE только у service_role.
- Истечение pending через 24ч: pg_cron (включить в Dashboard) или POST /api/admin/orders/expire.

## Правила безопасности (не нарушать)
- Service role ключ — только в server-side коде; в client bundle не попадает
- Все /api/admin/* начинаются с requireAdminApi() (401/403/200)
- Email-проверка админа — case-insensitive (ilike), т.к. Auth нормализует email
- Загрузка изображений: MIME allow-list + магические байты + лимит 5 МБ + санитизация имени файла
- Гостевые страницы заказов: HMAC token от service key (order-token.ts), verify constant-time
- Ошибки БД наружу: dbErrorResponse маппит коды; сырой error.message клиенту не возвращается
- Security headers в next.config.ts: nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy

## Текущий функционал
- Storefront: главная, каталог (фильтры: категория, бренд, цена, наличие, поиск, сортировка),
  страница товара, корзина, избранное, checkout, success, guest order lookup/view
- Корзина/избранное: localStorage хранит ТОЛЬКО productId+variantId+quantity (корзина);
  все цены/наличие — с сервера (/api/cart-preview). Финальный авторитет цен — place_order().
- Admin: логин/логаут, товары (+изображения с загрузкой в Storage, варианты),
  бренды, категории, заказы (список/детали/статусы/отмена/истечение)

## Система uk-переводов (удалена из кода 2026-08)
- Весь контент сайта и данные поставщика на украинском — переводы признаны избыточными.
- Из кода удалены: overlay-запросы в catalog.ts (было +3 запроса на страницу),
  поиск по translations, uk-блоки в формах админки, /admin/translations, /api/admin/translations.
- ТАБЛИЦЫ products/categories/brands_translations ОСТАВЛЕНЫ в БД (пустые, не мешают).
  Если когда-нибудь понадобится второй язык — восстановить по истории git.

## Известные ограничения (осознанные)
- Оплата НЕ реализована (payment_status='unpaid'; менеджер согласует вручную)
- Rate-limit in-process: сбрасывается при рестарте, не работает на multi-instance (нужен Redis/DB)
- Пагинация каталога отсутствует
- Sitemap без отдельных страниц товаров (каталог/категории покрывают перелинковку)
- CSP-заголовок не настроен (требует подбора nonce/hash под Next.js) — см. deployment checklist

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
