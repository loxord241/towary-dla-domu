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
