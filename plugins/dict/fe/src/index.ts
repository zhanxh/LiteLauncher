/**
 * @ll/plugin-dict —— /dict 英文词典（纯前端插件，backend.kind = "none"）
 *
 * 数据源 dictionaryapi.dev（免费 / 免密，仅英文词条）。请求经宿主代理 `ctx.http`
 * （`svc.http.send`），manifest 声明 `net:api.dictionaryapi.dev`。
 * 发音音频用 `svc.process.launch` 交给默认浏览器播放（故另声明 `process`）。
 *
 * 这里用 `ctx.http.send` 而非 `ctx.http.json`：因为「查不到词」返回的是 404，
 * 需要按状态码区分「未收录」与「网络/服务异常」，不能一律当成错误抛出。
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

const PLUGIN_ID = 'dict';
const ctx = getPluginContext(PLUGIN_ID);
const CACHE_TTL_MS = 30 * 60_000;

/** 词性缩写 → 中文 */
const POS_ZH: Record<string, string> = {
  noun: '名词',
  verb: '动词',
  adjective: '形容词',
  adverb: '副词',
  pronoun: '代词',
  preposition: '介词',
  conjunction: '连词',
  interjection: '感叹词',
  determiner: '限定词',
  numeral: '数词',
  article: '冠词',
  exclamation: '感叹词',
};

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
  icon = '📖',
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

interface DictDefinition {
  definition?: string;
  example?: string;
  synonyms?: string[];
}
interface DictMeaning {
  partOfSpeech?: string;
  definitions?: DictDefinition[];
  synonyms?: string[];
}
interface DictPhonetic {
  text?: string;
  audio?: string;
}
interface DictEntry {
  word?: string;
  phonetic?: string;
  phonetics?: DictPhonetic[];
  meanings?: DictMeaning[];
}
interface DictError {
  title?: string;
  message?: string;
  resolution?: string;
}

function wordOf(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  const args = (input.args ?? []).filter(Boolean);
  return (sub ? [sub, ...args] : args).join(' ').trim();
}

async function fetchDict(word: string): Promise<PanelItem[]> {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const res = await ctx.http.send({ url });

  if (res.status === 404) {
    return [
      makeItem('notfound', `未收录「${word}」`, '该词典仅含英文词条；请检查拼写或改用原型', '未找到', undefined, '🔍'),
    ];
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error('响应不是合法 JSON');
  }

  if (!Array.isArray(parsed)) {
    const e = parsed as DictError;
    throw new Error(e.message || e.title || '服务返回了错误');
  }
  const entries = parsed as DictEntry[];
  const entry = entries[0];
  if (!entry?.word) throw new Error('响应缺少词条');

  const phonetics = (entry.phonetics ?? []).filter((p) => p.text || p.audio);
  const phoneticText =
    entry.phonetic?.trim() || phonetics.find((p) => p.text)?.text?.trim() || '';
  const audio = phonetics.find((p) => p.audio)?.audio ?? '';

  const items: PanelItem[] = [];
  items.push(makeItem('word', entry.word, phoneticText ? `音标 ${phoneticText}` : '词条', '单词', entry.word, '📖'));
  if (phoneticText) {
    items.push(makeItem('phonetic', phoneticText, '国际音标（点击复制）', '音标', phoneticText, '🔤'));
  }

  // 释义：最多 3 个词性 × 每个 2 条，避免面板过长
  let defCount = 0;
  const meanings = entry.meanings ?? [];
  for (const [mi, m] of meanings.slice(0, 3).entries()) {
    const pos = POS_ZH[m.partOfSpeech ?? ''] ?? m.partOfSpeech ?? '释义';
    const defs = m.definitions ?? [];
    for (const [di, def] of defs.slice(0, 2).entries()) {
      const text = (def.definition ?? '').trim();
      if (!text) continue;
      items.push(
        makeItem(
          `def-${mi}-${di}`,
          clip(text, 90),
          def.example ? `${pos} · 例：${clip(def.example, 80)}` : pos,
          pos,
          text,
          '📘',
        ),
      );
      defCount += 1;
    }
    const syns = [...(m.synonyms ?? []), ...defs.flatMap((d) => d.synonyms ?? [])].filter(Boolean);
    if (mi === 0 && syns.length) {
      const uniq = Array.from(new Set(syns)).slice(0, 8);
      items.push(makeItem('syn', uniq.join(', '), '同义词', '同义词', uniq.join(', '), '🔁'));
    }
  }
  if (defCount === 0) {
    items.push(makeItem('nodef', '未提供释义', '该词条只有音标或音频信息', '提示', undefined, '⚠️'));
  }

  const example = meanings.flatMap((m) => m.definitions ?? []).find((d) => d.example)?.example;
  if (example) {
    items.push(makeItem('example', clip(example, 100), '例句', '例句', example, '✍️'));
  }

  if (audio) {
    items.push(
      makeItem('audio', '播放发音', '在默认浏览器播放 mp3（需联网）', '发音', undefined, '🔊', { url: audio }),
    );
    items.push(makeItem('audio-url', audio, '复制发音音频链接', '音频链接', audio, '🔗'));
  }

  return items;
}

/** 已抓取结果：键为查询单词 */
const cache = new Map<string, { at: number; items: PanelItem[] }>();

export const dictPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/dict',
  name: '英文词典',
  description: '英文词典：/dict hello 查音标、词性与释义，回车联网查询、再回车复制释义或打开发音（数据源 dictionaryapi.dev）。',
  icon: '📖',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const word = wordOf(input);
    if (!word) {
      return {
        items: [
          makeItem('help', '/dict hello', '输入英文单词（仅英文词条），回车联网查询', '用法', undefined, '💡'),
        ],
        emptyText: '输入单词',
      };
    }
    const key = word.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { items: hit.items, emptyText: '无结果' };
    }
    return {
      items: [
        makeItem('fetch', `查询「${word}」`, '回车联网获取音标与释义（dictionaryapi.dev）', '查询', undefined, '🔎', {
          fetch: key,
        }),
        makeItem('help', '/dict hello', '输入英文单词，回车联网查询', '用法', undefined, '💡'),
      ],
      emptyText: '回车查询',
    };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const url = item.metadata?.url;
    if (typeof url === 'string' && url) {
      try {
        await ctx.call('svc.process.launch', { target: url });
        return { toast: '已在浏览器打开发音' };
      } catch (err) {
        return { toast: `打开失败：${errText(err)}` };
      }
    }
    const key = item.metadata?.fetch;
    if (typeof key === 'string') {
      try {
        const items = await fetchDict(key);
        cache.set(key, { at: Date.now(), items });
        return { refresh: true, toast: '查询完成' };
      } catch (err) {
        return { toast: `查询失败：${errText(err)}` };
      }
    }
    if (item.badge === '用法') {
      return { toast: '输入英文单词后回车查询' };
    }
    const value = item.metadata?.value;
    if (typeof value === 'string' && value) {
      return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
    }
    return { toast: '该项无内容可复制' };
  },
};

export function setup(): void {
  pluginRegistry.register(dictPlugin);
}
