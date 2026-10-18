# 设计方案（入库）

> 本目录存放**方案设计与架构基线**，随代码一起提交。计划/任务日志不入库（见
> [计划工作流](../standards/basic/plan-workflow.md)），长期保留的决策写在这里。

## 基线文档（保留原名）

| 文档 | 内容 | 状态 |
| :--- | :--- | :--- |
| [plugin-architecture-design.md](plugin-architecture-design.md) | 插件化架构、LPS 契约、权限模型 | 设计基线（2026-10-11） |
| [plugin-native-dylib-design.md](plugin-native-dylib-design.md) | native 动态库形态的技术取舍 | 设计基线 |
| [optimization-plan.md](optimization-plan.md) | 0.2–0.4 共 18 个工作包的优化方案与实施状态 | 执行记录（2026-10-18） |

## 新增设计文档

- 命名：`YYYYMMDD_HHMMSS_<kebab-slug>.md`（例：`20261020_101500_hotkey-manifest.md`）。
- 文首必须写明：创建时间、状态（🟡 实施中 / ✅ 已完成 / ⛔ 已废弃）、关联计划。
- 模板与触发条件见 [方案设计工作流](../standards/basic/design-workflow.md)。
- 完成后把本文件的表格补一行，避免出现"找不到的设计"。

## 现状与历史

- 架构以 `plugin-architecture-design.md` 为基线，实际实现以代码与 `CHANGELOG.md` 为准。
- 已被推翻的决策不要删除，把状态改成 ⛔ 并写清"为什么废弃、被什么替代"。
