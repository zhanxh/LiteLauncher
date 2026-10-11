//! Todo 插件（LPS-1 内置插件）：/todo 指令后端
//!
//! 吸收原 todo.rs（CRUD + 重复规则 + 时间规范化）与 reminder.rs（调度扫描 + 弹窗/通知）
//! 的全部逻辑，改经 PluginContext 门控句柄访问宿主能力：
//! - db → todos 表（M1 共用核心库，M3 拆独立 todo.db + 迁移器）
//! - windows → manifest 声明的 todoapp（管理面板）/ reminder（提醒弹窗）两个视图
//! - notify → 系统通知；settings → popup_auto_close_secs（宿主自动加 todo. 前缀）
//!
//! 与核心库的历史约定：todos 表结构与 `YYYY-MM-DD HH:MM` 时间格式不变，
//! M3 迁移器将据此做无损搬库。

use chrono::{Datelike, Duration, Local, Months, NaiveDate, NaiveDateTime, NaiveTime, Weekday};
use ll_plugin_api::{CoreEvent, PluginBackend, PluginContext, PluginError, PluginManifest};
use serde_json::{json, Value as JsonValue};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const POPUP_DURATION_KEY: &str = "popup_auto_close_secs";
const POPUP_DURATION_DEFAULT: u64 = 12;
const POPUP_DURATION_MIN: u64 = 5;
const POPUP_DURATION_MAX: u64 = 300;

const SCHEDULER_TICK_SECS: u64 = 20;

pub struct TodoPlugin {
    ctx: Mutex<Option<PluginContext>>,
    enabled: Arc<AtomicBool>,
    scheduler_started: AtomicBool,
}

impl TodoPlugin {
    pub fn new() -> Self {
        Self {
            ctx: Mutex::new(None),
            enabled: Arc::new(AtomicBool::new(true)),
            scheduler_started: AtomicBool::new(false),
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

    fn need_db(ctx: &PluginContext) -> Result<Arc<dyn ll_plugin_api::DbApi>, PluginError> {
        ctx.db
            .clone()
            .ok_or_else(|| PluginError::permission_denied("db"))
    }

    fn need_windows(ctx: &PluginContext) -> Result<Arc<dyn ll_plugin_api::WindowApi>, PluginError> {
        ctx.windows
            .clone()
            .ok_or_else(|| PluginError::permission_denied("windows"))
    }

    // ───────────────────────────── 方法实现 ─────────────────────────────

    fn create(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let content = get_str(params, "content").unwrap_or_default();
        let clean_content = content.trim().to_string();
        if clean_content.is_empty() {
            return Err(PluginError::bad_params("待办内容不能为空"));
        }
        let remind_at = get_str(params, "remind_at");
        let repeat_rule = get_str(params, "repeat_rule");
        let raw_input = get_str(params, "raw_input").unwrap_or_default();

        let (remind_at, repeat_canonical, _) = finalize_schedule(
            remind_at.as_deref(),
            repeat_rule.as_deref(),
            None,
        )
        .map_err(PluginError::bad_params)?;

        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp();

        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            db.execute(
                "INSERT INTO todos (id, content, remind_at, repeat_rule, completed, raw_input, created_at, notified)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, 0)",
                &[
                    json!(id),
                    json!(clean_content),
                    json!(remind_at),
                    json!(repeat_canonical),
                    json!(raw_input),
                    json!(now),
                ],
            )?;
            Ok(json!({
                "id": id,
                "content": clean_content,
                "remind_at": remind_at,
                "repeat_rule": repeat_canonical,
                "completed": false,
                "raw_input": raw_input,
                "created_at": now,
            }))
        })
    }

