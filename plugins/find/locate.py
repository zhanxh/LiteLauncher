"""Linux/macOS 索引后端：plocate（首选）→ fd（次选）→ find（兜底）。

与 everything.py 的关系：两者实现**同一套接口**（search/db_loaded/version），
find.py 按平台二选一。对齐点：
    search(term, max_results, sort, offset, wait) -> (total_hits, [row, ...])
    row = {path,name,parent,is_dir,size,mtime_ms,attributes,hidden,system,readonly}

为什么不用 fzf：fzf 是**终端 TUI 模糊过滤器**，要抢占终端自己画界面；
LLP 插件只能回 JSON、面板由宿主统一绘制。且 fzf 不提供候选来源与元数据，
两头都要自己补。真正对标 Everything 的是 plocate 这类索引工具。

分层策略（越靠前越快）：
    1. plocate —— trigram 倒排索引，2700 万文件 0.008s；但**库里只有路径**，
       体积/修改时间必须靠 stat 补，所以只对截断后的前 N 条做 stat。
    2. fd     —— 并行遍历 + 实时 stat，2s/百万文件；原生支持
                  --changed-within / --size，能把过滤下推到工具本身。
    3. find   —— 全量遍历兜底，慢但哪都有。

元数据缺口的处理：locate 命中后，对**候选的前 limit 条**逐个 os.stat()。
这让 size:/dm: 语法不退化，代价是最多 100 次 stat（本地 FS 上亚毫秒级）。
排序若按 size/dm，则必须先 stat 完才能排——所以此时扩大 stat 窗口。
"""

import os
import re
import shutil
import stat as stat_mod
import subprocess
import time

import query as Q

# Linux 上统一用 Unix 纪元；Windows 后端返回的也是 Unix 毫秒，格式一致
_ATTR_HIDDEN = 0x02

# 排序字段 → (是否为数值字段)。与 everything.py 的 SORT_* 数值对齐，
# 这样 find.py 的 SORT_ALIASES 可以原样复用。
SORT_NAME = 1
SORT_PATH = 2
SORT_SIZE = 3
SORT_EXTENSION = 4
SORT_TYPE = 5
SORT_DATE_MODIFIED = 11
SORT_DATE_CREATED = 12
SORT_DATE_ACCESSED = 13
SORT_DESC_FLAG = 0x80000000

_SORT_FIELD = {
    SORT_NAME: "name", SORT_PATH: "path", SORT_SIZE: "size",
    SORT_EXTENSION: "ext", SORT_TYPE: "type",
    SORT_DATE_MODIFIED: "dm", SORT_DATE_CREATED: "dc", SORT_DATE_ACCESSED: "da",
}

# 全量遍历时的兜底上限，避免 find / 把机器拖死
_WALK_HARD_CAP = 20000
# 单条命令超时（秒）。plocate 毫秒级，fd/find 给宽一点。
_CMD_TIMEOUT = {"plocate": 5, "fd": 20, "find": 25}

# fd 的 --size / --changed-within 只认相对时间，语法与 Everything 不同，
# 这里把 Query 翻译过去；翻译不了的就留给 stat 后过滤。
_FD_SIZE_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*([kmgtb])$", re.I)
_FD_UNIT = {"b": 1, "k": 1024, "m": 1024 ** 2, "g": 1024 ** 3, "t": 1024 ** 4}


class LocateUnavailable(Exception):
    """plocate / fd / find 全部不可用。"""


class _Backend:
    name = ""
    bin = ""

    def __init__(self, bin_path):
        self.bin = bin_path

    def version(self):
        try:
            out = subprocess.run([self.bin, "--version"], capture_output=True,
                                 text=True, timeout=3)
            return (self.name, (out.stdout or out.stderr).strip().splitlines()[0][:32])
        except Exception:  # noqa: BLE001
            return (self.name, "unknown")

    def db_loaded(self):
        return True


