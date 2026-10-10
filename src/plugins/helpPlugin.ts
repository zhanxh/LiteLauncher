import { CommandPlugin, ParsedInput, PanelData } from '../types/command';
import { pluginRegistry } from '../core/registry';

/**
 * 帮助指令插件：/help
 */
export const helpPlugin: CommandPlugin = {
  id: 'help',
  trigger: '/help',
  name: '帮助指南',
  description: '查看所有支持的指令与使用语法说明',
  icon: '💡',

  isAction(_input: ParsedInput): boolean {
    return false;
  },

  async query(input: ParsedInput): Promise<PanelData> {
    const keyword = input.queryText.toLowerCase();
    const plugins = pluginRegistry.getAll();

    const items = plugins
      .filter((p) => p.id !== 'help')
      .map((p) => ({
        id: p.id,
        title: `${p.trigger} - ${p.name}`,
        description: p.description,
        icon: p.icon,
        badge: '指令',
      }))
      .filter((item) => {
        if (!keyword) return true;
        return (
          item.title.toLowerCase().includes(keyword) ||
          (item.description && item.description.toLowerCase().includes(keyword))
        );
      });

    return {
      items,
      emptyText: '未找到匹配的指令说明',
    };
  },
};
