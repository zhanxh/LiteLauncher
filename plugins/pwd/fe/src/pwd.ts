/**
 * /pwd 密码生成（WP-15：Python secrets → Web Crypto）
 *
 * 使用 crypto.getRandomValues + 拒绝采样，避免 modulo 偏差；生成策略与旧版一致：
 * 主密码/长密码/易输入 + 6/4 位 PIN + 3 词短语。
 */

export const LOWER = 'abcdefghijkmnopqrstuvwxyz'; // 去掉 l
export const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉 I O
export const DIGIT = '23456789'; // 去掉 0 1
export const SYMBOL = '!@#$%^&*()-_=+[]{}<>?,.:;';
export const WORDS = [
  'amber', 'bison', 'cobalt', 'delta', 'ember', 'falcon', 'garnet', 'harbor',
  'indigo', 'jasper', 'kelvin', 'lumen', 'maple', 'nectar', 'onyx', 'pepper',
  'quartz', 'raven', 'saffron', 'topaz', 'umber', 'violet', 'walnut', 'xenon',
  'yarrow', 'zephyr', 'solstice', 'cascade', 'meadow', 'orbit',
];

function randomInt(max: number): number {
  if (max <= 0) throw new Error('随机范围必须大于 0');
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

function pick(pool: string): string {
  return pool[randomInt(pool.length)];
}

export function generatePassword(n: number, symbols = true, easy = false): string {
  const length = Math.max(4, Math.min(Math.trunc(n), 128));
  if (easy) {
    return Array.from({ length }, () => pick(LOWER)).join('');
  }
  const pool = LOWER + UPPER + DIGIT + (symbols ? SYMBOL : '');
  if (!symbols) {
    return Array.from({ length }, () => pick(pool)).join('');
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const chars = Array.from({ length }, () => pick(pool));
    chars[randomInt(length)] = pick(SYMBOL);
    chars[randomInt(length)] = pick(DIGIT);
    chars[randomInt(length)] = pick(LOWER);
    chars[randomInt(length)] = pick(UPPER);
    const out = chars.join('');
    if ([...out].some((c) => SYMBOL.includes(c)) && [...out].some((c) => /\d/.test(c))) {
      return out;
    }
  }
  return Array.from({ length }, () => pick(pool)).join('');
}

export function generatePin(n: number): string {
  return Array.from({ length: n }, () => pick('0123456789')).join('');
}

export function generatePhrase(count = 3): string {
  return Array.from({ length: count }, () => WORDS[randomInt(WORDS.length)]).join('-');
}

export function entropyBits(password: string): number {
  let pool = 0;
  if ([...password].some((c) => /[a-z]/.test(c))) pool += 26;
  if ([...password].some((c) => /[A-Z]/.test(c))) pool += 26;
  if ([...password].some((c) => /\d/.test(c))) pool += 10;
  if ([...password].some((c) => !/[a-zA-Z0-9]/.test(c))) pool += SYMBOL.length;
  return pool > 1 ? [...password].length * Math.floor(Math.log2(pool)) : 0;
}

export interface PwdVariant {
  id: string;
  label: string;
  value: string;
  description: string;
}

export function generateVariants(input: string): PwdVariant[] {
  let length = 20;
  let symbols = true;
  let easy = false;
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const low = token.toLowerCase();
    if (low === 'nosym' || low === 'nosymbol' || low === '无符号') {
      symbols = false;
    } else if (low === 'easy' || low === '简单' || low === '易输入') {
      easy = true;
    } else if (/^\d+$/.test(token)) {
      length = Math.max(4, Math.min(Number(token), 128));
    }
  }

  const variants: PwdVariant[] = [];
  const specs: Array<[string, number, boolean]> = [
    ['主密码', length, symbols],
    ['长密码', Math.max(32, length), symbols],
    ['易输入', 16, false],
  ];
  for (const [label, n, sym] of specs) {
    const value = generatePassword(n, sym, easy);
    variants.push({
      id: label,
      label,
      value,
      description: `${label} · ${value.length} 位 · 约 ${entropyBits(value)} 位熵`,
    });
  }
  const pin6 = generatePin(6);
  const pin4 = generatePin(4);
  variants.push(
    { id: 'pin6', label: 'PIN', value: pin6, description: '6 位数字 PIN' },
    { id: 'pin4', label: 'PIN', value: pin4, description: '4 位数字 PIN' },
  );
  const phrase = generatePhrase(3);
  variants.push({
    id: 'phrase',
    label: '短语',
    value: phrase,
    description: '记忆短语（3 词）',
  });
  return variants;
}
