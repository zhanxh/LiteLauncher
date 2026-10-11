/**
 * @ll/plugin-todo 入口：向宿主注册指令、搜索与视图
 */
import { pluginRegistry, registerView } from "@ll/sdk";
import { todoPlugin } from "./todoPlugin";
import { TodoAppView, ReminderView } from "./views";

export function setup(): void {
  pluginRegistry.register(todoPlugin);
  registerView("todoapp", TodoAppView);
  registerView("reminder", ReminderView);
}
