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
products/categories/brands_translations, admin_users, customers, orders (+order_number,
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
- Admin: логин/логаут, товары (+изображения с загрузкой в Storage, варианты, uk-переводы),
  бренды, категории, заказы (список/детали/статусы/отмена/истечение)

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
