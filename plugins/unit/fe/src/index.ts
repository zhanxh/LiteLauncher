/**
 * @ll/plugin-unit —— /unit 单位换算与进制转换（纯前端插件，backend.kind = "none"）
 *
 * 用法：/unit <数值> <源单位> [目标单位]  |  /unit <hex|bin|oct|dec> <数值>
 * 无后端：换算表与进制转换都在本文件。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';

const PLUGIN_ID = 'unit';

/** 各族以基准单位计的换算系数（温度单列，因其为仿射变换而非比例） */
const FAMILIES: Record<string, Record<string, number>> = {
  长度: {
    m: 1, km: 1000, cm: 0.01, mm: 0.001, um: 1e-6,
    mi: 1609.344, ft: 0.3048, in: 0.0254, yd: 0.9144, nmi: 1852,
  },
  质量: {
    kg: 1, g: 0.001, mg: 1e-6, t: 1000,
    lb: 0.45359237, oz: 0.028349523125, jin: 0.5, liang: 0.05,
  },
  面积: { m2: 1, km2: 1e6, cm2: 1e-4, ha: 10000, acre: 4046.8564224, mu: 666.6666666666666 },
  数据: { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776, PB: 1125899906842624 },
  速度: { 'm/s': 1, mps: 1, 'km/h': 0.2777777777777778, kph: 0.2777777777777778, mph: 0.44704, kn: 0.5144444444444445 },
  时间: { s: 1, min: 60, h: 3600, d: 86400, w: 604800 },
};

const ALIASES: Record<string, string> = {
  米: 'm', 千米: 'km', 公里: 'km', 厘米: 'cm', 毫米: 'mm', 微米: 'um',
  英里: 'mi', 英尺: 'ft', 英寸: 'in', 码: 'yd', 海里: 'nmi',
  千克: 'kg', 公斤: 'kg', 克: 'g', 毫克: 'mg', 吨: 't',
  磅: 'lb', 盎司: 'oz', 斤: 'jin', 两: 'liang',
  平方米: 'm2', 平方公里: 'km2', 公顷: 'ha', 英亩: 'acre', 亩: 'mu',
  字节: 'B', 分钟: 'min', 分: 'min', 小时: 'h', 时: 'h', 天: 'd', 日: 'd', 周: 'w',
};

const TEMP_UNITS = new Set(['c', 'f', 'k']);
const BASES = new Set(['hex', 'bin', 'oct', 'dec']);
const BASE_LABELS: Record<string, string> = { dec: '十进制', hex: '十六进制', bin: '二进制', oct: '八进制' };

/** 归一化单位名（大小写、度数符号、中文别名） */
function normUnit(raw: string): string {
  const u = raw.trim().toLowerCase().replace(/°/g, '').replace(/℃/g, 'c').replace(/℉/g, 'f');
  return ALIASES[u] ?? u;
}

function findFamily(unit: string): [string, Record<string, number>] | null {
  for (const [fam, table] of Object.entries(FAMILIES)) {
    if (unit in table) return [fam, table];
  }
  return null;
}

