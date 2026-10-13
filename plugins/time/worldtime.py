#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/time 世界时钟（自包含，仅标准库）。

时区优先用 zoneinfo（需要系统/包内 IANA 数据），不可用时降级为固定 UTC 偏移
（此时夏令时会不准，description 中会标注）。
"""
import datetime
import json
import sys

PLUGIN = "time"
_seq = [1]

# (中文名, IANA 时区, 无 tzdata 时的固定偏移小时)
CITIES = [
    ("北京", "Asia/Shanghai", 8),
    ("东京", "Asia/Tokyo", 9),
    ("首尔", "Asia/Seoul", 9),
    ("新加坡", "Asia/Singapore", 8),
    ("迪拜", "Asia/Dubai", 4),
    ("伦敦", "Europe/London", 0),
    ("巴黎", "Europe/Paris", 1),
    ("柏林", "Europe/Berlin", 1),
    ("莫斯科", "Europe/Moscow", 3),
    ("纽约", "America/New_York", -5),
    ("洛杉矶", "America/Los_Angeles", -8),
    ("圣保罗", "America/Sao_Paulo", -3),
    ("开罗", "Africa/Cairo", 2),
    ("悉尼", "Australia/Sydney", 10),
]


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def svc(method, params=None):
    _emit({"jsonrpc": "2.0", "id": _seq[0], "method": method, "params": params or {}})
    _seq[0] += 1
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("宿主连接已关闭")
    resp = json.loads(line)
    if "error" in resp:
        raise RuntimeError(resp["error"].get("message", "svc 调用失败"))
    return resp.get("result")


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


def _tz(iana, fallback_hours):
    try:
        from zoneinfo import ZoneInfo  # Python 3.9+；Windows 需 tzdata 包
        return ZoneInfo(iana), True
    except Exception:
        return datetime.timezone(datetime.timedelta(hours=fallback_hours)), False


def _offset_label(dt, local_now):
    diff = dt.utcoffset() - local_now.utcoffset()
    hours = diff.total_seconds() / 3600.0
    if abs(hours) < 0.01:
        return "与本地同时"
    sign = "+" if hours > 0 else "−"
    h = abs(hours)
    text = f"{sign}{int(h)}" if h == int(h) else f"{sign}{h:.1f}"
    return f"本地 {text} 小时"


def on_search(p):
    keyword = full_text(p).strip().lower()
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    local_now = datetime.datetime.now().astimezone()
    out = [
        item("time:local", local_now.strftime("%H:%M:%S"),
             f"本地 · {local_now.strftime('%Y-%m-%d %A')}",
             badge="本地", icon="🏠"),
    ]
    matched = 0
    for i, (name, iana, fallback) in enumerate(CITIES):
        if keyword and keyword not in name.lower() and keyword not in iana.lower():
            continue
        tz, real = _tz(iana, fallback)
        dt = now_utc.astimezone(tz)
        note = "" if real else "（夏令时可能不准）"
        out.append(item(f"time:{i}", dt.strftime("%H:%M"),
                        f"{name} · {_offset_label(dt, local_now)}{note}",
                        badge=name, icon="🌍",
                        value=f"{name} {dt.strftime('%Y-%m-%d %H:%M')}", label=name))
        matched += 1
    if keyword and matched == 0:
        return {"items": [item("time:err", "未找到该城市", keyword,
                               badge="提示", icon="🌍")],
                "emptyText": "未找到该城市"}
    return {"items": out, "emptyText": "无结果"}


def on_select(p):
    md = p.get("metadata") or {}
    val = md.get("value")
    if not val:
        return {"toast": "该项无内容可复制"}
    return {"copy": str(val), "toast": f"已复制 {md.get('label', '时间')}"}


HANDLERS = {"search": on_search, "select": on_select}

if __name__ == "__main__":
    try:
        main(HANDLERS)
    finally:
        sys.exit(0)
