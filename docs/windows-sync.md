# Yugcontract Sync на Windows ПК (Task Scheduler)

Автоматическая ежедневная синхронизация цен/остатков Yugcontract напрямую с
домашнего ПК (разрешённый IP) вместо GitHub Actions. Запускается **существующий**
импортер без изменений: `node scripts/yugcontract-import-run.ts --run`.
Credentials берутся только из `.env.local` в корне репозитория — в задаче
планировщика и в скриптах секретов нет.

## 0. Предусловия (один раз)

1. Клон репозитория на диске, например `C:\projects\my-shop`.
2. Node.js **24 LTS** установлен (`node --version` → `v24.x`).
3. `.env.local` лежит в корне репо и содержит production ключи
   (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `YUGCONTRACT_USER_KEY`, `YUGCONTRACT_SECRET`).
4. `.env.local` не коммитится (уже в `.gitignore`).

## 1. Установить задачу

Открыть PowerShell и выполнить:

```powershell
powershell -ExecutionPolicy Bypass -File C:\projects\my-shop\scripts\windows\install-yugcontract-task.ps1
```

Установщик спросит пароль Windows (нужен, чтобы задача работала и когда вы не
залогинены; пароль хранит только Windows, в файлах его нет) и зарегистрирует
задачу **YugcontractSync**: ежедневно в **10:00**, догоняет пропущенный запуск
после включения ПК, не запускается от батареи, параллельные запуски запрещены.

## 2. Проверить, что задача зарегистрирована

```powershell
Get-ScheduledTask -TaskName YugcontractSync | Format-List TaskName, State
Get-ScheduledTaskInfo -TaskName YugcontractSync
```

## 3. Запустить вручную

Через планировщик:

```powershell
Start-ScheduledTask -TaskName YugcontractSync
```

или напрямую лаунчер:

```powershell
powershell -ExecutionPolicy Bypass -File C:\projects\my-shop\scripts\windows\yugcontract-sync.ps1
```

## 4. Где смотреть лог

`<репозиторий>\logs\yugcontract-sync-ГГГГММДД.log` — по одному файлу на день,
хранятся ~14 дней (старее удаляются автоматически). Последняя строка успешного
запуска: `done OK`; при ошибке код возврата ненулевой, и в логе видна причина
(например, «БЛОКУЮЩІ КОНФЛІКТИ» или упавший батч).

## 5. Временно отключить / включить

```powershell
Disable-ScheduledTask -TaskName YugcontractSync
Enable-ScheduledTask  -TaskName YugcontractSync
```

## 6. Удалить задачу

```powershell
Unregister-ScheduledTask -TaskName YugcontractSync -Confirm:$false
```

## 7. Если sync упал на полпути

Импортер чекпойнтится в БД. Упавший run можно продолжить вручную:

```powershell
cd C:\projects\my-shop
node scripts\yugcontract-import-run.ts --run --resume <RUN_ID из лога>
```

Либо ничего не делать — следующий ежедневный запуск выполнит свежий
идемпотентный `--run` и сам приведёт данные к актуальному состоянию.

## Коды выхода лаунчера

| Код | Значение |
|-----|----------|
| 0 | sync прошёл успешно |
| 1 | импортер вернул ошибку (см. лог) |
| 2 | Node.js не найден |
| 3 | Node.js слишком старый (нужен v24+) |
| 4 | нет `.env.local` в корне репо |
| 5 | нет скрипта импортера |
| 10 | не удалось создать папку логов |
