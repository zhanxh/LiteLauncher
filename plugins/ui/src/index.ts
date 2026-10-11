/**
 * @ll/ui —— LiteLauncher 设计令牌与共享样式（LPS §4.5 之外的样式基座）
 *
 * 引入本包即注入双主题令牌（[data-theme='dark' | 'light']，由 src/theme.ts 切换）。
 * 令牌命名沿用壳层既有约定（--bg-solid / --text-main / --accent-color …），
 * 插件 CSS 一律消费令牌，禁止硬编码颜色。
 */
import "./tokens.css";

export {};
