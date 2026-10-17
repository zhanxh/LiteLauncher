//! pomo —— 番茄钟（native 后端，M5 从 llp 迁入）
//!
//! 行为与 `pomo.py`（LLP/1 版，已在本轮迁移中删除，git 历史可查）逐条对齐：
//! - **分段**：专注 N 分钟 → 短休 N/5（最少 1 分钟）；`auto` 决定到点是自动接下一段，
//!   还是停在 hold 等用户点「下一段」；
//! - **状态持久化**：整体写进 settings（含单键 `snap` JSON 快照），桌面挂件是独立窗口，
//!   经 settings 读状态、经 `cmd` 键下发按钮命令——**协议一字未改**，挂件前端零改动；
//! - **命令消费**：`pause` / `resume` / `next` / `auto on|off` / `stop`，值形如
//!   `pause:<ts>`（时间戳保证值必变），消费后立即清空避免重复执行。
//!
//! 与 Python 版的实现差异（不改行为）：
//! - 单线程 ticker（300ms）代替「每段一个 worker 线程 + 0.5s 命令轮询线程」：
//!   到点精度从 20s 提到 300ms，线程数与常驻内存都降一半；
//! - svc 调用是同步直调（同进程），不再需要 Python 版的响应分发器与 id 配对。

use chrono::{Local, TimeZone};
use ll_plugin_api::{
    DesktopAttachResult, DesktopAttachStatus, PluginBackend, PluginContext, PluginError,
    PluginManifest,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_MIN: i64 = 25;
/// 专注 : 短休 = 5 : 1（25→5、50→10、5→1）
const BREAK_RATIO: i64 = 5;
const PHASE_FOCUS: &str = "focus";
const PHASE_BREAK: &str = "break";
const VIEW_WIDGET: &str = "widget";
/// 窗口标签 = `<pluginId>-<viewId>`（与宿主 open 的拼接规则一致）
const WIDGET_LABEL: &str = "pomo-widget";
const TICK_MS: u64 = 300;

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 按 5:1 推短休分钟数，最少 1 分钟（0 分钟会让挂件进度环分母变 0）
fn break_minutes_of(minutes: i64) -> i64 {
    let m = if minutes <= 0 { DEFAULT_MIN } else { minutes };
    // 最少 1 分钟：0 分钟的短休等于没有休息，且会让挂件进度环分母变 0（真机事故）
    (((m as f64) / (BREAK_RATIO as f64)).round() as i64).max(1)
}

fn fmt(sec: f64) -> String {
    let s = sec.max(0.0) as i64;
    format!("{:02}:{:02}", s / 60, s % 60)
}

fn cn(phase: &str) -> &'static str {
    if phase == PHASE_BREAK {
        "短休"
    } else {
        "专注"
    }
}

#[derive(Clone)]
struct State {
    /// 本段结束的绝对时刻（epoch 秒）；0 = 未在计时
    target: f64,
    /// 本段标签（挂件显示用）
    label: String,
    /// 本段分钟数（挂件进度环分母）
    minutes: i64,
    running: bool,
    paused: bool,
    paused_remain: f64,
    phase: String,
    /// 用户设定的原始专注段参数（短休结束后据此开下一轮专注）
    focus_label: String,
    focus_minutes: i64,
    break_minutes: i64,
    auto: bool,
    hold: bool,
    next_phase: String,
    rounds: i64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            target: 0.0,
            label: String::new(),
            minutes: DEFAULT_MIN,
            running: false,
            paused: false,
            paused_remain: 0.0,
            phase: PHASE_FOCUS.into(),
            focus_label: String::new(),
            focus_minutes: DEFAULT_MIN,
            break_minutes: break_minutes_of(DEFAULT_MIN),
            auto: true,
            hold: false,
            next_phase: PHASE_BREAK.into(),
            rounds: 0,
        }
    }
}

/// 状态机 + 宿主上下文。ticker 线程只依赖它（Arc<Inner>），不需要 PomoPlugin 自身。
struct Inner {
    state: Mutex<State>,
    ctx: Mutex<Option<PluginContext>>,
    ticker_started: AtomicBool,
    alive: AtomicBool,
}

impl Inner {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, PluginError> {
        self.state
            .lock()
            .map_err(|_| PluginError::internal("插件状态锁不可用"))
    }

