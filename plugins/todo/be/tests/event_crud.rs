//! 日程 CRUD、分类日历与冲突检测：Stage 2 新增的后端入口
//!
//! 这些路径单测碰不到——它们依赖真实列类型、`ON CONFLICT` 行为与跨表删除顺序。

#![cfg(test)]

mod common;

use common::upgraded;
use ll_plugin_api::PluginBackend;
use serde_json::{json, Value as JsonValue};

fn first(arr: &JsonValue, key: &str) -> Option<String> {
    arr.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

#[test]
fn save_creates_timed_event_with_default_duration_and_alarms() {
    let (plugin, _db) = upgraded();
    let saved = plugin
        .call(
            "save",
            json!({
                "content": "评审会",
                "start_at": "2026-10-20 14:00",
                "alarms": [30, 0, 30, 43201],
                "location": " 会议室 A ",
                "status": "free",
            }),
        )
        .unwrap();

    assert_eq!(
        first(&saved, "id").map(|s| s.len()),
        Some(36),
        "save 应返回带 id 的完整事件"
    );
    assert_eq!(first(&saved, "end_at").as_deref(), Some("2026-10-20 15:00"), "默认时长 60 分钟");
    assert_eq!(first(&saved, "location").as_deref(), Some("会议室 A"), "首尾空白要清掉");
    assert_eq!(first(&saved, "status").as_deref(), Some("free"));
    assert_eq!(first(&saved, "calendar_id").as_deref(), Some("default"), "缺省归到默认分类");
    // 提醒：越界(>30 天)丢弃、去重，降序输出与读回顺序一致
    assert_eq!(saved["alarms"], json!([30, 0]), "提醒需去重并剔除越界值");
    assert_eq!(saved["uid"].as_str().map(str::len), Some(36), "新建即带 .ics UID");
    // remind_at 仍跟着 start_at：老清单视图与 legacy `update` 路径读的是这一列
    assert_eq!(first(&saved, "remind_at").as_deref(), Some("2026-10-20 14:00"));
}

#[test]
fn save_all_day_clamps_times_to_midnight() {
    let (plugin, _db) = upgraded();
    let saved = plugin
        .call(
            "save",
            json!({"content": "出差", "start_at": "2026-10-20 14:00", "end_at": "2026-10-23", "all_day": true}),
        )
        .unwrap();
    assert_eq!(first(&saved, "start_at").as_deref(), Some("2026-10-20 00:00"));
    assert_eq!(first(&saved, "end_at").as_deref(), Some("2026-10-23 00:00"));
    assert_eq!(saved["all_day"], json!(1));
}

#[test]
fn save_reversed_span_falls_back_to_default_length() {
    let (plugin, _db) = upgraded();
    // 倒挂（结束早于开始）不该报错打断编辑，也不该存成零时长
    let saved = plugin
        .call(
            "save",
            json!({"content": "写反了", "start_at": "2026-10-20 16:00", "end_at": "2026-10-20 09:00"}),
        )
        .unwrap();
    assert_eq!(first(&saved, "end_at").as_deref(), Some("2026-10-20 17:00"));
}

#[test]
fn save_updates_in_place_and_replaces_alarms() {
    let (plugin, db) = upgraded();
    let created = plugin
        .call(
            "save",
            json!({"content": "周会", "start_at": "2026-10-19 09:00", "repeat_rule": "weekly", "alarms": [10, 30]}),
        )
        .unwrap();
    let id = first(&created, "id").unwrap();
    assert_eq!(first(&created, "repeat_rule").as_deref(), Some("every:1week"), "关键词要规范化后落库");

    let edited = plugin
        .call(
            "save",
            json!({"id": id, "content": "双周会", "start_at": "2026-10-19 10:00", "alarms": [5]}),
        )
        .unwrap();
    assert_eq!(first(&edited, "id").as_deref(), Some(id.as_str()), "带 id 就是改，不该新建");
    assert_eq!(edited["alarms"], json!([5]), "提醒整表替换");
    assert_eq!(first(&edited, "start_at").as_deref(), Some("2026-10-19 10:00"));

    let c = db.lock().unwrap();
    assert_eq!(common::count(&c, "todos"), 1, "编辑不能长出第二行");
    assert_eq!(common::count(&c, "event_alarms"), 1);
    drop(c);

    // 不存在的 id 要被拒，而不是静默新建
    assert!(plugin
        .call("save", json!({"id": "nope", "content": "x", "start_at": "2026-10-20 09:00"}))
        .is_err());
    // 空标题与坏时间/坏规则都要报错，别把脏数据写进去
    assert!(plugin.call("save", json!({"content": "  ", "start_at": "2026-10-20 09:00"})).is_err());
    assert!(plugin.call("save", json!({"content": "x", "start_at": "10月20日"})).is_err());
    assert!(plugin
        .call("save", json!({"content": "x", "start_at": "2026-10-20 09:00", "repeat_rule": "every:0day"}))
        .is_err());
}

#[test]
fn get_event_returns_the_same_shape_as_save() {
    let (plugin, _db) = upgraded();
    let created = plugin
        .call("save", json!({"content": "体检", "start_at": "2026-10-21 08:30", "alarms": [60]}))
        .unwrap();
    let id = first(&created, "id").unwrap();
    let fetched = plugin.call("get_event", json!({"id": id})).unwrap();
    assert_eq!(fetched, created, "编辑器回填只认一份形状");
    assert!(plugin.call("get_event", json!({"id": "missing"})).is_err());
}

#[test]
fn calendar_crud_keeps_events_when_the_calendar_goes_away() {
    let (plugin, db) = upgraded();
    let cal = plugin
        .call("save_calendar", json!({"name": "工作", "color": "#FF8800", "sort": 2}))
        .unwrap();
    let cal_id = first(&cal, "id").unwrap();
    assert_eq!(first(&cal, "color").as_deref(), Some("#ff8800"), "颜色统一小写存库");

    let list = plugin.call("list_calendars", json!({})).unwrap();
    let names: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["我的日程", "工作"], "按 sort 排序，默认分类排最前");

    plugin
        .call("save", json!({"content": "站会", "start_at": "2026-10-20 09:30", "calendar_id": cal_id}))
        .unwrap();

    // 非法颜色退回默认色，而不是把 CSS 变量原样注入前端
    let bad = plugin.call("save_calendar", json!({"name": "危险", "color": "url(x)"})).unwrap();
    assert_eq!(first(&bad, "color").as_deref(), Some("#4c8dff"));

    plugin.call("delete_calendar", json!({"id": cal_id})).unwrap();
    let c = db.lock().unwrap();
    assert_eq!(
        c.query_row("SELECT calendar_id FROM todos WHERE content='站会'", [], |r| r.get::<_, Option<String>>(0))
            .unwrap(),
        None,
        "删日历不该连带删日程，改成未分类"
    );
    drop(c);

    assert!(plugin.call("delete_calendar", json!({"id": "default"})).is_err(), "默认分类不可删");
    assert!(plugin.call("save_calendar", json!({"id": "default", "name": "改名"})).is_err());
    assert!(plugin.call("save_calendar", json!({"name": "  "})).is_err());
}