    fn list(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let filter = get_str(params, "keyword")
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let rows = if filter.is_empty() {
                db.query(
                    "SELECT id, content, remind_at, repeat_rule, completed, raw_input, created_at
                     FROM todos ORDER BY completed ASC, created_at DESC",
                    &[],
                )?
            } else {
                db.query(
                    "SELECT id, content, remind_at, repeat_rule, completed, raw_input, created_at
                     FROM todos WHERE LOWER(content) LIKE ?1 ORDER BY completed ASC, created_at DESC",
                    &[json!(format!("%{}%", filter))],
                )?
            };
            Ok(JsonValue::Array(rows.iter().map(row_to_todo).collect()))
        })
    }

    fn toggle(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let id = get_str(params, "id").ok_or_else(|| PluginError::bad_params("缺少参数 id"))?;
        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let current = db
                .query("SELECT completed FROM todos WHERE id = ?1", &[json!(id)])?
                .first()
                .and_then(|row| row.get("completed"))
                .and_then(|v| v.as_i64())
                .ok_or_else(|| PluginError::bad_params(format!("未找到对应待办: {}", id)))?;
            let new_state = if current == 0 { 1 } else { 0 };
            db.execute(
                "UPDATE todos SET completed = ?1 WHERE id = ?2",
                &[json!(new_state), json!(id)],
            )?;
            Ok(json!(new_state != 0))
        })
    }

    fn delete(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let id = get_str(params, "id").ok_or_else(|| PluginError::bad_params("缺少参数 id"))?;
        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            db.execute("DELETE FROM todos WHERE id = ?1", &[json!(id)])?;
            Ok(JsonValue::Null)
        })
    }

    fn update(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let id = get_str(params, "id").ok_or_else(|| PluginError::bad_params("缺少参数 id"))?;
        let content = get_str(params, "content").unwrap_or_default();
        let clean_content = content.trim().to_string();
        if clean_content.is_empty() {
            return Err(PluginError::bad_params("待办内容不能为空"));
        }
        let remind_at = get_str(params, "remind_at");
        let repeat_rule = get_str(params, "repeat_rule");

        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let existing = db
                .query(
                    "SELECT remind_at, notified FROM todos WHERE id = ?1",
                    &[json!(id)],
                )?
                .into_iter()
                .next()
                .ok_or_else(|| PluginError::bad_params(format!("未找到对应待办: {}", id)))?;
            let existing_remind = existing
                .get("remind_at")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let existing_notified = existing
                .get("notified")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            let (remind_at, repeat_canonical, time_changed) = finalize_schedule(
                remind_at.as_deref(),
                repeat_rule.as_deref(),
                existing_remind,
            )
            .map_err(PluginError::bad_params)?;

            db.execute(
                "UPDATE todos SET content = ?1, remind_at = ?2, repeat_rule = ?3, notified = ?4
                 WHERE id = ?5",
                &[
                    json!(clean_content),
                    json!(remind_at),
                    json!(repeat_canonical),
                    json!(if time_changed { 0 } else { existing_notified }),
                    json!(id),
                ],
            )?;

            let completed = db
                .query("SELECT completed FROM todos WHERE id = ?1", &[json!(id)])?
                .first()
                .and_then(|row| row.get("completed"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);

            Ok(json!({
                "id": id,
                "content": clean_content,
                "remind_at": remind_at,
                "repeat_rule": repeat_canonical,
                "completed": completed != 0,
                "raw_input": "",
                "created_at": 0,
            }))
        })
    }

    fn open_manager(&self) -> Result<JsonValue, PluginError> {
        self.with_ctx(|ctx| {
            Self::need_windows(ctx)?.open("todoapp", &[])?;
            Ok(JsonValue::Null)
        })
    }

    fn get_popup_duration(&self) -> Result<JsonValue, PluginError> {
        self.with_ctx(|ctx| Ok(json!(popup_duration(ctx))))
    }

    fn set_popup_duration(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let seconds = params
            .get("seconds")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| PluginError::bad_params("缺少参数 seconds"))?;
        if !(POPUP_DURATION_MIN..=POPUP_DURATION_MAX).contains(&seconds) {
            return Err(PluginError::bad_params(format!(
                "时长需在 {}-{} 秒之间",
                POPUP_DURATION_MIN, POPUP_DURATION_MAX
            )));
        }
        self.with_ctx(|ctx| {
            ctx.settings
                .set(POPUP_DURATION_KEY, &seconds.to_string())?;
            Ok(JsonValue::Null)
        })
    }

    fn test_popup(&self) -> Result<JsonValue, PluginError> {
        self.with_ctx(|ctx| {
            let dur = popup_duration(ctx);
            Self::need_windows(ctx)?.open(
                "reminder",
                &[
                    ("id".to_string(), "test-popup".to_string()),
                    (
                        "content".to_string(),
                        format!("这是一条测试提醒，弹窗将在 {} 秒后自动关闭", dur),
                    ),
                    ("dur".to_string(), dur.to_string()),
                ],
            )?;
            Ok(JsonValue::Null)
        })
    }
}

