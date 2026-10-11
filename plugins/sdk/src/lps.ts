/**
 * LPS-1 插件前端 SDK：PluginContext 最小实现（M1）
 *
 * 前端不再直接 invoke 各插件的业务命令，统一经宿主的 plugin_call 通道
 * 按 pluginId 分发。M2 将扩展 windows/settings/toast 等服务句柄。
 */
import { invoke } from '@tauri-apps/api/core';

export interface PluginContext {
  /** 调用本插件后端方法（宿主按 pluginId 分发到 PluginBackend::call） */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

const contexts = new Map<string, PluginContext>();

export function getPluginContext(pluginId: string): PluginContext {
  const cached = contexts.get(pluginId);
  if (cached) {
    return cached;
  }
  const ctx: PluginContext = {
    async call<T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      return await invoke<T>('plugin_call', { pluginId, method, params });
    },
  };
  contexts.set(pluginId, ctx);
  return ctx;
}
