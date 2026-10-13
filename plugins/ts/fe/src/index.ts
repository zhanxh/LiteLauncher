/**
 * @ll/plugin-ts —— /ts 时间戳转换（纯前端插件，backend.kind = "none"）
 *
 * 无后端：日期运算全部用标准 Date，时区取运行环境的本地时区。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';

const PLUGIN_ID = 'ts';
const WEEKDAYS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** 本地时间 `YYYY-MM-DD HH:mm:ss` */
function fmtLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** UTC 时间 `YYYY-MM-DD HH:mm:ss` */
function fmtUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** ISO 8601（含本地时区偏移，如 +08:00） */
function fmtIso(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hours}:${minutes}`;
}

/** 相对当前时间：`前 3.2 小时` / `后 12 分钟` */
function relative(target: number, now: number): string {
  const diff = now - target;
  const seconds = Math.abs(diff) / 1000;
  let unit: string;
  if (seconds < 60) unit = `${seconds.toFixed(0)} 秒`;
  else if (seconds < 3600) unit = `${(seconds / 60).toFixed(1)} 分钟`;
  else if (seconds < 86400) unit = `${(seconds / 3600).toFixed(1)} 小时`;
  else unit = `${(seconds / 86400).toFixed(1)} 天`;
  return `${diff >= 0 ? '前' : '后'} ${unit}`;
}

/** 依数量级自动识别时间戳单位（秒 / 毫秒 / 微秒 / 纳秒） */
function detectDivisor(n: number): { div: number; label: string } {
  const abs = Math.abs(n);
  if (abs < 1e11) return { div: 1, label: '秒' };
  if (abs < 1e14) return { div: 1e3, label: '毫秒' };
  if (abs < 1e17) return { div: 1e6, label: '微秒' };
  return { div: 1e9, label: '纳秒' };
}

function makeItem(id: string, title: string, description: string, badge: string, copy?: string): PanelItem {
  return {
    id: `${PLUGIN_ID}:${id}`,
    title,
    description,
    badge,
    icon: '🕒',
    metadata: copy === undefined ? {} : { value: copy },
  };
}

export const tsPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/ts',
  name: '时间戳转换',
  description:
    '时间戳转换：/ts 显示当前时间与时间戳；/ts 1700000000 时间戳→日期（自动识别秒/毫秒/微秒/纳秒）；/ts 2026-10-13 14:30 日期→时间戳。回车复制。',
  icon: '🕒',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const parts = [(input.subcommand ?? '').trim(), ...(input.args ?? [])].filter(Boolean);
    const now = Date.now();

    // 无参数 → 当前时间面板
    if (parts.length === 0) {
      const d = new Date(now);
      return {
        items: [
          makeItem('local', fmtLocal(d), '本地时间', '本地', fmtLocal(d)),
          makeItem('utc', fmtUtc(d), 'UTC 时间', 'UTC', fmtUtc(d)),
          makeItem('iso', fmtIso(d), 'ISO 8601（含时区）', 'ISO', fmtIso(d)),
          makeItem('week', WEEKDAYS[(d.getDay() + 6) % 7], '星期', '星期'),
          makeItem('s', String(Math.floor(now / 1000)), 'Unix 时间戳（秒）', '秒', String(Math.floor(now / 1000))),
          makeItem('ms', String(now), 'Unix 时间戳（毫秒）', '毫秒', String(now)),
        ],
        emptyText: '当前时间',
      };
    }

    // 首个参数为 now/ms/s 时可指定时间戳单位，其余情况自动识别
    let forceDiv: number | undefined;
    let text = parts.join(' ');
    if (parts[0] === 'now') {
      const d = new Date(now);
      return { items: [makeItem('now', fmtLocal(d), '当前本地时间', '本地', fmtLocal(d))], emptyText: '当前时间' };
    }
    if (parts[0] === 'ms' || parts[0] === 's') {
      forceDiv = parts[0] === 'ms' ? 1e3 : 1;
      text = parts.slice(1).join(' ').trim();
    }

    // 纯数字 → 时间戳转日期
    if (/^-?\d+$/.test(text)) {
      const raw = Number.parseInt(text, 10);
      const { div, label } = forceDiv !== undefined ? { div: forceDiv, label: forceDiv === 1 ? '秒' : '毫秒' } : detectDivisor(raw);
      const d = new Date(raw / div * 1e3);
      if (Number.isNaN(d.getTime())) {
        return { items: [makeItem('err', '时间戳超出可表示范围', text, '错误')], emptyText: '无法解析' };
      }
      const epochSeconds = Math.floor(d.getTime() / 1000);
      return {
        items: [
          makeItem('local', fmtLocal(d), `本地时间（按${label}解释）`, '本地', fmtLocal(d)),
          makeItem('utc', fmtUtc(d), 'UTC 时间', 'UTC', fmtUtc(d)),
          makeItem('iso', fmtIso(d), 'ISO 8601（含时区）', 'ISO', fmtIso(d)),
          makeItem('week', WEEKDAYS[(d.getDay() + 6) % 7], '星期', '星期'),
          makeItem('s', String(epochSeconds), 'Unix 时间戳（秒）', '秒', String(epochSeconds)),
          makeItem('ms', String(d.getTime()), 'Unix 时间戳（毫秒）', '毫秒', String(d.getTime())),
          makeItem('rel', relative(d.getTime(), now), '相对当前时间', '相对'),
        ],
        emptyText: '无法解析',
      };
    }

    // 其余视为日期文本（`2026-10-13 14:30` 按本地时区解释）
    const parsed = new Date(text.replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) {
      return {
        items: [
          makeItem('err', `无法识别的输入：${text}`, '支持时间戳（秒/毫秒/微秒/纳秒）或 2026-10-13 14:30 形式', '错误'),
        ],
        emptyText: '无法解析',
      };
    }
    const epochSeconds = Math.floor(parsed.getTime() / 1000);
    return {
      items: [
        makeItem('s', String(epochSeconds), 'Unix 时间戳（秒）', '秒', String(epochSeconds)),
        makeItem('ms', String(parsed.getTime()), 'Unix 时间戳（毫秒）', '毫秒', String(parsed.getTime())),
        makeItem('local', fmtLocal(parsed), '本地时间', '本地', fmtLocal(parsed)),
        makeItem('utc', fmtUtc(parsed), 'UTC 时间', 'UTC', fmtUtc(parsed)),
        makeItem('week', WEEKDAYS[(parsed.getDay() + 6) % 7], '星期', '星期'),
        makeItem('rel', relative(parsed.getTime(), now), '相对当前时间', '相对'),
      ],
      emptyText: '无法解析',
    };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
  },
};

export function setup(): void {
  pluginRegistry.register(tsPlugin);
}
