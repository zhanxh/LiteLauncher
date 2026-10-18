/**
 * @ll/plugin-apps 入口：向宿主注册指令与裸文本搜索提供者
 */
import { getPluginContext, pluginRegistry, searchRegistry } from "@ll/sdk";
import { appPlugin, appsLocalProvider, appsSuggestProvider, appsCliProvider, appsWebProvider } from "./appPlugin";

export function setup(): void {
  pluginRegistry.register(appPlugin);
  searchRegistry.register(appsSuggestProvider);
  searchRegistry.register(appsLocalProvider);
  searchRegistry.register(appsCliProvider);
  searchRegistry.register(appsWebProvider);

  // native 插件是懒初始化的：第一次 plugin_call 才跑 init（含目录导入与拼音回填）。
  // 主窗口启动时静默预热一次，让用户第一次输入时目录已经就绪；失败不影响任何功能。
  if (!new URLSearchParams(window.location.search).get("view")) {
    void getPluginContext("apps")
      .call("suggest", { limit: 1 })
      .catch(() => undefined);
  }
}
