/**
 * 取色历史：取色台窗口与指令面板是两个 JS 上下文（各自一份模块实例），
 * 靠宿主 settings KV（按插件 id 前缀隔离）共享同一份数据。
 */
import { getPluginContext } from '@ll/sdk';

const ctx = getPluginContext('pick');

const HISTORY_KEY = 'history';
/** 历史上限：够回看最近几次取色即可，避免面板被刷屏 */
export const HISTORY_MAX = 12;

/** 取色台是否正开着——主窗口的热键处理器据此让位（避免一次按键执行两遍） */
const PANEL_OPEN_KEY = 'panelOpen';

export async function loadHistory(): Promise<string[]> {
  const list = await ctx.settings.getJson<string[]>(HISTORY_KEY, []);
  return Array.isArray(list) ? list.filter((v) => typeof v === 'string' && v) : [];
}

/** 记一次取色（去重后置顶、截断到上限），返回新列表 */
export async function pushHistory(hex: string): Promise<string[]> {
  const current = await loadHistory();
  const next = [hex, ...current.filter((v) => v.toUpperCase() !== hex.toUpperCase())].slice(0, HISTORY_MAX);
  await ctx.settings.setJson(HISTORY_KEY, next);
  return next;
}

export async function clearHistory(): Promise<void> {
  await ctx.settings.setJson(HISTORY_KEY, []);
}

export async function setPanelOpen(open: boolean): Promise<void> {
  await ctx.settings.set(PANEL_OPEN_KEY, open ? '1' : '0');
}

export async function isPanelOpen(): Promise<boolean> {
  return (await ctx.settings.get(PANEL_OPEN_KEY)) === '1';
}
