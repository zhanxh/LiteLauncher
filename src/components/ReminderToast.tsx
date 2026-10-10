import { Component, onMount, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import '../styles/reminder.css';

interface ReminderToastProps {
  id: string;
  content: string;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 弹窗自动关闭时长（与 Rust 侧兜底关闭线程保持一致的前置量） */
const AUTO_CLOSE_MS = 12000;

/**
 * 待办提醒桌面右下角弹窗（无边框置顶小窗口的内容视图）
 * 点击任意位置关闭；12 秒后自动消失
 */
export const ReminderToast: Component<ReminderToastProps> = (props) => {
  let closed = false;

  const closeWindow = async () => {
    if (closed) return;
    closed = true;
    if (isTauri()) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().close();
      } catch (err) {
        console.error('关闭提醒弹窗失败:', err);
      }
    }
  };

  onMount(() => {
    // 限定作用域：仅本弹窗窗口重置 body 背景/滚动（css 规则随主 bundle 全局加载）
    document.body.classList.add('reminder-mode');
    const timer = setTimeout(() => void closeWindow(), AUTO_CLOSE_MS);
    onCleanup(() => {
      clearTimeout(timer);
      document.body.classList.remove('reminder-mode');
    });
  });

  const markHandled = async () => {
    // 通知应用侧该提醒已被用户看到并处理（仅记录日志，失败不影响关闭）
    if (isTauri()) {
      try {
        await invoke('record_fe_log', { msg: `ReminderPopup dismissed id=${props.id}` });
      } catch {
        /* 忽略 */
      }
    }
  };

  const onDismiss = () => {
    void markHandled();
    void closeWindow();
  };

  return (
    <div class="reminder-toast" onClick={onDismiss} title="点击关闭">
      <div class="reminder-toast-header">
        <span class="reminder-toast-icon">⏰</span>
        <span class="reminder-toast-title">待办提醒</span>
        <span class="reminder-toast-time">{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="reminder-toast-body">{props.content}</div>
      <div class="reminder-toast-footer">
        <span class="reminder-toast-hint">点击任意位置关闭 · 12 秒后自动消失</span>
      </div>
      <div class="reminder-toast-progress" />
    </div>
  );
};
