//! ll-plugin-notes —— LiteLauncher 笔记插件后端（独立编译 crate）
//!
//! 结构：
//! - `notes_dir`：笔记目录基础设施（Documents/LiteNotes + 欢迎笔记种子）
//! - `plugin`：NotesPlugin（FTS 索引/读写/编辑器窗口，经 ll-plugin-api 门控句柄）

mod notes_dir;
mod plugin;

pub use plugin::NotesPlugin;
