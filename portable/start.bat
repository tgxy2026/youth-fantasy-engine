@echo off
rem ============================================================
rem  Youth Fantasy Engine - Portable Launcher (Windows)
rem  青春幻想引擎 · 便携版启动脚本
rem
rem  NOTE: This file is written in ASCII on purpose.
rem  cmd.exe parses .bat as the OEM codepage (GBK on zh-CN Windows),
rem  so UTF-8 Chinese text here would appear garbled.
rem  Chinese instructions live in the sibling file 使用说明.txt.
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
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo.
  echo   This portable build needs Node.js installed ^(free, ~30 MB^).
  echo   Download: https://nodejs.org/zh-cn/download
  echo   Install it, then run this script again.
  echo.
  pause
  exit /b 1
)

rem ---- locate server script ----
set "SRV=%~dp0scripts\portable-server.mjs"
if not exist "%SRV%" set "SRV=%~dp0portable-server.mjs"
if not exist "%SRV%" (
  echo [ERROR] portable-server.mjs not found.
  echo   Make sure this folder is complete
  echo   ^(should contain dist\ and scripts\portable-server.mjs^).
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0dist\index.html" (
  echo [ERROR] dist\index.html not found.
  echo   Build the frontend first:  npm run build:portable
  echo.
  pause
  exit /b 1
)

echo Starting local server...
echo Data will be saved into the "data" folder next to this script.
echo.

node "%SRV%" --root "%~dp0."

echo.
echo Server stopped. Your data is in the "data" folder.
pause
