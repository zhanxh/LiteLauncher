/**
 * 区域框选的**纯几何逻辑**（可单测，不含任何 DOM / 宿主调用）
 *
 * 抽出来单独成 .ts 的原因：项目约定——测试脚手架对 `.ts` 递归转译，
 * 而 `.tsx` 只能返回空模块（solid JSX 需编译期）。可测的纯逻辑必须落在 .ts。
 */
import type { CaptureRegion } from '@ll/sdk';

/** 框选拖拽的中间状态 */
export interface DragState {
  /** 按下时的起点（CSS 像素，相对遮罩层左上角） */
  startX: number;
  startY: number;
  /** 当前指针位置 */
  curX: number;
  curY: number;
}

/** 归一化后的矩形（CSS 像素，左上角 + 宽高，宽高恒为正） */
export interface NormRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把拖拽状态归一化成矩形。
 *
 * 关键点：**方向无关**。用户从右下往左上框选（很常见）时，
 * 起点大于终点，若不交换 min/max 会得到负宽高，宿主会按 u32 转换后溢出成天文数字。
 */
export function normalizeDrag(d: DragState): NormRect {
  const x = Math.min(d.startX, d.curX);
  const y = Math.min(d.startY, d.curY);
  const width = Math.abs(d.curX - d.startX);
  const height = Math.abs(d.curY - d.startY);
  return { x, y, width, height };
}

/** 选区是否小到可以忽略（误触阈值：单击而非拖拽） */
export function isTinyDrag(r: NormRect, minSize = 4): boolean {
  return r.width < minSize || r.height < minSize;
}

/**
 * CSS 像素 → 桌面全局物理像素。
 *
 * 遮罩层铺满某块屏，其 CSS 尺寸 = 该屏物理尺寸 / scaleFactor，所以要把
 * 用户框的 CSS 坐标还原成**全局物理**坐标（`svc.screen.*` 的统一坐标系）时，
 * 要做两件事：
 *   1. 乘 scaleFactor 还原成物理像素
 *   2. 加上该屏在虚拟桌面中的原点（副屏可能是负坐标）
 *
 * 少任何一步，高 DPI 屏或副屏上的框选都会整体偏移。
 */
export function cssToGlobal(
  rect: NormRect,
  scaleFactor: number,
  monitorOrigin: { x: number; y: number },
): CaptureRegion {
  return {
    x: Math.round(monitorOrigin.x + rect.x * scaleFactor),
    y: Math.round(monitorOrigin.y + rect.y * scaleFactor),
    width: Math.max(1, Math.round(rect.width * scaleFactor)),
    height: Math.max(1, Math.round(rect.height * scaleFactor)),
  };
}

/** 选区的人类可读尺寸描述（按 scaleFactor 还原成物理像素显示） */
export function describeSize(rect: NormRect, scaleFactor: number): string {
  const w = Math.round(rect.width * scaleFactor);
  const h = Math.round(rect.height * scaleFactor);
  return `${w} × ${h}`;
}

/** 选区是否完全落在遮罩层内（拖出边界时应被裁剪，故正常恒为 true，留作防御） */
export function withinBounds(rect: NormRect, boundsW: number, boundsH: number): boolean {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= boundsW + 1 &&
    rect.y + rect.height <= boundsH + 1
  );
}
