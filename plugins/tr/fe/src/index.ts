/**
 * @ll/plugin-tr —— /tr 翻译（纯前端插件，backend.kind = "none"）
 *
 * 数据源 MyMemory（免费 / 免密，匿名有每日额度；超限返回 quotaFinished）。
 * 请求经宿主代理 `ctx.http`（`svc.http.send`），manifest 声明 `net:api.mymemory.translated.net`。
 *
 * 用法：
 *   /tr hello world        自动识别源语言（含中日韩字符→中文，否则英语），译向其对立面
 *   /tr zh hello           指定「译成中文」
 *   /tr en ja hello        指定「英语 → 日语」
 *
 * 沿用网络插件统一范式：query 不发请求，onSelect 抓取 + 缓存 + refresh。
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

const PLUGIN_ID = 'tr';
const ctx = getPluginContext(PLUGIN_ID);
const CACHE_TTL_MS = 30 * 60_000;

/** 语言别名 → API 代码（小写键） */
const LANGS: Record<string, string> = {
  zh: 'zh-CN',
  cn: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
  tw: 'zh-TW',
  en: 'en',
  ja: 'ja',
  jp: 'ja',
  ko: 'ko',
  kr: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ru: 'ru',
  it: 'it',
  pt: 'pt',
  ar: 'ar',
  th: 'th',
  vi: 'vi',
  nl: 'nl',
  tr: 'tr',
  pl: 'pl',
  hi: 'hi',
  id: 'id',
  ms: 'ms',
  el: 'el',
  sv: 'sv',
  da: 'da',
  fi: 'fi',
  no: 'no',
  cs: 'cs',
  uk: 'uk',
  he: 'he',
  ro: 'ro',
  hu: 'hu',
};

/** 语言代码 → 展示名 */
const LANG_NAME: Record<string, string> = {
  'zh-CN': '中文',
  'zh-TW': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  ru: '俄语',
  it: '意大利语',
  pt: '葡萄牙语',
  ar: '阿拉伯语',
  th: '泰语',
  vi: '越南语',
  nl: '荷兰语',
  tr: '土耳其语',
  pl: '波兰语',
  hi: '印地语',
  id: '印尼语',
  ms: '马来语',
};

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

