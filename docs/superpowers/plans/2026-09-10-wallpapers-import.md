# Wallpapers Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ежедневный sync обоев из 1С 7.7 владельца на витрину: CSV → ingest → staging → идемпотентный импортер → фото из 5 источников → публикация с честным правилом наличия.

**Architecture:** Новый поставочный канал «wallpapers» повторяет проверенные паттерны проекта: cron-роут даёт модель bearer-auth, `yc_content_goods` — модель staging (RLS on, без policies), Юг-импортер — модель plan/run с чекпоинтами. Новый сервис-слой в `app/lib/wallpapers/` — только pure-функции (unit-tested), исполнители — CLI-скрипты в `scripts/`. Money-path не затрагивается.

**Tech Stack:** Next.js 16.3.1 App Router (route handlers), node:test, Supabase (Postgres RLS, Storage), service-role client server-side only.

**Spec:** `docs/superpowers/specs/2026-09-10-wallpapers-import-design.md` (читать вместе с этим планом)

## Global Constraints

- СУБАГЕНТАМ ЗАПРЕЩЕНО: `npm run build` / `next dev` / `next start`, commit/push, `graphify update`, `--run/--apply` исполняемых скриптов, запись в БД (кроме отдельных оговорённых тестовых моков). Сборка и миграции — только у оркестратора.
- Это НЕ тот Next.js из весов: читать `node_modules/next/dist/docs/` перед работой с роутами/конфигами.
- Тесты: `npm test` (node:test, базлайн зелёный); проверки: `npx tsc --noEmit`, `npm run lint` (0 errors, 17 pre-existing warnings в tests/yugcontract-*). Ориентир — pass/fail, не абсолютные числа.
- Никаких RPC/DDL из кода приложения: миграции только файлом в `database/migrations/`, применяет оркестратор через Supabase MCP.
- Секреты (ключ выгрузки, service-role) не печатать и не коммитить; в тестах — только фиктивные значения.
- Сток: единственный источник правды — staging из 1С; продажи сайта списывают `stock_quantity` (place_order не трогаем); availability_status меняется ТОЛЬКО триггером миграции 040.
- Загрузка в Storage: JPEG/PNG/WebP, ≤5 МБ (bucket limit), имя файла санитизировать (`app/lib/upload-filename.ts`).
- Уникальный индекс `idx_product_images_product_url (product_id, image_url)` — дубль фото = ошибка 23505, пайплайн обязан быть diff-aware (INSERT только новых пар).
- Ограничение `.in()` ≤ 200 id, пагинация окна ≤1000 с `.order()` — проектные инварианты (pagination-hardening тест).

---

### Task 1: Миграция 040 — правило наличия (триггер)

**Files:**
- Create: `database/migrations/040_availability_from_stock.sql`
- Test: `tests/availability-migration.test.ts`

**Interfaces:**
- Produces: триггеры `trg_products_availability_from_stock` / `trg_product_variants_availability_from_stock` на UPDATE OF stock_quantity; semantics: `NEW.stock_quantity = 0 → NEW.availability_status='out_of_stock'`, `> 0 → 'in_stock'` (INSERT не трогаем — импортеры сами ставят согласованно).
- Оркестратор применяет через MCP; VER-SELECT'ы до/после в шапке файла.

- [ ] **Step 1: Написать миграцию**

```sql
-- 040_availability_from_stock.sql
-- Правило наличия (GO владельца 2026-09-10): остаток 0 => «Немає в наявності».
-- INSERT не трогаем: Юг-синк и wallpapers-импортер пишут оба поля согласованно.
-- VERIFY-PRE: select count(*) from pg_trigger where tgname like 'trg_%_availability_from_stock';  -- до: 0
-- VERIFY-POST: обновить products set stock_quantity = stock_quantity where id = <тестовый id>; availability_status должен следовать за qty (проверить на 2 строках: qty=0 и qty>0), откатив значения обратно.

CREATE OR REPLACE FUNCTION set_availability_from_stock()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.availability_status := CASE WHEN NEW.stock_quantity > 0 THEN 'in_stock' ELSE 'out_of_stock' END;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_products_availability_from_stock
BEFORE UPDATE OF stock_quantity ON products
FOR EACH ROW EXECUTE FUNCTION set_availability_from_stock();

CREATE TRIGGER trg_product_variants_availability_from_stock
BEFORE UPDATE OF stock_quantity ON product_variants
FOR EACH ROW EXECUTE FUNCTION set_availability_from_stock();
```

