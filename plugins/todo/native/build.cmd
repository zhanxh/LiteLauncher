@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  Build the todo native plugin (M5: builtin fully detached).
REM  Output: ..\todo.dll  (next to plugins/todo/manifest.json)
REM  ASCII-only + CRLF: see repo .gitattributes note for *.cmd
REM ============================================================

cargo build --release
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] cargo build failed
    exit /b 1
)

if not exist "target\release\todo.dll" (
    echo [ERROR] target\release\todo.dll missing - unexpected build layout
    exit /b 1
)

copy /Y "target\release\todo.dll" "..\todo.dll" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] failed to copy todo.dll into the plugin directory
    exit /b 1
)

echo OK: ..\todo.dll updated. Restart LiteLauncher to load it.
exit /b 0
