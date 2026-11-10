/**
 * @ll/plugin-hash —— /hash 哈希与编码（纯前端，WP-15；0.3 起支持文件内容哈希）
 *
 * 原 Python 版逐项输出 md5/sha 系列/base64/url/html/crc32；这里保留相同条目 id、
 * 中文 label 与 metadata.value 契约，壳层复制行为不变。
 *
 * 0.3 文件模式：输入像文件路径时先经宿主 `svc.fs.stat` 探测，确认是文件则走
 * `svc.fs.digest`（宿主单遍流式计算，manifest 声明 `fs:read`）——大文件的字节
 * 不进 WebView 内存。探测失败（无宿主 / 路径不存在 / 是目录）一律回落文本模式，
 * 0.2.x 的旧行为完全保留。
 */
import {
  getPluginContext,
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type FsStat,
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

/** 文件模式算法集（与宿主 svc.fs.digest 支持面一致）；base64/url/html 是文本操作，不参与文件模式 */
const FILE_ALGOS: readonly string[] = ['md5', 'sha1', 'sha256', 'sha512', 'crc32'];
/** 未指定算法时文件模式默认输出（顺序即展示顺序） */
const FILE_DIGEST_NAMES = ['md5', 'sha1', 'sha256', 'sha512', 'crc32'];

const ctx = getPluginContext(PLUGIN_ID);

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

/** 看起来像文件路径：含路径分隔符，且不是 `scheme://` 形式的 URL */
function looksLikePath(text: string): boolean {
  if (!/[\\/]/.test(text)) return false;
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(text);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatModified(ms: number | null): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

/** 取路径最后一段作展示名（兼容 / 与 \，忽略结尾分隔符） */
function fileName(path: string): string {
  const norm = path.replace(/[\\/]+$/, '');
  const idx = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** 说明条目：键盘导航跳过（kind=info），只负责解释"为什么没按文件处理" */
function hintItem(id: string, title: string, description: string, badge: string, icon: string): PanelItem {
  return { id, title: oneLine(title), description, badge, icon, kind: 'info' };
}

/** 文件模式：宿主一次顺序读算全部请求算法；条目契约与文本模式一致（metadata.value = hex） */
async function filePanel(path: string, sub: string, st: FsStat): Promise<PanelData> {
  const algos = isHashAlgo(sub) && FILE_ALGOS.includes(sub) ? [sub] : [...FILE_DIGEST_NAMES];
  const result = await ctx.fs.digest(path, algos);
  const items: PanelItem[] = result.digests.map((d) =>
    makeItem({
      name: d.algo,
      label: `文件哈希 · ${formatSize(result.size)}`,
      value: d.hex,
    }),
  );
  const modified = formatModified(st.modifiedMs);
  items.push({
    id: `${PLUGIN_ID}:fileinfo`,
    title: oneLine(fileName(path)),
    description: `${formatSize(st.size)}${modified ? ` · 修改 ${modified}` : ''}`,
    badge: '文件',
    icon: '📄',
    kind: 'info',
  });
  return { items, emptyText: '无法计算文件哈希' };
}

export const hashPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/hash',
  name: '哈希与编码',
  description:
    '哈希与编码工具：/hash 文本 列出全部（md5/sha1/sha256/sha512/base64/url/html/crc32），/hash 文件路径 直接计算文件内容哈希（md5/sha1/sha256/sha512/crc32），或 /hash md5 输入 只算指定项；回车复制结果。',
  icon: '🔐',
  argsHint: '[算法] 文本或文件路径',
  examples: ['/hash hello', '/hash md5 hello', '/hash base64 你好', '/hash C:\\path\\file.zip'],

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const sub = (input.subcommand ?? '').trim().toLowerCase();
    const text = isHashAlgo(sub)
      ? (input.args ?? []).join(' ').trim()
      : fullText(input);

    if (!text) {
      return {
        items: [
          hintItem(
            `${PLUGIN_ID}:hint`,
            '输入要处理的文本或文件路径',
            '例：/hash md5 hello（指定算法）、/hash hello（全部算法）、/hash C:\\file.zip（文件哈希）',
            '用法',
            '🔐',
          ),
        ],
        emptyText: '输入文本',
      };
    }

    // 文件模式探测：只在「未指定算法」或「指定的是文件算法」时进行——
    // base64/url/html 是文本操作，保持旧行为。stat 是廉价探测（逐键调用无妨）；
    // 不以 isHostAvailable() 为前置（浏览器预览时 stat 会抛错，catch 住即回落）。
    const tryFile = !isHashAlgo(sub) || FILE_ALGOS.includes(sub);
    let probe: FsStat | null = null;
    if (tryFile && looksLikePath(text)) {
      try {
        const st = await ctx.fs.stat(text);
        if (st.exists && st.isFile) {
          return await filePanel(text, sub, st);
        }
        probe = st;
      } catch {
        probe = null; // 无宿主 / 无 fs:read 权限 / IPC 失败 → 文本模式
      }
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
    // 路径没命中文件时给一句解释，避免"想算文件却看到字符串哈希"的困惑
    if (probe && looksLikePath(text)) {
      items.push(
        probe.exists
          ? hintItem(`${PLUGIN_ID}:pathhint`, text, '这是目录，/hash 只处理文件；当前结果按文本计算', '提示', '💡')
          : hintItem(`${PLUGIN_ID}:pathhint`, text, '路径不存在，当前结果按文本计算', '提示', '💡'),
      );
    }

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