- [ ] **Step 2: Статический тест миграции** (по образцу `tests/orders-revoke-migration.test.ts`): файл существует, содержит оба CREATE TRIGGER, `BEFORE UPDATE OF stock_quantity`, `'out_of_stock'`/`'in_stock'`, отсутствие DELETE/INSERT-стейтментов против place_order-инвариантов.
- [ ] **Step 3: `npm test`** — PASS; `npx tsc --noEmit` — clean.
- [ ] (оркестратор, вне субагента) применить через MCP + VERIFY-POST.

### Task 2: Миграция 041 — staging `wallpaper_stock`

**Files:**
- Create: `database/migrations/041_wallpaper_stock_staging.sql`
- Test: `tests/wallpaper-staging-migration.test.ts`

**Interfaces:**
- Produces: таблица `wallpaper_stock (id uuid pk default gen_random_uuid(), export_date date not null, code text not null, name text not null, price_retail numeric not null check (price_retail >= 0), qty numeric not null check (qty >= 0), created_at timestamptz default now())`; RLS enabled, policies НЕ создаются (только service role); index на `export_date`.

- [ ] **Step 1: SQL** (по образцу 011/yc_content_goods: RLS on без policies; UNIQUE НЕ нужен — каждый экспорт дописывает строки, читаем `DISTINCT ON (code) ... order by export_date desc` при импорте).
- [ ] **Step 2: Статический тест**: файл содержит `ENABLE ROW LEVEL SECURITY`, не содержит `CREATE POLICY`, check-констрейнты на цену/qty.
- [ ] **Step 3: `npm test`** PASS.
- [ ] (оркестратор) применить через MCP; VER: `select count(*) from wallpaper_stock` → 0; `select * from wallpaper_stock limit 1` под anon → permission denied.

### Task 3: Pure-парсер CSV, артикулов и размеров рулона

**Files:**
- Create: `app/lib/wallpapers/parse.ts`
- Test: `tests/wallpaper-parse.test.ts`

**Interfaces:**
- Produces:
  - `parseWallpaperCsv(text: string): { rows: WallpaperRow[]; errors: CsvError[] }` где `WallpaperRow = { code: string; name: string; article: string | null; rollSize: RollSize | null; priceRetail: number; qty: number }`, `RollSize = { widthCm: 53 | 106; lengthM: 10 | 15 }`, `CsvError = { line: number; reason: string }`. Разделитель `;`, header `code;name;article;unit;price_retail;qty`, первая строка header (опциональна — если поля совпали), BOM терпим.
  - `parseArticleTokens(name: string): string[]` — форматы: `NNNN-NN`, `NNNN NN`→dash, `NNNNN..NNNNNNN`, alnum `NNNNNN[а-яa-z]{1,3}NN` (86000br90), `([a-z]{1,2}) ?(NNN)` → `sp515`. Реинваймент логики чеклиста-матчера (см. scripts-прототип от 2026-09-10, /tmp удалится — тест фиксирует правила).
  - `parseRollSize(name: string): RollSize | null` — паттерны `53см*10м`, `0,53*10м`, `1,06*10м`, `53см×15м`, `106х10`.

- [ ] **Step 1: Пишешь падающие тесты** на фикстурах РЕАЛЬНЫХ названий из инвентаризации (взять 12 репрезентативных, вкл. `6647-04 шпалери,53см*10м`, `86000BR90 Браво темні, шпалери 1,06*10м`, `SP 531-34 какао+золото/шпалери 1,06*10м`, `Абстракция 5243 02 беж` (article `5243-02`), `30202 бузкова лілея шпалери` (article `30202`), кривые строки → errors).
- [ ] **Step 2: `npm test`** → FAIL.
- [ ] **Step 3: Имплементация** (node:crypto не нужен; только regex; строгое чтение чисел: `Number.isFinite`, цены clamp-валидация на уровне ingest).
- [ ] **Step 4: `npm test`** PASS; `npx tsc --noEmit` clean.

### Task 4: Категории — маппинг подгрупп 1С → категории сайта

**Files:**
- Create: `app/lib/wallpapers/categories.ts`
- Test: `tests/wallpaper-categories.test.ts`

**Interfaces:**
- Consumes: `parseWallpaperCsv`.
- Produces: `WALLPAPER_CATEGORY_MAP: Record<string, { name: string; slug: string }>` — 10 подгрупп (Акрил→`shpaleri-akryl`, Вінил 10 м→`shpaleri-vinyl-10m`, Вінил 15 м, Дуплекс, Метрові, Флізелін, Шовкографія, Мійка проста, Прості шпалери, Супермійка) + `WALLPAPER_ROOT = { name: 'Шпалери', slug: 'shpaleri' }`.
- Produces: `planCategoryUpsert(existing: { slug: string; name: string; parentSlug: string | null }[]): { creates: …; links: Record<subgroup, categoryId> }` — pure-план: корень «Шпалери», дети = 10 категорий; если slug существует — reuse, не создавать дубль.

