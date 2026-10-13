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
"""
import json
import sys
import threading
import time

PLUGIN = "pomo"
DEFAULT_MIN = 25

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
_state = {"target": 0.0, "label": "", "minutes": 0, "running": False,
          "paused": False, "paused_remain": 0.0}


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


def _worker(target, label, minutes):
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
    _persist("", 0)
    title = "⏱番茄钟结束"
    body = f"{label or '专注'} · {minutes} 分钟已结束"
    try:
        fire("svc.notify.send", {"title": title, "body": body})
    except Exception:
        pass
    try:
        fire("svc.log.write", {"level": "info", "message": f"番茄钟结束：{body}"})
    except Exception:
        pass


def _arm(target, label, minutes):
    with _state_lock:
        _state["target"] = target
        _state["label"] = label
        _state["minutes"] = minutes
        _state["running"] = True
        _state["paused"] = False
        _state["paused_remain"] = 0.0
    threading.Thread(target=_worker, args=(target, label, minutes), daemon=True).start()
    _persist(label, minutes, target)


def _persist(label, minutes, target=0.0):
    """把状态写进 settings —— 这是挂件（另一个进程）唯一能读到的地方。"""
    for k, v in (("target", str(target)), ("label", label), ("minutes", str(minutes))):
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
        label, minutes = _state["label"], _state["minutes"]
        _state["target"] = 0.0
        _state["running"] = False
    _persist(label, minutes, 0.0)
    return True


def _resume():
    """续计：把暂停时记下的剩余时间重新变成一个绝对目标时刻。"""
    with _state_lock:
        if not _state["paused"] or _state["paused_remain"] <= 0:
            return False
        remain = _state["paused_remain"]
        label, minutes = _state["label"], _state["minutes"]
    _arm(time.time() + remain, label, minutes)
    return True


def _stop():
    with _state_lock:
        was = _state["running"] or _state["paused"]
        _state.update({"running": False, "paused": False,
                       "target": 0.0, "paused_remain": 0.0})
    _persist("", 0, 0.0)
    return was


def _remaining():
    with _state_lock:
        if _state["paused"]:
            return _state["paused_remain"], _state["label"], _state["minutes"], "paused"
        if not _state["running"] or _state["target"] <= 0:
            return None, "", 0, ""
        return (_state["target"] - time.time(), _state["label"], _state["minutes"], "running")


def _fmt(sec):
    sec = max(0, int(sec))
    return f"{sec // 60:02d}:{sec % 60:02d}"


def _status_items():
    remain, label, minutes, phase = _remaining()
    if phase == "paused":
        return [
            item("pomo:paused", _fmt(remain), f"已暂停 · {label or '专注'}",
                 badge="暂停", icon="⏸️",
                 value=f"暂停中· {label or '专注'}", label="已暂停"),
            item("pomo:resume", "继续计时", "输入 /pomo resume", badge="继续", icon="▶️"),
            item("pomo:stop", "停止计时", "输入 /pomo stop", badge="停止", icon="⏹️"),
        ]
    if phase != "running":
        return [
            item("pomo:idle", "未在计时", "用法：/pomo start 25 写代码",
                 badge="空闲", icon="🍅"),
            item("pomo:hint", "常用时长", "25（经典）/ 5（短休）/ 50（长专注）",
                 badge="提示", icon="⏱️"),
            item("pomo:pin", "显示桌面挂件", "在桌面显示倒计时小挂件",
                 badge="挂件", icon="🪟"),
        ]
    return [
        item("pomo:remain", _fmt(remain), f"剩余时间 · {label or '专注'}",
             badge="进行中", icon="🍅",
             value=f"{minutes} 分钟 · {label or '专注'}", label="计时"),
        item("pomo:endat", time.strftime("%H:%M:%S", time.localtime(time.time() + remain)),
             "预计结束时间", badge="结束于", icon="🕒"),
        item("pomo:pause", "暂停计时", "输入 /pomo pause", badge="暂停", icon="⏸️"),
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
                verb = raw.split(":", 1)[0].strip().lower()
                # 先清空再执行：避免执行期间挂件又写一次而被重复消费
                fire("svc.settings.set", {"key": "cmd", "value": ""})
                if verb == "pause":
                    # 暂停态下再点暂停 = 继续（同一个按钮，省一个 UI 元素）
                    if not _pause():
                        _resume()
                elif verb == "stop":
                    _stop()
        except Exception:
            # 宿主连接断开时不能崩：插件进程退出由宿主管理
            pass
        time.sleep(CMD_POLL_S)


def on_search(p):
    # 宿主重启后进程是新的：若存储里的计时仍在未来且本地未运行，则重新挂起线程
    remain, _l, _m, phase = _remaining()
    if phase == "":
        stored = svc("svc.settings.get", {"key": "target"})
        try:
            stored_target = float(stored) if stored else 0.0
        except (TypeError, ValueError):
            stored_target = 0.0
        if stored_target > time.time():
            label = svc("svc.settings.get", {"key": "label"}) or "恢复的计时"
            mins_raw = svc("svc.settings.get", {"key": "minutes"}) or "0"
            try:
                mins = int(float(mins_raw))
            except ValueError:
                mins = 0
            _arm(stored_target, label, mins)
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
        target = time.time() + minutes * 60
        _arm(target, label, minutes)
        # 新建番茄钟即在桌面显示挂件（用户明确要的行为）
        ok, msg = _open_widget(pin=False)
        tail = "，到点会通知你" if ok else ""
        return {"success": True, "message": f"已开始 {minutes} 分钟计时{'：' + label if label else ''}{tail}"}

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
        remain, label, _m, phase = _remaining()
        state = "未计时" if phase == "" else ("暂停" if phase == "paused" else "计时中")
        return {"success": True,
                "message": f"番茄钟{state}" + (f" · {label} · 剩余 {_fmt(remain)}" if remain else "")}

    return {"success": False,
            "message": "未知子命令。可用：start [分钟] [标签] / stop / pause / resume / pin / widget"}


def on_select(p):
    """面板项点选：把面板操作映射到同一批处理器，避免两处逻辑漂移。"""
    iid = (p.get("id") or "")
    if iid == "pomo:stop":
        return on_execute({"subcommand": "stop", "args": []})
    if iid == "pomo:pause":
        return on_execute({"subcommand": "pause", "args": []})
    if iid == "pomo:resume":
        return on_execute({"subcommand": "resume", "args": []})
    if iid == "pomo:pin":
        return on_execute({"subcommand": "pin", "args": []})
    if iid == "pomo:remain":
        # 点剩余时间 → 显示详细剩余（保持面板项有反馈，不做死条目）
        remain, label, _m, _p = _remaining()
        return {"toast": f"{label or '专注'}：剩余 {_fmt(remain)}"}
    return {}


HANDLERS = {"search": on_search, "execute": on_execute, "select": on_select}

if __name__ == "__main__":
    try:
        threading.Thread(target=_cmd_loop, daemon=True).start()
        main(HANDLERS)
    finally:
        sys.exit(0)
