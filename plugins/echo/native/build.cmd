@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  Build the echo native plugin (LiteLauncher M1 sample).
REM
REM  Output: ..\echo.dll  (next to plugins/echo/manifest.json)
REM  ASCII-only + CRLF: see repo .gitattributes note for *.cmd
REM ============================================================

cargo build --release
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] cargo build failed
    exit /b 1
)

if not exist "target\release\echo.dll" (
    echo [ERROR] target\release\echo.dll missing - unexpected build layout
    exit /b 1
)

copy /Y "target\release\echo.dll" "..\echo.dll" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] failed to copy echo.dll into the plugin directory
    exit /b 1
)

echo OK: ..\echo.dll updated. Restart LiteLauncher to load it.
exit /b 0
