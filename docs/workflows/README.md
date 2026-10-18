# 开发 Runbook

> 这里回答"这类改动该怎么做、做完跑什么"。规范（必须遵守的约束）在
> [../standards/](../standards/README.md)，操作手册（怎么写插件）在 [../guides/](../guides/)。

## 路线

| 场景 | Runbook | 一句话 |
| :--- | :--- | :--- |
| 接一个需求，从开工到提交 | [00-lifecycle](00-lifecycle.md) | 六步闭环 + 按改动类型选验证 |
| 环境、构建、自检、排障 | [01-build-verify](01-build-verify.md) | `npm run check` → `build.cmd` → `build.cmd ship` |
| 改壳层 / 界面 / 交互 | [02-frontend](02-frontend.md) | Solid 响应性、`npm run gen`、真实窗口冒烟 |
| 改宿主 / crate / IPC | [03-rust-host](03-rust-host.md) | 依赖方向、契约变更、cargo test |
| 新增或修改插件 | [04-plugin-dev](04-plugin-dev.md) | 选形态 → 骨架 → 权限 → 测试 |
| 发版 | [05-release](05-release.md) | 版本同步 → tag → CI → 抽查 |

## 验证矩阵（按改动类型）

> 原则：**每次提交至少跑 `npm run check`；改动涉及窗口/渲染/交互时，必须真实启动看一遍。**
> `cargo check` 与单测都覆盖不到"窗口白屏""热键不响应"这类问题。

| 改动类型 | 必跑命令 | 额外确认 |
| :--- | :--- | :--- |
| **任意提交** | `npm run gate` | 任务绑定 + `CHANGELOG.md` 已更新（新增模块还需设计文档） |
| 任意代码改动 | `npm run check` | 类型 + 全 workspace 编译 |
| 前端 UI / 交互 / 样式 | `npm run build`；`npm run tauri dev` | 真实窗口：唤起、键盘上下选择、失焦隐藏、暗色主题 |
| 窗口 / 尺寸 / 焦点 / 多屏 | `npm run tauri dev` | 至少两个窗口同开；缩放与置顶表现 |
| 纯前端插件 `kind:none` | `npm run plugin:test:fe`；`npm run build` | 指令输入 → 回车执行 → 面板刷新 |
| LLP 插件 | `npm run plugin:test` | 目标机无 Python 时的降级提示 |
| native 插件业务逻辑 | `cargo test --manifest-path plugins/<id>/be/Cargo.toml` | — |
| native 插件产物 | `cargo check --manifest-path plugins/<id>/native/Cargo.toml`；`node tools/update-plugin-integrity.mjs` | 重启后插件能被加载（integrity 过期会被静默拒绝） |
| 宿主 crate / IPC | `cargo test --workspace`；`build.cmd check` | 关掉 dev server 用 release exe 复测一次 |
| manifest / ABI / 契约 | 上述全部 + 设计文档 | `api_version` 是否仍兼容；旧插件是否还能加载 |
| 数据库 schema | 对应 crate 单测 | 迁移前备份、幂等重跑、旧库升级路径 |
| 发布链路 / updater | `build.cmd ship` | 安装包实机安装、更新检查读到新版本 |
| 纯文档 | `npm run docs:check` | 相对链接可达 |

## 快速命令

```powershell
npm run gen              # 生成 src/plugins.generated.ts（predev/prebuild 自动跑）
npm run tauri dev        # 开发调试（前端 1420 + Rust 增量编译）
npm run check            # cargo check --workspace && tsc --noEmit
build.cmd check          # 更全：+ 插件 be 单测 + native crate check
build.cmd                # 日常构建（thin LTO），产物 release/LiteLauncher.exe
build.cmd ship           # 正式发布（fat LTO + NSIS 安装包），产物 target-ship/
npm run docs:check       # 文档相对链接检查
```

> 不要用 `cargo build --release` 代替 `build.cmd`：缺少 `custom-protocol` 特性，
> 产物会去连 `localhost:1420`，表现为白屏或"拒绝连接"。
