import { Component, Show } from 'solid-js';

interface ToastProps {
  message: string;
  visible: boolean;
}

/**
 * 悬浮操作反馈 Toast 组件
 */
export const Toast: Component<ToastProps> = (props) => {
  return (
    <Show when={props.visible}>
      <div class="toast-container">
        <span>✨</span>
        <span>{props.message}</span>
      </div>
    </Show>
  );
};
