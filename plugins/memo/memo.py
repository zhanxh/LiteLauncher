#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/memo 备忘速记（自包含，仅标准库）。

持久化：svc.settings KV（JSON 列表）。
"""
import datetime
import json
import sys
import time

PLUGIN = "memo"
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


def _stamp(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%m-%d %H:%M")


def _oneline(s, n=56):
    s = str(s).replace("\r", " ").replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def on_search(p):
    keyword = (p.get("keyword") or "").strip().lower()
    rows = load()
    out = []
    for i, r in enumerate(rows):
        content = r.get("content", "")
        if keyword and keyword not in content.lower():
            continue
        out.append(item(f"memo:{i}", _oneline(content), _stamp(r.get("ts", 0)),
                        badge=f"#{i + 1}", icon="📝", content=content, label="备忘"))
    out.reverse()
    if not out:
        out = [item("memo:hint", "暂无备忘", "/memo add 内容 记一条",
                    badge="提示", icon="📝")]
    return {"items": out, "emptyText": "无匹配备忘"}


def on_execute(p):
    sub = (p.get("subcommand") or "").strip().lower()
    args = [str(a) for a in (p.get("args") or [])]
    rows = load()

    if sub == "add":
        content = " ".join(args).strip()
        if not content:
            return {"success": False, "message": "用法：/memo add 内容"}
        rows.append({"content": content, "ts": int(time.time())})
        save(rows)
        return {"success": True, "message": f"已记下：{_oneline(content, 30)}"}

    if sub == "del":
        if not args:
            return {"success": False, "message": "用法：/memo del 序号"}
        try:
            idx = int(args[0]) - 1
        except ValueError:
            return {"success": False, "message": "序号必须是数字"}
        if 0 <= idx < len(rows):
            rows.pop(idx)
            save(rows)
            return {"success": True, "message": "已删除"}
        return {"success": False, "message": "序号超出范围"}

    if sub == "clear":
        n = len(rows)
        save([])
        return {"success": True, "message": f"已清空 {n} 条备忘"}

    return {"success": False, "message": f"未知子命令：{sub}"}


def on_select(p):
    md = p.get("metadata") or {}
    content = md.get("content")
    if not content:
        return {"toast": "该项无内容可复制"}
    return {"copy": str(content), "toast": "已复制备忘内容"}


HANDLERS = {"search": on_search, "execute": on_execute, "select": on_select}

if __name__ == "__main__":
    try:
        main(HANDLERS)
    finally:
        sys.exit(0)
