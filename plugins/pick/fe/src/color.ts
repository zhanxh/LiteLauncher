/**
 * 取色器的纯色彩换算。
 *
 * 刻意不依赖 DOM / solid / Tauri：取色台视图与指令面板都要用它，
 * 而这些逻辑又必须在 Node 里可测（视图组件含 JSX 无法在 Node 直跑）。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export type ColorFormat = 'hex' | 'rgb' | 'hsl';

/** `#RGB` / `#RRGGBB`（带不带 `#` 都认）→ RGB；非法输入返回 null */
export function hexToRgb(hex: string): Rgb | null {
  const raw = (hex ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return {
      r: Number.parseInt(raw[0] + raw[0], 16),
      g: Number.parseInt(raw[1] + raw[1], 16),
      b: Number.parseInt(raw[2] + raw[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
    };
  }
  return null;
}

/** RGB → 规范大写 `#RRGGBB`（分量越界自动收敛） */
export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (
    '#' +
    [r, g, b]
      .map((v) => clamp(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

/** RGB → HSL（h: 0–360，s/l: 0–100，四舍五入取整） */
export function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;

  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;

  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** 按格式渲染颜色字符串 */
export function formatColor(color: Rgb, format: ColorFormat): string {
  switch (format) {
    case 'rgb':
      return `rgb(${color.r}, ${color.g}, ${color.b})`;
    case 'hsl': {
      const { h, s, l } = rgbToHsl(color.r, color.g, color.b);
      return `hsl(${h}, ${s}%, ${l}%)`;
    }
    default:
      return rgbToHex(color.r, color.g, color.b);
  }
}

/**
 * 在给定底色上该用深字还是浅字（相对亮度法，阈值取 WCAG 的 0.179）。
 * 取色台把采样色铺成底色时，用它保证文字始终可读。
 */
export function readableOn(color: Rgb): '#000000' | '#FFFFFF' {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  return luminance > 0.179 ? '#000000' : '#FFFFFF';
}