- [ ] **Step 1: Падающие тесты** (маппинг полон — ровно 10, никакая подгруппа не теряется; идемпотентность плана; конфликт существующего slug с другим именем → ошибка плана).
- [ ] **Step 2-4:** FAIL → имплементация → PASS + tsc.

### Task 5: Ingest-эндпоинт `POST /api/ingest/1c-wallpaper`

**Files:**
- Create: `app/api/ingest/1c-wallpaper/route.ts`
- Test: `tests/wallpaper-ingest.test.ts`

**Interfaces:**
- Consumes: `parseWallpaperCsv`, миграция 041 (staging).
- Produces: POST c `Authorization: Bearer ${WALLPAPER_INGEST_SECRET}` (env; unset → 401 fail-closed, sha256+timingSafeEqual — скопировать модель `cronAuthorized()` из `app/api/cron/reconciliation/route.ts:47`); `Content-Type: text/csv`; лимиты: body ≤ 2 МБ, строк ≤ 2000, цена 0..100000, qty 0..9999 (вне — reject строки, не файла); `X-Export-Date: YYYYMMDD` обязателен и не старше 400 дней; пишет в `wallpaper_stock` (service-role client, `persistSession:false`); ответ `202 { accepted, rejected, exportDate, errors: первые 20 }`; ошибки записи → 500 без internals; других методов → 405. `export const maxDuration = 60`.

- [ ] **Step 1: Падающие тесты**: runtime fake-PostgREST (паттерн `tests/pagination-hardening.test.ts`) + статические инварианты (нет GET-экспорта, constant-time auth, лимиты в коде). Кейсы: нет/кривой секрет → 401; валидный CSV → 202 accepted=N; строка с ценой -1 → rejected=1; BOM+header → ок; body > 2 МБ → 413.
- [ ] **Step 2-4:** FAIL → имплементация → PASS + tsc + `npm run lint` (0 errors).

### Task 6: Импортер — pure-планировщик

**Files:**
- Create: `app/lib/wallpapers/import-plan.ts`
- Test: `tests/wallpaper-import-plan.test.ts`

**Interfaces:**
- Consumes: `WallpaperRow[]` (свежие на export_date: `DISTINCT ON (code) ... ORDER BY code, export_date DESC`), существующие товары (`yugcontract_id IS NULL AND sku LIKE 'wc-%'` — wallpaper-домен определяется sku-префиксом `wc-<code>`).
- Produces: `planWallpaperImport(existing: Map<string, ExistingProduct>, rows: WallpaperRow[]): WallpaperPlan`
  - `creates: { sku, slug, name, price, stockQty, availability, categoryId, isActive:false }[]` — slug = `wc-<нормализованный код>` (уникален by construction, коллизия → суффикс `-2`); name = имя из 1С как есть (укр.);
  - `updates: { id, fields: { price?, stock_quantity? } }[]` — diff-aware: менять только расхождения;
  - `missing: { id }[]` — были в `wc-`, исчезли из файла → статус OOS (qty=0), НЕ удаление;
  - `noops`, `conflicts` (sku-кластер занят не-wallpaper товаром → в отчёт, не пишем).
  - isActive управляется ОТДЕЛЬНО (Task 9 — publish gate по наличию фото).

- [ ] **Step 1: Падающие тесты**: создание, пере-план = noops (идемпотентность), изменение цены/остатка → только diff-поля, исчезнувшая позиция → missing(OOS), slug-коллизия, конфликт домена sku.
- [ ] **Step 2-4:** FAIL → имплементация → PASS + tsc.

### Task 7: Импортер — CLI-исполнитель

**Files:**
- Create: `scripts/wallpaper-import.ts` (`--plan` | `--run`)
- Test: `tests/wallpaper-import-cli.test.ts` (статические инварианты: только SELECT/UPSERT/UPDATE, батчи ≤200, history при изменении стока с source='1c-wallpaper')

**Interfaces:**
- Consumes: `planWallpaperImport`, service-role client (`.env.local`), категории из Task 4.
- Produces: `--plan`: печатает план (creates/updates/missing/noops/conflicts), 0 записей; `--run`: батчи ≤200, каждая строка-изменение стока → `product_stock_history (source='1c-wallpaper')`, availability НЕ трогается руками (триггер 040); финальная сводка в stdout. Никаких DELETE.

- [ ] **Step 1: Статические тесты** (паттерн import-plan тестов Юга).
- [ ] **Step 2-3:** имплементация; `npm test` + tsc. **Субагент НЕ запускает `--run`.**

