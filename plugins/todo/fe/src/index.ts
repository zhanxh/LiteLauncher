/**
 * @ll/plugin-todo 入口：向宿主注册指令、搜索与视图
 */
import { pluginRegistry, registerView } from "@ll/sdk";
import { todoAlias, todoPlugin } from "./todoPlugin";
import { CalendarView, TodoAppView, ReminderView } from "./views";

export function setup(): void {
  // 同一个 id 注册两个触发词：/cal 是主名，/todo 是留给老用法的隐藏别名
  pluginRegistry.register(todoPlugin);
  pluginRegistry.register(todoAlias);
  registerView("calendar", CalendarView);
  registerView("todoapp", TodoAppView);
  registerView("reminder", ReminderView);
}