    fn ctx(&self) -> Result<PluginContext, PluginError> {
        self.ctx
            .lock()
            .map_err(|_| PluginError::internal("插件上下文锁不可用"))?
            .clone()
            .ok_or_else(|| PluginError::internal("插件尚未初始化"))
    }

    fn snap(&self) -> Result<State, PluginError> {
        Ok(self.lock()?.clone())
    }

    // ── 持久化：挂件（独立窗口）唯一的数据源 ────────────────────────────

    fn persist_with(&self, ctx: &PluginContext, s: &State) {
        let pairs: [(&str, String); 13] = [
            ("target", format!("{:.3}", s.target)),
            ("label", s.label.clone()),
            ("minutes", s.minutes.to_string()),
            ("paused_remain", format!("{:.3}", s.paused_remain)),
            ("phase", s.phase.clone()),
            ("auto", if s.auto { "1" } else { "0" }.to_string()),
            ("hold", if s.hold { "1" } else { "0" }.to_string()),
            ("next_phase", s.next_phase.clone()),
            ("rounds", s.rounds.to_string()),
            ("break_minutes", s.break_minutes.to_string()),
            ("focus_minutes", s.focus_minutes.to_string()),
            ("focus_label", s.focus_label.clone()),
            // 单键快照：挂件每秒轮询一次，读一个 JSON 比读十几个键少一个数量级的 IPC
            ("snap", snapshot_json(s).to_string()),
        ];
        for (k, v) in pairs {
            // 持久化失败不该让业务失败：挂件下一轮轮询会再读到
            let _ = ctx.settings.set(k, &v);
        }
    }

    fn persist(&self) -> Result<(), PluginError> {
        let ctx = self.ctx()?;
        let s = self.snap()?;
        self.persist_with(&ctx, &s);
        Ok(())
    }

    fn notify(&self, title: &str, body: &str) {
        if let Ok(ctx) = self.ctx() {
            if let Some(n) = ctx.notify.as_ref() {
                let _ = n.send(title, body);
            }
            ctx.log.log("info", &format!("{title}：{body}"));
        }
    }

    // ── 状态迁移（与 pomo.py 的 _arm/_start_phase/... 一一对应）──────────

    fn arm(&self, target: f64, label: &str, minutes: i64, phase: &str) -> Result<(), PluginError> {
        let snapshot = {
            let mut s = self.lock()?;
            s.target = target;
            s.label = label.to_string();
            s.minutes = minutes;
            s.phase = phase.to_string();
            s.running = true;
            s.paused = false;
            s.paused_remain = 0.0;
            s.hold = false;
            s.next_phase = if phase == PHASE_FOCUS {
                PHASE_BREAK
            } else {
                PHASE_FOCUS
            }
            .to_string();
            s.clone()
        };
        let ctx = self.ctx()?;
        self.persist_with(&ctx, &snapshot);
        Ok(())
    }

    fn start_phase(&self, phase: &str) -> Result<(), PluginError> {
        let (minutes, label) = {
            let mut s = self.lock()?;
            s.hold = false;
            if phase == PHASE_BREAK {
                (s.break_minutes, "短休".to_string())
            } else {
                (s.focus_minutes, s.focus_label.clone())
            }
        };
        self.arm(
            now_secs() + (minutes as f64) * 60.0,
            &label,
            minutes,
            phase,
        )
    }

    fn start_new(&self, minutes: i64, label: &str) -> Result<i64, PluginError> {
        let bmin = break_minutes_of(minutes);
        {
            let mut s = self.lock()?;
            s.focus_minutes = minutes;
            s.break_minutes = bmin;
            s.focus_label = label.to_string();
            s.rounds = 0;
            s.auto = true;
            s.hold = false;
        }
        self.arm(
            now_secs() + (minutes as f64) * 60.0,
            label,
            minutes,
            PHASE_FOCUS,
        )?;
        Ok(bmin)
    }

    fn next_segment(&self) -> Result<bool, PluginError> {
        let nxt = {
            let s = self.lock()?;
            if !s.hold {
                return Ok(false);
            }
            s.next_phase.clone()
        };
        self.start_phase(&nxt)?;
        Ok(true)
    }