### Task 8: Фото-пайплайн — CLI

**Files:**
- Create: `app/lib/wallpapers/photo-sources.ts` (pure: индексация slug→артикул, матчеры, выбор основного фото)
- Create: `scripts/wallpaper-photos.ts` (`--index <source>` | `--plan` | `--run [--source slav|epicentr|shpalery-ua|styleo|shpaleru]`)
- Test: `tests/wallpaper-photo-sources.test.ts`

**Interfaces:**
- Consumes: `parseArticleTokens`; sitemap-индексы источников (кэш в `data/photo-cache/<source>.json`, скачивание curl-подобным fetch c UA-заголовком и таймаутом; троттлинг 200 мс).
- Produces (pure): `matchSourceByUrl(urls: string[], articleTokens: string[]): string | null` — строгий матч токена (`(?<!\d)tok(?!\d)`), приоритет источников: slav → epicentr → shpalery-ua → styleo → shpaleru.
- `--run` семантика: slav → hotlink-URL (`assets/products/<id>/*.jpg`, главное = первый `<img>` страницы, ≤12 текстур) в `product_images.image_url`; остальные источники → скачать (≤5 МБ, MIME-whitelist) → `upload-filename.ts` → Storage `product_images/<slug>/<sanitized>.<ext>` → относительный путь. Diff-aware по уникальному индексу (existing pairs читать с явной пагинацией ≤1000 + `.order('id')`, паттерн content-images). 23505 → пропуск как no-op. Все товары БЕЗ фото остаются is_active=false до Task 9.

- [ ] **Step 1: Падающие pure-тесты** матчеров на фикстурах-URL (реальные примеры из research: `v277-6647-04`, `bravo-86000br90-1-06x10-05-m.html`, `p…-shpaleri-arlekino-7165-10.html`, `...-uchkuduk-1323-04-...`, дубль-суффиксы `-07f80d`).
- [ ] **Step 2-3:** имплементация + статические тесты CLI. **Субагент НЕ запускает `--run`** (только `--index` на стейдж-фикстурах в /tmp).

### Task 9: Publish gate + freshness-крон

**Files:**
- Modify: `scripts/wallpaper-import.ts` (добавить action `--publish`)
- Create: `app/api/cron/wallpaper-freshness/route.ts`
- Modify: `vercel.json` (добавить cron `0 15 * * *` → `/api/cron/wallpaper-freshness`)
- Test: `tests/wallpaper-publish.test.ts`

**Interfaces:**
- `--publish`: `UPDATE products SET is_active=true WHERE sku LIKE 'wc-%' AND EXISTS (SELECT 1 FROM product_images ...)`, остальные wc- → is_active=false; отчёт «опубликовано X, скрыто Y». Publish — ОРКЕСТРАТОР по GO.
- Freshness-крон: GET + `cronAuthorized`-модель (тот же CRON_SECRET); читает `max(export_date)` из `wallpaper_stock`; если NULL или старше 26ч → `sendTelegramText` владельцу (модель telegram.ts), всегда 200 JSON-сводка (модель reconciliation-роута).

- [ ] **Step 1: Тесты** (статика: publish — единственный writer is_active в скрипте, крон не пишет в products; крон-сводка при пустом staging).
- [ ] **Step 2-3:** имплементация + tsc + lint.

### Task 10: Интеграционная фаза (ТОЛЬКО оркестратор)

- [ ] Применить миграции 040, 041 через MCP (VERIFY до/после).
- [ ] Сгенерировать `WALLPAPER_INGEST_SECRET`, отдать владельцу ВНЕ чата (лично/файлом), записать в Vercel env + .env.local.
- [ ] Полный прогон: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` (сборка — только оркестратор).
- [ ] Первый живой прогон: владелец/1С-ник ставит VBS (черновик в `scripts/1c-export/`) → файл приходит → `wallpaper-import.ts --plan` → отчёт владельцу → по GO `--run`, `wallpaper-photos.ts --run` (источники по одному), `--publish`.
- [ ] После кода: `graphify update .`; батч-пуш по GO владельца.

## Self-Review

- Spec §3 (канал): Tasks 2,3,5,7,10 ✅; §4 (фото): Task 8 ✅; §5 (040): Task 1 ✅; §6 (мониторинг): Task 5 limits + Task 9 freshness ✅; §7 (калькулятор) — вне плана, отдельный (сознательно, фаза 2) ✅; §8 (инварианты) — Global Constraints ✅.
- Типы: `WallpaperRow`/`RollSize` определены в Task 3, потребляются в 5,6,8 — имена совпадают.
- Миграции: 040 (Task 1), 041 (Task 2) — номер следующий после 039 ✅.
