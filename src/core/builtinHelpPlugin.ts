import { CommandPlugin, ParsedInput, PanelData } from '@ll/sdk';
import { pluginRegistry } from '@ll/sdk';

/**
 * 帮助指令插件：/help
 *
 * 存在的意义不是"列出有哪些指令"（候选面板已经能做），而是回答新用户
 * 最具体的那个问题：**这个指令到底怎么写？**
 * 因此这里只做两件事：可搜索的指令清单 + 插件声明的真实用法示例
 * （CommandPlugin.examples / argsHint）。作者把语法写在 description 里，
 * 结构化后新用户可以直接照抄，省掉"试一次错一次"的往返。
 */
export const helpPlugin: CommandPlugin = {
  id: 'help',
  trigger: '/help',
  name: '帮助指南',
  description: '查看所有支持的指令与真实用法示例；也可以 /help 关键词 过滤',
  icon: '💡',

  isAction(_input: ParsedInput): boolean {
    return false;
  },

  async query(input: ParsedInput): Promise<PanelData> {
    // 复用壳层的分词结果：subcommand + args 拼回用户实际输入的关键词
    const raw = [input.subcommand ?? '', ...(input.args ?? [])].join(' ').trim();
    const keyword = raw.toLowerCase();
    const plugins = pluginRegistry.getAll();

    const items = plugins
      .filter((p) => p.id !== 'help')
      .filter((p) => {
        if (!keyword) return true;
        return (
          p.trigger.toLowerCase().includes(keyword) ||
          p.name.toLowerCase().includes(keyword) ||
          (p.description ?? '').toLowerCase().includes(keyword) ||
          // 示例也要能被搜到：用户往往记不清指令名，但记得"框选""缩放"这类用法词
          (p.examples ?? []).some((e) => e.toLowerCase().includes(keyword)) ||
          (p.argsHint ?? '').toLowerCase().includes(keyword)
        );
      })
      .map((p) => {
        // 有示例就逐条列出来——这是 /help 相对候选面板的核心增量
        const examples = p.examples ?? [];
        const hotkeys = p.hotkeys ?? [];
        const detail = [
          p.description,
          p.argsHint ? `用法：${p.trigger} ${p.argsHint}` : '',
          examples.length > 0 ? examples.map((e) => `· ${e}`).join('\n') : '',
          // 有全局热键的在这里就点明，用户不必先去 /hotkey 查
          hotkeys.length > 0 ? `全局热键：${hotkeys.map((h) => h.accel).join('、')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          id: p.id,
          title: `${p.trigger} - ${p.name}`,
          description: detail,
          icon: p.icon,
          // 有示例的标出来，用户一眼知道哪些能直接照抄；有热键的补一个标记
          badge: [
            examples.length > 0 ? `${examples.length} 个示例` : '',
            hotkeys.length > 0 ? `${hotkeys.length} 个热键` : '',
          ]
            .filter(Boolean)
            .join(' · ') || '指令',
          // 选中即把该指令补进输入框，接着就能试
          metadata: { trigger: p.trigger },
        };
      });

    return {
      items,
      emptyText: keyword ? `未找到与「${raw}」相关的指令` : '暂无可用指令',
    };
  },
};
