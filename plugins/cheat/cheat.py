#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/cheat 命令速查（自包含，仅标准库）。

首次访问时写入内置常用命令种子；之后以用户数据为准（可删可加）。
持久化：svc.settings KV（JSON 列表）。
"""
import json
import sys

PLUGIN = "cheat"
_seq = [1]
KEY = "items"

SEEDS = [
    ("git 撤销最近提交（保留改动）", "git reset --soft HEAD~1", "git"),
    ("git 修改最后一次提交信息", "git commit --amend -m \"新信息\"", "git"),
    ("git 查看某文件历史", "git log -p --follow -- <path>", "git"),
    ("git 丢弃工作区改动", "git checkout -- <path>", "git"),
    ("git 暂存当前改动", "git stash push -m \"wip\"", "git"),
    ("git 恢复暂存", "git stash pop", "git"),
    ("git 删除已合并分支", "git branch --merged | grep -v '\\*' | xargs -n1 git branch -d", "git"),
    ("git 查看远程地址", "git remote -v", "git"),
    ("docker 列出运行中容器", "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'", "docker"),
    ("docker 进入容器 shell", "docker exec -it <容器> sh", "docker"),
    ("docker 清理悬空镜像", "docker image prune -f", "docker"),
    ("docker 查看容器日志", "docker logs -f --tail 100 <容器>", "docker"),
    ("k8s 查看 Pod 详情", "kubectl describe pod <pod> -n <ns>", "k8s"),
    ("k8s 进入 Pod", "kubectl exec -it <pod> -n <ns> -- sh", "k8s"),
    ("k8s 查看全部命名空间资源", "kubectl get all -A", "k8s"),
    ("端口占用（Windows）", "netstat -ano | findstr :8080", "net"),
    ("端口占用（Linux/mac）", "lsof -i :8080", "net"),
    ("查找文件（Linux）", "find /path -type f -name '*.log' -size +100M", "fs"),
    ("递归搜索内容", "grep -rn '关键字' --include='*.ts' .", "fs"),
    ("磁盘占用前 10（Linux）", "du -h --max-depth=1 | sort -rh | head -10", "fs"),
    ("JSON 美化（python）", "python -m json.tool file.json", "tool"),
    ("起一个本地静态服务器", "python -m http.server 8000", "tool"),
    ("生成随机密码", "python -c \"import secrets;print(secrets.token_urlsafe(16))\"", "tool"),
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
    """返回列表；None 表示从未保存过（用于一次性写入种子）。"""
    raw = svc("svc.settings.get", {"key": KEY})
    if raw is None or raw == "":
        return None
    try:
        data = json.loads(raw)
        return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []
    except Exception:
        return []


def save(rows):
    svc("svc.settings.set", {"key": KEY, "value": json.dumps(rows, ensure_ascii=False)})


def _seed():
    return [{"title": t, "content": c, "tag": g} for t, c, g in SEEDS]


def _oneline(s, n=60):
    s = str(s).replace("\r", " ").replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def on_search(p):
    keyword = (p.get("keyword") or "").strip().lower()
    rows = load()
    if rows is None:
        rows = _seed()
        save(rows)
    out = []
    for i, r in enumerate(rows):
        title = r.get("title", "")
        content = r.get("content", "")
        tag = r.get("tag", "")
        if keyword and keyword not in title.lower() and keyword not in content.lower() \
                and keyword not in tag.lower():
            continue
        out.append(item(f"cheat:{i}", _oneline(title), _oneline(content),
                        badge=tag or f"#{i + 1}", icon="📚",
                        content=content, label=title or "命令"))
    if not out:
        out = [item("cheat:hint", "没有匹配的条目",
                    "/cheat add \"标题\" 内容 添加",
                    badge="提示", icon="📚")]
    return {"items": out, "emptyText": "无匹配条目"}


def on_execute(p):
    sub = (p.get("subcommand") or "").strip().lower()
    args = [str(a) for a in (p.get("args") or [])]
    rows = load()
    if rows is None:
        rows = _seed()

    if sub == "add":
        if len(args) < 2:
            return {"success": False, "message": "用法：/cheat add \"标题\" 内容"}
        title = args[0].strip()
        content = " ".join(args[1:]).strip()
        if not content:
            return {"success": False, "message": "内容不能为空"}
        rows.append({"title": title, "content": content, "tag": "自定义"})
        save(rows)
        return {"success": True, "message": f"已添加：{title}"}

    if sub == "del":
        if not args:
            return {"success": False, "message": "用法：/cheat del 序号"}
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
    content = md.get("content")
    if not content:
        return {"toast": "该项无内容可复制"}
    return {"copy": str(content), "toast": f"已复制：{md.get('label', '')}"}


HANDLERS = {"search": on_search, "execute": on_execute, "select": on_select}

if __name__ == "__main__":
    try:
        main(HANDLERS)
    finally:
        sys.exit(0)