function toNumber(token: string): number | null {
  const v = Number.parseFloat(token.trim().replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
}

/** 数值格式化：整数直出；极大/极小值用 6 位有效数字；其余保留 6 位并去掉尾随 0 */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  if (Math.abs(v) >= 1e6 || (v !== 0 && Math.abs(v) < 1e-4)) {
    return v.toExponential(5).replace(/\.?0+e/, 'e').replace('e+', 'e');
  }
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function convertTemp(v: number, src: string, dst: string): number {
  if (src === dst) return v;
  const c = src === 'c' ? v : src === 'f' ? ((v - 32) * 5) / 9 : v - 273.15;
  if (dst === 'c') return c;
  if (dst === 'f') return (c * 9) / 5 + 32;
  return c + 273.15;
}

function makeItem(id: string, title: string, description: string, badge: string, copy?: string, icon = '📐'): PanelItem {
  return {
    id: `${PLUGIN_ID}:${id}`,
    title,
    description,
    badge,
    icon,
    metadata: copy === undefined ? {} : { value: copy },
  };
}

/** 进制转换：cmd 表示**目标进制**，即 /unit hex 255 → 255 转成十六进制 */
function baseItems(cmd: string, raw: string): PanelItem[] {
  const text = raw.trim();
  if (!text) {
    return [makeItem('err', '缺少数值', `例：/unit ${cmd} 255`, '错误', undefined, '❌')];
  }
  let value: number;
  if (/^0[xbo]/i.test(text)) value = Number.parseInt(text, 0);
  else if (/^-?\d+$/.test(text)) value = Number.parseInt(text, 10);
  else value = Number.NaN;
  if (!Number.isFinite(value)) {
    return [makeItem('err', '数值非法', `「${text}」无法解析为整数`, '错误', undefined, '❌')];
  }
  if (value < 0) return [makeItem('err', '暂不支持负数', text, '错误', undefined, '❌')];

  const render = (k: string): string => {
    switch (k) {
      case 'hex': return `0x${value.toString(16)}`;
      case 'bin': return `0b${value.toString(2)}`;
      case 'oct': return `0o${value.toString(8)}`;
      default: return String(value);
    }
  };

  const order = [cmd, ...['dec', 'hex', 'bin', 'oct'].filter((k) => k !== cmd)];
  const out: PanelItem[] = order.map((k) => {
    const rendered = render(k);
    const suffix = k === cmd ? '（目标进制）' : '';
    return makeItem(k, rendered, `${BASE_LABELS[k]}${suffix}`, k, rendered, '🔢');
  });

  const width = Math.max(1, Math.ceil(value.toString(2).length / 8));
  const hexBytes = value.toString(16).toUpperCase().padStart(width * 2, '0');
  out.push(
    makeItem(
      'bytes',
      (hexBytes.match(/../g) ?? []).join(' '),
      '字节序列（大端）',
      'bytes',
      undefined,
      '🧱',
    ),
  );
  return out;
}

function fullText(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  const args = input.args ?? [];
  if (sub) return [sub, ...args].join(' ').trim();
  return (input.queryText ?? '').trim();
}

export const unitPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/unit',
  name: '单位换算',
  description:
    '单位换算与进制转换：/unit 100 km mi、/unit 100 km（列出同族换算）、/unit 36.5 c f、/unit hex 255（255→0xFF）、/unit bin 10。回车复制结果。',
  icon: '📐',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const text = fullText(input);
    const toks = text.split(/\s+/).filter(Boolean);
    if (toks.length === 0) {
      const fams = Object.keys(FAMILIES).join(' / ');
      return {
        items: [
          makeItem('hint1', '格式：数值 源单位 [目标单位]', '例：/unit 100 km mi、/unit 36.5 c f', '用法', undefined, '📐'),
          makeItem('hint2', '进制转换', 'hex/bin/oct/dec + 数值，如 /unit hex 255', '用法', undefined, '🔢'),
          makeItem('hint3', `支持族：${fams} / 温度(c f k)`, '中文单位名亦可，如 /unit 100 公里 英里', '族', undefined, '📚'),
        ],
        emptyText: '输入换算表达式',
      };
    }

    const head = toks[0].toLowerCase();
    if (BASES.has(head)) {
      return { items: baseItems(head, toks.slice(1).join(' ')), emptyText: '无结果' };
    }

    let value: number | null = null;
    let src: string | null = null;
    let dst: string | null = null;
    for (const token of toks) {
      const n = toNumber(token);
      if (n !== null && value === null) {
        value = n;
        continue;
      }
      const u = normUnit(token);
      const usable = TEMP_UNITS.has(u) || findFamily(u) !== null;
      if (!usable) continue;
      if (src === null) src = u;
      else if (dst === null) dst = u;
    }

    if (value === null || src === null) {
      return {
        items: [makeItem('err', '无法解析', '格式：数值 源单位 [目标单位]，如 100 km mi', '错误', undefined, '❌')],
        emptyText: '无法解析',
      };
    }

    // 收窄后固化为 const：闭包内 let 的收窄会失效
    const amount: number = value;
    const fromUnit: string = src;

    // 温度：仿射变换，单独处理
    if (TEMP_UNITS.has(fromUnit)) {
      const target = dst ?? 'c';
      if (!TEMP_UNITS.has(target)) {
        return { items: [makeItem('err', '目标单位不匹配', target, '错误', undefined, '❌')], emptyText: '单位不匹配' };
      }
      const v = fmt(convertTemp(amount, fromUnit, target));
      return {
        items: [makeItem('t', `${v} ${target}`, `${fmt(amount)} ${fromUnit} → ${target}`, '温度', v, '🌡️')],
        emptyText: '无结果',
      };
    }

    const family = findFamily(fromUnit);
    if (!family) {
      return { items: [makeItem('err', '未知单位', fromUnit, '错误', undefined, '❌')], emptyText: '未知单位' };
    }
    const [fam, table] = family;

    if (dst !== null) {
      const other = findFamily(dst);
      if (!other || other[0] !== fam) {
        return { items: [makeItem('err', '单位不同族', `${fromUnit} 与 ${dst}`, '错误', undefined, '❌')], emptyText: '单位不同族' };
      }
      const v = fmt((amount * table[fromUnit]) / other[1][dst]);
      return {
        items: [makeItem('r', `${v} ${dst}`, `${fmt(amount)} ${fromUnit} → ${dst}`, fam, v)],
        emptyText: '无结果',
      };
    }

    const base = amount * table[fromUnit];
    return {
      items: Object.entries(table).map(([u, factor]) => {
        const v = fmt(base / factor);
        return makeItem(u, `${v} ${u}`, `${fmt(amount)} ${fromUnit} 换算为 ${u}`, fam, v);
      }),
      emptyText: '无结果',
    };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
  },
};

export function setup(): void {
  pluginRegistry.register(unitPlugin);
}
