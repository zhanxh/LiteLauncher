#!/usr/bin/env python3
"""LiteLauncher 示例外部插件：/sysinfo（LLP/1 sidecar，仅用 Python 标准库）

协议（stdio 上的 JSON Lines / JSON-RPC 2.0）：
  宿主 → 插件 : initialize / call / shutdown
  插件 → 宿主 : svc.* 反向请求（经宿主门控代执行：notify/process/settings/log）
本插件演示：search 返回系统信息条目、select 经 svc.notify 推送详情、
execute open 经 svc.process.launch 打开系统监视器。

跨平台说明：
  - stdio 一律 UTF-8（Windows 管道默认 GBK/本地编码，与宿主 JSON 不兼容，必须显式声明）
  - 信息采集：Linux 用 uptime/free，Windows 用 GetTickCount64/GlobalMemoryStatusEx，
    磁盘统一走 shutil.disk_usage
"""

import ctypes
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time

PROTOCOL = "LLP/1"
next_svc_id = 1
pending = {}  # id -> 等待中的响应占位（本插件串行处理，直接同步等待）

# 从 sidecar 沿 ppid 往上找主程序时最多爬的层数（中间可能隔一层启动壳）
MAX_CLIMB = 8


def _force_utf8_stdio():
    """管道默认编码跟随系统（中文 Windows = GBK），宿主按 UTF-8 收发，必须统一。"""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def svc(method, params):
    """向宿主发起反向服务请求并同步等待结果（LLP 约定：一切能力经宿主代理）"""
    global next_svc_id
    req_id = next_svc_id
    next_svc_id += 1
    emit({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
    # 读取下一行：必须是本请求的响应（LLP/1 MVP 假设串行会话）
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("宿主连接已关闭")
    resp = json.loads(line)
    if "error" in resp:
        raise RuntimeError(resp["error"].get("message", "svc 调用失败"))
    return resp.get("result")


def run(cmd):
    try:
        return subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ""


def _fmt_secs(total):
    m, s = divmod(int(total), 60)
    h, m = divmod(m, 60)
    d, h = divmod(h, 24)
    parts = []
    if d:
        parts.append(f"{d} 天")
    if h:
        parts.append(f"{h} 小时")
    if m:
        parts.append(f"{m} 分钟")
    return " ".join(parts) or f"{s} 秒"


def _uptime_windows():
    kernel32 = ctypes.windll.kernel32
    kernel32.GetTickCount64.restype = ctypes.c_uint64
    return _fmt_secs(kernel32.GetTickCount64() / 1000.0)


def _mem_windows():
    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_uint64),
            ("ullAvailPhys", ctypes.c_uint64),
            ("ullTotalPageFile", ctypes.c_uint64),
            ("ullAvailPageFile", ctypes.c_uint64),
            ("ullTotalVirtual", ctypes.c_uint64),
            ("ullAvailVirtual", ctypes.c_uint64),
            ("ullAvailExtendedVirtual", ctypes.c_uint64),
        ]

    st = MEMORYSTATUSEX()
    st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
        return None
    total, avail = st.ullTotalPhys, st.ullAvailPhys
    used = total - avail
    g = lambda n: f"{n / 1024**3:.1f}GB"
    return total, used, avail, g


def _fmt_mb(kb):
    return f"{kb / 1024:.1f} MB"


# ── 进程内存（主程序 + 子进程）─────────────────────────────────
# 只依赖标准库：Linux 读 /proc，Windows 用 Toolhelp32 快照拿进程树 +
# psapi GetProcessMemoryInfo 拿工作集；其余平台如实降级。


