/**
 * todo 插件视图：日程日历 / 待办管理面板 / 提醒弹窗
 * 注册进核心视图路由表（?view=calendar / ?view=todoapp / ?view=reminder）
 */
import { Component, onMount } from 'solid-js';
import { CalendarApp } from './calendar/CalendarApp';
import { TodoManager } from './TodoManager';
import { ReminderToast } from './ReminderToast';

/**
 * 日历窗口。
 * 视图窗口是插件视图包 import 的裸组件，所以 body 类名在这里自己打，
 * 和 TodoManager 在 onMount 里加 `todoapp-mode` 是同一套路。
 */
export const CalendarView: Component = () => {
  onMount(() => {
    document.body.classList.add('calendar-mode');
  });
  return <CalendarApp />;
};

export const TodoAppView: Component = () => <TodoManager />;

export const ReminderView: Component = () => {
  const params = new URLSearchParams(window.location.search);
  return (
    <ReminderToast
      id={params.get('id') || ''}
      content={params.get('content') || ''}
    />
  );
};