function langName(code: string): string {
  return LANG_NAME[code] ?? code;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function makeItem(
  id: string,
  title: string,
  description: string,
  badge: string,
  copy?: string,
  icon = '🌏',
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

interface TrQuery {
  src: string;
  tgt: string;
  text: string;
}

function tokensOf(input: ParsedInput): string[] {
  const sub = (input.subcommand ?? '').trim();
  const args = (input.args ?? []).filter(Boolean);
  return sub ? [sub, ...args] : args;
}

function parseQuery(input: ParsedInput): TrQuery | null {
  const tokens = tokensOf(input);
  if (tokens.length === 0) return null;

  const first = LANGS[tokens[0].toLowerCase()];
  if (first && tokens.length >= 2) {
    const second = LANGS[tokens[1].toLowerCase()];
    if (second && tokens.length >= 3) {
      const text = tokens.slice(2).join(' ').trim();
      return text ? { src: first, tgt: second, text } : null;
    }
    const text = tokens.slice(1).join(' ').trim();
    if (!text) return null;
    return { src: first, tgt: first.startsWith('zh') ? 'en' : 'zh-CN', text };
  }

  const text = tokens.join(' ').trim();
  if (!text) return null;
  const src = CJK_RE.test(text) ? 'zh-CN' : 'en';
  return { src, tgt: src === 'zh-CN' ? 'en' : 'zh-CN', text };
}

function keyOf(q: TrQuery): string {
  return `${q.src}|${q.tgt}|${q.text}`;
}

interface MyMemoryMatch {
  translation?: string;
  quality?: string | number;
}
interface MyMemoryResponse {
  responseData?: { translatedText?: string; match?: number };
  responseStatus?: number | string;
  responseDetails?: string;
  quotaFinished?: boolean;
  matches?: MyMemoryMatch[];
}

async function fetchTr(q: TrQuery): Promise<PanelItem[]> {
  const url =
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q.text)}` +
    `&langpair=${encodeURIComponent(`${q.src}|${q.tgt}`)}`;
  const d = await ctx.http.json<MyMemoryResponse>(url);

  if (d.quotaFinished) throw new Error('MyMemory 今日免费额度已用尽，请稍后再试');
  const status = String(d.responseStatus ?? '');
  if (status && status !== '200') {
    throw new Error(d.responseDetails || `服务返回 ${status}`);
  }
  const translated = d.responseData?.translatedText?.trim();
  if (!translated) throw new Error('响应缺少译文');

  const items: PanelItem[] = [];
  items.push(makeItem('out', clip(translated, 100), `${langName(q.src)} → ${langName(q.tgt)}`, '译文', translated, '🌏'));
  items.push(makeItem('in', clip(q.text, 100), '原文', '原文', q.text, '📝'));
  items.push(
    makeItem('pair', `${langName(q.src)} → ${langName(q.tgt)}`, `${q.src} → ${q.tgt}`, '语言', undefined, '🔤'),
  );

  // 备选译法（MyMemory 的匹配库，去重后取前 3 条）
  const alts = Array.from(
    new Set(
      (d.matches ?? [])
        .map((m) => (m.translation ?? '').trim())
        .filter((t) => t && t !== translated),
    ),
  ).slice(0, 3);
  for (const [i, alt] of alts.entries()) {
    items.push(makeItem(`alt-${i}`, clip(alt, 100), '备选译法', `备选${i + 1}`, alt, '🔀'));
  }

  const match = d.responseData?.match;
  if (typeof match === 'number') {
    items.push(makeItem('match', `匹配度 ${(match * 100).toFixed(0)}%`, '源语言识别与匹配质量', '匹配度'));
  }

  return items;
}

/** 已抓取结果：键为 src|tgt|text */
const cache = new Map<string, { at: number; items: PanelItem[] }>();

export const trPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/tr',
  name: '翻译',
  description: '翻译：自动识别中英方向，也可指定语言对（数据源 MyMemory，免密，有每日额度）。',
  icon: '🌏',
  argsHint: '[源语种 目标语种] <文本>',
  examples: ['/tr hello world', '/tr en ja hello', '/tr zh hello'],

  isAction: () => false,

  /**
   * 声明 300ms 防抖：壳层"停止输入即出结果"，用户不必再按一次回车。
   * 壳层对 query() 默认逐键调用且无防抖，直接联网会打爆接口；
   * 有了这个字段就能安全地把两段式范式简化掉。
   */
  queryDebounceMs: 300,

  async query(input: ParsedInput): Promise<PanelData> {
    const q = parseQuery(input);
    if (!q) {
      return {
        items: [
          makeItem('help', '/tr hello world', '直接输入文本自动中英互译', '用法', undefined, '💡'),
          makeItem('help2', '/tr en ja hello · /tr zh hello', '前置语言代码可指定语言对', '用法', undefined, '💡'),
        ],
        emptyText: '输入待翻译文本',
      };
    }
    const key = keyOf(q);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { items: hit.items, emptyText: '无结果' };
    }
    try {
      const items = await fetchTr(q);
      cache.set(key, { at: Date.now(), items });
      return { items, emptyText: '无结果' };
    } catch (err) {
      return {
        items: [
          makeItem('retry', `翻译失败：${errText(err)}`, '回车重试', '失败', undefined, '⚠️', { fetch: key }),
          makeItem('help', '/tr hello · /tr en ja hello', '可前置语言代码指定语言对', '用法', undefined, '💡'),
        ],
        emptyText: '翻译失败',
      };
    }
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const key = item.metadata?.fetch;
    if (typeof key === 'string') {
      const q = parseQueryFromKey(key);
      if (!q) return { toast: '翻译参数已失效，请重新输入' };
      try {
        const items = await fetchTr(q);
        cache.set(key, { at: Date.now(), items });
        return { refresh: true, toast: '翻译完成' };
      } catch (err) {
        return { toast: `翻译失败：${errText(err)}` };
      }
    }
    if (item.badge === '用法') {
      return { toast: '输入文本后回车翻译' };
    }
    const value = item.metadata?.value;
    if (typeof value === 'string' && value) {
      return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
    }
    return { toast: '该项无内容可复制' };
  },
};

/** 由缓存键还原：src|tgt|text（text 可能含 |，故按前两段切分） */
function parseQueryFromKey(key: string): TrQuery | null {
  const first = key.indexOf('|');
  const second = key.indexOf('|', first + 1);
  if (first < 0 || second < 0) return null;
  const src = key.slice(0, first);
  const tgt = key.slice(first + 1, second);
  const text = key.slice(second + 1);
  if (!src || !tgt || !text) return null;
  return { src, tgt, text };
}

export function setup(): void {
  pluginRegistry.register(trPlugin);
}
