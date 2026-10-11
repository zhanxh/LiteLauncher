/**
 * notes 插件视图：独立 Markdown 编辑器窗口
 * 注册进核心视图路由表（?view=editor&path=&title=）
 */
import { Component } from 'solid-js';
import { NoteEditor } from './NoteEditor';

export const EditorView: Component = () => {
  const params = new URLSearchParams(window.location.search);
  return (
    <NoteEditor
      filePath={params.get('path') || ''}
      title={params.get('title') || '未命名笔记'}
    />
  );
};
