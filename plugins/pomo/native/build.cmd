@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  Build the pomo native plugin (M5: migrated from llp/Python).
REM  Output: ..\pomo.dll  (next to plugins/pomo/manifest.json)
REM  ASCII-only + CRLF: see repo .gitattributes note for *.cmd
REM ============================================================

cargo build --release
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] cargo build failed
    exit /b 1
)

if not exist "target\release\pomo.dll" (
    echo [ERROR] target\release\pomo.dll missing - unexpected build layout
    exit /b 1
)

copy /Y "target\release\pomo.dll" "..\pomo.dll" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] failed to copy pomo.dll into the plugin directory
    exit /b 1
)

echo OK: ..\pomo.dll updated. Restart LiteLauncher to load it.
exit /b 0