impl Default for TodoPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginBackend for TodoPlugin {
    /// manifest 单一来源：本 crate 目录上层的 manifest.json（声明式，宿主/文档/未来安装器共用）
    fn manifest(&self) -> PluginManifest {
        static MANIFEST: std::sync::OnceLock<PluginManifest> = std::sync::OnceLock::new();
        MANIFEST
            .get_or_init(|| {
                serde_json::from_str(include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../manifest.json"
                )))
                .expect("plugins/todo/manifest.json 解析失败")
            })
            .clone()
    }

fn init(&self, ctx: PluginContext) -> Result<(), PluginError> {
        *self
            .ctx
            .lock()
            .map_err(|_| PluginError::internal("插件状态锁不可用"))? = Some(ctx.clone());
        self.enabled.store(true, Ordering::Relaxed);

        // 自检：确认 todos 表可访问
        {
            let db = Self::need_db(&ctx)?;
            db.migrate(&["
                CREATE TABLE IF NOT EXISTS todos (
                    id          TEXT PRIMARY KEY,
                    content     TEXT NOT NULL,
                    remind_at   TEXT,
                    repeat_rule TEXT,
                    completed   INTEGER NOT NULL DEFAULT 0,
                    raw_input   TEXT,
                    created_at  INTEGER NOT NULL,
                    notified    INTEGER NOT NULL DEFAULT 0
                )
            "])?;
        }

        // 提醒调度线程：只持有 ctx 快照与共享 enabled 标志，不持有 self
        if !self.scheduler_started.swap(true, Ordering::Relaxed) {
            let thread_ctx = ctx.clone();
            let enabled = Arc::clone(&self.enabled);
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(SCHEDULER_TICK_SECS));
                if !enabled.load(Ordering::Relaxed) {
                    continue;
                }
                match fire_due(&thread_ctx) {
                    Ok(0) => {}
                    Ok(n) => thread_ctx
                        .log
                        .log("info", &format!("触发提醒 {} 条", n)),
                    Err(e) => thread_ctx
                        .log
                        .log("error", &format!("提醒扫描失败: {}", e)),
                }
            });
        }
        Ok(())
    }

    fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, PluginError> {
        if !self.enabled.load(Ordering::Relaxed) {
            return Err(PluginError::disabled());
        }
        match method {
            "create" => self.create(&params),
            "list" => self.list(&params),
            "toggle" => self.toggle(&params),
            "delete" => self.delete(&params),
            "update" => self.update(&params),
            "open_manager" => self.open_manager(),
            "get_popup_duration" => self.get_popup_duration(),
            "set_popup_duration" => self.set_popup_duration(&params),
            "test_popup" => self.test_popup(),
            _ => Err(PluginError::unknown_method(method)),
        }
    }

    fn on_core_event(&self, ev: CoreEvent) {
        if matches!(ev, CoreEvent::Shutdown) {
            self.enabled.store(false, Ordering::Relaxed);
        }
    }

    fn shutdown(&self) {
        self.enabled.store(false, Ordering::Relaxed);
    }
}

// ───────────────────────────── 调度扫描 ─────────────────────────────

