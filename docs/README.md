# LiteLauncher 文档索引

状态权威：**`CHANGELOG.md` + 代码**。设计/优化文档记录的是写作时点的决策与背景，
可能落后于实现；涉及"现在到底支持什么"以代码和 CHANGELOG 为准。

| 文档 | 用途 | 状态 |
|---|---|---|
| [plugin-architecture-design.md](plugin-architecture-design.md) | 插件架构、LPS 契约、权限模型 | 设计基线 |
| [plugin-development-guide.md](plugin-development-guide.md) | 写插件的操作手册（FE/LLP/native） | 随 SDK 更新 |
| [native-plugin-guide.md](native-plugin-guide.md) | native dylib 插件 ABI 与构建 | 随 ABI 更新 |
| [plugin-native-dylib-design.md](plugin-native-dylib-design.md) | native 插件设计取舍 | 设计基线 |
| [plugin-roadmap.md](plugin-roadmap.md) | 历史路线图 | 历史快照 |
| [plugin-ux-review.md](plugin-ux-review.md) | 2026-10-13 的交互评审 | **历史快照** |
| [optimization-plan.md](optimization-plan.md) | 18 个工作包的优化计划与实施状态 | 执行记录 |
| [distribution.md](distribution.md) | 安装包、签名、自动更新与发布流程 | 运维手册 |
| [monetization.md](monetization.md) | 商业化边界、定价假设与退出策略 | 决策记录 |
| [memory-baseline.md](memory-baseline.md) | WP-10 内存基线 | 实测记录 |

## 阅读顺序

1. 新用户：根目录 `README.md` → 本文档索引；
2. 插件作者：`plugin-development-guide.md` → `plugin-architecture-design.md`；
3. native 插件作者：`native-plugin-guide.md` → `plugin-native-dylib-design.md`；
4. 维护者：`optimization-plan.md` → `CHANGELOG.md` → `memory-baseline.md`。
