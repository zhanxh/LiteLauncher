"""搜索表达式解析：把用户输入拆成结构化过滤器。

为什么单独成文件：Everything 把这套解析写进了 DLL（黑盒），Linux 侧只能自己实现。
而这恰恰是最容易写错、最值得单测的部分——控制词剥离、字段名与搜索词重名、
体积/时间单位换算，每一个错了都是静默返回错结果。

设计原则：**遇到不认识的 key:value 就当普通搜索词**，绝不静默丢弃用户的输入。
（顺带解决了 `http://x` 这种带冒号的串不会被误判成字段。）

只用标准库，且不碰 subprocess —— tools/test-find-logic.py 可直接 import 测。
"""

import re
import time

# 只有这些 key 会被当成字段，其余 `xxx:yyy` 一律降级为普通文本
KNOWN_FIELDS = {"ext", "size", "dm", "dc", "da", "name", "path", "type"}

# 时间字段 → stat 结构里的属性名
TIME_ATTR = {"dm": "st_mtime", "dc": "st_ctime", "da": "st_atime"}

_SIZE_UNITS = {
    "b": 1,
    "k": 1024, "kb": 1024, "kib": 1024,
    "m": 1024 ** 2, "mb": 1024 ** 2, "mib": 1024 ** 2,
    "g": 1024 ** 3, "gb": 1024 ** 3, "gib": 1024 ** 3,
    "t": 1024 ** 4, "tb": 1024 ** 4, "tib": 1024 ** 4,
}
_SIZE_RE = re.compile(r"^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)?)\s*([kmgtb]{1,3})?$", re.I)
_REL_TIME_RE = re.compile(r"^(\d+)([dwmh])$", re.I)
_ISO_DATE_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$")

_REL_UNIT_SECONDS = {"h": 3600, "d": 86400, "w": 604800, "m": 2592000}

_DAY = 86400


class Query:
    """一次查询的结构化结果。

    所有"必须包含"的列表之间是 AND 关系；min/max 之间是闭区间。
    """

    __slots__ = ("literals", "name_pats", "path_pats", "exts", "want_type",
                 "size_min", "size_max", "time_bounds")

    def __init__(self):
        self.literals = []      # 裸词：必须出现在完整路径中（Everything 默认语义）
        self.name_pats = []     # name:xxx → 只匹配 basename
        self.path_pats = []     # path:xxx → 只匹配完整路径
        self.exts = []          # ext:rs,py
        self.want_type = None   # 'file' | 'dir' | None
        self.size_min = None
        self.size_max = None
        self.time_bounds = {}   # {'dm': (min_ts, max_ts), ...}

    # ── 供索引后端使用 ─────────────────────────────────────────
    @property
    def needs_stat_filter(self):
        """是否必须 stat 才知道结果去留（决定候选要抓多宽）。"""
        return bool(self.size_min or self.size_max or self.time_bounds
                    or self.want_type or self.exts)

    def locate_patterns(self):
        """给 plocate 用的路径子串列表（已按 POSIX ERE 转义）。

        plocate 默认对**完整路径**做正则匹配，所以这里只放"要在路径里找"的词；
        name: 与 ext: 属于 basename 维度，plocate 表达不了，留给 stat 后过滤。
        """
        raw = self.literals + self.path_pats
        return [re.escape(p) for p in raw]

    # ── 结果过滤 ────────────────────────────────────────────────
    def match_path(self, path, name):
        low_path = path.lower()
        low_name = name.lower()
        for p in self.literals:
            if p.lower() not in low_path:
                return False
        for p in self.path_pats:
            if p.lower() not in low_path:
                return False
        for p in self.name_pats:
            if p.lower() not in low_name:
                return False
        if self.exts:
            # 点开头的隐藏文件要特殊处理：`.gitignore` 的扩展名是 gitignore（与 Everything 一致），
            # 不能因为 dot==0 就判成"无扩展名"，否则 ext:ignore 这类搜索会莫名命中/落空。
            if name.startswith("."):
                got = name[1:].lower()
            else:
                dot = name.rfind(".")
                got = name[dot + 1:].lower() if dot > 0 else ""
            if got not in self.exts:
                return False
        return True

    def match_stat(self, st):
        """st 为 os.stat_result。目录不参与体积/时间过滤（目录 size 无意义）。"""
        import stat as _stat
        is_dir = _stat.S_ISDIR(st.st_mode)
        if self.want_type == "dir" and not is_dir:
            return False
        if self.want_type == "file" and is_dir:
            return False

        if not is_dir:
            if self.size_min is not None and st.st_size < self.size_min:
                return False
            if self.size_max is not None and st.st_size > self.size_max:
                return False

        for field, (lo, hi) in self.time_bounds.items():
            ts = getattr(st, TIME_ATTR.get(field, "st_mtime"), 0) or 0
            if lo is not None and ts < lo:
                return False
            if hi is not None and ts > hi:
                return False
        return True

    def is_empty(self):
        return not (self.literals or self.name_pats or self.path_pats
                    or self.exts or self.want_type or self.size_min
                    or self.size_max or self.time_bounds)


