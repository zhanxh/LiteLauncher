"""展示层格式化：把 Everything 的原始结果转成面板文案。

独立成文件是为了能被 tools/test-find-plugin.mjs 直接测——
Everything 结果依赖外部进程与 DLL，没法在单测里造。
"""

KIND_ICON = "📁"   # 目录
FILE_ICON = "📄"   # 文件
HIDDEN_ICON = "👻"  # 隐藏/系统项


def fmt_size(num_bytes):
    """人类可读体积。0/未知统一显示 '-'（目录与未取到 size 的项）。"""
    if not num_bytes or num_bytes < 0:
        return "-"
    units = ("B", "KB", "MB", "GB", "TB", "PB")
    v = float(num_bytes)
    for u in units:
        if v < 1024 or u == units[-1]:
            if u == "B":
                return f"{int(v)} {u}"
            return f"{v:.1f} {u}"
        v /= 1024
    return f"{v:.1f} PB"


def fmt_mtime(unix_ms, now_ms):
    """相对时间。Everything 的 FILETIME 换算错误时会得到负数/极大值，一律兜成 '-'。"""
    if not unix_ms or unix_ms <= 0:
        return "-"
    diff = now_ms - unix_ms
    if diff < 0:
        return "未来"          # 索引时间戳异常，宁可说人话也别显示 56 年后
    if diff < 60_000:
        return "刚刚"
    mins = diff // 60_000
    if mins < 60:
        return f"{int(mins)} 分钟前"
    hours = mins // 60
    if hours < 24:
        return f"{int(hours)} 小时前"
    days = hours // 24
    if days < 30:
        return f"{int(days)} 天前"
    months = days // 30
    if months < 12:
        return f"{int(months)} 个月前"
    return f"{int(days // 365)} 年前"


def _shorten_middle(text, max_segments=4):
    """路径中间按**层级**省略，绝不截断目录名。

    按字符硬切会把 `averylongdirectoryname` 变成
    `averylongdirectorynam...e` 加省略号 —— 半个词既认不出也搜不了，
    比完整显示更糟。这里改为保留盘符 + 前几层 + `...` + 最后两层。
    """
    if not text:
        return text
    # 拆出盘符（"D:"），剩下的按 \ 分层
    norm = text.replace("/", "\\")
    parts = norm.split("\\")
    if len(parts) <= max_segments:
        return "\\".join(parts)
    keep_tail = 2
    head = parts[: max_segments - keep_tail]
    tail = parts[-keep_tail:]
    return "\\".join(head) + "\\...\\" + "\\".join(tail)


def build_row(r, now_ms, total=None, rank=None):
    """把一条 Everything 结果转成面板项。"""
    name = r.get("name") or r.get("path") or ""
    is_dir = bool(r.get("is_dir"))
    icon = KIND_ICON if is_dir else FILE_ICON
    if r.get("hidden") or r.get("system"):
        icon = HIDDEN_ICON

    bits = []
    if not is_dir:
        bits.append(fmt_size(r.get("size")))
    bits.append(fmt_mtime(r.get("mtime_ms"), now_ms))
    parent = r.get("parent") or ""
    if parent:
        bits.append(_shorten_middle(parent))
    description = "  ·  ".join(b for b in bits if b)

    badge = KIND_ICON if is_dir else FILE_ICON
    if rank:
        badge = f"#{rank}"
    elif is_dir:
        badge = "目录"

    meta = {
        "path": r.get("path", ""),
        "name": name,
        "isDir": is_dir,
    }
    return {
        "id": f"find:item:{rank or 0}:{r.get('path', '')}",
        "title": name,
        "description": description,
        "badge": badge,
        "icon": icon,
        "metadata": meta,
    }


def build_footer(total, shown, elapsed_ms, extra=None, source="Everything 索引"):
    """面板底部的统计条：让用户知道"总共多少、只显示了前多少"。

    source 由调用方传入实际后端名（Everything 索引 / plocate 索引），
    不要在这里写死——Linux 上写死会显示错误的信息来源。
    """
    label = f"共 {total} 项，显示前 {shown} 项" if total > shown else f"共 {total} 项"
    if elapsed_ms >= 1:
        label += f"  ·  {elapsed_ms:.0f}ms"
    if extra:
        label += f"  ·  {extra}"
    return {
        "id": "find:footer",
        "title": label,
        "description": source,
        "badge": "统计",
        "icon": "📊",
        "metadata": {"footer": True, "total": total, "shown": shown},
    }


def build_unavailable(reason, hint=""):
    """后端不可用时的引导面板（不要留空白，用户会以为插件坏了）。"""
    desc = hint or "请先安装并运行 Everything（https://www.voidtools.com）"
    return {
        "items": [{
            "id": "find:unavailable",
            "title": reason,
            "description": desc,
            "badge": "不可用",
            "icon": "⚠️",
            "metadata": {"unavailable": True},
        }],
        "emptyText": "文件索引不可用",
    }


def build_usage(hints, syntax="支持 Everything 原生语法"):
    """空输入时给的语法提示（搜索语法很强大，值得列出）。"""
    items = [{
        "id": "find:usage",
        "title": "输入关键词开始搜索",
        "description": syntax,
        "badge": "用法",
        "icon": "🔍",
        "metadata": {"usage": True},
    }]
    for i, h in enumerate(hints):
        items.append({
            "id": f"find:usage:{i}",
            "title": h,
            "description": syntax,
            "badge": "示例",
            "icon": "·",
            "metadata": {"usage": True, "example": h},
        })
    return {"items": items, "emptyText": "输入关键词"}