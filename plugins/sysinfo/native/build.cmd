@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  Build the sysinfo native plugin (M6: migrated from llp/Python).
REM  Output: ..\sysinfo.dll  (next to plugins/sysinfo/manifest.json)
REM  ASCII-only + CRLF: see repo .gitattributes note for *.cmd
REM ============================================================

cargo build --release
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] cargo build failed
    exit /b 1
)

if not exist "target\release\sysinfo.dll" (
    echo [ERROR] target\release\sysinfo.dll missing - unexpected build layout
    exit /b 1
)

copy /Y "target\release\sysinfo.dll" "..\sysinfo.dll" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] failed to copy sysinfo.dll into the plugin directory
    exit /b 1
)

echo OK: ..\sysinfo.dll updated. Restart LiteLauncher to load it.
exit /b 0
