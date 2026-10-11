/**
 * 壳层自有指令插件：/help（指令发现）与 /settings（设置中心）
 * 属核心能力（设计 §2），不参与插件包体系，但复用 CommandPlugin 契约
 */
import { pluginRegistry } from "@ll/sdk";
import { helpPlugin } from "./builtinHelpPlugin";
import { settingPlugin } from "./builtinSettingPlugin";

export function registerShellPlugins(): void {
  pluginRegistry.register(helpPlugin);
  pluginRegistry.register(settingPlugin);
}
