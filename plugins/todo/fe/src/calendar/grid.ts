/**
 * 月历网格的纯几何计算（DateTimePicker 的下拉日历与日程月视图共用，单一来源）
 * 约定：周一为一周起点。
 */

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

/** 该月 1 号前面要补几个空格子（周一开头 → 周日返回 6） */
export function firstWeekday(year: number, month: number): number {
  return (new Date(year, month, 1).getDay() + 6) % 7;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** 一格：`out` 表示属于邻月（灰显，但照常显示当天的条目） */
export interface MonthCell {
  key: string; // "YYYY-MM-DD"
  day: number;
  out: boolean;
}

/**
 * 6×7 固定行数：行数不固定的话，条目多的月份会把整张网格撑高、
 * 下面的日期一路上下跳，视觉上完全读不出来。
 * 邻月格子照钉钉的排法显示真实日号并灰显——后端 query_range 的区间
 * 本来就含这些补齐天，只留空会让跨月的安排凭空消失。
 * 返回对象而非裸 number，是为了能安全地喂给 Solid 的 `<For>`——
 * 它按引用身份建 key，一排重复的值会撞成"重复键"。
 */
export function monthCells(year: number, month: number): MonthCell[] {
  const lead = firstWeekday(year, month);
  const total = daysInMonth(year, month);
  const rows = Math.max(6, Math.ceil((lead + total) / 7));
  const cells: MonthCell[] = [];
  for (let i = 0; i < rows * 7; i++) {
    const d = new Date(year, month, 1 - lead + i);
    cells.push({
      key: dateKey(d.getFullYear(), d.getMonth(), d.getDate()),
      day: d.getDate(),
      out: d.getMonth() !== month,
    });
  }
  return cells;
}

/** 本地日期的存储串 "YYYY-MM-DD"（不能用 toISOString，那是 UTC） */
export function dateKey(year: number, month: number, day: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${year}-${p(month + 1)}-${p(day)}`;
}

export function todayKey(): string {
  const now = new Date();
  return dateKey(now.getFullYear(), now.getMonth(), now.getDate());
}
