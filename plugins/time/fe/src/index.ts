/**
 * @ll/plugin-time —— /time 世界时钟（纯前端，WP-15）
 *
 * 本地时间 + 14 个城市；复制值是 `城市 YYYY-MM-DD HH:MM`，与旧版一致。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';
import { worldTime } from './time';

const PLUGIN_ID = 'time';

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
    '世界时钟：/time 列出主要城市当前时间与相对本地的时差；/time 纽约 只看指定城市；回车复制时间。纯前端，无需 Python。',
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
      };
    }

    const items: PanelItem[] = [
      {
        id: `${PLUGIN_ID}:local`,
        title: snapshot.localTime,
        description: `本地 · ${snapshot.localDate}`,
        badge: '本地',
        icon: '🏠',
        kind: 'info',
      },
    ];
    snapshot.cities.forEach((city, index) => {
      items.push({
        id: `${PLUGIN_ID}:${index}`,
        title: city.time,
        description: `${city.name} · ${city.offset}${city.fallback ? '（夏令时可能不准）' : ''}`,
        badge: city.name,
        icon: '🌍',
        metadata: { value: city.value, label: city.name },
      });
    });
    return { items, emptyText: '无结果' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制 ${item.metadata?.label ?? '时间'}` };
  },
};

export function setup(): void {
  pluginRegistry.register(timePlugin);
}
