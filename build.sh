#!/usr/bin/env bash
# Linux/macOS 构建脚本（对应 Windows 的 build.cmd）
# 用法：
#   ./build.sh         完整构建：前端 + 主程序 + 便携插件部署
#   ./build.sh check   快速门禁：cargo check + 前端类型检查（不产二进制）
set -euo pipefail
cd "$(dirname "$0")"

# ── 工具链检查 ──────────────────────────────────────────────
command -v node >/dev/null || { echo "[错误] 未找到 node，请安装 Node.js 18+"; exit 1; }
command -v cargo >/dev/null || { echo "[错误] 未找到 cargo，请安装 Rust（rustup.rs）"; exit 1; }

if [[ "${1:-}" == "check" ]]; then
    echo "[check] Rust 工作区编译检查（含全部插件 crate）..."
    cargo check --workspace
    echo "[check] 前端类型检查..."
    npx tsc --noEmit
    echo "[check] 门禁通过"
    exit 0
fi

# ── 依赖安装（首次/依赖变更后自动补齐）─────────────────────
# node_modules/ 目录可能存在但内容残缺（安装中断、网盘同步跳过了深层路径、
# 从其他机器拷贝不完整）。在信任目录前先探测前端实际会 import 的包。
if [[ ! -f node_modules/@kobalte/core/package.json ]]; then
    echo "[依赖] 依赖缺失或不完整，执行 npm install..."
    npm install
fi

echo "[1/4] 构建前端（插件注册表生成 + 打包）..."
if ! npm run build; then
    echo "[错误] 前端构建失败。若日志中出现 \"failed to resolve import\"，多为依赖不完整所致。"
    echo "        修复：rm -rf node_modules && npm install"
    exit 1
fi

echo "[2/4] 构建主程序（Tauri release，含内置插件）..."
npx tauri build --no-bundle

echo "[3/4] 拷贝主程序到 release/LiteLauncher..."
mkdir -p release
cp -f src-tauri/target/release/LiteLauncher release/LiteLauncher

echo "[4/4] 部署外部插件到 release/plugins/..."
node tools/deploy-portable-plugins.mjs

echo "构建完成。可分发内容："
echo "  release/LiteLauncher        主程序（内置 todo/apps/notes/ai 插件）"
echo "  release/plugins/            外部插件（便携部署，随程序分发）"
