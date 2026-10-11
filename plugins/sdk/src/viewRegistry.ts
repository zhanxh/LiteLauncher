/**
 * 独立窗口视图注册表（LPS-1 视图路由）
 *
 * App.tsx 依据 ?view= 参数查表渲染，壳层不 import 任何插件视图组件；
 * 各插件在初始化时注册自己的视图（todoapp/reminder/editor…）。
 */
import type { Component } from 'solid-js';

const views = new Map<string, Component>();

export function registerView(id: string, component: Component): void {
  views.set(id, component);
}

export function getView(id: string): Component | undefined {
  return views.get(id);
}