fn popup_duration(ctx: &PluginContext) -> u64 {
    ctx.settings
        .get(POPUP_DURATION_KEY)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(POPUP_DURATION_DEFAULT)
        .clamp(POPUP_DURATION_MIN, POPUP_DURATION_MAX)
}

/// 扫描到期待办并触发提醒。一次性待办标记 notified=1；
/// 重复待办计算下一次触发时间并重新武装（notified 保持 0）
fn fire_due(ctx: &PluginContext) -> Result<usize, PluginError> {
    let db = ctx
        .db
        .as_ref()
        .ok_or_else(|| PluginError::permission_denied("db"))?;

    let now = Local::now().naive_local();
    let popup_dur = popup_duration(ctx);

    let rows = db.query(
        "SELECT id, content, repeat_rule, remind_at FROM todos
         WHERE completed = 0 AND notified = 0
           AND remind_at IS NOT NULL AND remind_at != ''",
        &[],
    )?;

    let due: Vec<(String, String, Option<String>, String)> = rows
        .iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.to_string();
            let content = row.get("content")?.as_str()?.to_string();
            let repeat_rule = row
                .get("repeat_rule")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let remind_at = row.get("remind_at")?.as_str()?.to_string();
            let dt = parse_remind_time(&remind_at, now)?;
            if dt > now {
                return None;
            }
            Some((id, content, repeat_rule, remind_at))
        })
        .collect();

    let mut fired = 0;
    for (id, content, repeat_rule, remind_at) in due {
        // 1. 桌面右下角弹窗（宿主按 manifest 视图规格创建，堆叠 + 兜底关闭）
        if let Some(windows) = &ctx.windows {
            let _ = windows.open(
                "reminder",
                &[
                    ("id".to_string(), id.clone()),
                    ("content".to_string(), content.clone()),
                    ("dur".to_string(), popup_dur.to_string()),
                ],
            );
        }

        // 2. 系统级通知（失败静默，不影响弹窗）
        if let Some(notify) = &ctx.notify {
            if let Err(e) = notify.send("LiteLauncher 待办提醒", &content) {
                ctx.log
                    .log("warn", &format!("系统通知失败 id={}: {}", id, e));
            }
        }

        // 3. 收尾：重复待办重排到下一次触发，一次性待办标记已通知
        let next = repeat_rule.as_deref().and_then(|rule| {
            parse_remind_time(&remind_at, now).and_then(|dt| next_occurrence(dt, rule, now))
        });
        match next {
            Some(next_dt) => {
                let next_str = next_dt.format("%Y-%m-%d %H:%M").to_string();
                db.execute(
                    "UPDATE todos SET remind_at = ?1, notified = 0 WHERE id = ?2",
                    &[json!(next_str), json!(id)],
                )?;
                ctx.log
                    .log("info", &format!("重复提醒已重排 id={} next={}", id, next_str));
            }
            None => {
                db.execute(
                    "UPDATE todos SET notified = 1 WHERE id = ?1",
                    &[json!(id)],
                )?;
            }
        }
        fired += 1;
    }
    Ok(fired)
}

// ───────────────────────────── 小工具 ─────────────────────────────