def _procs_linux():
    """全量进程表：pid -> {name, ppid, rss_kb, script}。权限不够/竞态消失的进程跳过。

    name 优先取 cmdline 的 argv[0] 基名——comm 被内核截到 15 字符
    （WebKitWebProcess → WebKitWebProces），显示会缺胳膊少腿。
    """
    procs = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/status", encoding="utf-8", errors="replace") as f:
                status = f.read()
            comm = re.search(r"^Name:\s+(.+)$", status, re.M)
            ppid = re.search(r"^PPid:\s+(\d+)$", status, re.M)
            rss = re.search(r"^VmRSS:\s+(\d+)\s+kB", status, re.M)
            if not (comm and ppid and rss):
                continue
            argv0 = script = ""
            try:
                with open(f"/proc/{entry}/cmdline", "rb") as f:
                    toks = [t.decode("utf-8", "replace") for t in f.read().split(b"\0") if t]
                if toks:
                    argv0 = toks[0].rsplit("/", 1)[-1]
                    # python sidecar 的脚本名在最后一个参数上（pomo.py / sysinfo.py）
                    script = toks[-1].rsplit("/", 1)[-1] if "python" in toks[0].lower() else ""
            except OSError:
                pass
            procs[int(entry)] = {
                "name": argv0 or comm.group(1),
                "ppid": int(ppid.group(1)),
                "rss_kb": int(rss.group(1)),
                "script": script,
            }
        except (OSError, ValueError):
            continue
    return procs


def _procs_windows():
    """Toolhelp32 快照：pid -> {name, ppid, rss_kb=None}；RSS 由 GetProcessMemoryInfo 补。"""
    kernel32 = ctypes.windll.kernel32
    TH32CS_SNAPPROCESS = 0x2

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", ctypes.c_ulong),
            ("cntUsage", ctypes.c_ulong),
            ("th32ProcessID", ctypes.c_ulong),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", ctypes.c_ulong),
            ("cntThreads", ctypes.c_ulong),
            ("th32ParentProcessID", ctypes.c_ulong),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", ctypes.c_ulong),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        return {}
    procs = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            procs[entry.th32ProcessID] = {
                "name": entry.szExeFile,
                "ppid": entry.th32ParentProcessID,
                "rss_kb": None,
            }
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return procs


def _rss_windows(pid):
    """工作集（KB）；打不开的进程（权限/已退出）返回 None，由调用方跳过。"""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.windll.kernel32
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None
    try:
        pmc = PROCESS_MEMORY_COUNTERS()
        pmc.cb = ctypes.sizeof(pmc)
        if ctypes.windll.psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), ctypes.sizeof(pmc)):
            return pmc.WorkingSetSize // 1024
        return None
    finally:
        kernel32.CloseHandle(h)


def _find_main_pid(procs):
    """主程序 = sidecar 沿 ppid 链向上第一个名字带 LiteLauncher 的祖先；
    链上找不到（被改名/隔了启动壳）退回全表唯一匹配。"""
    cur = os.getpid()
    for _ in range(MAX_CLIMB):
        info = procs.get(cur)
        if not info or not info["ppid"]:
            break
        cur = info["ppid"]
        info = procs.get(cur)
        if info and "litelauncher" in info["name"].lower():
            return cur
    cands = [p for p, i in procs.items()
             if "litelauncher" in i["name"].lower() and p != os.getpid()]
    return cands[0] if len(cands) == 1 else None


def _group_children(children):
    """子进程按名称聚合；python sidecar 补脚本名（Windows 拿不到 cmdline 就只报 exe）。"""
    groups = {}
    for pid, info in children.items():
        name = info["name"]
        hint = info.get("script") or ""
        key = f"{name} · {hint}" if hint else name
        g = groups.setdefault(key, {"key": key, "count": 0, "rss_kb": 0, "pids": []})
        g["count"] += 1
        g["rss_kb"] += info["rss_kb"] or 0
        g["pids"].append(pid)
    return sorted(groups.values(), key=lambda g: -g["rss_kb"])


def _proc_memory_report(procs=None):
    """主程序 + 直接子进程的内存占用（KB）。失败返回带 reason 的 dict（如实降级）。"""
    if procs is None:
        if os.name == "nt":
            procs = _procs_windows()
        elif os.path.isdir("/proc"):
            procs = _procs_linux()
        else:
            return {"reason": f"{platform.system()} 暂不支持（仅 Linux /proc 与 Windows）"}

    main_pid = _find_main_pid(procs)
    if main_pid is None or main_pid not in procs:
        return {"reason": "未在进程表中找到 LiteLauncher 主程序"}

    main_info = procs[main_pid]
    if os.name == "nt":
        main_rss = _rss_windows(main_pid)
        children = {p: dict(i) for p, i in procs.items()
                    if i["ppid"] == main_pid and p != os.getpid()}
        for pid in list(children):
            children[pid]["rss_kb"] = _rss_windows(pid)
        if main_rss is None:
            return {"reason": f"无法读取主程序内存（pid {main_pid}）"}
        main_info = {**main_info, "rss_kb": main_rss}
        children = {p: i for p, i in children.items() if i["rss_kb"] is not None}
    else:
        children = {p: dict(i) for p, i in procs.items()
                    if i["ppid"] == main_pid and p != os.getpid()}

    groups = _group_children(children)
    return {
        "main": {"pid": main_pid, "name": main_info["name"], "rss_kb": main_info["rss_kb"]},
        "groups": groups,
        "child_count": sum(g["count"] for g in groups),
        "child_total_kb": sum(g["rss_kb"] for g in groups),
    }


