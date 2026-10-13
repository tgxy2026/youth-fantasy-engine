@echo off
rem ============================================================
rem  Youth Fantasy Engine - Portable Launcher (Windows)
rem  青春幻想引擎 · 便携版启动脚本
rem
rem  NOTE: This file is written in ASCII on purpose.
rem  cmd.exe parses .bat as the OEM codepage (GBK on zh-CN Windows),
rem  so UTF-8 Chinese text here would appear garbled.
rem  Chinese instructions live in the sibling file 使用说明.txt.
rem
rem  Behaviour (3.0.3+):
rem    1) Prefer the BUNDLED RUNTIME - a single self-contained .exe
rem       that already contains the JS runtime. Works on any Windows
rem       machine with NOTHING installed. This is the normal path.
rem    2) Fall back to a system-wide Node.js, if the bundled runtime
rem       is missing or was blocked/removed by security software.
rem    3) Otherwise print a clear message.
rem
rem  The bundled runtime is located by WILDCARD rather than by name,
rem  because its filename contains Chinese characters (and this file
rem  must stay pure ASCII). Assumption: this folder holds exactly one
rem  .exe - the runtime itself.
rem ============================================================
setlocal
title Youth Fantasy Engine - Portable
cd /d "%~dp0"

echo.
echo ==================================================
echo   Youth Fantasy Engine - Portable
echo ==================================================
echo.

rem ---- 1) bundled runtime (preferred: zero dependency) ----
set "RT="
for %%F in ("%~dp0*.exe") do if not defined RT set "RT=%%~fF"

if defined RT (
  echo [runtime] bundled ^(no Node.js required^)
  echo.
  rem %* 透传附加参数（如 --no-open / --port 8765），便于脚本化与排查
  "%RT%" --root "%~dp0." %*
  goto :done
)

rem ---- 2) fall back to a system-wide Node.js ----
set "SRV=%~dp0scripts\portable-server.mjs"
if not exist "%SRV%" set "SRV=%~dp0portable-server.mjs"

where node >nul 2>nul
if errorlevel 1 goto :noruntime
if not exist "%SRV%" goto :noscript
if not exist "%~dp0dist\index.html" goto :nodist

echo [runtime] system Node.js ^(fallback^)
echo.
node "%SRV%" --root "%~dp0."
goto :done

:noruntime
echo [ERROR] No runtime found.
echo.
echo   This folder is missing the bundled runtime (the .exe file),
echo   and Node.js is not installed on this machine either.
echo.
echo   Fix: extract the WHOLE portable folder from the zip again,
echo        and keep the .exe inside this folder.
echo.
echo   If your antivirus removed the .exe, allow-list this folder
echo   and extract again.
echo.
pause
exit /b 1

:noscript
echo [ERROR] scripts\portable-server.mjs not found.
echo   Extract the WHOLE portable folder from the zip again.
echo.
pause
exit /b 1

:nodist
echo [ERROR] dist\index.html not found.
echo   Extract the WHOLE portable folder from the zip again.
echo.
pause
exit /b 1

:done
echo.
echo Server stopped. Your data is in the "data" folder next to this script.
pause
