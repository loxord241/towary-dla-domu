<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Yugcontract Sync (запуск агентом)

По команде пользователя «запусти Yugcontract Sync»:

1. `bash scripts/wsl/yugcontract-sync.sh` с увеличенным bash-таймаутом (15–30 мин). Не запускать `node scripts/yugcontract-import-run.ts --run` напрямую — только лаунчер (flock + лог). Если ответ «skipping (< 48h interval)», а владелец явно хочет запустить сейчас — повторить с `--force`.
2. Exit 0 → прочитать хвост сегодняшнего `logs/yugcontract-sync-ГГГГММДД.log` и выполнить `node scripts/catalog-health-check.ts` (read-only). Exit ≠ 0 → хвост лога; при упавшем батче предложить `node scripts/yugcontract-import-run.ts --run --resume <RUN_ID>`.
3. Отчитаться: exit code, inserted/updated/skipped/errors (включая images-фазу), длительность, health-check RESULT, RUN_ID. Sync состоит из трёх фаз — товары/цены, контент, изображения (hotlink в `product_images`); упавшая images-фаза лечится `node scripts/yugcontract-content-images.ts --run --resume <RUN_ID>`. Подробности: docs/wsl-sync.md, раздел 7.

## Синк шпалер 1С (ежедневный Excel, запуск агентом)

Шпалеры — отдельный домен (sku `wc-*`, витрина `/oboi`), остатки приходят из 1С 7.7 владельца. VBS-автоматизация отменена (решение владельца 2026-09-10): владелец КАЖДЫЙ ДЕНЬ вручную выгружает Excel и передаёт файл агенту. Триггеры: владелец прислал `.xls`-отчёт («Звіт з інвентаризації товару») или говорит «вот выгрузка» / «обработай остатки». Свежесть следит cron `wallpaper-freshness` (15:00 UTC, Telegram-алерт владельцу, если max(export_date) старше 26 ч).

1. Конвертер: `PYTHONPATH=<папка-xlrd> python3 scripts/1c-export/xls-report-to-ingest-csv.py <отчет.xls> data/` → `data/<дата>-wallpapers.csv` (code;name;article;unit;price_retail;qty) + `data/category-map-<дата>.json`. xlrd НЕ установлен в системе — скачать wheel с PyPI, распаковать в папку и подать в PYTHONPATH (паттерн /tmp/xlrdlib; так же ставятся openpyxl и прочие).
2. Ingest: `curl -sS -X POST https://towary-dla-domu.com/api/ingest/1c-wallpaper -H "Authorization: Bearer $(cat data/WALLPAPER_INGEST_KEY.txt)" -H "X-Export-Date: ГГГГММДД" --data-binary @data/<дата>-wallpapers.csv`. Ответ 202 `{accepted, rejected, errors}`; rejected > 0 — не сбой канала, но доложи владельцу цифры. Ключ строго server-side (data/ gitignored), в чат не печатать.
3. Импортер: `node scripts/wallpaper-import.ts --plan --category-map data/category-map-<дата>.json` (dry-run, показать владельцу сводку) → `node scripts/wallpaper-import.ts --run --category-map ...`. Идемпотентен и diff-aware; «позиция исчезла из выгрузки» = списание в 0 (is_active НЕ пишется синком никогда). Новые позиции создаются скрытыми — витринность решает шаг 4.
4. Видимость: `node scripts/wallpaper-import.ts --publish` — ЕДИНСТВЕННЫЙ писатель is_active: с фото → активен, без фото → скрыт. Запускать после синка, если появились новые позиции или новые фото.
5. Фото/характеристики после синка (опционально, slav = поставщик): `node scripts/wallpaper-photos.ts --run --sources slav --items data/wallpaper-items-20260910.json`, характеристики — `--specs` с тем же --items. ПРАВИЛО 2026-09-11: не-slav источники для артикулов без латинских букв («5070») ЗАПРЕЩЕНЫ без проверенного `--url-map` — авто-матч по цифрам давал чужие товары (видеокарта RTX 5070 у шпалер). Если в выгрузке есть позиции, которых нет в items-JSON — сгенерируй его из колонок code;name;article свежего CSV.
6. Проверка: `node scripts/catalog-health-check.ts` (read-only). Отчитаться: accepted/rejected, план (new/updated/missing), publish-счётчики, health-check RESULT.

Инварианты и дизайн: docs/superpowers/specs/2026-09-10-wallpapers-import-design.md; детали каналов — в шапках скриптов.
