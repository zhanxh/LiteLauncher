//! Todo 插件（LPS-1 内置插件）：/cal 日程管理后端（/todo 为别名）
//!
//! 吸收原 todo.rs（CRUD + 重复规则 + 时间规范化）与 reminder.rs（调度扫描 + 弹窗/通知）
//! 的全部逻辑，改经 PluginContext 门控句柄访问宿主能力：
//! - db → todos（日程项）/ calendars（分类日历）/ event_alarms（多条提醒）/ alarm_fires（触发记账）
//! - windows → manifest 声明的 calendar（日历主窗）/ todoapp（旧管理面板）/ reminder（提醒弹窗）
//! - notify → 系统通知；settings → popup_auto_close_secs（宿主自动加 todo. 前缀）
//!
//! 与核心库的历史约定：`YYYY-MM-DD HH:MM` 本地裸时间串不变；v2 新增列由 `init()`
//! 探列后增量补齐，旧待办数据无损升级（无提醒的旧待办 → 全天事项）。

pub mod ics;
mod recur;

use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, Weekday};
use ll_plugin_api::{CoreEvent, DbApi, PluginBackend, PluginContext, PluginError, PluginManifest};
use recur::expand_range;
use serde_json::{Value as JsonValue, json};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub use recur::{canonical_repeat_rule, parse_repeat_rule};

const POPUP_DURATION_KEY: &str = "popup_auto_close_secs";
const POPUP_DURATION_DEFAULT: u64 = 12;
const POPUP_DURATION_MIN: u64 = 5;
const POPUP_DURATION_MAX: u64 = 300;

const SCHEDULER_TICK_SECS: u64 = 20;

/// 数据模型版本标记（settings 键，宿主加 `todo.` 前缀）
const SCHEMA_VERSION_KEY: &str = "schema_version";
const SCHEMA_VERSION_V2: &str = "2";

/// 未指定分类时的落位（首次启动种一条，用户可改名/加色但不能删）
const DEFAULT_CALENDAR_ID: &str = "default";
const DEFAULT_CALENDAR_COLOR: &str = "#4c8dff";

/// 只给开始时间时的默认时长（settings 键 `default_duration_min`）
const DEFAULT_DURATION_KEY: &str = "default_duration_min";
const DEFAULT_DURATION_DEFAULT: i64 = 60;
const DEFAULT_DURATION_MIN: i64 = 5;
const DEFAULT_DURATION_MAX: i64 = 24 * 60;

/// 单条日程最多几条提醒、最多提前多久提醒
const MAX_ALARMS: usize = 8;
const MAX_ALARM_MINUTES: i64 = 30 * 24 * 60;

/// 提醒扫描的窗口：回看 26h 足以接住"跨 0 点的全天事项 + 隔夜睡眠"，
/// 前看 1d 只是让 `expand_range` 能把明天的实例算出来备用，未到点不弹。
const LOOKBACK_HOURS: i64 = 26;
const LOOKAHEAD_DAYS: i64 = 1;

/// 迟到超过这个秒数的漏发提醒**只写 `alarm_fires` 不弹窗**。
/// 没有这条，开机时 26h 回看窗里的每一个漏发都会炸成一排弹窗。
const FIRE_GRACE_SECS: i64 = 600;

/// 全天事项没有时刻，提醒挂在当天这个钟点起算（"提前 30 分" = 08:30）
const ALL_DAY_ALARM_HOUR: u32 = 9;

