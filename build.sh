#!/usr/bin/env bash
# Linux/macOS 构建脚本（对应 Windows 的 build.cmd）
# 用法：
#   ./build.sh         完整构建：前端 + 主程序 + 便携插件部署
#   ./build.sh check   快速门禁：cargo check + 前端类型检查（不产二进制）
#   ./build.sh ship    正式发布包：fat LTO + 单 codegen unit，产物落在独立的
#                      target-ship 目录，编完日常缓存仍可复用
set -euo pipefail
cd "$(dirname "$0")"

# ── 工具链检查 ──────────────────────────────────────────────
command -v node >/dev/null || { echo "[错误] 未找到 node，请安装 Node.js 22 LTS"; exit 1; }
command -v cargo >/dev/null || { echo "[错误] 未找到 cargo，请安装 Rust（rustup.rs）"; exit 1; }

# Vite 8 要求 Node 20.19+ / 22.12+；旧版 Node 会让 vite 报晦涩的 SyntaxError，
# 且 npm 仍可能返回 0，导致带着过期前端继续构建。这里快速失败。
node_ver=$(node -v | sed 's/^v//')
node_major=${node_ver%%.*}
node_minor=$(echo "$node_ver" | cut -d. -f2)
node_ok=0
if (( node_major > 22 )) \
   || { (( node_major == 22 )) && (( node_minor >= 12 )); } \
   || { (( node_major == 20 )) && (( node_minor >= 19 )); }; then
    node_ok=1
fi
if (( node_ok == 0 )); then
    echo "[错误] Node.js v${node_ver} 过旧。Vite 8 要求 Node 20.19+ 或 22.12+，请升级到 Node 22 LTS。"
    exit 1
fi

