# 输出定位与命名规范

> Agent 产出的每一份文件都必须落在项目结构的确定位置，不放根目录、不新建平行体系。
> 与用户显式指定的路径冲突时，先说明冲突再执行，不擅自二选一。

## 一、产物落位

| 产物类型 | 位置 | 是否入库 | 说明 |
| :--- | :--- | :--- | :--- |
| 计划 / 任务日志 | `docs/plans/`、`docs/tasks/` | 否 | 本地留痕，见 [计划工作流](plan-workflow.md) |
| 方案设计 | `docs/design/` | **是** | 架构、契约、数据模型、发布链路 |
| 规范 | `docs/standards/{basic,business}/` | **是** | 主题命名，不带时间戳 |
| 操作手册 | `docs/guides/` | **是** | 插件开发、native 指南、分发 |
| 历史快照 / 决策记录 | `docs/records/` | **是** | 评审、路线图、实测基线、商业决策 |
| 可复用经验 | `docs/knowledge/lessons/` | **是** | 一条一文件，见 [知识库](../../knowledge/README.md) |
| 参考资料 | `docs/knowledge/reference/` | **是** | 外部资料摘录、协议对照 |
| 前端源码 | `src/`（`components/` PascalCase、`core/` camelCase） | **是** | 生成文件 `src/plugins.generated.ts` 禁止手改 |
| 宿主 / crate | `src-tauri/src/`、`src-tauri/crates/<crate>/` | **是** | crate 名统一 `ll-` 前缀 |
| 插件 | `plugins/<id>/`（`manifest.json` + `fe/` + `native/` + `be/`） | **是** | 目录名即插件 id，小写单词 |
| 构建/测试脚本 | `tools/*.mjs` | **是** | 由 `package.json` scripts 调用 |
| 一次性脚本 | `tools/scratch/` | 否 | 任务结束即清理，转通用后移入 `tools/` |
| 前端构建产物 | `dist/` | 否 | `npm run build` 生成 |
| 便携产物 | `release/`（`LiteLauncher.exe` + `plugins/`） | 否 | `build.cmd` 生成 |
| 编译缓存 | `src-tauri/target*`、`plugins/*/native/target/` | 否 | 不要手工清理 ship 目录（代价是整轮重编） |
| 运行日志 | exe 同目录 `lifecycle.log`（超 2 MB 轮转为 `.log.1`） | 否 | 级别由 `LL_LOG` 控制 |

## 二、文档命名

| 类型 | 规则 | 示例 |
| :--- | :--- | :--- |
| 计划 / 任务 / 新设计 | `YYYYMMDD_HHMMSS_<kebab-slug>.md` | `20261018_143052_docs-governance.md` |
| 规范 / 手册 / 基线 | 主题名，`kebab-case`，无时间戳 | `plan-workflow.md`、`plugin-development-guide.md` |
| 既有设计基线 | 保留原名 | `plugin-architecture-design.md` |
| 插件目录 | 单个小写单词，与指令同名 | `plugins/todo`、`/todo` |
| Rust crate | `ll-<domain>` | `ll-host`、`ll-plugin-abi` |
| Rust 源文件 | `snake_case.rs` | `native.rs`、`ll_plugin_assets.rs` |
| TS 组件 | `PascalCase.tsx` | `ResultPanel.tsx` |
| TS 模块 | `camelCase.ts` | `externalPlugins.ts` |

> 时间戳前缀的作用：按文件名排序即按时间排序，且同日重跑不覆盖。

## 三、脚本落位（生命周期）

| 阶段 | 位置 | 判据 |
| :--- | :--- | :--- |
| 临时脚本（单次任务） | `tools/scratch/` | 文件名含日期区间或一次性代号 |
| 转通用 | `tools/` | 被 `package.json`、CI 或构建脚本复用 |
| 插件专属 | `plugins/<id>/` | 只服务该插件（如 `native/build.cmd`） |
| 不再需要 | 删除 | 任务收尾时清理，不留在 `tools/` 顶层 |

- `tools/` 顶层只放**可复用**脚本；新增脚本先写进 `tools/scratch/`，被流水线复用后再晋升。
- Python 只用于既有测试（`tools/test-pomo-logic.py`），新工具优先用 Node（目标机器不必装 Python）。

## 四、禁止行为

- ❌ 在仓库根或 `docs/` 根直接放新文档
- ❌ 手改生成文件（`src/plugins.generated.ts`）或插件 `integrity`（由 `tools/update-plugin-integrity.mjs` 回填）
- ❌ 手改版本号（用 `npm run version:sync`，`package.json` 是单一真相源）
- ❌ 提交 `docs/plans|tasks|archive`、`.agent/`、`dist/`、`release/`、编译产物
- ❌ 把日志、截图、临时 JSON 写进源码目录
- ❌ 为一次性任务在 `docs/` 新建平行目录体系
