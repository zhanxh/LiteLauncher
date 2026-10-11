//! 旧版单库数据迁移器（M3，一次性、幂等）
//!
//! 老版本所有业务表混在核心库 litelauncher.db 中。本迁移器把：
//! - todos            → plugins/todo/todo.db
//! - app_shortcuts    → plugins/apps/apps.db（含预置应用种子）
//! - note_index/fts   → plugins/notes/notes.db（FTS 重建）
//! - popup_auto_close_secs 设置键 → todo.popup_auto_close_secs 前缀改写
//!
//! 搬迁前整库备份为 litelauncher.db.bak-<时间戳>；逐表 try + 日志；
//! 核心库中已搬走的旧行在验证行数一致后删除，迁移完成写标记
//! `migration.plugins_v1 = done`（重新运行时直接跳过）。

use crate::db::get_db_path;
use crate::log_lifecycle;
use ll_host::PluginDbRegistry;
use rusqlite::params;

const MARKER_KEY: &str = "migration.plugins_v1";

/// 预置应用种子（与旧版 init_db 中的 default_apps 一致，按平台区分）
fn default_apps() -> &'static [(&'static str, &'static str)] {
    #[cfg(target_os = "windows")]
    {
        &[
            ("Visual Studio Code", "code.exe"),
            ("Google Chrome", "chrome.exe"),
            ("Microsoft Edge", "msedge.exe"),
            ("Windows Terminal", "wt.exe"),
            ("计算器", "calc.exe"),
            ("记事本", "notepad.exe"),
            ("资源管理器", "explorer.exe"),
        ]
    }
    #[cfg(target_os = "linux")]
    {
        &[
            ("Visual Studio Code", "code"),
            ("Google Chrome", "google-chrome"),
            ("Firefox", "firefox"),
            ("终端", "x-terminal-emulator"),
            ("文件管理器", "nautilus"),
            ("文本编辑器", "gedit"),
        ]
    }
    #[cfg(target_os = "macos")]
    {
        &[
            ("Visual Studio Code", "/Applications/Visual Studio Code.app"),
            ("Google Chrome", "/Applications/Google Chrome.app"),
            ("Safari", "/Applications/Safari.app"),
            ("终端", "/System/Applications/Utilities/Terminal.app"),
            ("访达", "/System/Library/CoreServices/Finder.app"),
        ]
    }
}

pub fn run_legacy_migration(core_conn: &rusqlite::Connection, registry: &PluginDbRegistry) {
    // 0. 幂等标记：已迁移过则直接保证插件库 schema 存在后返回
    let migrated = core_conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![MARKER_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .as_deref()
        == Some("done");

    if migrated {
        ensure_plugin_schemas(registry);
        return;
    }

    log_lifecycle("migration: 开始旧版单库数据迁移");

    // 1. 整库文件备份（迁移前快照，任何失败都可手工回滚）
    let core_path = get_db_path();
    let backup = core_path.with_extension(format!(
        "db.bak-{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    match std::fs::copy(&core_path, &backup) {
        Ok(_) => log_lifecycle(&format!("migration: 已备份至 {}", backup.display())),
        Err(e) => {
            log_lifecycle(&format!("migration: 备份失败（{}），中止迁移，数据保留原位", e));
            return;
        }
    }

    let mut all_ok = true;

    // 2. todos → todo.db
    all_ok &= migrate_table(
        core_conn,
        registry,
        "todo",
        "todos",
        "id, content, remind_at, repeat_rule, completed, raw_input, created_at, notified",
        |target| {
            target.execute_batch(
                "CREATE TABLE IF NOT EXISTS todos (
                    id          TEXT PRIMARY KEY,
                    content     TEXT NOT NULL,
                    remind_at   TEXT,
                    repeat_rule TEXT,
                    completed   INTEGER NOT NULL DEFAULT 0,
                    raw_input   TEXT,
                    created_at  INTEGER NOT NULL,
                    notified    INTEGER NOT NULL DEFAULT 0
                )",
            )
        },
    );

    // 3. app_shortcuts → apps.db
    all_ok &= migrate_table(
        core_conn,
        registry,
        "apps",
        "app_shortcuts",
        "id, name, path, created_at",
        |target| {
            target.execute_batch(
                "CREATE TABLE IF NOT EXISTS app_shortcuts (
                    id          TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    path        TEXT NOT NULL,
                    created_at  INTEGER NOT NULL
                )",
            )
        },
    );

    // 4. note_index / note_fts → notes.db（FTS 外部内容表需 rebuild）
    all_ok &= migrate_notes(core_conn, registry);

    // 5. 设置键前缀改写：popup_auto_close_secs → todo.popup_auto_close_secs
    if let Err(e) = rewrite_setting_key(core_conn, "popup_auto_close_secs", "todo.popup_auto_close_secs") {
        log_lifecycle(&format!("migration: 设置键改写失败: {}", e));
        all_ok = false;
    }

    // 6. apps.db 预置种子（迁移后仍为空才播种，如全新安装）
    if let Ok(conn) = registry.cached("apps") {
        if let Ok(conn) = conn.lock() {
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM app_shortcuts", [], |r| r.get(0))
                .unwrap_or(0);
            if count == 0 {
                let now = chrono::Utc::now().timestamp();
                for (name, path) in default_apps() {
                    let id = uuid::Uuid::new_v4().to_string();
                    let _ = conn.execute(
                        "INSERT INTO app_shortcuts (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
                        params![id, name, path, now],
                    );
                }
                log_lifecycle("migration: 已播种预置应用到 apps.db");
            }
        }
    }

    // 7. 收尾
    if all_ok {
        let _ = core_conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, 'done')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![MARKER_KEY],
        );
        log_lifecycle("migration: 迁移完成（旧表已清空，数据在插件独立库）");
    } else {
        log_lifecycle("migration: 部分失败——保留备份文件，核心库旧数据未删除，可重试");
    }
}

