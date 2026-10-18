/**
 * /cidr 纯函数实现（WP-15：Python ipaddress → BigInt）
 *
 * 支持 IPv4/IPv6、主机位归一化提示、掩码/广播/可用范围/总数与子网拆分。
 * 所有格式化保持 Python ipaddress 的常见输出（IPv6 压缩格式、小写）。
 */

export type IPVersion = 4 | 6;

export interface CidrAnalysis {
  version: IPVersion;
  network: string;
  prefix: number;
  hadHostBits: boolean;
  /** IPv4 only */
  broadcast?: string;
  netmask?: string;
  hostmask?: string;
  range?: string;
  hosts?: string;
  first: string;
  last: string;
  total: string;
  scope: string;
  split?: { count: number; prefix: number; subnets: string[] };
}

export type CidrResult =
  | { ok: true; data: CidrAnalysis }
  | { ok: false; error: string };

const V4_MAX = 0xffffffffn;
const V6_MAX = (1n << 128n) - 1n;

export function parseIpv4(text: string): bigint {
  const parts = text.split('.');
  if (parts.length !== 4) throw new Error(`无效 IPv4: ${text}`);
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`无效 IPv4: ${text}`);
    const n = Number(part);
    if (n < 0 || n > 255) throw new Error(`无效 IPv4: ${text}`);
    value = (value << 8n) + BigInt(n);
  }
  return value;
}

export function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n]
    .map((shift) => String(Number((value >> shift) & 0xffn)))
    .join('.');
}

export function parseIpv6(text: string): bigint {
  let source = text.trim().toLowerCase();
  if (source.includes('.')) {
    const cut = source.lastIndexOf(':');
    if (cut < 0) throw new Error(`无效 IPv6: ${text}`);
    const v4 = parseIpv4(source.slice(cut + 1));
    const hi = ((v4 >> 16n) & 0xffffn).toString(16);
    const lo = (v4 & 0xffffn).toString(16);
    source = `${source.slice(0, cut + 1)}${hi}:${lo}`;
  }

  const halves = source.split('::');
  if (halves.length > 2) throw new Error(`无效 IPv6: ${text}`);
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) {
    throw new Error(`无效 IPv6: ${text}`);
  }
  const groups = [
    ...left,
    ...Array.from({ length: 8 - left.length - right.length }, () => '0'),
    ...right,
  ];
  if (groups.length !== 8) throw new Error(`无效 IPv6: ${text}`);

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) throw new Error(`无效 IPv6: ${text}`);
    value = (value << 16n) + BigInt(`0x${group}`);
  }
  return value;
}

export function formatIpv6(value: bigint): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i -= 1) {
    groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  }
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] !== 0) continue;
    let j = i;
    while (j < groups.length && groups[j] === 0) j += 1;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen >= 2) {
    const left = hex.slice(0, bestStart).join(':');
    const right = hex.slice(bestStart + bestLen).join(':');
    return `${left}::${right}`;
  }
  return hex.join(':');
}

function maskFor(version: IPVersion, prefix: number): bigint {
  const bits = version === 4 ? 32 : 128;
  if (prefix === 0) return 0n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

function ipv4Scope(value: bigint): string {
  const flags: string[] = [];
  const inRange = (base: string, prefix: number) => {
    const start = parseIpv4(base);
    const bits = 32n - BigInt(prefix);
    const mask = bits === 0n ? 0n : (V4_MAX << bits) & V4_MAX;
    return (value & mask) === (start & mask);
  };
  if (inRange('10.0.0.0', 8) || inRange('172.16.0.0', 12) || inRange('192.168.0.0', 16)) flags.push('私有');
  if (inRange('127.0.0.0', 8)) flags.push('回环');
  if (inRange('169.254.0.0', 16)) flags.push('链路本地');
  if (inRange('224.0.0.0', 4)) flags.push('组播');
  if (inRange('240.0.0.0', 4) || inRange('0.0.0.0', 8)) flags.push('保留');
  if (!flags.length) flags.push('公网');
  return flags.join('、');
}

function ipv6Scope(value: bigint): string {
  const flags: string[] = [];
  const prefixMatch = (base: bigint, prefix: number) => {
    const mask = maskFor(6, prefix);
    return (value & mask) === (base & mask);
  };
  if (prefixMatch(0xfc00n << 112n, 7)) flags.push('私有');
  if (value === 1n) flags.push('回环');
  if (prefixMatch(0xfe80n << 112n, 10)) flags.push('链路本地');
  if (prefixMatch(0xff00n << 112n, 8)) flags.push('组播');
  if (prefixMatch(0x20010db8n << 96n, 32)) flags.push('保留');
  if (!flags.length) flags.push('公网');
  return flags.join('、');
}

export function analyzeCidr(raw: string): CidrResult {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ok: false, error: '输入 IP 或网段' };

  const target = tokens[0];
  const slash = target.lastIndexOf('/');
  const addressPart = slash >= 0 ? target.slice(0, slash) : target;
  const prefixPart = slash >= 0 ? target.slice(slash + 1) : '';

  try {
    const v4 = addressPart.includes('.');
    const version: IPVersion = v4 ? 4 : 6;
    const bits = version === 4 ? 32 : 128;
    const value = v4 ? parseIpv4(addressPart) : parseIpv6(addressPart);
    const prefix = prefixPart ? Number(prefixPart) : bits;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
      throw new Error(`前缀长度无效: ${prefixPart}`);
    }
    const networkValue = value & maskFor(version, prefix);
    const hadHostBits = slash >= 0 && networkValue !== value;
    const max = version === 4 ? V4_MAX : V6_MAX;
    const total = 1n << BigInt(bits - prefix);
    const lastValue = networkValue | (max ^ maskFor(version, prefix));

    const common: CidrAnalysis = {
      version,
      network: v4 ? formatIpv4(networkValue) : formatIpv6(networkValue),
      prefix,
      hadHostBits,
      first: v4 ? formatIpv4(networkValue) : formatIpv6(networkValue),
      last: v4 ? formatIpv4(lastValue) : formatIpv6(lastValue),
      total: total.toString(),
      scope: v4 ? ipv4Scope(networkValue) : ipv6Scope(networkValue),
    };

    if (v4) {
      const broadcast = lastValue;
      const netmask = maskFor(4, prefix);
      const hostmask = max ^ netmask;
      let first = networkValue;
      let last = broadcast;
      let hosts = total;
      if (prefix <= 30) {
        first = networkValue + 1n;
        last = broadcast - 1n;
        hosts = total - 2n;
      }
      common.broadcast = formatIpv4(broadcast);
      common.netmask = formatIpv4(netmask);
      common.hostmask = formatIpv4(hostmask);
      common.first = formatIpv4(first);
      common.last = formatIpv4(last);
      common.hosts = hosts.toString();
      common.range = `${formatIpv4(first)} – ${formatIpv4(last)}`;
    }

    const splitCount = tokens[1] && /^\d+$/.test(tokens[1]) ? Number(tokens[1]) : 0;
    if (splitCount >= 2) {
      const need = Math.ceil(Math.log2(splitCount));
      const newPrefix = prefix + need;
      if (newPrefix <= bits) {
        const count = Math.min(2 ** need, 64);
        const step = 1n << BigInt(bits - newPrefix);
        const subnets: string[] = [];
        for (let i = 0; i < count; i += 1) {
          const subnet = networkValue + BigInt(i) * step;
          subnets.push(v4 ? formatIpv4(subnet) : formatIpv6(subnet));
        }
        if (subnets.length) {
          common.split = { count: subnets.length, prefix: newPrefix, subnets };
        }
      }
    }

    return { ok: true, data: common };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
