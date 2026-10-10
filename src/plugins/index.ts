import { pluginRegistry } from '../core/registry';
import { helpPlugin } from './helpPlugin';
import { todoPlugin } from './todoPlugin';
import { notesPlugin } from './notesPlugin';
import { appPlugin } from './appPlugin';

/**
 * 初始化并注册所有内置指令插件
 */
export function registerBuiltinPlugins(): void {
  pluginRegistry.register(helpPlugin);
  pluginRegistry.register(todoPlugin);
  pluginRegistry.register(notesPlugin);
  pluginRegistry.register(appPlugin);
}
