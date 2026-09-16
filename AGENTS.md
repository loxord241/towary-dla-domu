<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# TOWARY DLA DOMU — правила для coding agents

Интернет-магазин (укр. контент) двух доменов: бытовая техника (поставщик
Yugcontract, витрина `/catalog`) и шпалеры (sku `wc-*`, витрина `/oboi`,
остатки из 1С владельца). Гостевой чекаут, оплата 100% онлайн LiqPay,
доставка Nova Post / Ukrposhta / самовывоз. Публичной регистрации нет —
Supabase Auth только для админов.

**Стек**: Next.js 16 (App Router, Turbopack) · React 19 · TypeScript ·
Tailwind v4 · Supabase (PostgreSQL + RLS, Auth, Storage) · Vercel ·
тесты `node --test` · Node 24.

**Документы**: [ARCHITECTURE.md](ARCHITECTURE.md) — как устроено (факты по
коду, established decisions, constraints); [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)
— история этапов и инцидентов с верификациями; `docs/` — аудиты и specs.
Если документация противоречит коду — код прав; зафиксируй расхождение
в доке или доложи владельцу, но не копируй устаревшее утверждение дальше.

Эти правила — общие для ЛЮБОГО coding agent (GLM, Gemini, Claude и др.).
Один репозиторий — один source of truth.

## Workflow: READ-ONLY → IMPLEMENTATION → PRODUCTION

1. **READ-ONLY** — сначала понять: `ARCHITECTURE.md` (раздел про зону
   изменений), реальный код зоны, смежные тесты. Для навигации по коду —
   `graphify query` (см. ниже). Ничего не менять, пока не сформулирован
   root cause и минимальный план.
2. **IMPLEMENTATION** — минимальное изменение + тесты. Новая логика —
   сначала тест (TDD там, где применимо); на баг — regression-тест,
   воспроизводящий его до фикса.
3. **PRODUCTION** — деплой/миграции/запись в живую БД — только по явному
   GO владельца (см. «Production-действия»). Локальная верификация
   (`npm test`, `npm run build`, read-only проверки) — до запроса GO.

## Scope и root cause

- Прежде чем править — установи root cause, а не симптом. Гипотезу
  подтверждай чтением кода/логов/пробой на read-only сценарии.
- Если задача звучит как «сделай X», а анализ показывает, что причина в Y —
  сначала доложи, не расширяй scope молча.
- Минимальный diff. Запрещены попутные рефакторинги, переименования,
  «улучшения» форматирования и апгрейды зависимостей вне задачи.
- Изменение сломанного теста — только вместе с обоснованием, почему
  сломан инвариант, а не тест.

## Факты: FACT / INFERENCE / UNKNOWN

- **FACT** — проверено кодом/конфигом/выводом команды. Цитируй источник
  (файл:строка или команда).
- **INFERENCE** — вывод из фактов; помечай как вывод.
- **UNKNOWN** — не знаешь; так и пиши. Не заполняй пробелы правдоподобными
  догадками и не выдавай их за подтверждения владельца или кода.
- Никогда не приписывай владельцу решений, которых он не принимал.
  Предложения агента — это предложения, а не установленные решения; они
  попадают в Established decisions только после GO владельца.

## Сначала паттерн проекта

Перед созданием нового: ищи готовый паттерн в коде и в
`ARCHITECTURE.md` §16–17 (Established decisions / Constraints). Примеры
закреплённых паттернов: витринные чтения — только `app/lib/catalog.ts`;
админ-API — через `requireAdminApi()`; пагинация ≤1000 + `.order('id')`;
client fetch — через `lib/cart-preview.ts`; изображения —
`getPublicImageUrl()`; новый HTML-рендер — только в allowlist sink'ах.
Новый паттерн = архитектурное предложение владельцу, не локальная инициатива.

## Обязательные проверки после изменений кода

1. `npm test` — 0 fail (204 файла, ~2351 тест, ~6с).
2. `npx tsc --noEmit` и `npm run lint` — без новых ошибок (2 pre-existing
   lint warnings допустимы).
