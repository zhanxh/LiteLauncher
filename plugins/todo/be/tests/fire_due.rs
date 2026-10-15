//! 提醒触发引擎（Stage 4）：多提醒 × 重复实例的幂等与漏发处理
//!
//! 数据全部用**相对当前时间**的时刻：`fire_due` 读真实 `Local::now()`，
//! 写死日期的测试只在那一天成立。要验的三件事都只有跑真库才看得见——
//! `alarm_fires` 的复合主键去重、补发窗口的分界、以及"日历展开出的实例
//! 与真正弹窗的是同一批"。

#![cfg(test)]

mod common;

use chrono::{Duration, Local};
use common::{count, ctx_with, ctx_with_windows, upgraded, Shared, TestWindows};
use ll_plugin_api::PluginBackend;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

/// n 分钟前的本地时刻串（与存储约定同：`YYYY-MM-DD HH:MM`）
fn ago(mins: i64) -> String {
    (Local::now() - Duration::minutes(mins))
        .format("%Y-%m-%d %H:%M")
        .to_string()
}

/// 每 tick 都新建 ctx，顺带覆盖"重启后靠 DB 记账而不是靠内存"这条
fn fire(shared: &Shared) -> usize {
    ll_plugin_todo::fire_due(&ctx_with(Arc::clone(shared))).expect("fire_due 失败")
}

fn fires(shared: &Shared) -> i64 {
    count(&shared.lock().unwrap(), "alarm_fires")
}

#[test]
fn each_alarm_claims_its_own_slot_once() {
    let (plugin, shared) = upgraded();
    // 开始前 2 分钟建的事件：提前 5 分的到点且仍在补发窗口内，提前 30 分的错过太久
    plugin
        .call(
            "save",
            json!({"content": "站会", "start_at": ago(2), "alarms": [30, 5]}),
        )
        .unwrap();

    assert_eq!(fire(&shared), 1, "只有补发窗口内的那条提醒该弹窗");
    assert_eq!(fires(&shared), 2, "错过过久的也要记账，否则下个 tick 又判成漏发");
    assert_eq!(fire(&shared), 0, "同一时刻重跑不得重复弹");
    assert_eq!(fires(&shared), 2, "记账不该被重复写");
}

#[test]
fn repeating_event_fires_per_occurrence() {
    let (plugin, shared) = upgraded();
    // 锚点在 24h+2min 前、每天重复 → 窗口里有"昨天"(错过过久)与"刚才"(到点)两个实例
    plugin
        .call(
            "save",
            json!({
                "content": "晨读",
                "start_at": ago(1442),
                "repeat_rule": "every:1day",
                "alarms": [0],
            }),
        )
        .unwrap();

    assert_eq!(fire(&shared), 1, "重复项每个实例各弹一次，而不是每 tick 弹一次");
    assert_eq!(fires(&shared), 2, "两条实例各自占一个 occ_key");
    assert_eq!(fire(&shared), 0, "两条都已记账");
}

#[test]
fn completed_events_stop_firing() {
    let (plugin, shared) = upgraded();
    let saved = plugin
        .call(
            "save",
            json!({"content": "交周报", "start_at": ago(3), "alarms": [0]}),
        )
        .unwrap();
    assert_eq!(fire(&shared), 1);

    plugin
        .call("toggle", json!({"id": saved["id"]}))
        .expect("勾选完成");
    assert_eq!(fire(&shared), 0, "已完成的事项不该再弹");
}

#[test]
fn events_without_alarms_stay_silent() {
    let (plugin, shared) = upgraded();
    plugin
        .call("save", json!({"content": "随手记", "start_at": ago(10)}))
        .unwrap();
    assert_eq!(fire(&shared), 0, "没设提醒就什么都不该弹");
    assert_eq!(fires(&shared), 0, "也不该留下记账行");
}

#[test]
fn future_events_are_not_booked_early() {
    let (plugin, shared) = upgraded();
    // 30 分钟后开始、提醒挂在开始前 10 分与准时 → 两个触发时刻都还在未来
    plugin
        .call(
            "save",
            json!({"content": "待开的会", "start_at": ago(-30), "alarms": [10, 0]}),
        )
        .unwrap();
    assert_eq!(fire(&shared), 0);
    assert_eq!(fires(&shared), 0, "未到点不能提前占掉记账，否则到点反而不弹");
}

