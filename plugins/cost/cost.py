#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/cost 快速记账（自包含，仅标准库）。

持久化：svc.settings KV（JSON 列表）。
"""
import datetime
import json
import sys
import time

PLUGIN = "cost"
_seq = [1]
KEY = "items"


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


def load():
    raw = svc("svc.settings.get", {"key": KEY})
    if not raw:
        return []
    try:
        data = json.loads(raw)
        return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []
    except Exception:
        return []


def save(rows):
    svc("svc.settings.set", {"key": KEY, "value": json.dumps(rows, ensure_ascii=False)})


def _money(v):
    return f"{v:.2f}".rstrip("0").rstrip(".") if v != int(v) else str(int(v))


def _day(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def on_search(p):
    sub = (p.get("subcommand") or "").strip().lower()
    rows = load()
    out = []

    if sub in ("month", "月", "本月"):
        now = datetime.datetime.now()
        prefix = now.strftime("%Y-%m")
        picked = [r for r in rows if _day(r.get("ts", 0)).startswith(prefix)]
        total = sum(float(r.get("amount", 0)) for r in picked)
        by_note = {}
        for r in picked:
            by_note[r.get("note", "其他")] = by_note.get(r.get("note", "其他"), 0) + float(r.get("amount", 0))
        out.append(item("cost:total", f"¥{_money(total)}", f"{prefix} 共 {len(picked)} 笔",
                        badge="本月合计", icon="💰"))
        for note, amt in sorted(by_note.items(), key=lambda kv: -kv[1])[:12]:
            out.append(item(f"cost:cat:{note}", f"¥{_money(amt)}", note,
                            badge="分类", icon="🏷️"))
        return {"items": out or [item("cost:empty", "本月暂无记录", "", badge="空", icon="💰")],
                "emptyText": "本月暂无记录"}

    today = datetime.date.today().strftime("%Y-%m-%d")
    todays = [r for r in rows if _day(r.get("ts", 0)) == today]
    total = sum(float(r.get("amount", 0)) for r in todays)
    out.append(item("cost:today", f"¥{_money(total)}", f"今日 {len(todays)} 笔 · 共 {len(rows)} 条记录",
                    badge="今日合计", icon="💰"))
    out.append(item("cost:monthhint", "查看本月合计", "输入 /cost month",
                    badge="提示", icon="📅"))
    for r in list(reversed(rows))[:12]:
        idx = rows.index(r) + 1
        out.append(item(f"cost:{idx}", f"¥{_money(float(r.get('amount', 0)))}",
                        f"{_day(r.get('ts', 0))} · {r.get('note', '')}",
                        badge=f"#{idx}", icon="🧾", item_json=json.dumps(r, ensure_ascii=False)))
    return {"items": out, "emptyText": "暂无记录"}


def on_execute(p):
    sub = (p.get("subcommand") or "").strip().lower()
    args = [str(a) for a in (p.get("args") or [])]
    rows = load()

    if sub == "add":
        if not args:
            return {"success": False, "message": "用法：/cost add 25 午餐"}
        try:
            amount = float(args[0])
        except ValueError:
            return {"success": False, "message": "金额必须是数字，如 /cost add 25 午餐"}
        note = " ".join(args[1:]).strip() or "未分类"
        rows.append({"amount": amount, "note": note, "ts": int(time.time())})
        save(rows)
        return {"success": True, "message": f"已记录 ¥{_money(amount)} · {note}"}

    if sub == "del":
        if not args:
            return {"success": False, "message": "用法：/cost del 序号"}
        try:
            idx = int(args[0]) - 1
        except ValueError:
            return {"success": False, "message": "序号必须是数字"}
        if 0 <= idx < len(rows):
            gone = rows.pop(idx)
            save(rows)
            return {"success": True, "message": f"已删除 ¥{_money(float(gone.get('amount', 0)))}"}
        return {"success": False, "message": "序号超出范围"}

    return {"success": False, "message": f"未知子命令：{sub}"}


def on_select(p):
    md = p.get("metadata") or {}
    raw = md.get("item_json")
    if not raw:
        return {}
    r = json.loads(raw)
    return {"toast": f"{_day(r.get('ts', 0))} · ¥{_money(float(r.get('amount', 0)))} · {r.get('note', '')}"}


HANDLERS = {"search": on_search, "execute": on_execute, "select": on_select}

if __name__ == "__main__":
    try:
        main(HANDLERS)
    finally:
        sys.exit(0)
