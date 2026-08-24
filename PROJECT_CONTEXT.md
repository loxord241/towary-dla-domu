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
