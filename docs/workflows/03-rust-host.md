# 03 宿主与 Rust 工作区

## 1. 分层

```
tauri-app (src-tauri)          窗口、托盘、热键、命令注册、设置
   ├── ll-host                 插件注册表 / 权限门控 / IPC 通道 / native 加载 / 每插件独立 DB
   │      └── ll-plugin-api    LPS-1 类型与 trait（零业务实现）
   ├── ll-native-shell         把 svc.* JSON 通道反向适配成 PluginContext 句柄
   ├── ll-plugin-abi           native 动态库的稳定 C-ABI（ll_plugin_load + vtable）
   ├── ll-migrate             插件 DB schema 迁移的纯逻辑（可单测，不碰 tauri）
   └── ll-icons                ll-icon:// 协议：exe/lnk/url 抽 32×32 PNG + 缓存
plugins/<id>/be                插件业务逻辑（只依赖 ll-plugin-api）
plugins/<id>/native            独立 cargo 工程 → cdylib，加载进宿主进程
```

## 2. 依赖方向（硬约束）

来自根 `Cargo.toml` 的注释，评审与 CI 都按这条看：

1. `plugins/*/be` 只能依赖 `ll-plugin-api` 与零平台依赖的通用库（serde/chrono/uuid/dirs/文本类），
   **禁止**依赖 `ll-host`、`tauri` 或彼此；
2. `ll-host` **不得**依赖任何具体插件；注册方向永远是"应用 crate → 插件 crate"；
3. 插件 crates 不在 `[workspace].members` 里，而在 `exclude` 中——它们由各自
   `plugins/<id>/native` 工程引用，这样 `cd plugins/<id>/be && cargo test` 仍能独立跑，
   否则单测会被 workspace 静默跳过。

新增 crate 属于"架构决策"：先写 [设计文档](../standards/basic/design-workflow.md)，再动手。

## 3. 改宿主的常见路径

| 想加什么 | 落点 | 连带改动 |
| :--- | :--- | :--- |
| 新的 `svc.*` 能力 | `ll-host` 的 svc 分发器 | 权限名进 manifest 白名单；前端 SDK `plugins/sdk` 暴露同名方法；指南补一节 |
| 新 IPC 命令 | `src-tauri/src/commands.rs` + `lib.rs` 注册 | 前端 `externalPlugins.ts` / `core` 调用点；错误文案要可行动 |
| 新窗口类型 | `src-tauri/src/lib.rs`（窗口构建） | `views[]` 契约、`PopupFrame`、宿主侧尺寸/锚定单测 |
| 新热键 | `src-tauri/src/hotkeys.rs` | 冲突仲裁、设置页改键、插件 `shortcut:` 声明 |
| DB schema 变更 | `ll-migrate`（纯逻辑）+ `src-tauri/src/migration.rs`（备份/定位/日志） | 旧库升级路径的单测；幂等可重跑 |
| native ABI 变更 | `ll-plugin-abi` | 版本门控（major 相等、插件 minor ≤ 宿主）、指南、所有 native 插件重编 |

**契约变更（manifest 字段、ABI 结构、窗口声明）是破坏性变更**：先设计，再同步 SDK、指南与
`api_version`，最后确认旧插件仍能加载。

## 4. 错误与 panic

- release profile 是 `panic = "abort"`：宿主路径上的 panic 会直接结束进程，没有 unwind。
- 可预期的失败（插件缺失、权限未声明、Python 不存在、网络超时）必须返回错误，
  由前端翻译成"缺什么、怎么办"的文案；原始错误写日志。
- 锁的 `RwLock::unwrap()`（中毒）可以接受；不要用它处理外部输入。

## 5. 验证

```powershell
cargo check --workspace                        # 全量编译
cargo test --workspace                         # 宿主与工具 crate 单测
cargo test -p ll-host                          # 只跑某个 crate
cargo test --manifest-path plugins/<id>/be/Cargo.toml   # 插件业务逻辑
build.cmd check                                # 上面 + 插件 crate + tsc
```

- 改了窗口/尺寸/焦点：离屏测试不算数，必须 `npm run tauri dev` 看真实窗口。
- 改了 native 加载：重编 dll 后跑 `node tools/update-plugin-integrity.mjs`，
  再重启确认插件真的被加载（integrity 不匹配是**静默拒绝**）。

## 6. 排障入口

| 现象 | 先看 |
| :--- | :--- |
| 插件注册了但调用报"未声明权限" | manifest `permissions` 与 svc 方法是否对齐 |
| 插件列表里没有 | `plugin_list` 返回、`backend.entry` 文件名与平台后缀、integrity |
| 窗口尺寸/位置不对 | 宿主侧换算与锚定逻辑（不要在前端补偿） |
| 数据库升级后字段缺失 | `ll-migrate` 的迁移步骤与 `user_version`/schema 版本判断 |
| 启动即退 | `lifecycle.log`、`LL_LOG=debug`、最近一次 ABI/feature 改动 |