fn get_str(params: &JsonValue, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn row_to_todo(row: &JsonValue) -> JsonValue {
    json!({
        "id": row.get("id").and_then(|v| v.as_str()).unwrap_or_default(),
        "content": row.get("content").and_then(|v| v.as_str()).unwrap_or_default(),
        "remind_at": row.get("remind_at").cloned().unwrap_or(JsonValue::Null),
        "repeat_rule": row.get("repeat_rule").cloned().unwrap_or(JsonValue::Null),
        "completed": row.get("completed").and_then(|v| v.as_i64()).unwrap_or(0) != 0,
        "raw_input": row.get("raw_input").and_then(|v| v.as_str()).unwrap_or_default(),
        "created_at": row.get("created_at").and_then(|v| v.as_i64()).unwrap_or(0),
    })
}

// ───────────────────── 纯函数（自 todo.rs / reminder.rs 原样迁移）─────────────────────

/// 解析重复规则为 (间隔数, 单位)，单位: i=分钟 h=小时 d=天 w=周 m=月
pub fn parse_repeat_rule(raw: &str) -> Option<(u32, char)> {
    let raw = raw.trim().to_lowercase();
    if raw.is_empty() {
        return None;
    }

    match raw.as_str() {
        "daily" => return Some((1, 'd')),
        "weekly" => return Some((1, 'w')),
        "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" => return Some((1, 'w')),
        _ => {}
    }

    let rest = raw
        .strip_prefix("every:")
        .or_else(|| raw.strip_prefix("repeat:"))?;
    let split = rest.find(|c: char| !c.is_ascii_digit())?;
    let n: u32 = rest[..split].parse().ok()?;
    if n == 0 || n > 999 {
        return None;
    }
    let unit = match &rest[split..] {
        "min" | "mins" | "minute" | "minutes" => 'i',
        "h" | "hour" | "hours" => 'h',
        "d" | "day" | "days" => 'd',
        "w" | "week" | "weeks" => 'w',
        "mo" | "month" | "months" | "m" => 'm',
        _ => return None,
    };
    Some((n, unit))
}

/// 规范化重复规则为标准存储格式 `every:{n}{min|hour|day|week|month}`
pub fn canonical_repeat_rule(raw: &str) -> Option<String> {
    parse_repeat_rule(raw).map(|(n, unit)| {
        let unit = match unit {
            'i' => "min",
            'h' => "hour",
            'd' => "day",
            'w' => "week",
            _ => "month",
        };
        format!("every:{}{}", n, unit)
    })
}

/// 计算重复提醒的下一次触发时间（严格晚于 now；错过多次时逐段推进追赶）
pub fn next_occurrence(
    remind_at: NaiveDateTime,
    rule: &str,
    now: NaiveDateTime,
) -> Option<NaiveDateTime> {
    let (n, unit) = parse_repeat_rule(rule)?;
    let mut t = remind_at;
    for _ in 0..10000 {
        t = match unit {
            'i' => t + Duration::minutes(n as i64),
            'h' => t + Duration::hours(n as i64),
            'd' => t + Duration::days(n as i64),
            'w' => t + Duration::weeks(n as i64),
            'm' => t.checked_add_months(Months::new(n))?,
            _ => return None,
        };
        if t > now {
            return Some(t);
        }
    }
    None
}

/// 星期关键词 → chrono Weekday（mon=一 .. sun=日）
fn weekday_keyword(raw: &str) -> Option<Weekday> {
    match raw.trim().to_lowercase().as_str() {
        "mon" => Some(Weekday::Mon),
        "tue" => Some(Weekday::Tue),
        "wed" => Some(Weekday::Wed),
        "thu" => Some(Weekday::Thu),
        "fri" => Some(Weekday::Fri),
        "sat" => Some(Weekday::Sat),
        "sun" => Some(Weekday::Sun),
        _ => None,
    }
}

/// 解析提醒时间文本为本地时间（NaiveDateTime）
///
/// 支持 `YYYY-MM-DD HH:MM[:SS]`（`T` 亦可作分隔符）、`YYYY-MM-DD`（当天 09:00）、
/// `HH:MM[:SS]`（今天该时刻，已过则顺延明天）
pub fn parse_remind_time(raw: &str, now: NaiveDateTime) -> Option<NaiveDateTime> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    let normalized = raw.replace('T', " ");
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(&normalized, fmt) {
            return Some(dt);
        }
    }

    if let Ok(date) = NaiveDate::parse_from_str(&normalized, "%Y-%m-%d") {
        return date.and_hms_opt(9, 0, 0);
    }

    for fmt in ["%H:%M:%S", "%H:%M"] {
        if let Ok(t) = NaiveTime::parse_from_str(raw, fmt) {
            let mut candidate = now.date().and_time(t);
            if candidate <= now {
                candidate += Duration::days(1);
            }
            return Some(candidate);
        }
    }

    None
}

