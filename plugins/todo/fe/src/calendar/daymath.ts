/**
 * 日程实例的纯日期算术（月/周/日三视图共用）
 *
 * 后端 `query_range` 返回的是**可能跨天的重叠区间**，按天拆开是渲染期的事，
 * 所以下面这几个函数只处理本地日期——本项目全程裸本地时间串，无时区。
 */
import { dateKey } from './grid';

/** 后端 query_range 的一条实例 */
export interface CalInstance {
  event_id: string;
  occ_key: string;
  content: string;
  /** "YYYY-MM-DD HH:MM" */
  start: string;
  end: string;
  all_day: boolean;
  is_virtual: boolean;
  completed: boolean;
  location: string | null;
  description: string | null;
  calendar_id: string | null;
  status: string;
  repeat_rule: string | null;
  alarms: number[];
}

/** "YYYY-MM-DD HH:MM" → 本地 Date（不能用 new Date(str)，那是按 UTC 解析补时串） */
export function parseLocal(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 把实例摊到它占据的每一天；跨天事件在月视图里要逐日出现 */
export function dayKeysOf(inst: CalInstance, maxDays = 400): string[] {
  const start = parseLocal(inst.start);
  const end = parseLocal(inst.end) ?? start;
  if (!start || !end) return [];
  // 结束时刻正好是 00:00（全天的尾格、或零点收工的定时事件）不占用次日
  const last =
    end.getHours() === 0 && end.getMinutes() === 0 && end.getTime() > start.getTime()
      ? new Date(end.getTime() - 60_000)
      : end;
  const keys: string[] = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  while (cur <= last && keys.length < maxDays) {
    keys.push(dateKey(cur.getFullYear(), cur.getMonth(), cur.getDate()));
    cur.setDate(cur.getDate() + 1);
  }
  return keys;
}

/** 实例按日分桶：key = "YYYY-MM-DD" */
export function bucketByDay(instances: CalInstance[]): Map<string, CalInstance[]> {
  const map = new Map<string, CalInstance[]>();
  for (const inst of instances) {
    for (const key of dayKeysOf(inst)) {
      const bucket = map.get(key);
      if (bucket) bucket.push(inst);
      else map.set(key, [inst]);
    }
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => (a.all_day === b.all_day ? a.start.localeCompare(b.start) : a.all_day ? -1 : 1));
  }
  return map;
}

/** 时间显示："09:30"，全天事件显示"全天" */
export function timeLabel(inst: CalInstance): string {
  if (inst.all_day) return '全天';
  return inst.start.slice(11, 16);
}

/** 月视图格子高度有限，标题超长要裁；用 Array.from 按码点切，emoji 不会被切成半个 */
export function ellipsis(text: string, max = 20): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}
