use rusqlite::{Connection, Result};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// 数据库连接状态管理器（核心库：command_history + app_settings）
pub struct DbState(pub Arc<Mutex<Connection>>);

/// 获取核心数据库持久化存储路径
pub fn get_db_path() -> PathBuf {
    let mut dir = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("LiteLauncher");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir.push("litelauncher.db");
    dir
}

/// 插件数据根目录（每插件一个子目录 + 独立 SQLite 文件）
pub fn plugin_db_root() -> PathBuf {
    let mut dir = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("LiteLauncher");
    dir.push("plugins");
    fs::create_dir_all(&dir).ok();
    dir
}

/// 外部插件安装目录（LLP/1：manifest.json + 任意语言 sidecar，拷入即安装）
pub fn extplugins_dir() -> PathBuf {
    let mut dir = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("LiteLauncher");
    dir.push("extplugins");
    fs::create_dir_all(&dir).ok();
    dir
}

/// 应用图标缓存目录（`ll-icon://` 抽出的 32×32 PNG）
///
/// 放 LocalAppData 而不是插件目录：图标是宿主能力，清缓存不应影响插件数据。
pub fn icons_dir() -> PathBuf {
    let mut dir = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("LiteLauncher");
    dir.push("icons");
    fs::create_dir_all(&dir).ok();
    dir
}

/// 初始化核心 SQLite 数据库与核心数据表
///
/// M3 起业务表归属各插件独立库（todos→todo.db、app_shortcuts→apps.db、
/// note_index/fts→notes.db）；核心库仅保留历史与设置。
/// 旧版本遗留的业务表若存在，由 migration::run_legacy_migration 搬出。
pub fn init_db() -> Result<Connection> {
    let db_path = get_db_path();
    let conn = Connection::open(&db_path)?;

    // 1. 指令历史表 (command_history)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS command_history (
            input       TEXT PRIMARY KEY,
            plugin_id   TEXT NOT NULL,
            used_at     INTEGER NOT NULL,
            use_count   INTEGER DEFAULT 1
        )",
        [],
    )?;

    // 2. 应用设置表 (app_settings)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    Ok(conn)
}
