//! 插件数据库 schema 迁移的**纯逻辑**（不依赖 tauri / ll-host）。
//!
//! 为什么单独成 crate：迁移是"改用户数据"的操作，必须有能真正跑起来的单测。
//! 宿主 crate 链接了 Tauri/WebView2，在部分 Windows GNU 工具链上测试二进制会在
//! 加载期就失败（`STATUS_ENTRYPOINT_NOT_FOUND`，见 docs/plugin-ux-review.md RK-07），
//! 迁移逻辑若留在 `src-tauri/src/migration.rs` 就永远测不了。
//!
//! 这里只放"给定一个 rusqlite 连接该做什么"，文件定位/备份/日志仍留在宿主。

pub mod apps;