def _proc_memory_items():
    """主程序/子进程内存条目；采集失败时给一条带原因的降级条目，不让用户猜。"""
    try:
        report = _proc_memory_report()
    except Exception as exc:  # noqa: BLE001
        report = {"reason": f"采集失败: {exc}"}
    if "reason" in report:
        return [{"id": "proc-mem", "title": f"进程内存: {report['reason']}",
                 "icon": "🫥", "description": "主程序与子进程内存占用暂不可用",
                 "metadata": {"detail": report["reason"]}}]

    main = report["main"]
    detail_lines = [f"主程序 {main['name']} (pid {main['pid']}): {_fmt_mb(main['rss_kb'])}"]
    items = [{
        "id": "proc-main",
        "title": f"主程序内存: {_fmt_mb(main['rss_kb'])} · {main['name']} (pid {main['pid']})",
        "icon": "🚀",
        "description": f"子进程 {report['child_count']} 个，共 {_fmt_mb(report['child_total_kb'])}（含 webview/插件 sidecar）",
        "metadata": {"detail": "\n".join(detail_lines)},
    }]
    for g in report["groups"][:6]:
        low = g["key"].lower()
        icon = "🐍" if "python" in low else ("🌐" if "webkit" in low or "webview" in low else "⚙️")
        multi = f" ×{g['count']}" if g["count"] > 1 else ""
        items.append({
            "id": f"proc-child-{g['pids'][0]}",
            "title": f"子进程 {g['key']}{multi} · {_fmt_mb(g['rss_kb'])}",
            "icon": icon,
            "description": f"pid {'/'.join(map(str, sorted(g['pids'])))}",
            "metadata": {"detail": f"{g['key']}{multi}: {_fmt_mb(g['rss_kb'])}（pid {', '.join(map(str, sorted(g['pids'])))}）"},
        })
    total = main["rss_kb"] + report["child_total_kb"]
    detail_lines.append(f"子进程合计（{report['child_count']} 个）: {_fmt_mb(report['child_total_kb'])}")
    detail_lines.append(f"合计: {_fmt_mb(total)}")
    items[0]["metadata"]["detail"] = "\n".join(detail_lines)
    items.append({
        "id": "proc-total",
        "title": f"进程内存合计: {_fmt_mb(total)}",
        "icon": "🧮",
        "description": f"主程序 {_fmt_mb(main['rss_kb'])} + 子进程 {_fmt_mb(report['child_total_kb'])}（{report['child_count']} 个）",
        "metadata": {"detail": "\n".join(detail_lines)},
    })
    return items


