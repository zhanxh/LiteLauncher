#!/usr/bin/env bash
# Linux/macOS 构建脚本（对应 Windows 的 build.cmd）
set -euo pipefail
cd "$(dirname "$0")"

echo "[1/3] Building frontend assets..."
npm run build

echo "[2/3] Building Tauri release binary..."
npx tauri build --no-bundle

echo "[3/3] Copying to release/LiteLauncher..."
mkdir -p release
cp -f src-tauri/target/release/tauri-app release/LiteLauncher
echo "Build and release completed successfully!"
