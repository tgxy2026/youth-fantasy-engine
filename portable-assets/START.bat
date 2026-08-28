@echo off
rem ============================================
rem  Novel Studio (Portable v1.2) Launcher
rem  Opens the app in Chrome / Edge (required
rem  for USB data-file read/write support).
rem ============================================
setlocal
set "HTML=%~dp0novel-studio.html"

rem -- Try Chrome (HKLM then HKCU App Paths) --
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>nul
if %errorlevel%==0 (
  start "" chrome.exe "--new-window" "%HTML%"
  exit /b 0
)
reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>nul
if %errorlevel%==0 (
  start "" chrome.exe "--new-window" "%HTML%"
  exit /b 0
)

rem -- Try Edge (usually preinstalled on Windows) --
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" >nul 2>nul
if %errorlevel%==0 (
  start "" msedge.exe "--new-window" "%HTML%"
  exit /b 0
)

rem -- Fallback: default browser --
start "" "%HTML%"
echo Note: Chrome or Edge is recommended for USB data-file support.
pause
