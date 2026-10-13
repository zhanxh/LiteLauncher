/**
 * @ll/plugin-rand —— /rand 随机生成（纯前端插件，backend.kind = "none"）
 *
 * 只用 Web Crypto 的 getRandomValues（非安全上下文也可用），不依赖 crypto.subtle。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';

const PLUGIN_ID = 'rand';
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USAGE: Array<[string, string]> = [
  ['uuid [n]', '生成 n 个 UUID v4（默认 3）'],
  ['str [长度]', '生成随机字符串（默认 16 位）'],
  ['num [最小] [最大]', '生成区间随机整数（默认 1–100）'],
  ['coin', '抛硬币'],
  ['dice [个数]', '掷骰子（默认 1 个）'],
  ['pick 甲 乙 丙', '从候选中随机挑一个'],
];

function randUint32(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

function randInt(min: number, max: number): number {
  return min + (randUint32() % (max - min + 1));
}

function uuidV4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randString(len: number): string {
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[randUint32() % ALPHABET.length];
  return out;
}

function makeItem(id: string, title: string, description: string, badge: string, copy?: string): PanelItem {
  return {
    id: `${PLUGIN_ID}:${id}`,
    title,
    description,
    badge,
    icon: '🎲',
    metadata: copy === undefined ? {} : { value: copy },
  };
}

/** 生成一组结果（同一子命令下给多个备选，方便一键换一个） */
function generate(sub: string, args: string[]): string | null {
  switch (sub) {
    case 'uuid':
      return uuidV4();
    case 'str': {
      const len = Number.parseInt(args[0] ?? '', 10);
      return randString(Number.isFinite(len) && len > 0 ? Math.min(len, 256) : 16);
    }
    case 'num': {
      const min = Number.parseInt(args[0] ?? '', 10);
      const max = Number.parseInt(args[1] ?? '', 10);
      const lo = Number.isFinite(min) ? min : 1;
      const hi = Number.isFinite(max) ? max : 100;
      if (hi < lo) return null;
      return String(randInt(lo, hi));
    }
    case 'coin':
      return randUint32() % 2 === 0 ? '正面' : '反面';
    case 'dice': {
      const n = Number.parseInt(args[0] ?? '', 10);
      const count = Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 1;
      const rolls = Array.from({ length: count }, () => randInt(1, 6));
      return count === 1 ? String(rolls[0]) : `${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b, 0)}`;
    }
    case 'pick':
      return args.length > 0 ? args[randUint32() % args.length] : null;
    default:
      return null;
  }
}

export const randPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/rand',
  name: '随机生成',
  description:
    '随机生成：/rand 列出全部，或 /rand uuid、/rand str 24、/rand num 1 100、/rand coin、/rand dice、/rand pick 甲 乙 丙；回车复制结果。',
  icon: '🎲',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const sub = (input.subcommand ?? '').trim().toLowerCase();
    const args = input.args ?? [];
    const known = USAGE.some(([usage]) => usage.split(' ')[0] === sub);

    if (!known) {
      // 无子命令：直接给出一串可复制的即时结果，末尾附用法清单
      const defaults: Array<[string, string[], string]> = [
        ['uuid', [], 'UUID v4'],
        ['str', ['16'], '随机字符串（16 位）'],
        ['num', ['1', '100'], '随机整数（1–100）'],
        ['coin', [], '抛硬币'],
        ['dice', [], '掷骰子'],
      ];
      const items: PanelItem[] = [];
      for (const [name, argv, label] of defaults) {
        const value = generate(name, argv);
        if (value) items.push(makeItem(name, value, label, name, value));
      }
      for (const [usage, desc] of USAGE) {
        items.push(makeItem(`help-${usage}`, `/rand ${usage}`, desc, '用法'));
      }
      return { items, emptyText: '无可用生成器' };
    }

    // 指定子命令：pick 直接给一个结果，其余给 3 个备选
    const variants = sub === 'pick' || sub === 'num' ? 1 : 3;
    const items: PanelItem[] = [];
    for (let i = 0; i < variants; i += 1) {
      const value = generate(sub, args);
      if (!value) break;
      items.push(makeItem(`${sub}-${i}`, value, `${sub} 第 ${i + 1} 个结果`, sub, value));
    }
    if (items.length === 0) {
      return { items: [makeItem('bad', '参数不合法', `用法：${sub} ${USAGE.find(([u]) => u.startsWith(sub))?.[1] ?? ''}`, '错误')], emptyText: '参数错误' };
    }
    return { items, emptyText: '无结果' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制：${value}` };
  },
};

export function setup(): void {
  pluginRegistry.register(randPlugin);
}
