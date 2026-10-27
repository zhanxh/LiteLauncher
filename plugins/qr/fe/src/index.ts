/**
 * @ll/plugin-qr —— /qr 二维码（纯前端插件，backend.kind = "none"）
 *
 * 输入即在本机编码，结果面板第一行直接是可扫的大图；回车把同一张图以 PNG
 * 写进剪贴板（顺带落盘，路径回在 toast 里）。
 *
 * 为什么不走公共取图 API：内容要原样发给第三方（常是内网地址、口令、私人链接），
 * 而且断网即不可用。编码器见同目录 qrcode.ts。
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
import { byteCapacity, encodeQR, toSVGDataURL, type QRCode } from './qrcode';

const PLUGIN_ID = 'qr';
/** 预览边长（CSS px）：壳层上限 224，取 200 时一行 ≈216，加上其余两行仍在面板内 */
const PREVIEW_PX = 200;
/** 导出 PNG 的模块边长：手机扫码够用，又不至于让剪贴板里躺着一张几十 MB 的图 */
const EXPORT_MODULE_PX = 8;

const ctx = getPluginContext(PLUGIN_ID);

function fullText(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  const args = input.args ?? [];
  if (sub) return [sub, ...args].join(' ').trim();
  return (input.queryText ?? '').trim();
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 矩阵 → PNG data URL。
 *
 * 逐行按**游程**填充而不是一格一个 fillRect：v20 是 97×97 格，逐格调用会让一次
 * 回车卡出可感知的延迟，而游程数通常只有几十。
 */
function toPNGDataURL(code: QRCode): string {
  const quiet = 4;
  const edge = (code.size + quiet * 2) * EXPORT_MODULE_PX;
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('无法创建画布上下文');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, edge, edge);
  g.fillStyle = '#000';
  for (let row = 0; row < code.size; row += 1) {
    let col = 0;
    while (col < code.size) {
      if (code.modules[row][col] === 0) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < code.size && code.modules[row][col] === 1) col += 1;
      g.fillRect(
        (start + quiet) * EXPORT_MODULE_PX,
        (row + quiet) * EXPORT_MODULE_PX,
        (col - start) * EXPORT_MODULE_PX,
        EXPORT_MODULE_PX,
      );
    }
  }
  return canvas.toDataURL('image/png');
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
  description: '二维码生成：/qr 文本 立即在面板里生成可扫的大图，回车复制图片到剪贴板（全程离线）。',
  icon: '🔳',
  // 编码是毫秒级的，但逐键重算会换掉 <img src> 并触发行高重量；120ms 肉眼无感。
  queryDebounceMs: 120,

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const text = fullText(input);
    if (!text) {
      return {
        items: [makeItem('hint', '输入要编码的文本或链接', '例：/qr https://example.com 或 /qr 你好世界', '用法')],
        emptyText: '输入文本',
      };
    }

    const result = encodeQR(text);
    if (!result.ok) {
      // 不静默截断：用户会拿着一张"内容少了半截"的码去扫
      return {
        items: [
          makeItem(
            'too-long',
            `内容超出上限：${result.bytes} 字节 > ${byteCapacity(20)} 字节`,
            '纠错等级 M、版本 1–20 的字节模式上限。可缩短文本，或改用文件/链接。',
            '超限',
          ),
        ],
        emptyText: '内容过长',
      };
    }

    const { code } = result;
    const preview = text.length <= 76 ? text : `${text.slice(0, 75)}…`;
    return {
      items: [
        {
          id: `${PLUGIN_ID}:preview`,
          // 普通 action 行：kind:'info' 会被降透明度且跳过键盘导航，用户就按不到回车了
          title: '回车复制二维码图片',
          description: `版本 ${code.version} · ${code.size}×${code.size} 模块 · 纠错 M · ${byteLength(text)} 字节`,
          badge: '图片',
          icon: toSVGDataURL(code),
          iconSize: PREVIEW_PX,
          // 不带 metadata.value：通用复制契约会把首个带 value 的项当"回车即复制文本"，
          // 与本行的图片动作冲突。图片内容由 onSelect 重新编码取得。
          metadata: { qr: text },
        },
        makeItem('text', preview, `原始内容（${text.length} 字符）`, '内容', text),
      ],
      emptyText: '无结果',
    };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const text = item.metadata?.qr;
    if (typeof text === 'string' && text) {
      // 测试壳层没有 DOM（tools/test-fe-plugins.mjs 只注入 SDK stub），先挡住再碰 canvas
      if (typeof document === 'undefined') return { toast: '当前环境无法导出图片' };
      const result = encodeQR(text);
      if (!result.ok) return { toast: '内容超出编码上限，无法导出' };
      try {
        const saved = await ctx.screen.savePng(toPNGDataURL(result.code), { toClipboard: true });
        // close:false —— 预览留在屏上，用户可以接着扫或改内容重生成
        return { toast: `二维码图片已复制（${saved.path}）`, close: false };
      } catch (err) {
        return { toast: `复制失败：${err instanceof Error ? err.message : String(err)}` };
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
