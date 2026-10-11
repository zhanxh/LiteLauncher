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
   * 获取所有已注册的插件列表
   */
  getAll(): CommandPlugin[] {
    return Array.from(this.plugins.values());
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
      return (
        plugin.trigger.toLowerCase().startsWith(lower) ||
        plugin.name.toLowerCase().includes(lower.replace('/', ''))
      );
    });
  }
}

export const pluginRegistry = new PluginRegistry();
