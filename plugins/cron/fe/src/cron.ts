/**
 * /cron 解析（WP-15：Python datetime → JS Date）
 *
 * 只解释表达式，不做调度。语义刻意与旧 Python 版逐行对齐：
 * 字段集合、通配/步长、日与周的 AND/OR 规则、未来 5 次触发。
 */

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

export const DOW_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export interface CronRun {
  /** `YYYY-MM-DD HH:MM` */
  text: string;
  /** `YYYY-MM-DD HH:MM:SS`（旧版复制值） */
  seconds: string;
  weekday: string;
}

export type CronResult =
  | { ok: true; expr: string; desc: string; runs: CronRun[] }
  | { ok: false; title: string; detail: string; expr?: string };

interface ParsedField {
  values: Set<number>;
  star: boolean;
}

function parseField(expr: string, lo: number, hi: number): ParsedField {
  const values = new Set<number>();
  const wildcard = expr === '*' || expr === '?';
  for (const raw of String(expr).split(',')) {
    let seg = raw.trim();
    if (!seg) continue;
    let step = 1;
    if (seg.includes('/')) {
      const [left, right] = seg.split('/', 2);
      seg = left;
      step = Number(right);
      if (!Number.isInteger(step) || step <= 0) throw new Error(`非法步长: ${right}`);
    }
    let start: number;
    let end: number;
    if (seg === '*' || seg === '?') {
      start = lo;
      end = hi;
    } else if (seg.includes('-')) {
      const [a, b] = seg.split('-', 2);
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(seg);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`非法字段: ${raw}`);
    }
    for (let v = start; v <= end; v += step) {
      if (v >= lo && v <= hi) values.add(v);
    }
  }
  return { values, star: wildcard };
}

function describeField(expr: string, unit: string, names?: string[]): string {
  if (expr === '*' || expr === '?') return `每${unit}`;
  const parts: string[] = [];
  for (const raw of String(expr).split(',')) {
    let seg = raw.trim();
    let step: number | null = null;
    if (seg.includes('/')) {
      const [left, right] = seg.split('/', 2);
      seg = left;
      step = Number(right);
    }
    if (seg === '*' || seg === '?') {
      parts.push(`每 ${step} ${unit}`);
      continue;
    }
    let label: string;
    if (seg.includes('-')) {
      const [a, b] = seg.split('-', 2);
      label = names
        ? `${names[Number(a) % 7]}–${names[Number(b) % 7]}`
        : `${a}–${b}`;
    } else if (names) {
      label = names[Number(seg) % 7];
    } else {
      label = String(seg);
    }
    if (step) label += `（步长 ${step}）`;
    parts.push(names ? label : `${label}${unit}`);
  }
  return parts.join('、');
}

const pad = (n: number) => String(n).padStart(2, '0');

function nextRuns(
  minutes: Set<number>,
  hours: Set<number>,
  doms: Set<number>,
  months: Set<number>,
  dows: Set<number>,
  domStar: boolean,
  dowStar: boolean,
  now: Date,
  n = 5,
): CronRun[] {
  const starts = new Date(now);
  starts.setSeconds(0, 0);
  starts.setMinutes(starts.getMinutes() + 1);

  const out: CronRun[] = [];
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const hh = [...hours].sort((a, b) => a - b);
  const mm = [...minutes].sort((a, b) => a - b);

  for (let i = 0; i < 1500 && out.length < n; i += 1) {
    if (months.has(day.getMonth() + 1)) {
      const dayOk = doms.has(day.getDate());
      const dowOk = dows.has(day.getDay());
      const ok = domStar && dowStar ? true : domStar ? dowOk : dowStar ? dayOk : dayOk || dowOk;
      if (ok) {
        for (const hour of hh) {
          for (const minute of mm) {
            const dt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
            if (dt.getTime() >= starts.getTime() && out.length < n) {
              out.push({
                text: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
                seconds: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:00`,
                weekday: DOW_NAMES[dt.getDay()],
              });
            }
          }
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/** 解析表达式；错误通过 CronResult 返回，不抛到壳层 */
export function evaluateCron(raw: string, now: Date = new Date()): CronResult {
  const text = raw.trim();
  if (!text) {
    return { ok: false, title: '输入 5 段 cron 表达式', detail: '分 时 日 月 周，如 0 9 * * 1-5' };
  }

  const first = text.split(/\s+/)[0]?.toLowerCase() ?? '';
  const expr = text.startsWith('@') ? (MACROS[first] ?? text) : text;
  const fields = expr.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    return {
      ok: false,
      title: '字段数不对',
      detail: `需要 5 段，当前 ${fields.length} 段`,
    };
  }

  let minutes: ParsedField;
  let hours: ParsedField;
  let doms: ParsedField;
  let months: ParsedField;
  let dows: ParsedField;
  try {
    minutes = parseField(fields[0], 0, 59);
    hours = parseField(fields[1], 0, 23);
    doms = parseField(fields[2], 1, 31);
    months = parseField(fields[3], 1, 12);
    dows = parseField(fields[4].replace(/(?<!\d)7(?!\d)/g, '0'), 0, 6);
  } catch (err) {
    return {
      ok: false,
      title: '字段解析失败',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (
    minutes.values.size === 0 ||
    hours.values.size === 0 ||
    doms.values.size === 0 ||
    months.values.size === 0 ||
    dows.values.size === 0
  ) {
    return { ok: false, title: '表达式无有效取值', detail: expr, expr };
  }

  const desc = [
    describeField(fields[0], '分钟'),
    describeField(fields[1], '小时'),
    describeField(fields[2], '日'),
    describeField(fields[3], '月'),
    describeField(fields[4], '周', DOW_NAMES),
  ].join(' · ');

  return {
    ok: true,
    expr,
    desc,
    runs: nextRuns(
      minutes.values,
      hours.values,
      doms.values,
      months.values,
      dows.values,
      doms.star,
      dows.star,
      now,
    ),
  };
}