/// 规范化提醒时间输入，返回标准存储格式 `YYYY-MM-DD HH:MM`
fn normalize_remind_time(raw: &str) -> Result<Option<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }

    let now = Local::now().naive_local();
    match parse_remind_time(raw, now) {
        Some(dt) if dt > now => Ok(Some(dt.format("%Y-%m-%d %H:%M").to_string())),
        Some(_) => Err("提醒时间已过去，请指定将来的时间".into()),
        None => Err("提醒时间格式无效，支持 HH:MM、YYYY-MM-DD 或 YYYY-MM-DD HH:MM".into()),
    }
}

/// 统一处理"提醒时间 + 重复规则"的组合语义，供 create/update 共用
///
/// - `keep_existing`：编辑时未修改时间字段的原值——原样保留（允许保留已触发过的过去时间）
/// - 星期关键词（mon..sun）+ 纯 `HH:MM` 时间 → 锚定到下一个对应星期
/// - 返回 (规范时间, 规范规则, 时间是否发生变化)
fn finalize_schedule(
    time_input: Option<&str>,
    repeat_input: Option<&str>,
    keep_existing: Option<String>,
) -> Result<(Option<String>, Option<String>, bool), String> {
    let now = Local::now().naive_local();
    let repeat_raw = repeat_input.unwrap_or("").trim();
    let repeat_canonical = if repeat_raw.is_empty() {
        None
    } else {
        Some(canonical_repeat_rule(repeat_raw).ok_or_else(|| {
            "重复规则无效，支持 every:30min、every:2hour、every:1day、every:1week、every:3month、daily、weekly、mon..sun".to_string()
        })?)
    };

    let time_raw = time_input.unwrap_or("").trim();
    let mut remind_at = if time_raw.is_empty() {
        None
    } else if Some(time_raw) == keep_existing.as_deref() {
        keep_existing.clone()
    } else {
        normalize_remind_time(time_raw)?
    };

    // 星期锚定：纯 HH:MM 时间 + mon..sun 关键词 → 日期调整到下一个匹配星期
    if let (Some(weekday), Some(dt_str)) = (weekday_keyword(repeat_raw), remind_at.as_deref()) {
        let is_bare_time = time_raw.contains(':') && !time_raw.contains('-');
        if is_bare_time {
            if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(dt_str, "%Y-%m-%d %H:%M") {
                let mut date = now.date();
                for _ in 0..8 {
                    if date.weekday() == weekday && date >= dt.date() {
                        break;
                    }
                    date += Duration::days(1);
                }
                let mut anchored = date.and_time(dt.time());
                if anchored <= now {
                    anchored += Duration::weeks(1);
                }
                remind_at = Some(anchored.format("%Y-%m-%d %H:%M").to_string());
            }
        }
    }

    if repeat_canonical.is_some() && remind_at.is_none() {
        return Err("重复提醒需要同时指定提醒时间".into());
    }

    let time_changed = remind_at != keep_existing;
    Ok((remind_at, repeat_canonical, time_changed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn empty_input_yields_none() {
        assert!(normalize_remind_time("").unwrap().is_none());
        assert!(normalize_remind_time("   ").unwrap().is_none());
    }

    #[test]
    fn future_datetime_kept_normalized() {
        let future = (chrono::Local::now() + chrono::Duration::hours(2))
            .format("%Y-%m-%d %H:%M")
            .to_string();
        assert_eq!(normalize_remind_time(&future).unwrap().unwrap(), future);
    }

    #[test]
    fn past_datetime_rejected() {
        let past = (chrono::Local::now() - chrono::Duration::hours(2))
            .format("%Y-%m-%d %H:%M")
            .to_string();
        assert!(normalize_remind_time(&past).is_err());
    }

    #[test]
    fn bare_time_resolves_to_canonical_datetime() {
        let out = normalize_remind_time("23:59").unwrap().unwrap();
        assert_eq!(out.len(), "YYYY-MM-DD HH:MM".len());
        assert!(chrono::NaiveDateTime::parse_from_str(&out, "%Y-%m-%d %H:%M").is_ok());
    }

    #[test]
    fn invalid_format_rejected() {
        assert!(normalize_remind_time("明天").is_err());
        assert!(normalize_remind_time("25:00").is_err());
        assert!(normalize_remind_time("2026-13-01").is_err());
    }

    #[test]
    fn parses_repeat_rule_aliases() {
        assert_eq!(parse_repeat_rule("every:30min"), Some((30, 'i')));
        assert_eq!(parse_repeat_rule("repeat:2h"), Some((2, 'h')));
        assert_eq!(parse_repeat_rule("every:1day"), Some((1, 'd')));
        assert_eq!(parse_repeat_rule("every:2w"), Some((2, 'w')));
        assert_eq!(parse_repeat_rule("every:3month"), Some((3, 'm')));
        assert_eq!(parse_repeat_rule("daily"), Some((1, 'd')));
        assert_eq!(parse_repeat_rule("weekly"), Some((1, 'w')));
        assert_eq!(parse_repeat_rule("fri"), Some((1, 'w')));
        assert_eq!(parse_repeat_rule("EVERY:10MIN"), Some((10, 'i')));
    }

    #[test]
    fn canonicalizes_repeat_rule() {
        assert_eq!(
            canonical_repeat_rule("every:30min").as_deref(),
            Some("every:30min")
        );
        assert_eq!(
            canonical_repeat_rule("daily").as_deref(),
            Some("every:1day")
        );
        assert_eq!(
            canonical_repeat_rule("every:2hours").as_deref(),
            Some("every:2hour")
        );
    }

    #[test]
    fn rejects_invalid_repeat_rule() {
        assert_eq!(parse_repeat_rule("every:0min"), None);
        assert_eq!(parse_repeat_rule("every:abc"), None);
        assert_eq!(parse_repeat_rule("every:5century"), None);
        assert_eq!(parse_repeat_rule(""), None);
    }

    #[test]
    fn next_occurrence_advances_and_catches_up() {
        let base = Local
            .with_ymd_and_hms(2026, 10, 10, 15, 0, 0)
            .unwrap()
            .naive_local();
        let next = next_occurrence(base, "every:30min", base).unwrap();
        assert_eq!(next.to_string(), "2026-10-10 15:30:00");
        let late_now = base + Duration::hours(2);
        let next = next_occurrence(base, "every:1hour", late_now).unwrap();
        assert_eq!(next.to_string(), "2026-10-10 18:00:00");
        let jan31 = Local
            .with_ymd_and_hms(2026, 1, 31, 9, 0, 0)
            .unwrap()
            .naive_local();
        let next = next_occurrence(jan31, "every:1month", jan31).unwrap();
        assert_eq!(next.to_string(), "2026-02-28 09:00:00");
    }

    #[test]
    fn parses_remind_time_forms() {
        let now = Local
            .with_ymd_and_hms(2026, 10, 10, 15, 0, 0)
            .unwrap()
            .naive_local();
        assert_eq!(
            parse_remind_time("2026-10-11 08:30", now)
                .unwrap()
                .to_string(),
            "2026-10-11 08:30:00"
        );
        assert_eq!(
            parse_remind_time("2026-10-11T08:30:45", now)
                .unwrap()
                .to_string(),
            "2026-10-11 08:30:45"
        );
        assert_eq!(
            parse_remind_time("2026-10-12", now).unwrap().to_string(),
            "2026-10-12 09:00:00"
        );
        // 18:00 晚于基准 15:00 → 今天；09:00 早于基准 → 顺延明天
        assert_eq!(
            parse_remind_time("18:00", now).unwrap().to_string(),
            "2026-10-10 18:00:00"
        );
        assert_eq!(
            parse_remind_time("09:00", now).unwrap().to_string(),
            "2026-10-11 09:00:00"
        );
        assert!(parse_remind_time("明天下午", now).is_none());
        assert!(parse_remind_time("", now).is_none());
        assert!(parse_remind_time("25:00", now).is_none());
    }
}
