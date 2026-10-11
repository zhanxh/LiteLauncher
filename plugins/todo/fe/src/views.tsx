/**
 * todo 插件视图：待办管理面板 / 提醒弹窗
 * 注册进核心视图路由表（?view=todoapp / ?view=reminder）
 */
import { Component } from 'solid-js';
import { TodoManager } from './TodoManager';
import { ReminderToast } from './ReminderToast';

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
