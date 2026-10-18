/**
 * 外部插件（LLP / native）的前端注册：宿主扫描 extplugins 后，前端据 plugin_list 的
 * backend.kind === "llp" | "native" + command 声明，生成通用 CommandPlugin 并注册。
 *
 * 两类插件共用同一套通用面板契约（MVP）：search/execute/select 全部走统一通道
 * 转发到后端（sidecar 或动态库 vtable），返回值即 PanelData / ActionResult / AfterSelect——
 * 与内置插件完全同构，壳层无任何特判。
 */
import { invoke } from '@tauri-apps/api/core';
import { getPluginContext, pluginRegistry, type CommandPlugin, type PanelItem } from '@ll/sdk';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 宿主 plugin_list 条目（commands.rs 手工序列化，camelCase 键） */
export interface ExternalPluginInfo {
  id: string;
  name: string;
  version: string;
  trigger: string;
  description?: string;
  enabled: boolean;
  backend: { kind: string; entry?: string[] };
  command?: {
    icon: string;
    actionSubcommands: string[];
    hint?: string | null;
    /**
     * search 的防抖毫秒数（缺省 = 壳层逐键立即调用）。
     * `/find` 这类"每键都要查外部索引"的插件必须声明，否则输入 10 个字符
     * 就是 10 次 IPC。宿主从 manifest 的 `command.queryDebounceMs` 透传。
     */
    queryDebounceMs?: number | null;
  };
}

/** 按宿主返回的 manifest 命令声明，生成通用指令插件 */
function makeExternalPlugin(info: ExternalPluginInfo): CommandPlugin {
  const ctx = getPluginContext(info.id);
  const command = info.command ?? { icon: '🧩', actionSubcommands: [] as string[], hint: null };

  return {
    id: info.id,
    trigger: info.trigger,
    name: info.name,
    description: info.description ?? '',
    icon: command.icon || '🧩',

    // 宿主 manifest 声明了就用；0/undefined 保持壳层默认的逐键调用
    ...(command.queryDebounceMs && command.queryDebounceMs > 0
      ? { queryDebounceMs: command.queryDebounceMs }
      : {}),

    isAction(input) {
      return command.actionSubcommands.includes(input.subcommand ?? '');
    },

    getPreview(input) {
      if (!command.actionSubcommands.includes(input.subcommand ?? '')) return null;
      return {
        title: `执行 ${info.name}`,
        detail: [input.subcommand, ...input.args].join(' ').trim() || input.raw,
        badge: '即时动作',
        hint: command.hint ?? '按 Enter 执行',
      };
    },

    async execute(input) {
      if (!isTauri()) return { success: true, message: `[预览模式] ${info.name}` };
      try {
        const res = await ctx.call<{ success?: boolean; message?: string }>('execute', {
          raw: input.raw,
          subcommand: input.subcommand ?? null,
          args: input.args,
          namedArgs: input.namedArgs,
        });
        return { success: res?.success !== false, message: res?.message ?? '已执行' };
      } catch (err: any) {
        return { success: false, message: `${info.name}: ${err?.message || err}` };
      }
    },

    async query(input) {
      if (!isTauri()) return { items: [], emptyText: '（浏览器预览模式）' };
      try {
        const data = await ctx.call<{ items?: PanelItem[]; emptyText?: string }>('search', {
          keyword: input.queryText.trim() || null,
          subcommand: input.subcommand ?? null,
          args: input.args,
        });
        return {
          items: data?.items ?? [],
          emptyText: data?.emptyText ?? '无结果',
        };
      } catch (err: any) {
        return {
          items: [],
          emptyText: '',
          error: `${info.name} 查询失败: ${err?.message || err}`,
        };
      }
    },

    async onSelect(item: PanelItem, actionId?: string) {
      if (!isTauri()) return { toast: `[预览] ${item.title}` };
      try {
        const res = await ctx.call<{
          close?: boolean;
          clearInput?: boolean;
          toast?: string;
          refresh?: boolean;
          copy?: string;
        }>('select', { id: item.id, metadata: item.metadata ?? {}, actionId: actionId ?? null });
        return {
          close: res?.close,
          clearInput: res?.clearInput,
          toast: res?.toast,
          refresh: res?.refresh,
          copy: res?.copy,
        };
      } catch (err: any) {
        return { toast: `${info.name}: ${err?.message || err}` };
      }
    },
  };
}

/** 启动时调用：拉取插件清单并注册全部外部插件命令（懒启动，注册不 spawn） */
export async function registerExternalPlugins(): Promise<number> {
  if (!isTauri()) return 0;
  try {
    const list = await invoke<ExternalPluginInfo[]>('plugin_list');
    let count = 0;
    for (const info of list) {
      if ((info.backend?.kind !== 'llp' && info.backend?.kind !== 'native') || !info.command) continue;
      pluginRegistry.register(makeExternalPlugin(info));
      count += 1;
    }
    if (count > 0) {
      const { invoke: inv } = await import('@tauri-apps/api/core');
      void inv('record_fe_log', {
        msg: `外部插件命令已注册: ${count} 个`,
      });
    }
    return count;
  } catch (err) {
    console.warn('外部插件注册失败:', err);
    return 0;
  }
}
