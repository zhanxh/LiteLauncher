@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  Build the find native plugin (M6: migrated from llp/Python).
REM  Output: ..\find.dll  (next to plugins/find/manifest.json)
REM  ASCII-only + CRLF: see repo .gitattributes note for *.cmd
REM ============================================================

cargo build --release
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] cargo build failed
    exit /b 1
)

if not exist "target\release\find.dll" (
    echo [ERROR] target\release\find.dll missing - unexpected build layout
    exit /b 1
)

copy /Y "target\release\find.dll" "..\find.dll" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] failed to copy find.dll into the plugin directory
    exit /b 1
)

echo OK: ..\find.dll updated. Restart LiteLauncher to load it.
exit /b 0