/// 触发记账的保留期与"每天最多清一次表"的 settings 标志
const FIRES_RETENTION_DAYS: i64 = 90;
const PURGE_KEY: &str = "last_purge_day";

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

        let (remind_at, repeat_canonical, _) =
            finalize_schedule(remind_at.as_deref(), repeat_rule.as_deref(), None)
                .map_err(PluginError::bad_params)?;

        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp();

        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            // v2 列一并写齐：只填 remind_at 的话，日程在日历上没有时长、没有归属日历，
            // 编辑器打开还会看到空表单（remind_at 保留是为了兼容旧的提醒扫描）
            let start = remind_at
                .as_deref()
                .and_then(|raw| parse_stored_time(raw).or_else(|| parse_event_time(raw, Local::now().naive_local())));
            let end = start.map(|s| s + Duration::minutes(default_duration(ctx)));
            let fmt = |dt: NaiveDateTime| dt.format("%Y-%m-%d %H:%M").to_string();
            db.execute(
                "INSERT INTO todos (id, content, remind_at, repeat_rule, completed, raw_input,
                                   created_at, notified, start_at, end_at, all_day, calendar_id,
                                   status, uid)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, 0, ?7, ?8, 0, ?9, 'busy', ?10)",
                &[
                    json!(id),
                    json!(clean_content),
                    json!(&remind_at),
                    json!(&repeat_canonical),
                    json!(raw_input),
                    json!(now),
                    json!(start.map(&fmt)),
                    json!(end.map(&fmt)),
                    json!(DEFAULT_CALENDAR_ID),
                    json!(uuid::Uuid::new_v4().to_string()),
                ],
            )?;
            if let Some(s) = start {
                replace_alarms(&db, &id, &[0])?;
                ctx.log.log("info", &format!("新建日程 {} 起，默认提前 0 分钟提醒", fmt(s)));
            }
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

    /// 日历视图取数：把 `[from, to]` 内的全部日程**实例**展开返回。
    fn query_range(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let (from, to, calendar_filter) = Self::range_params(params)?;
        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let (instances, truncated) = collect_instances(&db, from, to, &calendar_filter)?;
            Ok(json!({ "instances": instances, "truncated": truncated }))
        })
    }

    /// 解析 `{from, to, calendar_id?}`；`query_range` 与测试共用同一套入参校验
    fn range_params(params: &JsonValue) -> Result<(NaiveDateTime, NaiveDateTime, String), PluginError> {
        let from = parse_range_endpoint(
            &get_str(params, "from").ok_or_else(|| PluginError::bad_params("缺少参数 from"))?,
            false,
        )
        .ok_or_else(|| PluginError::bad_params("from 需为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM"))?;
        let to = parse_range_endpoint(
            &get_str(params, "to").ok_or_else(|| PluginError::bad_params("缺少参数 to"))?,
            true,
        )
        .ok_or_else(|| PluginError::bad_params("to 需为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM"))?;
        if to < from {
            return Err(PluginError::bad_params("区间终点早于起点"));
        }
        let calendar_filter = get_str(params, "calendar_id")
            .unwrap_or_default()
            .trim()
            .to_string();
        Ok((from, to, calendar_filter))
    }

    /// 导出 `.ics`：整段区间内的日程（未展开重复，交给对端日历自己展开）。
    /// 落盘走插件自己的 `std::fs`——宿主没有 `svc.fs`/`svc.dialog`，前端选不了路径。
    fn export_ics(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let (from, to, calendar_filter) = Self::range_params(params)?;
        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let events = collect_export_events(&db, from, to, &calendar_filter)?;
            let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
            let text = ics::render(&events, &stamp);
            let path = write_export_file(&text)?;
            Ok(json!({ "path": path, "count": events.len() }))
        })
    }

    /// 导入 `.ics`：文本由前端 FileReader 给（窗口内选文件），
    /// 路径由 `/cal import <路径>` 给（启动器里没有 svc.fs，读盘只能插件自己做）。
    /// 两条路都按 UID 幂等落库。
    fn import_ics(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let text = match get_str(params, "text") {
            Some(t) => t,
            None => {
                let raw = get_str(params, "path")
                    .ok_or_else(|| PluginError::bad_params("缺少参数 text 或 path"))?;
                read_input_file(&raw)?
            }
        };
        let calendar_id = get_str(params, "calendar_id")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_CALENDAR_ID.to_string());
        let parsed = ics::parse(&text);
        if parsed.is_empty() {
            return Err(PluginError::bad_params("文件里没有可导入的日程（VEVENT）"));
        }
        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let dur = default_duration(ctx);
            let mut added = 0;
            let mut updated = 0;
            let mut skipped = 0;
            for ev in &parsed {
                if ev.uid.trim().is_empty() {
                    skipped += 1; // 没有 UID 就认不出"同一条"，导入两次会留两份
                    continue;
                }
                let existing = db
                    .query("SELECT id FROM todos WHERE uid = ?1", &[json!(ev.uid)])?
                    .into_iter()
                    .next()
                    .and_then(|r| r.get("id").and_then(|v| v.as_str()).map(str::to_string));
                match upsert_imported(&db, existing.as_deref(), ev, &calendar_id, dur)? {
                    true => updated += 1,
                    false => added += 1,
                }
            }
            Ok(json!({
                "added": added,
                "updated": updated,
                "skipped": skipped,
                "total": parsed.len(),
            }))
        })
    }

    /// 新建/编辑日程（同一入口：带 `id` 即改，不带即建）
    fn save(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let id = get_str(params, "id")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let content = get_str(params, "content")
            .unwrap_or_default()
            .trim()
            .to_string();
        if content.is_empty() {
            return Err(PluginError::bad_params("日程标题不能为空"));
        }
        let all_day = flag_of(params.get("all_day")) != 0;
        let raw_input = get_str(params, "raw_input").unwrap_or_default();
        let (start, end) = self.resolve_span(params, all_day)?;
        let repeat_rule = normalize_repeat(get_str(params, "repeat_rule").as_deref())?;
        let repeat_until = get_str(params, "repeat_until")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let status = match get_str(params, "status").as_deref() {
            Some("free") => "free",
            _ => "busy",
        };
        let calendar_id = get_str(params, "calendar_id")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_CALENDAR_ID.to_string());
        let location = get_str(params, "location")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let description = get_str(params, "description")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let alarms = normalize_alarms(params.get("alarms"));

        let fmt = |dt: NaiveDateTime| dt.format("%Y-%m-%d %H:%M").to_string();
        // 老 fire 循环读 remind_at；Stage 4 换成 event_alarms 前，先让它跟着开始时间走
        let remind_at = start.map(fmt);

        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let saved_id = match &id {
                None => {
                    let new_id = uuid::Uuid::new_v4().to_string();
                    let now = chrono::Utc::now().timestamp();
                    db.execute(
                        "INSERT INTO todos (id, content, remind_at, repeat_rule, completed, raw_input,
                                           created_at, notified, start_at, end_at, all_day, location,
                                           description, calendar_id, status, repeat_until, uid)
                         VALUES (?1,?2,?3,?4,0,?5,?6,0,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                        &[
                            json!(new_id),
                            json!(content),
                            json!(remind_at),
                            json!(repeat_rule),
                            json!(raw_input),
                            json!(now),
                            json!(start.map(&fmt)),
                            json!(end.map(&fmt)),
                            json!(i64::from(all_day)),
                            json!(location),
                            json!(description),
                            json!(calendar_id),
                            json!(status),
                            json!(repeat_until),
                            json!(uuid::Uuid::new_v4().to_string()),
                        ],
                    )?;
                    new_id
                }
                Some(existing) => {
                    let found = db.query("SELECT id FROM todos WHERE id = ?1", &[json!(existing)])?;
                    if found.is_empty() {
                        return Err(PluginError::bad_params(format!("未找到对应日程: {}", existing)));
                    }
                    db.execute(
                        "UPDATE todos SET content=?1, remind_at=?2, repeat_rule=?3, start_at=?4,
                                end_at=?5, all_day=?6, location=?7, description=?8, calendar_id=?9,
                                status=?10, repeat_until=?11, notified=0
                         WHERE id=?12",
                        &[
                            json!(content),
                            json!(remind_at),
                            json!(repeat_rule),
                            json!(start.map(&fmt)),
                            json!(end.map(&fmt)),
                            json!(i64::from(all_day)),
                            json!(location),
                            json!(description),
                            json!(calendar_id),
                            json!(status),
                            json!(repeat_until),
                            json!(existing),
                        ],
                    )?;
                    existing.clone()
                }
            };
            replace_alarms(&db, &saved_id, &alarms)?;
            fetch_event(&db, &saved_id)
        })
    }

    /// 把入参里的 start_at/end_at 归一成一对外科时间；未给时间 → 无日期事项
    fn resolve_span(
        &self,
        params: &JsonValue,
        all_day: bool,
    ) -> Result<(Option<NaiveDateTime>, Option<NaiveDateTime>), PluginError> {
        let now = Local::now().naive_local();
        let start_raw = get_str(params, "start_at").unwrap_or_default();
        let start = if start_raw.trim().is_empty() {
            None
        } else {
            let parsed = parse_event_time(&start_raw, now).ok_or_else(|| {
                PluginError::bad_params("开始时间格式无效，支持 YYYY-MM-DD、YYYY-MM-DD HH:MM 或 HH:MM")
            })?;
            Some(if all_day {
                parsed.date().and_hms_opt(0, 0, 0).unwrap_or(parsed)
            } else {
                parsed
            })
        };

        let end_raw = get_str(params, "end_at").unwrap_or_default();
        let end = match (start, end_raw.trim().is_empty()) {
            (None, _) => None,
            (Some(s), true) => {
                if all_day {
                    Some(s)
                } else {
                    let mins = self.default_duration_min()?;
                    Some(s + Duration::minutes(mins))
                }
            }
            (Some(s), false) => {
                let parsed = parse_event_time(&end_raw, now).ok_or_else(|| {
                    PluginError::bad_params("结束时间格式无效，支持 YYYY-MM-DD、YYYY-MM-DD HH:MM 或 HH:MM")
                })?;
                let normalized = if all_day {
                    parsed.date().and_hms_opt(0, 0, 0).unwrap_or(parsed)
                } else {
                    parsed
                };
                // 全天按"含结束日"理解（钉钉的 10-12 到 10-15）；定时按必须晚于开始，
                // 倒挂就退回默认时长，比报错打断用户编辑更合适。
                if all_day && normalized < s {
                    Some(s)
                } else if !all_day && normalized <= s {
                    Some(s + Duration::minutes(self.default_duration_min()?))
                } else {
                    Some(normalized)
                }
            }
        };
        Ok((start, end))
    }

    fn default_duration_min(&self) -> Result<i64, PluginError> {
        self.with_ctx(|ctx| Ok(default_duration(ctx)))
    }

    /// 单条日程全文 + 提醒列表（编辑器回填用）
    fn get_event(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let id = get_str(params, "id").ok_or_else(|| PluginError::bad_params("缺少参数 id"))?;
        self.with_ctx(|ctx| fetch_event(&Self::need_db(ctx)?, &id))
    }

    fn list_calendars(&self) -> Result<JsonValue, PluginError> {
        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let rows = db.query(
                "SELECT id, name, color, sort FROM calendars ORDER BY sort ASC, created_at ASC",
                &[],
            )?;
            Ok(JsonValue::Array(rows))
        })
    }

    fn save_calendar(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let id = get_str(params, "id")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let name = get_str(params, "name")
            .unwrap_or_default()
            .trim()
            .chars()
            .take(24)
            .collect::<String>();
        if name.is_empty() {
            return Err(PluginError::bad_params("日历名称不能为空"));
        }
        let color = get_str(params, "color")
            .map(|s| s.trim().to_lowercase())
            .filter(|s| is_hex_color(s))
            .unwrap_or_else(|| DEFAULT_CALENDAR_COLOR.to_string());
        let sort = params.get("sort").and_then(|v| v.as_i64()).unwrap_or(0).clamp(0, 999);

        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            match id {
                None => {
                    let new_id = uuid::Uuid::new_v4().to_string();
                    db.execute(
                        "INSERT INTO calendars (id, name, color, sort, created_at) VALUES (?1,?2,?3,?4,?5)",
                        &[
                            json!(new_id),
                            json!(name),
                            json!(color),
                            json!(sort),
                            json!(chrono::Utc::now().timestamp()),
                        ],
                    )?;
                    Ok(json!({ "id": new_id, "name": name, "color": color, "sort": sort }))
                }
                Some(existing) => {
                    if existing == DEFAULT_CALENDAR_ID {
                        return Err(PluginError::bad_params("默认日历的名称不可改"));
                    }
                    let changed = db.execute(
                        "UPDATE calendars SET name=?1, color=?2, sort=?3 WHERE id=?4",
                        &[json!(name), json!(color), json!(sort), json!(existing)],
                    )?;
                    if changed == 0 {
                        return Err(PluginError::bad_params(format!("未找到对应日历: {}", existing)));
                    }
                    Ok(json!({ "id": existing, "name": name, "color": color, "sort": sort }))
                }
            }
        })
    }

    fn delete_calendar(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let id = get_str(params, "id").ok_or_else(|| PluginError::bad_params("缺少参数 id"))?;
        if id == DEFAULT_CALENDAR_ID {
            return Err(PluginError::bad_params("默认日历不能删除"));
        }
        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            // 日程不跟着删：归到"未分类"，由前端按灰色渲染
            db.execute("UPDATE todos SET calendar_id = NULL WHERE calendar_id = ?1", &[json!(id)])?;
            db.execute("DELETE FROM calendars WHERE id = ?1", &[json!(id)])?;
            Ok(JsonValue::Null)
        })
    }

    /// 冲突检测：`[start_at, end_at]` 与哪些日程时间块重叠。
    /// 排除自身、全天事项与"标闲"的日程——后两类不占时间，拦人没意义。
    fn check_conflict(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let now = Local::now().naive_local();
        let start_raw = get_str(params, "start_at").ok_or_else(|| PluginError::bad_params("缺少参数 start_at"))?;
        let start = parse_event_time(&start_raw, now)
            .ok_or_else(|| PluginError::bad_params("start_at 格式无效"))?;
        let end = match get_str(params, "end_at").filter(|s| !s.trim().is_empty()) {
            Some(raw) => parse_event_time(&raw, now).ok_or_else(|| PluginError::bad_params("end_at 格式无效"))?,
            None => start + Duration::minutes(DEFAULT_DURATION_DEFAULT),
        };
        let exclude = get_str(params, "id")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        self.with_ctx(|ctx| {
            let db = Self::need_db(ctx)?;
            let (instances, _) = collect_instances(&db, start, end, "")?;
            let start_s = start.format("%Y-%m-%d %H:%M").to_string();
            let end_s = end.format("%Y-%m-%d %H:%M").to_string();
            let hits: Vec<JsonValue> = instances
                .into_iter()
                .filter(|inst| {
                    inst.get("all_day").and_then(|v| v.as_bool()) != Some(true)
                        && inst.get("status").and_then(|v| v.as_str()) != Some("free")
                        && inst.get("event_id").and_then(|v| v.as_str()) != exclude.as_deref()
                        && inst.get("start").and_then(|v| v.as_str()).unwrap_or_default() < end_s.as_str()
                        && inst.get("end").and_then(|v| v.as_str()).unwrap_or_default() > start_s.as_str()
                })
                .collect();
            Ok(json!({ "conflicts": hits }))
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
            // 提醒行与触发记账没有外键级联，得自己收干净，否则孤儿行会一直占表
            let alarm_ids: Vec<String> = db
                .query("SELECT id FROM event_alarms WHERE event_id = ?1", &[json!(id)])?
                .iter()
                .filter_map(|row| row.get("id").and_then(|v| v.as_str()).map(str::to_string))
                .collect();
            for alarm_id in &alarm_ids {
                db.execute("DELETE FROM alarm_fires WHERE alarm_id = ?1", &[json!(alarm_id)])?;
            }
            db.execute("DELETE FROM event_alarms WHERE event_id = ?1", &[json!(id)])?;
            db.execute("DELETE FROM todos WHERE id = ?1", &[json!(id)])?;
            Ok(json!({ "deleted_alarms": alarm_ids.len() }))
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

    /// 主入口：日历窗口。待办面板（todoapp）视图仍在 manifest 里，供旧入口回退
    ///
    /// `mode`/`day` 会拼进窗口 URL（`?view=calendar&mode=week&day=…`），
    /// 前端 `CalendarApp` 读它做初始定位；窗口已开着时宿主只 focus，定位不生效。
    fn open_manager(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let mode = get_str(params, "mode")
            .map(|s| s.trim().to_lowercase())
            .filter(|s| s == "month" || s == "week" || s == "day");
        let day = get_str(params, "day")
            .map(|s| s.trim().to_string())
            .filter(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok());
        self.with_ctx(|ctx| {
            let mut args: Vec<(String, String)> = Vec::new();
            if let Some(m) = mode {
                args.push(("mode".to_string(), m));
            }
            if let Some(d) = day {
                args.push(("day".to_string(), d));
            }
            Self::need_windows(ctx)?.open("calendar", &args)?;
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
            ctx.settings.set(POPUP_DURATION_KEY, &seconds.to_string())?;
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

        {
            let db = Self::need_db(&ctx)?;
            ensure_schema(&db)?;
            seed_default_calendar(&db)?;
        }
        backfill_v2(&ctx)?;

        // 提醒调度线程：只持有 ctx 快照与共享 enabled 标志，不持有 self
        if !self.scheduler_started.swap(true, Ordering::Relaxed) {
            let thread_ctx = ctx.clone();
            let enabled = Arc::clone(&self.enabled);
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(SCHEDULER_TICK_SECS));
                    if !enabled.load(Ordering::Relaxed) {
                        continue;
                    }
                    match fire_due(&thread_ctx) {
                        Ok(0) => {}
                        Ok(n) => thread_ctx.log.log("info", &format!("触发提醒 {} 条", n)),
                        Err(e) => thread_ctx.log.log("error", &format!("提醒扫描失败: {}", e)),
                    }
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
            "query_range" => self.query_range(&params),
            "save" => self.save(&params),
            "get_event" => self.get_event(&params),
            "check_conflict" => self.check_conflict(&params),
            "export_ics" => self.export_ics(&params),
            "import_ics" => self.import_ics(&params),
            "list_calendars" => self.list_calendars(),
            "save_calendar" => self.save_calendar(&params),
            "delete_calendar" => self.delete_calendar(&params),
            "toggle" => self.toggle(&params),
            "delete" => self.delete(&params),
            "update" => self.update(&params),
            "open_manager" => self.open_manager(&params),
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

// ───────────────────────────── 数据模型 v2 ─────────────────────────────

/// 全新安装一次建齐，省掉九次 ALTER
const CREATE_TODOS_V2: &str = "
    CREATE TABLE IF NOT EXISTS todos (
        id           TEXT PRIMARY KEY,
        content      TEXT NOT NULL,
        remind_at    TEXT,
        repeat_rule  TEXT,
        completed    INTEGER NOT NULL DEFAULT 0,
        raw_input    TEXT,
        created_at   INTEGER NOT NULL,
        notified     INTEGER NOT NULL DEFAULT 0,
        start_at     TEXT,
        end_at       TEXT,
        all_day      INTEGER NOT NULL DEFAULT 0,
        location     TEXT,
        description  TEXT,
        calendar_id  TEXT,
        status       TEXT,
        repeat_until TEXT,
        uid          TEXT
    )";

/// 老库补列：(列名, DDL)。`migrate()` 是无门禁的 `execute_batch`，任一语句报错
/// 都会让 `init()` 直接返回 Err，所以必须先探列、只补缺失的那些。
const TODOS_V2_COLUMNS: &[(&str, &str)] = &[
    ("start_at", "ALTER TABLE todos ADD COLUMN start_at TEXT"),
    ("end_at", "ALTER TABLE todos ADD COLUMN end_at TEXT"),
    (
        "all_day",
        "ALTER TABLE todos ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0",
    ),
    ("location", "ALTER TABLE todos ADD COLUMN location TEXT"),
    (
        "description",
        "ALTER TABLE todos ADD COLUMN description TEXT",
    ),
    (
        "calendar_id",
        "ALTER TABLE todos ADD COLUMN calendar_id TEXT",
    ),
    ("status", "ALTER TABLE todos ADD COLUMN status TEXT"),
    (
        "repeat_until",
        "ALTER TABLE todos ADD COLUMN repeat_until TEXT",
    ),
    ("uid", "ALTER TABLE todos ADD COLUMN uid TEXT"),
];

const CREATE_CALENDARS: &str = "
    CREATE TABLE IF NOT EXISTS calendars (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT '#4c8dff',
        sort       INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    )";

/// 一条日程可挂多条提醒（提前 N 分钟），所以独立成表而非 JSON 列：
/// 触发幂等要靠 (alarm_id, occ_key) 复合主键的 INSERT ... ON CONFLICT
const CREATE_EVENT_ALARMS: &str = "
    CREATE TABLE IF NOT EXISTS event_alarms (
        id             TEXT PRIMARY KEY,
        event_id       TEXT NOT NULL,
        minutes_before INTEGER NOT NULL
    )";

/// 提醒触发记账（只记真正弹过的，不为未发生的实例预生成行）
const CREATE_ALARM_FIRES: &str = "
    CREATE TABLE IF NOT EXISTS alarm_fires (
        alarm_id TEXT NOT NULL,
        occ_key  TEXT NOT NULL,
        fired_at INTEGER NOT NULL,
        PRIMARY KEY (alarm_id, occ_key)
    )";

/// uid 供 .ics 导入去重；SQLite 的唯一索引允许多个 NULL，老行为未分配
const CREATE_UID_INDEX: &str = "CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_uid ON todos(uid)";

/// 按已存在的列算出本次要执行的建库语句。抽成纯函数是为了能离线单测
/// "老库补列" 这条最危险的路径——幂等性一旦破了，`init()` 就永久失败。
fn schema_stmts_for(existing: &HashSet<String>) -> Vec<&'static str> {
    let mut stmts: Vec<&str> = Vec::new();
    if existing.is_empty() {
        stmts.push(CREATE_TODOS_V2);
    } else {
        for (column, ddl) in TODOS_V2_COLUMNS {
            if !existing.contains(*column) {
                stmts.push(ddl);
            }
        }
    }
    stmts.extend_from_slice(&[
        CREATE_CALENDARS,
        CREATE_EVENT_ALARMS,
        CREATE_ALARM_FIRES,
        CREATE_UID_INDEX,
    ]);
    stmts
}

/// 探列后增量建库
fn ensure_schema(db: &Arc<dyn DbApi>) -> Result<(), PluginError> {
    let existing: HashSet<String> = db
        .query("SELECT name FROM pragma_table_info('todos')", &[])?
        .iter()
        .filter_map(|row| {
            row.get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_lowercase())
        })
        .collect();
    db.migrate(&schema_stmts_for(&existing))
}

/// 默认分类日历：`INSERT OR IGNORE` 天然幂等，老库第一次升级时会补上这条
fn seed_default_calendar(db: &Arc<dyn DbApi>) -> Result<(), PluginError> {
    db.execute(
        "INSERT OR IGNORE INTO calendars (id, name, color, sort, created_at)
         VALUES (?1, ?2, ?3, 0, ?4)",
        &[
            json!(DEFAULT_CALENDAR_ID),
            json!("我的日程"),
            json!(DEFAULT_CALENDAR_COLOR),
            json!(chrono::Utc::now().timestamp()),
        ],
    )?;
    Ok(())
}

/// 一次性把旧待办升级成日程项：有提醒时间的成为定时块，没有的降为全天事项；
/// 老提醒补一条"提前 0 分钟"的提醒行，且**已通知过的预写触发记录**——
/// 否则升级到 v2 后历史待办会被 alarm_fires 判定为"从未触发"而集体重弹。
fn backfill_v2(ctx: &PluginContext) -> Result<(), PluginError> {
    if ctx
        .settings
        .get(SCHEMA_VERSION_KEY)
        .as_deref()
        .unwrap_or_default()
        == SCHEMA_VERSION_V2
    {
        return Ok(());
    }
    let db = ctx
        .db
        .clone()
        .ok_or_else(|| PluginError::permission_denied("db"))?;

    db.execute(
        "UPDATE todos SET start_at = remind_at
         WHERE start_at IS NULL AND remind_at IS NOT NULL AND remind_at != ''",
        &[],
    )?;
    db.execute("UPDATE todos SET all_day = 1 WHERE start_at IS NULL", &[])?;
    db.execute(
        "UPDATE todos SET calendar_id = ?1 WHERE calendar_id IS NULL",
        &[json!(DEFAULT_CALENDAR_ID)],
    )?;

    let need_alarm = db.query(
        "SELECT id, start_at, notified FROM todos
         WHERE remind_at IS NOT NULL AND remind_at != ''
           AND NOT EXISTS (SELECT 1 FROM event_alarms a WHERE a.event_id = todos.id)",
        &[],
    )?;
    for row in &need_alarm {
        let Some(event_id) = row.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let alarm_id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO event_alarms (id, event_id, minutes_before) VALUES (?1, ?2, 0)",
            &[json!(alarm_id), json!(event_id)],
        )?;
        let notified = row.get("notified").and_then(|v| v.as_i64()).unwrap_or(0);
        if let Some(occ_key) = row.get("start_at").and_then(|v| v.as_str()) {
            if notified != 0 {
                db.execute(
                    "INSERT INTO alarm_fires (alarm_id, occ_key, fired_at) VALUES (?1, ?2, ?3)",
                    &[
                        json!(alarm_id),
                        json!(occ_key),
                        json!(Local::now().timestamp()),
                    ],
                )?;
            }
        }
    }

    let need_uid = db.query("SELECT id FROM todos WHERE uid IS NULL", &[])?;
    for row in &need_uid {
        let Some(event_id) = row.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        db.execute(
            "UPDATE todos SET uid = ?1 WHERE id = ?2",
            &[json!(uuid::Uuid::new_v4().to_string()), json!(event_id)],
        )?;
    }

    ctx.settings.set(SCHEMA_VERSION_KEY, SCHEMA_VERSION_V2)?;
    ctx.log.log(
        "info",
        &format!(
            "数据模型升级到 v2：补提醒 {} 条、补 uid {} 行",
            need_alarm.len(),
            need_uid.len()
        ),
    );
    Ok(())
}

// ───────────────────────────── 事件读写辅助 ─────────────────────────────

/// 把 `[from, to]` 内的事件展开成实例数组。`query_range` 与 `check_conflict` 共用，
/// 两边必须是同一套语义，否则"编辑器里说不冲突、存完日历上叠在一起"。
///
/// 重复项必须整表捞出（锚点可能在几年前），因此 WHERE 条件是
/// "要么有重复规则、要么锚点落在视区"；真正的相交判定交给 `expand_range`。
/// 跨天/全天的按天拆分由前端做，后端只给起止区间。
fn collect_instances(
    db: &Arc<dyn DbApi>,
    from: NaiveDateTime,
    to: NaiveDateTime,
    calendar_filter: &str,
) -> Result<(Vec<JsonValue>, bool), PluginError> {
    let rows = db.query(
        "SELECT id, content, start_at, end_at, all_day, location, description,
                calendar_id, status, repeat_rule, repeat_until, completed, remind_at
         FROM todos
         WHERE (repeat_rule IS NOT NULL AND repeat_rule != '')
            OR (COALESCE(start_at, remind_at) IS NOT NULL
                AND COALESCE(start_at, remind_at) != ''
                AND COALESCE(start_at, remind_at) <= ?2
                AND COALESCE(end_at, COALESCE(start_at, remind_at)) >= ?1)",
        &[
            json!(from.format("%Y-%m-%d %H:%M").to_string()),
            json!(to.format("%Y-%m-%d %H:%M").to_string()),
        ],
    )?;

    let mut alarms_by_event: std::collections::BTreeMap<String, Vec<i64>> =
        std::collections::BTreeMap::new();
    for alarm in db.query(
        "SELECT event_id, minutes_before FROM event_alarms ORDER BY minutes_before DESC",
        &[],
    )? {
        if let (Some(event_id), Some(minutes)) = (
            alarm.get("event_id").and_then(|v| v.as_str()),
            alarm.get("minutes_before").and_then(|v| v.as_i64()),
        ) {
            alarms_by_event
                .entry(event_id.to_string())
                .or_default()
                .push(minutes);
        }
    }

    let mut instances: Vec<JsonValue> = Vec::new();
    let mut truncated = false;
    for row in &rows {
        let event_id = row.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        if !calendar_filter.is_empty()
            && row
                .get("calendar_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                != calendar_filter
        {
            continue;
        }

        let anchor_raw = row
            .get("start_at")
            .and_then(|v| v.as_str())
            .or_else(|| row.get("remind_at").and_then(|v| v.as_str()))
            .unwrap_or_default();
        let Some(parsed) = parse_stored_time(anchor_raw) else {
            continue; // 无日期的旧待办：留在清单里，日历上不占位
        };

        let all_day = flag_of(row.get("all_day")) != 0;
        let end_raw = row.get("end_at").and_then(|v| v.as_str()).unwrap_or("");
        let (start, dur_min) = if all_day {
            // 全天：钉在当天 00:00，结束日含当天（与钉钉"到 10-15"的语料一致）
            let start_date = parsed.date();
            let end_date = parse_stored_time(end_raw)
                .map(|dt| dt.date())
                .filter(|d| *d >= start_date)
                .unwrap_or(start_date);
            let days = (end_date - start_date).num_days() + 1;
            (start_date.and_hms_opt(0, 0, 0).unwrap_or(parsed), days * 1440)
        } else {
            let dur = parse_stored_time(end_raw)
                .map(|end| end.signed_duration_since(parsed).num_minutes())
                .filter(|m| *m > 0)
                .unwrap_or(0);
            (parsed, dur)
        };

        let rule = row
            .get("repeat_rule")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let until = row
            .get("repeat_until")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let (occurrences, cut) = expand_range(start, dur_min, rule, until, from, to);
        truncated |= cut;

        let completed = flag_of(row.get("completed")) != 0;
        for occ in occurrences {
            instances.push(json!({
                "event_id": event_id,
                "occ_key": occ.key(),
                "content": row.get("content").and_then(|v| v.as_str()).unwrap_or_default(),
                "start": occ.start.format("%Y-%m-%d %H:%M").to_string(),
                "end": occ.end.format("%Y-%m-%d %H:%M").to_string(),
                "all_day": all_day,
                // 首实例沿用原记录语义，虚拟实例只读（改期要落到整条重复规则）
                "is_virtual": occ.start != start,
                "completed": completed,
                "location": row.get("location").cloned().unwrap_or(JsonValue::Null),
                "description": row.get("description").cloned().unwrap_or(JsonValue::Null),
                "calendar_id": row.get("calendar_id").cloned().unwrap_or(JsonValue::Null),
                "status": row.get("status").cloned().unwrap_or(json!("busy")),
                "repeat_rule": rule,
                "alarms": alarms_by_event.get(event_id).cloned().unwrap_or_default(),
            }));
        }
    }

    instances.sort_by(|a, b| {
        a.get("start")
            .and_then(|v| v.as_str())
            .cmp(&b.get("start").and_then(|v| v.as_str()))
    });
    Ok((instances, truncated))
}

/// 导出用的**事件本体**列表（不展开重复项——对端日历自己会展开，
/// 把 5 年的每周一都写成 VEVENT 反而会让对方变成一堆无法编辑的孤立条目）。
/// 取数条件与 `collect_instances` 同一条 WHERE，两边看到的永远是同一批日程。
/// `pub` 只为集成测试能跑"库 → .ics → 库"的往返而不碰真实下载目录。
pub fn collect_export_events(
    db: &Arc<dyn DbApi>,
    from: NaiveDateTime,
    to: NaiveDateTime,
    calendar_filter: &str,
) -> Result<Vec<ics::IcsEvent>, PluginError> {
    let rows = db.query(
        "SELECT id, content, start_at, end_at, remind_at, all_day, location, description,
                calendar_id, status, repeat_rule, repeat_until, uid
         FROM todos
         WHERE (repeat_rule IS NOT NULL AND repeat_rule != '')
            OR (COALESCE(start_at, remind_at) IS NOT NULL
                AND COALESCE(start_at, remind_at) != ''
                AND COALESCE(start_at, remind_at) <= ?2
                AND COALESCE(end_at, COALESCE(start_at, remind_at)) >= ?1)
         ORDER BY COALESCE(start_at, remind_at) ASC",
        &[
            json!(from.format("%Y-%m-%d %H:%M").to_string()),
            json!(to.format("%Y-%m-%d %H:%M").to_string()),
        ],
    )?;

    let mut out = Vec::new();
    for row in rows {
        if !calendar_filter.is_empty()
            && row
                .get("calendar_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                != calendar_filter
        {
            continue;
        }
        let event_id = row.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let alarms = db
            .query(
                "SELECT minutes_before FROM event_alarms WHERE event_id = ?1 ORDER BY minutes_before ASC",
                &[json!(event_id)],
            )?
            .iter()
            .filter_map(|r| r.get("minutes_before").and_then(|v| v.as_i64()))
            .collect();
        let text = |key: &str| {
            row.get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        };
        out.push(ics::IcsEvent {
            // UID 缺失的老行（理论上回填已补齐）现生成一个：没有 UID 的条目
            // 导出去再导回来必然重复，宁可给它一个稳定身份。
            uid: text("uid").unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            summary: text("content").unwrap_or_default(),
            description: text("description"),
            location: text("location"),
            start: parse_stored_time(text("start_at").as_deref().unwrap_or_default())
                .or_else(|| parse_stored_time(text("remind_at").unwrap_or_default().as_str())),
            end: parse_stored_time(text("end_at").as_deref().unwrap_or_default()),
            all_day: flag_of(row.get("all_day")) != 0,
            status: if text("status").as_deref() == Some("free") { "free" } else { "busy" }.to_string(),
            repeat_rule: text("repeat_rule"),
            repeat_until: text("repeat_until"),
            alarms,
        });
    }
    Ok(out)
}

/// 导入落库：带 `existing_id` 就地改（UID 相同 = 同一条），否则新建。
/// 返回是否走了更新分支。
fn upsert_imported(
    db: &Arc<dyn DbApi>,
    existing_id: Option<&str>,
    ev: &ics::IcsEvent,
    calendar_id: &str,
    default_dur_min: i64,
) -> Result<bool, PluginError> {
    let fmt = |dt: NaiveDateTime| dt.format("%Y-%m-%d %H:%M").to_string();
    let content = ev.summary.trim();
    let content = if content.is_empty() { "（无标题日程）" } else { content };
    let start = ev.start.map(&fmt);
    // 导入的结束时间可能倒挂或缺失，交给默认时长兜底，别把整个文件卡住
    let end = match (ev.start, ev.end) {
        (Some(s), Some(e)) if e > s => Some(fmt(e)),
        (Some(s), _) => Some(fmt(s + Duration::minutes(if ev.all_day { 0 } else { default_dur_min }))),
        (None, _) => None,
    };
    let all_day = i64::from(ev.all_day);

    let id = match existing_id {
        Some(existing) => {
            db.execute(
                "UPDATE todos SET content=?1, start_at=?2, end_at=?3, remind_at=?2, all_day=?4,
                        location=?5, description=?6, calendar_id=?7, status=?8,
                        repeat_rule=?9, repeat_until=?10, notified=0
                 WHERE id=?11",
                &[
                    json!(content),
                    json!(start),
                    json!(end),
                    json!(all_day),
                    json!(ev.location),
                    json!(ev.description),
                    json!(calendar_id),
                    json!(ev.status),
                    json!(ev.repeat_rule),
                    json!(ev.repeat_until),
                    json!(existing),
                ],
            )?;
            existing.to_string()
        }
        None => {
            let new_id = uuid::Uuid::new_v4().to_string();
            db.execute(
                "INSERT INTO todos (id, content, remind_at, repeat_rule, completed, raw_input,
                                   created_at, notified, start_at, end_at, all_day, location,
                                   description, calendar_id, status, repeat_until, uid)
                 VALUES (?1,?2,?3,?4,0,'',?5,0,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                &[
                    json!(new_id),
                    json!(content),
                    json!(start),
                    json!(ev.repeat_rule),
                    json!(chrono::Utc::now().timestamp()),
                    json!(start),
                    json!(end),
                    json!(all_day),
                    json!(ev.location),
                    json!(ev.description),
                    json!(calendar_id),
                    json!(ev.status),
                    json!(ev.repeat_until),
                    json!(ev.uid),
                ],
            )?;
            new_id
        }
    };
    // 提醒整体替换：导入文件里的 VALARM 就是这条日程提醒的完整真相
    let mut alarms = ev.alarms.clone();
    alarms.sort_unstable();
    alarms.dedup();
    let payload = json!(alarms);
    replace_alarms(db, &id, &normalize_alarms(Some(&payload)))?;
    Ok(existing_id.is_some())
}

/// 导出文件落盘位置：系统下载目录，回退 home（`notes` 插件同一先例）
fn write_export_file(text: &str) -> Result<String, PluginError> {
    let mut dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| PluginError::internal("找不到可用的下载目录，无法写出 .ics 文件"))?;
    dir.push(format!(
        "liteLauncher-cal-{}.ics",
        Local::now().format("%Y%m%d-%H%M%S")
    ));
    std::fs::write(&dir, text).map_err(|e| PluginError::internal(format!("写入导出文件失败: {}", e)))?;
    Ok(dir.display().to_string())
}

/// 读用户敲定的 `.ics` 路径（`/cal import ~/downloads/plan.ics`）。
/// 只做 `~` / `file://` 的展开与大小上限——路径本身是用户给的，不做"越界"揣测。
fn read_input_file(raw: &str) -> Result<String, PluginError> {
    const MAX_IMPORT_BYTES: u64 = 8 * 1024 * 1024;
    let cleaned = raw.trim().trim_start_matches("file://");
    if cleaned.is_empty() {
        return Err(PluginError::bad_params("文件路径为空"));
    }
    let path = match cleaned.strip_prefix("~/").or_else(|| cleaned.strip_prefix("~\\")) {
        Some(tail) => {
            let mut p = dirs::home_dir().ok_or_else(|| PluginError::bad_params("找不到用户主目录"))?;
            p.push(tail);
            p
        }
        None => std::path::PathBuf::from(cleaned),
    };
    let meta = std::fs::metadata(&path)
        .map_err(|e| PluginError::internal(format!("读不到文件 {}: {}", path.display(), e)))?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(PluginError::bad_params("文件超过 8 MB，不像是一个 .ics"));
    }
    std::fs::read_to_string(&path)
        .map_err(|e| PluginError::internal(format!("读取 {} 失败（不是 UTF-8 文本？）: {}", path.display(), e)))
}

/// 单条日程全文（编辑器回填）。找不到返回 not_found 语义的错误而不是 null，
/// 让前端能区分"记录被别的窗口删了"和"接口没通"。
fn fetch_event(db: &Arc<dyn DbApi>, id: &str) -> Result<JsonValue, PluginError> {
    let row = db
        .query(
            "SELECT id, content, remind_at, start_at, end_at, all_day, location, description,
                    calendar_id, status, repeat_rule, repeat_until, completed, uid, raw_input
             FROM todos WHERE id = ?1",
            &[json!(id)],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| PluginError::bad_params(format!("未找到对应日程: {}", id)))?;
    let alarms: Vec<i64> = db
        .query(
            "SELECT minutes_before FROM event_alarms WHERE event_id = ?1 ORDER BY minutes_before DESC",
            &[json!(id)],
        )?
        .iter()
        .filter_map(|r| r.get("minutes_before").and_then(|v| v.as_i64()))
        .collect();
    let mut event = row;
    if let Some(obj) = event.as_object_mut() {
        obj.insert(
            "alarms".to_string(),
            JsonValue::Array(alarms.into_iter().map(|m| json!(m)).collect()),
        );
    }
    Ok(event)
}

/// 提醒列表整体替换：逐条 diff 既啰嗦又要在并发编辑下丢更新，
/// 单用户场景直接删干净重建。
fn replace_alarms(db: &Arc<dyn DbApi>, event_id: &str, minutes: &[i64]) -> Result<(), PluginError> {
    let alarm_ids: Vec<String> = db
        .query(
            "SELECT id FROM event_alarms WHERE event_id = ?1",
            &[json!(event_id)],
        )?
        .iter()
        .filter_map(|row| row.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    for alarm_id in &alarm_ids {
        db.execute("DELETE FROM alarm_fires WHERE alarm_id = ?1", &[json!(alarm_id)])?;
    }
    db.execute("DELETE FROM event_alarms WHERE event_id = ?1", &[json!(event_id)])?;
    for minute in minutes {
        db.execute(
            "INSERT INTO event_alarms (id, event_id, minutes_before) VALUES (?1, ?2, ?3)",
            &[
                json!(uuid::Uuid::new_v4().to_string()),
                json!(event_id),
                json!(minute),
            ],
        )?;
    }
    Ok(())
}

/// SQLite 的布尔列是 0/1，前端也可能直接传 JSON 布尔
fn flag_of(value: Option<&JsonValue>) -> i64 {
    match value {
        Some(JsonValue::Bool(b)) => i64::from(*b),
        Some(v) => v.as_i64().unwrap_or(0),
        None => 0,
    }
}

/// 入参提醒列表：去重、升上限护栏，避免前端塞进 200 条提醒把扫描拖慢。
/// 超出 `MAX_ALARMS` 时保留**离开始时间最近**的那些（升序截断）——提前一个月的
/// 提醒对个人日程基本没用，近期的才是用户真正会漏的。
/// 返回降序，与 `event_alarms ... ORDER BY minutes_before DESC` 的读回顺序一致，
/// 编辑器和日历拿到的是同一份顺序。
fn normalize_alarms(value: Option<&JsonValue>) -> Vec<i64> {
    let mut out: Vec<i64> = value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_i64())
                .filter(|m| (0..=MAX_ALARM_MINUTES).contains(m))
                .collect()
        })
        .unwrap_or_default();
    out.sort_unstable();
    out.dedup();
    out.truncate(MAX_ALARMS);
    out.reverse();
    out
}

fn normalize_repeat(raw: Option<&str>) -> Result<Option<String>, PluginError> {
    let Some(trimmed) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    canonical_repeat_rule(trimmed)
        .map(Some)
        .ok_or_else(|| PluginError::bad_params(
            "重复规则无效，支持 every:30min、every:2hour、every:1day、every:1week、every:1month、every:1year",
        ))
}

/// 用户输入的时间（可以是过去的：日历允许补记已发生的安排）
fn parse_event_time(raw: &str, now: NaiveDateTime) -> Option<NaiveDateTime> {
    parse_stored_time(raw).or_else(|| parse_remind_time(raw, now))
}

fn is_hex_color(raw: &str) -> bool {
    let Some(body) = raw.strip_prefix('#') else {
        return false;
    };
    (body.len() == 6 || body.len() == 3) && body.chars().all(|c| c.is_ascii_hexdigit())
}

// ───────────────────────────── 调度扫描 ─────────────────────────────

fn popup_duration(ctx: &PluginContext) -> u64 {
    ctx.settings
        .get(POPUP_DURATION_KEY)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(POPUP_DURATION_DEFAULT)
        .clamp(POPUP_DURATION_MIN, POPUP_DURATION_MAX)
}

/// 只给开始时间时的默认时长
fn default_duration(ctx: &PluginContext) -> i64 {
    ctx.settings
        .get(DEFAULT_DURATION_KEY)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_DURATION_DEFAULT)
        .clamp(DEFAULT_DURATION_MIN, DEFAULT_DURATION_MAX)
}