    fn set_auto(&self, on: bool) -> Result<bool, PluginError> {
        let (hold, nxt) = {
            let mut s = self.lock()?;
            s.auto = on;
            (s.hold, s.next_phase.clone())
        };
        if on && hold {
            self.start_phase(&nxt)?;
            return Ok(true);
        }
        self.persist()?;
        Ok(on)
    }

    fn pause(&self) -> Result<bool, PluginError> {
        {
            let mut s = self.lock()?;
            if !s.running || s.paused {
                return Ok(false);
            }
            let remain = s.target - now_secs();
            if remain <= 0.0 {
                return Ok(false);
            }
            s.paused = true;
            s.paused_remain = remain;
            s.target = 0.0;
            s.running = false;
        }
        self.persist()?;
        Ok(true)
    }

    fn resume(&self) -> Result<bool, PluginError> {
        let (remain, label, minutes, phase) = {
            let s = self.lock()?;
            if !s.paused || s.paused_remain <= 0.0 {
                return Ok(false);
            }
            (s.paused_remain, s.label.clone(), s.minutes, s.phase.clone())
        };
        self.arm(now_secs() + remain, &label, minutes, &phase)?;
        Ok(true)
    }

    fn stop(&self) -> Result<bool, PluginError> {
        let was = {
            let mut s = self.lock()?;
            let was = s.running || s.paused || s.hold;
            s.running = false;
            s.paused = false;
            s.hold = false;
            s.target = 0.0;
            s.paused_remain = 0.0;
            s.rounds = 0;
            s.label.clear();
            s.phase = PHASE_FOCUS.to_string();
            was
        };
        // 停止后 paused_remain 必须清零：挂件靠它决定显示「继续」还是「开始」
        self.persist()?;
        Ok(was)
    }

    /// 本段走完：发通知，按 auto 决定自动接下一段还是停在 hold
    fn on_phase_end(&self, phase: &str) -> Result<(), PluginError> {
        let (nxt, auto, rounds) = {
            let mut s = self.lock()?;
            let nxt = if phase == PHASE_FOCUS {
                PHASE_BREAK
            } else {
                PHASE_FOCUS
            };
            if phase == PHASE_FOCUS {
                s.rounds += 1;
            }
            (nxt.to_string(), s.auto, s.rounds)
        };
        let done = cn(phase);
        let nxt_name = cn(&nxt);
        if auto {
            self.notify(
                &format!("⏱{done}结束"),
                &format!("第 {rounds} 轮 · 自动开始{nxt_name}"),
            );
            return self.start_phase(&nxt);
        }
        self.notify(
            &format!("⏱{done}结束"),
            &format!("第 {rounds} 轮 · 点挂件的「{nxt_name} ▶」开始下一段"),
        );
        let snapshot = {
            let mut s = self.lock()?;
            s.hold = true;
            s.next_phase = nxt;
            s.target = 0.0;
            s.running = false;
            s.paused = false;
            s.paused_remain = 0.0;
            s.clone()
        };
        let ctx = self.ctx()?;
        self.persist_with(&ctx, &snapshot);
        Ok(())
    }

    // ── 挂件命令（settings 的 `cmd` 键）──────────────────────────────

    fn handle_cmd(&self, raw: &str) {
        let parts: Vec<String> = raw
            .split(':')
            .map(|p| p.trim().to_lowercase())
            .filter(|p| !p.is_empty())
            .collect();
        let verb = parts.first().map(String::as_str).unwrap_or("");
        let arg = parts.get(1).map(String::as_str).unwrap_or("");
        match verb {
            // 暂停态下再点暂停 = 继续（同一个按钮，省一个 UI 元素）
            "pause" => {
                if !self.pause().unwrap_or(false) {
                    let _ = self.resume();
                }
            }
            "resume" => {
                let _ = self.resume();
            }
            "next" => {
                let _ = self.next_segment();
            }
            "auto" => {
                let _ = self.set_auto(matches!(arg, "1" | "on" | "true"));
            }
            "stop" => {
                let _ = self.stop();
            }
            _ => {}
        }
    }

    // ── 读状态 ───────────────────────────────────────────────────────

