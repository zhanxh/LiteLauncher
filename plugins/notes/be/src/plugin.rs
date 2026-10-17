//! NotesPlugin：/note 指令后端实现

use crate::notes_dir::get_notes_dir;
use ll_plugin_api::{PluginBackend, PluginContext, PluginError, PluginManifest};
use regex::Regex;
use serde_json::{json, Value as JsonValue};
use std::fs;
use std::path::{Path, PathBuf};
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
    /// 管理面板引入子目录后：递归扫描 + 清理已不存在的旧索引行（改名/移动/删除后不残留）
    fn synced_db(ctx: &PluginContext) -> Result<(), PluginError> {
        let db = Self::need_db(ctx)?;

        // 1. 先清理失效行：FTS 为外挂内容表，必须先删 FTS 再删主表，否则内容不同步
        let rows = db.query("SELECT path FROM note_index", &[])?;
        for r in &rows {
            let Some(path) = r.get("path").and_then(|v| v.as_str()) else {
                continue;
            };
            if !Path::new(path).exists() {
                db.execute(
                    "DELETE FROM note_fts WHERE rowid IN (SELECT rowid FROM note_index WHERE path = ?1)",
                    &[json!(path)],
                )?;
                db.execute("DELETE FROM note_index WHERE path = ?1", &[json!(path)])?;
            }
        }

        // 2. 递归扫描磁盘上的 Markdown，mtime 变化才重建该行（清理后重拉一次快照）
        let notes_dir = get_notes_dir();
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
        for path in walk_md_files(&notes_dir) {
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
            // 外挂内容 FTS：先按 path 定位旧行删除，再插入新值（按 title 删会误伤同名标题）
            db.execute(
                "DELETE FROM note_fts WHERE rowid IN (SELECT rowid FROM note_index WHERE path = ?1)",
                &[json!(path_str)],
            )?;
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
        // 与其余文件操作同一把尺：路径必须落在笔记根内（防 ../ 与越权绝对路径）
        let p = ensure_inside_notes_root(&path)?;
        if !p.is_file() {
            return Err(PluginError::bad_params("文件不存在或非普通文本文件"));
        }
        let content = fs::read_to_string(&p)
            .map_err(|e| PluginError::internal(format!("读取文件失败: {}", e)))?;
        Ok(json!(content))
    }

    fn save(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let path = get_str(params, "path")
            .ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        let content = get_str(params, "content").unwrap_or_default();
        // 写路径同样必须落在笔记根内
        let p = ensure_inside_notes_root(&path)?;
        if p.is_dir() {
            return Err(PluginError::bad_params("目标是文件夹，不能写入"));
        }
        fs::write(&p, &content)
            .map_err(|e| PluginError::internal(format!("写入文件失败: {}", e)))?;

        self.with_ctx(|ctx| {
            Self::synced_db(ctx)?;
            Ok(JsonValue::Null)
        })
    }

    /// 新建 Markdown 笔记（/note new [标题]；管理面板可带 parent 在子目录内创建）
    /// 文件名清洗非法字符；同名不覆盖，自动追加序号；写入 `# 标题` 模板并同步索引
    fn create(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let title = sanitize_title(&get_str(params, "title").unwrap_or_default());
        let title = if title.is_empty() {
            "未命名笔记".to_string()
        } else {
            title
        };

        let parent = resolve_parent_dir(params)?;
        let mut file_name = format!("{}.md", title);
        let mut seq = 2;
        while parent.join(&file_name).exists() {
            file_name = format!("{} ({}).md", title, seq);
            seq += 1;
        }
        let path = parent.join(&file_name);
        fs::write(&path, format!("# {}\n\n", title))
            .map_err(|e| PluginError::internal(format!("创建笔记失败: {}", e)))?;

        // 立即入索引，下次 /note 搜索可见
        self.with_ctx(|ctx| Self::synced_db(ctx))?;

        Ok(json!({
            "path": path.to_string_lossy(),
            "title": title,
        }))
    }

    /// 新建文件夹（管理面板）：parent 为笔记根内的目录，name 自动避让同名
    fn create_dir(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let name = sanitize_title(&get_str(params, "name").unwrap_or_default());
        if name.is_empty() {
            return Err(PluginError::bad_params("文件夹名不能为空"));
        }
        let parent = resolve_parent_dir(params)?;
        let mut target = parent.join(&name);
        let mut seq = 2;
        while target.exists() {
            target = parent.join(format!("{} ({})", name, seq));
            seq += 1;
        }
        fs::create_dir_all(&target)
            .map_err(|e| PluginError::internal(format!("创建文件夹失败: {}", e)))?;
        Ok(json!({
            "path": target.to_string_lossy(),
            "name": target.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
        }))
    }

    /// 重命名（管理面板右键）：文件/文件夹均可，目标名清洗非法字符
    fn rename(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let raw = get_str(params, "path").ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        let old = ensure_inside_notes_root(&raw)?;
        if old == notes_root_plain()? {
            return Err(PluginError::bad_params("不能重命名笔记根目录"));
        }
        let name = sanitize_title(&get_str(params, "new_name").unwrap_or_default());
        if name.is_empty() {
            return Err(PluginError::bad_params("名称不能为空"));
        }
        let parent = old
            .parent()
            .ok_or_else(|| PluginError::bad_params("路径缺少父目录"))?
            .to_path_buf();
        let new_path = parent.join(&name);
        // 仅大小写变化（a.md → A.md）在大小写不敏感的文件系统上 exists() 也为真，
        // 属于合法改名，不能按重名拒绝
        let case_only_change = old
            .file_name()
            .map(|n| n.to_string_lossy().eq_ignore_ascii_case(&name))
            .unwrap_or(false);
        if !case_only_change && new_path.exists() {
            return Err(PluginError::bad_params("同名文件/文件夹已存在"));
        }
        fs::rename(&old, &new_path)
            .map_err(|e| PluginError::internal(format!("重命名失败: {}", e)))?;
        self.with_ctx(|ctx| Self::synced_db(ctx))?;
        Ok(json!({
            "path": new_path.to_string_lossy(),
            "name": name,
        }))
    }

    /// 移动（管理面板右键）：把文件/文件夹移入另一目录，同名自动避让，禁止移入自身或其后代
    fn move_entry(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let raw = get_str(params, "path").ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        let from = ensure_inside_notes_root(&raw)?;
        if from == notes_root_plain()? {
            return Err(PluginError::bad_params("不能移动笔记根目录"));
        }
        let target_raw =
            get_str(params, "target_dir").ok_or_else(|| PluginError::bad_params("缺少参数 target_dir"))?;
        let target_dir = ensure_dir_inside_notes_root(&target_raw)?;
        if target_dir.starts_with(&from) {
            return Err(PluginError::bad_params("不能把目录移入自身或其子目录"));
        }
        let name = from
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or_else(|| PluginError::bad_params("路径缺少名称"))?;
        let mut dest = target_dir.join(&name);
        // 目标目录就是当前父目录：无操作（否则会命中下面的重名避让被改名成 "名 (2)"）
        if dest == from {
            return Ok(json!({
                "path": from.to_string_lossy(),
                "name": name,
            }));
        }
        let mut seq = 2;
        while dest.exists() {
            let stem = Path::new(&name)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| name.clone());
            let ext = Path::new(&name)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            dest = target_dir.join(format!("{} ({}){}", stem, seq, ext));
            seq += 1;
        }
        fs::rename(&from, &dest)
            .map_err(|e| PluginError::internal(format!("移动失败: {}", e)))?;
        self.with_ctx(|ctx| Self::synced_db(ctx))?;
        Ok(json!({
            "path": dest.to_string_lossy(),
            "name": dest.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
        }))
    }

    /// 删除（管理面板右键）：文件直接删，文件夹递归删；根目录不可删
    fn delete(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let raw = get_str(params, "path").ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        let target = ensure_inside_notes_root(&raw)?;
        if target == notes_root_plain()? {
            return Err(PluginError::bad_params("不能删除笔记根目录"));
        }
        if target.is_dir() {
            fs::remove_dir_all(&target)
                .map_err(|e| PluginError::internal(format!("删除文件夹失败: {}", e)))?;
        } else {
            fs::remove_file(&target)
                .map_err(|e| PluginError::internal(format!("删除文件失败: {}", e)))?;
        }
        self.with_ctx(|ctx| Self::synced_db(ctx))?;
        Ok(JsonValue::Null)
    }

    /// 在系统中打开：交系统默认程序（文件）或资源管理器（文件夹）
    fn open_in_system(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let raw = get_str(params, "path").ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        let target = ensure_inside_notes_root(&raw)?;
        self.with_ctx(|ctx| {
            let process = ctx
                .process
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("process"))?;
            process.launch(&target.to_string_lossy())?;
            Ok(JsonValue::Null)
        })
    }

    /// 在系统中显示：资源管理器定位并选中该文件/文件夹
    fn reveal_in_system(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let raw = get_str(params, "path").ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        let target = ensure_inside_notes_root(&raw)?;
        self.with_ctx(|ctx| {
            let process = ctx
                .process
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("process"))?;
            process.reveal(&target.to_string_lossy())?;
            Ok(JsonValue::Null)
        })
    }

    /// 内容搜索（管理面板搜索窗）：大小写/全字/正则开关 + 包含/排除 glob，
    /// 按文件分组返回命中行（行号 + 行文本），带总量与截断标记
    fn search_files(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let query = get_str(params, "query").unwrap_or_default().trim().to_string();
        if query.is_empty() {
            return Ok(json!({ "root": get_notes_dir().to_string_lossy(), "files": [], "total": 0, "truncated": false }));
        }
        let case_sensitive = params.get("case_sensitive").and_then(|v| v.as_bool()).unwrap_or(false);
        let whole_word = params.get("whole_word").and_then(|v| v.as_bool()).unwrap_or(false);
        let is_regex = params.get("is_regex").and_then(|v| v.as_bool()).unwrap_or(false);
        let re = build_search_regex(&query, case_sensitive, whole_word, is_regex)
            .map_err(|e| PluginError::bad_params(e))?;

        let include = parse_glob_patterns(&get_str(params, "include").unwrap_or_default())
            .map_err(PluginError::bad_params)?;
        let exclude = parse_glob_patterns(&get_str(params, "exclude").unwrap_or_default())
            .map_err(PluginError::bad_params)?;
        let root = notes_root_plain()?;

        // 上限：单文件 50 行命中 / 全部 200 个文件 / 500 行命中，防大笔记目录拖爆前端
        const MAX_MATCHES_PER_FILE: usize = 50;
        const MAX_FILES: usize = 200;
        const MAX_TOTAL: usize = 500;
        const MAX_LINE_CHARS: usize = 300;

        let mut files: Vec<JsonValue> = Vec::new();
        let mut total: usize = 0;
        let mut truncated = false;

        for path in walk_all_files(&root) {
            if files.len() >= MAX_FILES || total >= MAX_TOTAL {
                truncated = true;
                break;
            }
            let rel = match path.strip_prefix(&root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if !include.is_empty() && !include.iter().any(|g| g.is_match(&rel)) {
                continue;
            }
            if exclude.iter().any(|g| g.is_match(&rel)) {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue; // 二进制或不可读文件跳过
            };
            let mut matches: Vec<JsonValue> = Vec::new();
            for (idx, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    let text: String = line.chars().take(MAX_LINE_CHARS).collect();
                    matches.push(json!({ "line": idx + 1, "text": text }));
                    total += 1;
                    if matches.len() >= MAX_MATCHES_PER_FILE || total >= MAX_TOTAL {
                        truncated = true;
                        break;
                    }
                }
            }
            if !matches.is_empty() {
                files.push(json!({
                    "path": path.to_string_lossy(),
                    "rel": rel,
                    "name": path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
                    "matches": matches,
                }));
            }
        }

        files.sort_by(|a, b| {
            let ka = a.get("rel").and_then(|v| v.as_str()).unwrap_or_default().to_lowercase();
            let kb = b.get("rel").and_then(|v| v.as_str()).unwrap_or_default().to_lowercase();
            ka.cmp(&kb)
        });

        Ok(json!({
            "root": root.to_string_lossy(),
            "files": files,
            "total": total,
            "truncated": truncated,
        }))
    }

    /// 目录树（管理面板左栏）：递归列出笔记根目录，文件夹在前、文件在后
    fn tree(&self, _params: &JsonValue) -> Result<JsonValue, PluginError> {
        let root = get_notes_dir();
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "LiteNotes".into());
        let children = scan_children(&root, "");
        Ok(json!({
            "name": name,
            "path": root.to_string_lossy(),
            "rel": "",
            "kind": "dir",
            "children": children,
        }))
    }

    /// 打开笔记本管理面板窗口（/note app）
    fn open_manager(&self, _params: &JsonValue) -> Result<JsonValue, PluginError> {
        self.with_ctx(|ctx| {
            let windows = ctx
                .windows
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("windows"))?;
            windows.open("manager", &[])?;
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
            "create" => self.create(&params),
            "open_editor" => self.open_editor(&params),
            "open_manager" => self.open_manager(&params),
            "tree" => self.tree(&params),
            "create_dir" => self.create_dir(&params),
            "rename" => self.rename(&params),
            "move_entry" => self.move_entry(&params),
            "delete" => self.delete(&params),
            "open_in_system" => self.open_in_system(&params),
            "reveal_in_system" => self.reveal_in_system(&params),
            "search_files" => self.search_files(&params),
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

// ── 管理面板路径与扫描辅助 ────────────────────────────────────────────────

/// Windows canonicalize 会返回 \\?\ 前缀的 verbatim 路径，展示/索引/前端都不该看到它；
/// 仅在包含性校验的瞬间使用 verbatim，对外一律剥回普通绝对路径
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.as_os_str().to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", rest))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// 笔记根目录的规范路径（verbatim，仅用于 starts_with 包含性校验）
fn ensure_root_canonical() -> Result<PathBuf, PluginError> {
    get_notes_dir()
        .canonicalize()
        .map_err(|e| PluginError::internal(format!("笔记目录不可用: {}", e)))
}

/// 笔记根目录的干净绝对路径（无 \\?\ 前缀），供根目录守卫比对与相对路径拆分
fn notes_root_plain() -> Result<PathBuf, PluginError> {
    Ok(strip_verbatim(&ensure_root_canonical()?))
}

/// 规范化并校验路径必须位于笔记根目录内（防 ../ 与任意路径越权），返回干净绝对路径
fn ensure_inside_notes_root(raw: &str) -> Result<PathBuf, PluginError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains("..") {
        return Err(PluginError::bad_params("非法的文件路径"));
    }
    let root_canon = ensure_root_canonical()?;
    let p = Path::new(trimmed);
    if !p.exists() {
        return Err(PluginError::bad_params("路径不存在"));
    }
    let canon = p
        .canonicalize()
        .map_err(|e| PluginError::bad_params(format!("路径不可用: {}", e)))?;
    if !canon.starts_with(&root_canon) {
        return Err(PluginError::permission_denied("路径越出笔记根目录"));
    }
    Ok(strip_verbatim(&canon))
}

/// 校验路径是笔记根内的目录（创建/移动的目标父目录）
fn ensure_dir_inside_notes_root(raw: &str) -> Result<PathBuf, PluginError> {
    let canon = ensure_inside_notes_root(raw)?;
    if !canon.is_dir() {
        return Err(PluginError::bad_params("目标不是文件夹"));
    }
    Ok(canon)
}

/// 解析创建类操作的父目录参数：parent 为空 = 笔记根目录；否则必须是根内目录
fn resolve_parent_dir(params: &JsonValue) -> Result<PathBuf, PluginError> {
    match get_str(params, "parent").map(|s| s.trim().to_string()) {
        Some(p) if !p.is_empty() => ensure_dir_inside_notes_root(&p),
        _ => notes_root_plain(),
    }
}

/// 隐藏/系统杂项：点开头与 Windows 常见系统文件不进树与索引
fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
        || name.eq_ignore_ascii_case("desktop.ini")
        || name.eq_ignore_ascii_case("thumbs.db")
}

