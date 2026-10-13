#!/usr/bin/env python3
"""LiteLauncher LLP/1 外部插件：/cidr 网段计算（自包含，仅标准库）。"""
import ipaddress
import json
import sys

PLUGIN = "cidr"
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


def _scope_flags(net):
    flags = []
    for label, attr in (("私有", "is_private"), ("公网", "is_global"),
                        ("回环", "is_loopback"), ("链路本地", "is_link_local"),
                        ("组播", "is_multicast"), ("保留", "is_reserved")):
        try:
            if getattr(net, attr):
                flags.append(label)
        except Exception:
            pass
    return "、".join(flags) if flags else "未标注"


def _split(net, count):
    import math
    if count < 2:
        return []
    need = math.ceil(math.log2(count))
    new_prefix = net.prefixlen + need
    if new_prefix > net.max_prefixlen:
        return []
    try:
        return list(net.subnets(new_prefix=new_prefix))[:64]
    except Exception:
        return []


def on_search(p):
    text = full_text(p).strip()
    toks = text.split()
    if not toks:
        return {
            "items": [item("cidr:hint", "输入 IP 或网段",
                           "例：/cidr 192.168.1.0/24、/cidr 10.0.0.0/24 4、/cidr 2001:db8::/32",
                           badge="用法", icon="🌐")],
            "emptyText": "输入 IP 或网段",
        }

    target = toks[0]
    had_host_bits = False
    try:
        net = ipaddress.ip_network(target, strict=False)
    except ValueError:
        try:
            ip = ipaddress.ip_address(target)
            net = ipaddress.ip_network(f"{ip}/{ip.max_prefixlen}", strict=False)
        except ValueError as exc:
            return {"items": [item("cidr:err", "无法识别的 IP/网段", str(exc),
                                   badge="错误", icon="❌")],
                    "emptyText": "无法识别"}

    try:
        orig = ipaddress.ip_network(target, strict=True)
    except ValueError:
        had_host_bits = "/" in target

    ver = net.version
    items = [
        item("cidr:network", str(net.network_address), "网络地址", badge="网络", icon="🌐",
             value=str(net.network_address), label="网络地址"),
        item("cidr:prefix", f"/{net.prefixlen}", f"前缀长度（IPv{ver}）", badge="前缀", icon="📏"),
    ]

    if ver == 4:
        items += [
            item("cidr:broadcast", str(net.broadcast_address), "广播地址", badge="广播", icon="📢",
                 value=str(net.broadcast_address), label="广播地址"),
            item("cidr:mask", str(net.netmask), "子网掩码", badge="掩码", icon="🧱",
                 value=str(net.netmask), label="子网掩码"),
            item("cidr:wildcard", str(net.hostmask), "反掩码（wildcard）", badge="反掩码", icon="🧱",
                 value=str(net.hostmask), label="反掩码"),
        ]
        if net.prefixlen <= 30:
            first, last = net.network_address + 1, net.broadcast_address - 1
            hosts = net.num_addresses - 2
        else:
            first, last, hosts = net.network_address, net.broadcast_address, net.num_addresses
        items += [
            item("cidr:range", f"{first} – {last}", "可用主机范围", badge="范围", icon="🔢",
                 value=f"{first} - {last}", label="可用主机范围"),
            item("cidr:hosts", f"{hosts}", "可用主机数", badge="主机数", icon="#️⃣",
                 value=str(hosts), label="可用主机数"),
        ]
    else:
        items += [
            item("cidr:first", str(net.network_address), "首个地址", badge="首地址", icon="🔢",
                 value=str(net.network_address), label="首个地址"),
            item("cidr:last", str(net[-1]), "末个地址", badge="末地址", icon="🔢",
                 value=str(net[-1]), label="末个地址"),
        ]

    items += [
        item("cidr:total", f"{net.num_addresses}", "地址总数", badge="总数", icon="#️⃣",
             value=str(net.num_addresses), label="地址总数"),
        item("cidr:scope", _scope_flags(net), f"IPv{ver}", badge="属性", icon="🏷️"),
    ]
    if had_host_bits:
        items.insert(1, item("cidr:note", str(net), "输入含主机位，已按网段归一化",
                             badge="提示", icon="ℹ️"))

    if len(toks) > 1 and toks[1].isdigit():
        subnets = _split(net, int(toks[1]))
        if subnets:
            items.append(item("cidr:split", f"拆分为 {len(subnets)} 个子网",
                              f"新前缀 /{subnets[0].prefixlen}", badge="拆分", icon="✂️"))
            for i, sub in enumerate(subnets[:20]):
                items.append(item(f"cidr:s{i}", str(sub), f"第 {i + 1} 个", badge=f"#{i + 1}",
                                  icon="🌐", value=str(sub), label=f"子网 {i + 1}"))

    return {"items": items, "emptyText": "无结果"}


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
