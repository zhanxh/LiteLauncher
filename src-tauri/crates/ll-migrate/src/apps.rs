//! `apps.db` schema v2：应用目录（自动收录 + 拼音检索 + 使用频次）
//!
//! 迁移原则：**只加列、不改旧列**，v1 数据升上来后仍能直接被旧查询读到；
//! 版本进度写在 `PRAGMA user_version`，每一步都幂等，失败可安全重跑。

use rusqlite::Connection;

/// v2 新增列（列名, 列定义）
pub const V2_COLUMNS: &[(&str, &str)] = &[
    ("source", "TEXT NOT NULL DEFAULT 'manual'"),
    ("pinyin", "TEXT NOT NULL DEFAULT ''"),
    ("initials", "TEXT NOT NULL DEFAULT ''"),
    ("launch_count", "INTEGER NOT NULL DEFAULT 0"),
    ("last_used_at", "INTEGER"),
    ("hidden", "INTEGER NOT NULL DEFAULT 0"),
    // 最近一次被扫描到的时间：用它做"消失条目只隐藏不删除"的判据，
    // 避免 `path NOT IN (...)` 在应用数超过 SQLite 变量上限时失效
    ("last_seen_at", "INTEGER"),
];

/// 当前 schema 版本
pub const SCHEMA_VERSION: i64 = 2;

/// 把 apps.db 升到 v2（幂等）
pub fn migrate_v2(conn: &Connection) -> rusqlite::Result<()> {
    // 1. 历史数据去重：同一 path 保留最早一行，否则唯一索引建不起来。
    //    v1 的 add() 已挡重复，这里只兜底更早的数据。
    conn.execute(
        "DELETE FROM app_shortcuts
         WHERE rowid NOT IN (SELECT MIN(rowid) FROM app_shortcuts GROUP BY path)",
        [],
    )?;

    // 2. 逐列补齐（已存在则跳过）
    for (column, ddl) in V2_COLUMNS {
        add_column_if_missing(conn, "app_shortcuts", column, ddl)?;
    }

    // 3. 索引：path 唯一保证导入幂等；rank 索引服务"手动优先 + 频次 + 最近使用"排序
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_app_shortcuts_path ON app_shortcuts(path);
         CREATE INDEX IF NOT EXISTS ix_app_shortcuts_rank
             ON app_shortcuts(source, launch_count DESC, last_used_at DESC);",
    )?;

    // 4. 版本标记最后写：中途失败时下次启动会重跑（各步骤均幂等）
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

/// 列不存在才 ALTER（SQLite 不支持 `ADD COLUMN IF NOT EXISTS`）
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    ddl: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let mut found = false;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            found = true;
            break;
        }
    }
    drop(rows);
    drop(stmt);
    if !found {
        conn.execute_batch(&format!(
            "ALTER TABLE {} ADD COLUMN {} {}",
            table, column, ddl
        ))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v1 结构 + 两条重复 path（模拟历史脏数据）
    fn v1_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("内存库");
        conn.execute_batch(
            "CREATE TABLE app_shortcuts (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                path        TEXT NOT NULL,
                created_at  INTEGER NOT NULL
            );
            INSERT INTO app_shortcuts (id, name, path, created_at) VALUES
                ('a', '微信', 'C:\\WeChat\\WeChat.exe', 1),
                ('b', '微信副本', 'C:\\WeChat\\WeChat.exe', 2),
                ('c', '记事本', 'C:\\Windows\\notepad.exe', 3);",
        )
        .expect("建 v1 表");
        conn
    }

    fn columns(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("PRAGMA table_info(app_shortcuts)")
            .expect("table_info");
        let rows = stmt.query_map([], |r| r.get::<_, String>(1)).expect("读取列名");
        rows.filter_map(Result::ok).collect()
    }

    #[test]
    fn adds_columns_and_dedupes_paths() {
        let conn = v1_conn();
        migrate_v2(&conn).expect("v2 迁移");

        let cols = columns(&conn);
        for (expected, _) in V2_COLUMNS {
            assert!(
                cols.iter().any(|c| c == expected),
                "缺少列 {expected}"
            );
        }

        let same_path: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_shortcuts WHERE path = ?1",
                rusqlite::params!["C:\\WeChat\\WeChat.exe"],
                |r| r.get(0),
            )
            .expect("统计重复 path");
        assert_eq!(same_path, 1, "同一 path 只应保留一行");

        let kept: String = conn
            .query_row(
                "SELECT id FROM app_shortcuts WHERE path = ?1",
                rusqlite::params!["C:\\WeChat\\WeChat.exe"],
                |r| r.get(0),
            )
            .expect("保留行");
        assert_eq!(kept, "a", "应保留最早的一行");

        // 老数据默认归为 manual，绝不能被后续扫描覆盖
        let source: String = conn
            .query_row("SELECT source FROM app_shortcuts WHERE id = 'c'", [], |r| r.get(0))
            .expect("source 默认值");
        assert_eq!(source, "manual");

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .expect("user_version");
        assert_eq!(version, SCHEMA_VERSION);

        let index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'ux_app_shortcuts_path'",
                [],
                |r| r.get(0),
            )
            .expect("唯一索引");
        assert_eq!(index, 1);
    }

    #[test]
    fn is_idempotent() {
        let conn = v1_conn();
        migrate_v2(&conn).expect("第一次迁移");
        migrate_v2(&conn).expect("第二次迁移应直接通过");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_shortcuts", [], |r| r.get(0))
            .expect("统计行数");
        assert_eq!(count, 2, "重复行只应在第一次迁移时被清掉");
    }

    #[test]
    fn add_column_keeps_existing_values() {
        let conn = Connection::open_in_memory().expect("内存库");
        conn.execute_batch(
            "CREATE TABLE t (id TEXT PRIMARY KEY);
             INSERT INTO t (id) VALUES ('x');",
        )
        .expect("建表");

        add_column_if_missing(&conn, "t", "source", "TEXT NOT NULL DEFAULT 'manual'")
            .expect("第一次加列");
        add_column_if_missing(&conn, "t", "source", "TEXT NOT NULL DEFAULT 'manual'")
            .expect("第二次应跳过");

        let source: String = conn
            .query_row("SELECT source FROM t WHERE id = 'x'", [], |r| r.get(0))
            .expect("旧行取默认值");
        assert_eq!(source, "manual");
    }
}
