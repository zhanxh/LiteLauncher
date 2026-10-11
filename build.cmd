@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  LiteLauncher Windows 构建脚本（对应 Linux 的 build.sh）
REM  用法：
REM    build.cmd          完整构建：前端 + 主程序 + 便携插件部署
REM    build.cmd check    快速门禁：cargo check + 前端类型检查（不产二进制）
REM ============================================================

set "STEP=[1/5]"

REM ── 工具链检查 ──────────────────────────────────────────────
where node >nul 2>nul || (
    echo [错误] 未找到 node，请安装 Node.js 18+ 并加入 PATH
    exit /b 1
)
where cargo >nul 2>nul || (
    if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
        set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
    ) else (
        echo [错误] 未找到 cargo，请安装 Rust（rustup.rs）并加入 PATH
        exit /b 1
    )
)

if "%~1"=="check" goto :check

REM ── 依赖安装（首次/依赖变更后自动补齐）─────────────────────
if not exist "node_modules\" (
    echo [依赖] node_modules 缺失，执行 npm install...
    call npm install || exit /b 1
)

REM ── [1/5] 前端：插件注册表生成 + 类型检查 + 打包 ────────────
set "STEP=[2/5]"
echo %STEP% 构建前端（插件注册表生成 + 打包）...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 前端构建失败
    exit /b 1
)

REM ── [2/5] 主程序：Tauri release 构建（含全部内置插件 crate）──
set "STEP=[3/5]"
echo %STEP% 构建主程序（Tauri release，含内置插件）...
call npx tauri build --no-bundle
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 主程序构建失败
    exit /b 1
)

REM ── [3/5] 产物拷贝 ──────────────────────────────────────────
set "STEP=[4/5]"
if not exist "release" mkdir "release"
echo %STEP% 拷贝主程序到 release\LiteLauncher.exe...
copy /Y "src-tauri\target\release\LiteLauncher.exe" "release\LiteLauncher.exe" >nul || exit /b 1

REM ── [4/5] 便携插件部署（backend.kind=llp → release\plugins\）─
echo %STEP% 部署外部插件到 release\plugins\...
node tools\deploy-portable-plugins.mjs || exit /b 1

REM ── [5/5] 完成 ──────────────────────────────────────────────
set "STEP=[5/5]"
echo %STEP% 构建完成。可分发内容：
echo   release\LiteLauncher.exe        主程序（内置 todo/apps/notes/ai 插件）
echo   release\plugins\                外部插件（便携部署，随程序分发）
exit /b 0

:check
echo [check] Rust 工作区编译检查（含全部插件 crate）...
cargo check --workspace
if %ERRORLEVEL% NEQ 0 exit /b 1
echo [check] 前端类型检查...
call npx tsc --noEmit
if %ERRORLEVEL% NEQ 0 exit /b 1
echo [check] 门禁通过
exit /b 0
