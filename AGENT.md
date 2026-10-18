# LiteLauncher

Tauri 2 + SolidJS + Rust 的桌面启动器：搜索框即入口，功能一律以插件形态接入
（native / llp / none），窗口是按需弹出的上下文容器。

- **语言**：TypeScript（strict）+ Rust（Edition 2024）
- **构建**：Vite 8 + Tauri 2 + Cargo workspace；SQLite（FTS5）为索引层，笔记正文留在磁盘
- **平台**：Windows 为主目标，Linux 次之
- **状态权威**：`CHANGELOG.md` + 代码。设计/评审/基线文档记录写作时点的决策，可能落后于实现

---

## ⏭ 执行前置路由门禁（先于一切）

收到任何需求后，第一步不是执行，而是匹配路由：

1. 对照 [docs/routing.yaml](docs/routing.yaml) 的 `triggers` 匹配意图；
2. 命中 → 读 `target` 全文 → **严格按其中流程执行**；
3. 未命中 → 走默认工作流 [计划与任务工作流](docs/standards/basic/plan-workflow.md)；
4. 复合意图（"加个插件并接进指令系统"）→ 按**主意图**先匹配，其余在主目标完成后顺序处理。

> 命中路由 ≠ 跳过项目约束。下面的「工作流约束」与「验证门禁」对**所有**任务强制。

## 🔒 工作流约束（所有会改文件的任务）

1. **检查** — `npm run task:current`；再看 `docs/plans/`、`docs/tasks/` 有没有同名文档。
2. **建档** — 没有就先建 `docs/plans/YYYYMMDD_HHMMSS_<slug>.md` + 同名任务，然后
   `npm run task:auto -- docs/plans/<file>.md`（绑定写入 `.agent/contexts/<stem>.yaml`）。
3. **设计前置** — 新插件 / 新 crate / 契约（manifest、ABI、视图）/ 新指令 / 数据模型 /
   发布链路 / 跨层重构 → 先写 `docs/design/` 并确认，见
   [方案设计工作流](docs/standards/basic/design-workflow.md)。
4. **执行** — 分小步，每步结束仓库都能构建；每完成一步立刻勾选任务文档。
5. **验证** — 按下方「验证门禁」跑对应命令，结论写进任务文档（写命令与结果，不写"已验证"）。
6. **收尾** — 更新 `CHANGELOG.md`（每次提交至少一行，重构/文档归 `Internal`）→ 提交 → 提交后归档：`npm run task:archive -- <stem>`。

**门禁机械化**：`.githooks/pre-commit`（建档 + 设计 + 变更日志）与 `pre-push`（建档）调用
`node tools/agent/gate-check.mjs`；底层逻辑不依赖任何特定编辑器。
启用一次：`npm run hooks:install`（Linux/macOS 另需 `chmod +x .githooks/*`）。降级留痕：`GATE_SKIP=1 git commit ...`。

> `docs/plans|tasks|archive` 与 `.agent/` 是**本机执行留痕**（gitignored）；
> 要长期保留的结论写进 `docs/design/` 或 `docs/knowledge/lessons/`。

## ✅ 验证门禁（按改动类型）

| 改动 | 必跑 | 额外确认 |
| :--- | :--- | :--- |
| 任意提交 | `npm run gate` | 任务绑定 + `CHANGELOG.md` 已更新（新增模块还需设计文档） |
| 任意代码 | `npm run check` | `cargo check --workspace` + `tsc --noEmit` |
| 前端 / 交互 / 样式 | `npm run build` + `npm run tauri dev` | 真实窗口：唤起、键盘选择、失焦隐藏、主题 |
| 窗口 / 尺寸 / 焦点 | `npm run tauri dev` | 多窗口同开、缩放、置顶 |
| 纯前端插件 | `npm run plugin:test:fe` | 输入 → 回车 → 面板刷新 |
| LLP 插件 | `npm run plugin:test` | 无 Python 时的降级提示 |
| native 插件 | `cargo test --manifest-path plugins/<id>/be/Cargo.toml` + `cargo check --manifest-path plugins/<id>/native/Cargo.toml` | `node tools/update-plugin-integrity.mjs` 后重启 |
| 宿主 / crate / IPC | `cargo test --workspace` + `build.cmd check` | 关掉 dev server 用 release 复测 |
| manifest / ABI / 契约 | 上述全部 + 设计文档 | 旧插件仍能加载 |
| 发布链路 | `build.cmd ship` | 安装包实机安装、更新检查 |
| 纯文档 | `npm run docs:check` | 相对链接可达 |

> 提交前推荐 `build.cmd check`（含插件单测）。**渲染/窗口/热键类改动必须真实启动确认**，
> 离屏与单测都覆盖不到平台窗口行为。

## 🧭 场景速查表

| 你想做的事 | 读 | 入口命令 |
| :--- | :--- | :--- |
| 接一个需求，从开工到提交 | [00-lifecycle](docs/workflows/00-lifecycle.md) | 见该文 |
| 环境、构建、自检、排障 | [01-build-verify](docs/workflows/01-build-verify.md) | `npm run check` / `build.cmd` |
| 改壳层 / 界面 / 交互 | [02-frontend](docs/workflows/02-frontend.md) | `npm run tauri dev` |
| 改宿主 / crate / IPC | [03-rust-host](docs/workflows/03-rust-host.md) | `cargo test --workspace` |
| 新增或修改插件 | [04-plugin-dev](docs/workflows/04-plugin-dev.md) | `npm run plugin:create -- <id>` |
| 发版 | [05-release](docs/workflows/05-release.md) | `build.cmd ship` |
| 写插件（完整契约） | [插件开发指南](docs/guides/plugin-development-guide.md) | — |
| native ABI / 动态库 | [native 插件指南](docs/guides/native-plugin-guide.md) | — |
| 分发、签名、自动更新 | [分发手册](docs/guides/distribution.md) | — |
| 插件交付前自查 | [插件交付验收](docs/standards/business/plugin-acceptance.md) | — |
| 版本号 / 发版约束 | [版本与发布](docs/standards/business/versioning-release.md) | `npm run version:check` |
| 产物该放哪、怎么命名 | [输出定位](docs/standards/basic/output-placement.md) | — |
| 编码与提交信息 | [编码与提交规范](docs/standards/basic/coding-conventions.md) | — |
| 查历史结论 / 当时为什么 | [records/](docs/records/README.md) | — |
| 复盘、沉淀经验 | [knowledge/](docs/knowledge/README.md) | — |

