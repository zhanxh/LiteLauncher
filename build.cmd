@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  LiteLauncher Windows build script (Linux/macOS: build.sh)
REM
REM  IMPORTANT: keep this file ASCII-only with CRLF line endings.
REM  cmd.exe cannot reliably parse .cmd files that contain UTF-8 /
REM  GBK multi-byte text (with or without "chcp 65001"); the parser
REM  loses its file offset and executes random line fragments.
REM  Chinese usage notes live in build.sh and docs/ instead.
REM
REM  Usage:
REM    build.cmd          full build: frontend + main exe + portable plugin deploy
REM    build.cmd check    quick gate: cargo check + frontend type check (no binary)
REM ============================================================

REM -- Toolchain check ----------------------------------------
where node >nul 2>nul || (
    echo [ERROR] node not found. Install Node.js 18+ and add it to PATH
    exit /b 1
)
where cargo >nul 2>nul || (
    if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
        set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
    ) else (
        echo [ERROR] cargo not found. Install Rust from rustup.rs and add it to PATH
        exit /b 1
    )
)

if "%~1"=="check" goto :check

REM -- npm install (first run / after dependency changes) ------
REM node_modules\ may exist but be incomplete (interrupted install, cloud-sync
REM directory that skipped deep paths, copy from another machine). Probe a
REM package that the frontend actually imports before trusting the directory.
if not exist "node_modules\@kobalte\core\package.json" (
    echo [DEPS] dependencies missing or incomplete, running npm install...
    call npm install || exit /b 1
)

set "STEP=[1/5]"
echo %STEP% Building frontend (plugin registry gen + type check + bundle)...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] frontend build failed
    echo         If the log shows "failed to resolve import", dependencies are
    echo         incomplete. Fix: rmdir /s /q node_modules ^&^& npm install
    exit /b 1
)

REM -- [2/5] main program: Tauri release build (built-in plugins)
REM A running LiteLauncher.exe locks target\release\LiteLauncher.exe (os error 5),
REM so fail early with a clear message instead of after a full compile.
tasklist /FI "IMAGENAME eq LiteLauncher.exe" 2>nul | find /I "LiteLauncher.exe" >nul && (
    echo [ERROR] LiteLauncher.exe is currently running and locks the build output.
    echo         Please close it first, then re-run build.cmd.
    exit /b 1
)
set "STEP=[2/5]"
echo %STEP% Building main program (Tauri release, built-in plugins included)...
call npx tauri build --no-bundle
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] main program build failed
    exit /b 1
)

REM -- [3/5] copy binary to release/ ---------------------------
set "STEP=[3/5]"
if not exist "release" mkdir "release"
echo %STEP% Copying main exe to release\LiteLauncher.exe...
copy /Y "src-tauri\target\release\LiteLauncher.exe" "release\LiteLauncher.exe" >nul || exit /b 1

REM -- [4/5] deploy external plugins (backend.kind=llp) --------
set "STEP=[4/5]"
echo %STEP% Deploying external plugins to release\plugins\...
node tools\deploy-portable-plugins.mjs || exit /b 1

REM -- [5/5] done -----------------------------------------------
set "STEP=[5/5]"
echo %STEP% Done. Distributable output:
echo   release\LiteLauncher.exe        main program (built-in todo/apps/notes/ai plugins)
echo   release\plugins\                external plugins (portable, ship together)
exit /b 0

:check
echo [check] Rust workspace check (all plugin crates)...
cargo check --workspace
if %ERRORLEVEL% NEQ 0 exit /b 1
echo [check] Frontend type check...
call npx tsc --noEmit
if %ERRORLEVEL% NEQ 0 exit /b 1
echo [check] gate passed
exit /b 0