/// 递归扫描目录：文件夹在前、文件在后，名称不区分大小写排序，rel 以 / 分隔
fn scan_children(dir: &Path, parent_rel: &str) -> Vec<JsonValue> {
    let mut dirs: Vec<(String, JsonValue)> = Vec::new();
    let mut files: Vec<(String, JsonValue)> = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if is_hidden_name(&name) {
            continue;
        }
        let rel = if parent_rel.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", parent_rel, name)
        };
        if path.is_dir() {
            let children = scan_children(&path, &rel);
            dirs.push((
                name.to_lowercase(),
                json!({
                    "name": name,
                    "path": path.to_string_lossy(),
                    "rel": rel,
                    "kind": "dir",
                    "children": children,
                }),
            ));
        } else if path.is_file() {
            files.push((
                name.to_lowercase(),
                json!({
                    "name": name,
                    "path": path.to_string_lossy(),
                    "rel": rel,
                    "kind": "file",
                    "size": fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
                }),
            ));
        }
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    files.sort_by(|a, b| a.0.cmp(&b.0));
    dirs.into_iter()
        .map(|(_, v)| v)
        .chain(files.into_iter().map(|(_, v)| v))
        .collect()
}

/// 递归收集目录下全部普通文件（跳过隐藏/系统杂项）
fn walk_all_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if is_hidden_name(&name) {
            continue;
        }
        if path.is_dir() {
            out.extend(walk_all_files(&path));
        } else if path.is_file() {
            out.push(path);
        }
    }
    out
}