/// 确保各插件库 schema 存在（全新安装/已迁移场景）
fn ensure_plugin_schemas(registry: &PluginDbRegistry) {
    let schemas: &[(&str, &str)] = &[
        (
            "todo",
            "CREATE TABLE IF NOT EXISTS todos (
                id          TEXT PRIMARY KEY,
                content     TEXT NOT NULL,
                remind_at   TEXT,
                repeat_rule TEXT,
                completed   INTEGER NOT NULL DEFAULT 0,
                raw_input   TEXT,
                created_at  INTEGER NOT NULL,
                notified    INTEGER NOT NULL DEFAULT 0
            )",
        ),
        (
            "apps",
            "CREATE TABLE IF NOT EXISTS app_shortcuts (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                path        TEXT NOT NULL,
                created_at  INTEGER NOT NULL
            )",
        ),
        (
            "notes",
            "CREATE TABLE IF NOT EXISTS note_index (
                path        TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                mtime       INTEGER NOT NULL,
                snippet     TEXT,
                tags        TEXT
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
                title, snippet,
                content='note_index',
                content_rowid='rowid'
            )",
        ),
    ];
    for (plugin_id, ddl) in schemas {
        if let Ok(conn) = registry.cached(plugin_id) {
            if let Ok(conn) = conn.lock() {
                if let Err(e) = conn.execute_batch(ddl) {
                    log_lifecycle(&format!("migration: {} schema 建表失败: {}", plugin_id, e));
                }
            }
        }
    }
}

/// 通用单表搬迁：核心库 → 插件库，列集相同；成功后删除核心库旧行
fn migrate_table(
    core: &rusqlite::Connection,
    registry: &PluginDbRegistry,
    plugin_id: &str,
    table: &str,
    columns: &str,
    ensure_schema: impl Fn(&rusqlite::Connection) -> rusqlite::Result<()>,
) -> bool {
    let result = (|| -> Result<(), String> {
        let source_count: i64 = core
            .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
            .map_err(|e| format!("读取源表 {} 失败: {}", table, e))?;
        if source_count == 0 {
            log_lifecycle(&format!("migration: {} 无数据，跳过", table));
            // 仍确保目标 schema 存在
            let target_conn = registry
                .cached(plugin_id)
                .map_err(|e| e)?;
            let target = target_conn.lock().map_err(|_| "目标库锁不可用".to_string())?;
            ensure_schema(&target).map_err(|e| format!("建表失败: {}", e))?;
            return Ok(());
        }

        let target_conn = registry.cached(plugin_id).map_err(|e| e)?;
        let target = target_conn.lock().map_err(|_| "目标库锁不可用".to_string())?;
        ensure_schema(&target).map_err(|e| format!("建表失败: {}", e))?;

        let col_list: Vec<&str> = columns.split(", ").collect();
        let placeholders: Vec<String> = (1..=col_list.len()).map(|i| format!("?{}", i)).collect();
        let insert_sql = format!(
            "INSERT OR REPLACE INTO {} ({}) VALUES ({})",
            table,
            columns,
            placeholders.join(", ")
        );

        let tx = core.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut stmt = tx
            .prepare(&format!("SELECT {} FROM {}", columns, table))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let mut vals = Vec::with_capacity(col_list.len());
                for i in 0..col_list.len() {
                    let v: rusqlite::types::Value = row.get(i)?;
                    vals.push(v);
                }
                Ok(vals)
            })
            .map_err(|e| e.to_string())?;

        let mut copied = 0i64;
        for row in rows {
            let vals = row.map_err(|e| e.to_string())?;
            target
                .execute(&insert_sql, rusqlite::params_from_iter(vals))
                .map_err(|e| format!("写入 {}.{} 失败: {}", plugin_id, table, e))?;
            copied += 1;
        }
        drop(stmt);

        if copied != source_count {
            return Err(format!(
                "{} 行数不一致（源 {}，已复制 {}），中止删除",
                table, source_count, copied
            ));
        }
        tx.execute(&format!("DELETE FROM {}", table), [])
            .map_err(|e| format!("清理源表失败: {}", e))?;
        tx.commit().map_err(|e| e.to_string())?;
        log_lifecycle(&format!(
            "migration: {} 已迁移 {} 行 → {} 库",
            table, copied, plugin_id
        ));
        Ok(())
    })();

    match result {
        Ok(()) => true,
        Err(e) => {
            log_lifecycle(&format!("migration: {} 迁移失败: {}", table, e));
            false
        }
    }
}

