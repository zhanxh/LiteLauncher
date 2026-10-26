/**
 * @ll/plugin-time —— /time 世界时钟（纯前端，WP-15）
 *
 * 面板：本地时间 + 14 个城市，秒级实时刷新（PanelData.live，壳层每秒重跑 query）；
 * 回车把该城市的墙面时钟弹到桌面（可同时弹多个，自动贴壁纸层），
 * Ctrl+Enter 复制 `城市 YYYY-MM-DD HH:MM`（与旧版一致的复制值）。
 */
import {
  getPluginContext,
  pluginRegistry,
  registerView,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';
import { ClockWidget } from './clock';
import { localZoneName, worldTime } from './time';

const PLUGIN_ID = 'time';
const VIEW_ID = 'clock';

/** 面板刷新间隔：读数到秒，1s 一跳刚好；壳层会夹到最小 500ms */
const LIVE_MS = 1000;

const ctx = getPluginContext(PLUGIN_ID);

function fullText(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  if (sub) return [sub, ...(input.args ?? [])].join(' ').trim();
  return (input.queryText ?? '').trim();
}

export const timePlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/time',
  name: '世界时钟',
  description:
    '世界时钟：/time 列出主要城市当前时间与相对本地的时差（秒级实时刷新）；回车在桌面弹出该城市的墙面时钟（可弹出多个、自动贴壁纸层），Ctrl+Enter 复制时间。纯前端，无需 Python。',
  icon: '🌍',
  argsHint: '[城市]',
  examples: ['/time', '/time 纽约', '/time 伦敦'],

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const keyword = fullText(input);
    const snapshot = worldTime(keyword);
    if (keyword && snapshot.cities.length === 0) {
      return {
        items: [
          {
            id: `${PLUGIN_ID}:err`,
            title: '未找到该城市',
            description: keyword,
            badge: '提示',
            icon: '🌍',
            kind: 'info',
          },
        ],
        emptyText: '未找到该城市',
        // 错误提示是静态的，不声明 live
      };
    }

    const items: PanelItem[] = [
      {
        id: `${PLUGIN_ID}:local`,
        title: snapshot.localTime,
        description: `本地 · ${snapshot.localDate}`,
        badge: '本地',
        icon: '🏠',
        metadata: {
          city: '本地',
          tz: localZoneName(),
          fb: 0,
          value: `本地 ${snapshot.localDate.split(' ')[0]} ${snapshot.localTime.slice(0, 5)}`,
          label: '本地',
        },
        actions: [{ id: 'copy', label: '复制时间', accel: 'ctrl+enter' }],
      },
    ];
    snapshot.cities.forEach((city, index) => {
      items.push({
        id: `${PLUGIN_ID}:${index}`,
        title: city.time,
        description: `${city.name} · ${city.offset}${city.fallback ? '（夏令时可能不准）' : ''} · 回车弹桌面时钟`,
        badge: city.name,
        icon: '🌍',
        metadata: {
          city: city.name,
          tz: city.iana,
          fb: city.fallbackHours,
          value: city.value,
          label: city.name,
        },
        actions: [{ id: 'copy', label: '复制时间', accel: 'ctrl+enter' }],
      });
    });
    return {
      items,
      emptyText: '无结果',
      // 实时刷新：面板停留期间壳层每秒重跑 query，时间读数永远当前
      live: LIVE_MS,
    };
  },

  async onSelect(item: PanelItem, actionId?: string): Promise<AfterSelect> {
    const meta = item.metadata ?? {};
    const value = typeof meta.value === 'string' ? meta.value : '';

    // 次级动作：复制时间（Ctrl+Enter），保留旧版"复制"能力的替代路径
    if (actionId === 'copy') {
      if (!value) return { toast: '该项无内容可复制' };
      return { copy: value, toast: `已复制 ${meta.label ?? '时间'}` };
    }

    // 主动作：在桌面弹出该城市的墙面时钟（可多个；同城市重复点回已开的钟）
    const city = typeof meta.city === 'string' ? meta.city : '';
    const tz = typeof meta.tz === 'string' ? meta.tz : '';
    if (!city || !tz) return { toast: '该项缺少时区信息' };
    try {
      await ctx.windows.open(VIEW_ID, {
        city,
        tz,
        fallback: typeof meta.fb === 'number' ? meta.fb : 0,
      });
      return { toast: `已在桌面展示 ${city} 时钟` };
    } catch (err) {
      // 开窗失败（权限/环境异常）不应让点击毫无反馈：退回复制时间
      console.error('弹出桌面时钟失败:', err);
      if (value) return { copy: value, toast: '弹时钟失败，已复制时间' };
      return { toast: '弹出桌面时钟失败' };
    }
  },
};

export function setup(): void {
  pluginRegistry.register(timePlugin);
  // 桌面墙面时钟视图（?view=clock）：App.tsx 依据 ?view= 查表渲染
  registerView(VIEW_ID, ClockWidget);
}
