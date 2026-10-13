"""Everything SDK 的 ctypes 封装（Everything64.dll）。

只做三件事：找 DLL、声明签名、执行一次查询并读回结果。
搜索词/排序/结果游标都由 Everything 侧维护，这里不缓存。

实测踩出来的坑（改代码前先读，都是静默失败）：
  1. 必须先 Everything_Reset() 再 SetSearchW()，否则沿用上一次的搜索词。
  2. 结果索引**从 1 开始**，0 是无效索引（读它返回 0 长度，不报错）。
  3. 不设 Everything_SetRequestFlags 则 size/mtime 恒为 0。
  4. GetResultDateModified 返回 Windows FILETIME（1601 纪元），不是 Unix 秒。
  5. GetResultFullPathNameW 的缓冲区必须显式转 LPWSTR 传，否则**静默返回 0**。
  6. DLL 是 per-thread 状态（搜索词 + 结果游标），并发查询必须加锁。
  7. **只有 GetResultFullPathNameW 可用**（走 IPC 拿真实数据）。
     GetResultFileNameW / GetResultHighlightedFileNameW 会返回垃圾内存
     （实测返回值 1966691184 这种明显不是长度的数），因为它们走本地缓存、
     需要 REQ_FILE_NAME 且不支持 (NULL, 0) 问长度。
     故文件名一律从 fullpath切，高亮名直接放弃（Everything 自己 UI 里才有）。
  8. 索引从 1 开始：idx0 也是有效结果，真正的上界是 GetNumResults()。
"""

import ctypes
import os
from ctypes import wintypes

IS_WINDOWS = os.name == "nt"

# Everything 请求标志位（EVERYTHING_REQUEST_*，数值以 SDK的 Everything.h 为准）
REQ_FILE_NAME = 0x00000001
REQ_PATH = 0x00000002
REQ_SIZE = 0x00000010
REQ_DATE_MODIFIED = 0x00000040
REQ_ATTRIBUTES = 0x00000100
REQ_HIGHLIGHTED_FILE_NAME = 0x00002000

# Everything 排序（低16 位是类型，高位是方向）
SORT_NAME = 1
SORT_PATH = 2
SORT_SIZE = 3
SORT_EXTENSION = 4
SORT_TYPE = 5
SORT_DATE_MODIFIED = 11
SORT_DATE_CREATED = 12
SORT_DATE_ACCESSED = 13
SORT_SORT_BY_NAME_ASC = SORT_NAME

# FILETIME → Unix 毫秒：(unix_ms - 11644473600000) * 10000
FILETIME_TO_UNIX_MS_OFFSET = 11644473600000

_ATTR_HIDDEN = 0x02
_ATTR_SYSTEM = 0x04
_ATTR_READONLY = 0x01


class EverythingUnavailable(Exception):
    """Everything 未安装 / 未运行 / DLL 缺失 —— 全部归为"不可用"。"""


def _candidate_dll_paths():
    """DLL 查找顺序：插件 bin/ > 环境变量 > 常见安装位置。"""
    # __file__ 就是 plugins/find/everything.py，插件根就在它所在目录
    plugin_root = os.path.dirname(os.path.abspath(__file__))
    yield os.path.join(plugin_root, "bin", "Everything64.dll")
    env = os.environ.get("LITE_EVERYTHING_DLL") or os.environ.get("EVERYTHING_DLL")
    if env:
        yield env
    for base in (r"C:\Program Files\Everything", r"C:\Program Files (x86)\Everything",
                 r"D:\Program Files\Everything", r"D:\softs\Everything"):
        yield os.path.join(base, "Everything64.dll")
    yield os.path.join(plugin_root, "bin", "Everything32.dll")


