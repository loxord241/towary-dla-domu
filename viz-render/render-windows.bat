@echo off
setlocal enabledelayedexpansion
title Визуализатор шпалер — батч-рендер (RTX 3090)
chcp 65001 >nul

rem ===== Что делает: рендерит все обои из manifest.json во всех комнатах
rem ===== (vitalnia/bedroom/kids) на твоём GPU и ЗАЛИВАЕТ в хранилище сайта.
rem ===== Идемпотентно: повторный запуск добирает только недостающее.

set "WORK=%~dp0"
set "BLENDER_DIR=%LOCALAPPDATA%\BlenderRenderer"
set "BLENDER_EXE=%BLENDER_DIR%\blender-4.2.23-windows-x64\blender.exe"
set "BLENDER_ZIP=%BLENDER_DIR%\blender.zip"
set "SUPA=https://wtkuctkkeobucbrfvjxx.supabase.co"
set "KEYFILE=%WORK%.service-key"
set "TEXDIR=%WORK%tex"
set "OUTDIR=%WORK%out"
set "RESW=1920"
set "RESH=1080"
set "SAMPLES=128"
set "QUALITY=88"

if not exist "%KEYFILE%" (
  echo [ОШИБКА] Нет файла .service-key рядом с батником.
  pause
  exit /b 1
)
set /p SERVICE_KEY=<"%KEYFILE%"

rem ===== 1. Blender (ставится один раз) =====
if not exist "%BLENDER_EXE%" (
  echo [1/4] Скачиваю Blender ^(один раз, ~350 МБ^)...
  if not exist "%BLENDER_DIR%" mkdir "%BLENDER_DIR%"
  curl -L -o "%BLENDER_ZIP%" "https://download.blender.org/release/Blender4.2/blender-4.2.23-windows-x64.zip" || goto :fatal
  echo Распаковываю...
  tar -xf "%BLENDER_ZIP%" -C "%BLENDER_DIR%" || goto :fatal
  del "%BLENDER_ZIP%"
)
echo [1/4] Blender: %BLENDER_EXE%

rem ===== 2. Сцена: render из манифеста =====
echo [2/4] Рендер ^(GPU OptiX^)... это долго: ~330 кадров x 3 комнаты.
if not exist "%TEXDIR%" mkdir "%TEXDIR%"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
set /a DONE=0
for %%R in (vitalnia bedroom kids) do (
  if not exist "%OUTDIR%\%%R" mkdir "%OUTDIR%\%%R"
rem Рендерим по манифесту через powershell-генератор списка
powershell -NoProfile -Command "$m = Get-Content '%WORK%manifest.json' -Raw | ConvertFrom-Json; foreach ($p in $m.textures.PSObject.Properties) { Write-Output ($p.Name + '|' + $p.Value) }" > "%WORK%_list.tsv"
for /f "usebackq tokens=1,2 delims=|" %%A in ("%WORK%_list.tsv") do (
  set "SLUG=%%A"
  set "TURL=%%B"
  for %%R in (vitalnia bedroom kids) do (
    if not exist "%OUTDIR%\%%R\%%A.webp" (
      if not exist "%TEXDIR%\%%A.png" (
        echo   текстура %%A...
        curl -sS -m 120 -o "%TEXDIR%\%%A.png" "%%B"
      )
      echo   рендер %%R / %%A ...
      "%BLENDER_EXE%" --background --factory-startup -P "%WORK%build_scene.py" -- --room %%R --texture "%TEXDIR%\%%A.png" --roll-w 53 --width %RESW% --height %RESH% --samples %SAMPLES% --format webp --quality %QUALITY% --device optix --out "%OUTDIR%\%%R\%%A.webp"
      if errorlevel 1 (
        echo   ... OptiX не взял, пробую CUDA
        "%BLENDER_EXE%" --background --factory-startup -P "%WORK%build_scene.py" -- --room %%R --texture "%TEXDIR%\%%A.png" --roll-w 53 --width %RESW% --height %RESH% --samples %SAMPLES% --format webp --quality %QUALITY% --device cuda --out "%OUTDIR%\%%R\%%A.webp"
      )
      if exist "%OUTDIR%\%%R\%%A.webp" set /a DONE+=1
    )
  )
)
echo [3/4] Отрендерено новых кадров: %DONE%

rem ===== 3. Заливка в хранилище сайта =====
echo [3/4] Заливаю в хранилище...
for /f "usebackq delims=" %%F in (`dir /s /b "%OUTDIR%\*.webp"`) do (
  set "FULL=%%F"
  set "REL=!FULL:%OUTDIR%\=!"
  set "REL=!REL:\=/!"
  curl -sS -X POST -H "Authorization: Bearer %SERVICE_KEY%" -H "Content-Type: image/webp" -H "x-upsert: true" --data-binary "@%%F" "https://wtkuctkkeobucbrfvjxx.supabase.co/storage/v1/object/vizualizator/!REL!" -o nul
)
echo [4/4] ГОТОВО. Отрендерено новых кадров: %DONE%
echo Скажи оркестратору, что батч закончился — он проверит и включит на сайте.
pause
exit /b 0

:fatal
echo [ФАТАЛЬНО] Скачивание/распаковка Blender не удались. Проверь интернет и запусти ещё раз.
pause
exit /b 1
