@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem Wallpaper visualizer - final render batch for the owner's
rem Windows machine with NVIDIA GPU (OptiX).
rem
rem Usage:
rem   render_windows.bat [manifest.txt]
rem
rem Manifest lines (pipe-separated, one render per line):
rem   <texture path or URL>|<out png>|<width>|<height>|<samples>
rem
rem On first run a default manifest is created and the textures
rem are downloaded to %USERPROFILE%\wallpaper-viz\textures.
rem
rem NOTE: texture wc-x32938/10200936_4.webp has download-arrow
rem icons baked into the source file (supplier watermark); a
rem cleaned copy is made on the WSL side (see report) - replace
rem the downloaded webp with the cleaned png for production use.
rem
rem Device: build_scene.py tries OptiX first, then CUDA, then CPU
rem (--device optix). If OptiX init fails, Cycles may fall back to
rem CPU silently; verify GPU use with nvidia-smi during a run.
rem ============================================================

set "SCRIPT_DIR=%~dp0"
set "MANIFEST=%~1"
if "%MANIFEST%"=="" set "MANIFEST=%SCRIPT_DIR%render_manifest.txt"
set "TEXDIR=%USERPROFILE%\wallpaper-viz\textures"
if not exist "%TEXDIR%" mkdir "%TEXDIR%"

rem ---- locate blender.exe ----
set "BLENDER="
where blender >nul 2>nul && set "BLENDER=blender"
if not defined BLENDER for %%D in (
    "%ProgramFiles%\Blender Foundation\Blender 4.2\blender.exe"
    "%ProgramFiles%\Blender Foundation\Blender 4.5\blender.exe"
    "%LOCALAPPDATA%\Programs\Blender Foundation\Blender 4.2\blender.exe"
) do if exist %%D set "BLENDER=%%~D"

if not defined BLENDER (
    echo Blender not found, installing 4.2 LTS to %LOCALAPPDATA%\Blender ...
    set "BLENDER=%LOCALAPPDATA%\Blender\blender.exe"
    if not exist "%LOCALAPPDATA%\Blender\blender.exe" (
        powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://download.blender.org/release/Blender4.2/blender-4.2.23-windows-x64.zip' -OutFile \"$env:TEMP\blender4223.zip\""
        powershell -NoProfile -Command "Expand-Archive -Force \"$env:TEMP\blender4223.zip\" \"$env:TEMP\blender4223\""
        robocopy "%TEMP%\blender4223\blender-4.2.23-windows-x64" "%LOCALAPPDATA%\Blender" /E /NFL /NDL /NJH /NJS >nul
        del "%TEMP%\blender4223.zip" >nul 2>nul
        rmdir /s /q "%TEMP%\blender4223" >nul 2>nul
    )
)

echo Using blender: %BLENDER%
"%BLENDER%" --version | findstr /C:"Blender 4"
if errorlevel 1 (
    echo ERROR: blender did not run.
    exit /b 1
)

rem ---- default manifest + texture downloads on first run ----
if not exist "%MANIFEST%" (
    echo Creating default manifest: %MANIFEST%
    > "%MANIFEST%" (
        echo %TEXDIR%\slav-11474.jpg^|%SCRIPT_DIR%previews\final-1.png^|1920^|1080^|256
        echo %TEXDIR%\slav-7252.jpg^|%SCRIPT_DIR%previews\final-2.png^|1920^|1080^|256
        echo %TEXDIR%\wc-x32938-10200936_4.webp^|%SCRIPT_DIR%previews\final-3.png^|1920^|1080^|256
    )
)

if not exist "%TEXDIR%\slav-11474.jpg"     powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://oboi-slav-oboi.com/assets/products/11474/0566178001757511900.jpg' -OutFile '%TEXDIR%\slav-11474.jpg'"
if not exist "%TEXDIR%\slav-7252.jpg"      powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://oboi-slav-oboi.com/assets/products/7252/0890431001681992330.jpg' -OutFile '%TEXDIR%\slav-7252.jpg'"
if not exist "%TEXDIR%\wc-x32938-10200936_4.webp" powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://wtkuctkkeobucbrfvjxx.supabase.co/storage/v1/object/public/product_images/wc-x32938/10200936_4.webp' -OutFile '%TEXDIR%\wc-x32938-10200936_4.webp'"

rem ---- render every manifest line ----
set /a N=0
for /f "usebackq tokens=1-5 delims=| eol=#" %%A in ("%MANIFEST%") do (
    set /a N+=1
    echo.
    echo [!N!] rendering %%A -^> %%B
    if not exist "%%~dpB" mkdir "%%~dpB"
    "%BLENDER%" -b --factory-startup -P "%SCRIPT_DIR%build_scene.py" -- ^
        --texture "%%A" --out "%%B" --width %%C --height %%D --samples %%E ^
        --key-power 200 --fill-power 50 --exposure -0.15 --device optix
    if errorlevel 1 echo RENDER FAILED for %%A
)

echo.
echo Done. Outputs are next to the script in previews\.
endlocal
