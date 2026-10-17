@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  Build the ai native plugin (M5: builtin fully detached).
REM  Output: ..\ai.dll  (next to plugins/ai/manifest.json)
REM  ASCII-only + CRLF: see repo .gitattributes note for *.cmd
REM ============================================================

cargo build --release
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] cargo build failed
    exit /b 1
)

if not exist "target\release\ai.dll" (
    echo [ERROR] target\release\ai.dll missing - unexpected build layout
    exit /b 1
)

copy /Y "target\release\ai.dll" "..\ai.dll" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] failed to copy ai.dll into the plugin directory
    exit /b 1
)

echo OK: ..\ai.dll updated. Restart LiteLauncher to load it.
exit /b 0
