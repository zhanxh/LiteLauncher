/**
 * 时间轴拖拽的纯算术部分（指针状态机在 TimeGrid 里，这里只回答"拖到哪了"）。
 *
 * 单独成文件同样是为了能单测：吸附和钳位算错一格，用户拖出来的就是 09:07 这种
 * 没人会手写的开始时间。
 */
import { MINUTES_PER_DAY, Span } from './layout';

/** 吸附粒度：钉钉同款 15 分钟，日程排布的常见最小单位 */
export const SNAP_MIN = 15;

/** 1 分钟 = 1.5 像素：一天 1440 分钟 → 2160px，滚动区里刚好是"两屏半"的量级 */
export const PX_PER_MIN = 1.5;

export function snap(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

/** 列内像素偏移 → 当天分钟数（钳在 [0, 1440]） */
export function minAtOffset(offsetY: number, pxPerMin = PX_PER_MIN): number {
  if (!Number.isFinite(offsetY)) return 0;
  return Math.min(MINUTES_PER_DAY, Math.max(0, offsetY / pxPerMin));
}

export function minutesToPx(min: number, pxPerMin = PX_PER_MIN): number {
  return min * pxPerMin;
}

/** 拖出来的两端点 → 合法区间：短于吸附粒度的按一格算，避免拖出零高度块 */
export function normalizeDrag(a: number, b: number): Span {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const startMin = snap(Math.min(lo, MINUTES_PER_DAY - SNAP_MIN));
  const endMin = Math.max(snap(hi), startMin + SNAP_MIN);
  return { startMin, endMin: Math.min(endMin, MINUTES_PER_DAY) };
}

/** 整体平移（保持时长），越界就贴边而不是截断时长 */
export function moveSpan(span: Span, deltaMin: number): Span {
  const dur = span.endMin - span.startMin;
  let startMin = snap(span.startMin + deltaMin);
  startMin = Math.max(0, Math.min(startMin, MINUTES_PER_DAY - dur));
  return { startMin, endMin: startMin + dur };
}

/** 只动结束端，且不允许拖到开始端之前 */
export function resizeSpan(span: Span, endMin: number): Span {
  const next = snap(Math.max(endMin, span.startMin + SNAP_MIN));
  return { startMin: span.startMin, endMin: Math.min(next, MINUTES_PER_DAY) };
}

/** 块底边热区（px）：命中它算"改时长"，否则算"整体移动" */
export const RESIZE_ZONE_PX = 8;