/// 扫描到期提醒并弹窗。三条规矩缺一不可：
/// - **幂等**：`alarm_fires` 的复合主键 `(alarm_id, occ_key)` + `INSERT … ON CONFLICT DO NOTHING`
///   的受影响行数，重启或同一 tick 重跑都不会重复弹；
/// - **漏发只记账**：错过超过 `FIRE_GRACE_SECS` 的（关机/睡眠）写表不弹，
///   否则开机一次性炸出十几条；
/// - **全天按 09:00 起算**：全天事项没有时刻，不然提醒全落在半夜。
///
/// 实例来自 `collect_instances`，与日历画的是同一套展开结果——
/// 老实现自持的 `remind_at` 重排逻辑因此不再需要（重复项由展开覆盖，
/// 而不是把锚点一路往前搬）。
///
/// `pub` 只为集成测试能拿真实 SQLite 驱动一遍触发；运行时唯一的调用者
/// 是插件自持的 20s 轮询线程（宿主没有调度器）。
pub fn fire_due(ctx: &PluginContext) -> Result<usize, PluginError> {
    let db = ctx
        .db
        .as_ref()
        .ok_or_else(|| PluginError::permission_denied("db"))?;

    let now = Local::now().naive_local();
    let popup_dur = popup_duration(ctx);
    purge_old_fires(ctx, db)?;

    let from = now - Duration::hours(LOOKBACK_HOURS);
    let to = now + Duration::days(LOOKAHEAD_DAYS);
    let (instances, _) = collect_instances(db, from, to, "")?;

    // (event_id, minutes_before) → alarm_id。记账挂在提醒行上，
    // 而 collect_instances 只把分钟数带回来，得在这里把这层对上。
    let mut alarm_ids: std::collections::BTreeMap<(String, i64), String> =
        std::collections::BTreeMap::new();
    for row in db.query("SELECT id, event_id, minutes_before FROM event_alarms", &[])? {
        if let (Some(alarm_id), Some(event_id), Some(minutes)) = (
            row.get("id").and_then(|v| v.as_str()),
            row.get("event_id").and_then(|v| v.as_str()),
            row.get("minutes_before").and_then(|v| v.as_i64()),
        ) {
            alarm_ids.insert((event_id.to_string(), minutes), alarm_id.to_string());
        }
    }

    let fired_at = Local::now().timestamp();
    let mut fired = 0;
    for inst in &instances {
        let completed = inst.get("completed").and_then(|v| v.as_bool()).unwrap_or(false);
        let minutes_list: Vec<i64> = match inst.get("alarms").and_then(|v| v.as_array()) {
            Some(arr) if !completed => arr.iter().filter_map(|v| v.as_i64()).collect(),
            _ => continue, // 已完成的事项不该留提醒，兜住脏数据
        };
        if minutes_list.is_empty() {
            continue;
        }

        let event_id = inst.get("event_id").and_then(|v| v.as_str()).unwrap_or_default();
        let occ_key = inst.get("occ_key").and_then(|v| v.as_str()).unwrap_or_default();
        let content = inst.get("content").and_then(|v| v.as_str()).unwrap_or_default();
        let Some(occ_start) = parse_stored_time(
            inst.get("start").and_then(|v| v.as_str()).unwrap_or_default(),
        ) else {
            continue;
        };
        let all_day = inst.get("all_day").and_then(|v| v.as_bool()).unwrap_or(false);

        for minutes in minutes_list {
            let Some(alarm_id) = alarm_ids.get(&(event_id.to_string(), minutes)) else {
                continue; // 提醒行刚被编辑器换过 id，这一次跳过即可
            };
            let anchor = if all_day {
                occ_start
                    .date()
                    .and_hms_opt(ALL_DAY_ALARM_HOUR, 0, 0)
                    .unwrap_or(occ_start)
            } else {
                occ_start
            };
            let fire_at = anchor - Duration::minutes(minutes);
            if fire_at > now {
                continue; // 未到点
            }

            let claimed = db.execute(
                "INSERT INTO alarm_fires (alarm_id, occ_key, fired_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT DO NOTHING",
                &[json!(alarm_id), json!(occ_key), json!(fired_at)],
            )?;
            if claimed == 0 {
                continue; // 已触发过
            }

            let late_secs = (now - fire_at).num_seconds();
            if late_secs > FIRE_GRACE_SECS {
                ctx.log.log(
                    "info",
                    &format!(
                        "提醒错过过久，仅补记账 id={} occ={} 提前{}分 迟到{}秒",
                        event_id, occ_key, minutes, late_secs
                    ),
                );
                continue;
            }

            // 桌面右下角弹窗：id 取"事件 × 实例 × 提前量"，各占一个窗
            if let Some(windows) = &ctx.windows {
                let _ = windows.open(
                    "reminder",
                    &[
                        (
                            "id".to_string(),
                            reminder_slot_id(event_id, occ_key, minutes),
                        ),
                        ("content".to_string(), content.to_string()),
                        ("dur".to_string(), popup_dur.to_string()),
                    ],
                );
            }

            // 系统级通知（失败静默，不影响弹窗）
            if let Some(notify) = &ctx.notify {
                if let Err(e) = notify.send("LiteLauncher 日程提醒", content) {
                    ctx.log
                        .log("warn", &format!("系统通知失败 id={}: {}", event_id, e));
                }
            }
            ctx.log.log(
                "info",
                &format!("提醒已触发 id={} occ={} 提前{}分", event_id, occ_key, minutes),
            );
            fired += 1;
        }
    }
    Ok(fired)
}

