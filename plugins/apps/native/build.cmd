@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  Build the apps native plugin (M5: builtin fully detached).
REM  Output: ..\apps.dll  (next to plugins/apps/manifest.json)
REM  ASCII-only + CRLF: see repo .gitattributes note for *.cmd
REM ============================================================

cargo build --release
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] cargo build failed
    exit /b 1
)

if not exist "target\release\apps.dll" (
    echo [ERROR] target\release\apps.dll missing - unexpected build layout
    exit /b 1
)

copy /Y "target\release\apps.dll" "..\apps.dll" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] failed to copy apps.dll into the plugin directory
    exit /b 1
)

echo OK: ..\apps.dll updated. Restart LiteLauncher to load it.
exit /b 0