#[test]
fn editing_alarms_rearms_the_event() {
    let (plugin, shared) = upgraded();
    let saved = plugin
        .call(
            "save",
            json!({"content": "改提醒", "start_at": ago(2), "alarms": [5]}),
        )
        .unwrap();
    assert_eq!(fire(&shared), 1);

    // 换提醒 = 换 alarm_id，旧记账随提醒行一起删掉，用户改完期待的就是"再弹一次"
    plugin
        .call(
            "save",
            json!({
                "id": saved["id"],
                "content": "改提醒",
                "start_at": ago(2),
                "alarms": [1],
            }),
        )
        .unwrap();
    assert_eq!(fires(&shared), 0, "重建提醒要清掉旧触发记录");
    assert_eq!(fire(&shared), 1, "新提醒应照常触发");
}

/// 卡片是独立窗口，URL 参数就是它的全部数据源——少一个字段就只能画一张空卡
#[test]
fn popup_params_carry_the_whole_card() {
    let (plugin, shared) = upgraded();
    // 一次取时刻、两个断言都从它推：`ago`/`ahead` 各读一次 now()，跨分钟边界会让
    // 期望的 end（后端按 start_at + 默认时长存）比实参差一分钟
    let base = Local::now();
    let at = |mins: i64| (base + Duration::minutes(mins)).format("%Y-%m-%d %H:%M").to_string();

    let cal = plugin
        .call("save_calendar", json!({"name": "工作", "color": "#4c8dff"}))
        .unwrap();
    let saved = plugin
        .call(
            "save",
            json!({
                "content": "团队周会",
                "start_at": at(-2),
                "calendar_id": cal["id"],
                "alarms": [5],
            }),
        )
        .unwrap();

    let (windows, opened) = TestWindows::new();
    let fired =
        ll_plugin_todo::fire_due(&ctx_with_windows(Arc::clone(&shared), Arc::new(windows)))
            .expect("fire_due 失败");
    assert_eq!(fired, 1);

    let popup = opened
        .lock()
        .unwrap()
        .pop()
        .expect("到点的提醒该开一张卡片");
    assert_eq!(popup.0, "reminder");
    let params: HashMap<String, String> = popup.1.into_iter().collect();
    let want = |k: &str, v: &str| {
        assert_eq!(params.get(k).map(String::as_str), Some(v), "参数 {k}");
    };
    want("content", "团队周会");
    want("event", saved["id"].as_str().unwrap());
    want("minutes", "5");
    want("cal", "工作");
    // 区间取实例的，不是日程锚点的：重复事项弹的是"这一次"
    want("start", &at(-2));
    want("end", &at(58));
    want("all_day", "0");
    // id 是 unique_by：同一事件 × 同一次 × 同一档重跑不能开出第二张
    let slot = params.get("id").expect("卡片要有实例键");
    assert!(
        slot.starts_with(saved["id"].as_str().unwrap()) && slot.ends_with("-5min"),
        "{slot}"
    );
}

/// 多提醒 × 重复实例：开几个窗就得记几条账，两边数目对不上就是漏弹或重复弹
#[test]
fn one_popup_per_fired_alarm() {
    let (plugin, shared) = upgraded();
    plugin
        .call(
            "save",
            json!({
                "content": "晨读",
                "start_at": ago(1442),
                "repeat_rule": "every:1day",
                "alarms": [30, 0],
            }),
        )
        .unwrap();

    let (windows, opened) = TestWindows::new();
    let fired =
        ll_plugin_todo::fire_due(&ctx_with_windows(Arc::clone(&shared), Arc::new(windows)))
            .expect("fire_due 失败");
    assert_eq!(opened.lock().unwrap().len(), fired, "每个到点提醒各开一张卡片");

    let again = ll_plugin_todo::fire_due(&ctx_with_windows(
        Arc::clone(&shared),
        Arc::new(TestWindows::default()),
    ))
    .expect("重跑失败");
    assert_eq!(again, 0, "已记账的不再弹");
}