#[test]
fn check_conflict_skips_all_day_free_and_itself() {
    let (plugin, _db) = upgraded();
    let busy = plugin
        .call("save", json!({"content": "已排的项目评审", "start_at": "2026-10-20 14:00", "end_at": "2026-10-20 15:00"}))
        .unwrap();
    let id = first(&busy, "id").unwrap();
    // 全天事项（请假）不算时间块冲突
    plugin
        .call("save", json!({"content": "整天请假", "start_at": "2026-10-20 09:00", "all_day": true}))
        .unwrap();
    // 忙碌=free 的（如"喝水"）也不该拦人
    plugin
        .call("save", json!({"content": "喝水", "start_at": "2026-10-20 14:30", "status": "free"}))
        .unwrap();

    let hits = plugin
        .call("check_conflict", json!({"start_at": "2026-10-20 14:30", "end_at": "2026-10-20 15:30"}))
        .unwrap();
    let conflicts = hits["conflicts"].as_array().unwrap();
    assert_eq!(conflicts.len(), 1, "只应命中定时忙碌的那条：{conflicts:?}");
    assert_eq!(conflicts[0]["content"], json!("已排的项目评审"));

    // 编辑自身时不该把自己算进冲突
    let with_self = plugin
        .call("check_conflict", json!({"id": id, "start_at": "2026-10-20 14:00", "end_at": "2026-10-20 15:00"}))
        .unwrap();
    let hit_ids: Vec<&str> = with_self["conflicts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["event_id"].as_str().unwrap())
        .collect();
    assert!(!hit_ids.contains(&id.as_str()), "自身那条必须被排除：{hit_ids:?}");
    let without_self = plugin
        .call("check_conflict", json!({"start_at": "2026-10-20 14:00", "end_at": "2026-10-20 15:00"}))
        .unwrap();
    assert_eq!(
        without_self["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["event_id"].as_str() == Some(id.as_str()))
            .count(),
        1,
        "不带 id 时同一条要正常命中"
    );

    // 相邻不算重叠：15:00 结束、15:00 开始
    let edge = plugin
        .call("check_conflict", json!({"start_at": "2026-10-20 15:00", "end_at": "2026-10-20 16:00"}))
        .unwrap();
    let timed: Vec<&JsonValue> = edge["conflicts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["content"].as_str() == Some("已排的项目评审"))
        .collect();
    assert!(timed.is_empty(), "首尾相接不该报冲突");

    assert!(plugin.call("check_conflict", json!({"end_at": "2026-10-20 15:00"})).is_err());
}

#[test]
fn delete_clears_alarms_and_fire_history() {
    let (plugin, db) = upgraded();
    let created = plugin
        .call("save", json!({"content": "要删掉的", "start_at": "2026-10-22 11:00", "alarms": [0, 15]}))
        .unwrap();
    let id = first(&created, "id").unwrap();

    // 先给两条提醒各写一条触发记录，模拟"这个实例已经弹过了"
    let alarm_ids: Vec<String> = db
        .lock()
        .unwrap()
        .prepare("SELECT id FROM event_alarms WHERE event_id = ?1")
        .unwrap()
        .query_map(rusqlite::params![id], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(alarm_ids.len(), 2);
    {
        let c = db.lock().unwrap();
        for al in &alarm_ids {
            c.execute(
                "INSERT INTO alarm_fires (alarm_id, occ_key, fired_at) VALUES (?1,?2,?3)",
                rusqlite::params![al, "2026-10-22 11:00", 1_i64],
            )
            .unwrap();
        }
        assert_eq!(common::count(&c, "alarm_fires"), 2);
    }

    plugin.call("delete", json!({"id": id})).unwrap();
    let c = db.lock().unwrap();
    assert_eq!(common::count(&c, "todos"), 0);
    assert_eq!(
        common::count(&c, "event_alarms"),
        0,
        "删日程必须连带清提醒，否则残留行的 id 会被新日程误认为已触发过"
    );
    assert_eq!(
        common::count(&c, "alarm_fires"),
        0,
        "触发记录要跟着提醒一起删"
    );
}
