/**
 * 通用基窗的骨架组件（@ll/ui）
 *
 * 标准窗口的三段式结构，只有内容区滚动：
 *
 *     ┌────────────────────────┐
 *     │ 标题栏  [按钮] [按钮] ✕ │ ← 可隐藏；整行是拖拽区
 *     ├────────────────────────┤
 *     │ 内容区（唯一的滚动区）    │ ← 超高时只有这里出滚动条
 *     ├────────────────────────┤
 *     │ 状态栏  [按钮]          │ ← 可隐藏；放操作按钮或状态文案
 *     └────────────────────────┘
 *
 * 两种用法由 `fill` 切换：
 * - `auto_height` 视图（默认）：窗口高度跟着内容走，mountPopup 把
 *   "标题 + 内容自然高 + 状态栏"报回宿主，超过 `max_height` 后内容区内部滚动；
 * - `fill`（日历、设置这类定尺寸窗）：窗口大小归用户/宿主，内容撑满窗口，
 *   不上报高度（`pluginId` 都不用给——报了也会被宿主以"未声明 auto_height"拒掉）。
 *
 * 需要完全自定义骨架（比如 pomo 挂件的悬停展开条）就直接用 `@ll/sdk` 的
 * `mountPopup()`；基窗的硬保证只有一条：auto_height 下宿主按内容高度收窗口。
 *
 * 样式在同目录 popup.css 里，全窗口共享且每条规则都锁在 `body.ll-popup-mode`
 * 下，所以这里不必 import CSS。
 */
import { Show, type Component, type JSX, onCleanup, onMount } from 'solid-js';
import { mountPopup, type PopupHandle } from '@ll/sdk';

export interface PopupFrameProps {
  /**
   * 上报尺寸用的插件 id（= manifest 的 `id`）。`fill` 模式下不需要；
   * 不传且非 fill 时只借骨架（浏览器预览态也没有宿主可上报）。
   */
  pluginId?: string;
  /** 定尺寸窗口：内容撑满窗口、不上报高度（日历/设置这类可 resize 窗） */
  fill?: boolean;
  /** 三者都不传时不渲染标题栏，由子内容自己带头 */
  title?: JSX.Element;
  actions?: JSX.Element;
  /** 关闭按钮。基窗是无边框窗，没有系统 X，插件不传就等于关不掉 */
  onClose?: () => void;
  /** 状态栏：操作按钮或状态文案，与内容一起构成标准三段式 */
  footer?: JSX.Element;
  children?: JSX.Element;
}

export const PopupFrame: Component<PopupFrameProps> = (props) => {
  let head!: HTMLDivElement;
  let inner!: HTMLDivElement;
  let foot!: HTMLDivElement;

  const hasHead = () =>
    props.title !== undefined || props.actions !== undefined || props.onClose !== undefined;

  let popup: PopupHandle | undefined;
  onMount(() => {
    popup = mountPopup({
      // fill 模式没有可上报的高度，不传 pluginId = mountPopup 只管骨架
      pluginId: props.fill ? undefined : props.pluginId,
      content: inner,
      // 三段式下窗口高度是三段之和，没有单个元素量得出来
      measure: () =>
        (hasHead() ? head.offsetHeight : 0) + inner.offsetHeight + (props.footer ? foot.offsetHeight : 0),
      // 内容被窗口夹住时 inner 可能不动，头尾的高度变化也要算内容变化
      watch: [ ...(hasHead() ? [head] : []), ...(props.footer ? [foot] : []) ],
      drag: hasHead() ? head : null,
    });
  });
  onCleanup(() => popup?.dispose());

  return (
    <div class="ll-popup-root" classList={{ 'll-popup-root--fill': !!props.fill }}>
      <Show when={hasHead()}>
        <div class="ll-popup-head" ref={head}>
          <span class="ll-popup-title">{props.title}</span>
          <span class="ll-popup-space" />
          <Show when={props.actions}>
            <span class="ll-popup-actions">{props.actions}</span>
          </Show>
          <Show when={props.onClose}>
            <button type="button" class="ll-popup-x" onClick={() => props.onClose?.()}>
              ×
            </button>
          </Show>
        </div>
      </Show>
      <div class="ll-popup-body">
        <div class="ll-popup-body-inner" ref={inner}>
          {props.children}
        </div>
      </div>
      <Show when={props.footer}>
        <div class="ll-popup-foot" ref={foot}>
          {props.footer}
        </div>
      </Show>
    </div>
  );
};
