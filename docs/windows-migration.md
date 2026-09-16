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

0. ✅ **graphify** — выполнено 2026-09-16: `winget install astral-sh.uv` →
   `uv tool install "graphifyy[sql]"` (SQL-экстра — чтобы парсились
   `database/*.sql`), граф пересобран `graphify update .`,
   `.zcode/config.json` переписан на Windows-пути (`graphify-mcp.exe`).
   Уточнение: `graphify-out/` на самом деле хранится в git (113 файлов) —
   обновляется коммитами `chore(graphify)` после смены кода, а не
   регенерируется с нуля.
1. **Прогон тестов на Windows** — `npm test` в `C:\projects\my-shop`
   (выполнено 2026-09-15: 2351/2351/0 fail).
2. **Playwright на Windows** — проще, чем в WSL: `npx playwright install
   chromium` в рабочей папке; костыли `/tmp/debs` + `LD_LIBRARY_PATH`
   больше не нужны.
3. ✅ **ZCode на Windows** — работает, сеансы идут из `C:\projects\my-shop`
   (2026-09-16).
4. **Таймеры Югконтракта (уточнено 2026-09-16):** автоматика выключена
   СОЗНАТЕЛЬНО с инцидента 2026-09-05 — синк ходит по команде
   («запусти Yugcontract Sync») через лаунчеры с 48h-гейтом. GitHub
   Actions вооружён (расписание каждые 6ч), но GO-переменная
   `YUGCONTRACT_SYNC_ENABLED` ни разу не включалась — 0 успешных запусков
   (да и IP-allowlist Yugcontract домашний, раннеры Azure не прошли бы).
   WSL systemd-таймеры установлены, но disarmed. Если понадобится
   безлюдный запуск — `scripts/windows/install-yugcontract-task.ps1`
   (Планировщик задач, спросит пароль Windows).
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