/// 递归收集目录下全部 .md 文件，供索引同步
fn walk_md_files(dir: &Path) -> Vec<PathBuf> {
    walk_all_files(dir)
        .into_iter()
        .filter(|p| p.extension().map_or(false, |e| e.eq_ignore_ascii_case("md")))
        .collect()
}

/// 由搜索词与开关构造匹配正则：Aa=区分大小写，ab=全字匹配，.*=正则模式
fn build_search_regex(
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    is_regex: bool,
) -> Result<Regex, String> {
    let mut pattern = String::new();
    if !case_sensitive {
        pattern.push_str("(?i)");
    }
    if is_regex {
        pattern.push_str(query);
    } else {
        let escaped = regex::escape(query);
        if whole_word {
            pattern.push_str(&format!("\\b(?:{})\\b", escaped));
        } else {
            pattern.push_str(&escaped);
        }
    }
    Regex::new(&pattern).map_err(|e| format!("正则表达式无效: {}", e))
}

/// 解析逗号/分号分隔的 glob 列表（如 `Work/**/*.md, *.md`），空串返回空列表
fn parse_glob_patterns(raw: &str) -> Result<Vec<Regex>, String> {
    let mut out = Vec::new();
    for part in raw.split([',', ';']) {
        let pattern = part.trim().replace('\\', "/");
        if pattern.is_empty() {
            continue;
        }
        let re = glob_to_regex(&pattern);
        out.push(
            Regex::new(&re).map_err(|e| format!("glob “{}” 无效: {}", pattern, e))?,
        );
    }
    Ok(out)
}

