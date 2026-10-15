/**
 * 提醒卡片与只读详情的文案计算（纯函数，`now` 一律注入，好让 FE 测试台能断言）。
 *
 * 卡片是常驻的——用户不点「我知道了」它就一直挂着，所以所有措辞都按
 * "开窗那一刻算一次、之后不再变"来设计：倒计时写死会越看越假，
 * 于是只写"几分钟后 / 现在开始"这一档粗粒度的说法。
 */
import { WEEKDAY_LABELS, dateKey } from './calendar/grid';
import { parseLocal } from './calendar/daymath';
import { dateOf, timeOf } from './calendar/dtfield';

export interface ReminderPayload {
  /** 窗口实例键（事件 × 某一次 × 提前量），也是 unique_by 的值 */
  id: string;
  /** 事件 id，「查看详情」拿它去 get_event */
  event: string;
  content: string;
  /** 提前几分钟提醒；0 = 准时 */
  minutes: number;
  /** "YYYY-MM-DD HH:MM"，脏参一律降级成空串 */
  start: string;
  end: string;
  allDay: boolean;
  /** 日历名，空串 = 分类已删/未分类 */
  cal: string;
}

const SPAN_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const intOf = (raw: string | null): number => {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * 形状对上的串还要过一遍回环：`2026-13-99 00:00` 合正则，但 Date 会把它
 * 顺延成 2027-04-09，一路画到日历外面去。回环不相等就当脏参。
 * 详情窗口也从 URL 取同一批参数，脏参判定只能有一份。
 */
export function asSpan(v: string): string {
  if (!SPAN_RE.test(v)) return '';
  const d = parseLocal(v);
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  const back = `${dateKey(d.getFullYear(), d.getMonth(), d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return back === v ? v : '';
}

/** 缺参、脏参都退回"能画出一张空卡片"，而不是抛错让窗口白屏 */
export function parseReminder(search: string): ReminderPayload {
  const q = new URLSearchParams(search);
  const grab = (k: string): string => asSpan((q.get(k) ?? '').trim());
  return {
    id: q.get('id') ?? '',
    event: q.get('event') ?? '',
    content: (q.get('content') ?? '').trim(),
    minutes: intOf(q.get('minutes')),
    start: grab('start'),
    end: grab('end'),
    allDay: q.get('all_day') === '1',
    cal: (q.get('cal') ?? '').trim(),
  };
}

/** "2026-10-15" → "周四"；脏串按周一处理，不能返回 undefined 拼进文案 */
export function weekdayOf(day: string): string {
  const d = DAY_RE.test(day) ? parseLocal(day) : null;
  // grid.ts 的表头是光杆的"一二三…日"，卡片上要的是"周四"，前缀在这里补
  return `周${d ? WEEKDAY_LABELS[(d.getDay() + 6) % 7] : WEEKDAY_LABELS[0]}`;
}

/** "2026-10-15" → "10/15" */
export function shortDate(day: string): string {
  const [, m, dd] = day.split('-');
  return m && dd ? `${Number(m)}/${Number(dd)}` : day;
}

/**
 * 强调行：钉钉那句"5分钟后"。全天事项没有时刻（提醒锚在后端写死的 09:00），
 * 拿 00:00 去算会一路显示"已开始"，所以单独给一句"今天"。
 */
export function leadLabel(p: ReminderPayload, now: Date): string {
  if (p.allDay) return '今天';
  const start = p.start ? parseLocal(p.start) : null;
  if (!start) return p.minutes > 0 ? `提前 ${p.minutes} 分钟` : '现在开始';
  const mins = Math.ceil((start.getTime() - now.getTime()) / 60000);
  if (mins >= 120) return `${Math.round(mins / 60)} 小时后`;
  return mins >= 1 ? `${mins} 分钟后` : '现在开始';
}

/**
 * 时间区间行的四种形状（卡片与只读详情共用同一段文案逻辑）：
 *   同日      10/15 周四 16:00 - 16:30
 *   跨日      10/15 周四 16:00 - 10/16 周五 09:30
 *   只有开始  10/15 周四 16:00 起
 *   全天      10/15 周四 全天 / 10/15 周四 - 10/17 周六 全天
 */
export function formatSpan(start: string, end: string, allDay: boolean, now: Date): string {
  const startDay = dateOf(start) || dateKey(now.getFullYear(), now.getMonth(), now.getDate());
  const startTime = timeOf(start) || '00:00';
  const head = `${shortDate(startDay)} ${weekdayOf(startDay)}`;
  const endDay = dateOf(end);
  const endTime = timeOf(end);

  if (allDay) {
    if (!endDay || endDay === startDay) return `${head} 全天`;
    return `${head} - ${shortDate(endDay)} ${weekdayOf(endDay)} 全天`;
  }
  if (!end) return `${head} ${startTime} 起`;
  if (endDay === startDay) return `${head} ${startTime} - ${endTime}`;
  return `${head} ${startTime} - ${shortDate(endDay)} ${weekdayOf(endDay)} ${endTime}`;
}

export function spanLabel(p: ReminderPayload, now: Date): string {
  return formatSpan(p.start, p.end, p.allDay, now);
}

/** 「查看详情」只带定位需要的四个参数，正文走 get_event 现取 */
export function detailParams(p: ReminderPayload): Record<string, string> {
  const out: Record<string, string> = { event: p.event };
  if (p.start) out.start = p.start;
  if (p.end) out.end = p.end;
  if (p.allDay) out.all_day = '1';
  return out;
}

/**
 * 只读详情里的重复行：规则串是 `every:N{单位}`，直接甩给用户读不出来。
 * 历史手工输入的非规范串照 EventModal 的做法原样显示，别当空。
 */
export function repeatLabel(rule: string): string {
  const m = rule.trim().match(/^every:(\d+)(min|hour|day|week|month)$/);
  if (!m) return rule.trim() || '不重复';
  const n = Number(m[1]);
  const unit = { min: '分钟', hour: '小时', day: '天', week: '周', month: '个月' }[m[2]];
  return n === 1 ? `每${unit}` : `每 ${n} ${unit}`;
}

/** 提醒档：和 EventModal 的快捷档同一套措辞，只读态换了说法会让人以为是两个字段 */
export function alarmLabel(alarms: number[]): string {
  if (alarms.length === 0) return '无';
  return alarms
    .map((m) => (m === 0 ? '准时' : m >= 1440 ? `提前 ${m / 1440} 天` : `提前 ${m} 分钟`))
    .join('、');
}
