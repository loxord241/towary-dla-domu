# Yugcontract Sync в WSL2 (systemd timer)

Ежедневная синхронизация Yugcontract напрямую из WSL2 на домашнем
ПК (разрешённый поставщиком IP). Три фазы, все — **существующие** импортеры
без изменений:

1. товары/цены/остатки: `node scripts/yugcontract-import-run.ts --run`;
2. supplier content (описания + характеристики) — только если фаза 1
   успешно завершилась: `node scripts/yugcontract-content-fetch.ts --stage`
   (один вызов get-content-goods → staging `yc_content_goods`), затем
   `node scripts/yugcontract-content-apply.ts --run` (diff-aware батчи →
   ONLY `products.description` + `products.specifications`, checkpoint в
   `yc_content_batches`, пустые HTML-шеллы поставщика исключены);
3. изображения (hotlink) — только если фаза 2 успешно завершилась:
   `node scripts/yugcontract-content-images.ts --run` (diff-aware батчи из
   staging `yc_content_goods.pictures` → ONLY `product_images` как внешние
   URL; ручные Storage-строки не трогаются; удаления сознательно не
   реализованы; checkpoint в `yc_content_batches`, phase='images').

Credentials — только
из `.env.local` в корне репо; в юнитах, скриптах и логах секретов нет.

Расписание: systemd будит лаунчер **ежедневно в 18:00**, но реальный интервал
между успешными sync — **48 часов**: лаунчер пропускает срабатывание, если с
прошлого успешного запуска прошло меньше 47 ч (stamp-файл
`logs/.yugcontract-last-success`; упавшие запуски не штампуются и ретраятся
на следующий день). Штамп означает «последний успешный РАБОЧИЙ запуск»: если
products-фаза отсеялась DB-гейтом импортера («skipping (< 48h interval)»,
exit 0 без работы), штамп **не обновляется** — иначе реальный интервал
растягивался бы до ~4 суток (47 ч штампа + 47 ч DB-гейта). То же правило
действует в Windows-лаунчере. Дневной триггер нужен как якорь времени 18:00 и
для Persistent-догона после простоя — чистый «каждые 48 ч» systemd-календарь
выразить не может.

Механизм: **systemd timer** (systemd в этом WSL уже включён: `/etc/wsl.conf`
→ `[boot] systemd=true`). Timer выбран вместо cron, потому что умеет
`Persistent=true` — догонять пропущенный запуск один раз после простоя.

## Файлы

| Файл | Назначение |
|---|---|
| `scripts/wsl/yugcontract-sync.sh` | лаунчер: root/node/.env.local проверки, лог `logs/yugcontract-sync-ГГГГММДД.log` с ротацией 14 дней, scrub секретов, `flock` против параллельных запусков, **жёсткий таймаут 30 мин на каждую фазу** (`timeout`, переопределяется `YUGCONTRACT_SYNC_TIMEOUT_SECS`; зависшая фаза убивается, в лог пишется явное сообщение, exit 124), корректный exit code; после успешной фазы 1 запускает content-фазу (fetch --stage → apply --run), после неё — images-фазу (`content-images --run`); штамп успеха ставится только когда products-импорт реально выполнялся |
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
   несколько минут; ориентир: 2026-09-03 (с images-фазой) прошёл за ~10 мин,
   более ранние без неё — ~200 с). Лаунчер сам держит жёсткий таймаут 30 мин
   на каждую фазу и при зависании завершается с exit 124 и явным сообщением
   в логе — держите bash-таймаут не меньше этого предела (или временно
   уменьшите `YUGCONTRACT_SYNC_TIMEOUT_SECS`).
   Если лаунчер ответил «skipping (< 48h interval)», а владелец явно хочет
   запустить сейчас — повторить с `--force` (обходит только 48h-гейт;
   flock/логи/остальные защиты действуют). Гейт-отсев (это сообщение, exit 0)
   штамп последнего успеха не трогает.

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

* Content-фаза (описания/характеристики) сама не пишет в `product_images` —
  fetch лишь обновляет метаданные staging (`yc_content_goods.pictures`);
  apply пишет только description/specifications. Изображения импортирует
  отдельная images-фаза (`yugcontract-content-images.ts --run`), которая
  идёт третьей и берёт URL из того же staging.
* Если images-фаза упала при успешных фазах 1–2 — sync возвращает ≠ 0 и
  штамп 48h-гейта НЕ ставится: следующий дневной триггер повторит весь sync
  (фаза 1 diff-aware и отработает как дешёвый no-op), images догонятся
  тогда же. Упавший images-run также можно продолжить вручную:
  `node scripts/yugcontract-content-images.ts --run --resume <RUN_ID>`.
* Деактивации/удаления товаров sync не выполняет по дизайну — такой пункт в
  отчёт не включается.
* GitHub Actions / Yugcontract 403 — не чинить, вне сценария.

## Известные состояния после инцидента 2026-09-05

Пока поставка от Yugcontract не восстановлена, действуют особенности ниже.
Они НЕ регрессии — ожидаемые последствия инцидента; пункт (в) уточняет
примечание про images-фазу выше для пост-инцидентного периода.

1. **health-check ожидаемо FAIL по OOS-перекосу.** `catalog-health-check.ts`
   будет падать по перекосу наличия (доля out-of-stock), пока поставка не
   восстановится и склад не пополнится. Это не регрессия кода; после
   восстановления поставки результат должен вернуться к PASS/WARN сам.

2. **ПЕРЕД первым пост-восстановительным `--run` обязателен `--plan`.**
   Сначала прогнать dry-run (`node scripts/yugcontract-import-run.ts
   --plan`) и проверить критерий «категорії: створити 0». Selection на
   старых id даёт тихий no-op (новая поставка = новые id → ничего не
   выбирается), а при частичном ремапе категорий `--run` без плана создаёт
   дубли категорий. Если план показывает «створити > 0» — не запускать
   `--run`, разбираться с ремапом отдельно.

3. **Упавшая images-фаза НЕ подхватывается повторным sync.** В отличие от
   штатного режима, после инцидента повторный запуск sync не догоняет
   упавшую images-фазу — сразу продолжать вручную:
   `node scripts/yugcontract-content-images.ts --run --resume <RUN_ID>`
   (RUN_ID взять из хвоста дневного лога).

4. **stamp-файл `logs/.yugcontract-last-success` может расходиться с
   DB-гейтом.** windows-sync (запуск из Windows-планировщика) перезаписывает
   mtime штампа, поэтому файл может показывать свежий успех при фактически
   не зашедшем sync. Доверять DB-гейту (реальному состоянию данных в БД),
   а не mtime штампа.

## Коды выхода лаунчера

| Код | Значение |
|-----|----------|
| 0 | sync OK (или пропущен: уже выполняется другой — flock; либо products-фаза отсеяна 48h DB-гейтом импортера — в этом случае штамп не обновляется) |
| 1 | импортер вернул ошибку (см. лог) |
| 2 / 3 | node не найден / слишком старый (нужен v24+) |
| 4 / 5 | нет `.env.local` / нет скрипта импортера |
| 6 / 10 | не удалось перейти в корень / создать logs |
| 7 | в системе нет coreutils `timeout` |
| 124 | фаза превысила жёсткий таймаут (по умолчанию 30 мин, `YUGCONTRACT_SYNC_TIMEOUT_SECS`) и была убита; в логе явное сообщение, воркфлоу/systemd увидят failure |
