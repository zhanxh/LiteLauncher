//! 笔记目录基础设施：Documents/LiteNotes 与首次运行种子笔记

use std::fs;
use std::path::PathBuf;

/// 获取默认笔记目录（Documents/LiteNotes），首次运行播种欢迎笔记
pub fn get_notes_dir() -> PathBuf {
    let mut dir = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("LiteNotes");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
        let intro_note = dir.join("LiteLauncher 快速入门指南.md");
        let _ = fs::write(
            &intro_note,
            "# LiteLauncher 快速入门指南\n\n欢迎使用 LiteLauncher！这是一款以搜索框为唯一交互入口的生产力启动器。\n\n## 快捷指令\n- `/note`：快速检索并阅读本地 Markdown 笔记文档\n- `/todo`：待办日程管理与即时提醒\n- `/app`：毫秒级应用唤起与快捷方式\n\n点击或回车即可在独立编辑窗口中实时修改保存本笔记（支持 Ctrl+S 保存）。\n",
        );

        let arch_note = dir.join("生产力与极简哲学.md");
        let _ = fs::write(
            &arch_note,
            "# 生产力与极简哲学\n\nCommand-First, Window-as-Context, Plugin-Driven.\n\n减少界面驻留时间，按需唤起上下文容器。当任务完成，界面立即隐退，注意力归还用户。\n",
        );
    }
    dir
}
