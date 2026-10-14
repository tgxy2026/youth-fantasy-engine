@echo off
rem ============================================================
rem  Youth Fantasy Engine - Portable Launcher (Windows)
rem  青春幻想引擎 · 便携版启动脚本
rem
rem  NOTE: This file is written in ASCII on purpose.
rem  cmd.exe parses .bat as the OEM codepage (GBK on zh-CN Windows),
rem  so UTF-8 Chinese text here would appear garbled.
rem  Chinese instructions live in the sibling file 使用说明-安装前必读.txt.
rem
rem  Behaviour (2026-10-14): plain "node + script" launch.
rem  The single-file .exe packaging (Node SEA) was dropped on 2026-10-14
rem  (maintenance cost outweighed the benefit). The only runtime is a
rem  Node.js installed on this machine.
rem
rem  %* passes extra args through (e.g. --no-open / --port 8765)
rem ============================================================
setlocal
title Youth Fantasy Engine - Portable
cd /d "%~dp0"

echo.
echo ==================================================
echo   Youth Fantasy Engine - Portable
echo ==================================================
echo.

rem ---- locate Node.js ----
where node >nul 2>nul
if errorlevel 1 goto :noruntime

rem ---- locate server script ----
set "SRV=%~dp0scripts\portable-server.mjs"
if not exist "%SRV%" set "SRV=%~dp0portable-server.mjs"
if not exist "%SRV%" goto :noscript

if not exist "%~dp0dist\index.html" goto :nodist

echo [runtime] system Node.js
echo.
echo Starting local server...
echo Data will be saved into the "data" folder next to this script.
echo.
node "%SRV%" --root "%~dp0." %*
goto :done

:noruntime
echo [ERROR] Node.js not found.
echo.
echo   This portable build runs on Node.js ^(free, about 30 MB^).
echo   Download: https://nodejs.org/zh-cn/download   ^(pick the LTS version^)
echo   China mirror: https://npmmirror.com/mirrors/node/
echo.
echo   Install it, then run this script again.
echo   Already installed? Re-open Explorer / terminal so the new PATH takes effect.
echo.
pause
exit /b 1

:noscript
echo [ERROR] portable-server.mjs not found.
echo   Make sure this folder is complete
echo   ^(should contain dist\ and scripts\portable-server.mjs^).
echo.
pause
exit /b 1

:nodist
echo [ERROR] dist\index.html not found.
echo   Make sure the whole portable folder was extracted from the zip.
echo.
pause
exit /b 1

:done
echo.
echo Server stopped. Your data is in the "data" folder next to this script.
pause
