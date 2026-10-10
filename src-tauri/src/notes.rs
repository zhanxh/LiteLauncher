use crate::db::DbState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteItem {
    pub path: String,
    pub title: String,
    pub mtime: i64,
    pub snippet: String,
    pub tags: String,
}

/// 获取默认笔记目录（%USERPROFILE%\Documents\LiteNotes）
pub fn get_notes_dir() -> PathBuf {
    let mut dir = dirs::document_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("LiteNotes");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
        // 初始化内置欢迎笔记
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

/// 增量同步磁盘 Markdown 文件至 SQLite 索引库
fn sync_notes_index(conn: &rusqlite::Connection) -> Result<(), String> {
    let notes_dir = get_notes_dir();
    if !notes_dir.exists() {
        return Ok(());
    }

    let entries = match fs::read_dir(&notes_dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().map_or(false, |ext| ext == "md") {
            let metadata = match fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };

            let mtime = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            let path_str = path.to_string_lossy().to_string();

            // 检查数据库中现有记录的修改时间
            let existing_mtime: Option<i64> = conn
                .query_row(
                    "SELECT mtime FROM note_index WHERE path = ?1",
                    params![&path_str],
                    |row| row.get(0),
                )
                .ok();

            // 若修改时间未变，则直接跳过增量更新
            if let Some(saved_time) = existing_mtime {
                if saved_time == mtime {
                    continue;
                }
            }

            // 读取文件前 800 字提取标题与纯文本摘要
            let content = fs::read_to_string(&path).unwrap_or_default();
            let mut title = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "未命名笔记".into());

            // 优先解析首行 # 一级标题
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("# ") {
                    title = trimmed.trim_start_matches("# ").trim().to_string();
                    break;
                }
            }

            // 清理 Markdown 标记，保留纯文本作为前 500 字 snippet
            let clean_text = content
                .replace('#', "")
                .replace('*', "")
                .replace('`', "")
                .replace('\r', " ")
                .replace('\n', " ");
            let snippet: String = clean_text.chars().take(300).collect();

            // 写入或更新 note_index
            let _ = conn.execute(
                "INSERT INTO note_index (path, title, mtime, snippet, tags)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(path) DO UPDATE SET
                    title = excluded.title,
                    mtime = excluded.mtime,
                    snippet = excluded.snippet",
                params![&path_str, &title, mtime, &snippet, "[]"],
            );

            // 更新 FTS5 虚拟表
            let _ = conn.execute(
                "DELETE FROM note_fts WHERE title = ?1",
                params![&title],
            );
            let _ = conn.execute(
                "INSERT INTO note_fts (title, snippet) VALUES (?1, ?2)",
                params![&title, &snippet],
            );
        }
    }

    Ok(())
}

/// 检索笔记列表（按关键字过滤，优先 FTS5 或 LIKE 模糊匹配）
#[tauri::command]
pub fn search_notes(
    state: State<'_, DbState>,
    keyword: Option<String>,
) -> Result<Vec<NoteItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    
    // 执行快速增量同步
    let _ = sync_notes_index(&conn);

    let filter = keyword.unwrap_or_default().trim().to_lowercase();
    let query_sql = if filter.is_empty() {
        "SELECT path, title, mtime, snippet, tags FROM note_index ORDER BY mtime DESC"
    } else {
        "SELECT path, title, mtime, snippet, tags FROM note_index
         WHERE LOWER(title) LIKE ?1 OR LOWER(snippet) LIKE ?1
         ORDER BY mtime DESC"
    };

    let mut stmt = conn.prepare(query_sql).map_err(|e| e.to_string())?;
    let like_pattern = format!("%{}%", filter);

    let mapper = |row: &rusqlite::Row| -> rusqlite::Result<NoteItem> {
        Ok(NoteItem {
            path: row.get(0)?,
            title: row.get(1)?,
            mtime: row.get(2)?,
            snippet: row.get(3).unwrap_or_default(),
            tags: row.get(4).unwrap_or_default(),
        })
    };

    let mut list = Vec::new();
    if filter.is_empty() {
        let rows = stmt.query_map([], mapper).map_err(|e| e.to_string())?;
        for item in rows.flatten() {
            list.push(item);
        }
    } else {
        let rows = stmt.query_map([&like_pattern], mapper).map_err(|e| e.to_string())?;
        for item in rows.flatten() {
            list.push(item);
        }
    }

    Ok(list)
}

/// 实时读取指定路径的完整 Markdown 文件内容
#[tauri::command]
pub fn read_note_content(path: String) -> Result<String, String> {
    if path.contains("..") {
        return Err("非法的文件访问路径".into());
    }
    let p = Path::new(&path);
    if !p.exists() || !p.is_file() {
        return Err("文件不存在或非普通文本文件".into());
    }
    fs::read_to_string(p).map_err(|e| format!("读取文件失败: {}", e))
}

/// 实时保存 Markdown 文件内容并增量同步索引
#[tauri::command]
pub fn save_note_content(
    state: State<'_, DbState>,
    path: String,
    content: String,
) -> Result<(), String> {
    if path.contains("..") {
        return Err("非法的文件写入路径".into());
    }
    let p = Path::new(&path);
    fs::write(p, &content).map_err(|e| format!("写入文件失败: {}", e))?;

    // 保存后触发一次索引增量更新
    if let Ok(conn) = state.0.lock() {
        let _ = sync_notes_index(&conn);
    }

    Ok(())
}

/// 动态创建并弹出独立 Markdown 编辑窗口
///
/// 必须声明为 async：Tauri v2 在 Windows 上同步命令运行于主线程，
/// 在主线程里创建新 WebviewWindow 会阻塞事件循环造成死锁（窗口有标题无内容、整个进程无法响应）。
#[tauri::command]
pub async fn open_editor_window(
    app: AppHandle,
    path: String,
    title: String,
) -> Result<(), String> {
    // 基于文件路径的稳定 label（确定性哈希）：同一文件再次打开时聚焦既有窗口，而不是重复弹窗
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    let window_id = format!("editor-{:016x}", hasher.finish());

    // 如果已有对应窗口则聚焦并返回（先于隐藏主窗口判断，避免无谓隐藏）
    if let Some(existing) = app.get_webview_window(&window_id) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    // 隐藏主搜索框，聚焦到编辑器
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.hide();
    }

    // 构造带参数的 URL 路由：index.html?view=editor&path=...&title=...
    let target_url = format!(
        "index.html?view=editor&path={}&title={}",
        urlencoding_simple(&path),
        urlencoding_simple(&title)
    );

    let window_title = format!("LiteLauncher - {}", title);

    WebviewWindowBuilder::new(
        &app,
        &window_id,
        WebviewUrl::App(target_url.into()),
    )
    .title(window_title)
    .inner_size(860.0, 640.0)
    .min_inner_size(600.0, 400.0)
    .decorations(true)
    .resizable(true)
    .center()
    .build()
    .map_err(|e| format!("创建编辑器窗口失败: {}", e))?;

    Ok(())
}

/// 轻量 URL 编码辅助
pub(crate) fn urlencoding_simple(s: &str) -> String {
    let mut encoded = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{:02X}", b));
        }
    }
    encoded
}