    /// paused / hold / running / "" + 剩余秒数（与 Python `_remaining` 同形）
    fn remaining(&self) -> Result<(f64, &'static str), PluginError> {
        let s = self.lock()?;
        if s.paused {
            return Ok((s.paused_remain, "paused"));
        }
        if s.hold {
            return Ok((0.0, "hold"));
        }
        if !s.running || s.target <= 0.0 {
            return Ok((0.0, ""));
        }
        Ok((s.target - now_secs(), "running"))
    }

    fn session_state_text(&self, s: &State) -> String {
        if s.paused {
            format!("已暂停 · 剩余 {}", fmt(s.paused_remain))
        } else if s.hold {
            format!("已完成 {} 轮 · 等下一段", s.rounds)
        } else {
            format!("剩余 {}", fmt(s.target - now_secs()))
        }
    }

    // ── 面板条目（文案与图标与 Python 版一致）─────────────────────────

    fn item(id: &str, title: &str, desc: &str, badge: &str, icon: &str, meta: Value) -> Value {
        json!({
            "id": id,
            "title": title,
            "description": desc,
            "badge": badge,
            "icon": icon,
            "metadata": meta
        })
    }

    fn widget_item() -> Value {
        Self::item(
            "pomo:widget",
            "显示桌面挂件",
            "挂件被关掉后用它找回，计时不受影响；也可输入 /pomo widget",
            "挂件",
            "🪟",
            json!({}),
        )
    }

    fn label_text(s: &State) -> String {
        if s.label.is_empty() {
            "专注".to_string()
        } else {
            s.label.clone()
        }
    }

    fn status_items(&self) -> Result<Value, PluginError> {
        let s = self.snap()?;
        let auto_cn = if s.auto { "开" } else { "关" };
        let nxt_cn = cn(&s.next_phase);
        let item_auto = Self::item(
            "pomo:auto",
            &format!("自动衔接：{auto_cn}"),
            "输入 /pomo auto on|off —— 开：到点自动开始下一段；关：到点停下等你点「下一段」",
            "自动",
            "🔁",
            json!({}),
        );
        let label = Self::label_text(&s);

        let items: Vec<Value> = if s.paused {
            vec![
                Self::item(
                    "pomo:paused",
                    &fmt(s.paused_remain),
                    &format!("已暂停 · {} · {label}", cn(&s.phase)),
                    "暂停",
                    "⏸️",
                    json!({
                        "value": format!("暂停中· {} · {label}", cn(&s.phase)),
                        "label": "已暂停"
                    }),
                ),
                Self::item(
                    "pomo:resume",
                    "继续计时",
                    "输入 /pomo resume",
                    "继续",
                    "▶️",
                    json!({}),
                ),
                item_auto,
                Self::widget_item(),
                Self::item(
                    "pomo:stop",
                    "停止计时",
                    "输入 /pomo stop",
                    "停止",
                    "⏹️",
                    json!({}),
                ),
            ]
        } else if s.hold {
            // hold：一段跑完了，等用户点「下一段」——这一屏必须存在，
            // 否则用户只看到「准备开始」，以为计时器根本没跑完
            vec![
                Self::item(
                    "pomo:hold",
                    &format!("已完成 {} 轮 · 等下一段", s.rounds),
                    &format!("下一段是{nxt_cn} · 自动衔接{auto_cn}"),
                    "待开始",
                    "⏭️",
                    json!({
                        "value": format!("{} 轮 · 待开始{nxt_cn}", s.rounds),
                        "label": "待开始"
                    }),
                ),
                Self::item(
                    "pomo:next",
                    &format!("开始{nxt_cn}"),
                    "输入 /pomo next",
                    "下一段",
                    "▶️",
                    json!({}),
                ),
                item_auto,
                Self::widget_item(),
                Self::item(
                    "pomo:stop",
                    "停止计时",
                    "输入 /pomo stop",
                    "停止",
                    "⏹️",
                    json!({}),
                ),
            ]
        } else if !s.running || s.target <= 0.0 {
            vec![
                Self::item(
                    "pomo:idle",
                    "未在计时",
                    "用法：/pomo start 25 写代码",
                    "空闲",
                    "🍅",
                    json!({}),
                ),
                Self::item(
                    "pomo:hint",
                    "专注 : 短休 = 5 : 1",
                    "25 分钟专注自动接 5 分钟短休；5 分钟专注接 1 分钟短休",
                    "提示",
                    "⏱️",
                    json!({}),
                ),
                Self::item(
                    "pomo:pin",
                    "显示桌面挂件",
                    "在桌面显示倒计时小挂件",
                    "挂件",
                    "🪟",
                    json!({}),
                ),
            ]
        } else {
            let remain = s.target - now_secs();
            let icon = if s.phase == PHASE_FOCUS {
                "🍅"
            } else {
                "☕"
            };
            vec![
                Self::item(
                    "pomo:remain",
                    &fmt(remain),
                    &format!("剩余时间 · {} · {label}", cn(&s.phase)),
                    "进行中",
                    icon,
                    json!({
                        "value": format!("{} 分钟 · {} · {label}", s.minutes, cn(&s.phase)),
                        "label": "计时"
                    }),
                ),
                Self::item(
                    "pomo:endat",
                    &clock_of(now_secs() + remain),
                    &format!("本段（{}）预计结束", cn(&s.phase)),
                    "结束于",
                    "🕒",
                    json!({}),
                ),
                Self::item(
                    "pomo:pause",
                    "暂停计时",
                    "输入 /pomo pause",
                    "暂停",
                    "⏸️",
                    json!({}),
                ),
                item_auto,
                Self::widget_item(),
                Self::item(
                    "pomo:stop",
                    "停止计时",
                    "输入 /pomo stop",
                    "停止",
                    "⏹️",
                    json!({}),
                ),
            ]
        };
        Ok(json!({ "items": items, "emptyText": "无结果" }))
    }

