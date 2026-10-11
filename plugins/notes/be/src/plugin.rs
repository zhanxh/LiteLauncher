//! NotesPlugin：/note 指令后端实现

use crate::notes_dir::get_notes_dir;
use ll_plugin_api::{PluginBackend, PluginContext, PluginError, PluginManifest};
use serde_json::{json, Value as JsonValue};
use std::fs;
use std::sync::{Arc, Mutex};

pub struct NotesPlugin {
    ctx: Mutex<Option<PluginContext>>,
}

impl NotesPlugin {
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

    /// 增量同步磁盘 Markdown 到索引（DbApi JSON 通道实现，替代原裸 Connection 版本）
    fn synced_db(ctx: &PluginContext) -> Result<(), PluginError> {
        let db = Self::need_db(ctx)?;
        let rows = db.query("SELECT path, mtime FROM note_index", &[])?;
        let indexed: std::collections::HashMap<String, i64> = rows
            .iter()
            .filter_map(|r| {
                Some((
                    r.get("path")?.as_str()?.to_string(),
                    r.get("mtime")?.as_i64()?,
                ))
            })
            .collect();

        let notes_dir = get_notes_dir();
        let entries = match fs::read_dir(&notes_dir) {
            Ok(e) => e,
            Err(_) => return Ok(()),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !path.extension().map_or(false, |ext| ext == "md") {
                continue;
            }
            let mtime = fs::metadata(&path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let path_str = path.to_string_lossy().to_string();
            if indexed.get(&path_str) == Some(&mtime) {
                continue;
            }

            let content = fs::read_to_string(&path).unwrap_or_default();
            let mut title = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "未命名笔记".into());
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("# ") {
                    title = trimmed.trim_start_matches("# ").trim().to_string();
                    break;
                }
            }
            let clean_text = content
                .replace('#', "")
                .replace('*', "")
                .replace('`', "")
                .replace('\r', " ")
                .replace('\n', " ");
            let snippet: String = clean_text.chars().take(300).collect();

            db.execute(
                "INSERT INTO note_index (path, title, mtime, snippet, tags)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(path) DO UPDATE SET
                    title = excluded.title,
                    mtime = excluded.mtime,
                    snippet = excluded.snippet",
                &[
                    json!(path_str),
                    json!(title),
                    json!(mtime),
                    json!(snippet),
                    json!("[]"),
                ],
            )?;
            db.execute("DELETE FROM note_fts WHERE title = ?1", &[json!(title)])?;
            db.execute(
                "INSERT INTO note_fts (title, snippet) VALUES (?1, ?2)",
                &[json!(title), json!(snippet)],
            )?;
        }
        Ok(())
    }

    fn search(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let filter = get_str(params, "keyword")
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        self.with_ctx(|ctx| {
            Self::synced_db(ctx)?;
            let db = Self::need_db(ctx)?;
            let rows = if filter.is_empty() {
                db.query(
                    "SELECT path, title, mtime, snippet, tags FROM note_index ORDER BY mtime DESC",
                    &[],
                )?
            } else {
                let like = format!("%{}%", filter);
                db.query(
                    "SELECT path, title, mtime, snippet, tags FROM note_index
                     WHERE LOWER(title) LIKE ?1 OR LOWER(snippet) LIKE ?1
                     ORDER BY mtime DESC",
                    &[json!(like)],
                )?
            };
            Ok(JsonValue::Array(rows))
        })
    }

    fn read(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let path = get_str(params, "path")
            .ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        if path.contains("..") {
            return Err(PluginError::bad_params("非法的文件访问路径"));
        }
        let p = std::path::Path::new(&path);
        if !p.exists() || !p.is_file() {
            return Err(PluginError::bad_params("文件不存在或非普通文本文件"));
        }
        let content = fs::read_to_string(p)
            .map_err(|e| PluginError::internal(format!("读取文件失败: {}", e)))?;
        Ok(json!(content))
    }

    fn save(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let path = get_str(params, "path")
            .ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        let content = get_str(params, "content").unwrap_or_default();
        if path.contains("..") {
            return Err(PluginError::bad_params("非法的文件写入路径"));
        }
        fs::write(&path, &content)
            .map_err(|e| PluginError::internal(format!("写入文件失败: {}", e)))?;

        self.with_ctx(|ctx| {
            Self::synced_db(ctx)?;
            Ok(JsonValue::Null)
        })
    }

    fn open_editor(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let path = get_str(params, "path")
            .ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        let title = get_str(params, "title").unwrap_or_else(|| "未命名笔记".into());
        self.with_ctx(|ctx| {
            let windows = ctx
                .windows
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("windows"))?;
            windows.open(
                "editor",
                &[
                    ("path".to_string(), path),
                    ("title".to_string(), title),
                ],
            )?;
            Ok(JsonValue::Null)
        })
    }
}

impl Default for NotesPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginBackend for NotesPlugin {
    /// manifest 单一来源：本 crate 目录上层的 manifest.json
    fn manifest(&self) -> PluginManifest {
        static MANIFEST: std::sync::OnceLock<PluginManifest> = std::sync::OnceLock::new();
        MANIFEST
            .get_or_init(|| {
                serde_json::from_str(include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../manifest.json"
                )))
                .expect("plugins/notes/manifest.json 解析失败")
            })
            .clone()
    }

fn init(&self, ctx: PluginContext) -> Result<(), PluginError> {
        // 自检 + 首次初始化笔记目录（种子欢迎笔记）
        {
            let db = Self::need_db(&ctx)?;
            db.migrate(&["
                CREATE TABLE IF NOT EXISTS note_index (
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
                )
            "])?;
            let _ = get_notes_dir();
        }
        *self
            .ctx
            .lock()
            .map_err(|_| PluginError::internal("插件状态锁不可用"))? = Some(ctx);
        Ok(())
    }

    fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, PluginError> {
        match method {
            "search" => self.search(&params),
            "read" => self.read(&params),
            "save" => self.save(&params),
            "open_editor" => self.open_editor(&params),
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
