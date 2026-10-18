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
REM    build.cmd ship     OFFICIAL RELEASE build: fat LTO + 1 codegen unit,
REM                       NSIS installer + updater artifacts (needs signing key;
REM                       see docs/distribution.md), separate target-ship dir
REM ============================================================

REM -- Toolchain check ----------------------------------------
where node >nul 2>nul || (
    echo [ERROR] node not found. Install Node.js 22 LTS and add it to PATH
    exit /b 1
)
REM Vite 8 requires Node 20.19+ / 22.12+. On older Node, vite crashes with a
REM cryptic SyntaxError and npm may still exit 0, so the build would continue
REM and embed a STALE frontend into the exe. Fail fast with a clear message.
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
set "NODE_VER=%NODE_VER:v=%"
for /f "tokens=1,2 delims=." %%a in ("%NODE_VER%") do (
    set "NODE_MAJOR=%%a"
    set "NODE_MINOR=%%b"
)
set "NODE_OK=0"
if %NODE_MAJOR% GTR 22 set "NODE_OK=1"
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% GEQ 12 set "NODE_OK=1"
if %NODE_MAJOR% EQU 20 if %NODE_MINOR% GEQ 19 set "NODE_OK=1"
if %NODE_OK% NEQ 1 (
    echo [ERROR] Node.js v%NODE_VER% is too old. Vite 8 requires Node 20.19+ or 22.12+.
    echo         Install Node.js 22 LTS from https://nodejs.org then re-run build.cmd.
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

REM "ship" = official release. Everyday builds keep the fast profile in Cargo.toml.
set "SHIP="
if /I "%~1"=="ship" set "SHIP=1"
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
if not exist "dist\index.html" (
    echo [ERROR] frontend build produced no dist\index.html. The vite step may
    echo         have crashed silently. Check the npm output above.
    exit /b 1
)

REM -- [1.5/5] native dylib plugins (M1+): standalone cargo projects ----
REM Each plugins/<id>/native builds with panic=unwind + static CRT (isolated
REM from the host's panic=abort). Output dll is copied next to the plugin
REM manifest; the host scanner dlopens it per backend.entry on next start.
for /d %%D in (plugins\*) do (
  if exist "%%D\native\Cargo.toml" (
    echo [1.5/5] Building native plugin: %%~nxD ...
    pushd "%%D\native"
    cargo build --release
    if errorlevel 1 exit /b 1
    popd
    copy /Y "%%D\native\target\release\*.dll" "%%D\" >nul
    if errorlevel 1 exit /b 1
  )
)
REM Backfill backend.integrity: a rebuilt dll has new bytes, and a stale hash
REM makes the loader reject the plugin at startup (silent failure).
node tools\update-plugin-integrity.mjs
if %ERRORLEVEL% NEQ 0 exit /b 1

REM -- [1.8/5] deploy external plugins BEFORE bundle --------
REM tauri.conf.json bundle.resources maps release\plugins into the installer;
REM the directory must exist and be current before the bundler runs.
set "STEP=[1.8/5]"
echo %STEP% Deploying external plugins to release\plugins\...
node tools\deploy-portable-plugins.mjs || exit /b 1

REM -- [2/5] main program: Tauri release build (built-in plugins)
REM A running LiteLauncher.exe locks target\release\LiteLauncher.exe (os error 5),
REM so fail early with a clear message instead of after a full compile.
tasklist /FI "IMAGENAME eq LiteLauncher.exe" 2>nul | find /I "LiteLauncher.exe" >nul && (
    echo [ERROR] LiteLauncher.exe is currently running and locks the build output.
    echo         Please close it first, then re-run build.cmd.
    exit /b 1
)
set "STEP=[2/5]"
REM Everyday build: fast profile from Cargo.toml, cargo reuses src-tauri\target.
set "BIN=src-tauri\target\release"
if defined SHIP (
    echo %STEP% Building OFFICIAL RELEASE - fat LTO, 1 codegen unit, separate cache...
    echo         Slow on purpose. For everyday builds just run: build.cmd
    set "CARGO_PROFILE_RELEASE_LTO=true"
    set "CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1"
    REM Separate target dir: this profile differs from Cargo.toml, so cargo would
    REM recompile every dependency here and leave a cache it cannot reuse later.
    set "CARGO_TARGET_DIR=%CD%\src-tauri\target-ship"
    set "BIN=src-tauri\target-ship\release"
) else (
    echo %STEP% Building main program - Tauri release, built-in plugins included...
)
if defined SHIP (
    echo %STEP% Building NSIS installer + updater artifacts...
    call npx tauri build --bundles nsis
) else (
    call npx tauri build --no-bundle
)
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] main program build failed
    exit /b 1
)

REM -- [3/5] copy binary to release/ ---------------------------
set "STEP=[3/5]"
if not exist "release" mkdir "release"
echo %STEP% Copying main exe to release\LiteLauncher.exe...
if not exist "%BIN%\LiteLauncher.exe" (
    echo [ERROR] "%BIN%\LiteLauncher.exe" missing - the Tauri step produced no binary
    exit /b 1
)
copy /Y "%BIN%\LiteLauncher.exe" "release\LiteLauncher.exe" >nul || exit /b 1

REM -- [4/5] done -----------------------------------------------
set "STEP=[4/5]"
echo %STEP% Done. Distributable output:
echo   release\LiteLauncher.exe        main program (built-in: todo/apps/ai)
echo   release\plugins\                external plugins (llp/native/none, ship together; notes = native)
echo   src-tauri\target\release\bundle\  NSIS/MSI installer (when building without --no-bundle)
exit /b 0

:check
echo [check] Rust workspace check (all plugin crates)...
cargo check --workspace
if %ERRORLEVEL% NEQ 0 exit /b 1
echo [check] Frontend type check...
call npx tsc --noEmit
if %ERRORLEVEL% NEQ 0 exit /b 1
echo [check] Plugin backend unit tests (plugins/*/be)...
for /d %%D in (plugins\*) do (
  if exist "%%D\be\Cargo.toml" (
    pushd "%%D\be"
    cargo test
    if errorlevel 1 exit /b 1
    popd
  )
)
echo [check] Native plugin crates (independent cargo projects)...
for /d %%D in (plugins\*) do (
  if exist "%%D\native\Cargo.toml" (
    pushd "%%D\native"
    cargo check
    if errorlevel 1 exit /b 1
    popd
  )
)
echo [check] gate passed
exit /b 0
