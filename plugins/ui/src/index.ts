/**
 * @ll/ui —— LiteLauncher 设计令牌与共享样式（LPS §4.5 之外的样式基座）
 *
 * 引入本包即注入双主题令牌（[data-theme='dark' | 'light']，由 src/theme.ts 切换）。
 * 令牌命名沿用壳层既有约定（--bg-solid / --text-main / --accent-color …），
 * 插件 CSS 一律消费令牌，禁止硬编码颜色。
 */
import './tokens.css';
// 弹出式基窗的样式随包注入，插件不必（也无从）各自 import：
// 一个 bundle 全窗口共享，漏引只会到真机上才发现弹窗样式没生效。
import './popup.css';

export { PopupFrame, type PopupFrameProps } from './PopupFrame';