3. `npm run build` — если менялись страницы/конфиг/редиректы.
4. `graphify update .` — после изменений кода (AST-only, бесплатно).
5. Read-only live-проверки, где применимо (`scripts/catalog-health-check.ts`).

## Git

- Ветка `main`; коммить маленькими единицами с conventional-префиксом
  (`fix(scope):`, `feat:`, `chore:`, `docs:`, `test:`), язык сообщений —
  русский/укр. как в истории.
- **Коммит/пуш — только по задаче от владельца или по явному GO.** Перед
  пушем `git pull --rebase` (был инцидент параллельных сеансов 2026-09-15:
  WSL и Windows писали в один репо; работаем из ОДНОГО чекаута — Windows).
- Не коммить: `.env.local`, `data/`, `logs/`, токены. Если секрет попал в
  дифф — остановись и доложи (ротация обязательна).
- Правки в коммитах, уже запушенных, — только новым коммитом (не reword/force).

## Безопасность

- Секреты — только server-side (`SUPABASE_SERVICE_ROLE_KEY`, `YUGCONTRACT_*`,
  `NOVA_POSHTA_API_KEY`, `TELEGRAM_*`, `CRON_SECRET`,
  `WALLPAPER_INGEST_SECRET`, `LIQPAY_*`); в client bundle и в ответах API —
  никогда. Публичные ключи — `NEXT_PUBLIC_*`.
- Ошибки БД наружу — через `dbErrorResponse`; сырой `error.message` клиенту
  не возвращается.
- Внешние данные провайдеров — strict whitelist парсинг, провайдеру не доверяем.
- HTML от поставщика хранится только санитизированным; `dangerouslySetInnerHTML`
  разрешён ровно в 4 местах allowlist'ом (ProductDescription, ProductJsonLd,
  FaqJsonLd, OrganizationJsonLd — инвариант-тест) — не добавляй пятый без GO.
- Чужие вводы: `sanitizeSearchTerm` для поиска, валидаторы `isUuid`/`nonNegNumOrNull`
  для API, `upload-filename.ts` для загрузок.

## Критические зоны (особые ограничения)

- **DB/RLS**: гранты и RLS-политики — security boundary (миграции 014, 024,
  032, 033, 035, 036, 039). Любая новая таблица: RLS + явные гранты сразу
  (final_001 авто-грантит SELECT → public — footgun). Миграции применяются
  ВРУЧНУЮ через SQL Editor, из кода DDL недоступен; новый файл миграции —
  последовательный номер.
- **checkout/orders/payments**: клиент шлёт только контакты + идентификаторы;
  деньги/сток считает `place_order()` (SECURITY DEFINER, вызывается
  service-ролью из route — EXECUTE у anon отозван миграцией 036). LiqPay
  callback — условный UPDATE с interlock против cancelled/expiration.
  Rate-limit'ы checkout/lookup не ослаблять.
- **stock**: декремент только в place_order, возврат только в
  admin_cancel_order; каждая запись — строка в product_stock_history.
- **admin**: каждый handler начинается с `requireAdminApi()`; вход валидировать.
- **webhooks/callbacks**: LiqPay — проверка подписи; Telegram webhook —
  secret header и ВСЕГДА 200 (Telegram ретраит не-2xx); ingest — bearer-ключ.
- **is_active шпалер** пишет только `wallpaper-import --publish`.
- Порядок deploy миграций с revoke — см. шапки самих миграций (пример: 036
  требует деплой кода ДО применения).

## Production-действия — только с явным GO владельца

Запрещено без GO: запись в живую БД сверх read-only проверок, применение
миграций, `git push`, вызов производственных синков с `--force`, изменение
vercel.json/cron, включение GitHub Actions-синков. Команда «запусти
Yugcontract Sync» и «вот выгрузка» — это явные GO на соответствующий
сценарий ниже, не на что-то большее.

## Операционные сценарии (выполняются агентом по команде владельца)

### Yugcontract Sync — по команде «запусти Yugcontract Sync»

