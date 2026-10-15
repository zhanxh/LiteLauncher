/**
 * 时间轴（周/日视图）的纯几何计算：把实例摊到某一天、再把互相重叠的块并排分道。
 *
 * 这两步都容易静默算错：跨天事件切错一分钟，块就顶到次日；分道算错，
 * 两块叠在一起根本读不出来。放成纯函数才好单测。
 */
import { dateKey } from './grid';
import { CalInstance, parseLocal } from './daymath';

/** 一天内的分钟区间，左闭右开 */
export interface Span {
  startMin: number;
  endMin: number;
}

export const MINUTES_PER_DAY = 1440;

/** 定时事件的默认块高（分钟）：零时长事件在时间轴上要占一格，否则点不到 */
export const MIN_BLOCK_MIN = 15;

/**
 * 实例在指定那天占的时间轴区间；不占（不在这天 / 是全天事项）返回 null。
 *
 * 全天事项走顶部的全天带，不进时间轴——它没有"几点到几点"的语义，
 * 画成 00:00–24:00 的色块会把整列糊满。
 */
export function timelineSpan(inst: CalInstance, day: string): Span | null {
  if (inst.all_day) return null;
  const start = parseLocal(inst.start);
  if (!start) return null;
  const end = parseLocal(inst.end) ?? start;
  const [y, m, d] = day.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d).getTime();
  const dayEnd = dayStart + MINUTES_PER_DAY * 60_000;
  if (end.getTime() <= dayStart || start.getTime() >= dayEnd) return null;
  const startMin = clampMin((start.getTime() - dayStart) / 60_000);
  const rawEnd = clampMin((Math.max(end.getTime(), start.getTime()) - dayStart) / 60_000);
  return { startMin, endMin: Math.max(rawEnd, startMin + MIN_BLOCK_MIN) };
}

function clampMin(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(MINUTES_PER_DAY, Math.max(0, v));
}

export interface Placed<T> extends Span {
  item: T;
  /** 第几道（0 起） */
  lane: number;
  /** 所在重叠簇一共几道 */
  lanes: number;
}

/**
 * 重叠分道：按开始时间扫描，块放进最左边的空闲道；同一簇（互相直接或传递重叠）
 * 共用一个道数，宽度按簇算——否则两条只跟中间那条重叠的日程会各自以为很宽，
 * 结果还是叠在一起。
 */
export function packLanes<T>(items: readonly (Span & { item: T })[]): Placed<T>[] {
  const sorted = [...items].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin,
  );
  const placed: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let clusterEnd = 0;

  const flush = () => {
    const lanes = cluster.reduce((n, p) => Math.max(n, p.lane + 1), 1);
    for (const p of cluster) p.lanes = lanes;
    cluster = [];
  };

  for (const item of sorted) {
    if (cluster.length && item.startMin >= clusterEnd) {
      flush();
      clusterEnd = 0;
    }
    const busy = cluster.filter((p) => p.endMin > item.startMin).map((p) => p.lane);
    let lane = 0;
    while (busy.includes(lane)) lane++;
    const p: Placed<T> = {
      item: item.item,
      startMin: item.startMin,
      endMin: item.endMin,
      lane,
      lanes: 1,
    };
    cluster.push(p);
    placed.push(p);
    clusterEnd = Math.max(clusterEnd, item.endMin);
  }
  flush();
  return placed;
}

/** 当天 00:00 起算的"现在"，用于时间轴上的当前时刻线 */
export function nowMinutes(now = new Date()): number {
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

/** 给定日期串偏移天数（月/周/日导航共用，避开 Date 的月份进位坑） */
export function shiftDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return dateKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/** 该日期所在周的周一（本项目全程周一为一周起点） */
export function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const idx = (dt.getDay() + 6) % 7;
  dt.setDate(dt.getDate() - idx);
  return dateKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
}
