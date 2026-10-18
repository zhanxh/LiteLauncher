# 方案设计工作流（开发前置）

> 原则：**新增即需设计，先设计后实施**。设计文档入库 `docs/design/`（随代码版本管理），
> 计划/任务文档为本地执行留痕（不入库），见 [计划与任务工作流](plan-workflow.md)。

## 一、何时必须做方案设计

| 类别 | 触发条件（典型路径/场景） |
| :--- | :--- |
| 新插件 | 新增 `plugins/<id>/`（`fe/`、`native/`、`be/`、`manifest.json`） |
| 新宿主能力 | 新增 `src-tauri/crates/<crate>/`；`ll-host` 新增服务/子系统 |
| 契约变更 | `manifest.json` 字段增删、权限模型、`views` 形状、`svc.*` 方法集 |
| ABI 变更 | `ll-plugin-abi`、native 导出符号、插件与宿主的调用协议 |
| 新指令 | 新增 `/xxx` 指令或 DSL 语法（分词、参数、胶囊回显） |
| 数据模型 | 新增 SQLite 库/表，或对既有库做破坏性迁移（参考 `apps.db` schema v2） |
| 发布链路 | 签名、`latest.json`、updater、安装包结构、版本号策略 |
| 跨层重构 | 调整前端壳层与插件的职责边界、窗口/焦点模型 |

**不强制**：bug 修复、文案、样式微调、参数/常量迭代、纯测试补充。
但涉及接口形状或结构调整时，仍建议先落一份设计。

## 二、流程（插在六步闭环的「建档」与「执行」之间）

1. **建档** — 照常建计划 + 任务并绑定上下文。
2. **方案设计** — 按模板写 `docs/design/YYYYMMDD_HHMMSS_<slug>.md`：
   - 至少写清：背景与目标、方案与取舍、影响面、验证方法；
   - 涉及插件的，必须写明形态选择（native / llp / none）与权限清单；
   - **经用户确认后**再进入实施（不可逆或高成本的决策必须确认）。
3. **实施** — 严格按设计执行；设计变更要同步改设计文档（设计文档是决策记录，不是一次性草稿）。
4. **落档/复盘/收尾** — 设计文档随代码一起提交，并在文首更新状态与日期。

## 三、设计文档模板

```markdown
# 方案设计：<一句话标题>

- 创建时间：YYYY-MM-DD
- 状态：🟡 实施中 / ✅ 已完成 / ⛔ 已废弃
- 关联计划：`docs/plans/<同名>.md`（本地留痕）

## 背景与目标
（为什么做、解决什么问题、成功标准）

## 方案
（技术选型、数据流、模块与接口、关键决策及理由；可选方案对比）

## 影响面
（涉及文件/目录、契约兼容性、性能与包体、回滚方式）

## 验证
（如何证明设计达成：单测 / 插件测试 / 构建自检 / 人工确认）

## 结果记录
（实施后回填：产物、验证结论、提交号、遗留项）
```

## 四、门禁保障

`tools/agent/gate-check.mjs --check-design`（由 `pre-commit` 自动调用）：

- 本次提交**新增**了 `plugins/<id>/`（`plugins/sdk`、`plugins/ui` 除外）或
  `src-tauri/crates/<crate>/` 下的文件时，必须同时新增 `docs/design/` 文档；
- 仅修改（M/A 之外的常规改动）不拦截，避免误伤修复类提交。

降级：`GATE_SKIP=1 git commit ...`（留痕，仅用于已做设计但门禁误判的情况）。

## 五、既有基线文档

以下文档是当前架构的设计基线，**保留原文件名**（被源码注释引用）：

| 文档 | 内容 |
| :--- | :--- |
| [plugin-architecture-design.md](../../design/plugin-architecture-design.md) | 插件化架构、LPS 契约、权限模型 |
| [plugin-native-dylib-design.md](../../design/plugin-native-dylib-design.md) | native 动态库形态的设计取舍 |
| [optimization-plan.md](../../design/optimization-plan.md) | 0.2–0.4 的 18 个工作包与实施状态 |

新增设计文档一律使用时间戳前缀，并列进 [docs/design/README.md](../../design/README.md)。