def collect_items():
    """采集系统信息条目（Linux/Windows，其余平台仅返回内核与运行时条目）"""
    items = []
    is_win = os.name == "nt"

    kernel = f"{platform.system()} {platform.release()} ({platform.machine()})"
    items.append({"id": "kernel", "title": f"内核: {kernel}", "icon": "🐧" if not is_win else "🪟",
                  "description": platform.platform(), "metadata": {"detail": kernel}})

    if is_win:
        try:
            uptime = _uptime_windows()
            items.append({"id": "uptime", "title": f"开机时长: {uptime}",
                          "icon": "⏱️", "description": "来自 GetTickCount64",
                          "metadata": {"detail": uptime}})
        except Exception:
            pass
    else:
        uptime_raw = run(["uptime", "-p"])
        if uptime_raw:
            items.append({"id": "uptime", "title": f"开机时长: {uptime_raw.removeprefix('up ')}",
                          "icon": "⏱️", "description": "来自 uptime -p",
                          "metadata": {"detail": uptime_raw}})

    if is_win:
        try:
            mem = _mem_windows()
            if mem:
                total, used, avail, g = mem
                items.append({"id": "mem", "title": f"内存: {g(total)} 总量 / {g(used)} 已用",
                              "icon": "🧠", "description": f"可用 {g(avail)}",
                              "metadata": {"detail": f"total={g(total)} used={g(used)} avail={g(avail)}"}})
        except Exception:
            pass
    else:
        mem_line = run(["free", "-h", "--si"])
        if mem_line:
            mem = mem_line.splitlines()[1].split()
            items.append({"id": "mem", "title": f"内存: {mem[1]} 总量 / {mem[2]} 已用",
                          "icon": "🧠", "description": f"可用 {mem[6]}",
                          "metadata": {"detail": f"total={mem[1]} used={mem[2]} avail={mem[6]}"}})

    # 主程序与子进程的内存占用：紧挨系统内存条目，主题相邻
    items.extend(_proc_memory_items())

    try:
        disk_path = "C:\\" if is_win else "/"
        du = shutil.disk_usage(disk_path)
        label = "系统盘 C:" if is_win else "根分区"
        pct = f"{du.used / du.total * 100:.0f}%"
        g = lambda n: f"{n / 1024**3:.1f}GB"
        items.append({"id": "disk", "title": f"{label}: {g(du.used)} 已用 / {g(du.total)} 总量",
                      "icon": "💾", "description": f"剩余 {g(du.free)}（使用率 {pct}）",
                      "metadata": {"detail": f"used={g(du.used)} size={g(du.total)} avail={g(du.free)} {pct}"}})
    except Exception:
        pass

    # 展示实际生效的解释器：用户可在「设置 → Python 环境」切换，这里用于确认
    pyver = f"Python {platform.python_version()}"
    items.append({"id": "runtime", "title": f"sidecar 运行时: {pyver}",
                  "icon": "🐍", "description": f"解释器: {sys.executable}",
                  "metadata": {"detail": f"{pyver}\n{sys.executable}"}})
    return items


def main():
    _force_utf8_stdio()
    # LLP/1 initialize 握手
    for raw in sys.stdin:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")

        if method == "initialize":
            emit({"jsonrpc": "2.0", "id": msg.get("id"),
                  "result": {"protocol": PROTOCOL, "plugin": "sysinfo"}})
            continue

        if method == "shutdown":
            break

        if method == "call":
            inner = msg.get("params", {})
            m, params = inner.get("method"), inner.get("params", {}) or {}
            try:
                result = handle_call(m, params)
                emit({"jsonrpc": "2.0", "id": msg.get("id"), "result": result})
            except Exception as exc:  # noqa: BLE001
                emit({"jsonrpc": "2.0", "id": msg.get("id"),
                      "error": {"message": str(exc)}})
            continue

        # 兜底：对带 id 的未知请求回错误，避免宿主等待超时
        if msg.get("id") is not None:
            emit({"jsonrpc": "2.0", "id": msg.get("id"),
                  "error": {"message": f"未知方法: {method}"}})


def handle_call(m, params):
    if m == "search":
        keyword = (params.get("keyword") or "").strip().lower()
        items = collect_items()
        if keyword:
            items = [i for i in items
                     if keyword in i["title"].lower() or keyword in (i.get("description") or "").lower()]
        return {"items": items, "emptyText": "未匹配到系统信息条目"}

    if m == "execute":
        sub = params.get("subcommand")
        if sub == "open":
            target = {"nt": "taskmgr.exe", "posix": "gnome-system-monitor"}.get(os.name)
            if not target:
                return {"success": False, "message": f"暂不支持在 {platform.system()} 上打开系统监视器"}
            svc("svc.process.launch", {"target": target})
            return {"success": True, "message": "已打开系统监视器"}
        return {"success": False, "message": "支持的子命令：open（打开系统监视器）"}

    if m == "select":
        detail = (params.get("metadata") or {}).get("detail", "")
        svc("svc.notify.send", {"title": "系统信息", "body": detail or "（无详情）"})
        return {"toast": "详情已发送至系统通知"}

    raise RuntimeError(f"未知方法: {m}")


if __name__ == "__main__":
    try:
        main()
    finally:
        # stdin EOF（宿主退出）自然结束；兜底退出码
        sys.exit(0)
