//! App 插件（LPS-1 内置插件）：/app 指令后端
//!
//! 吸收原 app_launcher.rs（快捷列表/添加/启动）与 system_apps.rs（系统应用扫描，
//! 位于同级 apps_system 模块）的全部逻辑。应用启动经 ctx.process 受控进程服务
//! （平台策略与注入校验由宿主实现），不直接持有 std::process。
//!
//! 0.2 起这里多了"应用目录"职责：首次启动把开始菜单/桌面收录进 `app_shortcuts`，
//! 并按「手动优先 → 启动频次 → 最近使用」排序。目的只有一个——让用户在启动器里
//! 输入 `wx` 就能打开微信，而不是先学会 `/app add`。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ll_plugin_api::{
    DbApi, LogApi, PluginBackend, PluginContext, PluginError, PluginManifest, SettingsApi,
};
use serde_json::{Value as JsonValue, json};

mod system;
mod text;

use crate::system::{DEFAULT_LIMIT, SystemAppItem, search_system_apps};
use crate::text::{icon_url, index_text, short_description};

/// 导入时单次扫描上限：开始菜单常见几百项，2000 足够，也避免异常目录把内存打满
const IMPORT_LIMIT: usize = 2000;
/// 后台自动扫描节流：24h 内不重复全量扫描（用户可用 `/app rescan` 强制）
const RESCAN_INTERVAL_SECS: i64 = 24 * 3600;
/// 列表单次返回上限（IPC 与渲染成本都要收口）
const LIST_LIMIT_MAX: usize = 200;
/// 空状态推荐条数
const SUGGEST_DEFAULT: usize = 6;

pub struct AppsPlugin {
    ctx: Mutex<Option<PluginContext>>,
    /// 导入既耗时又幂等：自动导入与用户手动 rescan 可能并发，
    /// 用原子标志挡住第二次，避免两轮扫描互相改写 `last_seen_at`
    importing: AtomicBool,
}

