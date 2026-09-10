@echo off
cd /d "%~dp0"
if not exist X:\1cv7.md subst X: "D:\Baza 2023"
echo === DIAGNOSTIKA starting ===
C:\Windows\SysWOW64\cscript.exe //Nologo "%~dp0DIAGNOSTIKA.vbs"
echo.
echo === Gotovo. Fail diag.txt - v etoy zhe papke. Peredayte ego magazinu ===
pause
