/**
 * /hash 纯函数实现（WP-15：从 Python 标准库迁到 WebView）。
 *
 * 为什么保留手写 MD5：Web Crypto 不提供 MD5，而 /hash 的历史输出必须兼容。
 * 其余 SHA 系列走 crypto.subtle（异步），所有编码函数保持与 Python 版一致的
 * UTF-8 / 百分号编码 / html.escape 语义。
 */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0,
);

const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;

/** UTF-8 字符串的 MD5（RFC 1321），返回 32 位小写 hex */
export function md5Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(total);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLen = bytes.length * 8;
  view.setUint32(total - 8, bitLen >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(offset + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const next = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i] + m[g]) >>> 0, MD5_S[i])) >>> 0;
      a = next;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const wordHex = (word: number) => {
    let out = '';
    for (let i = 0; i < 4; i += 1) {
      out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return out;
  };
  return wordHex(a0) + wordHex(b0) + wordHex(c0) + wordHex(d0);
}

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** zlib.crc32 等价实现（8 位小写 hex） */
export function crc32Hex(text: string): string {
  const table = getCrcTable();
  const bytes = new TextEncoder().encode(text);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

function bytesToBinary(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

export function base64Encode(text: string): string {
  return btoa(bytesToBinary(new TextEncoder().encode(text)));
}

/** 解码失败返回 null（Python 版解码失败会跳过该项） */
export function base64Decode(text: string): string | null {
  let normalized = text.replace(/\s+/g, '');
  normalized += '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function urlEncode(text: string): string {
  // Python quote(safe="") 会编码 !'()*，encodeURIComponent 不会
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function urlDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    // Python unquote 对非法百分号是宽容的；这里退回原文而不是抛错
    return text;
  }
}

const HTML_NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

export function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function htmlUnescape(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return HTML_NAMED[body] ?? whole;
  });
}

export interface HashEntry {
  name: string;
  label: string;
  value: string;
}

const LABELS: Record<string, string> = {
  md5: 'MD5',
  sha1: 'SHA1',
  sha256: 'SHA256',
  sha512: 'SHA512',
  base64: 'Base64 编码',
  base64d: 'Base64 解码',
  url: 'URL 编码',
  urldec: 'URL 解码',
  html: 'HTML 转义',
  htmlunesc: 'HTML 反转义',
  crc32: 'CRC32',
};

const ORDER = [
  'md5',
  'sha1',
  'sha256',
  'sha512',
  'base64',
  'base64d',
  'url',
  'urldec',
  'html',
  'htmlunesc',
  'crc32',
];

async function digestHex(algo: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest(algo, data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** 按算法名算一项；失败/空值返回 null（对应 Python 的 try/continue） */
export async function computeHash(name: string, text: string): Promise<string | null> {
  try {
    switch (name) {
      case 'md5':
        return md5Hex(text);
      case 'sha1':
        return await digestHex('SHA-1', text);
      case 'sha256':
        return await digestHex('SHA-256', text);
      case 'sha512':
        return await digestHex('SHA-512', text);
      case 'base64':
        return base64Encode(text);
      case 'base64d':
        return base64Decode(text);
      case 'url':
        return urlEncode(text);
      case 'urldec':
        return urlDecode(text);
      case 'html':
        return htmlEscape(text);
      case 'htmlunesc':
        return htmlUnescape(text);
      case 'crc32':
        return crc32Hex(text);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function isHashAlgo(name: string): boolean {
  return ORDER.includes(name);
}

export async function computeEntries(names: string[], text: string): Promise<HashEntry[]> {
  const out: HashEntry[] = [];
  for (const name of names) {
    const value = await computeHash(name, text);
    if (!value) continue;
    out.push({ name, label: LABELS[name] ?? name, value });
  }
  return out;
}

export function oneLine(text: string, limit = 76): string {
  const flat = text.replace(/\r/g, ' ').replace(/\n/g, ' ');
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

export function inputSize(text: string): { chars: number; bytes: number } {
  return { chars: [...text].length, bytes: new TextEncoder().encode(text).length };
}
