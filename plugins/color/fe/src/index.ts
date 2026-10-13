/**
 * @ll/plugin-color —— /color 颜色格式转换（纯前端插件，backend.kind = "none"）
 *
 * 支持输入：`#ff8800` / `#f80` / `255,136,0` / `rgb(255,136,0)` / `rgba(...,0.5)` / `hsl(30,100%,50%)`
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';

const PLUGIN_ID = 'color';

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function parseColor(raw: string): Rgb | null {
  const text = raw.trim().toLowerCase();

  const hex = text.match(/^#?([0-9a-f]{3,8})$/);
  if (hex) {
    const h = hex[1];
    const expand = (s: string) => Number.parseInt(s.length === 1 ? s + s : s, 16);
    if (h.length === 3 || h.length === 4) {
      return {
        r: expand(h[0]), g: expand(h[1]), b: expand(h[2]),
        a: h.length === 4 ? expand(h[3]) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: expand(h.slice(0, 2)), g: expand(h.slice(2, 4)), b: expand(h.slice(4, 6)),
        a: h.length === 8 ? expand(h.slice(6, 8)) / 255 : 1,
      };
    }
    return null;
  }

  const fn = text.match(/^(rgb|rgba|hsl|hsla)\s*\(([^)]*)\)$/);
  if (fn) {
    const parts = fn[2].split(/[,/\s]+/).filter(Boolean);
    const nums = parts.map((p) => Number.parseFloat(p));
    if (nums.some((n) => !Number.isFinite(n)) || nums.length < 3) return null;
    const [x, y, z] = nums;
    const a = nums.length > 3 ? clamp(nums[3], 0, 1) : 1;
    if (fn[1].startsWith('rgb')) {
      return { r: clamp(Math.round(x), 0, 255), g: clamp(Math.round(y), 0, 255), b: clamp(Math.round(z), 0, 255), a };
    }
    return hslToRgb(x, clamp(y, 0, 100) / 100, clamp(z, 0, 100) / 100, a);
  }

  const bare = text.split(/[\s,]+/).filter(Boolean);
  if (bare.length === 3 || bare.length === 4) {
    const nums = bare.map((p) => Number.parseFloat(p));
    if (nums.every((n) => Number.isFinite(n))) {
      return {
        r: clamp(Math.round(nums[0]), 0, 255),
        g: clamp(Math.round(nums[1]), 0, 255),
        b: clamp(Math.round(nums[2]), 0, 255),
        a: nums.length === 4 ? clamp(nums[3], 0, 1) : 1,
      };
    }
  }
  return null;
}

function hslToRgb(h: number, s: number, l: number, a: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(hue / 60) % 6;
  const table: Array<[number, number, number]> = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r, g, b] = table[seg];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    a,
  };
}

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) * 60;
  else if (max === gg) h = ((bb - rr) / d + 2) * 60;
  else h = ((rr - gg) / d + 4) * 60;
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

function rgbToHsv({ r, g, b }: Rgb): [number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) * 60;
    else if (max === gg) h = ((bb - rr) / d + 2) * 60;
    else h = ((rr - gg) / d + 4) * 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(v * 100)];
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

function makeItem(id: string, title: string, description: string, badge: string, copy?: string): PanelItem {
  return {
    id: `${PLUGIN_ID}:${id}`,
    title,
    description,
    badge,
    icon: '🎨',
    metadata: copy === undefined ? {} : { value: copy },
  };
}

export const colorPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/color',
  name: '颜色转换',
  description:
    '颜色格式转换：/color #ff8800、/color rgb(255,136,0)、/color hsl(30,100%,50%)、/color 255,136,0 输出 HEX/RGB/RGBA/HSL/HSV 与互补色；回车复制。',
  icon: '🎨',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const parts = [(input.subcommand ?? '').trim(), ...(input.args ?? [])].filter(Boolean);
    const text = parts.join(' ').trim();

    if (!text) {
      return {
        items: [
          makeItem('hint', '输入颜色值', '支持 #ff8800 / #f80 / 255,136,0 / rgb(255,136,0) / hsl(30,100%,50%)', '用法'),
        ],
        emptyText: '输入颜色',
      };
    }

    const rgb = parseColor(text);
    if (!rgb) {
      return {
        items: [makeItem('err', `无法识别的颜色：${text}`, '支持 HEX、rgb()、rgba()、hsl()、hsla() 或 r,g,b', '错误')],
        emptyText: '无法解析',
      };
    }

    const { r, g, b, a } = rgb;
    const [h, s, l] = rgbToHsl(rgb);
    const [, sv, v] = rgbToHsv(rgb);
    const hex = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
    const alpha = Number(a.toFixed(3));
    const rgba = alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
    const hslText = alpha >= 1 ? `hsl(${h}, ${s}%, ${l}%)` : `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
    const hsvText = `hsv(${h}, ${sv}%, ${v}%)`;
    const complement = `#${hex2(255 - r)}${hex2(255 - g)}${hex2(255 - b)}`;

    return {
      items: [
        makeItem('hex', hex.toUpperCase(), '十六进制', 'HEX', hex.toUpperCase()),
        makeItem('rgb', rgba, 'RGB / RGBA', 'RGB', rgba),
        makeItem('hsl', hslText, 'HSL / HSLA', 'HSL', hslText),
        makeItem('hsv', hsvText, 'HSV', 'HSV', hsvText),
        makeItem('comp', complement.toUpperCase(), '互补色（反相）', '互补', complement.toUpperCase()),
        makeItem('alpha', `不透明度 ${Math.round(alpha * 100)}%`, alpha >= 1 ? '完全不透明' : '含透明通道', 'Alpha'),
      ],
      emptyText: '无法解析',
    };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
  },
};

export function setup(): void {
  pluginRegistry.register(colorPlugin);
}
