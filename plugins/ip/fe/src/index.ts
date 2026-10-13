/**
 * @ll/plugin-ip —— /ip 公网 IP 与归属查询（纯前端插件，backend.kind = "none"）
 *
 * 数据源 ipwho.is（免费 / 免密 / HTTPS）。不带参数查本机公网 IP，带参数查指定 IP。
 * 请求经宿主代理 `ctx.http`（`svc.http.send`），manifest 声明 `net:ipwho.is`。
 *
 * 沿用网络插件统一范式：query 不发请求，onsSelect 抓取 + 缓存 + refresh。
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

const PLUGIN_ID = 'ip';
const ctx = getPluginContext(PLUGIN_ID);
const CACHE_TTL_MS = 10 * 60_000;

function targetOf(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  const args = (input.args ?? []).filter(Boolean);
  return (sub ? [sub, ...args] : args).join('').trim();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function makeItem(
  id: string,
  title: string,
  description: string,
  badge: string,
  copy?: string,
  icon = '🌐',
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

interface IpWhoIs {
  ip?: string;
  success?: boolean;
  message?: string;
  type?: string;
  continent?: string;
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  postal?: string;
  calling_code?: string;
  capital?: string;
  connection?: { asn?: number; org?: string; isp?: string; domain?: string };
  timezone?: { id?: string; abbr?: string; utc?: string; is_dst?: boolean };
  flag?: { emoji?: string };
}

async function fetchIp(target: string): Promise<PanelItem[]> {
  const url = `https://ipwho.is/${encodeURIComponent(target)}`;
  const d = await ctx.http.json<IpWhoIs>(url);
  if (d.success === false) {
    throw new Error(d.message || '查询失败（服务返回 success=false）');
  }
  const ip = d.ip ?? target;
  const flag = d.flag?.emoji ? `${d.flag.emoji} ` : '';
  const placeParts = [d.city, d.region, d.country].filter(Boolean);
  const place = `${flag}${placeParts.join(', ')}`;
  const coord =
    typeof d.latitude === 'number' && typeof d.longitude === 'number'
      ? `${d.latitude}, ${d.longitude}`
      : '';

  const items: PanelItem[] = [];
  items.push(makeItem('ip', ip, d.type ? `类型 ${d.type}` : 'IP 地址', 'IP', ip, '🌐'));
  if (placeParts.length) {
    items.push(makeItem('place', place, `归属地（${d.continent ?? '—'}）`, '归属地', placeParts.join(', '), '📍'));
  }
  if (coord) items.push(makeItem('coord', coord, '经纬度', '坐标', coord, '🧭'));

  const conn = d.connection;
  if (conn) {
    const org = conn.org || conn.isp || '';
    if (org) items.push(makeItem('org', org, conn.isp && conn.isp !== org ? `ISP：${conn.isp}` : '运营商 / 组织', '运营商', org, '🏢'));
    if (typeof conn.asn === 'number') items.push(makeItem('asn', `AS${conn.asn}`, '自治系统号', 'ASN', `AS${conn.asn}`, '🔢'));
    if (conn.domain) items.push(makeItem('domain', conn.domain, '所属域', '域', conn.domain, '🔗'));
  }

  const tz = d.timezone;
  if (tz?.id) {
    const utc = tz.utc ? `UTC${tz.utc}` : '';
    items.push(makeItem('tz', `${tz.id} ${utc}`.trim(), '时区', '时区', tz.id, '🕒'));
  }
  if (d.postal) items.push(makeItem('postal', d.postal, '邮政编码', '邮编', d.postal, '📮'));
  if (d.calling_code) items.push(makeItem('calling', `+${d.calling_code}`, '国际区号', '区号', `+${d.calling_code}`, '📞'));
  if (d.capital) items.push(makeItem('capital', d.capital, '首都', '首都', d.capital, '🏛️'));

  return items;
}

/** 已抓取结果：键为查询目标（空串代表本机公网 IP） */
const cache = new Map<string, { at: number; items: PanelItem[] }>();

export const ipPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/ip',
  name: 'IP 查询',
  description: 'IP 归属查询：查公网 IP 的运营商、时区与坐标（数据源 ipwho.is）。不带参数查本机。',
  icon: '🌐',
  argsHint: '[IP 或域名]',
  examples: ['/ip', '/ip 8.8.8.8', '/ip example.com'],

  isAction: () => false,

  /**
   * 声明 300ms 防抖：壳层"停止输入即出结果"，用户不必再按一次回车。
   * 壳层对 query() 默认逐键调用且无防抖，直接联网会打爆接口；
   * 有了这个字段就能安全地把两段式范式简化掉。
   */
  queryDebounceMs: 300,

  async query(input: ParsedInput): Promise<PanelData> {
    const target = targetOf(input);
    const hit = cache.get(target);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { items: hit.items, emptyText: '无结果' };
    }
    const label = target || '本机公网 IP';
    try {
      const items = await fetchIp(target);
      cache.set(target, { at: Date.now(), items });
      return { items, emptyText: '无结果' };
    } catch (err) {
      return {
        items: [
          makeItem('retry', `查询 ${label} 失败：${errText(err)}`, '回车重试', '失败', undefined, '⚠️', { fetch: target }),
          makeItem('help', '/ip · /ip 8.8.8.8', '不带参数查本机公网 IP，带参数查指定 IPv4 / IPv6', '用法', undefined, '💡'),
        ],
        emptyText: '查询失败',
      };
    }
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const target = item.metadata?.fetch;
    if (typeof target === 'string') {
      try {
        const items = await fetchIp(target);
        cache.set(target, { at: Date.now(), items });
        return { refresh: true, toast: '查询完成' };
      } catch (err) {
        return { toast: `查询失败：${errText(err)}` };
      }
    }
    if (item.badge === '用法') {
      return { toast: '输入 IP 或直接回车查本机' };
    }
    const value = item.metadata?.value;
    if (typeof value === 'string' && value) {
      return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
    }
    return { toast: '该项无内容可复制' };
  },
};

export function setup(): void {
  pluginRegistry.register(ipPlugin);
}
