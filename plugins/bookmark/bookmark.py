#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/bookmark 书签收藏（自包含，仅标准库）。

持久化：svc.settings KV（LLP 无 DDL 通道，故用 JSON 列表存于插件私有命名空间）。
"""
import json
import re
import sys
import time

PLUGIN = "bookmark"
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


def save(items):
    svc("svc.settings.set", {"key": KEY, "value": json.dumps(items, ensure_ascii=False)})


def on_search(p):
    keyword = (p.get("keyword") or "").strip().lower()
    rows = load()
    out = []
    for i, it in enumerate(rows):
        title = it.get("title") or it.get("url", "")
        url = it.get("url", "")
        if keyword and keyword not in title.lower() and keyword not in url.lower():
            continue
        out.append(item(f"bookmark:{i}", title, url, badge=f"#{i + 1}", icon="🔖", url=url))
    if not out:
        out = [item("bookmark:hint", "暂无书签",
                    "/bookmark add \"标题\" URL 添加",
                    badge="提示", icon="🔖")]
    return {"items": out, "emptyText": "无匹配书签"}


def on_execute(p):
    sub = (p.get("subcommand") or "").strip().lower()
    args = [str(a) for a in (p.get("args") or [])]
    rows = load()

    if sub == "add":
        if len(args) < 2:
            return {"success": False, "message": "用法：/bookmark add \"标题\" URL"}
        title, url = args[0].strip(), args[1].strip()
        if not title or not url:
            return {"success": False, "message": "标题与 URL 都不能为空"}
        if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url):
            url = "https://" + url
        rows.append({"title": title, "url": url, "created_at": int(time.time())})
        save(rows)
        return {"success": True, "message": f"已添加书签：{title}"}

    if sub == "del":
        if not args:
            return {"success": False, "message": "用法：/bookmark del 序号"}
        try:
            idx = int(args[0]) - 1
        except ValueError:
            return {"success": False, "message": "序号必须是数字"}
        if 0 <= idx < len(rows):
            gone = rows.pop(idx)
            save(rows)
            return {"success": True, "message": f"已删除：{gone.get('title', '')}"}
        return {"success": False, "message": "序号超出范围"}

    return {"success": False, "message": f"未知子命令：{sub}"}


def on_select(p):
    md = p.get("metadata") or {}
    url = md.get("url")
    if not url:
        return {"toast": "该项不是可打开的链接"}
    svc("svc.process.launch", {"target": url})
    return {"close": True, "toast": f"已打开 {url}"}


HANDLERS = {"search": on_search, "execute": on_execute, "select": on_select}

if __name__ == "__main__":
    try:
        main(HANDLERS)
    finally:
        sys.exit(0)