# ── Linux 系统依赖预检 ──────────────────────────────────────
# 只查编译期真正要用的东西：pkg-config 探针 + bindgen 要的 libclang.so。
# 全部是 -dev 包，运行期一个都不需要（运行期要的是 .so，见 README 的自检命令）。
# libxdo-dev 不在列：global-hotkey 走 dlopen，编译期探不到它。
# librsvg2-dev 不在列：本项目的依赖图实际没探它，装上只是浪费。
check_linux_deps() {
    local missing=()
    command -v pkg-config >/dev/null || missing+=(pkg-config)

    # bindgen 找的是 libclang.so（不带版本号那个 dev 符号链接）
    local clang_ok=0
    if ls /usr/lib/llvm-*/lib/libclang.so >/dev/null 2>&1; then
        clang_ok=1
    elif command -v ldconfig >/dev/null && ldconfig -p | grep -q 'libclang\.so'; then
        clang_ok=1
    fi
    (( clang_ok )) || missing+=(libclang-dev)

    local probes=(
        gtk+-3.0                 # gtk 绑定（services.rs 里压小窗尺寸下限）
        webkit2gtk-4.1           # Tauri webview
        javascriptcoregtk-4.1    # Tauri webview
        libsoup-3.0              # webkit 的 HTTP 栈
        gbm                      # mesa 的 buffer 管理，链接期要 -lgbm
        libpipewire-0.3          # xcap → pipewire-sys
        libspa-0.2               # xcap → libspa-sys
    )
    local m
    for m in "${probes[@]}"; do
        pkg-config --exists "$m" 2>/dev/null || missing+=("$m")
    done

    if (( ${#missing[@]} )); then
        echo "[错误] 缺少 Linux 编译依赖：${missing[*]}"
        echo "       修复（Debian/Ubuntu，装完直接重跑本脚本）："
        echo "         sudo apt-get install -y build-essential pkg-config libclang-dev \\"
        echo "           libgtk-3-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \\"
        echo "           libsoup-3.0-dev libgbm-dev libpipewire-0.3-dev libspa-0.2-dev"
        echo "       判据：报 \"Unable to find libclang\" 或 \"was not found in the pkg-config"
        echo "       search path\" 都是缺 -dev，不是版本/代码问题，别去改 build.rs。"
        exit 1
    fi
}
if [[ "$(uname -s)" == "Linux" ]]; then
    check_linux_deps
fi

# ship = 正式发布档。日常构建直接用 Cargo.toml 里的快速档。
SHIP=0
if [[ "${1:-}" == "ship" ]]; then SHIP=1; fi   # 不用 && 形式：set -e 下的返回值容易误判

if [[ "${1:-}" == "check" ]]; then
    echo "[check] Rust 工作区编译检查（含全部插件 crate）..."
    cargo check --workspace
    echo "[check] 前端类型检查..."
    npx tsc --noEmit
    echo "[check] 插件后端单测（plugins/*/be）..."
    for be_dir in plugins/*/be; do
        [[ -f "$be_dir/Cargo.toml" ]] || continue
        (cd "$be_dir" && cargo test)
    done
    echo "[check] native 插件 crate（独立 cargo 工程）..."
    shopt -s nullglob
    for native_dir in plugins/*/native; do
        [[ -f "$native_dir/Cargo.toml" ]] || continue
        (cd "$native_dir" && cargo check)
    done
    echo "[check] 门禁通过"
    exit 0
fi

# ── 依赖安装（首次/依赖变更后自动补齐）─────────────────────
# node_modules/ 目录可能存在但内容残缺（安装中断、网盘同步跳过了深层路径、
# 从其他机器拷贝不完整）。在信任目录前先探测前端实际会 import 的包。
# 探测清单 = 前端真实 import 的关键包（src/core/updater.ts 用到 plugin-updater/plugin-process），
# 只探一个包探不出"部分安装"——残缺可能正好落在别处。
node_modules_incomplete=0
for dep_pkg in @kobalte/core @tauri-apps/plugin-updater @tauri-apps/plugin-process; do
    [[ -f "node_modules/$dep_pkg/package.json" ]] || node_modules_incomplete=1
done
if (( node_modules_incomplete )); then
    echo "[依赖] 依赖缺失或不完整，执行 npm install..."
    npm install
fi

echo "[1/4] 构建前端（插件注册表生成 + 打包）..."
if ! npm run build; then
    echo "[错误] 前端构建失败。若日志中出现 \"failed to resolve import\"，多为依赖不完整所致。"
    echo "        修复：rm -rf node_modules && npm install"
    exit 1
fi
if [[ ! -f dist/index.html ]]; then
    echo "[错误] 前端构建未产出 dist/index.html，vite 步骤可能静默崩溃，请检查上方 npm 输出。"
    exit 1
fi

# ── [1.5/4] native 动态库插件（M1+）──────────────────────────
# 每个 plugins/<id>/native 是独立 cargo 工程（panic=unwind + 静态 CRT，与宿主
# panic=abort 隔离）。编出的 dll/so 复制到 plugins/<id>/ 根——宿主按 manifest
# 的 backend.entry 从那里 dlopen。产物缺失的插件会被扫描器跳过并记日志。
shopt -s nullglob
for native_dir in plugins/*/native; do
    [[ -f "$native_dir/Cargo.toml" ]] || continue
    echo "[1.5/4] 构建 native 插件（${native_dir#plugins/}）..."
    (cd "$native_dir" && cargo build --release)
    for lib in "$native_dir"/target/release/*.dll "$native_dir"/target/release/*.so; do
        [[ -e "$lib" ]] && cp -f "$lib" "$native_dir/.."
    done
done

# 回填 backend.integrity：重编后的 dll/so 字节已变，旧 hash 会让宿主拒载（静默失效）。
# 脚本与宿主用同一条选库规则（按平台后缀），Windows 回填 .dll、Linux 回填 .so。
node tools/update-plugin-integrity.mjs

BIN="src-tauri/target/release/LiteLauncher"
if (( SHIP )); then
    echo "[2/4] 构建正式发布包（fat LTO + 单 codegen unit，独立缓存目录）..."
    echo "        这一步很慢是刻意的。日常构建请直接跑 ./build.sh"
    # 档位与 Cargo.toml 不同，cargo 会把全部依赖在这个目录重编一遍；
    # 单独开一个 target-ship 是为了不弄脏日常那份增量缓存
    export CARGO_PROFILE_RELEASE_LTO=true
    export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
    export CARGO_TARGET_DIR="$PWD/src-tauri/target-ship"
    BIN="src-tauri/target-ship/release/LiteLauncher"
else
    echo "[2/4] 构建主程序（Tauri release，含内置插件）..."
fi
# tauri.conf.json 的 bundle.resources 会把 release/plugins 打进安装包，
# 所以必须先部署插件再执行 bundler。
echo "[1.8/4] 部署外部插件到 release/plugins/..."
node tools/deploy-portable-plugins.mjs

# ship = 正式发布包：顺手打 .deb，让目标机用 apt 补运行库。
# 日常构建保持 --no-bundle（快，且不碰网络）。默认目标只有 deb：rpm 要装 rpmbuild，
# appimage 要从 GitHub 下 linuxdeploy，两者都不适合放进构建默认路径。
# 发布流水线用 SHIP_BUNDLES=deb,appimage 显式加上 appimage —— Tauri 在 Linux 上的
# 自动更新只认 AppImage（deb 不是 updater 载体），缺它就没有 linux-x86_64 更新条目。
if (( SHIP )) && [[ "$(uname -s)" == "Linux" ]]; then
    # tray-icon 让 tauri-cli 在打包期用 pkg-config 探 appindicator 的 libdir（写 deb
    # Depends、往 AppImage 里塞 .so）。这不是编译依赖，上面那份预检查不到它；缺了也不
    # 报「缺依赖」，而是 release 全编完（CI 上 7 分钟）才 panic
    # "Can't detect any appindicator library"。在这里先亮出来。
    if ! pkg-config --exists ayatana-appindicator3-0.1 2>/dev/null; then
        echo "[错误] 打包需要 libayatana-appindicator3-dev（pkg-config 模块 ayatana-appindicator3-0.1）"
        echo "       sudo apt-get install -y libayatana-appindicator3-dev"
        exit 1
    fi
    npx tauri build --bundles "${SHIP_BUNDLES:-deb}"
else
    npx tauri build --no-bundle
fi

[[ -f "$BIN" ]] || { echo "[错误] 未产出 $BIN，Tauri 步骤没有生成二进制"; exit 1; }
echo "[3/4] 拷贝主程序到 release/LiteLauncher..."
mkdir -p release
cp -f "$BIN" release/LiteLauncher

echo "[4/4] 完成。可分发内容："
echo "  release/LiteLauncher        主程序（内置：todo/apps/ai；notes 为 native 插件）"
echo "  release/plugins/            外部插件（便携部署，随程序分发）"

# deb 装的是整个应用目录：主程序 + bundle.resources 里的 release/plugins/（0.2.1 实测
# 149 个插件文件在包内），但 Depends 只列 Tauri 探到的那几个库。
if (( SHIP )) && [[ "$(uname -s)" == "Linux" ]]; then
    echo "  src-tauri/target-ship/release/bundle/deb/*.deb   安装包"
    if ! ls src-tauri/target-ship/release/bundle/deb/*.deb >/dev/null 2>&1; then
        echo "[警告] 上面这一步没找到 .deb，tauri 打包步骤可能静默失败，请检查上方输出"
    else
        echo "  发版前把 Depends 与产物 ldd 对一遍（见 README「Linux 上 ./build.sh ship 多打一个 .deb」）"
    fi
    if [[ ",${SHIP_BUNDLES:-deb}," == *",appimage,"* ]]; then
        echo "  src-tauri/target-ship/release/bundle/appimage/*.AppImage        便携包，也是 updater 载体（+ .sig）"
        # v2 的 createUpdaterArtifacts 签的就是 AppImage 本体，不产 v1 时代的 .AppImage.tar.gz
        if ! ls src-tauri/target-ship/release/bundle/appimage/*.AppImage.sig >/dev/null 2>&1; then
            echo "[警告] 没找到 *.AppImage.sig，updater 产物可能没生成（检查 createUpdaterArtifacts 与签名私钥）"
        fi
    fi
fi
