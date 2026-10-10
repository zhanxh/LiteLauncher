use rusqlite::{params, Connection, Result};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// 数据库连接状态管理器
pub struct DbState(pub Mutex<Connection>);

/// 获取数据库持久化存储路径
pub fn get_db_path() -> PathBuf {
    let mut dir = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("LiteLauncher");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir.push("litelauncher.db");
    dir
}

/// 初始化 SQLite 数据库与数据表
pub fn init_db() -> Result<Connection> {
    let db_path = get_db_path();
    let conn = Connection::open(&db_path)?;

    // 1. 初始化待办事项表 (todos)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS todos (
            id          TEXT PRIMARY KEY,
            content     TEXT NOT NULL,
            remind_at   TEXT,
            repeat_rule TEXT,
            completed   INTEGER NOT NULL DEFAULT 0,
            raw_input   TEXT,
            created_at  INTEGER NOT NULL
        )",
        [],
    )?;

    // 2. 初始化应用快捷方式表 (app_shortcuts)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_shortcuts (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            path        TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        )",
        [],
    )?;

    // 3. 初始化笔记元数据索引表 (note_index)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS note_index (
            path        TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            mtime       INTEGER NOT NULL,
            snippet     TEXT,
            tags        TEXT
        )",
        [],
    )?;

    // 4. 初始化 FTS5 全文索引虚拟表 (note_fts)
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
            title,
            snippet,
            content='note_index',
            content_rowid='rowid'
        )",
        [],
    )?;

    // 5. 初始化指令历史表 (command_history)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS command_history (
            input       TEXT PRIMARY KEY,
            plugin_id   TEXT NOT NULL,
            used_at     INTEGER NOT NULL,
            use_count   INTEGER DEFAULT 1
        )",
        [],
    )?;

    // 3. 初始插入几个常用系统预置应用（若表为空）
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM app_shortcuts",
        [],
        |row| row.get(0),
    ).unwrap_or(0);

    if count == 0 {
        // 预置应用按平台区分：Windows 直接指向系统可执行文件，
        // Linux 用 /usr/share/applications 的 .desktop 名称，macOS 走 /Applications
        #[cfg(target_os = "windows")]
        let default_apps = [
            ("Visual Studio Code", "code.exe"),
            ("Google Chrome", "chrome.exe"),
            ("Microsoft Edge", "msedge.exe"),
            ("Windows Terminal", "wt.exe"),
            ("计算器", "calc.exe"),
            ("记事本", "notepad.exe"),
            ("资源管理器", "explorer.exe"),
        ];

        #[cfg(target_os = "linux")]
        let default_apps = [
            ("Visual Studio Code", "code"),
            ("Google Chrome", "google-chrome"),
            ("Firefox", "firefox"),
            ("终端", "x-terminal-emulator"),
            ("文件管理器", "nautilus"),
            ("文本编辑器", "gedit"),
        ];

        #[cfg(target_os = "macos")]
        let default_apps = [
            ("Visual Studio Code", "/Applications/Visual Studio Code.app"),
            ("Google Chrome", "/Applications/Google Chrome.app"),
            ("Safari", "/Applications/Safari.app"),
            ("终端", "/System/Applications/Utilities/Terminal.app"),
            ("访达", "/System/Library/CoreServices/Finder.app"),
        ];

        let now = chrono::Utc::now().timestamp();
        for (name, path) in default_apps {
            let id = uuid::Uuid::new_v4().to_string();
            let _ = conn.execute(
                "INSERT INTO app_shortcuts (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, name, path, now],
            );
        }
    }

    Ok(conn)
}
