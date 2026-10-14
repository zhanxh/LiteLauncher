#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/pomo 番茄钟（自包含，仅标准库）。

要点：
1. sidecar 常驻，用后台线程计时；到点经**推送式** svc.notify.send 发系统通知
   （后台线程只写不读 stdout；宿主对每个 svc 请求会回一行响应，主循环会忽略它，
   因此不会污染协议）。
2. 桌面挂件是**独立的 Webview 窗口**（manifest.views 里的 `widget` 视图），
   它的 JS 上下文与本进程不同，拿不到这里的内存状态。故每次 start/stop 都把
   `target`/`label`/`minutes` 写进 settings（宿主强制 `${pluginId}.` 前缀隔离，
   跨进程共享），挂件以 settings 为唯一数据源每秒轮询。
3. 反向同理：挂件上的"暂停/停止"按钮也写settings 的 `cmd` 键，
   本进程每 tick 消费一次并清空。这是现成的跨进程通道——
   无需新增宿主能力或改 LLP 协议（前端 ctx.call 只能打到宿主 svc.*，
   events 也是单向 emit，都到不了 sidecar）。
4. 计时是**分段**的：一段专注（用户设定的分钟数）跟一段短休（专注的 1/5，
   最少 1 分钟）。每段到点后由 `auto` 决定去向——
   auto=1 立即开始下一段；auto=0 停在 hold 态，等用户点挂件的「下一段 ▶」。
   默认在 `/pomo start` 时置为 1（用户要的"初始就是自动"），随时可关。