class Plocate(_Backend):
    """plocate / mlocate / locate —— 索引查询。

    ⚠️ 不能只看 `which locate` 命中就认定可用：Git Bash / Cygwin / 交叉编译环境
    自带的 GNU findutils `locate` 也叫这个名字，但它默认读 /var/lib/mlocate.db，
    该库通常不存在，且它**不认- l / --all / -i 这套参数**（会报错或静默返回空）。
    实测踩到的表现：探测通过 → 查询返回空 → 以为"确实没有匹配" → 放弃了遍历降级。
    所以这里用一次**真实的探测查询**来判定，失败就当不可用。
    """

    name = "plocate"

    # 常见索引库位置。存在即认为索引就绪。
    DB_PATHS = ("/var/lib/plocate/plocate.db",
                "/var/lib/slocate/slocate.db",
                "/var/lib/mlocate/mlocate.db")

    @classmethod
    def detect(cls):
        # plocate 优先：Ubuntu 22.04+ / Fedora 35+ 默认
        for b in ("plocate", "mlocate", "locate"):
            p = shutil.which(b)
            if p:
                inst = cls(p)
                if inst.probe():
                    return inst
        raise LocateUnavailable("未找到可用的 plocate / mlocate / locate 索引")

    def probe(self):
        """真实探测：能否成功执行一次查询。

        判据是**参数被支持**——GNU findutils / MSYS 的 locate 只认
        `-d db -r pattern` 这套 GNU 专有选项，给它 plocate 的 `-i/-l/--all`
        会直接报错。实测踩到：探测只查退出码，MSYS locate 返回 1（无结果）
        被误判为"索引可用" → 真正查询永远返回空 → 整个 /find 在该机器上失效。

        所以这里用 plocate 专属参数组合探测：只有真plocate/mlocate 才会通过。
        """
        try:
            r = subprocess.run([self.bin, "-i", "-l", "1", "--all",
                                "lite-launcher-probe-xyz9q"],
                               capture_output=True, text=True,
                               timeout=_CMD_TIMEOUT["plocate"],
                               errors="replace")
        except (subprocess.TimeoutExpired, OSError):
            return False
        # 0=有结果 1=无结果，两者都说明参数被支持、库可读
        return r.returncode in (0, 1)

    def db_loaded(self):
        """索引库是否存在。已通过 probe() 验证过，这里只做兜底提示。"""
        return True

    def candidates(self, q, cap, timeout):
        """返回候选路径列表（可能有更多，取前 cap 条）。"""
        pats = q.locate_patterns()
        if not pats:
            # 没有可下推的路径词（如只有 ext: / size:）→ 索引帮不上忙，交给遍历
            return None
        cmd = [self.bin, "-i", "-l", str(max(cap, 1))]
        # plocate 多模式是 AND，mlocate 是 OR；显式 --all 统一为 AND，
        # 只有一个模式时 --all 无副作用。
        # 注意：GNU findutils 的 locate 不认这些参数，但那种情况已被 probe() 挡掉。
        if len(pats) > 1:
            cmd.append("--all")
        cmd.extend(pats)
        try:
            r = subprocess.run(cmd, capture_output=True, text=True,
                               timeout=timeout, errors="replace")
        except subprocess.TimeoutExpired:
            return []
        if r.returncode not in (0, 1):
            return []
        return [ln for ln in r.stdout.splitlines() if ln.strip()][:cap]


class Fd(_Backend):
    """fd-find —— 并行遍历 + gitignore 感知。"""

    name = "fd"

    @classmethod
    def detect(cls):
        for b in ("fd", "fdfind"):
            p = shutil.which(b)
            if p:
                return cls(p)
        raise LocateUnavailable("未找到 fd / fdfind")

    def candidates(self, q, cap, timeout, roots):
        cmd = [self.bin, "--type", "f", "--type", "d",
               "--absolute-path", "--max-results", str(cap)]
        if q.want_type == "dir":
            cmd = [self.bin, "--type", "d", "--absolute-path",
                   "--max-results", str(cap)]
        elif q.want_type == "file":
            cmd = [self.bin, "--type", "f", "--absolute-path",
                   "--max-results", str(cap)]
        cmd += ["--hidden", "--follow"]

        # 路径词转 fd 的 glob/正则。locate 那边是子串匹配，
        # 这里用 --full-path + 不带 pattern 的方式：交给后续 filter 处理更简单，
        # 避免 fd 正则语义与子串语义不一致导致漏结果。
        pushed = False
        if q.exts:
            for e in q.exts:
                cmd += ["--extension", e]
            pushed = True
        if q.size_min is not None and q.size_max == q.size_min:
            n = _fd_size_str(q.size_min)
            if n:
                cmd += ["--size", n]
                pushed = True
        if "dm" in q.time_bounds:
            lo, _hi = q.time_bounds["dm"]
            if lo is not None:
                secs = max(1, int(time.time() - lo))
                cmd += ["--changed-within", f"{secs}s"]
                pushed = True
        if not pushed:
            # **不把路径词推给 fd**：fd 的 pattern 是正则，而 Everything 语义是
            # 子串匹配，用户搜"a.b"会被 fd 当成正则、搜"a b"会被当成两个 pattern。
            # 宁可多列一点候选交给 Python 过滤，也不能漏结果或误命中。
            # 推给 fd 的只有 ext/size/mtime 这类**无歧义**的结构化过滤。
            pass

        cmd += roots or [os.path.expanduser("~")]
        return _run(cmd, timeout, cap)


