/**
 * todo 插件视图：日程日历 / 待办管理面板 / 提醒弹窗 / 日程详情
 * 注册进核心视图路由表（?view=calendar / ?view=todoapp / ?view=reminder / ?view=detail）
 */
import { Component, onMount } from 'solid-js';
import { CalendarApp } from './calendar/CalendarApp';
import { EventDetail, parseDetail } from './calendar/EventDetail';
import { TodoManager } from './TodoManager';
import { ReminderToast } from './ReminderToast';
import { parseReminder } from './remindfmt';

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

/** 提醒卡片：参数全在 URL 上（窗口是宿主按 manifest 直接开的，没有别的通道） */
export const ReminderView: Component = () => (
  <ReminderToast payload={parseReminder(window.location.search)} />
);

export const DetailView: Component = () => {
  const seed = parseDetail(window.location.search);
  // 浏览器 dev 预览没有宿主，动态 import 也拿不到窗口，只在宿主里收口
  const close = () =>
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().destroy())
      .catch(() => undefined);
  return <EventDetail seed={seed} onClose={close} />;
};
