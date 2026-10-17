@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  Build the notes native plugin (M2 pilot).
REM  Output: ..\notes.dll  (next to plugins/notes/manifest.json)
REM  ASCII-only + CRLF: see repo .gitattributes note for *.cmd
REM ============================================================

cargo build --release
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] cargo build failed
    exit /b 1
)

if not exist "target\release\notes.dll" (
    echo [ERROR] target\release\notes.dll missing - unexpected build layout
    exit /b 1
)

copy /Y "target\release\notes.dll" "..\notes.dll" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] failed to copy notes.dll into the plugin directory
    exit /b 1
)

echo OK: ..\notes.dll updated. Restart LiteLauncher to load it.
exit /b 0
