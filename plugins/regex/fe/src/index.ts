/**
 * @ll/plugin-regex —— /regex 正则测试与速查（纯前端插件，backend.kind = "none"）
 *
 * 用法：/regex 列出速查；/regex 模式 校验表达式；/regex 模式 样本文本 显示匹配与分组。
 * 模式支持 JS 字面量写法 `/pattern/flags`，缺省 flags 为 g。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';

const PLUGIN_ID = 'regex';
const MAX_MATCHES = 30;

const CHEATS: Array<[string, string]> = [
  ['\\d+', '一个或多个数字'],
  ['^\\w+$', '仅由字母数字下划线构成的整串'],
  ['[\\u4e00-\\u9fa5]+', '中文字符串'],
  ['\\b[\\w.+-]+@[\\w-]+\\.[\\w.]+\\b', '邮箱（宽松）'],
  ['https?://\\S+', 'URL'],
  ['\\d{4}-\\d{2}-\\d{2}', '日期 YYYY-MM-DD'],
  ['(\\d{3})-(\\d{4})', '带分组捕获的号码片段'],
  ['^\\s*$', '空白行'],
  ['(?<=\\d)(?=(\\d{3})+$)', '千分位插入位置（前瞻）'],
];

interface Compiled {
  re: RegExp;
  source: string;
  flags: string;
}

/** 解析模式：支持 `/pattern/flags` 字面量写法，否则整串作为模式、默认 flags=g */
function compile(raw: string): Compiled | string {
  const literal = raw.match(/^\/(.*)\/([gimsuy]*)$/s);
  const source = literal ? literal[1] : raw;
  const flags = literal ? literal[2] || 'g' : 'g';
  try {
    return { re: new RegExp(source, flags), source, flags };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function makeItem(id: string, title: string, description: string, badge: string, copy?: string): PanelItem {
  return {
    id: `${PLUGIN_ID}:${id}`,
    title,
    description,
    badge,
    icon: '🧩',
    metadata: copy === undefined ? {} : { value: copy },
  };
}

export const regexPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/regex',
  name: '正则测试',
  description: '正则工具：/regex 列出常用正则速查；/regex 模式 校验表达式；/regex 模式 样本文本 显示匹配与分组。回车复制。',
  icon: '🧩',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const pattern = (input.subcommand ?? '').trim();
    const sample = (input.args ?? []).join(' ');

    if (!pattern) {
      return {
        items: [
          makeItem('hint', '用法：/regex 模式 [样本文本]', '含空格的模式或文本请用引号包起来', '用法'),
          ...CHEATS.map(([p, desc]) => makeItem(p, p, desc, '速查', p)),
        ],
        emptyText: '输入正则表达式',
      };
    }

    const result = compile(pattern);
    if (typeof result === 'string') {
      return {
        items: [makeItem('err', `表达式非法：${result}`, pattern, '错误')],
        emptyText: '表达式非法',
      };
    }
    const { re, source, flags } = result;
    const literal = `/${source}/${flags}`;

    if (!sample) {
      return {
        items: [
          makeItem('ok', literal, '表达式编译通过，补上样本文本即可看到匹配结果', '有效', literal),
          makeItem('flags', `${flags}（${describeFlags(flags)}）`, '生效的匹配标志', '标志'),
        ],
        emptyText: '表达式有效',
      };
    }

    const matches = [...sample.matchAll(re)];
    if (matches.length === 0) {
      return {
        items: [
          makeItem('ok', literal, '表达式有效', '有效', literal),
          makeItem('none', '样本文本中没有匹配', sample.slice(0, 76), '无匹配'),
        ],
        emptyText: '无匹配',
      };
    }

    const items: PanelItem[] = matches.slice(0, MAX_MATCHES).map((m, i) => {
      const groups = m.slice(1).filter((g) => g !== undefined);
      const groupText = groups.length > 0 ? ` · 分组：${groups.join(' | ')}` : '';
      return makeItem(`m${i}`, m[0] || '（零宽匹配）', `位置 ${m.index}${groupText}`, `#${i + 1}`, m[0]);
    });
    if (matches.length > MAX_MATCHES) {
      items.push(makeItem('more', `仅显示前 ${MAX_MATCHES} 个匹配`, `共 ${matches.length} 个`, '截断'));
    }
    return { items, emptyText: '无匹配' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
  },
};

function describeFlags(flags: string): string {
  const names: Record<string, string> = {
    g: '全局匹配',
    i: '忽略大小写',
    m: '多行模式',
    s: '点号匹配换行',
    u: 'Unicode 模式',
    y: '粘性匹配',
  };
  return flags.split('').map((f) => names[f] ?? f).join('、') || '无';
}

export function setup(): void {
  pluginRegistry.register(regexPlugin);
}
