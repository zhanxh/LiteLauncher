//! `.ics` 导入导出（Stage 5）：走"库 → 文本 → 库"的完整往返
//!
//! 导出落盘要写系统下载目录，测试不碰真实文件系统；
//! 这里直接调 `collect_export_events` + `ics::render` 拿到同一份文本，
//! 再喂回 `import_ics`——用户实际得到的字节序列与断言的字节序列一致。

#![cfg(test)]

mod common;

use chrono::{NaiveDate, NaiveDateTime};
use common::{count, ctx_with, upgraded, Shared};
use std::sync::Arc;
use ll_plugin_api::PluginBackend;
use serde_json::json;

fn day(y: i32, m: u32, d: u32, hh: u32, mi: u32) -> NaiveDateTime {
    NaiveDate::from_ymd_opt(y, m, d)
        .unwrap()
        .and_hms_opt(hh, mi, 0)
        .unwrap()
}

fn exported(shared: &Shared, from: NaiveDateTime, to: NaiveDateTime) -> String {
    let ctx = ctx_with(Arc::clone(shared));
    let db = ctx.db.as_ref().expect("测试 ctx 应带 db");
    let events = ll_plugin_todo::collect_export_events(db, from, to, "").expect("导出取数失败");
    ll_plugin_todo::ics::render(&events, "20261015T000000Z")
}

#[test]
fn export_covers_the_window_and_import_round_trips_by_uid() {
    let (plugin, shared) = upgraded();
    plugin
        .call(
            "save",
            json!({
                "content": "评审会",
                "start_at": "2026-10-20 14:00",
                "end_at": "2026-10-20 15:30",
                "location": "会议室 A",
                "description": "带原型",
                "status": "free",
                "alarms": [10, 30],
                "repeat_rule": "every:2week",
            }),
        )
        .unwrap();
    plugin
        .call(
            "save",
            json!({"content": "出差", "start_at": "2026-10-12", "end_at": "2026-10-15", "all_day": true}),
        )
        .unwrap();

    let text = exported(&shared, day(2026, 10, 1, 0, 0), day(2026, 10, 31, 23, 59));
    assert!(text.contains("BEGIN:VCALENDAR"), "导出必须是合法 .ics 头：{text}");
    assert_eq!(text.matches("BEGIN:VEVENT").count(), 2, "两条日程各一个 VEVENT");
    assert!(text.contains("DTSTART;VALUE=DATE:20261012"));
    assert!(text.contains("DTEND;VALUE=DATE:20261016"), "全天结束日不含端点：{text}");
    assert!(text.contains("SUMMARY:评审会"));
    assert!(text.contains("TRANSP:TRANSPARENT"), "空闲事项要带出去");
    assert!(text.contains("TRIGGER:-PT10M") && text.contains("TRIGGER:-PT30M"), "两条提醒各一个 VALARM：{text}");
    assert!(text.contains("RRULE:FREQ=WEEKLY;INTERVAL=2"));

    // 导入回同一套库：UID 命中已有记录 → 全部走更新，不产生副本
    let res = plugin
        .call("import_ics", json!({ "text": text }))
        .expect("import_ics 失败");
    assert_eq!(res["added"], json!(0), "同 UID 不该新建副本：{res}");
    assert_eq!(res["updated"], json!(2));
    assert_eq!(count(&shared.lock().unwrap(), "todos"), 2, "两次导入都不该多出副本");

    // 再导一次仍然幂等
    let again = plugin.call("import_ics", json!({ "text": text })).unwrap();
    assert_eq!(again["added"], json!(0));
    assert_eq!(again["updated"], json!(2));
}

#[test]
fn import_of_foreign_file_lands_in_the_default_calendar_with_alarms() {
    let (plugin, shared) = upgraded();
    let text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ext-1@other\r\n\
                SUMMARY:外部日程\r\nDTSTART:20261022T090000\r\nDTEND:20261022T100000\r\n\
                RRULE:FREQ=MONTHLY;UNTIL=20261231T155900Z\r\n\
                BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:remind\r\nTRIGGER:-P2D\r\nEND:VALARM\r\n\
                END:VEVENT\r\nEND:VCALENDAR\r\n";
    let res = plugin.call("import_ics", json!({ "text": text })).unwrap();
    assert_eq!(res["added"], json!(1));

    let rows = plugin
        .call("query_range", json!({"from": "2026-10-01", "to": "2026-10-31"}))
        .unwrap();
    let inst = rows.get("instances").unwrap().as_array().unwrap();
    let ext: Vec<&serde_json::Value> = inst
        .iter()
        .filter(|i| i.get("content").and_then(|v| v.as_str()) == Some("外部日程"))
        .collect();
    assert_eq!(ext.len(), 1, "10 月内应展开出一次：{ext:?}");
    assert_eq!(ext[0]["start"], json!("2026-10-22 09:00"));
    assert_eq!(ext[0]["alarms"], json!([2880]), "VALARM 的 -P2D 落成 2880 分钟");
    assert_eq!(ext[0]["calendar_id"], json!("default"), "缺省挂到默认分类");
    assert_eq!(count(&shared.lock().unwrap(), "event_alarms"), 1);

    // UNTIL 落到本地裸串，重复截止语义跟着进来
    let ev = plugin
        .call("get_event", json!({"id": ext[0]["event_id"]}))
        .unwrap();
    assert_eq!(ev["repeat_rule"], json!("every:1month"));
    assert!(
        ev["repeat_until"].as_str().unwrap().starts_with("2026-12-3"),
        "UNTIL 换算到本地：{}",
        ev["repeat_until"]
    );
}

#[test]
fn import_rejects_garbage_and_counts_rows_without_uid() {
    let (plugin, _shared) = upgraded();
    assert!(plugin.call("import_ics", json!({"text": ""})).is_err(), "空文本要报错");
    assert!(plugin
        .call("import_ics", json!({"text": "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"}))
        .is_err());

    // 没有 UID 的条目认不出"同一条"，只能跳过而不是每次都插一份
    let text = "BEGIN:VEVENT\r\nSUMMARY:无身份\r\nDTSTART:20261022T090000\r\nEND:VEVENT\r\n";
    let res = plugin.call("import_ics", json!({ "text": text })).unwrap();
    assert_eq!(res["skipped"], json!(1));
    assert_eq!(res["added"], json!(0));
}

#[test]
fn long_chinese_titles_survive_the_file() {
    let (plugin, shared) = upgraded();
    let title = "非常长的日程标题".repeat(8);
    plugin
        .call(
            "save",
            json!({"content": title, "start_at": "2026-10-21 09:00"}),
        )
        .unwrap();
    let text = exported(&shared, day(2026, 10, 1, 0, 0), day(2026, 10, 31, 23, 59));
    // 折行后按 CRLF + 前导空格拼回，再导入应逐字符还原
    let res = plugin.call("import_ics", json!({ "text": text })).unwrap();
    assert_eq!(res["updated"], json!(1), "长标题折行后仍要认出同一条：{res}");
    let rows = plugin
        .call("query_range", json!({"from": "2026-10-21", "to": "2026-10-21"}))
        .unwrap();
    let inst = rows.get("instances").unwrap().as_array().unwrap();
    let mine = inst
        .iter()
        .find(|i| i.get("content").and_then(|v| v.as_str()).is_some_and(|c| c.chars().count() > 40))
        .expect("折行往返后标题不能变短");
    assert_eq!(mine["content"], json!(title));
}
