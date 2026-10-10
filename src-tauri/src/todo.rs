use crate::db::DbState;
use crate::reminder::parse_remind_time;
use chrono::{Datelike, Duration, Local, Months, NaiveDateTime, Weekday};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TodoItem {
    pub id: String,
    pub content: String,
    pub remind_at: Option<String>,
    pub repeat_rule: Option<String>,
    pub completed: bool,
    pub raw_input: String,
    pub created_at: i64,
}

/// 解析重复规则为 (间隔数, 单位)，单位: i=分钟 h=小时 d=天 w=周 m=月
///
/// 支持语法：
/// - `every:30min` / `repeat:2hour` / `every:1day` / `every:1week` / `every:3month`
///   （单位可简写：min/h/d/w/mo，m 按月处理，分钟请用 min）
/// - 内置关键词：`daily`（每天）、`weekly`（每周）、`mon`..`sun`（每周指定星期）
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

/// 规范化提醒时间输入：
/// - `HH:MM` → 今天该时刻，已过则顺延明天
/// - `YYYY-MM-DD` → 当天 09:00
/// - `YYYY-MM-DD HH:MM` → 精确时刻（早于当前时间则报错）
/// 返回标准存储格式 `YYYY-MM-DD HH:MM`
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
/// - 重复规则必须搭配提醒时间；返回 (规范时间, 规范规则, 时间是否发生变化)
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

    // 星期锚定：仅当时间输入是纯 HH:MM（含 ':' 不含 '-'）且解析为今天/明天时，
    // 把日期调整到下一个匹配的星期
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

/// 创建新待办事项
#[tauri::command]
pub fn create_todo(
    state: State<'_, DbState>,
    content: String,
    remind_at: Option<String>,
    repeat_rule: Option<String>,
    raw_input: String,
) -> Result<TodoItem, String> {
    let clean_content = content.trim();
    if clean_content.is_empty() {
        return Err("待办内容不能为空".into());
    }

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();

    let (remind_at, repeat_canonical, _) =
        finalize_schedule(remind_at.as_deref(), repeat_rule.as_deref(), None)?;

    conn.execute(
        "INSERT INTO todos (id, content, remind_at, repeat_rule, completed, raw_input, created_at, notified)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
        rusqlite::params![
            &id,
            clean_content,
            &remind_at,
            &repeat_canonical,
            0,
            &raw_input,
            now
        ],
    )
    .map_err(|e| format!("写入待办失败: {}", e))?;

    Ok(TodoItem {
        id,
        content: clean_content.to_string(),
        remind_at,
        repeat_rule: repeat_canonical,
        completed: false,
        raw_input,
        created_at: now,
    })
}

/// 查询待办列表（未完成排在最前，按创建时间倒序）
#[tauri::command]
pub fn list_todos(
    state: State<'_, DbState>,
    keyword: Option<String>,
) -> Result<Vec<TodoItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let filter = keyword.unwrap_or_default().trim().to_lowercase();
    let query_sql = if filter.is_empty() {
        "SELECT id, content, remind_at, repeat_rule, completed, raw_input, created_at
         FROM todos ORDER BY completed ASC, created_at DESC"
    } else {
        "SELECT id, content, remind_at, repeat_rule, completed, raw_input, created_at
         FROM todos WHERE LOWER(content) LIKE ?1 ORDER BY completed ASC, created_at DESC"
    };

    let mut stmt = conn.prepare(query_sql).map_err(|e| e.to_string())?;
    let like_pattern = format!("%{}%", filter);

    let mapper = |row: &rusqlite::Row| -> rusqlite::Result<TodoItem> {
        let completed_int: i32 = row.get(4)?;
        Ok(TodoItem {
            id: row.get(0)?,
            content: row.get(1)?,
            remind_at: row.get(2)?,
            repeat_rule: row.get(3)?,
            completed: completed_int != 0,
            raw_input: row.get(5)?,
            created_at: row.get(6)?,
        })
    };

    let mut list = Vec::new();
    if filter.is_empty() {
        let rows = stmt.query_map([], mapper).map_err(|e| e.to_string())?;
        for item in rows {
            if let Ok(todo) = item {
                list.push(todo);
            }
        }
    } else {
        let rows = stmt.query_map([&like_pattern], mapper).map_err(|e| e.to_string())?;
        for item in rows {
            if let Ok(todo) = item {
                list.push(todo);
            }
        }
    }

    Ok(list)
}

