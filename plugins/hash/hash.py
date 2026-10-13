#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/hash 哈希与编码（自包含，仅标准库）。

协议：stdio 上的 JSON Lines（JSON-RPC 2.0）
  宿主→插件 : initialize / call / shutdown
  插件→宿主 : svc.*（宿主按 manifest 权限门控代理执行）
本插件无任何 svc 调用，纯计算。
"""
import base64
import hashlib
import html
import json
import sys
import urllib.parse
import zlib

PLUGIN = "hash"
_seq = [1]


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def svc(method, params=None):
    """反向服务请求（须在 manifest 声明对应权限；宿主按门控代理执行）。"""
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


def full_text(p):
    """还原斜杠之后的完整输入文本（引号内空格已被分词器合并为单个 token）。"""
    sub = (p.get("subcommand") or "").strip()
    args = p.get("args") or []
    if sub:
        return " ".join([sub] + list(args)).strip()
    return (p.get("keyword") or "").strip()


def _oneline(s, n=76):
    s = str(s).replace("\r", " ").replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


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
        # 其它行（含后台线程的 svc 响应）：忽略，避免污染协议


def _b64d(t):
    pad = "=" * (-len(t) % 4)
    return base64.b64decode((t + pad).encode()).decode("utf-8", "replace")


LABELS = {
    "md5": "MD5",
    "sha1": "SHA1",
    "sha256": "SHA256",
    "sha512": "SHA512",
    "base64": "Base64 编码",
    "base64d": "Base64 解码",
    "url": "URL 编码",
    "urldec": "URL 解码",
    "html": "HTML 转义",
    "htmlunesc": "HTML 反转义",
    "crc32": "CRC32",
}

ALGOS = {
    "md5": lambda t: hashlib.md5(t.encode()).hexdigest(),
    "sha1": lambda t: hashlib.sha1(t.encode()).hexdigest(),
    "sha256": lambda t: hashlib.sha256(t.encode()).hexdigest(),
    "sha512": lambda t: hashlib.sha512(t.encode()).hexdigest(),
    "base64": lambda t: base64.b64encode(t.encode()).decode(),
    "base64d": _b64d,
    "url": lambda t: urllib.parse.quote(t, safe=""),
    "urldec": lambda t: urllib.parse.unquote(t),
    "html": lambda t: html.escape(t),
    "htmlunesc": lambda t: html.unescape(t),
    "crc32": lambda t: format(zlib.crc32(t.encode()) & 0xFFFFFFFF, "08x"),
}


def on_search(p):
    sub = (p.get("subcommand") or "").strip().lower()
    if sub in ALGOS:
        text = " ".join(p.get("args") or []).strip()
    else:
        text = full_text(p)
    if not text:
        return {
            "items": [item("hash:hint", "输入要处理的文本",
                           "例：/hash md5 hello（指定算法）或 /hash hello（全部算法）",
                           badge="用法", icon="🔐")],
            "emptyText": "输入文本",
        }

    names = [sub] if sub in ALGOS else list(ALGOS)
    out = []
    for name in names:
        try:
            val = ALGOS[name](text)
        except Exception:  # 解码类失败则跳过该项
            continue
        if not val:
            continue
        out.append(item("hash:" + name, _oneline(val), LABELS[name],
                        badge=name.upper(), icon="🔐", value=val, label=LABELS[name]))
    out.append(item("hash:size", f"{len(text)} 字符 / {len(text.encode())} 字节",
                    "输入长度", badge="长度", icon="📏"))
    return {"items": out, "emptyText": "无法处理该输入"}


def on_select(p):
    md = p.get("metadata") or {}
    val = md.get("value")
    if not val:
        return {"toast": "该项无内容可复制"}
    return {"copy": str(val), "toast": f"已复制 {md.get('label', '结果')}"}


HANDLERS = {"search": on_search, "select": on_select}

if __name__ == "__main__":
    try:
        main(HANDLERS)
    finally:
        sys.exit(0)
