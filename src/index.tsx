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
// 全屏遮罩视图（宿主给 `transparent: true` 的视图加了 ?transparent=1）：
// 先摘掉全局不透明底色，否则遮罩层会盖成一整块纯色——这是截图框选层
// "一片黑、看不到桌面"的直接原因。
if (new URLSearchParams(window.location.search).get('transparent') === '1') {
  document.documentElement.classList.add('ll-transparent');
}

registerShellPlugins();
registerBuiltinPlugins();
void registerExternalPlugins();
render(() => <App />, document.getElementById("root") as HTMLElement);
console.log("src/index.tsx render call completed!");
