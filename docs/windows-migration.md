# Переезд с WSL на Windows — статус и памятка

Дата: 2026-09-15. Причина: нагрузка WSL на компьютер владельца.

## Что уже сделано

1. **Клон на Windows:** `C:\projects\my-shop` (HEAD = `ab750d8`), origin → GitHub.
   Конфиг Windows-git: `core.longpaths=true`, `core.autocrlf=false`.
2. **Секреты перенесены:** `.env.local` и `data/` (включая
   `WALLPAPER_INGEST_KEY.txt`, сиды SEO-текстов) скопированы из WSL.
3. **`.wslconfig`** (`C:\Users\Admin\.wslconfig`): WSL ограничен 8 ГБ ОЗУ /
   6 потоков / swap 4 ГБ + `autoMemoryReclaim=gradual` + sparse VHD.
   Вступает в силу после `wsl --shutdown` (владелец выполняет сам, когда
   удобен перерыв — текущий сеанс агента живёт в WSL).
4. **`.gitattributes`**: LF везде, бинарники исключены — чекауты Windows и
   Linux байт-в-байт, пины тестов без CRLF-шума.
5. Зависимости Windows-клона: `npm install` (Native Windows npm 12, Node 24).
6. **Скилы/MCP/плагины перенесены** (2026-09-15):
   - `C:\Users\Admin\.agents\skills` — 16 скилов;
   - `C:\Users\Admin\.zcode\cli\config.json` — MCP-серверы
     `playwright`, `supabase`, `github` + плагин `supabase`;
   - кеши плагинов и маркетплейсы (25 МБ) — без повторной загрузки;
   - `v2\credentials.json` — учётка (если приложение спросит логин —
     повторный вход, не поломка).

## Что осталось (по мере надобности)

0. **graphify** — единственное, что ставится заново (uv на Windows
   отсутствует): `winget install astral-sh.uv`, затем
   `uv tool install graphifyy`. Сам граф (`graphify-out/`) в git не хранится
   — регенерируется из репо первой командой `graphify update .`. Проектная
   обвязка (`.zcode/config.json` + hook) уже в репо.
1. **Прогон тестов на Windows** — `npm test` в `C:\projects\my-shop`
   (выполнено 2026-09-15: 2351/2351/0 fail).
2. **Playwright на Windows** — проще, чем в WSL: `npx playwright install
   chromium` в рабочей папке; костыли `/tmp/debs` + `LD_LIBRARY_PATH`
   больше не нужны.
3. **ZCode на Windows** — установить и продолжить сеансы из
   `C:\projects\my-shop` (после этого WSL-сеанс гасится).
4. **Таймеры Югконтракта:** рабочий синк — GitHub Actions (каждые 6ч).
   Локальные WSL systemd-таймеры (`yugcontract-sync/health`) при уходе с
   WSL отключить: `systemctl disable --now yugcontract-sync.timer
   yugcontract-health.timer`. Если нужен локальный дубль — готов
   `scripts/windows/install-yugcontract-task.ps1` (Планировщик задач).
5. **Гигиена при закрытии WSL** (не раньше, чем Windows-сеанс обживётся):
   - убедиться, что в `C:\projects\my-shop` нет незапушенных коммитов;
   - `wsl --shutdown`; WSL-копию проекта не удалять сразу — держать как
     бэкап 2–4 недели.

## Правила после переезда

- Работаем ТОЛЬКО из одного чекаута (Windows) — параллельные правки в двух
  копиях = конфликты (см. инцидент 2026-09-15 с параллельным сеансом).
- `npm run restart` вызывает bash-скрипт (`scripts/dev-restart.sh`) — на
  Windows запускать dev через `npm run dev` напрямую.
- Python-конвертер 1С (xlrd-паттерн из AGENTS.md) работает на виндовом
  Python так же: распакованное колесо + `PYTHONPATH`.
