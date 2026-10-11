/**
 * @ll/plugin-apps 入口：向宿主注册指令与裸文本搜索提供者
 */
import { pluginRegistry, searchRegistry } from "@ll/sdk";
import { appPlugin, appsLocalProvider, appsCliProvider, appsWebProvider } from "./appPlugin";

export function setup(): void {
  pluginRegistry.register(appPlugin);
  searchRegistry.register(appsLocalProvider);
  searchRegistry.register(appsCliProvider);
  searchRegistry.register(appsWebProvider);
}