    // ── 挂件窗口 ────────────────────────────────────────────────────

    fn open_widget(&self, pin: bool) -> (bool, String) {
        let ctx = match self.ctx() {
            Ok(c) => c,
            Err(e) => return (false, format!("打开挂件失败：{e}")),
        };
        let Some(windows) = ctx.windows.as_ref() else {
            return (false, "打开挂件失败：manifest 未声明 windows 权限".into());
        };
        if let Err(e) = windows.open(VIEW_WIDGET, &[]) {
            return (false, format!("打开挂件失败：{e}"));
        }
        if !pin {
            return (true, "已在桌面显示倒计时挂件".into());
        }
        // 贴壁纸层：Wayland 下必定失败，宿主会如实返回 unsupported，
        // 这里必须把降级事实告诉用户，不能谎称已贴到桌面
        match windows.attach_desktop(WIDGET_LABEL) {
            Ok(DesktopAttachResult {
                on_wallpaper: true, ..
            }) => (true, "挂件已贴到桌面壁纸层（会被桌面图标遮挡）".into()),
            Ok(DesktopAttachResult { status, .. }) => {
                let reason = match status {
                    DesktopAttachStatus::Unsupported { reason } => reason,
                    DesktopAttachStatus::Failed { reason } => reason,
                    DesktopAttachStatus::Attached => "未知原因".into(),
                };
                (
                    true,
                    format!("挂件已显示，但未能贴到壁纸层（{reason}），保持置顶浮窗"),
                )
            }
            Err(e) => (
                true,
                format!("挂件已显示（贴壁纸层失败：{e}），保持置顶浮窗"),
            ),
        }
    }

    // ── 初始化：从 settings 恢复（宿主重启后进程是新的）────────────────