impl AppsPlugin {
    pub fn new() -> Self {
        Self {
            ctx: Mutex::new(None),
            importing: AtomicBool::new(false),
        }
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

    fn need_db(ctx: &PluginContext) -> Result<Arc<dyn DbApi>, PluginError> {
        ctx.db
            .clone()
            .ok_or_else(|| PluginError::permission_denied("db"))
    }

    /// 取导入所需的三个句柄并从锁里出来：扫描期间不能一直占着状态锁，
    /// 否则用户在导入进行中打字会查不动列表。
    fn import_parts(
        &self,
    ) -> Result<(Arc<dyn DbApi>, Arc<dyn SettingsApi>, Arc<dyn LogApi>), PluginError> {
        let guard = self
            .ctx
            .lock()
            .map_err(|_| PluginError::internal("插件状态锁不可用"))?;
        let ctx = guard
            .as_ref()
            .ok_or_else(|| PluginError::internal("插件尚未初始化"))?;
        Ok((
            Self::need_db(ctx)?,
            Arc::clone(&ctx.settings),
            Arc::clone(&ctx.log),
        ))
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

    /// 列表 / 检索：手动添加优先，其次启动次数与最近使用
    fn list(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let keyword = get_str(params, "keyword").unwrap_or_default();
        let limit = get_u64(params, "limit")
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_LIMIT)
            .clamp(1, LIST_LIMIT_MAX);
        let kw = keyword.trim().to_lowercase();
        if kw.is_empty() && get_u64(params, "limit").is_none() {
            // 无关键词且未显式要条数：沿用"最近添加"语义，避免设置页/旧调用方
            // 突然被 200 条目录项淹没
            return self.list_recent(ctx_db(self)?, DEFAULT_LIMIT);
        }

        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let like = format!("%{}%", kw);
            let prefix = format!("{}%", kw);
            let rows = db.query(
                "SELECT id, name, path, source, launch_count, last_used_at
                 FROM app_shortcuts
                 WHERE hidden = 0
                   AND (?1 = '' OR lower(name) LIKE ?2 OR pinyin LIKE ?2 OR initials LIKE ?2)
                 ORDER BY
                   CASE
                     WHEN ?1 = '' THEN 0
                     WHEN lower(name) = ?1 THEN 0
                     WHEN lower(name) LIKE ?3 THEN 1
                     WHEN initials LIKE ?3 THEN 2
                     WHEN pinyin LIKE ?3 THEN 3
                     ELSE 4
                   END,
                   (source = 'manual') DESC,
                   launch_count DESC,
                   COALESCE(last_used_at, 0) DESC,
                   name COLLATE NOCASE ASC
                 LIMIT ?4",
                &[json!(kw), json!(like), json!(prefix), json!(limit as i64)],
            )?;
            Ok(JsonValue::Array(rows.iter().map(row_to_item).collect()))
        })
    }

    /// 无关键词的旧行为：按创建时间列出条目（手动添加的排在自动收录之前）
    fn list_recent(&self, db: Arc<dyn DbApi>, limit: usize) -> Result<JsonValue, PluginError> {
        let rows = db.query(
            "SELECT id, name, path, source, launch_count, last_used_at
             FROM app_shortcuts
             WHERE hidden = 0
             ORDER BY created_at ASC
             LIMIT ?1",
            &[json!(limit as i64)],
        )?;
        Ok(JsonValue::Array(rows.iter().map(row_to_item).collect()))
    }

    /// 空状态推荐：按启动频次/最近使用取前 N 个
    fn suggest(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let limit = get_u64(params, "limit")
            .map(|v| v as usize)
            .unwrap_or(SUGGEST_DEFAULT)
            .clamp(1, 12);
        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let rows = db.query(
                "SELECT id, name, path, source, launch_count, last_used_at
                 FROM app_shortcuts
                 WHERE hidden = 0
                 ORDER BY launch_count DESC,
                          COALESCE(last_used_at, 0) DESC,
                          name COLLATE NOCASE ASC
                 LIMIT ?1",
                &[json!(limit as i64)],
            )?;
            Ok(JsonValue::Array(rows.iter().map(row_to_item).collect()))
        })
    }

    /// 欢迎引导/设置页用的目录统计（只读，不触发扫描）
    fn stats(&self) -> Result<JsonValue, PluginError> {
        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let total = count_visible(&db)?;
            let system = count_source(&db, "system")?;
            Ok(json!({
                "total": total,
                "system": system,
                "manual": (total - system).max(0),
            }))
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
                return Err(PluginError::bad_params(format!(
                    "\"{}\" 已在应用列表中",
                    name
                )));
            }

            let id = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now().timestamp();
            let (pinyin, initials) = index_text(&name);
            db.execute(
                "INSERT INTO app_shortcuts
                    (id, name, path, created_at, source, pinyin, initials)
                 VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?6)",
                &[
                    json!(id),
                    json!(name),
                    json!(path),
                    json!(now),
                    json!(pinyin),
                    json!(initials),
                ],
            )?;
            Ok(json!({
                "id": id,
                "name": name,
                "path": path,
                "icon": icon_url(&path),
                "description": short_description("manual", &path),
                "badge": "自定义",
            }))
        })
    }

    fn search_system(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let keyword = get_str(params, "keyword");
        let limit = params
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);
        self.with_ctx(|ctx| {
            let saved = Self::saved_paths(ctx)?;
            let items = search_system_apps(
                keyword,
                // IPC 层仍限制 100，导入走 IMPORT_LIMIT 直连扫描
                limit.map(|l| l.min(100)).or(Some(DEFAULT_LIMIT)),
                &saved,
            );
            Ok(json!(items))
        })
    }

    /// 扫描已安装应用并写入目录（幂等；`force=true` 跳过 24h 节流）
    fn import_system(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let force = params
            .get("force")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let (db, settings, log) = self.import_parts()?;

        // 已有导入在跑：直接返回，不排队（下一次进启动器还会自动补）
        if self.importing.swap(true, Ordering::AcqRel) {
            return Ok(json!({ "skipped": true, "reason": "已有导入在进行" }));
        }

        let started = Instant::now();
        let result = run_import(&db, &settings, &log, force);
        self.importing.store(false, Ordering::Release);

        let (added, updated, total) = result?;
        Ok(json!({
            "added": added,
            "updated": updated,
            "total": total,
            "ms": started.elapsed().as_millis() as u64,
        }))
    }

    fn rescan(&self, _params: &JsonValue) -> Result<JsonValue, PluginError> {
        self.import_system(&json!({ "force": true }))
    }

    fn launch(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let path =
            get_str(params, "path").ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        self.with_ctx(|ctx| {
            let process = ctx
                .process
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("process"))?;
            process.launch(&path)?;
            // 启动成功才计数：失败的中文路径也能少一次噪声统计
            Self::record_launch(ctx, &path);
            Ok(JsonValue::Null)
        })
    }

    /// 在系统文件管理器中定位应用（Ctrl+Enter 动作）
    fn reveal(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let path =
            get_str(params, "path").ok_or_else(|| PluginError::bad_params("缺少参数 path"))?;
        self.with_ctx(|ctx| {
            let process = ctx
                .process
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("process"))?;
            process.reveal(&path)?;
            Ok(JsonValue::Null)
        })
    }

    fn record_launch(ctx: &PluginContext, path: &str) {
        if let Some(db) = &ctx.db {
            let now = chrono::Utc::now().timestamp();
            let _ = db.execute(
                "UPDATE app_shortcuts
                 SET launch_count = launch_count + 1, last_used_at = ?1
                 WHERE path = ?2",
                &[json!(now), json!(path)],
            );
        }
    }
}

