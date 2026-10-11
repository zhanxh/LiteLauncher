/**
 * @ll/sdk —— LPS-1 插件前端 SDK 唯一入口
 *
 * 插件 fe 包只允许 import 本包与 solid-js；
 * 壳层（App.tsx）也只通过本包消费插件产物。
 */
export * from "./command";
export * from "./lps";
export * from "./registry";
export * from "./searchRegistry";
export * from "./viewRegistry";
