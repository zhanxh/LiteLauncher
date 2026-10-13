/**
 * 截图标注的几何与绘制计算（纯函数，无 DOM 依赖，可被 node 测试直接跑）
 *
 * 坐标系约定（最容易出错的地方，务必分清）：
 *   - **选区局部坐标**：以选区左上角为原点，单位是 CSS 像素。标注只在这个空间里发生。
 *   - **物理像素**：与宿主/剪贴板交互时用的单位（= 局部坐标 × scale）。
 *   导出图片时Canvas 尺寸用物理像素，保证贴到聊天窗口/文档里不糊。
 */

/** 标注工具类型 */
export type ToolKind = 'none' | 'arrow' | 'rect' | 'ellipse' | 'line' | 'text' | 'mosaic' | 'step';

/** 统一色板：截图标注只需有限的强调色，别让用户调色 */
export const PALETTE = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#A855F7', '#FFFFFF'] as const;

/** 各工具的默认线宽（CSS 像素） */
export const DEFAULT_WIDTH: Record<Exclude<ToolKind, 'none'>, number> = {
  arrow: 3,
  rect: 3,
  ellipse: 3,
  line: 3,
  text: 0, // 文字不用线宽，用字号
  mosaic: 12, // 马赛克块边长
  step: 0, // 步骤号用固定直径
};

export interface Point {
  x: number;
  y: number;
}

/** 一条标注（已归一化为选区局部坐标） */
export interface Annotation {
  id: string;
  kind: Exclude<ToolKind, 'none'>;
  /** 起点（文字/矩形/椭圆/直线/箭头/马赛克拖拽起点，步骤号为圆心） */
  x1: number;
  y1: number;
  /** 终点 */
  x2: number;
  y2: number;
  /** 文字内容（仅 kind='text'） */
  text?: string;
  color: string;
  /** 线宽 / 马赛克块边长 / 文字字号（CSS 像素） */
  size: number;
}

/** 拖拽过程中的临时形状（尚未落到 annotations） */
export interface DraftShape {
  kind: Exclude<ToolKind, 'none'>;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * 归一化拖拽为"左上 + 正宽高"。
 * 反向拖拽（右下→左上）必须走这里，否则矩形会得到负宽高，
 * canvas.strokeRect 会朝反方向画、fillText 定位也会跑偏。
 */
export function normBox(d: DraftShape): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(d.x1, d.x2),
    y: Math.min(d.y1, d.y2),
    w: Math.abs(d.x2 - d.x1),
    h: Math.abs(d.y2 - d.y1),
  };
}

/** 判定一次拖拽是否"太短"（不足以构成有效标注） */
export function isTooShort(d: DraftShape, min = 4): boolean {
  return Math.abs(d.x2 - d.x1) < min && Math.abs(d.y2 - d.y1) < min;
}

/** 箭头：返回从 (x1,y1) 指向 (x2,y2) 的单位向量 */
export function arrowVector(x1: number, y1: number, x2: number, y2: number): Point {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  // 零长度：给个默认方向而不是 NaN，否则 canvas 收到 NaN 坐标会静默不画
  return len < 1e-6 ? { x: 1, y: 0 } : { x: dx / len, y: dy / len };
}

/**
 * 箭头头部两个翼的端点。
 *
 * @param size 箭头头部边长（CSS 像素）
 * @param spread 张开角度（弧度），默认 30° 左右是视觉上最自然的角度
 */
export function arrowHead(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  size: number,
  spread = Math.PI / 6,
): [Point, Point] {
  const v = arrowVector(x1, y1, x2, y2);
  // 沿箭头方向回退 size，避免头部尖端正好压在终点上显得短
  const bx = x2 - v.x * size;
  const by = y2 - v.y * size;
  const base = Math.atan2(v.y, v.x);
  return [
    { x: bx + Math.cos(base + spread) * size, y: by + Math.sin(base + spread) * size },
    { x: bx + Math.cos(base - spread) * size, y: by + Math.sin(base - spread) * size },
  ];
}

/** 马赛克分块时的块数上限（性能护栏：4K 屏按 8px 切会是 13 万块） */
const MAX_MOSAIC_BLOCKS = 4096;

/**
 * 马赛克覆盖块：把拖拽区域按 blockSize 切成网格，返回每个块的落点。
 * 返回"块"而不是"像素着色指令"，是为了让 canvas 侧只管 fillRect。
 */
export function mosaicBlocks(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  blockSize: number,
): { x: number; y: number; size: number }[] {
  const b = normBox({ kind: 'mosaic', x1, y1, x2, y2 });
  const size = Math.max(2, blockSize);
  // 块数上限保护：拖着选整个屏幕时，按 blockSize 切会产生上万个块拖慢渲染。
  // 先按上限算出网格规模，再据此调整每块的实际尺寸——而不是切完再截断，
  // 后者会在选区边缘留下一大片没打码的空白（安全上不可接受）。
  const maxSide = Math.ceil(Math.sqrt(MAX_MOSAIC_BLOCKS));
  const cols = Math.max(1, Math.min(Math.ceil(b.w / size), maxSide));
  const rows = Math.max(1, Math.min(Math.ceil(b.h / size), maxSide));
  const bw = b.w / cols;
  const bh = b.h / rows;
  const out: { x: number; y: number; size: number }[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      out.push({ x: b.x + c * bw, y: b.y + r * bh, size: Math.max(bw, bh) });
    }
  }
  return out;
}

/**
 * 步骤编号：返回该标第几个（从 1 开始）。
 *
 * 为什么要按 y 排序再编号：用户画步骤的顺序不一定是阅读顺序，
 * 而"教程截图"里的步骤号必须与视觉阅读顺序一致，否则读者会困惑。
 */
export function stepNumbers(list: Annotation[]): Map<string, number> {
  const steps = list.filter((a) => a.kind === 'step');
  // 先按 y 排（同一行再按 x），与视觉阅读顺序一致
  const sorted = [...steps].sort((a, b) => (Math.abs(a.y1 - b.y1) < 12 ? a.x1 - b.x1 : a.y1 - b.y1));
  const out = new Map<string, number>();
  sorted.forEach((a, i) => out.set(a.id, i + 1));
  return out;
}

/** 导出图片的像素尺寸：局部 CSS 尺寸 × 缩放，向下取整但不小于 1 */
export function exportSize(
  boxW: number,
  boxH: number,
  scaleFactor: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(boxW * scaleFactor)),
    height: Math.max(1, Math.round(boxH * scaleFactor)),
  };
}