impl Default for AppsPlugin {
    fn default() -> Self {
        Self::new()
    }
}

/// 宿主返回行 → 面板项。壳层只认 `PanelItem` 契约，来源标签在这里翻译成人话。
fn row_to_item(row: &JsonValue) -> JsonValue {
    let name = str_field(row, "name");
    let path = str_field(row, "path");
    let source = str_field(row, "source");
    let source = if source.is_empty() {
        "manual".to_string()
    } else {
        source
    };
    json!({
        "id": str_field(row, "id"),
        "name": name,
        "path": path,
        "icon": "🚀",
        "description": short_description(&source, &path),
        "badge": if source == "manual" { "自定义" } else { "已安装" },
    })
}

fn str_field(row: &JsonValue, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn get_str(params: &JsonValue, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn get_u64(params: &JsonValue, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}

/// `list()` 在无关键词、无显式 limit 时需要 db，但又不该进 `with_ctx` 闭包两次
fn ctx_db(plugin: &AppsPlugin) -> Result<Arc<dyn DbApi>, PluginError> {
    let guard = plugin
        .ctx
        .lock()
        .map_err(|_| PluginError::internal("插件状态锁不可用"))?;
    let ctx = guard
        .as_ref()
        .ok_or_else(|| PluginError::internal("插件尚未初始化"))?;
    AppsPlugin::need_db(ctx)
}

/// 全量导入：扫描 → 同名裸命令升级 / 同名真实路径跳过 → upsert → 隐藏消失项
fn run_import(
    db: &Arc<dyn DbApi>,
    settings: &Arc<dyn SettingsApi>,
    log: &Arc<dyn LogApi>,
    force: bool,
) -> Result<(i64, i64, i64), PluginError> {
    let now = chrono::Utc::now().timestamp();

    if !force {
        if let Some(last) = settings
            .get("catalog_imported_at")
            .and_then(|s| s.parse::<i64>().ok())
        {
            if now.saturating_sub(last) < RESCAN_INTERVAL_SECS {
                return Ok((0, 0, count_apps(db)?));
            }
        }
    }

    // 手动添加的名字优先，但不能让"预置种子"挡掉真正的安装快捷方式：
    // 种子里是 `code.exe` 这种裸命令，装在 PATH 之外时启动会失败。
    // 规则：同名手动项若是**裸命令**（没有路径分隔符），把它升级成系统快捷方式；
    // 若用户填的是真实路径，则完全不动。
    let candidates = search_system_apps(None, Some(IMPORT_LIMIT), &HashSet::new());
    let (added, updated) = import_candidates(db, &candidates, now)?;
    let after = count_apps(db)?;

    let _ = settings.set("catalog_imported_at", &now.to_string());
    log.log(
        "info",
        &format!(
            "catalog: 候选 {}，新增 {}，更新 {}，总数 {}",
            candidates.len(),
            added,
            updated,
            after
        ),
    );
    Ok((added, updated, after))
}

/// 把一批扫描结果写进目录（纯 DB 逻辑，便于用内存库单测）
///
/// 返回 `(新增, 更新)`；调用方负责节流、扫描与日志。
fn import_candidates(
    db: &Arc<dyn DbApi>,
    candidates: &[SystemAppItem],
    now: i64,
) -> Result<(i64, i64), PluginError> {
    let before = count_apps(db)?;
    let manual: HashMap<String, (String, String)> = db
        .query(
            "SELECT id, lower(name) AS n, path FROM app_shortcuts WHERE source = 'manual'",
            &[],
        )?
        .iter()
        .filter_map(|r| {
            let key = r.get("n").and_then(|v| v.as_str())?;
            let id = r.get("id").and_then(|v| v.as_str())?;
            let path = r.get("path").and_then(|v| v.as_str())?;
            Some((key.to_string(), (id.to_string(), path.to_string())))
        })
        .collect();

    let mut seen = 0i64;
    for item in candidates {
        if item.path.trim().is_empty() {
            continue;
        }
        let key = item.name.to_lowercase();
        if let Some((id, existing_path)) = manual.get(&key).cloned() {
            if is_bare_command(&existing_path) {
                let (pinyin, initials) = index_text(&item.name);
                // OR IGNORE：极端情况下系统快捷方式已被别的行占用时不要中断整轮导入
                db.execute(
                    "UPDATE OR IGNORE app_shortcuts
                     SET path = ?1, name = ?2, pinyin = ?3, initials = ?4, hidden = 0
                     WHERE id = ?5",
                    &[
                        json!(item.path),
                        json!(item.name),
                        json!(pinyin),
                        json!(initials),
                        json!(id),
                    ],
                )?;
                seen += 1;
            }
            continue;
        }
        let (pinyin, initials) = index_text(&item.name);
        let id = uuid::Uuid::new_v4().to_string();
        let affected = db.execute(
            "INSERT INTO app_shortcuts
                (id, name, path, created_at, source, pinyin, initials,
                 launch_count, last_used_at, hidden, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, 'system', ?5, ?6, 0, NULL, 0, ?4)
             ON CONFLICT(path) DO UPDATE SET
                name = excluded.name,
                pinyin = excluded.pinyin,
                initials = excluded.initials,
                hidden = 0,
                last_seen_at = excluded.last_seen_at
             WHERE app_shortcuts.source = 'system'",
            &[
                json!(id),
                json!(item.name),
                json!(item.path),
                json!(now),
                json!(pinyin),
                json!(initials),
            ],
        )?;
        if affected > 0 {
            seen += 1;
        }
    }

    // 本次没扫到的系统条目只隐藏、不删除：U 盘/网络盘暂时不可用不该抹掉数据。
    // 扫描结果为空时整轮跳过——那通常意味着目录读不到（权限/挂载），
    // 而不是"所有应用都被卸载了"，此时隐藏全部系统项是最糟的反应。
    if !candidates.is_empty() {
        db.execute(
            "UPDATE app_shortcuts SET hidden = 1
             WHERE source = 'system' AND COALESCE(last_seen_at, 0) < ?1",
            &[json!(now)],
        )?;
    }

    let after = count_apps(db)?;
    let added = (after - before).max(0);
    let updated = (seen - added).max(0);
    Ok((added, updated))
}

fn count_apps(db: &Arc<dyn DbApi>) -> Result<i64, PluginError> {
    Ok(db
        .query("SELECT COUNT(*) AS n FROM app_shortcuts", &[])?
        .first()
        .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0))
}

fn count_visible(db: &Arc<dyn DbApi>) -> Result<i64, PluginError> {
    Ok(db
        .query(
            "SELECT COUNT(*) AS n FROM app_shortcuts WHERE hidden = 0",
            &[],
        )?
        .first()
        .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0))
}