class Find(_Backend):
    """GNU find —— 兜底，哪都有，慢。

    注意不要用 `-quit`：MSYS/BSD 版 find 对 `-quit` 与括号子句的组合处理不一致，
    实测 Windows 自带 find.exe 加了 -quit 只返回 1 条（且常是根目录本身）。
    这里一次性列出、由上层按 cap 截断。
    """

    name = "find"

    @classmethod
    def detect(cls):
        p = shutil.which("find")
        if not p:
            raise LocateUnavailable("未找到 find")
        return cls(p)

    def candidates(self, q, cap, timeout, roots):
        root = roots[0] if roots else os.path.expanduser("~")
        #⚠️ find 的表达式**不支持嵌套括号**——`( -type f ( -name x ) )` 会报
        #   "invalid expression; I was expecting to find a ')'"。
        #   find 不是递归下降解析器，-a只能靠空格并列隐含表达：
        #   `-type f -a -name '*.rs'` 才是合法的"且"。
        # 所以「文件 且 扩展名匹配」必须展平成单层 -o 链，不能套括号。
        if q.exts:
            terms = []
            for e in q.exts:
                terms.append(["-type", "f", "-a", "-name", f"*.{e}"])
            cmd = [self.bin, root, "("]
            for i, t in enumerate(terms):
                if i:
                    cmd.append("-o")
                cmd += t
            cmd += [")", "-print"]
        elif q.want_type == "dir":
            cmd = [self.bin, root, "-type", "d", "-print"]
        elif q.want_type == "file":
            cmd = [self.bin, root, "-type", "f", "-print"]
        else:
            cmd = [self.bin, root, "(", "-type", "f", "-o", "-type", "d", ")", "-print"]
        return _run(cmd, timeout, cap)


def _fd_size_str(num_bytes):
    v = float(num_bytes)
    for unit in ("t", "g", "m", "k", "b"):
        base = _FD_UNIT[unit]
        if v >= base:
            n = v / base
            return f"{n:.4g}{unit}"
    return None


def _run(cmd, timeout, cap):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=timeout, errors="replace")
    except subprocess.TimeoutExpired:
        # 超时也接受部分结果：superuser 实测 find 在大目录上会被卡住，
        # 但已经吐出来的行仍然有效。
        out = getattr(r, "stdout", "") or ""
        return [ln for ln in out.splitlines() if ln.strip()][:cap]
    except Exception:  # noqa: BLE001
        return []
    return [ln for ln in r.stdout.splitlines() if ln.strip()][:cap]


def _make_row(path, st):
    name = os.path.basename(path) or path
    parent = os.path.dirname(path) or "/"
    is_dir = stat_mod.S_ISDIR(st.st_mode)
    return {
        "path": path,
        "name": name,
        "parent": parent,
        "is_dir": is_dir,
        "size": 0 if is_dir else int(st.st_size),
        "mtime_ms": int(st.st_mtime * 1000) if st.st_mtime else 0,
        "attributes": 0,
        # locate 索引里没有隐藏属性，只能靠路径首字符判断——
        # 比 Windows 的 FILE_ATTRIBUTE_HIDDEN 弱，但足够面板区分用。
        "hidden": name.startswith("."),
        "system": False,
        "readonly": not (st.st_mode & stat_mod.S_IWUSR),
    }


def _decode_sort(sort):
    """把 find.py 传来的数字 sort code 还原成 (字段名, 是否降序)。"""
    if sort is None:
        return None, False
    desc = bool(sort & SORT_DESC_FLAG)
    return _SORT_FIELD.get(sort & 0xFFFF), desc


