# LiteLauncher 文档索引

> 状态权威：**`CHANGELOG.md` + 代码**。设计、评审、基线文档记录的是写作时点的决策，
> 可能落后于实现；"现在到底支持什么"以代码和 CHANGELOG 为准。
>
> Agent 入口：[AGENT.md](../AGENT.md)。人类入口：[README.md](../README.md)。

## 从这里开始

| 你是 | 读 |
| :--- | :--- |
| 第一次接手这个仓库 | [根 README](../README.md) → 本文 → [开发 Runbook](workflows/README.md) |
| 要动一个需求 | [00 生命周期](workflows/00-lifecycle.md)（建档 → 实施 → 验证 → 提交） |
| 要加或改插件 | [04 插件开发](workflows/04-plugin-dev.md) → [插件开发指南](guides/plugin-development-guide.md) |
| 要改宿主/前端 | [03 宿主](workflows/03-rust-host.md) / [02 前端](workflows/02-frontend.md) |
| 要发版 | [05 发布](workflows/05-release.md) → [版本与发布规范](standards/business/versioning-release.md) |
| 要查历史结论 | [records/](records/README.md)、[knowledge/](knowledge/README.md) |

## 目录

| 目录 | 内容 | 入库 | 何时看 |
| :--- | :--- | :---: | :--- |
| `workflows/` | **开发 Runbook**：生命周期、构建验证、前端、宿主、插件、发布 | ✅ | 动手前 |
| `standards/basic/` | 计划闭环、方案设计、输出定位、编码与提交 | ✅ | 写代码/建档前 |
| `standards/business/` | 插件验收、版本与发布 | ✅ | 交付/发版前 |
| `design/` | 架构基线与新增设计文档 | ✅ | 理解系统、做方案时 |
| `guides/` | 操作手册：插件开发、native ABI、分发签名 | ✅ | 写插件、发版时 |
| `records/` | 历史快照与决策记录（评审、路线图、实测、商业化） | ✅ | 追溯"当时为什么这么定" |
| `knowledge/` | 经验（lessons）与参考资料（reference） | ✅ | 排查问题、复盘后 |
| `plans/` | **进行中**的计划（本地留痕） | ❌ | 开工前查有没有在途工作 |
| `tasks/` | **进行中**的任务日志（本地留痕） | ❌ | 执行中勾选步骤 |
| `archive/` | 已完成的计划/任务（本地留痕） | ❌ | 查历史 |
| `images/` | 文档配图 | ✅ | — |

> `plans/`、`tasks/`、`archive/` 与 `.agent/` 在 `.gitignore` 中：属本机执行留痕，
> 结论要长期保留时写进 `design/`（方案）或 `knowledge/lessons/`（经验）。

## 新文档放哪

| 你写的是 | 放 |
| :--- | :--- |
| "这次要做什么、分几步" | `plans/` + `tasks/`（不入库） |
| "以后必须遵守的约定" | `standards/basic/` 或 `standards/business/` |
| "为什么这样设计、影响面多大" | `design/` |
| "怎么操作这个工具/接口" | `guides/` |
| "某个时点的评审/实测结论" | `records/` |
| "下次别再踩" | `knowledge/lessons/` |

判断顺序：**约束 → 规范；决策 → 设计；操作 → 手册；时点快照 → records；复用结论 → knowledge。**
命名与落位细则见 [输出定位规范](standards/basic/output-placement.md)。

## 文档状态标记

设计文档与快照类文档在文首标注：

- 🟡 实施中 / ✅ 已完成 / ⛔ 已废弃（设计文档）
- `> **历史快照（YYYY-MM-DD）**`（评审、路线图、实测）

已被推翻的结论**保留原文并标注**，不静默改写：决策过程本身是资产。

## 维护

- 改完代码顺手改文档：命令、路径、行为变了，对应 Runbook 与 `README.md` 同批更新。
- 每次提交在 `CHANGELOG.md` 的 `[Unreleased]` 记一行（重构/文档归 `Internal`，门禁会拦）。
- 链接检查：`npm run docs:check`（相对链接可达性）。
- 目录结构变更属于"新流程"，按 [方案设计工作流](standards/basic/design-workflow.md) 先出方案。