fn count_source(db: &Arc<dyn DbApi>, source: &str) -> Result<i64, PluginError> {
    Ok(db
        .query(
            "SELECT COUNT(*) AS n FROM app_shortcuts WHERE source = ?1 AND hidden = 0",
            &[json!(source)],
        )?
        .first()
        .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
        .unwrap_or(0))
}

/// 裸命令判定：`code.exe` / `wt` 是裸命令，`C:\...` 与 `/usr/bin/...` 不是。
/// 用于把迁移器播种的裸命令升级成真实系统快捷方式，同时不动用户手填的绝对路径。
fn is_bare_command(path: &str) -> bool {
    !path.contains('\\') && !path.contains('/') && !path.contains(':')
}

/// 老数据（v1 迁移过来的预置应用）没有拼音列的值，启动时补一次
fn backfill_pinyin(db: &Arc<dyn DbApi>) -> Result<(), PluginError> {
    let rows = db.query(
        "SELECT id, name FROM app_shortcuts WHERE pinyin = '' OR initials = ''",
        &[],
    )?;
    for row in rows {
        let id = str_field(&row, "id");
        let name = str_field(&row, "name");
        if id.is_empty() || name.is_empty() {
            continue;
        }
        let (pinyin, initials) = index_text(&name);
        db.execute(
            "UPDATE app_shortcuts SET pinyin = ?1, initials = ?2 WHERE id = ?3",
            &[json!(pinyin), json!(initials), json!(id)],
        )?;
    }
    Ok(())
}

