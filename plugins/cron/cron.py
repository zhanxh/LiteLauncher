#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/cron Cron 表达式解析（自包含，仅标准库）。

仅解析与解释（不做任务调度）：描述含义 + 计算未来 5 次触发时间。
"""
import datetime
import json
import re
import sys

PLUGIN = "cron"
_seq = [1]


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


MACROS = {
    "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
}

DOW_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]


def _parse_field(expr, lo, hi):
    """解析单个字段为 (取值集合, 是否通配)。"""
    vals = set()
    wildcard = expr in ("*", "?")
    for seg in str(expr).split(","):
        seg = seg.strip()
        if not seg:
            continue
        step = 1
        if "/" in seg:
            seg, s = seg.split("/", 1)
            step = int(s)
        if seg in ("*", "?"):
            start, end = lo, hi
        elif "-" in seg:
            a, b = seg.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(seg)
        for v in range(start, end + 1, step):
            if lo <= v <= hi:
                vals.add(v)
    return vals, wildcard


def _describe(expr, unit, names=None):
    if expr in ("*", "?"):
        return f"每{unit}"
    parts = []
    for seg in str(expr).split(","):
        seg = seg.strip()
        step = None
        if "/" in seg:
            seg, s = seg.split("/", 1)
            step = int(s)
        if seg in ("*", "?"):
            parts.append(f"每 {step} {unit}")
            continue
        if "-" in seg:
            a, b = seg.split("-", 1)
            if names:
                label = f"{names[int(a) % 7]}–{names[int(b) % 7]}"
            else:
                label = f"{a}–{b}"
        elif names:
            label = names[int(seg) % 7]
        else:
            label = str(seg)
        if step:
            label += f"（步长 {step}）"
        parts.append(f"{label}{unit}" if not names else label)
    sep = "、"
    return sep.join(parts)


def _next_runs(minutes, hours, doms, months, dows, dom_star, dow_star, n=5):
    now = datetime.datetime.now()
    starts = (now + datetime.timedelta(minutes=1)).replace(second=0, microsecond=0)
    out = []
    day = starts.replace(hour=0, minute=0)
    for _ in range(1500):
        if len(out) >= n:
            break
        if day.month in months:
            day_ok = day.day in doms
            dow_ok = ((day.weekday() + 1) % 7) in dows
            if dom_star and dow_star:
                ok = True
            elif dom_star:
                ok = dow_ok
            elif dow_star:
                ok = day_ok
            else:
                ok = day_ok or dow_ok
            if ok:
                for hh in sorted(hours):
                    for mm in sorted(minutes):
                        dt = day.replace(hour=hh, minute=mm)
                        if dt >= starts and len(out) < n:
                            out.append(dt)
        day += datetime.timedelta(days=1)
    return out


def on_search(p):
    text = full_text(p).strip()
    if not text:
        return {
            "items": [
                item("cron:hint", "输入 5 段 cron 表达式", "分 时 日 月 周，如 0 9 * * 1-5",
                     badge="用法", icon="⏰"),
                item("cron:ex1", "0 9 * * 1-5", "工作日 09:00", badge="示例", icon="⏰"),
                item("cron:ex2", "*/15 * * * *", "每 15 分钟", badge="示例", icon="⏰"),
                item("cron:ex3", "0 0 1 * *", "每月 1 日 00:00", badge="示例", icon="⏰"),
            ],
            "emptyText": "输入 cron 表达式",
        }

    expr = MACROS.get(text.split()[0].lower() if text.startswith("@") else "", text)
    fields = expr.split()
    if len(fields) != 5:
        return {"items": [item("cron:err", "字段数不对", f"需要 5 段，当前 {len(fields)} 段",
                               badge="错误", icon="❌")],
                "emptyText": "格式错误"}

    try:
        minutes, m_star = _parse_field(fields[0], 0, 59)
        hours, h_star = _parse_field(fields[1], 0, 23)
        doms, dom_star = _parse_field(fields[2], 1, 31)
        months, mo_star = _parse_field(fields[3], 1, 12)
        raw_dows, dow_star = _parse_field(re.sub(r"(?<!\d)7(?!\d)", "0", fields[4]), 0, 6)
        dows = raw_dows
    except Exception as exc:
        return {"items": [item("cron:err", "字段解析失败", str(exc),
                               badge="错误", icon="❌")],
                "emptyText": "解析失败"}

    if not (minutes and hours and doms and months and dows):
        return {"items": [item("cron:err", "表达式无有效取值", expr,
                               badge="错误", icon="❌")],
                "emptyText": "无有效取值"}

    desc = " · ".join([
        _describe(fields[0], "分钟"),
        _describe(fields[1], "小时"),
        _describe(fields[2], "日"),
        _describe(fields[3], "月"),
        _describe(fields[4], "周", names=DOW_NAMES),
    ])

    out = [
        item("cron:desc", desc[:76], f"表达式：{expr}", badge="含义", icon="⏰",
             value=expr, label="cron 表达式"),
        item("cron:next", "未来 5 次触发", "按本地时区计算", badge="计划", icon="📅"),
    ]
    for i, dt in enumerate(_next_runs(minutes, hours, doms, months, dows, dom_star, dow_star)):
        out.append(item(f"cron:n{i}", dt.strftime("%Y-%m-%d %H:%M"), DOW_NAMES[(dt.weekday() + 1) % 7],
                        badge=f"+{i + 1}", icon="🕒", value=dt.strftime("%Y-%m-%d %H:%M:%S"),
                        label="触发时间"))
    return {"items": out, "emptyText": "无结果"}


def on_select(p):
    md = p.get("metadata") or {}
    val = md.get("value")
    if not val:
        return {"toast": "该项无内容可复制"}
    return {"copy": str(val), "toast": f"已复制 {md.get('label', '结果')}"}


HANDLERS = {"search": on_search, "select": on_select}

if __name__ == "__main__":
    try:
        main(HANDLERS)
    finally:
        sys.exit(0)