"""
import json
import sys
import threading
import time

PLUGIN = "pomo"
DEFAULT_MIN = 25
# 专注 : 短休 = 5 : 1（25→5、50→10、5→1）
BREAK_RATIO = 5

PHASE_FOCUS = "focus"
PHASE_BREAK = "break"

# ── 挂件相关常量 ────────────────────────────────────────────────
VIEW_WIDGET = "widget"
# 窗口标签 = `<pluginId>-<viewId>`（宿主 open_on_main 的拼接规则）
WIDGET_LABEL = "pomo-" + VIEW_WIDGET
# 挂件读取状态的间隔（ms）。sidecar 侧只需保证"最终一致"，
# 真正的刷新率由挂件自己的 1s 轮询决定。
CMD_POLL_S = 0.5

_seq = [1]
_io_lock = threading.Lock()
_state_lock = threading.Lock()
# label/minutes 恒指**当前段**（挂件用 minutes 当进度环的分母）；
# focus_label/focus_minutes 是用户设定的原始专注段参数，短休结束后据此开下一轮专注。
_state = {"target": 0.0, "label": "", "minutes": DEFAULT_MIN, "running": False,
          "paused": False, "paused_remain": 0.0,
          "phase": PHASE_FOCUS, "focus_label": "", "focus_minutes": DEFAULT_MIN,
          "break_minutes": 1, "auto": True, "hold": False,
          "next_phase": PHASE_BREAK, "rounds": 0}


def break_minutes_of(minutes):
    """按 5:1 推短休分钟数。向上取整到最少 1 分钟——0 分钟的短休等于没有休息，
    但更要紧的是它会让挂件的进度环分母变成 0。"""
    try:
        m = int(float(minutes))
    except (TypeError, ValueError):
        m = DEFAULT_MIN
    if m <= 0:
        m = DEFAULT_MIN
    return max(1, int(round(m / float(BREAK_RATIO))))



def _next_id():
    with _io_lock:
        rid = _seq[0]
        _seq[0] += 1
        return rid


def _emit(obj):
    with _io_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


# ── 响应分发 ────────────────────────────────────────────────────
# 为什么需要它：stdin 只有一条数据流，但主线程（处理宿主请求）和命令线程
# （消费挂件按钮）都可能发 svc 并各自 readline() 一行响应。若两者并发，
# 后读的那个会把别人的响应取走——表现为"暂停按钮点了没反应"或"设置写串了"，
# 而且是**偶发**的，极难排查。
# 正确做法：单一 reader 线程负责所有 readline，按 id 把响应派发给等待方。
# 详见 `_start_response_dispatcher`。
_pending = {}
_pending_cv = threading.Condition()
# 无主响应（fire 发出）的上限；详见 _dispatch 里的说明
_PENDING_MAX = 64


def _dispatch(resp):
    """把一行响应交给等待该 id 的线程。"""
    with _pending_cv:
        rid = resp.get("id")
        # fire() 发出的请求没人 await，其响应会堆在这里。必须设上限，
        # 否则一个跑一整天的番茄钟会把 _pending 撑到几百行（缓慢内存泄漏）。
        if len(_pending) >= _PENDING_MAX:
            try:
                del _pending[min(_pending)]   # 丢最老的一条
            except (KeyError, TypeError):
                pass
        _pending[rid] = resp
        _pending_cv.notify_all()


def _await(rid, timeout=10.0):
    """等待指定 id 的响应。超时抛错而不是死等——宿主卡住时插件不该挂死。"""
    deadline = time.monotonic() + timeout
    with _pending_cv:
        while rid not in _pending:
            remain = deadline - time.monotonic()
            if remain <= 0:
                raise RuntimeError(f"等待 svc 响应超时 (id={rid})")
            _pending_cv.wait(remain)
        return _pending.pop(rid)


def _reader_loop():
    """唯一的 stdin 读取者。宿主下行消息与 svc 响应都从这里分流出去。

    - 带 `id` 且 `method`/`result`/`error` 成对出现的 → svc 响应，交给等待方
    - 带 `method` 的 → 宿主发来的请求（如插件下发通道），交给主循环的 inbox
    """
    while True:
        line = sys.stdin.readline()
        if not line:
            # 宿主关闭连接：唤醒所有等待者，让它们各自报错退出而不是永久阻塞
            with _pending_cv:
                _pending_cv.notify_all()
            return
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "method" in msg:
            _inbox_put(msg)
        else:
            _dispatch(msg)


_inbox = []
_inbox_cv = threading.Condition()


def _inbox_put(msg):
    with _inbox_cv:
        _inbox.append(msg)
        _inbox_cv.notify_all()


def _inbox_take(timeout=0.5):
    """取一条宿主下行消息；超时返回 None 让主循环有机会退出/打日志。

    超时返回 None 是刻意的：主循环不能阻塞在无限等待上，
    否则 shutdown 之外的退出路径都会挂住。
    """
    with _inbox_cv:
        if not _inbox:
            _inbox_cv.wait(timeout)
        if _inbox:
            return _inbox.pop(0)
    return None


def _start_response_dispatcher():
    """启动 reader 线程并把它与主循环的读stdin 解耦。

    启动后主循环不再直接 `for raw in sys.stdin`，改从 `_inbox` 取——
    这样 stdin 永远只有一个读者，多线程发 svc 就安全了。
    """
    threading.Thread(target=_reader_loop, daemon=True).start()


def svc(method, params=None, timeout=10.0):
    """同步反向请求（写请求 → 经分发器等自己的响应）。任意线程可调用。"""
    rid = _next_id()
    _emit({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
    resp = _await(rid, timeout)
    if "error" in resp:
        raise RuntimeError(resp["error"].get("message", "svc 调用失败"))
    return resp.get("result")


def svc_read_settings(key):
    """读一个 settings 键（返回 str 或 None），供挂件命令消费线程使用。"""
    try:
        return svc("svc.settings.get", {"key": key}, timeout=5.0)
    except Exception:
        return None


def fire(method, params=None):
    """任意线程可用的推送式请求：只写不等响应（到点通知、状态持久化用）。

    宿主仍会为它回一行响应，但由 `_reader_loop` 按 id 派发——由于没人
    `_await` 这个 id，`_pending` 会积压一行。响应量极小（每轮计时几条），
    可接受；换成"不等就清理"反而要额外加锁判断，得不偿失。
    """
    _emit({"jsonrpc": "2.0", "id": _next_id(), "method": method, "params": params or {}})


def item(iid, title, desc="", badge="", icon="🧩", **meta):
    return {"id": iid, "title": title, "description": desc,
            "badge": badge, "icon": icon, "metadata": meta}


def full_text(p):
    sub = (p.get("subcommand") or "").strip()
    args = p.get("args") or []
    if sub:
        return " ".join([sub] + list(args)).strip()
    return (p.get("keyword") or "").strip()


def main(handlers):
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    # stdin 交给唯一的 reader 线程；主循环从 inbox 取消息。
    # 这样后台线程（计时通知 / 挂件命令消费）发 svc 时不会与主循环抢响应行。
    _start_response_dispatcher()

    while True:
        msg = _inbox_take()
        if msg is None:
            continue
        method = msg.get("method")
        if method == "initialize":
            _emit({"jsonrpc": "2.0", "id": msg.get("id"),
                   "result": {"protocol": "LLP/1", "plugin": PLUGIN}})
        elif method == "shutdown":
            break
        elif method == "call":
            inner = msg.get("params") or {}
            try:
                res = handlers[inner.get("method")](inner.get("params") or {})
                _emit({"jsonrpc": "2.0", "id": msg.get("id"), "result": res})
            except Exception as exc:  # noqa: BLE001
                _emit({"jsonrpc": "2.0", "id": msg.get("id"),
                       "error": {"message": str(exc)}})


def _notify(title, body):
    """系统通知 + 一条日志。后台线程调用，只写不读。"""
    try:
        fire("svc.notify.send", {"title": title, "body": body})
    except Exception:
        pass
    try:
        fire("svc.log.write", {"level": "info", "message": f"{title}：{body}"})
    except Exception:
        pass


def _worker(target, label, minutes, phase):
    while True:
        remain = target - time.time()
        if remain <= 0:
            break
        time.sleep(min(remain, 20))
    with _state_lock:
        # 已被新的计时覆盖，或已被暂停（暂停会改写 target）→ 本线程作废
        if abs(_state["target"] - target) > 0.001 or _state["paused"]:
            return
        _state["running"] = False
        _state["target"] = 0.0
    _on_phase_end(phase)


def _on_phase_end(phase):
    """一段走完：发通知，然后按 auto 决定「自动接下一段」还是「停在 hold 等按钮」。

    ⚠️ 停在 hold 时也必须把状态写进 settings（hold=1 / next_phase）：
    上一版只把 target 清零，挂件读到 target=0 就退回 IDLE_VIEW，于是
    5 分钟的计时跑完，桌面上显示的是「25:00 准备开始」——用户以为倒计时出错了。
    """
    with _state_lock:
        nxt = PHASE_BREAK if phase == PHASE_FOCUS else PHASE_FOCUS
        if phase == PHASE_FOCUS:
            _state["rounds"] += 1
        auto = _state["auto"]
        rounds = _state["rounds"]
    done = "专注" if phase == PHASE_FOCUS else "短休"
    nxt_name = "短休" if nxt == PHASE_BREAK else "专注"
    if auto:
        _notify(f"⏱{done}结束", f"第 {rounds} 轮 · 自动开始{nxt_name}")
        _start_phase(nxt)
        return
    _notify(f"⏱{done}结束", f"第 {rounds} 轮 · 点挂件的「{nxt_name} ▶」开始下一段")
    with _state_lock:
        _state["hold"] = True
        _state["next_phase"] = nxt
        _state["target"] = 0.0
        _state["running"] = False
        _state["paused"] = False
        _state["paused_remain"] = 0.0
    _persist()


def _start_phase(phase):
    """开始指定段：专注段用用户设定的分钟数，短休段用 5:1 推出来的分钟数。"""
    with _state_lock:
        if phase == PHASE_BREAK:
            minutes, label = _state["break_minutes"], "短休"
        else:
            minutes, label = _state["focus_minutes"], _state["focus_label"]
        _state["hold"] = False
    _arm(time.time() + minutes * 60, label, minutes, phase)


def _arm(target, label, minutes, phase=PHASE_FOCUS):
    with _state_lock:
        _state["target"] = target
        _state["label"] = label
        _state["minutes"] = minutes
        _state["phase"] = phase
        _state["running"] = True
        _state["paused"] = False
        _state["paused_remain"] = 0.0
        _state["hold"] = False
        # 下一段预告：专注之后是短休，短休之后是专注
        _state["next_phase"] = PHASE_BREAK if phase == PHASE_FOCUS else PHASE_FOCUS
    threading.Thread(target=_worker, args=(target, label, minutes, phase), daemon=True).start()
    _persist()


def _start_new(minutes, label):
    """开一轮全新的番茄钟：重置轮数、默认自动衔接、按 5:1 算出短休时长。"""
    bmin = break_minutes_of(minutes)
    with _state_lock:
        _state.update({"focus_minutes": minutes, "break_minutes": bmin,
                       "focus_label": label, "rounds": 0, "auto": True, "hold": False})
    _arm(time.time() + minutes * 60, label, minutes, PHASE_FOCUS)
    return bmin


def _next_segment():
    """hold 态下手动开始下一段。非 hold 态返回 False（没什么可"下一段"的）。"""
    with _state_lock:
        if not _state["hold"]:
            return False
        nxt = _state["next_phase"]
    _start_phase(nxt)
    return True


def _set_auto(on):
    """切换自动衔接。勾选时如果正停在 hold，立刻接上——用户的意图就是"别再等我"。"""
    with _state_lock:
        _state["auto"] = bool(on)
        hold, nxt = _state["hold"], _state["next_phase"]
    if on and hold:
        _start_phase(nxt)
        return True
    _persist()
    return bool(on)


def _persist():
    """把状态整体写进 settings —— 挂件（另一个进程）唯一能读到的地方。

    paused_remain 必须一并持久化：挂件的「继续」按钮要靠它判断当前是否
    处于暂停态（target=0 且 paused_remain>0）。漏掉它挂件就无从展示恢复入口，
    用户暂停后只能干瞪眼——这是真机反馈过的实际事故。
    hold / next_phase / phase 同理：它们决定挂件显示「时间到等按钮」还是「下一段」。
    """
    with _state_lock:
        snap = dict(_state)
    pairs = {
        "target": str(snap["target"]),
        "label": snap["label"],
        "minutes": str(snap["minutes"]),
        "paused_remain": str(snap["paused_remain"]),
        "phase": snap["phase"],
        "auto": "1" if snap["auto"] else "0",
        "hold": "1" if snap["hold"] else "0",
        "next_phase": snap["next_phase"],
        "rounds": str(snap["rounds"]),
        "break_minutes": str(snap["break_minutes"]),
        "focus_minutes": str(snap["focus_minutes"]),
        "focus_label": snap["focus_label"],
        # 单键快照：挂件每秒轮询一次，读一个 JSON 比读十几个键少一个数量级的 IPC。
        # 上面那些散装键仍然保留——面板/命令/人工排障都按名字取，且是 snap 缺失时
        # 挂件的回退数据源（旧版本留下的状态没有 snap）。
        "snap": json.dumps(snap, ensure_ascii=False),
    }
    for k, v in pairs.items():
        try:
            fire("svc.settings.set", {"key": k, "value": v})
        except Exception:
            pass


def _pause():
    """暂停：把剩余时间记下来，并把 target 归零让挂件显示暂停态。"""
    with _state_lock:
        if not _state["running"] or _state["paused"]:
            return False
        remain = _state["target"] - time.time()
        if remain <= 0:
            return False
        _state["paused"] = True
        _state["paused_remain"] = remain
        _state["target"] = 0.0
        _state["running"] = False
    _persist()
    return True


def _resume():
    """续计：把暂停时记下的剩余时间重新变成一个绝对目标时刻（同一段）。"""
    with _state_lock:
        if not _state["paused"] or _state["paused_remain"] <= 0:
            return False
        remain = _state["paused_remain"]
        label, minutes, phase = _state["label"], _state["minutes"], _state["phase"]
    _arm(time.time() + remain, label, minutes, phase)
    return True


def _stop():
    with _state_lock:
        was = _state["running"] or _state["paused"] or _state["hold"]
        _state.update({"running": False, "paused": False, "hold": False,
                       "target": 0.0, "paused_remain": 0.0, "rounds": 0,
                       "label": "", "phase": PHASE_FOCUS})
    # stopped 后暂停剩余也必须清零：挂件靠它判断显示哪个按钮，
    # 残留会让停止后的挂件又冒出继续按钮
    _persist()
    return was


def _remaining():
    with _state_lock:
        if _state["paused"]:
            return _state["paused_remain"], _state["label"], _state["minutes"], "paused"
        if _state["hold"]:
            # hold 是"这段跑完了、在等人点按钮"，既不是 running 也不是 idle：
            # 混进 idle 会让挂件/面板退回「准备开始 25:00」，把"时间到"这件事整个抹掉
            return 0.0, _state["label"], _state["minutes"], "hold"
        if not _state["running"] or _state["target"] <= 0:
            return None, "", 0, ""
        return (_state["target"] - time.time(), _state["label"], _state["minutes"], "running")


def _ui_snap():
    """给面板/命令用的状态副本（锁内取，避免读到跨字段撕裂的中间态）"""
    with _state_lock:
        return dict(_state)


def _fmt(sec):
    sec = max(0, int(sec))
    return f"{sec // 60:02d}:{sec % 60:02d}"


def _cn(phase):
    return "短休" if phase == PHASE_BREAK else "专注"


def _status_items():
    s = _ui_snap()
    auto_cn = "开" if s["auto"] else "关"
    nxt_cn = _cn(s["next_phase"])
    item_auto = item("pomo:auto", f"自动衔接：{auto_cn}",
                     "输入 /pomo auto on|off —— 开：到点自动开始下一段；"
                     "关：到点停下等你点「下一段」", badge="自动", icon="🔁")

    if s["paused"]:
        return [
            item("pomo:paused", _fmt(s["paused_remain"]),
                 f"已暂停 · {_cn(s['phase'])} · {s['label'] or '专注'}",
                 badge="暂停", icon="⏸️",
                 value=f"暂停中· {_cn(s['phase'])} · {s['label'] or '专注'}", label="已暂停"),
            item("pomo:resume", "继续计时", "输入 /pomo resume", badge="继续", icon="▶️"),
            item_auto,
            item("pomo:stop", "停止计时", "输入 /pomo stop", badge="停止", icon="⏹️"),
        ]

    # hold：一段跑完了，等用户点「下一段」。这一屏必须存在，否则用户只看到
    # 「准备开始」，以为计时器根本没跑完（真机反馈的实际问题）
    if s["hold"]:
        return [
            item("pomo:hold", f"已完成 {s['rounds']} 轮 · 等下一段",
                 f"下一段是{nxt_cn} · 自动衔接{auto_cn}",
                 badge="待开始", icon="⏭️",
                 value=f"{s['rounds']} 轮 · 待开始{nxt_cn}", label="待开始"),
            item("pomo:next", f"开始{nxt_cn}", "输入 /pomo next", badge="下一段", icon="▶️"),
            item_auto,
            item("pomo:stop", "停止计时", "输入 /pomo stop", badge="停止", icon="⏹️"),
        ]

    if not s["running"] or s["target"] <= 0:
        return [
            item("pomo:idle", "未在计时", "用法：/pomo start 25 写代码",
                 badge="空闲", icon="🍅"),
            item("pomo:hint", "专注 : 短休 = 5 : 1",
                 "25 分钟专注自动接 5 分钟短休；5 分钟专注接 1 分钟短休",
                 badge="提示", icon="⏱️"),
            item("pomo:pin", "显示桌面挂件", "在桌面显示倒计时小挂件",
                 badge="挂件", icon="🪟"),
        ]

    remain = s["target"] - time.time()
    icon = "🍅" if s["phase"] == PHASE_FOCUS else "☕"
    return [
        item("pomo:remain", _fmt(remain),
             f"剩余时间 · {_cn(s['phase'])} · {s['label'] or '专注'}",
             badge="进行中", icon=icon,
             value=f"{s['minutes']} 分钟 · {_cn(s['phase'])} · {s['label'] or '专注'}",
             label="计时"),
        item("pomo:endat", time.strftime("%H:%M:%S", time.localtime(time.time() + remain)),
             f"本段（{_cn(s['phase'])}）预计结束", badge="结束于", icon="🕒"),
        item("pomo:pause", "暂停计时", "输入 /pomo pause", badge="暂停", icon="⏸️"),
        item_auto,
        item("pomo:stop", "停止计时", "输入 /pomo stop", badge="停止", icon="⏹️"),
    ]


def _open_widget(pin=False):
    """打开挂件窗口。pin=True 时再尝试贴到桌面壁纸层。"""
    try:
        svc("svc.window.open", {"view": VIEW_WIDGET})
    except Exception as exc:
        return False, f"打开挂件失败：{exc}"

    if not pin:
        return True, "已在桌面显示倒计时挂件"

    # 贴壁纸层：Wayland 下必定失败，宿主会如实返回 unsupported，
    # 这里必须把降级事实告诉用户，不能谎称已贴到桌面
    try:
        res = svc("svc.window.attachDesktop", {"label": WIDGET_LABEL})
    except Exception as exc:
        return True, f"挂件已显示（贴壁纸层失败：{exc}），保持置顶浮窗"
    if isinstance(res, dict) and res.get("onWallpaper"):
        return True, "挂件已贴到桌面壁纸层（会被桌面图标遮挡）"
    reason = "未知原因"
    st = res.get("status") if isinstance(res, dict) else None
    if isinstance(st, dict):
        reason = st.get("reason") or reason
    return True, f"挂件已显示，但未能贴到壁纸层（{reason}），保持置顶浮窗"


def _cmd_loop():
    """消费挂件写来的命令（settings 的 `cmd` 键）。

    挂件按钮写 `pause:<ts>` / `stop:<ts>`，本线程读到后执行并**清空**该键。
    清空很重要：不清的话每次轮询都会重复执行同一条命令。
    带时间戳后缀是必要的——若值不变，某些 KV 实现会判为"未变更"而丢写。
    """
    while True:
        try:
            raw = svc_read_settings("cmd")
            if raw:
                # 值形如 `pause:<ts>` / `auto:on:<ts>`——第三段是时间戳，保证值必变
                parts = [p.strip().lower() for p in raw.split(":") if p.strip()]
                verb = parts[0] if parts else ""
                arg = parts[1] if len(parts) > 1 else ""
                # 先清空再执行：避免执行期间挂件又写一次而被重复消费
                fire("svc.settings.set", {"key": "cmd", "value": ""})
                if verb == "pause":
                    # 暂停态下再点暂停 = 继续（同一个按钮，省一个 UI 元素）
                    if not _pause():
                        _resume()
                elif verb == "resume":
                    # 挂件的「继续」按钮发独立动词，语义比复用 pause 清晰
                    _resume()
                elif verb == "next":
                    # hold 态下手动开始下一段（专注↔短休交替）
                    _next_segment()
                elif verb == "auto":
                    _set_auto(arg in ("1", "on", "true"))
                elif verb == "stop":
                    _stop()
        except Exception:
            # 宿主连接断开时不能崩：插件进程退出由宿主管理
            pass
        time.sleep(CMD_POLL_S)


def _restore_from_settings():
    """宿主重启后进程是新的：把 settings 里的状态搬回内存，必要时重新挂起计时线程。

    分段参数（phase/rounds/auto/短休时长/专注标签）与 hold/paused 标记必须一起恢复：
    只认 `target` 的话，重启后「专注 25 + 短休 5」的节奏会退化成「永远重复同一个
    分钟数的专注段」；而 hold/paused 不恢复，挂件上那两个按钮（下一段 / 继续）
    点下去就会静默失效——状态看得见、命令却没落地，最难排查的一类问题。
    """
    def num(key, default=0.0):
        try:
            return float(svc("svc.settings.get", {"key": key}) or default)
        except (TypeError, ValueError):
            return default

    def txt(key, default=""):
        try:
            return svc("svc.settings.get", {"key": key}) or default
        except Exception:
            return default

    stored_target = num("target")
    stored_phase = txt("phase", PHASE_FOCUS)
    phase = stored_phase if stored_phase in (PHASE_FOCUS, PHASE_BREAK) else PHASE_FOCUS
    nxt = txt("next_phase", PHASE_BREAK)
    next_phase = nxt if nxt in (PHASE_FOCUS, PHASE_BREAK) else PHASE_BREAK
    label = txt("label")
    focus_label = txt("focus_label")
    focus_minutes = int(num("focus_minutes", DEFAULT_MIN)) or DEFAULT_MIN
    break_minutes = int(num("break_minutes", break_minutes_of(focus_minutes))) or 1
    minutes = int(num("minutes", focus_minutes)) or focus_minutes
    paused_remain = num("paused_remain")
    hold = txt("hold") == "1"
    auto = txt("auto", "1") != "0"
    rounds = int(num("rounds"))

    with _state_lock:
        _state.update({"phase": phase, "next_phase": next_phase, "label": label,
                       "focus_label": focus_label, "focus_minutes": focus_minutes,
                       "break_minutes": break_minutes, "minutes": minutes,
                       "rounds": rounds, "auto": auto, "hold": hold,
                       "paused_remain": paused_remain})

    if stored_target > time.time():
        # 仍在计时：按原来的段重新挂线程（target 是 time.time 同源的秒级绝对时刻）
        _arm(stored_target, label, minutes, phase)
    elif paused_remain > 0:
        with _state_lock:
            _state["paused"] = True
    else:
        # 没在计时也要回写一次：升级前的旧状态里没有 `snap` 键，
        # 不补写的话挂件要等到下一次 start/stop 才看得到单键快照
        _persist()
    return True


def on_search(p):
    remain, _l, _m, phase = _remaining()
    if phase == "":
        _restore_from_settings()
    return {"items": _status_items(), "emptyText": "无结果"}


def on_execute(p):
    sub = (p.get("subcommand") or "").strip().lower()
    args = [str(a) for a in (p.get("args") or [])]

    if sub == "start":
        minutes = DEFAULT_MIN
        label_args = list(args)
        if label_args:
            try:
                minutes = int(float(label_args[0]))
                label_args = label_args[1:]
            except ValueError:
                pass
        minutes = max(1, min(minutes, 24 * 60))
        label = " ".join(label_args).strip()
        break_min = _start_new(minutes, label)
        # 新建番茄钟即在桌面显示挂件（用户明确要的行为）
        ok, msg = _open_widget(pin=False)
        tail = "，到点会通知你" if ok else ""
        return {"success": True,
                "message": (f"已开始 {minutes} 分钟专注{'：' + label if label else ''}"
                            f"（每段后接 {break_min} 分钟短休，自动衔接已开启）{tail}")}

    if sub == "stop":
        was = _stop()
        return {"success": True, "message": "已停止计时" if was else "当前没有在计时"}

    if sub == "pause":
        remain, _l, _m, phase = _remaining()
        if phase == "paused":
            _resume()
            return {"success": True, "message": "已继续计时"}
        if _pause():
            return {"success": True, "message": f"已暂停，剩余 {_fmt(remain)}"}
        return {"success": False, "message": "当前没有在计时"}

    if sub == "resume":
        if _resume():
            return {"success": True, "message": "已继续计时"}
        return {"success": False, "message": "当前不是暂停状态"}

    # /pomo next —— 停在「等下一段」时手动推进（专注↔短休交替）
    if sub == "next":
        if _next_segment():
            s = _ui_snap()
            return {"success": True,
                    "message": f"已开始{s['minutes']} 分钟{_cn(s['phase'])}"}
        return {"success": False, "message": "当前没有待开始的下一段（自动衔接开着或没在计时）"}

    # /pomo auto on|off —— 到点后是否自动开始下一段
    if sub == "auto":
        raw = args[0].strip().lower() if args else "on"
        if raw in ("on", "1", "true"):
            on = True
        elif raw in ("off", "0", "false"):
            on = False
        else:
            return {"success": False, "message": "用法：/pomo auto on|off"}
        _set_auto(on)
        s = _ui_snap()
        if on:
            msg = "已开启自动衔接：到点直接开始下一段"
            if s["phase"] == PHASE_FOCUS and s["running"]:
                msg += f"（本轮专注剩余 {_fmt(s['target'] - time.time())}）"
        else:
            msg = "已关闭自动衔接：每段结束后等你点挂件的「下一段 ▶」"
        return {"success": True, "message": msg}

    # /pomo pin —— 打开挂件并尝试贴到桌面壁纸层
    if sub == "pin":
        _ok, msg = _open_widget(pin=True)
        return {"success": True, "message": msg}

    # /pomo widget —— 只显示挂件，不尝试壁纸层
    if sub == "widget":
        _ok, msg = _open_widget(pin=False)
        return {"success": True, "message": msg}

    # /pomo where —— 诊断：报告当前后端与挂件窗口状态
    if sub == "where":
        s = _ui_snap()
        if s["paused"]:
            state, extra = "暂停", f" · {s['label'] or '专注'} · 剩余 {_fmt(s['paused_remain'])}"
        elif s["hold"]:
            state, extra = "等下一段", f" · 已完成 {s['rounds']} 轮 · 下一段是{_cn(s['next_phase'])}"
        elif s["running"] and s["target"] > time.time():
            state, extra = "计时中", f" · {_cn(s['phase'])} {s['label'] or '专注'} · 剩余 {_fmt(s['target'] - time.time())}"
        else:
            state, extra = "未计时", ""
        auto_cn = "开" if s["auto"] else "关"
        return {"success": True,
                "message": f"番茄钟{state}{extra} · 自动衔接{auto_cn} · 短休 {s['break_minutes']} 分钟"}

    return {"success": False,
            "message": "未知子命令。可用：start [分钟] [标签] / stop / pause / resume / "
                       "next（开始下一段）/ auto on|off（到点是否自动接下一段）/ pin / widget"}


def on_select(p):
    """面板项点选：把面板操作映射到同一批处理器，避免两处逻辑漂移。"""
    iid = (p.get("id") or "")
    if iid == "pomo:stop":
        return on_execute({"subcommand": "stop", "args": []})
    if iid == "pomo:pause":
        return on_execute({"subcommand": "pause", "args": []})
    if iid == "pomo:resume":
        return on_execute({"subcommand": "resume", "args": []})
    if iid == "pomo:next":
        return on_execute({"subcommand": "next", "args": []})
    if iid == "pomo:auto":
        # 点一下就是翻转开关，省得记 on/off
        return on_execute({"subcommand": "auto",
                           "args": ["off" if _ui_snap()["auto"] else "on"]})
    if iid == "pomo:pin":
        return on_execute({"subcommand": "pin", "args": []})
    if iid == "pomo:remain":
        # 点剩余时间 → 显示详细剩余（保持面板项有反馈，不做死条目）
        s = _ui_snap()
        if s["running"]:
            return {"toast": f"{_cn(s['phase'])} {s['label'] or '专注'}：剩余 {_fmt(s['target'] - time.time())}"}
        return {"toast": "未在计时"}
    if iid == "pomo:hold":
        return {"toast": f"已完成 {_ui_snap()['rounds']} 轮 · 点「下一段」继续"}
    return {}


HANDLERS = {"search": on_search, "execute": on_execute, "select": on_select}

if __name__ == "__main__":
    try:
        threading.Thread(target=_cmd_loop, daemon=True).start()
        main(HANDLERS)
    finally:
        sys.exit(0)