/// 启动后后台补目录：首次全量、之后 24h 一次
fn spawn_catalog_import(db: Arc<dyn DbApi>, settings: Arc<dyn SettingsApi>, log: Arc<dyn LogApi>) {
    std::thread::spawn(move || {
        if let Err(e) = run_import(&db, &settings, &log, false) {
            log.log("warn", &format!("catalog: 后台导入失败: {}", e));
        }
    });
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
        let db = Self::need_db(&ctx)?;
        // 自检：确认快捷表可访问（schema 由宿主迁移器保证）
        db.query("SELECT COUNT(*) FROM app_shortcuts", &[])?;

        // v1 数据补拼音；失败不阻断插件——目录仍可用，只是中文缩写搜不到
        if let Err(e) = backfill_pinyin(&db) {
            ctx.log
                .log("warn", &format!("catalog: 拼音回填失败: {}", e));
        }

        let settings = Arc::clone(&ctx.settings);
        let log = Arc::clone(&ctx.log);
        *self
            .ctx
            .lock()
            .map_err(|_| PluginError::internal("插件状态锁不可用"))? = Some(ctx);

        // 首次运行：空状态是用户看到的第一屏，必须等一次导入完成再返回，
        // 否则用户会先看到 7 个预置种子、几秒后才"变出"已装应用。
        // 之后每 24h 一次的后台扫描走线程，不阻塞查询。
        if settings.get("catalog_imported_at").is_none() {
            if let Err(e) = run_import(&db, &settings, &log, true) {
                log.log("warn", &format!("catalog: 首次导入失败: {}", e));
            }
        } else {
            spawn_catalog_import(db, settings, log);
        }
        Ok(())
    }

    fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, PluginError> {
        match method {
            "list" => self.list(&params),
            "stats" => self.stats(),
            "add" => self.add(&params),
            "search_system" => self.search_system(&params),
            "launch" => self.launch(&params),
            "reveal" => self.reveal(&params),
            "import_system" => self.import_system(&params),
            "rescan" => self.rescan(&params),
            "suggest" => self.suggest(&params),
            _ => Err(PluginError::unknown_method(method)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ll_plugin_api::{DbApi, PluginError};
    use rusqlite::types::Value as SqlValue;
    use rusqlite::{Connection, params_from_iter};
    use serde_json::Value as JsonValue;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    const SCHEMA: &str = "
        CREATE TABLE app_shortcuts (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            path        TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            source      TEXT NOT NULL DEFAULT 'manual',
            pinyin      TEXT NOT NULL DEFAULT '',
            initials    TEXT NOT NULL DEFAULT '',
            launch_count INTEGER NOT NULL DEFAULT 0,
            last_used_at INTEGER,
            hidden      INTEGER NOT NULL DEFAULT 0,
            last_seen_at INTEGER
        );
        CREATE UNIQUE INDEX ux_app_shortcuts_path ON app_shortcuts(path);
    ";

    /// 内存 SQLite + DbApi 适配：验证的是真实 SQL，不是手写桩
    struct TestDb(Mutex<Connection>);

    impl TestDb {
        fn new() -> Arc<Self> {
            let conn = Connection::open_in_memory().expect("内存库");
            conn.execute_batch(SCHEMA).expect("建 v2 表");
            Arc::new(Self(Mutex::new(conn)))
        }
    }

    fn json_to_sql(v: &JsonValue) -> SqlValue {
        match v {
            JsonValue::Null => SqlValue::Null,
            JsonValue::Bool(b) => SqlValue::Integer(i64::from(*b)),
            JsonValue::Number(n) => n
                .as_i64()
                .map(SqlValue::Integer)
                .or_else(|| n.as_f64().map(SqlValue::Real))
                .unwrap_or(SqlValue::Null),
            JsonValue::String(s) => SqlValue::Text(s.clone()),
            other => SqlValue::Text(other.to_string()),
        }
    }

    fn sql_to_json(v: SqlValue) -> JsonValue {
        match v {
            SqlValue::Null => JsonValue::Null,
            SqlValue::Integer(i) => json!(i),
            SqlValue::Real(f) => json!(f),
            SqlValue::Text(s) => json!(s),
            SqlValue::Blob(b) => json!(format!("<blob {} bytes>", b.len())),
        }
    }

    impl DbApi for TestDb {
        fn migrate(&self, statements: &[&str]) -> Result<(), PluginError> {
            let conn = self.0.lock().map_err(|_| PluginError::db("锁不可用"))?;
            for sql in statements {
                conn.execute_batch(sql)
                    .map_err(|e| PluginError::db(e.to_string()))?;
            }
            Ok(())
        }

        fn execute(&self, sql: &str, params: &[JsonValue]) -> Result<u64, PluginError> {
            let conn = self.0.lock().map_err(|_| PluginError::db("锁不可用"))?;
            let vals: Vec<SqlValue> = params.iter().map(json_to_sql).collect();
            conn.execute(sql, params_from_iter(vals))
                .map(|n| n as u64)
                .map_err(|e| PluginError::db(e.to_string()))
        }

        fn query(&self, sql: &str, params: &[JsonValue]) -> Result<Vec<JsonValue>, PluginError> {
            let conn = self.0.lock().map_err(|_| PluginError::db("锁不可用"))?;
            let mut stmt = conn
                .prepare(sql)
                .map_err(|e| PluginError::db(e.to_string()))?;
            let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
            let vals: Vec<SqlValue> = params.iter().map(json_to_sql).collect();
            let mut rows = stmt
                .query(params_from_iter(vals))
                .map_err(|e| PluginError::db(e.to_string()))?;
            let mut out = Vec::new();
            while let Some(row) = rows.next().map_err(|e| PluginError::db(e.to_string()))? {
                let mut obj = serde_json::Map::new();
                for (idx, name) in names.iter().enumerate() {
                    let value: SqlValue =
                        row.get(idx).map_err(|e| PluginError::db(e.to_string()))?;
                    obj.insert(name.clone(), sql_to_json(value));
                }
                out.push(JsonValue::Object(obj));
            }
            Ok(out)
        }
    }

    fn app(name: &str, path: &str) -> SystemAppItem {
        SystemAppItem {
            name: name.to_string(),
            path: path.to_string(),
            detail: path.to_string(),
            kind: "startmenu".to_string(),
            added: false,
        }
    }

    fn seed_manual(db: &Arc<dyn DbApi>, id: &str, name: &str, path: &str) {
        db.execute(
            "INSERT INTO app_shortcuts (id, name, path, created_at, source)
             VALUES (?1, ?2, ?3, 1, 'manual')",
            &[json!(id), json!(name), json!(path)],
        )
        .expect("插入手动条目");
    }

    fn row(db: &Arc<dyn DbApi>, name: &str) -> JsonValue {
        db.query(
            "SELECT name, path, source, pinyin, initials, hidden
             FROM app_shortcuts WHERE name = ?1",
            &[json!(name)],
        )
        .expect("查询行")
        .into_iter()
        .next()
        .expect("行存在")
    }

    #[test]
    fn distinguishes_bare_commands_from_absolute_paths() {
        assert!(is_bare_command("code.exe"));
        assert!(is_bare_command("wt"));
        assert!(!is_bare_command(r"C:\Program Files\Code\code.exe"));
        assert!(!is_bare_command("/usr/bin/code"));
        assert!(!is_bare_command(r"C:relative"));
    }

    #[test]
    fn import_upgrades_bare_seed_and_fills_pinyin() {
        let db: Arc<dyn DbApi> = TestDb::new();
        seed_manual(&db, "seed", "Visual Studio Code", "code.exe");

        let candidates = vec![
            app("Visual Studio Code", r"C:\Menu\Code.lnk"),
            app("微信", r"C:\Menu\WeChat.lnk"),
        ];
        let (added, updated) = import_candidates(&db, &candidates, 100).expect("导入");
        assert_eq!(added, 1, "只应新增微信，VS Code 是升级");
        assert_eq!(updated, 1);

        let code = row(&db, "Visual Studio Code");
        assert_eq!(
            code["path"], r"C:\Menu\Code.lnk",
            "裸命令应升级为真实快捷方式"
        );
        assert_eq!(code["source"], "manual", "升级不应改变来源");
        assert_eq!(code["pinyin"], "visualstudiocode");
        assert_eq!(code["initials"], "vsc");

        let wechat = row(&db, "微信");
        assert_eq!(wechat["source"], "system");
        assert_eq!(wechat["pinyin"], "weixin");
        assert_eq!(wechat["initials"], "wx");
        assert_eq!(wechat["hidden"], 0);
    }

    #[test]
    fn rescan_hides_missing_system_rows_but_keeps_manual() {
        let db: Arc<dyn DbApi> = TestDb::new();
        seed_manual(&db, "seed", "记事本", r"C:\Windows\notepad.exe");

        let first = vec![
            app("微信", r"C:\Menu\WeChat.lnk"),
            app("计算器", r"C:\Menu\calc.lnk"),
        ];
        import_candidates(&db, &first, 100).expect("首次导入");

        // 第二次扫描里"计算器"消失；手动条目"记事本"不在候选里也不该被隐藏
        let second = vec![app("微信", r"C:\Menu\WeChat.lnk")];
        import_candidates(&db, &second, 200).expect("二次导入");

        assert_eq!(row(&db, "微信")["hidden"], 0);
        assert_eq!(row(&db, "计算器")["hidden"], 1, "消失的系统项应隐藏");
        assert_eq!(row(&db, "记事本")["hidden"], 0, "手动项永不被扫描隐藏");

        // 扫描失败（空结果）不应把已有目录整片隐藏
        import_candidates(&db, &[], 300).expect("空扫描");
        assert_eq!(row(&db, "微信")["hidden"], 0, "空扫描不得隐藏任何条目");
    }
}
