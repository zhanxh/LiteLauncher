# 计划与任务标准化工作流

> 目的：让"先计划、再动手、留痕迹、可复盘"成为可复制的流程，任何 Agent（或人）
> 接手任务时都按同一套模板建档、执行、落档。
>
> 适用：**所有会改动项目文件的任务**（代码、文档、插件、脚本、配置）。
> 纯问答、只读排查、单条命令查询不需要建档。

## 一、目录与命名

| 目录 | 用途 | 是否入库 | 命名 |
| :--- | :--- | :--- | :--- |
| `docs/plans/` | 方案计划（做什么、为什么、怎么做） | 否（本地留痕） | `YYYYMMDD_HHMMSS_<slug>.md` |
| `docs/tasks/` | 任务日志（步骤勾选、结果记录） | 否（本地留痕） | 与计划同名 |
| `docs/archive/` | 已完成的计划/任务归档 | 否（本地留痕） | `archive/plans/`、`archive/tasks/` |
| `docs/design/` | 方案设计（架构/契约/数据模型） | **是** | 新建：`YYYYMMDD_HHMMSS_<slug>.md` |

- `<slug>`：英文小写 + 连字符，例：`plugin-hotkey-manifest`、`docs-governance`。
- 同名计划与任务是**一对**：同一个 stem，便于 `task:auto` 自动绑定、`task:archive` 一并归档。
- 显示名示例：`20261018_143052_docs-governance.md`。
- 既有基线文档（如 `docs/design/plugin-architecture-design.md`）**保留原名**：它们被源码注释与
  其他文档引用，改名会断链；其创建时间写进文首。

> `docs/plans|tasks|archive` 与 `.agent/` 在 `.gitignore` 中，属本机执行留痕，不推送到远端。
> 需要长期保留的结论，进入 `docs/design/`（方案）或 `docs/knowledge/lessons/`（经验）。

## 二、计划文档模板

```markdown
# <任务标题>

**状态**: 🔴 待审批 / 🟡 实施中 / ✅ 已完成
**日期**: YYYY-MM-DD
**关联任务**: `docs/tasks/<同名>.md`
**背景**: 为什么做（现状问题 / 用户诉求）

## 目标
- 目标 1（可验证）
- 目标 2

## 关键决策（用户确认项）
| 决策 | 选择 | 理由 |
| :--- | :--- | :--- |

## 实施步骤（分阶段，每阶段可独立验证）
1. **阶段名** — 涉及文件/模块
   - 子步骤：具体可验证动作
2. ...

## 约束
- 平台/依赖/构建时间限制
- 不可逆动作与回滚方式

## 结果
- 关键产出、验证命令与结论（执行后回填）
```

## 三、任务文档模板

```markdown
# 任务：<标题>

**关联计划**: `docs/plans/<同名>.md`

## 步骤
1. [ ] 步骤一
2. [ ] 步骤二

## 结果记录
（执行后填写：改动文件、验证命令输出、提交号）
```

## 四、六步闭环

1. **检查** — 先看有没有在建的工作：
   `npm run task:current`；再在 `docs/plans/`、`docs/tasks/` 查同名文档。
2. **建档** — 不存在则按模板新建计划 + 任务（同 stem），绑定当前会话：
   `npm run task:auto -- docs/plans/<文件名>.md`
   - 涉及"新东西"（新插件、新 crate、新指令、新窗口、新数据表、ABI/契约变更）时，
     必须先写 `docs/design/` 设计文档并确认，见 [方案设计工作流](design-workflow.md)。
3. **执行** — 按计划分阶段实施；每完成一个阶段立刻勾选任务文档。
   - 临时脚本放 `tools/scratch/`（gitignored），转通用后再进 `tools/`；
     与某个插件强相关的脚本放 `plugins/<id>/`，见 [输出定位规范](output-placement.md)。
4. **落档** — 回填任务文档（勾选 + 结果）、计划标记 ✅、刷新 `CHANGELOG.md`
   （**每次修改至少一行**：用户可感知→`Added/Changed/Fixed/Removed`，其余→`Internal`）。
5. **复盘** — 对照目标核对产出，记录偏差；有可复用结论时写进
   `docs/knowledge/lessons/`（一条一个文件，见 [知识库](../../knowledge/README.md)）。
6. **收尾** — 提交（代码 + 文档 + CHANGELOG），**提交后**归档并释放绑定：
   `npm run task:archive -- <stem>`（归档物为本地留痕，不需再提交）。

## 五、上下文命令

| 命令 | 说明 |
| :--- | :--- |
| `npm run task:current` | 显示当前绑定（最新者为主上下文） |
| `npm run task:list` | 扫描进行中的计划/任务，标注绑定状态 |
| `npm run task:auto -- docs/plans/<file>.md` | 建档后自动绑定计划 + 同名任务 |
| `npm run task:switch -- <stem>` | 切换到已有计划/任务 |
| `npm run task:close` | 标记绑定完成（不归档） |
| `npm run task:archive -- <stem>` | 归档该计划/任务并释放绑定（标准收尾） |

> 绑定文件：`.agent/contexts/<stem>.yaml`（gitignored）。**每个计划一份**，
> 多会话并发时互不覆盖；收尾一律带自己的 `<stem>`，不要依赖无参扫描。

## 六、门禁

- **硬拦截点**：`.githooks/pre-commit`（建档 + 设计门禁）与 `.githooks/pre-push`（建档）。
- **底层命令**：`node tools/agent/gate-check.mjs`。
- **启用方式**（每台机器一次）：`npm run hooks:install`；
  Linux/macOS 还需 `chmod +x .githooks/pre-commit .githooks/pre-push`。
- **降级留痕**：`GATE_SKIP=1 git commit ...`。只应在"确实已做设计但被误伤"时使用，
  并在提交说明里写明原因。

门禁只检查三件事：

1. 存在**有效绑定**：绑定指向的计划文件存在、绑定未关闭、计划状态行未标 ✅；
2. 本次提交若**新增**了高风险目录（`plugins/<id>/`、`src-tauri/crates/<crate>/`）的代码，
   必须同时新增 `docs/design/` 设计文档；
3. 本次提交必须**更新 `CHANGELOG.md`**（merge / rebase / cherry-pick 与无暂存改动时跳过）。

## 七、验收清单

- [ ] 计划/任务文档齐全，stem 一致，状态明确
- [ ] 关键决策有记录（用户确认，或合理默认 + 理由）
- [ ] 每个阶段有验证证据（命令输出 / 测试结果 / 人工确认）
- [ ] 结果已回填任务文档；`CHANGELOG.md` 的 `[Unreleased]` 为本次修改记了一行
- [ ] 会话绑定已释放（`npm run task:archive -- <stem>`）
- [ ] `npm run check` 或 `build.cmd check` 通过（按改动类型）
