#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/pomo 番茄钟（自包含，仅标准库）。

要点：sidecar 常驻，用后台线程计时；到点经**推送式** svc.notify.send 发系统通知
（后台线程只写不读 stdout；宿主对每个 svc 请求会回一行响应，主循环会忽略它，
因此不会污染协议）。
"""
import json
import sys
import threading
import time

PLUGIN = "pomo"
DEFAULT_MIN = 25

_seq = [1]
_io_lock = threading.Lock()
_state_lock = threading.Lock()
_state = {"target": 0.0, "label": "", "minutes": 0, "running": False}


def _next_id():
    with _io_lock:
        rid = _seq[0]
        _seq[0] += 1
        return rid


def _emit(obj):
    with _io_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def svc(method, params=None):
    """主线程使用的同步反向请求（写请求 → 读响应）。"""
    _emit({"jsonrpc": "2.0", "id": _next_id(), "method": method, "params": params or {}})
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("宿主连接已关闭")
    resp = json.loads(line)
    if "error" in resp:
        raise RuntimeError(resp["error"].get("message", "svc 调用失败"))
    return resp.get("result")


def fire(method, params=None):
    """任意线程可用的推送式请求：只写不读（响应由主循环丢弃）。"""
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
    for raw in sys.stdin:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
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
        # 其它行（含后台线程 svc 响应）：忽略


def _worker(target, label, minutes):
    while True:
        remain = target - time.time()
        if remain <= 0:
            break
        time.sleep(min(remain, 20))
    with _state_lock:
        if abs(_state["target"] - target) > 0.001:
            return  # 已被新的计时覆盖
        _state["running"] = False
        _state["target"] = 0.0
    title = "⏱ 番茄钟结束"
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
    threading.Thread(target=_worker, args=(target, label, minutes), daemon=True).start()


def _remaining():
    with _state_lock:
        if not _state["running"] or _state["target"] <= 0:
            return None, "", 0
        return _state["target"] - time.time(), _state["label"], _state["minutes"]


def _fmt(sec):
    sec = max(0, int(sec))
    return f"{sec // 60:02d}:{sec % 60:02d}"


def _status_items():
    remain, label, minutes = _remaining()
    if remain is None:
        return [
            item("pomo:idle", "未在计时", "用法：/pomo start 25 写代码",
                 badge="空闲", icon="🍅"),
            item("pomo:hint", "常用时长", "25（经典）/ 5（短休）/ 50（长专注）",
                 badge="提示", icon="⏱️"),
        ]
    return [
        item("pomo:remain", _fmt(remain), f"剩余时间 · {label or '专注'}",
             badge="进行中", icon="🍅",
             value=f"{minutes} 分钟 · {label or '专注'}", label="计时"),
        item("pomo:endat", time.strftime("%H:%M:%S", time.localtime(time.time() + remain)),
             "预计结束时间", badge="结束于", icon="🕒"),
        item("pomo:stop", "停止计时", "输入 /pomo stop", badge="停止", icon="⏹️"),
    ]


def on_search(p):
    stored = svc("svc.settings.get", {"key": "target"})
    try:
        stored_target = float(stored) if stored else 0.0
    except Exception:
        stored_target = 0.0
    # 宿主重启后进程是新的：若存储里的计时仍在未来且本地未运行，则重新挂起线程
    with _state_lock:
        running = _state["running"]
    if not running and stored_target > time.time():
        _arm(stored_target, "恢复的计时", 0)
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
        svc("svc.settings.set", {"key": "target", "value": str(target)})
        svc("svc.settings.set", {"key": "label", "value": label})
        svc("svc.settings.set", {"key": "minutes", "value": str(minutes)})
        return {"success": True,
                "message": f"已开始 {minutes} 分钟计时{'：' + label if label else ''}，到点会通知你"}

    if sub == "stop":
        with _state_lock:
            was = _state["running"]
            _state["running"] = False
            _state["target"] = 0.0
        svc("svc.settings.set", {"key": "target", "value": ""})
        return {"success": True, "message": "已停止计时" if was else "当前没有在计时"}

    return {"success": False, "message": f"未知子命令：{sub}（可用 start / stop）"}


def on_select(p):
    return {}


HANDLERS = {"search": on_search, "execute": on_execute, "select": on_select}

if __name__ == "__main__":
    try:
        main(HANDLERS)
    finally:
        sys.exit(0)
