# 01 构建、自检与排障

## 1. 环境

| 依赖 | 要求 | 说明 |
| :--- | :--- | :--- |
| Node.js | ≥ 20.19（Vite 8 硬要求），推荐 22 LTS / 24 | 版本过低时 Vite 会抛 `SyntaxError`，`npm` 仍可能退出 0 |
| Rust | stable（1.99+） | 仓库使用 Edition 2024 |
| Windows 工具链 | MSVC（VS2022 C++ 工具）或完整 GNU 工具链 | 二选一，GNU 不需要管理员权限 |
| Linux 依赖 | webkit2gtk-4.1、gtk-3、libsoup-3、libgbm-dev、libpipewire-0.3-dev、libspa-0.2-dev、libclang-dev | `build.sh` 会预检并打印同一条安装命令 |

判据：报 `Unable to find libclang` 或 `was not found in the pkg-config search path`，
都是**缺 `-dev` 包**，不要去改 `build.rs`。

## 2. 四档验证

| 档位 | 命令 | 覆盖 | 用时 |
| :--- | :--- | :--- | :--- |
| 类型 + 编译 | `npm run check` | `cargo check --workspace` + `tsc --noEmit` | 秒级~分钟级 |
| 全量自检 | `build.cmd check` | 上面 + `plugins/*/be` 单测 + `plugins/*/native` 编译 | 更久，提交前推荐 |
| 日常构建 | `build.cmd` | 前端 → native 插件 → 部署 → 主程序 → 拷到 `release/` | thin LTO |
| 正式发布 | `build.cmd ship` | 同上，fat LTO + 1 CGU + NSIS 安装包 | 首次在新目录全量重编（约 8~9G） |

`build.cmd` 的执行顺序（排障时按这个定位）：

1. `npm run build`（内含 `npm run gen` 生成插件注册表）→ 产出 `dist/`；
2. 遍历 `plugins/*/native/Cargo.toml` 逐个 `cargo build --release`，dll 拷回 `plugins/<id>/`；
3. `node tools/update-plugin-integrity.mjs` 回填 hash；
4. `node tools/deploy-portable-plugins.mjs` 部署到 `release/plugins/`；
5. `npx tauri build`（ship 档加 `--bundles nsis`）→ 拷 exe 到 `release/`。

> 不要用 `cargo build --release` 代替：缺少 `custom-protocol` 特性，产物会连
> `localhost:1420`，表现为白屏或"拒绝连接"。

## 3. 常见故障

| 现象 | 原因 | 处理 |
| :--- | :--- | :--- |
| `failed to resolve import ...` | `node_modules` 不完整 | `rmdir /s /q node_modules` 后 `npm install` |
| 构建"成功"但界面是旧的 | Node 太旧导致 Vite 静默失败 | `node -v` 确认 ≥ 20.19；`build.cmd` 已 fail fast |
| `os error 5` 写 exe 失败 | LiteLauncher 正在运行，占用产物 | 关掉托盘实例（含所有窗口）后重试 |
| 启动后窗口白屏 | dev URL 未就绪 / 用了 cargo 直接构建 | 用 `npm run tauri dev` 或 `build.cmd` |
| 插件加载不上、无报错 | `backend.integrity` 与 dll 不匹配 | `node tools/update-plugin-integrity.mjs` 后重启 |
| 指向错误的插件版本 | 宿主扫到旧 dll | 清理 `plugins/<id>/*.dll` 后重新构建 |
| `/find` 不可用 | Windows 未装 Everything / Linux 无 plocate 索引 | `sudo updatedb`；`/find where` 看后端状态 |

## 4. 日志

- 位置：exe 同目录 `lifecycle.log`；超过 2 MB 启动时轮转为 `lifecycle.log.1`（只留一份）。
- 级别：默认 `info`；`LL_LOG=debug` 记录窗口尺寸、焦点、IPC 与前端 console；`LL_LOG=off` 全关。
- 排障顺序：先看日志末尾的 error，再对照 `CHANGELOG.md` 最近改动，最后才怀疑环境。

## 5. 缓存与磁盘

- `src-tauri/target/`（日常档）与 `src-tauri/target-ship/`（发布档）**故意分开**：
  两套 profile 不同，混用会导致每次切档全量重编。
- `plugins/*/native/target/` 是各插件独立工程的缓存，已 gitignore。
- 空间告警时先删 `src-tauri/target/debug`、`plugins/*/native/target/debug`，
  不要动 `target-ship`（除非确定不再发版）。
