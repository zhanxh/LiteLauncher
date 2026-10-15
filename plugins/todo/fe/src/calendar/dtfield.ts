/**
 * 日期/时间选择器的纯逻辑。
 *
 * 单独成 .ts 是为了能被 tools/test-fe-plugins.mjs 转译直测——JSX 进不去那个测试台，
 * 而"哪些档位算过期""打开时滚到哪一格"这类判断正是最容易悄悄错的地方。
 * 所有跟"现在几点"有关的结果都由调用方注入 now，不读系统时钟。
 */
import { dateKey } from './grid';

/** 时间档位步长（分钟）：00:00、00:15 … 23:30、23:45 */
export const SLOT_STEP = 15;

/** 只选了日期时补上的时间，与新建日程的种子时刻一致 */
export const DEFAULT_TIME = '09:00';

export interface TimeSlot {
  index: number;
  hh: number;
  mm: number;
  /** "HH:MM" */
  label: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 时间列表的行高（px）。CSS 用 --dtf-row 取同一个值，滚动定位才是确定数 */
export const ROW_HEIGHT = 28;

/** 一天的档位表：模块级常量，Solid 的 <For> 按引用建 key，每次新建会整列重建 */
export const TIME_SLOTS: TimeSlot[] = Array.from(
  { length: (24 * 60) / SLOT_STEP },
  (_, i) => ({
    index: i,
    hh: Math.floor(i * SLOT_STEP / 60),
    mm: (i * SLOT_STEP) % 60,
    label: `${pad(Math.floor(i * SLOT_STEP / 60))}:${pad((i * SLOT_STEP) % 60)}`,
  }),
);

const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

/**
 * 过期档位只在选择"今天"时才有意义。
 * 整点不宽限也不提前：14:00 整选 14:00 仍然可选，14:07 起 14:00 才算过去。
 * 日期为空（还没选）时不禁用，否则用户连起点都定不下来。
 */
export function isSlotDisabled(slot: TimeSlot, date: string, now: Date): boolean {
  if (!date) return false;
  if (date !== dateKey(now.getFullYear(), now.getMonth(), now.getDate())) return false;
  return slot.hh * 60 + slot.mm < minutesOfDay(now);
}

/** 第一个还能选的档位；一天已经过完（23:50 之后）就退回最后一档 */
export function firstSelectableIndex(date: string, now: Date): number {
  const i = TIME_SLOTS.findIndex((s) => !isSlotDisabled(s, date, now));
  return i < 0 ? TIME_SLOTS.length - 1 : i;
}

/**
 * 打开时间列表时滚到哪一格。
 * 已选值还没过期就以它为准（高亮那行得看得见）；过期了或压根没值，
 * 就按钉钉的做法从第一个可选档位开始——列表顶部就是用户真能点的东西。
 */
export function scrollTargetIndex(selectedLabel: string, date: string, now: Date): number {
  const sel = TIME_SLOTS.find((s) => s.label === selectedLabel);
  if (sel && !isSlotDisabled(sel, date, now)) return sel.index;
  return firstSelectableIndex(date, now);
}

// ── 值的组合：规范值恒为 "YYYY-MM-DD HH:MM"，空串 = 无值 ──────────────

export function dateOf(value: string): string {
  return value.slice(0, 10);
}

export function timeOf(value: string): string {
  return value.length >= 16 ? value.slice(11, 16) : '';
}

/** 换日期保留时间半；空值补默认时间，否则后端按串比较会把 "YYYY-MM-DD" 排到当天所有日程之前 */
export function pickDate(value: string, day: string): string {
  return `${day} ${timeOf(value) || DEFAULT_TIME}`;
}

/** 换时间保留日期半；日期还空着就落到 fallbackDate（结束字段传开始的日期） */
export function pickTime(value: string, fallbackDate: string, time: string): string {
  return `${dateOf(value) || fallbackDate} ${time}`;
}

// ── 月历浮层 ────────────────────────────────────────────────────────

/** 月份翻页，month 为 0-11，跨年自动进位 */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/** "2026-10-15" → "2026年10月15日"；无值时退回今天，标题不能是空的 */
export function monthTitle(date: string, fallback: string): string {
  const [y, m, d] = (date || fallback).split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

/**
 * 浮层标题。停在选中日期那个月时给完整日期，翻页到别的月只给年月——
 * 标题写着 10 月 15 日、格子里却是 11 月，比不给日期更难读。
 */
export function headTitle(date: string, year: number, month: number, fallback: string): string {
  const cur = dateOf(date) ? date : fallback;
  if (cur.slice(0, 7) === `${year}-${pad(month + 1)}`) return monthTitle(cur, fallback);
  return `${year}年${month + 1}月`;
}

/** 浮层初始停在值所在的月份，无值停在当月 */
export function monthOfDate(date: string, fallback: string): { year: number; month: number } {
  const [y, m] = (date || fallback).split('-').map(Number);
  return { year: y, month: m - 1 };
}
