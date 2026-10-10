use crate::db::DbState;
use crate::log_lifecycle;
use crate::notes::urlencoding_simple;
use chrono::{Duration, Local, NaiveDate, NaiveDateTime, NaiveTime};
use rusqlite::params;
use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

/// 提醒弹窗逻辑尺寸（逻辑像素）
const POPUP_WIDTH: f64 = 360.0;
const POPUP_HEIGHT: f64 = 148.0;
/// 弹窗距屏幕右/下边缘的边距（逻辑像素）
const POPUP_MARGIN: f64 = 16.0;
/// 弹窗自动关闭时长（秒）；前端 12 秒主动关，此处为兜底
const POPUP_FALLBACK_CLOSE_SECS: u64 = 20;

/// 解析提醒时间文本为本地时间（NaiveDateTime）
///
/// 支持三种格式：
/// - `YYYY-MM-DD HH:MM[:SS]`（`T` 亦可作日期与时间的分隔符）
/// - `YYYY-MM-DD` → 当天 09:00
/// - `HH:MM[:SS]` → 今天该时刻，若已过去则顺延到明天
pub fn parse_remind_time(raw: &str, now: NaiveDateTime) -> Option<NaiveDateTime> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    // 完整日期时间
    let normalized = raw.replace('T', " ");
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(&normalized, fmt) {
            return Some(dt);
        }
    }

    // 仅日期 → 当天 09:00
    if let Ok(date) = NaiveDate::parse_from_str(&normalized, "%Y-%m-%d") {
        return date.and_hms_opt(9, 0, 0);
    }

    // 仅时间 → 今天，已过则明天
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

/// 在桌面右下角弹出提醒小窗口（无边框、置顶、不抢焦点、不进任务栏）
///
/// 调度线程不在主线程，窗口创建必须派发回主线程执行（否则部分平台死锁/panic）
fn show_reminder_popup(app: &AppHandle, id: &str, content: &str) {
    let dispatcher = app.clone();
    let handle = app.clone();
    let id = id.to_string();
    let content = content.to_string();
    let _ = dispatcher.run_on_main_thread(move || {
        if let Err(e) = create_reminder_window(&handle, &id, &content) {
            log_lifecycle(&format!("Reminder popup error id={}: {}", id, e));
        }
    });
}

fn create_reminder_window(app: &AppHandle, id: &str, content: &str) -> Result<(), String> {
    let label = format!("reminder-{}", id.replace(['-', ' '], ""));

    // 同一待办重复触发时先关旧窗，避免叠加
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
    }

    // 多条提醒同时到达时向上堆叠，避免完全重叠
    let stack_offset = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with("reminder-"))
        .count() as f64
        * (POPUP_HEIGHT + 8.0);

    let target_url = format!(
        "index.html?view=reminder&id={}&content={}",
        urlencoding_simple(id),
        urlencoding_simple(content)
    );

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(target_url.into()))
        .title("LiteLauncher 待办提醒")
        .inner_size(POPUP_WIDTH, POPUP_HEIGHT)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| format!("创建提醒弹窗失败: {}", e))?;

    // 定位到主显示器右下角（逻辑坐标，随 DPI 缩放）
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let mon_logical = monitor.size().to_logical::<f64>(monitor.scale_factor());
        let _ = window.set_position(LogicalPosition::new(
            mon_logical.width - POPUP_WIDTH - POPUP_MARGIN,
            mon_logical.height - POPUP_HEIGHT - POPUP_MARGIN - stack_offset,
        ));
    }

    let _ = window.show();

    // 兜底关闭：前端 JS 因异常未能自动关闭时，防止弹窗永久残留
    let app_for_close = app.clone();
    let label_for_close = label.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(POPUP_FALLBACK_CLOSE_SECS));
        if let Some(w) = app_for_close.get_webview_window(&label_for_close) {
            let _ = w.close();
        }
    });

    Ok(())
}

/// 扫描到期待办并发送系统通知，返回本次触发的条数
fn fire_due_reminders(app: &AppHandle) -> Result<usize, String> {
    let Some(state) = app.try_state::<DbState>() else {
        return Ok(0);
    };
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = Local::now().naive_local();

    let due: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, content, remind_at FROM todos
                 WHERE completed = 0 AND notified = 0
                   AND remind_at IS NOT NULL AND remind_at != ''",
            )
            .map_err(|e| e.to_string())?;

        let mapper = |row: &rusqlite::Row| -> rusqlite::Result<(String, String, String)> {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        };
        let rows = stmt.query_map([], mapper).map_err(|e| e.to_string())?;

        rows.flatten()
            .filter_map(|(id, content, remind_at)| {
                parse_remind_time(&remind_at, now)
                    .filter(|dt| *dt <= now)
                    .map(|_| (id, content))
            })
            .collect()
    };

    let mut fired = 0;
    for (id, content) in due {
        // 1. 桌面右下角弹窗（应用自绘，不依赖系统通知守护进程）
        show_reminder_popup(app, &id, &content);

        // 2. 系统级通知（进入系统通知中心留存历史；无守护进程时静默失败，不影响弹窗）
        let result = app
            .notification()
            .builder()
            .title("LiteLauncher 待办提醒")
            .body(&content)
            .show();
        log_lifecycle(&format!(
            "Reminder fired id={} content={} notify_result={:?}",
            id, content, result
        ));

        conn.execute(
            "UPDATE todos SET notified = 1 WHERE id = ?1",
            params![&id],
        )
        .map_err(|e| format!("标记已通知失败: {}", e))?;
        fired += 1;
    }

    Ok(fired)
}

/// 启动后台提醒调度线程：每 20 秒扫描一次到期待办并弹系统通知。
/// 主窗口隐藏（启动器常驻托盘）时提醒依然有效。
pub fn spawn_reminder_scheduler(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(20));
        if let Err(e) = fire_due_reminders(&app) {
            log_lifecycle(&format!("Reminder check error: {}", e));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now_fixture() -> NaiveDateTime {
        Local.with_ymd_and_hms(2026, 10, 10, 15, 0, 0)
            .unwrap()
            .naive_local()
    }

    #[test]
    fn parses_full_datetime() {
        let parsed = parse_remind_time("2026-10-11 08:30", now_fixture()).unwrap();
        assert_eq!(parsed.to_string(), "2026-10-11 08:30:00");
    }

    #[test]
    fn parses_datetime_with_t_separator_and_seconds() {
        assert_eq!(
            parse_remind_time("2026-10-11T08:30:45", now_fixture())
                .unwrap()
                .to_string(),
            "2026-10-11 08:30:45"
        );
    }

    #[test]
    fn parses_date_defaults_to_9am() {
        assert_eq!(
            parse_remind_time("2026-10-12", now_fixture())
                .unwrap()
                .to_string(),
            "2026-10-12 09:00:00"
        );
    }

    #[test]
    fn bare_time_today_if_future_else_tomorrow() {
        // 18:00 晚于基准 15:00 → 今天
        assert_eq!(
            parse_remind_time("18:00", now_fixture())
                .unwrap()
                .to_string(),
            "2026-10-10 18:00:00"
        );
        // 09:00 早于基准 15:00 → 顺延明天
        assert_eq!(
            parse_remind_time("09:00", now_fixture())
                .unwrap()
                .to_string(),
            "2026-10-11 09:00:00"
        );
    }

    #[test]
    fn rejects_garbage_and_empty() {
        assert!(parse_remind_time("明天下午", now_fixture()).is_none());
        assert!(parse_remind_time("", now_fixture()).is_none());
        assert!(parse_remind_time("25:00", now_fixture()).is_none());
    }
}
