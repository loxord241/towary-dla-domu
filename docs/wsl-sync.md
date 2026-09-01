# Yugcontract Sync в WSL2 (systemd timer)

Ежедневная синхронизация цен/остатков Yugcontract напрямую из WSL2 на домашнем
ПК (разрешённый поставщиком IP). Запускается **существующий** импортер без
изменений: `node scripts/yugcontract-import-run.ts --run`. Credentials — только
из `.env.local` в корне репо; в юнитах, скриптах и логах секретов нет.

Расписание: systemd будит лаунчер **ежедневно в 18:00**, но реальный интервал
между успешными sync — **48 часов**: лаунчер пропускает срабатывание, если с
прошлого успешного запуска прошло меньше 47 ч (stamp-файл
`logs/.yugcontract-last-success`; упавшие запуски не штампуются и ретраятся
на следующий день). Дневной триггер нужен как якорь времени 18:00 и для
Persistent-догона после простоя — чистый «каждые 48 ч» systemd-календарь
выразить не может.

Механизм: **systemd timer** (systemd в этом WSL уже включён: `/etc/wsl.conf`
→ `[boot] systemd=true`). Timer выбран вместо cron, потому что умеет
`Persistent=true` — догонять пропущенный запуск один раз после простоя.

## Файлы

| Файл | Назначение |
|---|---|
| `scripts/wsl/yugcontract-sync.sh` | лаунчер: root/node/.env.local проверки, лог `logs/yugcontract-sync-ГГГГММДД.log` с ротацией 14 дней, scrub секретов, `flock` против параллельных запусков, корректный exit code |
| `scripts/wsl/install-yugcontract-timer.sh` | идемпотентная установка systemd unit'ов (`yugcontract-sync.service` + `yugcontract-sync.timer`) и включение таймера |

## 1. Установить таймер

```bash
bash scripts/wsl/install-yugcontract-timer.sh
```

(нужен sudo для записи в `/etc/systemd/system`; запускать из WSL).

## 2. Проверить статус

```bash
systemctl list-timers yugcontract-sync.timer
systemctl status yugcontract-sync.timer
journalctl -u yugcontract-sync -n 50        # вывод последнего запуска
```

## 3. Запустить вручную (вне расписания)

```bash
systemctl start yugcontract-sync.service
```

или напрямую лаунчер: `bash scripts/wsl/yugcontract-sync.sh`.

## 4. Включить / выключить

```bash
sudo systemctl disable --now yugcontract-sync.timer   # выключить
sudo systemctl enable  --now yugcontract-sync.timer   # включить обратно
```

## 5. Удалить

```bash
sudo systemctl disable --now yugcontract-sync.timer
sudo rm /etc/systemd/system/yugcontract-sync.service /etc/systemd/system/yugcontract-sync.timer
sudo systemctl daemon-reload
```

## 6. Где логи

* `logs/yugcontract-sync-ГГГГММДД.log` в корне репо (хранятся ~14 дней);
* `journalctl -u yugcontract-sync` (journal).
Последняя строка успешного запуска: `done OK`. При упавшем батче — exit code ≠ 0
и подсказка с `--resume <RUN_ID>`.

## Поведение после выключения/включения Windows

| Сценарий | Что происходит |
|---|---|
| WSL работает в плановое время | запуск в 18:00, если с прошлого успешного sync ≥ 48 ч (иначе — пропуск) |
| ПК был выключен в плановое время, потом Windows загружен и WSL запущен | **один** догоняющий запуск сразу при старте WSL (`Persistent=true`), если интервал ≥ 48 ч; двойных запусков нет |
| WSL не стартовал весь день | запуска в этот день не будет — ограничение WSL2: при старте Windows дистрибутив сам не поднимается |
| Windows выключается во время sync | импортер чекпойнтится; следующий запуск — свежий идемпотентный `--run`, либо вручную `--run --resume <RUN_ID>` |

**Опциональный Windows-side trigger** (только если нужна гарантия запуска в дни,
когда вы не открываете WSL): задача Task Scheduler «At log on» с командой
`wsl.exe -d Ubuntu -e /bin/true` — просто поднимает WSL, дальше `Persistent=true`
сам догоняет. Ничего сверх этого не требуется и не устанавливалось.

## 7. Запуск через coding-agent

По команде владельца «запусти Yugcontract Sync» агент выполняет:

1. Запуск (только через лаунчер — он держит `flock` и пишет лог; прямой
   `node scripts/yugcontract-import-run.ts --run` агентом НЕ используется):

   ```bash
   bash scripts/wsl/yugcontract-sync.sh
   ```

   Bash-таймаут команды — увеличенный, 15–30 минут (типичный полный sync —
   несколько минут; ориентир: 2026-08-31 прошёл за ~197 с + планирование).
   Если лаунчер ответил «skipping (< 48h interval)», а владелец явно хочет
   запустить сейчас — повторить с `--force` (обходит только 48h-гейт;
   flock/логи/остальные защиты действуют).

2. Проверить exit code:

   | Код | Трактовка агентом |
   |-----|-------------------|
   | 0 | OK (включая «пропущен: уже выполняется другой» — flock сработал) |
   | ≠ 0 | см. хвост лога; importer подскажет `--run --resume <RUN_ID>` |

3. Итог взять из актуального дневного лога (`logs/yugcontract-sync-ГГГГММДД.log`,
   дата — локальная, сегодняшняя): `tail -n 30 <лог>`. Там же counters по
   батчам, суммарные inserted/updated/skipped/errors и длительность.

4. При exit 0 — пост-проверка (read-only SELECT-ы, ничего не пишет):

   ```bash
   node scripts/catalog-health-check.ts
   ```

5. Краткий отчёт владельцу: exit code, inserted / updated / skipped / errors,
   длительность, health-check RESULT (PASS/WARN/FAIL + проблемные пункты),
   RUN_ID из лога.

Примечания:

* Отсутствие новых изображений ошибкой НЕ считается: price/stock sync
  изображения не импортирует (изображения — отдельная контентная кампания).
* Деактивации/удаления товаров sync не выполняет по дизайну — такой пункт в
  отчёт не включается.
* GitHub Actions / Yugcontract 403 — не чинить, вне сценария.

## Коды выхода лаунчера

| Код | Значение |
|-----|----------|
| 0 | sync OK (или пропущен — уже выполняется другой) |
| 1 | импортер вернул ошибку (см. лог) |
| 2 / 3 | node не найден / слишком старый (нужен v24+) |
| 4 / 5 | нет `.env.local` / нет скрипта импортера |
| 6 / 10 | не удалось перейти в корень / создать logs |
