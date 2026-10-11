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
import shutil
import subprocess
import sys
import time

PROTOCOL = "LLP/1"
next_svc_id = 1
pending = {}  # id -> 等待中的响应占位（本插件串行处理，直接同步等待）


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

    pyver = f"Python {platform.python_version()}"
    items.append({"id": "runtime", "title": f"sidecar 运行时: {pyver}",
                  "icon": "🐍", "description": "本插件由 python3 标准库实现",
                  "metadata": {"detail": pyver}})
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
