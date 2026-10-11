/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { registerShellPlugins } from "./core/builtin";
import { registerBuiltinPlugins } from "./plugins.generated";

console.log("src/index.tsx executing render...");
// 插件注册先于壳层渲染：视图路由表（?view=）在 App 顶层即需就绪
// 1. 壳层自有指令（/help、/settings）；2. plugins/*/fe 插件包（生成文件，勿手改）
registerShellPlugins();
registerBuiltinPlugins();
render(() => <App />, document.getElementById("root") as HTMLElement);
console.log("src/index.tsx render call completed!");
