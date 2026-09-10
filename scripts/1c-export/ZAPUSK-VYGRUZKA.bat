@echo off
rem ===== REAL path to the 1C base (edit here if base moves) =====
set BASE="D:\Baza 2023"
rem ===== virtual drive letter (no spaces allowed by 1C 7.7) =====
set XDRIVE=X:

if not exist %XDRIVE%\1cv7.md subst %XDRIVE% %BASE%
if exist %XDRIVE%\1cv7.md (echo Virtual drive OK: %XDRIVE% -^> %BASE%) else (echo WARNING: %XDRIVE% mapping failed - base folder wrong?)
cd /d "%~dp0"
echo === Wallpaper export: starting (32-bit cscript) ===
C:\Windows\SysWOW64\cscript.exe //Nologo "%~dp0slav-oboi-export.vbs"
echo.
echo === Finished. Log: slav-oboi-export.log (same folder) ===
pause