## 🗺 架构地图

```
src/                     壳层（SolidJS）：App.tsx、components/、core/（parser/tokenizer/fuzzy）
src/plugins.generated.ts ← npm run gen 生成，禁止手改
plugins/sdk/             @ll/sdk —— 插件唯一允许依赖的壳层包
plugins/ui/              @ll/ui  —— 共享 UI（PopupFrame 等）
plugins/<id>/            manifest.json + fe/（前端）+ native/（cdylib 工程）+ be/（业务逻辑）
src-tauri/src/           窗口、托盘、热键、commands（IPC）、settings、migration
src-tauri/crates/
  ll-host                插件注册表、权限门控、IPC 通道、native 加载、每插件独立 DB
  ll-plugin-api          LPS-1 类型与 trait（零业务实现）
  ll-native-shell        svc.* JSON 通道 → PluginContext 句柄
  ll-plugin-abi          native 稳定 C-ABI（ll_plugin_load + vtable）
  ll-migrate             插件 DB schema 迁移纯逻辑（可单测）
  ll-icons               ll-icon:// 图标协议与缓存
tools/                   构建/测试/发布脚本（Node）；tools/agent/ 为工作流脚本
docs/                    workflows / standards / design / guides / records / knowledge（入库）
```

## 🚀 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `npm run tauri dev` | 开发调试（前端 1420 + Rust 增量编译） |
| `npm run gen` | 生成 `src/plugins.generated.ts`（dev/build 自动跑） |
| `npm run check` | `cargo check --workspace && tsc --noEmit` |
| `build.cmd check` | 全量自检：+ 插件 be 单测 + native crate 检查 |
| `build.cmd` | 日常构建 → `release/LiteLauncher.exe` + `release/plugins/` |
| `build.cmd ship` | 正式发布：fat LTO + NSIS + updater 产物 |
| `cargo test --workspace` | 宿主与工具 crate 单测 |
| `npm run plugin:test:fe` / `plugin:test` | 纯前端 / LLP 插件测试 |
| `npm run plugin:create -- <id> --name "名称"` | 生成 native 插件骨架 |
| `npm run plugin:install -- <id> [--portable]` | 部署插件到用户目录或便携目录 |
| `node tools/update-plugin-integrity.mjs` | 重建 dll 后回填 `backend.integrity` |
| `npm run version:check` / `version:sync` | 版本一致性校验 / 同步 |
| `npm run docs:check` | 文档相对链接检查 |
| `npm run task:current` / `task:auto` / `task:archive` | 任务上下文：查看 / 绑定 / 归档 |
| `npm run hooks:install` | 启用 `.githooks`（每台机器一次） |

## ⛔ 硬约束

- **插件不进主程序**：主程序不链接任何插件 crate；插件在 `[workspace].exclude` 中，
  由各自 `plugins/<id>/native` 工程引用。
- **依赖方向**：`plugins/*/be` 只能依赖 `ll-plugin-api` 与零平台依赖的通用库，
  禁止依赖 `ll-host`、`tauri` 或彼此；`ll-host` 不得依赖任何具体插件。
- **不要用 `cargo build --release` 代替 `build.cmd`**：缺 `custom-protocol` 特性，
  产物会连 `localhost:1420`，表现为白屏/拒绝连接。
- **不手改生成物**：`src/plugins.generated.ts`、`backend.integrity`、版本号（用脚本同步）。
- **`panic = "abort"`**：宿主路径上的 panic 直接结束进程，不要用 panic 处理可预期失败。
- **`.cmd` 脚本必须 ASCII + CRLF**：`cmd.exe` 解析多字节会错位执行。
- **`query()` 默认逐键无防抖**：网络请求放 `onSelect`；需要每键查索引的声明
  `command.queryDebounceMs`。
- **每次提交必须动 `CHANGELOG.md`**：`[Unreleased]` 至少一行，重构/文档/CI 归 `Internal`；
  门禁 `--check-changelog` 会拦（merge / rebase / cherry-pick 除外）。
- **插件权限最小化**：没在 `permissions` 里声明的能力，宿主给的是 `None` 句柄。

## 📄 完成定义（DoD）

- [ ] 计划/任务已建档并绑定；结果已回填
- [ ] 按改动类型跑过验证，命令与结论有记录
- [ ] 涉及渲染/交互的改动已真实启动确认
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 为本次修改记了一行（`Internal` 也算）
- [ ] 文档与命令同步更新（Runbook、README、指南）
- [ ] `npm run task:archive -- <stem>` 已释放绑定
- [ ] 提交信息符合 `feat(scope): ...` / `fix(scope): ...`

## 文档结构

入口 [docs/README.md](docs/README.md)：`workflows/`（怎么跑）、`standards/`（必须遵守）、
`design/`（方案与基线）、`guides/`（手册）、`records/`（历史快照）、`knowledge/`（经验）、
`plans|tasks|archive`（本地留痕）。
