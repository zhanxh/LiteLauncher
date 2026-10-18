/**
 * @ll/plugin-hash —— /hash 哈希与编码（纯前端，WP-15）
 *
 * 原 Python 版逐项输出 md5/sha 系列/base64/url/html/crc32；这里保留相同条目 id、
 * 中文 label 与 metadata.value 契约，壳层复制行为不变。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';
import {
  computeEntries,
  isHashAlgo,
  inputSize,
  oneLine,
  type HashEntry,
} from './hash';

const PLUGIN_ID = 'hash';

function fullText(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  if (sub) return [sub, ...(input.args ?? [])].join(' ').trim();
  return (input.queryText ?? '').trim();
}

function makeItem(entry: HashEntry): PanelItem {
  return {
    id: `${PLUGIN_ID}:${entry.name}`,
    title: oneLine(entry.value),
    description: entry.label,
    badge: entry.name.toUpperCase(),
    icon: '🔐',
    metadata: { value: entry.value, label: entry.label },
  };
}

export const hashPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/hash',
  name: '哈希与编码',
  description:
    '哈希与编码工具：/hash 文本 列出全部（md5/sha1/sha256/sha512/base64/url/html/crc32），或 /hash md5 文本 只算指定项；回车复制结果。纯前端，无需 Python。',
  icon: '🔐',
  argsHint: '[算法] 文本',
  examples: ['/hash hello', '/hash md5 hello', '/hash base64 你好', '/hash urldec a%20b'],

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const sub = (input.subcommand ?? '').trim().toLowerCase();
    const text = isHashAlgo(sub)
      ? (input.args ?? []).join(' ').trim()
      : fullText(input);

    if (!text) {
      return {
        items: [
          {
            id: `${PLUGIN_ID}:hint`,
            title: '输入要处理的文本',
            description: '例：/hash md5 hello（指定算法）或 /hash hello（全部算法）',
            badge: '用法',
            icon: '🔐',
          },
        ],
        emptyText: '输入文本',
      };
    }

    const names = isHashAlgo(sub)
      ? [sub]
      : ['md5', 'sha1', 'sha256', 'sha512', 'base64', 'base64d', 'url', 'urldec', 'html', 'htmlunesc', 'crc32'];
    const entries = await computeEntries(names, text);
    const items: PanelItem[] = entries.map(makeItem);
    const size = inputSize(text);
    items.push({
      id: `${PLUGIN_ID}:size`,
      title: `${size.chars} 字符 / ${size.bytes} 字节`,
      description: '输入长度',
      badge: '长度',
      icon: '📏',
    });

    return { items, emptyText: '无法处理该输入' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) {
      return { toast: '该项无内容可复制' };
    }
    return {
      copy: value,
      toast: `已复制 ${item.metadata?.label ?? '结果'}`,
    };
  },
};

export function setup(): void {
  pluginRegistry.register(hashPlugin);
}
