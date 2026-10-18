/**
 * @ll/plugin-clip —— /clip 剪贴板历史（纯前端插件，backend.kind = "none"）
 *
 * 隐私立场（与 Ditto 的公开结论一致：这类工具价值与风险同源）：
 *   1. **按需入库**而非持续监听——只有用户自己打开 /clip 时才拉一次当前剪贴板。
 *      比 Ditto 的后台监听暴露面更小：你不主动查看，它就什么都不记。
 *   2. 疑似凭据（私钥头、password=、24+ 位高熵裸串）**压根不落盘**，由宿主过滤。
 *   3. 条数上限（200）+ 单条上限（64KB）+ 过期（7 天），由宿主强制。
 *   4. 提供"暂停监听"开关——处理凭据前先按一下。
 *   5. 数据只在本机插件库，不出网。
 * 面板把上述策略如实展示给用户，而不是藏进设置页。
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
import { isMultiline, preview, relativeTime, sizeHint } from './format';

const PLUGIN_ID = 'clip';
const ctx = getPluginContext(PLUGIN_ID);

/** 宿主返回的剪贴板历史条目 */
interface ClipEntry {
  id: number;
  text: string;
  ts: number;
  /** 来源进程 exe 名（旧数据可能为空） */
  source_app?: string | null;
}

/** 宿主返回的隐私策略 */
interface ClipPolicy {
  max_entries: number;
  max_bytes: number;
  retention_days: number;
  excluded_apps: string[];
  detect_secrets: boolean;
}

