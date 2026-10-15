//! 集成测试共用的最小宿主替身：真 SQLite + 语句头白名单，其余句柄空实现。
//!
//! 宿主在 ll-host（插件禁止依赖），这里按 `CoreDbApi` 逐条复刻一份门控等价实现，
//! 保证"插件里能跑的 SQL"和"宿主允许的 SQL"不会各说各话。

#![allow(dead_code)]

use ll_plugin_api::{
    DbApi, EventApi, LogApi, PluginBackend, PluginContext, PluginError, SettingsApi,
};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub type Shared = Arc<Mutex<rusqlite::Connection>>;

struct TestDb(Shared);

fn check_sql_head(sql: &str, allowed: &[&str]) -> Result<(), PluginError> {
    let head = sql
        .trim_start()
        .split(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if allowed.contains(&head.as_str()) {
        Ok(())
    } else {
        Err(PluginError::db(format!("SQL 语句类型不允许: {}", head)))
    }
}

fn json_to_sql(v: &JsonValue) -> Result<rusqlite::types::Value, PluginError> {
    use rusqlite::types::Value as Sql;
    Ok(match v {
        JsonValue::Null => Sql::Null,
        JsonValue::Bool(b) => Sql::Integer(if *b { 1 } else { 0 }),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Sql::Integer(i)
            } else if let Some(f) = n.as_f64() {
                Sql::Real(f)
            } else {
                return Err(PluginError::bad_params("数字参数超出可表示范围"));
            }
        }
        JsonValue::String(s) => Sql::Text(s.clone()),
        _ => return Err(PluginError::bad_params("SQL 参数仅支持标量值")),
    })
}

fn sql_to_json(v: rusqlite::types::Value) -> JsonValue {
    use rusqlite::types::Value as Sql;
    match v {
        Sql::Null => JsonValue::Null,
        Sql::Integer(i) => json!(i),
        Sql::Real(f) => json!(f),
        Sql::Text(s) => json!(s),
        Sql::Blob(b) => json!(String::from_utf8_lossy(&b).to_string()),
    }
}

impl DbApi for TestDb {
    fn migrate(&self, statements: &[&str]) -> Result<(), PluginError> {
        let conn = self.0.lock().map_err(|_| PluginError::db("锁"))?;
        for stmt in statements {
            conn.execute_batch(stmt)
                .map_err(|e| PluginError::db(format!("migrate 失败: {}", e)))?;
        }
        Ok(())
    }

    fn execute(&self, sql: &str, params: &[JsonValue]) -> Result<u64, PluginError> {
        check_sql_head(sql, &["insert", "update", "delete", "replace"])?;
        let conn = self.0.lock().map_err(|_| PluginError::db("锁"))?;
        let vals: Vec<rusqlite::types::Value> = params
            .iter()
            .map(json_to_sql)
            .collect::<Result<Vec<_>, _>>()?;
        conn.execute(sql, rusqlite::params_from_iter(vals))
            .map(|n| n as u64)
            .map_err(|e| PluginError::db(format!("执行失败: {}", e)))
    }

    fn query(&self, sql: &str, params: &[JsonValue]) -> Result<Vec<JsonValue>, PluginError> {
        check_sql_head(sql, &["select", "with"])?;
        let conn = self.0.lock().map_err(|_| PluginError::db("锁"))?;
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| PluginError::db(format!("prepare 失败: {}", e)))?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let vals: Vec<rusqlite::types::Value> = params
            .iter()
            .map(json_to_sql)
            .collect::<Result<Vec<_>, _>>()?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(vals), |row| {
                let mut obj = JsonMap::new();
                for (idx, name) in names.iter().enumerate() {
                    let v: rusqlite::types::Value = row.get(idx)?;
                    obj.insert(name.clone(), sql_to_json(v));
                }
                Ok(JsonValue::Object(obj))
            })
            .map_err(|e| PluginError::db(format!("查询失败: {}", e)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| PluginError::db(format!("行读取失败: {}", e)))?);
        }
        Ok(out)
    }
}

#[derive(Default)]
struct TestSettings(Mutex<HashMap<String, String>>);

impl SettingsApi for TestSettings {
    fn get(&self, key: &str) -> Option<String> {
        self.0.lock().unwrap().get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> Result<(), PluginError> {
        self.0.lock().unwrap().insert(key.to_string(), value.to_string());
        Ok(())
    }
}

struct TestLog;
impl LogApi for TestLog {
    fn log(&self, _level: &str, _msg: &str) {}
}

struct TestEvent;
impl EventApi for TestEvent {
    fn emit(&self, _event: &str, _payload: JsonValue) -> Result<(), PluginError> {
        Ok(())
    }
}

/// v1 时代的 todos 表（宿主 migration.rs 搬来的老库就是这个形状）
pub const V1_DDL: &str = "
    CREATE TABLE todos (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, remind_at TEXT, repeat_rule TEXT,
        completed INTEGER NOT NULL DEFAULT 0, raw_input TEXT,
        created_at INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0
    )";

pub fn ctx_with(shared: Shared) -> PluginContext {
    PluginContext {
        db: Some(Arc::new(TestDb(shared))),
        windows: None,
        notify: None,
        process: None,
        secrets: None,
        http: None,
        clipboard: None,
        screen: None,
        shortcuts: None,
        clipboard_history: None,
        events: Arc::new(TestEvent),
        settings: Arc::new(TestSettings::default()),
        log: Arc::new(TestLog),
    }
}

/// 在 8 列老库上跑一次完整 init，返回可直接 `call()` 的插件与共享连接
pub fn upgraded() -> (ll_plugin_todo::TodoPlugin, Shared) {
    let shared: Shared = Arc::new(Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
    shared.lock().unwrap().execute_batch(V1_DDL).unwrap();
    let plugin = ll_plugin_todo::TodoPlugin::new();
    plugin.init(ctx_with(Arc::clone(&shared))).unwrap();
    (plugin, shared)
}

pub fn cols(conn: &rusqlite::Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info('todos')")
        .unwrap();
    let mut v: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    v.sort();
    v
}

pub fn count(conn: &rusqlite::Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
        .unwrap()
}
