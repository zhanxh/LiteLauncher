/**
 * @ll/plugin-ai 入口：向宿主注册 /ai 指令与对话窗口视图
 */
import { pluginRegistry, registerView } from '@ll/sdk';
import { aiPlugin } from './aiPlugin';
import { ChatView } from './ChatView';

export function setup(): void {
  pluginRegistry.register(aiPlugin);
  registerView('chat', ChatView);
}