1. Лаунчер: WSL/Linux — `bash scripts/wsl/yugcontract-sync.sh`; **Windows** —
   `powershell -ExecutionPolicy Bypass -File scripts/windows/yugcontract-sync.ps1`
   (в Git Bash нет flock — bash-лаунчер падает с exit 44 вместо старого
   молчаливого скипа). Оба поддерживают `--force` (против 48h-гейта).
   Таймаут запуска 15–30 мин. НЕ запускать
   `node scripts/yugcontract-import-run.ts --run` напрямую — только лаунчер.
2. Exit 0 → хвост сегодняшнего `logs/yugcontract-sync-ГГГГММДД.log` +
   `node scripts/catalog-health-check.ts` (read-only). Exit ≠ 0 → хвост
   лога; упавший батч — предложить `--resume <RUN_ID>`.
3. Отчёт: exit code, inserted/updated/skipped/errors (все три фазы —
   товары/цены, контент, изображения), длительность, RUN_ID, health RESULT.
   Упавшая images-фаза лечится `scripts/yugcontract-content-images.ts --run --resume`.

### Синк шпалер 1С (ежедневный Excel)

Триггеры: владелец прислал `.xls`-отчёт («Звіт з інвентаризації товару»),
сказал «вот выгрузка» / «обработай остатки». Свежесть следит cron
`wallpaper-freshness` (15:00 UTC, Telegram-алерт, если выгрузка старше 26ч).

1. Конвертер: `PYTHONPATH=<папка-xlrd> python scripts/1c-export/xls-report-to-ingest-csv.py <отчет.xls> data/`
   → `data/<дата>-wallpapers.csv` + `data/category-map-<дата>.json`.
   **Windows**: `python3` в Git Bash — Store-заглушка, использовать `python`
   или `py` (Python 3.14.7 установлен 2026-09-16). xlrd глобально не ставится:
   `python -m pip install --target /tmp/xlrdlib xlrd`, затем `PYTHONPATH=/tmp/xlrdlib`.
2. Ingest: `curl -X POST https://towary-dla-domu.com/api/ingest/1c-wallpaper
   -H "Authorization: Bearer $(cat data/WALLPAPER_INGEST_KEY.txt)"
   -H "X-Export-Date: ГГГГММДД" --data-binary @data/<дата>-wallpapers.csv`.
   202 `{accepted, rejected, errors}`; rejected>0 — не сбой канала, доложи цифры.
   Ключ строго server-side, в чат не печатать.
3. Импорт: `node scripts/wallpaper-import.ts --plan --category-map data/category-map-<дата>.json`
   (dry-run, показать сводку) → `--run`. Идемпотентен, diff-aware;
   «исчез из выгрузки» = списание в 0; is_active синком НЕ пишется.
4. Видимость: `node scripts/wallpaper-import.ts --publish` — ЕДИНСТВЕННЫЙ
   писатель is_active (с фото → активен). После синка при новых позициях/фото.
5. Фото/характеристики (опционально): `scripts/wallpaper-photos.ts --run
   --sources slav --items data/wallpaper-items-<дата>.json` (+`--specs`).
   ПРАВИЛО 2026-09-11: не-slav источники для артикулов без латиницы ЗАПРЕЩЕНЫ
   без проверенного `--url-map` (авто-матч по цифрам давал чужие товары).
6. Проверка: `node scripts/catalog-health-check.ts`. Отчёт: accepted/rejected,
   план (new/updated/missing), publish-счётчики, health RESULT.

## graphify

Граф знаний кода: `graphify-out/` (в git, обновляется коммитами
`chore(graphify)`).

- Вопросы по кодбейсу — сначала `graphify query "<вопрос>"`;
  `graphify path "<A>" "<B>"` — связи; `graphify explain "<concept>"` —
  концепт. Это возвращает скоупед-сабграф вместо grep по всему репо.
- Грязные `graphify-out/` файлы после hooks/обновлений — норма и не повод
  скипать graphify. `GRAPH_REPORT.md` — только для широкого ревью архитектуры.
- После изменений кода — `graphify update .` (AST-only, без API-стоимости).
- MCP-сервер: `C:\Users\Admin\.local\bin\graphify-mcp.exe` (нужен
  `uv tool install "graphifyy[mcp,sql]"` — без `[mcp]` сервер падает на
  импорте). CLI работает независимо от MCP.