    fn restore_from_settings(&self) -> Result<(), PluginError> {
        let ctx = self.ctx()?;
        let num = |key: &str, default: f64| -> f64 {
            ctx.settings
                .get(key)
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(default)
        };
        let txt = |key: &str, default: &str| -> String {
            ctx.settings
                .get(key)
                .unwrap_or_else(|| default.to_string())
        };

        let stored_target = num("target", 0.0);
        let stored_phase = txt("phase", PHASE_FOCUS);
        let phase = if stored_phase == PHASE_FOCUS || stored_phase == PHASE_BREAK {
            stored_phase
        } else {
            PHASE_FOCUS.to_string()
        };
        let nxt = txt("next_phase", PHASE_BREAK);
        let next_phase = if nxt == PHASE_FOCUS || nxt == PHASE_BREAK {
            nxt
        } else {
            PHASE_BREAK.to_string()
        };
        let mut focus_minutes = num("focus_minutes", DEFAULT_MIN as f64) as i64;
        if focus_minutes <= 0 {
            focus_minutes = DEFAULT_MIN;
        }
        let mut break_minutes = num("break_minutes", break_minutes_of(focus_minutes) as f64) as i64;
        if break_minutes <= 0 {
            break_minutes = 1;
        }
        let mut minutes = num("minutes", focus_minutes as f64) as i64;
        if minutes <= 0 {
            minutes = focus_minutes;
        }
        let paused_remain = num("paused_remain", 0.0);
        let label = txt("label", "");
        let focus_label = txt("focus_label", "");
        let rounds = num("rounds", 0.0) as i64;
        let auto = txt("auto", "1") != "0";
        let hold = txt("hold", "0") == "1";

        {
            let mut s = self.lock()?;
            s.phase = phase;
            s.next_phase = next_phase;
            s.label = label;
            s.focus_label = focus_label;
            s.focus_minutes = focus_minutes;
            s.break_minutes = break_minutes;
            s.minutes = minutes;
            s.rounds = rounds;
            s.auto = auto;
            s.hold = hold;
            s.paused_remain = paused_remain;
        }

        if stored_target > now_secs() {
            // 仍在计时：接着跑（target 是 epoch 秒，与 now_secs() 同源）
            self.lock()?.target = stored_target;
            self.lock()?.running = true;
            self.persist()?;
        } else if paused_remain > 0.0 {
            self.lock()?.paused = true;
        } else {
            // 没在计时也回写一次：升级前的旧状态里没有 `snap` 键
            self.persist()?;
        }
        Ok(())
    }

    // ── ticker：命令消费 + 到点判定（替代 Python 的 worker + cmd 双线程）──

