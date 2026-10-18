/**
 * @ll/plugin-pwd —— /pwd 密码生成（纯前端，WP-15）
 *
 * 不落盘、不调用后端；每次 query 生成新密码，回车复制选中项。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';
import { generateVariants } from './pwd';

const PLUGIN_ID = 'pwd';

function fullText(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  if (sub) return [sub, ...(input.args ?? [])].join(' ').trim();
  return (input.queryText ?? '').trim();
}

export const pwdPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/pwd',
  name: '密码生成器',
  description:
    '强密码生成：/pwd 列出多种方案；/pwd 24 指定长度；/pwd 16 easy（无易混淆字符）或 /pwd 20 nosym（不含符号）；回车复制。纯前端，无需 Python。',
  icon: '🔑',
  argsHint: '[长度] [easy|nosym]',
  examples: ['/pwd', '/pwd 24', '/pwd 16 easy', '/pwd 20 nosym'],

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const variants = generateVariants(fullText(input));
    const items: PanelItem[] = variants.map((variant) => ({
      id: `${PLUGIN_ID}:${variant.id}`,
      title: variant.value,
      description: variant.description,
      badge: variant.label,
      icon: '🔑',
      metadata: { value: variant.value, label: variant.label },
    }));
    return { items, emptyText: '无结果' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制 ${item.metadata?.label ?? '密码'}` };
  },
};

export function setup(): void {
  pluginRegistry.register(pwdPlugin);
}