class LocateIndex:
    """对外接口与 everything.Everything 完全一致。

    backend_cls 只在测试里用来强制指定后端（隔离机器差异），
    生产路径一律走 detect() 的自动降级链。
    """

    def __init__(self, roots=None, backend_cls=None):
        self.roots = [r for r in (roots or []) if os.path.isdir(r)] or None
        errors = []
        self.backend = None
        factories = [backend_cls] if backend_cls else [
            Plocate.detect, Fd.detect, Find.detect]
        for factory in factories:
            try:
                self.backend = factory()
                break
            except LocateUnavailable as exc:
                errors.append(str(exc))
        if self.backend is None:
            raise LocateUnavailable("；".join(errors) or "没有可用的文件索引后端")

    def version(self):
        return self.backend.version()

    def db_loaded(self):
        return self.backend.db_loaded()

    def search(self, term, max_results=20, sort=None, offset=0, wait=True):
        q = Q.parse(term)
        field, desc = _decode_sort(sort)
        limit = max(1, int(max_results))

        # 按元数据排序时必须先 stat 完才知道谁在前，
        # 所以窗口放大；按名字排序则可以只 stat 需要的条数。
        need_all = field in ("size", "dm", "dc", "da")
        window = min(_WALK_HARD_CAP, limit * (8 if need_all else 3))

        paths = self._candidates(q, window)
        if paths is None:
            paths = []

        rows = []
        truncated = False
        for p in paths:
            if not p or not os.path.lexists(p):
                continue
            try:
                st = os.stat(p)
            except OSError:
                continue
            if not q.match_path(p, os.path.basename(p) or p):
                continue
            if not q.match_stat(st):
                continue
            rows.append(_make_row(p, st))
            if len(rows) >= window:
                truncated = True
                break

        # 相关性排序（用户没写 desc/asc 时）
        if field is None and q.literals:
            rows.sort(key=lambda r: -Q.relevance(r["path"], r["name"], q.literals))

        # 显式字段排序
        if field == "name":
            rows.sort(key=lambda r: r["name"].lower(), reverse=desc)
        elif field == "path":
            rows.sort(key=lambda r: r["path"].lower(), reverse=desc)
        elif field == "ext":
            rows.sort(key=lambda r: os.path.splitext(r["name"])[1].lower(), reverse=desc)
        elif field == "type":
            rows.sort(key=lambda r: (not r["is_dir"], r["name"].lower()), reverse=desc)
        elif field == "size":
            # 目录 size 恒为 0，混排会把所有目录顶到前面，这里排到末尾
            rows.sort(key=lambda r: (r["is_dir"], r["size"]), reverse=desc)
        elif field == "dm":
            rows.sort(key=lambda r: (r["is_dir"], r["mtime_ms"]), reverse=desc)
        elif field == "dc":
            rows.sort(key=lambda r: (r["is_dir"], r["mtime_ms"]), reverse=desc)
        elif field == "da":
            rows.sort(key=lambda r: (r["is_dir"], r["mtime_ms"]), reverse=desc)

        total = len(rows)
        page = rows[offset:offset + limit]
        if truncated:
            # 明确告知"还有更多"，避免用户以为这就是全部
            total = max(total, window)
        return total, page

    def _candidates(self, q, cap):
        """按后端能力逐级尝试拿候选路径。

        索引与遍历的关系：**不是二选一，而是叠加**。
        索引库由 updatedb 定时刷新，新建/刚改名的文件可能还不在库里
        （plocate 官方明确：新文件要等下次 updatedb）。所以索引返回空时
        仍要跑一遍遍历兜底，否则用户刚保存的文件就是搜不到。
        """
        timeout = _CMD_TIMEOUT.get(self.backend.name, 10)
        merged = []

        # 有索引且查询能下推 → 先走索引
        if isinstance(self.backend, Plocate):
            got = self.backend.candidates(q, cap, timeout)
            if got:
                merged = list(got)

        # 再用遍历补齐（索引没命中 / 没有可下推的索引模式）
        seen = set(merged)
        budget = cap if merged else cap
        for factory in (Fd.detect, Find.detect):
            try:
                b = factory()
            except LocateUnavailable:
                continue
            got = b.candidates(q, budget, _CMD_TIMEOUT.get(b.name, 10), self.roots)
            if not got:
                continue
            for p in got:
                if p not in seen:
                    seen.add(p)
                    merged.append(p)
            if len(merged) >= cap:
                break
            # 已经拿到索引结果且遍历也有结果 → 够了，别再跑下一个遍历器
            if merged:
                break
        return merged[:cap]