def parse_size(text):
    """`>500mb` / `<1kb` / `100` / `1mb..10mb` → (min, max)，字节。"""
    text = text.strip()
    if not text:
        return None
    if ".." in text:
        lo_s, _, hi_s = text.partition("..")
        lo = parse_size(lo_s)
        hi = parse_size(hi_s)
        return (lo[0] if lo else None, hi[1] if hi else None)

    m = _SIZE_RE.match(text)
    if not m:
        return None
    op, num, unit = m.group(1) or "=", m.group(2), (m.group(3) or "b").lower()
    val = int(float(num) * _SIZE_UNITS.get(unit, 1))
    if op == ">":
        return (val + 1, None)
    if op == ">=":
        return (val, None)
    if op == "<":
        return (None, val - 1)
    if op == "<=":
        return (None, val)
    return (val, val)


def _midnight(ts):
    return int(ts - (ts % _DAY))


def parse_time(text, now=None):
    """`today` / `7d` / `>2024-01-01` / `2024-01-01..2024-01-31` → (min, max) Unix 秒。"""
    text = text.strip().lower()
    if not text:
        return None
    now = time.time() if now is None else now

    if text == "today":
        return (_midnight(now), None)
    if text == "yesterday":
        return (_midnight(now) - _DAY, _midnight(now) - 1)
    if text == "now":
        return (int(now) - 2, None)

    m = _REL_TIME_RE.match(text)
    if m:
        span = int(m.group(1)) * _REL_UNIT_SECONDS[m.group(2).lower()]
        return (int(now) - span, None)

    if ".." in text:
        lo_s, _, hi_s = text.partition("..")
        lo = parse_time(lo_s, now) if lo_s.strip() else (None, None)
        hi = parse_time(hi_s, now) if hi_s.strip() else (None, None)
        return (lo[0], hi[1])

    m = _ISO_DATE_RE.match(text)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            base = _midnight(int(time.mktime((y, mo, d, 0, 0, 0, 0, 0, -1))))
        except (ValueError, OverflowError):
            return None
        return (base, base + _DAY - 1)

    for op, fn in ((">=", lambda v: v), (">", lambda v: v + 1),
                   ("<=", lambda v: v + _DAY - 1), ("<", lambda v: v - 1)):
        if text.startswith(op):
            rest = parse_time(text[len(op):].strip(), now)
            if not rest:
                return None
            return (fn(rest[0]), None)
    return None


def parse(term):
    """把 Everything 风格表达式拆成 Query。

    支持：ext: / size: / dm: / dc: / da: / name: / path: / type:，
    以及多个值（ext:rs,py）与区间（size:1mb..10mb）。
    不认识的 key:value 整体降级为普通搜索词。
    """
    q = Query()
    for tok in (term or "").split():
        key, sep, val = tok.partition(":")
        low = key.lower()
        if not sep or low not in KNOWN_FIELDS or not val:
            q.literals.append(tok)
            continue

        if low == "ext":
            q.exts = [e.strip().lstrip(".").lower() for e in val.split(",") if e.strip()]
        elif low == "size":
            got = parse_size(val)
            if got:
                if got[0] is not None:
                    q.size_min = got[0] if q.size_min is None else max(q.size_min, got[0])
                if got[1] is not None:
                    q.size_max = got[1] if q.size_max is None else min(q.size_max, got[1])
            else:
                q.literals.append(tok)
        elif low in TIME_ATTR:
            got = parse_time(val)
            if got:
                q.time_bounds[low] = got
            else:
                q.literals.append(tok)
        elif low == "name":
            q.name_pats.append(val)
        elif low == "path":
            q.path_pats.append(val)
        elif low == "type":
            t = val.lower()
            if t in ("folder", "dir", "directory"):
                q.want_type = "dir"
            elif t in ("file", "files"):
                q.want_type = "file"
            else:
                q.literals.append(tok)
    return q


def relevance(path, name, literals):
    """相关性打分：用于没有显式排序时的默认顺序。

    仿 Everything 的默认行为——文件名命中远重于路径命中，短路径重于长路径。
    分不开就返回 0（该候选会被过滤掉）。
    """
    if not literals:
        return 1.0
    low_path, low_name = path.lower(), name.lower()
    total = 0.0
    for raw in literals:
        p = raw.lower()
        if not p:
            continue
        if low_name == p:
            score = 100.0
        elif low_name.startswith(p):
            score = 80.0
        elif p in low_name:
            score = 55.0
        elif p in low_path:
            score = 25.0
        else:
            return 0.0
        total += score
    # 同分时短路径优先（少一层通常更接近用户意图）
    return total / len(literals) - min(len(path), 4000) / 40000.0
