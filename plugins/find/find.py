#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/find 文件搜索（走系统索引）。

两个后端，同一套接口，按平台二选一：
  Windows → everything.py（Everything64.dll，NTFS USN Journal 索引，7~35ms）
  Linux   → locate.py（plocate trigram 索引；退化时用 fd/find 遍历）

为什么不自己遍历：索引工具已经把全盘文件收好了，实测 Everything 7~35ms、
plocate 0.008s（2700 万文件）。自己遍历就是"一个更慢的系统搜索"，
且在按体积/时间排序时根本拿不到元数据。

宿主能力：不新增任何 svc.*。sidecar 是独立进程，能自己加载 DLL / 调 locate、
自己 open 文件夹。真正用到的宿主能力只有 launch（打开文件/定位文件）。
"""

import json
import os
import sys
import threading
import time

# sidecar 的 cwd 不保证是插件目录，插件内模块要能直接 import
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import format  # noqa: E402  必须在 sys.path 调整之后

PLUGIN = "find"
DEFAULT_LIMIT = 20
MAX_LIMIT = 100
SIDE_KEY = "recent_dirs"

IS_WINDOWS = os.name == "nt"

_seq = [1]

# 后端是 per-thread 状态（Everything 的搜索词 + 结果游标），并发查询必须串行
_query_lock = threading.Lock()

USAGE_HINTS = [
    "报告.md",
    "ext:rs clippy",
    "size:>500mb",
    "dm:today",
    "D:\\codes\\ 文件名" if IS_WINDOWS else "~/codes/ 文件名",
]

# 排序别名：Everything 用数字 sort code，这里给可读名字
SORT_ALIASES = {
    "name": 1,
    "path": 2,
    "size": 3,
    "ext": 4,
    "type": 5,
    "dm": 11,
    "dc": 12,
    "da": 13,
}
SORT_DESC_FLAG = 0x80000000


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


def now_ms():
    return int(time.time() * 1000)


# ── 搜索后端（懒加载 + 复用）────────────────────────────────────
# Windows: Everything（everything.py） / Linux: plocate（locate.py）
# 两者接口一致，调用方无需关心平台。
_backend = None
_load_error = ""


def get_backend():
    global _backend, _load_error
    if _backend is not None or _load_error:
        return _backend
    try:
        if IS_WINDOWS:
            from everything import Everything
            _backend = Everything()
        else:
            from locate import LocateIndex
            _backend = LocateIndex()
    except Exception as exc:  # noqa: BLE001
        _load_error = str(exc)
        _backend = None
    return _backend


def backend_label():
    """给「不可用」引导面板用的后端名，跟踪实际加载结果。"""
    return "Everything" if IS_WINDOWS else "plocate"


def unavailable_hint():
    if IS_WINDOWS:
        return ("本插件依赖 Everything 的索引。请先安装并运行 Everything"
                "（https://www.voidtools.com），再把 SDK 的 Everything64.dll "
                "放到插件的 bin/ 目录。")
    return ("本插件依赖 plocate 全盘索引（查询毫秒级）。安装并建库：\n"
            "  Debian/Ubuntu: sudo apt install plocate && sudo updatedb\n"
            "  Fedora/RHEL:   sudo dnf install plocate && sudo updatedb\n"
            "没有索引时会降级为 fd / find 遍历——只搜用户目录、每查一次全扫一遍，"
            "大目录会超过 5 秒调用上限，基本不可用。装好后可用 /find where 查看状态。")


CONTROL_WORDS = {"desc", "asc", "limit", "recent", "open", "dir", "where"}


def _scan(tokens):
    """扫一遍，把控制词与其"参数 token"标出来。

    不能简单地把 desc/asc/limit 及其后一个词删掉——字段名（size/dm/...）
    完全可能与用户想搜的词重名。判定依据只能是"参数是否合法"：
      - desc/asc 的参数：必须是已知的排序字段名；否则 desc/asc 本身也保留为搜索词
      - limit 的参数：必须是正整数；否则 limit 本身也保留为搜索词
    返回 (搜索词列表, 排序 code or None, limit or None)
    """
    kept = []
    sort_code = None
    limit = None
    i = 0
    n = len(tokens)
    while i < n:
        low = tokens[i].lower()
        if low in ("desc", "asc") and i + 1 < n:
            field = tokens[i + 1].lower()
            if field in SORT_ALIASES:
                sort_code = SORT_ALIASES[field] | (SORT_DESC_FLAG if low == "desc" else 0)
                i += 2
                continue
            # 字段不合法 → desc/asc 本身当普通搜索词，继续看下一个 token
            kept.append(tokens[i])
            i += 1
            continue
        if low == "limit" and i + 1 < n and tokens[i + 1].isdigit():
            limit = max(1, min(MAX_LIMIT, int(tokens[i + 1])))
            i += 2
            continue
        # 开头的子命令单独处理（recent/open/dir/where 是 Action，不进搜索）
        if i == 0 and low in ("recent", "open", "dir", "where"):
            i += 1
            continue
        kept.append(tokens[i])
        i += 1
    return kept, sort_code, limit


def parse_query(keyword, args):
    """把 LLP 参数还原成 Everything 搜索表达式。

    注意壳层的切分规则（src/core/parser.ts）：
      - `queryText` = trigger 之后**所有 token 原样用空格拼接**（含子命令）
      - `subcommand` = 第一个不以 `-` 开头的 token，会从 `args` 里被挖掉
    所以这里**不能**把 args 再拼到 keyword 后面（会重复），
    只需要从整串里剥掉控制词。
    """
    tokens = (keyword or "").split()
    kept, _, _ = _scan(tokens)
    return " ".join(kept).strip()


def resolve_sort(keyword, subcommand, args):
    """从整串输入里解析排序。

    Everything 的 sort code：低 16 位是字段，高位 0x80000000 是降序。
    排序信息可能落在 keyword 里（queryText 是整串），也可能落在 args 里。
    """
    tokens = (keyword or "").split() + list(args or [])
    # keyword 与 args 有重叠（queryText 已含全部 token），只扫 keyword 即可，
    # 但 subcommand 单独可能在 args 里，补扫一次不会重复剥离
    _, code, _ = _scan(tokens)
    return code


def resolve_limit(keyword, subcommand, args, default=DEFAULT_LIMIT):
    tokens = (keyword or "").split() + list(args or [])
    _, _, limit = _scan(tokens)
    return limit if limit is not None else default


def load_side():
    raw = svc("svc.settings.get", {"key": SIDE_KEY})
    if not raw:
        return []
    try:
        return json.loads(raw)
    except Exception:  # noqa: BLE001
        return []


def save_side(items):
    svc("svc.settings.set", {"key": SIDE_KEY,
                             "value": json.dumps(items[:10], ensure_ascii=False)})


def push_recent_dir(path):
    items = [p for p in load_side() if p != path]
    items.insert(0, path)
    save_side(items)


# ── handler ─────────────────────────────────────────────────────
def on_search(p):
    keyword = (p.get("keyword") or "").strip()
    sub = (p.get("subcommand") or "").strip().lower()
    args = [str(a) for a in (p.get("args") or [])]

    if not keyword and not sub:
        syntax = ("支持 Everything 原生语法" if IS_WINDOWS
                  else "支持 ext: / size: / dm: / name: / path: / type: 语法")
        return format.build_usage(USAGE_HINTS, syntax)

    ev = get_backend()
    if ev is None:
        return format.build_unavailable(
            f"未检测到可用的文件索引（{backend_label()}）",
            unavailable_hint())
    if not ev.db_loaded():
        if IS_WINDOWS:
            return format.build_unavailable("Everything 数据库仍在加载", "稍等几秒再试")
        return format.build_unavailable(
            "文件索引库尚未生成",
            "请执行 sudo updatedb 生成索引（首次建库可能需要几分钟）。"
            "未建库时插件会自动降级为 fd / find 遍历。")

    # /find recent —— 最近打开过的目录
    if sub == "recent":
        items = []
        for i, d in enumerate(load_side()):
            items.append({
                "id": f"find:recent:{i}",
                "title": os.path.basename(d.rstrip("\\/")) or d,
                "description": d,
                "badge": "最近",
                "icon": "🕘",
                "metadata": {"path": d, "isDir": True},
            })
        if not items:
            items = [{
                "id": "find:recent:empty",
                "title": "还没有最近目录",
                "description": "打开搜索结果里的文件夹后会自动记在这里",
                "badge": "空",
                "icon": "🕘",
                "metadata": {},
            }]
        return {"items": items, "emptyText": "无最近目录"}

    sort = resolve_sort(keyword, sub, args)
    limit = resolve_limit(keyword, sub, args)
    term = parse_query(keyword, args)

    t0 = time.perf_counter()
    with _query_lock:
        total, rows = ev.search(term, max_results=limit, sort=sort)
    elapsed_ms = (time.perf_counter() - t0) * 1000

    now = now_ms()
    items = []
    for i, r in enumerate(rows):
        items.append(format.build_row(r, now, total=total, rank=i + 1))
    items.append(format.build_footer(
        total, len(rows), elapsed_ms,
        source=f"{backend_label()} 索引" if IS_WINDOWS else f"{backend_label()} 索引 / 遍历"))
    if not rows:
        return {"items": items, "emptyText": f"没有匹配「{term}」的文件"}
    return {"items": items, "emptyText": f"没有匹配「{term}」的文件"}


def on_execute(p):
    sub = (p.get("subcommand") or "").strip().lower()
    args = [str(a) for a in (p.get("args") or [])]

    if sub == "recent":
        return {"success": True, "message": "下方列出最近打开的目录"}

    if sub == "where":
        # /find where —— 打印当前后端与索引状态，便于排查
        ev = get_backend()
        if ev is None:
            return {"success": False,
                    "message": f"{backend_label()} 不可用：{_load_error}"}
        return {"success": True,
                "message": f"后端 {' '.join(map(str, ev.version()))} 索引已就绪"}

    if sub == "open":
        if not args:
            return {"success": False, "message": "用法：/find open <路径>"}
        svc("svc.process.launch", {"target": args[0]})
        return {"success": True, "message": f"已打开 {args[0]}"}

    if sub == "dir":
        if not args:
            return {"success": False, "message": "用法：/find dir <路径>"}
        svc("svc.process.launch", {"target": args[0]})
        return {"success": True, "message": f"已打开 {args[0]}"}

    return {"success": False,
            "message": "支持：recent（最近目录）/ open <路径> / dir <路径> / where（诊断）"}


def on_select(p):
    md = p.get("metadata") or {}
    path = md.get("path")
    if not path:
        # 统计条 / 用法项不是可执行项 —— 必须给反馈，不能是按了没反应的死条目
        return {"toast": md.get("footer") and "统计信息" or "请输入关键词后选择结果"}

    is_dir = bool(md.get("isDir"))
    if is_dir:
        push_recent_dir(path)
    # 文件与目录都用宿主 launch：文件是"用默认程序打开"，目录是"资源管理器打开"
    svc("svc.process.launch", {"target": path})
    return {"close": True,
            "toast": f"已{'打开目录' if is_dir else '打开文件'}：{md.get('name') or path}",
            "copy": path}


HANDLERS = {"search": on_search, "execute": on_execute, "select": on_select}


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:  # noqa: BLE001
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
            fn = HANDLERS.get(inner.get("method"))
            if fn is None:
                _emit({"jsonrpc": "2.0", "id": msg.get("id"),
                       "error": {"message": f"未知方法: {inner.get('method')}"}})
                continue
            try:
                _emit({"jsonrpc": "2.0", "id": msg.get("id"), "result": fn(inner.get("params") or {})})
            except Exception as exc:  # noqa: BLE001
                _emit({"jsonrpc": "2.0", "id": msg.get("id"), "error": {"message": str(exc)}})
        elif msg.get("id") is not None:
            _emit({"jsonrpc": "2.0", "id": msg.get("id"),
                   "error": {"message": f"未知方法: {method}"}})


if __name__ == "__main__":
    try:
        main()
    finally:
        sys.exit(0)