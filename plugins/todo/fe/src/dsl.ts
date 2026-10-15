/**
 * /cal 指令语法（纯函数）
 *
 * 单列成 .ts 而不是塞进 todoPlugin.ts 的原因：这条语法链是最容易静默错位的
 * 地方（`10-15 14:00-15:30` 到底是 10 月 15 日还是"减 15 分钟"？），
 * 而 `.tsx` 在 FE 测试脚手架里加载不了，纯函数才能被 tools/test-fe-plugins.mjs 钉住。
 *
 * 支持的写法：
 *   /cal new "评审" 10-15 14:00-15:30 every:weekly --al 10,30 --where 会议室 --cal 工作 --free
 *
 * 时间一律输出成后端认识的裸本地串（`YYYY-MM-DD HH:MM` 或 `HH:MM`），
 * 插件不做任何时区换算——整个项目存的就是本地裸串。
 */

/** `--al` 的上限与后端 MAX_ALARMS/MAX_ALARM_MINUTES 对齐（超出的后端会截，这里只挡明显垃圾） */
const MAX_ALARMS = 8;
const MAX_ALARM_MINUTES = 30 * 24 * 60;

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DATE_LONG_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
// 短日期必须整串就是"月-日"：锚死两端，`10-15-16` 这类含糊写法才会落回标题而不是被当成语法
const DATE_SHORT_RE = /^(\d{1,2})-(\d{1,2})$/;
// 区间的两段都必须是钟点（`时:分`），否则 `\d{1,2}-\d{1,2}-\d{1,2}` 会把 `2026-10-15`
// 误读成"10 月 15 日到 16 日"，用户的绝对日期凭空消失
const SPAN_RE = /^((?:[01]?\d|2[0-3]):[0-5]\d)[~～-]((?:[01]?\d|2[0-3]):[0-5]\d)$/;
const INTERVAL_RE =
  /^(?:every|repeat):(\d{1,3})(min(?:ute)?s?|h(?:our)?s?|d(?:ay)?s?|w(?:eek)?s?|mo(?:nth)?s?|y(?:ear)?s?|m)$/i;
