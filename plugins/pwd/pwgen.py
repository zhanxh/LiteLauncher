#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/pwd 密码生成器（自包含，仅标准库）。

脚本名刻意不用 pwd.py：pwd 是 Unix 标准库模块，同名会遮蔽。
"""
import json
import secrets
import string
import sys

PLUGIN = "pwd"
_seq = [1]


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


def full_text(p):
    sub = (p.get("subcommand") or "").strip()
    args = p.get("args") or []
    if sub:
        return " ".join([sub] + list(args)).strip()
    return (p.get("keyword") or "").strip()


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


LOWER = "abcdefghijkmnopqrstuvwxyz"       # 去掉 l
UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"        # 去掉 I O
DIGIT = "23456789"                        # 去掉 0 1
SYMBOL = "!@#$%^&*()-_=+[]{}<>?,.:;"
WORDS = ["amber", "bison", "cobalt", "delta", "ember", "falcon", "garnet", "harbor",
         "indigo", "jasper", "kelvin", "lumen", "maple", "nectar", "onyx", "pepper",
         "quartz", "raven", "saffron", "topaz", "umber", "violet", "walnut", "xenon",
         "yarrow", "zephyr", "solstice", "cascade", "meadow", "orbit"]


def _gen(n, symbols=True, easy=False):
    pool = LOWER + UPPER + DIGIT + (SYMBOL if symbols else "")
    n = max(4, min(int(n), 128))
    if not symbols:
        return "".join(secrets.choice(pool) for _ in range(n))
    for _ in range(200):
        pw = [secrets.choice(pool) for _ in range(n)]
        pw[secrets.randbelow(n)] = secrets.choice(SYMBOL)
        pw[secrets.randbelow(n)] = secrets.choice(DIGIT)
        pw[secrets.randbelow(n)] = secrets.choice(LOWER)
        pw[secrets.randbelow(n)] = secrets.choice(UPPER)
        out = "".join(pw)
        if any(c in SYMBOL for c in out) and any(c.isdigit() for c in out):
            return out
    return "".join(secrets.choice(pool) for _ in range(n))


def _pin(n):
    return "".join(secrets.choice("0123456789") for _ in range(n))


def _phrase(count=3):
    return "-".join(secrets.choice(WORDS) for _ in range(count))


def _cost(pw):
    pool = 0
    if any(c.islower() for c in pw):
        pool += 26
    if any(c.isupper() for c in pw):
        pool += 26
    if any(c.isdigit() for c in pw):
        pool += 10
    if any(not c.isalnum() for c in pw):
        pool += len(SYMBOL)
    bits = len(pw) * (pool.bit_length() - 1) if pool > 1 else 0
    return bits


def on_search(p):
    toks = full_text(p).split()
    length = 20
    symbols = True
    easy = False
    for t in toks:
        low = t.lower()
        if low in ("nosym", "nosymbol", "无符号"):
            symbols = False
        elif low in ("easy", "简单", "易输入"):
            easy = True
        elif t.isdigit():
            length = max(4, min(int(t), 128))

    lower_pool = LOWER if easy else LOWER + UPPER + DIGIT
    variants = [
        ("主密码", length, symbols),
        ("长密码", max(32, length), symbols),
        ("易输入", 16, False),
    ]
    out = []
    for i, (label, n, sym) in enumerate(variants):
        if easy:
            pw = "".join(secrets.choice(lower_pool) for _ in range(n))
        else:
            pw = _gen(n, symbols=sym)
        out.append(item(f"pwd:{i}", pw, f"{label} · {len(pw)} 位 · 约 {_cost(pw)} 位熵",
                        badge=label, icon="🔑", value=pw, label=label))
    pin6, pin4 = _pin(6), _pin(4)
    out.append(item("pwd:pin6", pin6, "6 位数字 PIN", badge="PIN", icon="#️⃣",
                    value=pin6, label="PIN"))
    out.append(item("pwd:pin4", pin4, "4 位数字 PIN", badge="PIN", icon="#️⃣",
                    value=pin4, label="PIN"))
    ph = _phrase(3)
    out.append(item("pwd:phrase", ph, "记忆短语（3 词）", badge="短语", icon="📝",
                    value=ph, label="记忆短语"))
    return {"items": out, "emptyText": "无结果"}


def on_select(p):
    md = p.get("metadata") or {}
    val = md.get("value")
    if not val:
        return {"toast": "该项无内容可复制"}
    return {"copy": str(val), "toast": f"已复制 {md.get('label', '密码')}"}


HANDLERS = {"search": on_search, "select": on_select}

if __name__ == "__main__":
    try:
        main(HANDLERS)
    finally:
        sys.exit(0)