/// 切换待办完成状态
#[tauri::command]
pub fn toggle_todo(state: State<'_, DbState>, id: String) -> Result<bool, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let current: i32 = conn
        .query_row(
            "SELECT completed FROM todos WHERE id = ?1",
            rusqlite::params![&id],
            |row| row.get(0),
        )
        .map_err(|e| format!("未找到对应待办: {}", e))?;

    let new_state = if current == 0 { 1 } else { 0 };

    conn.execute(
        "UPDATE todos SET completed = ?1 WHERE id = ?2",
        rusqlite::params![new_state, &id],
    )
    .map_err(|e| format!("更新待办失败: {}", e))?;

    Ok(new_state != 0)
}

/// 删除待办事项
#[tauri::command]
pub fn delete_todo(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM todos WHERE id = ?1", rusqlite::params![&id])
        .map_err(|e| format!("删除待办失败: {}", e))?;
    Ok(())
}

/// 修改待办内容 / 提醒时间 / 重复规则（管理面板用）
///
/// 时间字段未修改时原值保留（允许保留已触发过的历史时间）；
/// 时间发生变化时重置 notified 标记，调度器会按新时间重新提醒
#[tauri::command]
pub fn update_todo(
    state: State<'_, DbState>,
    id: String,
    content: String,
    remind_at: Option<String>,
    repeat_rule: Option<String>,
) -> Result<TodoItem, String> {
    let clean_content = content.trim();
    if clean_content.is_empty() {
        return Err("待办内容不能为空".into());
    }

    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let (existing_remind, existing_notified): (Option<String>, i32) = conn
        .query_row(
            "SELECT remind_at, notified FROM todos WHERE id = ?1",
            rusqlite::params![&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("未找到对应待办: {}", e))?;

    let (remind_at, repeat_canonical, time_changed) =
        finalize_schedule(remind_at.as_deref(), repeat_rule.as_deref(), existing_remind)?;

    conn.execute(
        "UPDATE todos SET content = ?1, remind_at = ?2, repeat_rule = ?3, notified = ?4
         WHERE id = ?5",
        rusqlite::params![
            clean_content,
            &remind_at,
            &repeat_canonical,
            if time_changed { 0 } else { existing_notified },
            &id
        ],
    )
    .map_err(|e| format!("更新待办失败: {}", e))?;

    let completed: i32 = conn
        .query_row(
            "SELECT completed FROM todos WHERE id = ?1",
            rusqlite::params![&id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(TodoItem {
        id,
        content: clean_content.to_string(),
        remind_at,
        repeat_rule: repeat_canonical,
        completed: completed != 0,
        raw_input: String::new(),
        created_at: 0,
    })
}

/// 打开待办管理面板窗口（/todo app）
///
/// 与编辑器窗口同理声明为 async：避免同步命令在主线程创建窗口造成事件循环死锁
#[tauri::command]
pub async fn open_todo_manager(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("todo-manager") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        &app,
        "todo-manager",
        WebviewUrl::App("index.html?view=todoapp".into()),
    )
    .title("LiteLauncher - 待办管理")
    .inner_size(580.0, 680.0)
    .min_inner_size(480.0, 520.0)
    .resizable(true)
    .center()
    .build()
    .map_err(|e| format!("创建待办管理窗口失败: {}", e))?;

    Ok(())
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
        let base = Local.with_ymd_and_hms(2026, 10, 10, 15, 0, 0)
            .unwrap()
            .naive_local();
        // 基准时间逐段推进到严格晚于 now
        let next = next_occurrence(base, "every:30min", base).unwrap();
        assert_eq!(next.to_string(), "2026-10-10 15:30:00");
        // 错过 3 个周期 → 直接跳到下一个未来时刻
        let late_now = base + Duration::hours(2);
        let next = next_occurrence(base, "every:1hour", late_now).unwrap();
        assert_eq!(next.to_string(), "2026-10-10 18:00:00");
        // 月度日历推进（月末安全）
        let jan31 = Local.with_ymd_and_hms(2026, 1, 31, 9, 0, 0)
            .unwrap()
            .naive_local();
        let next = next_occurrence(jan31, "every:1month", jan31).unwrap();
        assert_eq!(next.to_string(), "2026-02-28 09:00:00");
    }
}
