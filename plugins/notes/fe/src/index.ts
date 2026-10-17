/**
 * @ll/plugin-notes 入口：向宿主注册指令与编辑器/管理面板视图
 */
import { pluginRegistry, registerView } from "@ll/sdk";
import { notesPlugin } from "./notesPlugin";
import { EditorView, ManagerView } from "./views";

export function setup(): void {
  pluginRegistry.register(notesPlugin);
  registerView("editor", EditorView);
  registerView("manager", ManagerView);
}
