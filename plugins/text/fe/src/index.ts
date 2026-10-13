/**
 * @ll/plugin-text —— /text 文本处理（纯前端插件，backend.kind = "none"）
 *
 * 无 Rust crate、无 sidecar：全部逻辑在本文件，只依赖 @ll/sdk。
 * 选中即复制经 AfterSelect.copy 声明，壳层不理解本插件语义。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';

const PLUGIN_ID = 'text';

/** 按 camelCase / 分隔符切词（结果用于命名风格转换） */
function words(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^0-9A-Za-z\u4e00-\u9fa5]+/)
    .filter(Boolean);
}

interface Transform {
  label: string;
  fn: (s: string) => string;
}

const TRANSFORMS: Record<string, Transform> = {
  upper: { label: '全大写', fn: (s) => s.toUpperCase() },
  lower: { label: '全小写', fn: (s) => s.toLowerCase() },
  reverse: { label: '字符反转', fn: (s) => [...s].reverse().join('') },
  snake: { label: 'snake_case', fn: (s) => words(s).map((w) => w.toLowerCase()).join('_') },
  kebab: { label: 'kebab-case', fn: (s) => words(s).map((w) => w.toLowerCase()).join('-') },
  camel: {
    label: 'camelCase',
    fn: (s) =>
      words(s)
        .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
        .join(''),
  },
  pascal: {
    label: 'PascalCase',
    fn: (s) =>
      words(s)
        .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
        .join(''),
  },
  title: {
    label: '标题化',
    fn: (s) => s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1)),
  },
  trim: { label: '去除首尾空白', fn: (s) => s.trim() },
};

/** 还原斜杠之后的完整输入：指定子命令时排除它本身，否则取整段关键词 */
function fullText(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  const args = input.args ?? [];
  if (sub) return [sub, ...args].join(' ').trim();
  return (input.queryText ?? '').trim();
}

function makeItem(
  id: string,
  title: string,
  description: string,
  badge: string,
  copy?: string,
): PanelItem {
  return {
    id: `${PLUGIN_ID}:${id}`,
    title,
    description,
    badge,
    icon: '🔤',
    metadata: copy === undefined ? {} : { value: copy },
  };
}

export const textPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/text',
  name: '文本处理',
  description: '文本处理：/text 文本 列出全部变换，或 /text snake 文本 只做指定变换；回车复制结果。',
  icon: '🔤',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const sub = (input.subcommand ?? '').trim().toLowerCase();
    const specified = sub in TRANSFORMS;
    const text = specified ? (input.args ?? []).join(' ').trim() : fullText(input);

    if (!text) {
      return {
        items: [
          {
            id: `${PLUGIN_ID}:hint`,
            title: '输入要处理的文本',
            description: `例：/text 列全变换、/text snake ${'{文本}'}；可用 ${Object.keys(TRANSFORMS).join(' / ')}`,
            badge: '用法',
            icon: '🔤',
          },
        ],
        emptyText: '输入文本',
      };
    }

    const names = specified ? [sub] : Object.keys(TRANSFORMS);
    const items: PanelItem[] = [];
    for (const name of names) {
      const t = TRANSFORMS[name];
      let value: string;
      try {
        value = t.fn(text);
      } catch {
        continue;
      }
      if (!value) continue;
      items.push(makeItem(name, oneLine(value), t.label, name, value));
    }

    items.push(
      makeItem(
        'stats',
        `${[...text].length} 字符 / ${words(text).length} 词 / ${new TextEncoder().encode(text).length} 字节`,
        '长度统计',
        '统计',
      ),
    );
    return { items, emptyText: '无法处理该输入' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
  },
};

function oneLine(s: string, max = 76): string {
  const flat = s.replace(/\r?\n/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function setup(): void {
  pluginRegistry.register(textPlugin);
}
