/**
 * notes 插件视图：独立编辑器窗口 + 笔记本管理面板
 * 注册进核心视图路由表（?view=editor|manager）
 */
import { Component } from 'solid-js';
import { NoteEditor } from './NoteEditor';
import { NotesManager } from './manager/NotesManager';

export const EditorView: Component = () => {
  const params = new URLSearchParams(window.location.search);
  return (
    <NoteEditor
      filePath={params.get('path') || ''}
      title={params.get('title') || '未命名笔记'}
    />
  );
};

/** /note app 打开的笔记本管理面板（目录树 + 编辑预览） */
export const ManagerView: Component = () => {
  return <NotesManager />;
};
