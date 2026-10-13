/**
 * @ll/plugin-fx —— /fx 汇率换算（纯前端插件，backend.kind = "none"）
 *
 * 数据源 open.er-api.com（免费 / 免密，基于 exchangerate-api，每日更新）。
 * 请求经宿主代理 `ctx.http`（`svc.http.send`），manifest 需声明 `net:open.er-api.com`。
 *
 * 与 /weather 同一范式：query 不发请求，只在输入时给「查询」项；抓取在 onSelect，
 * 结果按「金额|基准|目标」缓存 5 分钟后 refresh 刷新面板。
 */
import {
  getPluginContext,
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';

const PLUGIN_ID = 'fx';
const ctx = getPluginContext(PLUGIN_ID);
const CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_BASE = 'USD';

/** 列出模式下展示的主要货币（不含基准本身） */
const COMMON = ['CNY', 'EUR', 'JPY', 'GBP', 'HKD', 'KRW', 'CAD', 'AUD', 'CHF', 'SGD', 'THB', 'INR', 'TWD'];

/** 货币代码 → 中文名（仅用于展示，取不到时回退代码本身） */
const NAME: Record<string, string> = {
  USD: '美元',
  CNY: '人民币',
  EUR: '欧元',
  JPY: '日元',
  GBP: '英镑',
  HKD: '港币',
  KRW: '韩元',
  CAD: '加元',
  AUD: '澳元',
  CHF: '瑞郎',
  SGD: '新加坡元',
  THB: '泰铢',
  INR: '印度卢比',
  RUB: '卢布',
  TWD: '新台币',
  NZD: '新西兰元',
  MYR: '马来西亚林吉特',
  PHP: '菲律宾比索',
  VND: '越南盾',
  IDR: '印尼盾',
  BRL: '雷亚尔',
  ZAR: '南非兰特',
  SAR: '沙特里亚尔',
  AED: '迪拉姆',
  TRY: '土耳其里拉',
};

function cur(code: string): string {
  const name = NAME[code];
  return name ? `${code} ${name}` : code;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function trimZero(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** 自适应精度数字格式化（大数带千分位，小数保留有效位，去掉尾随 0） */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return trimZero(n.toFixed(4));
  return trimZero(n.toFixed(6));
}

function makeItem(
  id: string,
  title: string,
  description: string,
  badge: string,
  copy?: string,
  icon = '💱',
  extra?: Record<string, unknown>,
): PanelItem {
  return {
    id: `${PLUGIN_ID}:${id}`,
    title,
    description,
    badge,
    icon,
    metadata: { ...(copy === undefined ? {} : { value: copy }), ...(extra ?? {}) },
  };
}

interface ErApiResponse {
  result?: string;
  'error-type'?: string;
  base_code?: string;
  time_last_update_utc?: string;
  time_next_update_utc?: string;
  rates?: Record<string, number>;
}

interface FxQuery {
  amount: number;
  base: string;
  target: string | null;
}

const CODE_RE = /^[A-Za-z]{3}$/;
const NUM_RE = /^\d+(?:\.\d+)?$/;

/** 解析输入：[/fx] [/fx usd] [/fx usd cny] [/fx 100 usd cny]（大小写不敏感） */
function parseQuery(input: ParsedInput): FxQuery | null {
  const sub = (input.subcommand ?? '').trim();
  const raw = sub ? [sub, ...(input.args ?? []).filter(Boolean)] : (input.args ?? []).filter(Boolean);
  if (raw.length === 0) return { amount: 1, base: DEFAULT_BASE, target: null };

  const tokens = [...raw];
  let amount = 1;
  if (NUM_RE.test(tokens[0])) {
    amount = Number.parseFloat(tokens.shift() as string);
  }
  if (tokens.length === 0) return { amount, base: DEFAULT_BASE, target: null };
  if (!CODE_RE.test(tokens[0])) return null;
  const base = tokens[0].toUpperCase();
  if (tokens.length === 1) return { amount, base, target: null };
  if (!CODE_RE.test(tokens[1])) return null;
  return { amount, base, target: tokens[1].toUpperCase() };
}

/** 缓存键：同一查询才复用结果 */
function keyOf(q: FxQuery): string {
  return `${q.amount}|${q.base}|${q.target ?? ''}`;
}

async function fetchFx(q: FxQuery): Promise<PanelItem[]> {
  const url = `https://open.er-api.com/v6/latest/${q.base}`;
  const data = await ctx.http.json<ErApiResponse>(url);
  if (data.result && data.result !== 'success') {
    throw new Error(data['error-type'] ?? `服务返回 ${data.result}`);
  }
  const rates = data.rates;
  if (!rates || typeof rates.CNY !== 'number') throw new Error('响应缺少 rates');
  if (rates[q.base] !== 1) {
    // 少数服务不回填基准自身，补一个便于展示
    rates[q.base] = 1;
  }
  // 服务返回的 rates 是「1 基准 = ? 目标」
  const updated = data.time_last_update_utc ?? '';
  const items: PanelItem[] = [];

  if (q.target) {
    const rate = rates[q.target];
    if (typeof rate !== 'number') {
      return [
        makeItem('err', `不支持的货币：${q.target}`, `服务未提供 ${q.target} 的汇率`, '错误', undefined, '❌'),
      ];
    }
    const converted = q.amount * rate;
    const oneBaseInTarget = fmt(rate);
    items.push(
      makeItem(
        'conv',
        `${fmt(q.amount)} ${q.base} = ${fmt(converted)} ${q.target}`,
        `${cur(q.base)} → ${cur(q.target)}`,
        '换算',
        `${fmt(q.amount)} ${q.base} = ${fmt(converted)} ${q.target}`,
        '💱',
      ),
    );
    items.push(makeItem('rate', `1 ${q.base} = ${oneBaseInTarget} ${q.target}`, '当前汇率', '汇率', oneBaseInTarget, '📈'));
    items.push(
      makeItem(
        'inv',
        `1 ${q.target} = ${fmt(1 / rate)} ${q.base}`,
        '反向汇率',
        '反向',
        fmt(1 / rate),
        '📉',
      ),
    );
    items.push(makeItem('amount', `${fmt(converted)}`, `${q.target} 金额（仅数字）`, '结果', fmt(converted), '🔢'));
    if (updated) items.push(makeItem('updated', `更新时间 ${updated}`, '数据源 open.er-api.com', '时间'));
    return items;
  }

  // 列出模式：基准 → 主要货币
  items.push(
    makeItem('base', `1 ${cur(q.base)}`, '基准货币，下列为可换算的主要货币', '基准', `1 ${q.base}`, '🏦'),
  );
  for (const code of COMMON) {
    if (code === q.base) continue;
    const rate = rates[code];
    if (typeof rate !== 'number') continue;
    items.push(
      makeItem(
        code,
        `1 ${q.base} = ${fmt(rate)} ${code}`,
        cur(code),
        code,
        fmt(rate),
        '💱',
      ),
    );
  }
  if (updated) items.push(makeItem('updated', `更新时间 ${updated}`, '数据源 open.er-api.com', '时间'));
  return items;
}

/** 已抓取结果 */
const cache = new Map<string, { at: number; items: PanelItem[] }>();

export const fxPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/fx',
  name: '汇率换算',
  description:
    '汇率换算：/fx 100 usd cny 精确换算，/fx usd cny 只看汇率，/fx usd 列出主要货币。数据源 open.er-api.com（每日更新）。',
  icon: '💱',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const q = parseQuery(input);
    if (!q) {
      return {
        items: [
          makeItem('help', '/fx 100 usd cny', '格式：/fx [金额] <基准货币> [目标货币]（3 位代码）', '用法', undefined, '💡'),
          makeItem('help2', '/fx usd · /fx 500 jpy cny', '省略目标货币则列出主要货币汇率', '用法', undefined, '💡'),
        ],
        emptyText: '输入货币代码',
      };
    }

    const key = keyOf(q);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { items: hit.items, emptyText: '无结果' };
    }

    const label = q.target ? `${fmt(q.amount)} ${q.base} → ${q.target}` : `${q.base} 主要货币汇率`;
    return {
      items: [
        makeItem('fetch', `查询 ${label}`, '回车联网获取（open.er-api.com）', '查询', undefined, '🔎', { fetch: key }),
        makeItem('help', '/fx 100 usd cny', '格式：/fx [金额] <基准货币> [目标货币]', '用法', undefined, '💡'),
      ],
      emptyText: '回车查询',
    };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const key = item.metadata?.fetch;
    if (typeof key === 'string') {
      const q = parseQueryFromKey(key);
      if (!q) return { toast: '查询参数已失效，请重新输入' };
      try {
        const items = await fetchFx(q);
        cache.set(key, { at: Date.now(), items });
        return { refresh: true, toast: '汇率已更新' };
      } catch (err) {
        return { toast: `查询失败：${errText(err)}` };
      }
    }
    if (item.badge === '用法') {
      return { toast: '格式：/fx [金额] <基准货币> [目标货币]' };
    }
    const value = item.metadata?.value;
    if (typeof value === 'string' && value) {
      return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
    }
    return { toast: '该项无内容可复制' };
  },
};

/** 由缓存键还原查询参数（键格式：amount|base|target） */
function parseQueryFromKey(key: string): FxQuery | null {
  const [amountStr, base, target] = key.split('|');
  const amount = Number.parseFloat(amountStr);
  if (!Number.isFinite(amount) || !base) return null;
  return { amount, base, target: target || null };
}

export function setup(): void {
  pluginRegistry.register(fxPlugin);
}