/// 提醒窗的 `unique_by` 值。宿主 `sanitize_label` 只保留 ASCII 字母数字再拼整串哈希，
/// 冒号空格都会被吃掉，这里先把实例键压平，让窗口标签读起来还有形。
fn reminder_slot_id(event_id: &str, occ_key: &str, minutes_before: i64) -> String {
    let flat: String = occ_key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    format!("{event_id}-{flat}-{minutes_before}min")
}

/// 触发记账只为短期幂等服务，90 天前的记录没人再比对。
/// 用 settings 记最后清理日，避免 20s 一跳都跑一遍 DELETE。
fn purge_old_fires(ctx: &PluginContext, db: &Arc<dyn DbApi>) -> Result<(), PluginError> {
    let today = Local::now().format("%Y-%m-%d").to_string();
    if ctx.settings.get(PURGE_KEY).as_deref() == Some(today.as_str()) {
        return Ok(());
    }
    let cutoff = Local::now().timestamp() - FIRES_RETENTION_DAYS * 24 * 3600;
    let removed = db.execute(
        "DELETE FROM alarm_fires WHERE fired_at < ?1",
        &[json!(cutoff)],
    )?;
    ctx.settings.set(PURGE_KEY, &today)?;
    if removed > 0 {
        ctx.log
            .log("info", &format!("清理提醒记账 {} 行", removed));
    }
    Ok(())
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
//
// 重复规则的解析与推进已上移到 `recur.rs`（日历视图与提醒调度要用同一套语义）。

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

/// 解析**已入库**的时间串。与 `parse_remind_time` 不同：这里不做"已过则顺延明天"
/// 的语义，纯日期一律按 00:00 处理，因为它读的是历史数据而不是用户输入。
fn parse_stored_time(raw: &str) -> Option<NaiveDateTime> {
    let s = raw.trim().replace('T', " ");
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S") {
        return Some(dt);
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M") {
        return Some(dt);
    }
    NaiveDate::parse_from_str(&s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
}

/// 解析区间端点：纯日期按整日取边界（起点 00:00:00 / 终点 23:59:59）
fn parse_range_endpoint(raw: &str, is_end: bool) -> Option<NaiveDateTime> {
    let s = raw.trim().replace('T', " ");
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M") {
        return Some(dt);
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(&s, "%Y-%m-%d %H:%M:%S") {
        return Some(dt);
    }
    let tail = if is_end { (23, 59, 59) } else { (0, 0, 0) };
    NaiveDate::parse_from_str(&s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(tail.0, tail.1, tail.2))
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

    fn cols(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    /// v1 建库语句留下的列（宿主 migration.rs 搬来的老库就是这个形状）
    const LEGACY_COLS: &[&str] = &[
        "id",
        "content",
        "remind_at",
        "repeat_rule",
        "completed",
        "raw_input",
        "created_at",
        "notified",
    ];

    #[test]
    fn fresh_install_creates_full_table_in_one_shot() {
        let stmts = schema_stmts_for(&cols(&[]));
        assert_eq!(stmts.len(), 5);
        assert!(stmts[0].contains("CREATE TABLE IF NOT EXISTS todos"));
        assert!(!stmts.iter().any(|s| s.starts_with("ALTER")));
    }

    /// 老库升级必须补满 9 列；而第二次启动（列已齐）一条 ALTER 都不能再发——
    /// `migrate()` 是 execute_batch，重复列名会让整个 `init()` 失败。
    #[test]
    fn legacy_upgrade_adds_all_columns_then_is_idempotent() {
        let first = schema_stmts_for(&cols(LEGACY_COLS));
        let alters: Vec<&&str> = first.iter().filter(|s| s.starts_with("ALTER")).collect();
        assert_eq!(alters.len(), TODOS_V2_COLUMNS.len());

        let after: HashSet<String> = LEGACY_COLS
            .iter()
            .map(|s| s.to_string())
            .chain(TODOS_V2_COLUMNS.iter().map(|(c, _)| c.to_string()))
            .collect();
        let second = schema_stmts_for(&after);
        assert!(
            second.iter().all(|s| !s.starts_with("ALTER")),
            "第二次启动仍在补列: {:?}",
            second
        );
        assert_eq!(second.len(), 4);
    }

    /// 新装 CREATE 与老库 ALTER 两条路径必须得到同一份列集，否则查询会撞上不存在的列
    #[test]
    fn create_and_alter_paths_agree_on_columns() {
        for (column, _) in TODOS_V2_COLUMNS {
            assert!(
                CREATE_TODOS_V2.contains(column),
                "CREATE_TODOS_V2 缺列 {}",
                column
            );
        }
    }

    #[test]
    fn stored_time_parser_is_strict_and_keeps_date_only_at_midnight() {
        assert_eq!(
            parse_stored_time("2026-10-14 09:30").unwrap(),
            NaiveDate::from_ymd_opt(2026, 10, 14)
                .unwrap()
                .and_hms_opt(9, 30, 0)
                .unwrap()
        );
        assert_eq!(
            parse_stored_time("2026-10-14").unwrap(),
            NaiveDate::from_ymd_opt(2026, 10, 14)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
        );
        assert!(parse_stored_time("").is_none());
        assert!(parse_stored_time("明天 9 点").is_none());
    }

    #[test]
    fn range_endpoint_of_date_only_window_is_end_of_day() {
        let d = NaiveDate::from_ymd_opt(2026, 10, 14).unwrap();
        assert_eq!(
            parse_range_endpoint("2026-10-14", false).unwrap(),
            d.and_hms_opt(0, 0, 0).unwrap()
        );
        assert_eq!(
            parse_range_endpoint("2026-10-14", true).unwrap(),
            d.and_hms_opt(23, 59, 59).unwrap()
        );
    }

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
    fn reminder_slot_id_is_unique_per_occurrence_and_alarm() {
        // 窗口标签的唯一性靠这个串，实例或提前量任一不同就不能撞窗
        let a = reminder_slot_id("evt", "2026-10-15 14:30", 10);
        let b = reminder_slot_id("evt", "2026-10-15 14:30", 30);
        let c = reminder_slot_id("evt", "2026-10-16 14:30", 10);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a, "evt-202610151430-10min");
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