    fn start_ticker(self: &Arc<Self>) {
        if self.ticker_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let inner = Arc::clone(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(TICK_MS));
            if !inner.alive.load(Ordering::Relaxed) {
                return;
            }
            let Some(ctx) = inner.ctx.lock().ok().and_then(|g| g.clone()) else {
                continue;
            };

            // 1) 挂件按钮命令：读到就清空（不清会被每轮轮询重复执行）
            if let Some(raw) = ctx.settings.get("cmd") {
                if !raw.trim().is_empty() {
                    let _ = ctx.settings.set("cmd", "");
                    inner.handle_cmd(&raw);
                }
            }

            // 2) 到点判定
            let finished_phase = {
                let Ok(mut s) = inner.state.lock() else {
                    continue;
                };
                if s.running && !s.paused && s.target > 0.0 && now_secs() >= s.target {
                    s.running = false;
                    s.target = 0.0;
                    Some(s.phase.clone())
                } else {
                    None
                }
            };
            if let Some(phase) = finished_phase {
                let _ = inner.on_phase_end(&phase);
            }
        });
    }

    // ── 方法分发（与 pomo.py 的 on_search/on_execute/on_select 对齐）────

    fn search(&self) -> Result<Value, PluginError> {
        let (_, phase) = self.remaining()?;
        if phase.is_empty() {
            // 首次进入（宿主刚启动）：先把 settings 里的状态搬回内存
            let _ = self.restore_from_settings();
        }
        self.status_items()
    }

    fn execute(&self, params: &Value) -> Result<Value, PluginError> {
        let sub = params
            .get("subcommand")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let args: Vec<String> = params
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|v| match v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        match sub.as_str() {
            "start" => {
                // 不带参数的 start 在会话进行中 = 只把挂件找回来，绝不重置
                if args.is_empty() {
                    let s = self.snap()?;
                    if s.running || s.paused || s.hold {
                        let (ok, msg) = self.open_widget(false);
                        let head = format!("计时仍在进行（{}）", self.session_state_text(&s));
                        return Ok(if ok {
                            json!({ "success": true,
                                    "message": format!("{head}，挂件已重新显示；要开新的请先 /pomo stop") })
                        } else {
                            json!({ "success": false,
                                    "message": format!("{head}，但挂件显示失败：{msg}（计时未受影响）") })
                        });
                    }
                }
                let mut minutes = DEFAULT_MIN;
                let mut label_args: Vec<String> = args.clone();
                if !label_args.is_empty() {
                    if let Ok(v) = label_args[0].parse::<f64>() {
                        minutes = v as i64;
                        label_args.remove(0);
                    }
                }
                let minutes = minutes.clamp(1, 24 * 60);
                let label = label_args.join(" ").trim().to_string();
                let break_min = self.start_new(minutes, &label)?;
                // 新建番茄钟即在桌面显示挂件（用户明确要的行为）
                let (ok, _msg) = self.open_widget(false);
                let tail = if ok { "，到点会通知你" } else { "" };
                let mut message = format!(
                    "已开始 {minutes} 分钟专注{}（每段后接 {break_min} 分钟短休，自动衔接已开启）{tail}",
                    if label.is_empty() {
                        String::new()
                    } else {
                        format!("：{label}")
                    }
                );
                if !ok {
                    message.push_str("；挂件显示失败，计时仍在进行");
                }
                Ok(json!({ "success": true, "message": message }))
            }

            "stop" => {
                let was = self.stop()?;
                Ok(json!({
                    "success": true,
                    "message": if was { "已停止计时" } else { "当前没有在计时" }
                }))
            }

            "pause" => {
                let (remain, phase) = self.remaining()?;
                if phase == "paused" {
                    let _ = self.resume()?;
                    return Ok(json!({ "success": true, "message": "已继续计时" }));
                }
                if self.pause()? {
                    return Ok(json!({
                        "success": true,
                        "message": format!("已暂停，剩余 {}", fmt(remain))
                    }));
                }
                Ok(json!({ "success": false, "message": "当前没有在计时" }))
            }

            "resume" => {
                if self.resume()? {
                    Ok(json!({ "success": true, "message": "已继续计时" }))
                } else {
                    Ok(json!({ "success": false, "message": "当前不是暂停状态" }))
                }
            }

            "next" => {
                if self.next_segment()? {
                    let s = self.snap()?;
                    Ok(json!({
                        "success": true,
                        "message": format!("已开始 {} 分钟{}", s.minutes, cn(&s.phase))
                    }))
                } else {
                    Ok(json!({
                        "success": false,
                        "message": "当前没有待开始的下一段（自动衔接开着或没在计时）"
                    }))
                }
            }

            "auto" => {
                let raw = args
                    .first()
                    .map(|a| a.trim().to_lowercase())
                    .unwrap_or_else(|| "on".to_string());
                let on = match raw.as_str() {
                    "on" | "1" | "true" => true,
                    "off" | "0" | "false" => false,
                    _ => return Ok(json!({ "success": false, "message": "用法：/pomo auto on|off" })),
                };
                self.set_auto(on)?;
                let s = self.snap()?;
                let message = if on {
                    let mut msg = "已开启自动衔接：到点直接开始下一段".to_string();
                    if s.phase == PHASE_FOCUS && s.running {
                        msg.push_str(&format!("（本轮专注剩余 {}）", fmt(s.target - now_secs())));
                    }
                    msg
                } else {
                    "已关闭自动衔接：每段结束后等你点挂件的「下一段 ▶」".to_string()
                };
                Ok(json!({ "success": true, "message": message }))
            }

            "pin" => {
                let (_ok, msg) = self.open_widget(true);
                Ok(json!({ "success": true, "message": msg }))
            }

            "widget" => {
                let (_ok, msg) = self.open_widget(false);
                Ok(json!({ "success": true, "message": msg }))
            }

            "where" => {
                let s = self.snap()?;
                let (state, extra) = if s.paused {
                    (
                        "暂停",
                        format!(" · {} · 剩余 {}", Self::label_text(&s), fmt(s.paused_remain)),
                    )
                } else if s.hold {
                    (
                        "等下一段",
                        format!(
                            " · 已完成 {} 轮 · 下一段是{}",
                            s.rounds,
                            cn(&s.next_phase)
                        ),
                    )
                } else if s.running && s.target > now_secs() {
                    (
                        "计时中",
                        format!(
                            " · {} {} · 剩余 {}",
                            cn(&s.phase),
                            Self::label_text(&s),
                            fmt(s.target - now_secs())
                        ),
                    )
                } else {
                    ("未计时", String::new())
                };
                let auto_cn = if s.auto { "开" } else { "关" };
                Ok(json!({
                    "success": true,
                    "message": format!(
                        "番茄钟{state}{extra} · 自动衔接{auto_cn} · 短休 {} 分钟",
                        s.break_minutes
                    )
                }))
            }

            _ => Ok(json!({
                "success": false,
                "message": "未知子命令。可用：start [分钟] [标签] / stop / pause / resume / next（开始下一段）/ auto on|off（到点是否自动接下一段）/ pin / widget（找回桌面挂件；计时中 /pomo start 不带参数同样只找回挂件）"
            })),
        }
    }

    fn select(&self, params: &Value) -> Result<Value, PluginError> {
        let id = params.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let as_exec = |sub: &str, args: Vec<&str>| -> Result<Value, PluginError> {
            self.execute(&json!({
                "subcommand": sub,
                "args": args.iter().map(|a| Value::String((*a).into())).collect::<Vec<_>>()
            }))
        };
        match id {
            "pomo:stop" => as_exec("stop", vec![]),
            "pomo:pause" => as_exec("pause", vec![]),
            "pomo:resume" => as_exec("resume", vec![]),
            "pomo:next" => as_exec("next", vec![]),
            "pomo:auto" => {
                // 点一下就是翻转开关
                let on = !self.snap()?.auto;
                as_exec("auto", vec![if on { "on" } else { "off" }])
            }
            "pomo:pin" => as_exec("pin", vec![]),
            "pomo:widget" => as_exec("widget", vec![]),
            "pomo:remain" => {
                let s = self.snap()?;
                Ok(if s.running {
                    json!({ "toast": format!("{} {}：剩余 {}", cn(&s.phase), Self::label_text(&s), fmt(s.target - now_secs())) })
                } else {
                    json!({ "toast": "未在计时" })
                })
            }
            "pomo:hold" => {
                let s = self.snap()?;
                Ok(json!({ "toast": format!("已完成 {} 轮 · 点「下一段」继续", s.rounds) }))
            }
            _ => Ok(json!({})),
        }
    }
}