class Everything:
    """薄封装。构造即加载；每次 search 都必须串行调用。"""

    def __init__(self, dll_path=None):
        if not IS_WINDOWS:
            raise EverythingUnavailable("Everything 仅支持 Windows")
        self.dll = self._load(dll_path)
        self._declare()
        self.dll_path = dll_path or ""

    @staticmethod
    def _load(dll_path):
        if dll_path:
            if not os.path.isfile(dll_path):
                raise EverythingUnavailable(f"找不到 Everything64.dll：{dll_path}")
            return ctypes.cdll.LoadLibrary(dll_path)
        for cand in _candidate_dll_paths():
            if os.path.isfile(cand):
                return ctypes.cdll.LoadLibrary(cand)
        raise EverythingUnavailable(
            "未找到 Everything64.dll。请安装 Everything（https://www.voidtools.com）"
            "并把 SDK 的 Everything64.dll 放到插件的 bin/ 目录。")

    def _declare(self):
        d = self.dll
        u32, u64, b = wintypes.DWORD, ctypes.c_uint64, wintypes.BOOL

        # 无参
        for name, rt in (("Everything_IsDBLoaded", b), ("Everything_IsAdmin", b),
                         ("Everything_GetMajorVersion", u32), ("Everything_GetMinorVersion", u32),
                         ("Everything_GetBuildNumber", u32), ("Everything_GetLastError", u32),
                         ("Everything_Reset", b),
                         ("Everything_GetTotResults", u32), ("Everything_GetNumResults", u32),
                         ("Everything_GetTotFileResults", u32), ("Everything_GetTotFolderResults", u32)):
            getattr(d, name).restype = rt

        # 有参
        d.Everything_SetSearchW.argtypes = [wintypes.LPCWSTR]
        d.Everything_SetMax.argtypes = [u32]
        d.Everything_SetOffset.argtypes = [u32]
        d.Everything_SetSort.argtypes = [u32]
        d.Everything_SetRequestFlags.argtypes = [u32]
        d.Everything_QueryW.restype = b
        d.Everything_QueryW.argtypes = [b]

        d.Everything_GetResultFullPathNameW.restype = u32
        d.Everything_GetResultFullPathNameW.argtypes = [u32, wintypes.LPWSTR, u32]
        # 注意：GetResultFileNameW / GetResultHighlightedFileNameW 刻意不声明——
        # 实测它们返回垃圾内存，见模块文档第7 条。
        d.Everything_IsFileResult.restype = b
        d.Everything_IsFileResult.argtypes = [u32]
        d.Everything_IsFolderResult.restype = b
        d.Everything_IsFolderResult.argtypes = [u32]

        for name in ("Everything_GetResultSize", "Everything_GetResultDateModified",
                     "Everything_GetResultDateCreated", "Everything_GetResultDateAccessed"):
            fn = getattr(d, name)
            fn.restype = b
            fn.argtypes = [u32, ctypes.POINTER(u64)]
        d.Everything_GetResultAttributes.restype = b
        d.Everything_GetResultAttributes.argtypes = [u32, ctypes.POINTER(ctypes.c_uint32)]

    # ── 状态查询 ────────────────────────────────────────────────
    def version(self):
        return (self.dll.Everything_GetMajorVersion(),
                self.dll.Everything_GetMinorVersion(),
                self.dll.Everything_GetBuildNumber())

    def db_loaded(self):
        return bool(self.dll.Everything_IsDBLoaded())

    def is_admin(self):
        return bool(self.dll.Everything_IsAdmin())

    def last_error(self):
        return int(self.dll.Everything_GetLastError())

    # ── 查询 ────────────────────────────────────────────────────
    def search(self, term, max_results=20, sort=None, offset=0, wait=True):
        """执行一次搜索，返回 (total_hits, [结果 dict, ...])。"""
        d = self.dll
        d.Everything_Reset()
        if term:
            d.Everything_SetSearchW(term)
        d.Everything_SetMax(int(max_results))
        if offset:
            d.Everything_SetOffset(int(offset))
        if sort is not None:
            d.Everything_SetSort(int(sort))
        # 不设这一组，size/mtime 会全部是 0
        d.Everything_SetRequestFlags(
            REQ_FILE_NAME | REQ_PATH | REQ_SIZE | REQ_ATTRIBUTES
            | REQ_DATE_MODIFIED | REQ_HIGHLIGHTED_FILE_NAME)

        if not d.Everything_QueryW(bool(wait)):
            raise EverythingUnavailable(f"Everything 查询失败（错误码 {self.last_error()}）")

        total = int(d.Everything_GetTotResults())
        n = int(d.Everything_GetNumResults())
        rows = []
        #索引从 1 开始
        for i in range(1, n + 1):
            row = self._read_row(i)
            if row:
                rows.append(row)
        return total, rows

    def _read_row(self, idx):
        """只读 FullPathName —— 其余 Getter 在这个 SDK 版本下会返回垃圾内存。"""
        d = self.dll
        need = int(d.Everything_GetResultFullPathNameW(idx, None, 0))
        if need == 0:
            return None
        buf = ctypes.create_unicode_buffer(need + 2)
        # 缓冲区必须显式 cast 成 LPWSTR，否则静默返回 0
        written = int(d.Everything_GetResultFullPathNameW(idx, ctypes.cast(buf, wintypes.LPWSTR), need + 2))
        if written == 0:
            return None
        full = buf.value
        if not full:
            return None

        size = ctypes.c_uint64()
        d.Everything_GetResultSize(idx, ctypes.byref(size))
        mtime = ctypes.c_uint64()
        d.Everything_GetResultDateModified(idx, ctypes.byref(mtime))
        attrs = ctypes.c_uint32()
        d.Everything_GetResultAttributes(idx, ctypes.byref(attrs))

        parent = os.path.dirname(full.rstrip("\\/")) or full
        return {
            "path": full,
            # 文件名从 fullpath 切，不依赖 GetResultFileNameW
            "name": os.path.basename(full.rstrip("\\/")) or full,
            "parent": parent,
            "is_dir": bool(d.Everything_IsFolderResult(idx)),
            "size": int(size.value),
            # FILETIME → Unix 毫秒
            "mtime_ms": (int(mtime.value) // 10000 - FILETIME_TO_UNIX_MS_OFFSET)
                        if mtime.value else 0,
            "attributes": int(attrs.value),
            "hidden": bool(attrs.value & _ATTR_HIDDEN),
            "system": bool(attrs.value & _ATTR_SYSTEM),
            "readonly": bool(attrs.value & _ATTR_READONLY),
        }