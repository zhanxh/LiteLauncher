//! /pomo 状态机单测（对齐 pomo.py 的关键行为，不需要宿主）。
//!
//! 覆盖点都是"以前真机出过事故"的位置：
//! - 专注:短休 = 5:1 取整（0 分钟短休会让挂件进度环分母变 0）
//! - 暂停/继续后分钟数与阶段不变（挂件用 minutes 当分母）
//! - auto=off 到点停 hold、next_phase 正确（否则挂件退回"准备开始"，用户以为没跑完）
//! - hold 态下开 auto 立刻接上下一段（用户意图就是"别再等我"）

use super::*;
use ll_plugin_api::{EventApi, LogApi, NotifyApi, SettingsApi};
use std::collections::HashMap;

#[derive(Default)]
struct FakeSettings(Mutex<HashMap<String, String>>);

impl SettingsApi for FakeSettings {
    fn get(&self, key: &str) -> Option<String> {
        self.0.lock().ok()?.get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> Result<(), PluginError> {
        if let Ok(mut m) = self.0.lock() {
            m.insert(key.to_string(), value.to_string());
        }
        Ok(())
    }
}

#[derive(Default)]
struct FakeNotify(Mutex<Vec<(String, String)>>);

impl NotifyApi for FakeNotify {
    fn send(&self, title: &str, body: &str) -> Result<(), PluginError> {
        if let Ok(mut v) = self.0.lock() {
            v.push((title.to_string(), body.to_string()));
        }
        Ok(())
    }
}

struct FakeLog;
impl LogApi for FakeLog {
    fn log(&self, _level: &str, _msg: &str) {}
}

struct FakeEvents;
impl EventApi for FakeEvents {
    fn emit(&self, _event: &str, _payload: serde_json::Value) -> Result<(), PluginError> {
        Ok(())
    }
}

fn setup() -> (Arc<Inner>, Arc<FakeSettings>, Arc<FakeNotify>) {
    let settings = Arc::new(FakeSettings::default());
    let notify = Arc::new(FakeNotify::default());
    let inner = Arc::new(Inner {
        state: Mutex::new(State::default()),
        ctx: Mutex::new(None),
        // 置 true：单测不启 ticker 线程，避免 300ms 轮询干扰断言
        ticker_started: AtomicBool::new(true),
        alive: AtomicBool::new(false),
    });
    let ctx = PluginContext {
        db: None,
        windows: None,
        notify: Some(notify.clone()),
        process: None,
        secrets: None,
        http: None,
        clipboard: None,
        screen: None,
        shortcuts: None,
        clipboard_history: None,
        events: Arc::new(FakeEvents),
        settings: settings.clone(),
        log: Arc::new(FakeLog),
    };
    *inner.ctx.lock().unwrap() = Some(ctx);
    (inner, settings, notify)
}

#[test]
fn break_minutes_follow_five_to_one() {
    assert_eq!(break_minutes_of(25), 5);
    assert_eq!(break_minutes_of(50), 10);
    assert_eq!(break_minutes_of(5), 1);
    // 1 分钟专注 → round(0.2)=0，但必须兜到 1（0 会让挂件进度环分母为 0）
    assert_eq!(break_minutes_of(1), 1);
    assert_eq!(break_minutes_of(0), 5);
}

#[test]
fn start_new_sets_focus_segment_and_persists_snap() {
    let (inner, settings, _) = setup();
    let bmin = inner.start_new(25, "写代码").unwrap();
    assert_eq!(bmin, 5);

    let s = inner.snap().unwrap();
    assert!(s.running);
    assert_eq!(s.phase, PHASE_FOCUS);
    assert_eq!(s.minutes, 25);
    assert_eq!(s.break_minutes, 5);
    assert!(s.auto);
    assert!(s.target > now_secs());

    // 挂件优先读 `snap`：键必须在，且能解析出 focus/25
    let snap: Value = serde_json::from_str(&settings.get("snap").unwrap()).unwrap();
    assert_eq!(snap["phase"], "focus");
    assert_eq!(snap["minutes"], 25);
    assert_eq!(snap["auto"], true);
}

#[test]
fn pause_then_resume_keeps_phase_and_minutes() {
    let (inner, _settings, _) = setup();
    inner.start_new(30, "review").unwrap();
    assert!(inner.pause().unwrap());

    let paused = inner.snap().unwrap();
    assert!(paused.paused);
    assert!(!paused.running);
    assert!(paused.paused_remain > 1700.0 && paused.paused_remain <= 1800.0);

    assert!(inner.resume().unwrap());
    let resumed = inner.snap().unwrap();
    assert!(resumed.running);
    assert!(!resumed.paused);
    assert_eq!(resumed.minutes, 30);
    assert_eq!(resumed.phase, PHASE_FOCUS);
}

#[test]
fn phase_end_without_auto_holds_and_announces_next() {
    let (inner, settings, notify) = setup();
    inner.start_new(1, "x").unwrap();
    inner.set_auto(false).unwrap();
    inner.on_phase_end(PHASE_FOCUS).unwrap();

    let s = inner.snap().unwrap();
    assert!(s.hold);
    assert!(!s.running);
    assert_eq!(s.rounds, 1);
    assert_eq!(s.next_phase, PHASE_BREAK);

    let snap: Value = serde_json::from_str(&settings.get("snap").unwrap()).unwrap();
    assert_eq!(snap["hold"], true);
    assert_eq!(snap["next_phase"], "break");

    let sent = notify.0.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert!(sent[0].1.contains("下一段"));
}

#[test]
fn enabling_auto_in_hold_starts_break_immediately() {
    let (inner, _settings, _) = setup();
    inner.start_new(1, "x").unwrap();
    inner.set_auto(false).unwrap();
    inner.on_phase_end(PHASE_FOCUS).unwrap();
    assert!(inner.snap().unwrap().hold);

    inner.set_auto(true).unwrap();
    let s = inner.snap().unwrap();
    assert!(!s.hold);
    assert!(s.running);
    assert_eq!(s.phase, PHASE_BREAK);
    assert_eq!(s.minutes, 1); // 1 分钟专注 → 1 分钟短休
}

#[test]
fn widget_cmd_pause_is_consumed_as_toggle() {
    let (inner, _settings, _) = setup();
    inner.start_new(10, "x").unwrap();
    // 挂件写的是 `pause:<ts>`，第三段是时间戳
    inner.handle_cmd("pause:1712345678901");
    assert!(inner.snap().unwrap().paused);
    // 暂停态下再点同一个按钮 = 继续
    inner.handle_cmd("pause:1712345678902");
    assert!(!inner.snap().unwrap().paused);
}

#[test]
fn stop_clears_rounds_and_paused_remain() {
    let (inner, settings, _) = setup();
    inner.start_new(5, "x").unwrap();
    inner.pause().unwrap();
    assert!(inner.stop().unwrap());

    let s = inner.snap().unwrap();
    assert!(!s.running && !s.paused && !s.hold);
    assert_eq!(s.rounds, 0);
    assert_eq!(s.paused_remain, 0.0);

    // 停止后挂件不能冒出"继续"按钮
    let snap: Value = serde_json::from_str(&settings.get("snap").unwrap()).unwrap();
    assert_eq!(snap["paused_remain"], 0.0);
}

#[test]
fn search_lists_remain_item_while_running() {
    let (inner, _settings, _) = setup();
    inner.start_new(25, "写代码").unwrap();
    let out = inner.search().unwrap();
    let ids: Vec<&str> = out["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["id"].as_str())
        .collect();
    assert!(ids.contains(&"pomo:remain"));
    assert!(ids.contains(&"pomo:pause"));
    assert!(ids.contains(&"pomo:widget"));
}
