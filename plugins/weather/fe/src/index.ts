/**
 * @ll/plugin-weather —— /weather 天气查询（纯前端插件，backend.kind = "none"）
 *
 * 数据源 wttr.in（免费 / 免密 / 返回 JSON）。请求经宿主代理 `ctx.http`（即 `svc.http.send`），
 * 因此不受 webview 的 CORS 限制；manifest 需声明 `net:wttr.in`。
 *
 * 关键设计：壳层对 `query()` 是**逐键调用且无防抖**的，所以绝不在 query 里发请求——
 * 输入时只渲染一个「查询」项，真正的抓取发生在 onSelect（用户显式回车），
 * 结果按输入缓存 5 分钟，抓取完成后返回 `refresh` 让面板就地刷新。
 * 这套「显式触发 + 缓存 + 刷新」是全部网络类插件的统一范式。
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

const PLUGIN_ID = 'weather';
const ctx = getPluginContext(PLUGIN_ID);
const CACHE_TTL_MS = 5 * 60_000;

/** 还原查询位置：`/weather new york` → "new york"；空输入 → ""（wttr.in 按本机 IP 定位） */
function locationOf(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  const args = (input.args ?? []).filter(Boolean);
  return (sub ? [sub, ...args] : args).join(' ').trim();
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
  icon = '🌤️',
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

/** wttr.in 的天气描述是英文，且服务端 `lang=zh` 实际未翻译——这里自建常用词映射 */
const COND_ZH: Record<string, string> = {
  sunny: '晴',
  clear: '晴',
  'partly cloudy': '局部多云',
  cloudy: '多云',
  overcast: '阴',
  mist: '薄雾',
  fog: '雾',
  'freezing fog': '冻雾',
  haze: '霾',
  smoky: '烟霾',
  'patchy rain nearby': '零星降雨',
  'patchy rain possible': '可能有零星降雨',
  'light rain': '小雨',
  'moderate rain': '中雨',
  'heavy rain': '大雨',
  'light drizzle': '毛毛雨',
  'light rain shower': '小阵雨',
  'moderate or heavy rain shower': '中到大雨',
  'thundery outbreaks possible': '可能有雷阵雨',
  'light snow': '小雪',
  'moderate snow': '中雪',
  'heavy snow': '大雪',
  'blowing snow': '风雪',
  blizzard: '暴雪',
  sleet: '雨夹雪',
  'light sleet': '小雨夹雪',
  'ice pellets': '冰粒',
};

function condZh(en: string): string {
  const key = en.trim().toLowerCase();
  if (COND_ZH[key]) return COND_ZH[key];
  if (key.includes('thunder')) return '雷雨';
  if (key.includes('snow')) return '降雪';
  if (key.includes('sleet')) return '雨夹雪';
  if (key.includes('rain') || key.includes('drizzle') || key.includes('shower')) return '降雨';
  if (key.includes('fog') || key.includes('mist')) return '雾';
  return en.trim();
}

const WIND_ZH: Record<string, string> = {
  N: '北风',
  NNE: '东北偏北风',
  NE: '东北风',
  ENE: '东北偏东风',
  E: '东风',
  ESE: '东南偏东风',
  SE: '东南风',
  SSE: '东南偏南风',
  S: '南风',
  SSW: '西南偏南风',
  SW: '西南风',
  WSW: '西南偏西风',
  W: '西风',
  WNW: '西北偏西风',
  NW: '西北风',
  NNW: '西北偏北风',
};

function windZh(dir: string): string {
  return WIND_ZH[dir] ?? `${dir} 风`;
}

interface WttrValue {
  value?: string;
}
interface WttrCurrent {
  temp_C?: string;
  FeelsLikeC?: string;
  humidity?: string;
  windspeedKmph?: string;
  winddir16Point?: string;
  visibility?: string;
  pressure?: string;
  uvIndex?: string;
  weatherDesc?: WttrValue[];
  observation_time?: string;
}
interface WttrDay {
  maxtempC?: string;
  mintempC?: string;
  astronomy?: Array<{ sunrise?: string; sunset?: string }>;
}
interface WttrArea {
  areaName?: WttrValue[];
  region?: WttrValue[];
  country?: WttrValue[];
}
interface WttrResponse {
  current_condition?: WttrCurrent[];
  nearest_area?: WttrArea[];
  weather?: WttrDay[];
}

async function fetchWeather(loc: string): Promise<PanelItem[]> {
  const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1&lang=zh`;
  const data = await ctx.http.json<WttrResponse>(url);
  const cur = data.current_condition?.[0];
  if (!cur) throw new Error('响应缺少 current_condition');

  const area = data.nearest_area?.[0];
  const day = data.weather?.[0];
  const name = area?.areaName?.[0]?.value ?? (loc || '当前位置');
  const region = area?.region?.[0]?.value;
  const country = area?.country?.[0]?.value;
  const place = [name, region && region !== name ? region : '', country]
    .filter(Boolean)
    .join(' · ');

  const descEn = cur.weatherDesc?.[0]?.value?.trim() ?? '';
  const desc = condZh(descEn);
  const temp = cur.temp_C ?? '—';
  const feels = cur.FeelsLikeC ?? '—';

  const items: PanelItem[] = [];

  // 一句话摘要（最常用的复制目标）
  items.push(
    makeItem(
      'summary',
      `${place || name} ${desc} ${temp}°C`,
      `体感 ${feels}°C · 湿度 ${cur.humidity ?? '—'}% · ${windZh(cur.winddir16Point ?? '')} ${cur.windspeedKmph ?? '—'} km/h`,
      '摘要',
      `${place || name} ${desc} ${temp}°C`,
      '📌',
    ),
  );
  items.push(makeItem('temp', `${temp}°C`, `当前气温 · 数据源 wttr.in`, '气温', `${temp}°C`, '🌡️'));
  items.push(makeItem('feels', `${feels}°C`, '体感温度', '体感', `${feels}°C`));
  items.push(makeItem('desc', desc, descEn && descEn !== desc ? `原文：${descEn}` : '天气现象', '天气', desc, '☁️'));
  items.push(makeItem('humidity', `${cur.humidity ?? '—'}%`, '相对湿度', '湿度', `${cur.humidity ?? '—'}%`, '💧'));
  items.push(
    makeItem(
      'wind',
      `${windZh(cur.winddir16Point ?? '')} ${cur.windspeedKmph ?? '—'} km/h`,
      `风向 ${cur.winddir16Point ?? '—'}`,
      '风',
      `${cur.windspeedKmph ?? '—'} km/h`,
      '🍃',
    ),
  );
  items.push(makeItem('visibility', `${cur.visibility ?? '—'} km`, '能见度', '能见度', `${cur.visibility ?? '—'} km`, '👁️'));
  items.push(makeItem('pressure', `${cur.pressure ?? '—'} hPa`, '气压', '气压', `${cur.pressure ?? '—'} hPa`, '📊'));
  items.push(makeItem('uv', `UV ${cur.uvIndex ?? '—'}`, '紫外线指数', '紫外线', `${cur.uvIndex ?? '—'}`, '🕶️'));

  if (day) {
    const range = `${day.mintempC ?? '—'}~${day.maxtempC ?? '—'}°C`;
    items.push(makeItem('today', `今日 ${range}`, '今日最低 ~ 最高', '今日', range, '📅'));
    const astro = day.astronomy?.[0];
    if (astro?.sunrise && astro?.sunset) {
      items.push(
        makeItem(
          'sun',
          `日出 ${astro.sunrise} / 日落 ${astro.sunset}`,
          '当地天文时间',
          '日出日落',
          `日出 ${astro.sunrise} 日落 ${astro.sunset}`,
          '🌅',
        ),
      );
    }
  }

  if (place) {
    items.push(makeItem('place', place, '解析到的位置', '位置', place, '📍'));
  }
  if (cur.observation_time) {
    items.push(makeItem('obs', `观测时间 ${cur.observation_time}`, 'wttr.in 观测时刻', '观测'));
  }

  return items;
}

/** 已抓取结果：键为查询位置（空串代表本机定位） */
const cache = new Map<string, { at: number; items: PanelItem[] }>();

export const weatherPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/weather',
  name: '天气查询',
  description:
    '天气查询：/weather 北京 联网获取实况与今日预报（数据源 wttr.in）。不带城市用本机网络位置，回车查询、再回车复制结果。',
  icon: '🌤️',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const loc = locationOf(input);
    const hit = cache.get(loc);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { items: hit.items, emptyText: '无结果' };
    }
    const label = loc || '当前位置';
    return {
      items: [
        makeItem('fetch', `查询「${label}」天气`, '回车联网获取（wttr.in，约 1 秒）', '查询', undefined, '🔎', {
          fetch: loc,
        }),
        makeItem('help', '/weather 上海 · /weather Tokyo', '输入城市名（支持中英文），不带则按本机定位', '用法', undefined, '💡'),
      ],
      emptyText: '回车查询',
    };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const loc = item.metadata?.fetch;
    if (typeof loc === 'string') {
      try {
        const items = await fetchWeather(loc);
        cache.set(loc, { at: Date.now(), items });
        return { refresh: true, toast: '天气已更新' };
      } catch (err) {
        return { toast: `查询失败：${errText(err)}` };
      }
    }
    if (item.badge === '用法') {
      return { toast: '输入城市名后回车查询' };
    }
    const value = item.metadata?.value;
    if (typeof value === 'string' && value) {
      return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
    }
    return { toast: '该项无内容可复制' };
  },
};

export function setup(): void {
  pluginRegistry.register(weatherPlugin);
}
