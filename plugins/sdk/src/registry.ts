import { CommandPlugin } from './command';

/**
 * 插件注册总线（Plugin Registry）
 * 集中管理所有指令插件实例与快速检索
 */
class PluginRegistry {
  private plugins = new Map<string, CommandPlugin>();

  /**
   * 注册指令插件
   */
  register(plugin: CommandPlugin): void {
    this.plugins.set(plugin.trigger.toLowerCase(), plugin);
  }

  /**
   * 依据确切触发前缀查找插件
   */
  get(trigger: string): CommandPlugin | undefined {
    return this.plugins.get(trigger.toLowerCase());
  }

  /**
   * 依据插件 ID 获取插件
   */
  getById(id: string): CommandPlugin | undefined {
    for (const plugin of this.plugins.values()) {
      if (plugin.id === id) {
        return plugin;
      }
    }
    return undefined;
  }

  /**
   * 获取可对外展示的插件列表（`hidden` 的别名不在内）
   *
   * 补全候选、模糊推荐、`/help` 清单和 `/hotkey` 速查表都走这里，
   * 所以过滤放在源头而不是每个调用点——漏一处就是"列表里出现两行 /cal /todo"。
   * 精确命中别名仍靠 `get('/todo')`，那条路径不经过本方法。
   */
  getAll(): CommandPlugin[] {
    return Array.from(this.plugins.values()).filter((plugin) => !plugin.hidden);
  }

  /**
   * 根据当前输入前缀模糊匹配候选插件
   * 示例：输入 "/not" 匹配到 "/note"
   */
  matchCandidates(inputPrefix: string): CommandPlugin[] {
    const lower = inputPrefix.toLowerCase().trim();
    if (!lower.startsWith('/')) {
      return [];
    }

    return Array.from(this.plugins.values()).filter((plugin) => {
      if (plugin.hidden) return false;
      return (
        plugin.trigger.toLowerCase().startsWith(lower) ||
        plugin.name.toLowerCase().includes(lower.replace('/', ''))
      );
    });
  }
}

export const pluginRegistry = new PluginRegistry();
