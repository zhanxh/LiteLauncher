# 项目规范索引

> 规范回答"必须怎么做"，不解释背景；背景与取舍在设计文档与指南里。

## 基础规范（所有任务）

| 规范 | 说明 |
| :--- | :--- |
| [计划与任务工作流](basic/plan-workflow.md) | 建档、命名、六步闭环、上下文命令、门禁与降级 |
| [方案设计工作流](basic/design-workflow.md) | 什么必须设计、设计文档模板、`--check-design` 门禁 |
| [输出定位与命名](basic/output-placement.md) | 产物落位、文档/代码命名、脚本生命周期 |
| [编码与提交规范](basic/coding-conventions.md) | TS/Solid、Rust 依赖方向、插件约束、提交信息与 CHANGELOG |

## 业务规范（本项目特有）

| 规范 | 说明 |
| :--- | :--- |
| [插件交付验收](business/plugin-acceptance.md) | manifest 契约、权限最小化、测试与冒烟清单 |
| [版本与发布](business/versioning-release.md) | 版本单一真相源、tag 与 CI、产物与回滚 |

## 通用原则

- 文档语言：中文；标识符、命令、路径、字段名保持英文原样。
- 编码：UTF-8，无 BOM；`.cmd` 脚本必须 ASCII + CRLF（`cmd.exe` 解析多字节会错位）。
- 文件名：文档 `kebab-case`，Rust `snake_case`，TS 组件 `PascalCase`。
- 状态权威：**`CHANGELOG.md` + 代码**。设计/评审文档记录的是写作时点的决策，可能落后于实现。
