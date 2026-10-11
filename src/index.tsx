/* @refresh reload */
import { render } from "solid-js/web";
import "@ll/ui";
import App from "./App";
import { registerShellPlugins } from "./core/builtin";
import { registerBuiltinPlugins } from "./plugins.generated";
import { registerExternalPlugins } from "./core/externalPlugins";

console.log("src/index.tsx executing render...");
// 插件注册先于壳层渲染：视图路由表（?view=）在 App 顶层即需就绪
// 1. 壳层自有指令（/help、/settings）；2. plugins/*/fe 插件包（生成文件，勿手改）；
// 3. extplugins 外部插件（LLP，异步注册——清单就绪后指令立即可用）
registerShellPlugins();
registerBuiltinPlugins();
void registerExternalPlugins();
render(() => <App />, document.getElementById("root") as HTMLElement);
console.log("src/index.tsx render call completed!");