/// 极简 glob → 正则：`**/` 跨零或多级目录，`**` 任意字符，`*` 单段内任意，
/// `?` 单字符；大小写不敏感（Windows 习惯）。rel 路径统一以 / 分隔。
fn glob_to_regex(pattern: &str) -> String {
    let mut re = String::from("^(?i)");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if i + 1 < chars.len() && chars[i + 1] == '*' {
                i += 2;
                if i < chars.len() && chars[i] == '/' {
                    i += 1;
                    re.push_str("(?:.*/)?");
                } else {
                    re.push_str(".*");
                }
            } else {
                re.push_str("[^/\\\\]*");
                i += 1;
            }
        } else if c == '?' {
            re.push_str("[^/\\\\]");
            i += 1;
        } else {
            re.push_str(&regex::escape(&c.to_string()));
            i += 1;
        }
    }
    re.push('$');
    re
}

/// 清洗笔记标题为合法文件名：Windows 非法字符与控制字符替换为空格，
/// 压缩连续空白，去掉结尾的空格与点（Windows 不允许）
fn sanitize_title(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(|c| c == '.' || c == ' ')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{build_search_regex, glob_to_regex, is_hidden_name, sanitize_title, strip_verbatim};
    use regex::Regex;
    use std::path::{Path, PathBuf};

    #[test]
    fn strips_windows_illegal_chars() {
        assert_eq!(sanitize_title(r#"a/b\c:d*e?f"g<h>i|j"#), "a b c d e f g h i j");
    }

    #[test]
    fn trims_and_collapses_whitespace() {
        assert_eq!(sanitize_title("  会议   记录  "), "会议 记录");
        assert_eq!(sanitize_title("笔记."), "笔记");
        assert_eq!(sanitize_title(""), "");
    }

    #[test]
    fn glob_matches_rel_paths() {
        let re = Regex::new(&glob_to_regex("Work/**/*.md")).unwrap();
        assert!(re.is_match("Work/a.md"), "**/ 应跨零级目录");
        assert!(re.is_match("Work/sub/b.md"));
        assert!(re.is_match("Work/sub/deep/c.md"));
        assert!(!re.is_match("Other/a.md"));
        assert!(!re.is_match("Work/a.txt"));

        let root_only = Regex::new(&glob_to_regex("*.md")).unwrap();
        assert!(root_only.is_match("a.md"));
        assert!(!root_only.is_match("Work/a.md"), "* 不应跨目录");

        let q = Regex::new(&glob_to_regex("note?.md")).unwrap();
        assert!(q.is_match("note1.md"));
        assert!(!q.is_match("note12.md"));

        // 大小写不敏感（Windows 习惯）
        let ci = Regex::new(&glob_to_regex("Work/*.MD")).unwrap();
        assert!(ci.is_match("Work/a.md"));
    }

    #[test]
    fn search_regex_options() {
        let re = build_search_regex("Hello", false, false, false).unwrap();
        assert!(re.is_match("say hello world"));

        let cs = build_search_regex("Hello", true, false, false).unwrap();
        assert!(!cs.is_match("say hello world"));
        assert!(cs.is_match("say Hello world"));

        let ww = build_search_regex("cat", false, true, false).unwrap();
        assert!(ww.is_match("a cat here"));
        assert!(!ww.is_match("category"));

        let rx = build_search_regex("h(l+)o", true, false, true).unwrap();
        assert!(rx.is_match("say hllo"));
        assert!(build_search_regex("(unclosed", false, false, true).is_err());
    }

    #[test]
    fn hidden_names_filtered() {
        assert!(is_hidden_name(".git"));
        assert!(is_hidden_name("desktop.ini"));
        assert!(is_hidden_name("Desktop.INI"));
        assert!(!is_hidden_name("notes.md"));
    }

    #[test]
    fn strip_verbatim_prefix() {
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\C:\a\b")),
            PathBuf::from(r"C:\a\b")
        );
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\srv\share")),
            PathBuf::from(r"\\srv\share")
        );
        assert_eq!(strip_verbatim(Path::new(r"C:\a\b")), PathBuf::from(r"C:\a\b"));
    }
}