/// 挂件消费的 JSON 快照（字段名与 pomo.py 的 `snap` 完全一致）
fn snapshot_json(s: &State) -> Value {
    json!({
        "target": s.target,
        "label": s.label,
        "minutes": s.minutes,
        "running": s.running,
        "paused": s.paused,
        "paused_remain": s.paused_remain,
        "phase": s.phase,
        "focus_label": s.focus_label,
        "focus_minutes": s.focus_minutes,
        "break_minutes": s.break_minutes,
        "auto": s.auto,
        "hold": s.hold,
        "next_phase": s.next_phase,
        "rounds": s.rounds
    })
}

/// epoch 秒 → 本地 `HH:MM:SS`（面板「结束于」条目）
fn clock_of(epoch: f64) -> String {
    Local
        .timestamp_opt(epoch as i64, 0)
        .single()
        .map(|t| t.format("%H:%M:%S").to_string())
        .unwrap_or_else(|| "--:--:--".to_string())
}

pub struct PomoPlugin {
    inner: Arc<Inner>,
}

impl Default for PomoPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl PomoPlugin {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                ctx: Mutex::new(None),
                ticker_started: AtomicBool::new(false),
                alive: AtomicBool::new(false),
            }),
        }
    }
}

impl PluginBackend for PomoPlugin {
    fn manifest(&self) -> PluginManifest {
        serde_json::from_str(include_str!("../../manifest.json")).expect("pomo manifest.json 解析失败")
    }

    fn init(&self, ctx: PluginContext) -> Result<(), PluginError> {
        {
            let mut slot = self
                .inner
                .ctx
                .lock()
                .map_err(|_| PluginError::internal("插件上下文锁不可用"))?;
            *slot = Some(ctx);
        }
        self.inner.alive.store(true, Ordering::SeqCst);
        let _ = self.inner.restore_from_settings();
        self.inner.start_ticker();
        Ok(())
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, PluginError> {
        match method {
            "search" => self.inner.search(),
            "execute" => self.inner.execute(&params),
            "select" => self.inner.select(&params),
            other => Err(PluginError::unknown_method(other)),
        }
    }

    fn shutdown(&self) {
        self.inner.alive.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod state_tests;