const REPEAT_KEYWORDS = ['daily', 'weekly', 'monthly', 'yearly', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface CalDraft {
  /** 剔除全部语法后的裸词，即日程标题 */
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  /** 提前多少分钟提醒，空数组 = 不提醒 */
  alarms: number[];
  location: string;
  description: string;
  /** 分类日历的**名字**（id 要拿列表比对后才填得出来，那一步在插件里做） */
  calendarName: string;
  /** '' = 交后端按默认（busy）处理 */
  status: string;
  repeatRule: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * `M-D` 省略年份：默认今年，但已经过去的（早于昨天）按明年算——
 * 12-30 输入 `1-5` 要的是明天的 1 月 5 日，而不是快一年前那天；
 * 留"昨天"这一天是为了允许补记刚发生的安排。
 */
export function resolveDate(month: number, day: number, today: Date): string {
  const y = today.getFullYear();
  const cand = new Date(y, month - 1, day);
  const floor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  floor.setDate(floor.getDate() - 1);
  const year = cand < floor ? y + 1 : y;
  return `${year}-${pad(month)}-${pad(day)}`;
}

const normTime = (t: string) => {
  const [h, m] = t.split(':');
  return `${pad(Number(h))}:${pad(Number(m))}`;
};

/** `--al 10,30` → [10,30]；非法项丢掉而不是报错，用户手滑打个空格不该整条指令失败 */
function parseAlarms(raw: string): number[] {
  const out: number[] = [];
  for (const part of raw.split(/[,，]/)) {
    const n = Number(part.trim());
    if (Number.isFinite(n) && n >= 0 && n <= MAX_ALARM_MINUTES) out.push(Math.round(n));
  }
  out.sort((a, b) => a - b);
  return [...new Set(out)].slice(0, MAX_ALARMS);
}

/** 取下一个 flag 的值；下一个 token 是 flag 或不存在时返回空（`--where` 后面直接结束） */
function takeValue(tokens: string[], i: number): string {
  const next = tokens[i + 1];
  if (next === undefined || next.startsWith('-')) return '';
  return next;
}

export function parseCalArgs(tokens: string[], today: Date = new Date()): CalDraft {
  const draft: CalDraft = {
    title: '',
    startAt: '',
    endAt: '',
    allDay: false,
    alarms: [],
    location: '',
    description: '',
    calendarName: '',
    status: '',
    repeatRule: '',
  };
  const words: string[] = [];
  // 日期与时间分开出现时（`10-15 14:00`）才需要它；一旦拼上就按带日期的绝对时间处理
  let datePart = '';
  let alarmsGiven = false;

  const setStart = (time: string) => {
    draft.startAt = datePart ? `${datePart} ${time}` : time;
  };

  for (let i = 0; i < tokens.length; i++) {
    const arg = tokens[i];
    const lower = arg.toLowerCase();

    if (arg.startsWith('--')) {
      const name = lower.slice(2);
      if (name === 'al' || name === 'alarm' || name === 'remind') {
        const rawValue = takeValue(tokens, i);
        if (rawValue) i++;
        alarmsGiven = true;
        // `--al none` 是显式"不要提醒"——不写这条的话，用户没法在残留时间上关掉提醒
        if (/^(none|no|off)$/i.test(rawValue)) {
          draft.alarms = [];
        } else {
          const vals = parseAlarms(rawValue);
          if (vals.length) draft.alarms = [...draft.alarms, ...vals];
        }
      } else if (name === 'where' || name === 'loc') {
        draft.location = takeValue(tokens, i);
        if (draft.location) i++;
      } else if (name === 'note' || name === 'desc') {
        draft.description = takeValue(tokens, i);
        if (draft.description) i++;
      } else if (name === 'cal' || name === 'calendar') {
        draft.calendarName = takeValue(tokens, i);
        if (draft.calendarName) i++;
      } else if (name === 'all-day' || name === 'allday') {
        draft.allDay = true;
      } else if (name === 'free') {
        draft.status = 'free';
      } else if (name === 'busy') {
        draft.status = 'busy';
      }
      // 未知 flag 静默吞掉：补全或从别处粘来的多余参数不该污染标题
      continue;
    }

    if (lower === '全天') {
      draft.allDay = true;
      continue;
    }

    const interval = arg.match(INTERVAL_RE);
    if (interval) {
      const unitRaw = interval[2].toLowerCase();
      const unit = unitRaw.startsWith('min')
        ? 'min'
        : unitRaw.startsWith('h')
          ? 'hour'
          : unitRaw.startsWith('d')
            ? 'day'
            : unitRaw.startsWith('w')
              ? 'week'
              : unitRaw.startsWith('y')
                ? 'year'
                : 'month';
      draft.repeatRule = `every:${interval[1]}${unit}`;
      continue;
    }

    if (REPEAT_KEYWORDS.includes(lower)) {
      const map: Record<string, string> = {
        daily: 'every:1day',
        weekly: 'every:1week',
        monthly: 'every:1month',
        // 后端有 year 步长（按月 12 倍推进），这里不必用 12month 绕
        yearly: 'every:1year',
      };
      draft.repeatRule = map[lower] ?? draft.repeatRule;
      continue;
    }

    const long = arg.match(DATE_LONG_RE);
    if (long) {
      datePart = `${long[1]}-${pad(Number(long[2]))}-${pad(Number(long[3]))}`;
      continue;
    }

    const short = arg.match(DATE_SHORT_RE);
    if (short) {
      const m = Number(short[1]);
      const d = Number(short[2]);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        datePart = resolveDate(m, d, today);
        continue;
      }
    }

    // 区间 `14:00-15:30`（也接受 `14:00~15:30`）
    const span = arg.match(SPAN_RE);
    if (span) {
      setStart(normTime(span[1]));
      draft.endAt = datePart ? `${datePart} ${normTime(span[2])}` : normTime(span[2]);
      continue;
    }

    if (TIME_RE.test(arg)) {
      setStart(normTime(arg));
      continue;
    }

    words.push(arg);
  }

  draft.title = words.join(' ').trim();
  // 只给了日期没给钟点 → 用户要的是"那一天"，不是 00:00 的一小时定时
  if (datePart && !draft.startAt) {
    draft.allDay = true;
    draft.startAt = datePart;
  }
  if (draft.allDay) {
    // DSL 只能表达"这一天"：全天没有钟点，跨天区间留给编辑器改
    draft.startAt = draft.startAt.slice(0, 10);
    draft.endAt = draft.startAt;
  }
  if (!draft.allDay && !draft.startAt) draft.endAt = '';
  // 老用法 `/todo new "喝水" 15:00` 到点就弹（后端 create 也是补 0 分钟），
  // 升级后不给 --al 也必须照旧提醒，否则"提醒不见了"是回归而不是简化。
  if (!alarmsGiven && draft.startAt && !draft.allDay) draft.alarms = [0];
  draft.alarms = [...draft.alarms].sort((a, b) => b - a);
  return draft;
}

/** 重复规则存储格式（every:N{min|hour|day|week|month|year}）→ 中文标签 */
export function repeatLabel(rule?: string | null): string {
  if (!rule) return '';
  const m = rule.match(/^every:(\d+)(min|hour|day|week|month|year)$/);
  if (!m) return rule;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const single: Record<string, string> = {
    day: '每天',
    week: '每周',
    month: '每月',
    year: '每年',
    hour: '每小时',
    min: '每分钟',
  };
  if (n === 1 && single[unit]) return single[unit];
  const units: Record<string, string> = {
    min: '分钟',
    hour: '小时',
    day: '天',
    week: '周',
    month: '个月',
    year: '年',
  };
  return `每 ${n} ${units[unit] ?? unit}`;
}

/**
 * `--cal 工作` → 分类 id：先精确名，再前缀，都不中就回默认。
 * 回默认而不是报错，是因为胶囊已经告诉用户"📁 工作"，落库再炸一次没意义。
 */
export function matchCalendarId(name: string, calendars: { id: string; name: string }[]): string {
  const want = name.trim().toLowerCase();
  if (!want) return '';
  const exact = calendars.find((c) => c.name.toLowerCase() === want);
  if (exact) return exact.id;
  const prefix = calendars.find((c) => c.name.toLowerCase().startsWith(want));
  return prefix?.id ?? '';
}

const dateShort = (at: string) => (at.length > 10 ? at.slice(5, 10) : at.length === 10 ? at.slice(5) : '');

/** 胶囊文案：`🗓 10-15 14:00–15:30 · 📍会议室 · ⏰ -10/-30min · 🔁 每周` */
export function describeDraft(draft: CalDraft): string {
  const bits: string[] = [];
  if (draft.allDay) {
    const from = dateShort(draft.startAt);
    const to = dateShort(draft.endAt);
    bits.push(`🗓 ${from ? (to && to !== from ? `${from}→${to} 全天` : `${from} 全天`) : '全天'}`);
  } else if (draft.startAt) {
    const from = `${dateShort(draft.startAt)} ${draft.startAt.slice(-5)}`.trim();
    const to = draft.endAt ? draft.endAt.slice(-5) : '';
    bits.push(`🗓 ${from}${to ? `–${to}` : ''}`);
  } else {
    bits.push('🗓 未定时');
  }
  if (draft.location) bits.push(`📍${draft.location}`);
  if (draft.calendarName) bits.push(`📁${draft.calendarName}`);
  if (draft.alarms.length) bits.push(`⏰ ${draft.alarms.map((m) => `-${m}min`).join('/')}`);
  const repeatText = repeatLabel(draft.repeatRule);
  if (repeatText) bits.push(`🔁 ${repeatText}`);
  if (draft.status === 'free') bits.push('🟢 空闲');
  return bits.join(' · ');
}