/** 还原斜杠之后的搜索关键词（分词器会把首 token 收进 subcommand） */
export function searchKeyword(input: ParsedInput): string {
  const parts = [input.subcommand ?? '', ...(input.args ?? [])];
  return parts.join(' ').trim();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 拉历史；带关键词则搜索 */
async function loadEntries(keyword: string, limit = 50): Promise<ClipEntry[]> {
  // 后台监听（Windows）已经持续入库；这里补一次当前剪贴板，作为
  // “监听未启动/非 Windows 平台”的兜底——重复内容会被宿主去重。
  if (!keyword) {
    await ctx.call('svc.clipboard.history.ingest', {});
  }
  const entries = keyword
    ? await ctx.call<ClipEntry[]>('svc.clipboard.history.search', { keyword, limit })
    : await ctx.call<ClipEntry[]>('svc.clipboard.history.recent', { limit });
  return entries ?? [];
}

/** 隐私策略摘要（面板顶部一行说清，让用户知道数据被怎么处理） */
async function policyLine(): Promise<string> {
  try {
    const p = await ctx.call<ClipPolicy>('svc.clipboard.history.policy', {});
    if (!p) return '数据只存本机';
    const bits = [
      `最多 ${p.max_entries} 条`,
      `${p.retention_days} 天过期`,
      p.detect_secrets ? '疑似凭据不记录' : '',
      p.excluded_apps?.length ? '密码管理器不入库' : '',
    ].filter(Boolean);
    return `数据只存本机 · ${bits.join(' · ')}`;
  } catch {
    return '数据只存本机';
  }
}

export const clipPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/clip',
  name: '剪贴板历史',
  description:
    '剪贴板历史：回车查看最近复制并回填，输入关键词可搜索。数据只存本机，疑似密码不记录，可暂停监听。',
  icon: '📋',
  argsHint: '[关键词]',
  examples: ['/clip 查看最近复制', '/clip kubectl 搜索历史', '/clip 面板首项可暂停/开启监听'],

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const keyword = searchKeyword(input);
    const items: PanelItem[] = [];

    let entries: ClipEntry[] = [];
    let note = '';
    try {
      entries = await loadEntries(keyword);
    } catch (err) {
      note = `读取历史失败：${messageOf(err)}`;
    }

    // 隐私策略与监听开关：放在最前面，用户第一眼就能看到、随手能关
    let watching = true;
    try {
      watching = Boolean(await ctx.call<boolean>('svc.clipboard.history.watching', {}));
    } catch {
      // 读不到就按开启处理，不因此阻断主流程
    }
    items.push({
      id: `${PLUGIN_ID}:policy`,
      title: watching ? '监听中：后台记录本机复制内容' : '已暂停：不再记录新的复制',
      description: await policyLine(),
      icon: watching ? '🔒' : '⏸️',
      badge: watching ? '隐私' : '已暂停',
      metadata: { action: 'toggle-watch' },
    });
    items.push({
      id: `${PLUGIN_ID}:clear`,
      title: '清空剪贴板历史',
      description: '立即删除本机保存的全部历史条目',
      icon: '🗑️',
      badge: '清空',
      metadata: { action: 'clear' },
    });

    if (keyword) {
      items.push({
        id: `${PLUGIN_ID}:kw`,
        title: `搜索：${keyword}`,
        description: entries.length > 0 ? `命中 ${entries.length} 条` : '无命中',
        icon: '🔍',
        badge: '搜索',
        kind: 'info',
        metadata: { action: 'none' },
      });
    }

    for (const e of entries) {
      items.push({
        id: `${PLUGIN_ID}:e${e.id}`,
        title: preview(e.text),
        description: `${relativeTime(e.ts)} · ${sizeHint(e.text)}${isMultiline(e.text) ? ' · 多行' : ''}${e.source_app ? ` · ${e.source_app.replace(/\.exe$/i, '')}` : ''}`,
        icon: '📄',
        badge: `id ${e.id}`,
        actions: [{ id: 'copy-only', label: '仅复制，不关窗', accel: 'ctrl+enter' }],
        // value 走壳层通用 copy 契约：回车即回填剪贴板
        metadata: { action: 'recall', id: e.id, value: e.text },
      });
    }

    if (entries.length === 0) {
      items.push({
        id: `${PLUGIN_ID}:empty`,
        title: keyword ? `没有匹配「${keyword}」的历史` : '还没有可回填的历史',
        description: '复制任意文本后回来即可找回；数据只存本机，可随时暂停',
        icon: '💡',
        badge: '空',
        kind: 'info',
        metadata: { action: 'none' },
      });
    }

    void note;
    return { items, emptyText: note || '没有可回填的剪贴板历史' };
  },

  async onSelect(item: PanelItem, actionId?: string): Promise<AfterSelect> {
    const meta = item.metadata ?? {};
    const action = String(meta.action ?? '');

    if (action === 'recall') {
      const id = Number(meta.id);
      try {
        await ctx.call('svc.clipboard.history.recall', { id });
        if (actionId === 'copy-only') {
          // 只回填、不关窗：连续取多条时不必反复打开 /clip
          return {
            copy: String(meta.value ?? ''),
            toast: '已复制（面板保持打开）',
          };
        }
        // 同时回传 copy：宿主 recall 已写入剪贴板，但壳层的通用 copy 走的是
        // 原生命令且在窗口隐藏的**同一帧内**执行，比插件 await 后再写更稳
        // （插件侧那次写入可能撞上 webview 失焦被拒）。两者不冲突，幂等。
        return {
          copy: String(meta.value ?? ''),
          toast: '已回填到剪贴板',
          clearInput: true,
          close: true,
        };
      } catch (err) {
        return { toast: `回填失败：${messageOf(err)}` };
      }
    }

    if (action === 'clear') {
      try {
        await ctx.call('svc.clipboard.history.clear', {});
        return { refresh: true, toast: '剪贴板历史已清空' };
      } catch (err) {
        return { toast: `清空失败：${messageOf(err)}` };
      }
    }

    if (action === 'toggle-watch') {
      try {
        const on = Boolean(await ctx.call<boolean>('svc.clipboard.history.watching', {}));
        await ctx.call('svc.clipboard.history.watching', { on: !on });
        return {
          refresh: true,
          toast: on ? '已暂停监听（处理凭据时建议暂停）' : '已开启监听',
        };
      } catch (err) {
        return { toast: `切换失败：${messageOf(err)}` };
      }
    }

    return { toast: '该项仅用于说明' };
  },
};

export function setup(): void {
  pluginRegistry.register(clipPlugin);
}
