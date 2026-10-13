/**
 * @ll/plugin-qr —— /qr 二维码生成（纯前端插件，backend.kind = "none"）
 *
 * 与 Python 版同样借道公共图片 API 生成二维码（免去在插件里内置编码器）。
 * 这是纯前端插件调用宿主 `svc.*` 能力的示例：打开图片走 svc.process.launch，
 * 需要 manifest 声明 `process` 权限。
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

const PLUGIN_ID = 'qr';
const API = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=';

const ctx = getPluginContext(PLUGIN_ID);

function fullText(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  const args = input.args ?? [];
  if (sub) return [sub, ...args].join(' ').trim();
  return (input.queryText ?? '').trim();
}

function makeItem(id: string, title: string, description: string, badge: string, copy?: string): PanelItem {
  return {
    id: `${PLUGIN_ID}:${id}`,
    title,
    description,
    badge,
    icon: '🔳',
    metadata: copy === undefined ? {} : { value: copy },
  };
}

export const qrPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/qr',
  name: '二维码',
  description: '二维码生成：/qr 文本 生成二维码，回车在默认浏览器打开图片（联网），也可复制二维码链接或原文。',
  icon: '🔳',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const text = fullText(input);
    if (!text) {
      return {
        items: [makeItem('hint', '输入要编码的文本或链接', '例：/qr https://example.com 或 /qr 你好世界', '用法')],
        emptyText: '输入文本',
      };
    }

    const url = API + encodeURIComponent(text);
    const preview = text.length <= 76 ? text : `${text.slice(0, 75)}…`;
    // 打开项：metadata.url 由 onSelect 识别，不打 copy 标记
    return {
      items: [
        {
          id: `${PLUGIN_ID}:open`,
          title: '打开二维码图片',
          description: '在默认浏览器打开（需联网取图）',
          badge: '打开',
          icon: '🔗',
          metadata: { url },
        },
        makeItem('link', url, '复制二维码图片链接', '链接', url),
        makeItem('text', preview, `原始内容（${text.length} 字符）`, '内容', text),
      ],
      emptyText: '无结果',
    };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const url = item.metadata?.url;
    if (typeof url === 'string' && url) {
      try {
        await ctx.call('svc.process.launch', { target: url });
        return { toast: '已在浏览器打开二维码', close: true };
      } catch (err) {
        return { toast: `打开失败：${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
  },
};

export function setup(): void {
  pluginRegistry.register(qrPlugin);
}