/// 笔记搬迁：note_index 行复制 + note_fts 全量重建（外部内容表）
fn migrate_notes(core: &rusqlite::Connection, registry: &PluginDbRegistry) -> bool {
    let has_index = core
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='note_index'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if !has_index {
        ensure_plugin_schemas(registry);
        return true;
    }

    let result = (|| -> Result<(), String> {
        let target_conn = registry.cached("notes").map_err(|e| e)?;
        let target = target_conn.lock().map_err(|_| "目标库锁不可用".to_string())?;
        target.execute_batch(
            "CREATE TABLE IF NOT EXISTS note_index (
                path        TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                mtime       INTEGER NOT NULL,
                snippet     TEXT,
                tags        TEXT
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
                title, snippet,
                content='note_index',
                content_rowid='rowid'
            )",
        )
        .map_err(|e| format!("notes schema 建表失败: {}", e))?;

        let source_count: i64 = core
            .query_row("SELECT COUNT(*) FROM note_index", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        if source_count > 0 {
            let tx = core.unchecked_transaction().map_err(|e| e.to_string())?;
            let mut stmt = tx
                .prepare("SELECT path, title, mtime, snippet, tags FROM note_index")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })
                .map_err(|e| e.to_string())?;

            let mut copied = 0i64;
            for row in rows {
                let (path, title, mtime, snippet, tags) = row.map_err(|e| e.to_string())?;
                target
                    .execute(
                        "INSERT OR REPLACE INTO note_index (path, title, mtime, snippet, tags)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![path, title, mtime, snippet, tags],
                    )
                    .map_err(|e| format!("写入 note_index 失败: {}", e))?;
                copied += 1;
            }
            drop(stmt);

            if copied != source_count {
                return Err(format!("note_index 行数不一致（源 {}，已复制 {}）", source_count, copied));
            }
            tx.execute("DELETE FROM note_index", [])
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            log_lifecycle(&format!("migration: note_index 已迁移 {} 行 → notes 库", copied));
        }

        // FTS 索引重建（目标库），并清理核心库残留索引
        target
            .execute("INSERT INTO note_fts(note_fts) VALUES('rebuild')", [])
            .map_err(|e| format!("FTS 重建失败: {}", e))?;
        let _ = core.execute("INSERT INTO note_fts(note_fts) VALUES('rebuild')", []);
        Ok(())
    })();

    match result {
        Ok(()) => true,
        Err(e) => {
            log_lifecycle(&format!("migration: notes 迁移失败: {}", e));
            false
        }
    }
}

/// 设置键前缀改写（仅当新键不存在时）
fn rewrite_setting_key(
    core: &rusqlite::Connection,
    old_key: &str,
    new_key: &str,
) -> Result<(), String> {
    let old_value: Option<String> = core
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![old_key],
            |r| r.get(0),
        )
        .ok();
    if let Some(value) = old_value {
        let exists: i64 = core
            .query_row(
                "SELECT COUNT(*) FROM app_settings WHERE key = ?1",
                params![new_key],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if exists == 0 {
            core.execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2)",
                params![new_key, value],
            )
            .map_err(|e| e.to_string())?;
            log_lifecycle(&format!("migration: 设置键 {} → {}", old_key, new_key));
        }
    }
    Ok(())
}
