//! App 插件（LPS-1 内置插件）：/app 指令后端
//!
//! 吸收原 app_launcher.rs（快捷列表/添加/启动）与 system_apps.rs（系统应用扫描，
//! 位于同级 apps_system 模块）的全部逻辑。应用启动经 ctx.process 受控进程服务
//! （平台策略与注入校验由宿主实现），不直接持有 std::process。

use std::sync::Arc;

mod system;

use crate::system::{search_system_apps, DEFAULT_LIMIT};
use ll_plugin_api::{PluginBackend, PluginContext, PluginError, PluginManifest};
use serde_json::{json, Value as JsonValue};
use std::collections::HashSet;
use std::sync::Mutex;

pub struct AppsPlugin {
    ctx: Mutex<Option<PluginContext>>,
}

impl AppsPlugin {
    pub fn new() -> Self {
        Self { ctx: Mutex::new(None) }
    }

    fn with_ctx<R>(
        &self,
        f: impl FnOnce(&PluginContext) -> Result<R, PluginError>,
    ) -> Result<R, PluginError> {
        let guard = self
            .ctx
            .lock()
            .map_err(|_| PluginError::internal("插件状态锁不可用"))?;
        let ctx = guard
            .as_ref()
            .ok_or_else(|| PluginError::internal("插件尚未初始化"))?;
        f(ctx)
    }

    fn need_db(ctx: &PluginContext) -> Result<Arc<dyn ll_plugin_api::DbApi>, PluginError> {
        ctx.db
            .clone()
            .ok_or_else(|| PluginError::permission_denied("db"))
    }

    fn saved_paths(ctx: &PluginContext) -> Result<HashSet<String>, PluginError> {
        let db = Self::need_db(ctx)?;
        let rows = db.query("SELECT path FROM app_shortcuts", &[])?;
        Ok(rows
            .iter()
            .filter_map(|r| r.get("path").and_then(|v| v.as_str()).map(String::from))
            .collect())
    }

    // ───────────────────────────── 方法实现 ─────────────────────────────

    fn list(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let filter = get_str(params, "keyword")
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let sql = if filter.is_empty() {
                "SELECT id, name, path FROM app_shortcuts ORDER BY created_at ASC".to_string()
            } else {
                "SELECT id, name, path FROM app_shortcuts
                 WHERE LOWER(name) LIKE ?1 OR LOWER(path) LIKE ?1 ORDER BY created_at ASC"
                    .to_string()
            };
            let like = format!("%{}%", filter);
            let rows = db.query(&sql, &[json!(like)])?;
            Ok(JsonValue::Array(
                rows.iter()
                    .map(|r| {
                        let name = r.get("name").and_then(|v| v.as_str()).unwrap_or_default();
                        let path = r.get("path").and_then(|v| v.as_str()).unwrap_or_default();
                        json!({
                            "id": r.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
                            "name": name,
                            "path": path,
                            "icon": "🚀",
                            "description": format!("可执行程序: {}", path),
                        })
                    })
                    .collect(),
            ))
        })
    }

    fn add(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let name = get_str(params, "name")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| PluginError::bad_params("缺少参数 name"))?;
        let path = get_str(params, "path")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;

        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            // 同一路径只允许添加一次，避免候选列表重复点击造成冗余条目
            let exists: i64 = db
                .query(
                    "SELECT COUNT(*) AS n FROM app_shortcuts WHERE path = ?1",
                    &[json!(path)],
                )?
                .first()
                .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
                .unwrap_or(0);
            if exists > 0 {
                return Err(PluginError::bad_params(format!("\"{}\" 已在应用列表中", name)));
            }

            let id = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now().timestamp();
            db.execute(
                "INSERT INTO app_shortcuts (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
                &[json!(id), json!(name), json!(path), json!(now)],
            )?;
            Ok(json!({
                "id": id,
                "name": name,
                "path": path,
                "icon": "🚀",
                "description": format!("可执行程序: {}", path),
            }))
        })
    }

    fn search_system(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let keyword = get_str(params, "keyword");
        let limit = params.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
        self.with_ctx(|ctx| {
            let saved = Self::saved_paths(ctx)?;
            let items = search_system_apps(keyword, limit.or(Some(DEFAULT_LIMIT)), &saved);
            Ok(json!(items))
        })
    }

    fn launch(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let path = get_str(params, "path")
            .ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        self.with_ctx(|ctx| {
            let process = ctx
                .process
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("process"))?;
            process.launch(&path)?;
            Ok(JsonValue::Null)
        })
    }
}

impl Default for AppsPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginBackend for AppsPlugin {
    /// manifest 单一来源：本 crate 目录上层的 manifest.json
    fn manifest(&self) -> PluginManifest {
        static MANIFEST: std::sync::OnceLock<PluginManifest> = std::sync::OnceLock::new();
        MANIFEST
            .get_or_init(|| {
                serde_json::from_str(include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../manifest.json"
                )))
                .expect("plugins/apps/manifest.json 解析失败")
            })
            .clone()
    }

fn init(&self, ctx: PluginContext) -> Result<(), PluginError> {
        // 自检：确认快捷表可访问（schema 由宿主迁移器保证）
        {
            let db = Self::need_db(&ctx)?;
            db.query("SELECT COUNT(*) FROM app_shortcuts", &[])?;
        }
        *self
            .ctx
            .lock()
            .map_err(|_| PluginError::internal("插件状态锁不可用"))? = Some(ctx);
        Ok(())
    }

    fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, PluginError> {
        match method {
            "list" => self.list(&params),
            "add" => self.add(&params),
            "search_system" => self.search_system(&params),
            "launch" => self.launch(&params),
            _ => Err(PluginError::unknown_method(method)),
        }
    }
}

fn get_str(params: &JsonValue, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

