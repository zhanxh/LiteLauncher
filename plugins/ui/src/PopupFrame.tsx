/**
 * 弹出式基窗的骨架组件（@ll/ui）
 *
 * 配套 manifest 视图的 `auto_height: true`：宿主开出一个空白窗口，插件把
 * widget 放进这里，就得到"无边框 + 可拖拽 + 高度跟着内容"的弹窗。
 * 头部带 `data-tauri-drag-region="deep"`，由 mountPopup 挂上。
 *
 * ## 什么时候不用它
 * 需要自定义头部（比如 pomo 挂件的悬停展开条）就直接用 `@ll/sdk` 的
 * `mountPopup()`，骨架自己排 —— 基窗的硬保证只有一条：宿主按内容高度收窗口，
 * 壳不该规定插件的内容怎么排。
 *
 * 样式在同目录 popup.css 里，全窗口共享且每条规则都锁在 `body.ll-popup-mode`
 * 下，所以这里不必 import CSS。
 */
import { Show, type Component, type JSX, onCleanup, onMount } from 'solid-js';
import { mountPopup, type PopupHandle } from '@ll/sdk';

export interface PopupFrameProps {
  /** 上报尺寸用的插件 id（= manifest 的 `id`） */
  pluginId: string;
  /** 三者都不传时不渲染头部，由子内容自己带头 */
  title?: JSX.Element;
  actions?: JSX.Element;
  /** 关闭按钮。基窗是无边框窗，没有系统 X，插件不传就等于关不掉 */
  onClose?: () => void;
  children?: JSX.Element;
}

export const PopupFrame: Component<PopupFrameProps> = (props) => {
  let root!: HTMLDivElement;
  let head!: HTMLDivElement;

  const hasHead = () =>
    props.title !== undefined || props.actions !== undefined || props.onClose !== undefined;

  let popup: PopupHandle | undefined;
  onMount(() => {
    popup = mountPopup({
      pluginId: props.pluginId,
      content: root,
      drag: hasHead() ? head : null,
    });
  });
  onCleanup(() => popup?.dispose());

  return (
    <div class="ll-popup-root" ref={root}>
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
      <div class="ll-popup-body">{props.children}</div>
    </div>
  );
};
