/**
 * @ll/plugin-hotkey —— /hotkey 全局热键速查表（纯前端插件，backend.kind = "none"）
 *
 * 汇总各插件自报的 `CommandPlugin.hotkeys`，渲染成一张可搜索、可复制的速查表。
 * 分组与格式化逻辑在 ./hotkeys.ts（纯函数，可被 node 测试直接跑）。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';
import { groupHotkeys, prettyAccel, type HotkeyEntry } from './hotkeys';

const PLUGIN_ID = 'hotkey';

/** 遍历全部插件，收集自报的热键（并挂上归属插件信息，便于点击回填） */
function collectEntries(): HotkeyEntry[] {
  const entries: HotkeyEntry[] = [];
  for (const p of pluginRegistry.getAll()) {
    for (const h of p.hotkeys ?? []) {
      entries.push({
        accel: h.accel,
        description: h.description,
        pluginId: p.id,
        trigger: p.trigger,
        pluginName: p.name,
        icon: p.icon,
      });
    }
  }
  return entries;
}

export const hotkeyPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/hotkey',
  name: '全局热键速查',
  description:
    '全局热键速查表：列出当前真正生效的全局热键（免开启动器即可触发）。回车复制对应指令。',
  icon: '⌨️',
  argsHint: '[筛选]',
  examples: ['/hotkey', '/hotkey 截图'],

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const keyword = [input.subcommand ?? '', ...(input.args ?? [])].join(' ').trim().toLowerCase();
    const all = collectEntries();

    if (all.length === 0) {
      return {
        items: [
          {
            id: `${PLUGIN_ID}:empty`,
            title: '当前没有已生效的全局热键',
            description:
              '全局热键需要在插件 manifest 里静态声明 shortcut:<accel> 权限，且注册成功才会出现在这里。',
            badge: '空',
            icon: '⌨️',
          },
        ],
        emptyText: '无全局热键',
      };
    }

    // 关键词同时匹配热键本身、说明文字与归属插件——用户往往只记得其中一项
    const matched = keyword
      ? all.filter((e) =>
          [e.accel, e.description, e.trigger, e.pluginName].some((s) => s.toLowerCase().includes(keyword)),
        )
      : all;

    if (matched.length === 0) {
      return {
        items: [
          {
            id: `${PLUGIN_ID}:none`,
            title: `没有匹配「${keyword}」的全局热键`,
            description: `当前共 ${all.length} 个已生效热键，换个关键词试试`,
            badge: '无匹配',
            icon: '🔍',
          },
        ],
        emptyText: `未找到与「${keyword}」相关的全局热键`,
      };
    }

    // 搜索时打平（用户要的是"找到那一个键"，分组标题只会碍事）；
    // 无搜索时保留分组标题（速查表的价值就在于一眼看全）
    const items: PanelItem[] = keyword
      ? matched.map((e) => makeItem(e))
      : groupHotkeys(matched).flatMap((g) => [
          {
            id: `${PLUGIN_ID}:g:${g.id}`,
            title: g.title,
            description: `${g.entries.length} 个热键`,
            badge: '分组',
            icon: '▸',
          },
          ...g.entries.map((e) => makeItem(e)),
        ]);

    return { items, emptyText: '无全局热键' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    // 分组标题不可执行：明确给反馈，别让用户按了没反应（死条目问题）
    if (item.badge === '分组' || item.badge === '空' || item.badge === '无匹配') {
      return { toast: '该项仅用于说明' };
    }
    const trigger = item.metadata?.trigger;
    if (typeof trigger === 'string' && trigger) {
      return { copy: trigger, toast: `已复制指令 ${trigger}` };
    }
    return { toast: '该项无内容可复制' };
  },
};

function makeItem(e: HotkeyEntry): PanelItem {
  return {
    id: `${PLUGIN_ID}:${e.pluginId}:${e.accel}`,
    title: prettyAccel(e.accel),
    description: e.description,
    badge: e.pluginName,
    icon: e.icon,
    // 回车复制归属指令而不是热键本身：用户拿到 "alt+shift+s" 没法直接用，
    // 拿到 "/shot" 才能粘贴进输入框跑起来
    metadata: { value: e.trigger, trigger: e.trigger },
  };
}

export function setup(): void {
  // 不申请任何宿主能力：数据全部来自插件注册表里的自报字段
  pluginRegistry.register(hotkeyPlugin);
}