import { Component, createSignal, onMount, onCleanup } from 'solid-js';
import { getPluginContext } from '@ll/sdk';
import { PopupFrame } from '@ll/ui';

interface NoteEditorProps {
  filePath: string;
  title: string;
}

const ctx = getPluginContext('notes');

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 轻量 Markdown 解析预览函数（遵循 KISS 原则，支持常用排版）
 */
function renderMarkdownPreview(markdown: string): string {
  let html = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 解析标题
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

  // 解析粗体与斜体
  html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');

  // 解析行内代码
  html = html.replace(/`([^`]+)`/gim, '<code>$1</code>');

  // 解析引用
  html = html.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

  // 解析无序列表
  html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');

  // 换行替换
  html = html.replace(/\n\n/gim, '<p></p>');
  html = html.replace(/\n/gim, '<br/>');

  return html;
}

/**
 * 独立 Markdown 编辑器窗口组件
 */
export const NoteEditor: Component<NoteEditorProps> = (props) => {
  const [content, setContent] = createSignal('');
  const [isSaved, setIsSaved] = createSignal(true);
  const [saveStatusText, setSaveStatusText] = createSignal('已同步');
  const [activeTab, setActiveTab] = createSignal<'split' | 'edit' | 'preview'>('split');

  // 读取文件内容
  const loadFile = async () => {
    if (!props.filePath) return;
    if (isTauri()) {
      try {
        const text = await ctx.call<string>('read', { path: props.filePath });
        setContent(text);
        setIsSaved(true);
        setSaveStatusText('已同步');
      } catch (err) {
        console.error('读取笔记内容失败:', err);
      }
    } else {
      setContent(`# ${props.title}\n\n这是在浏览器预览模式下的 Markdown 编辑测试内容。\n\n- 支持实时渲染\n- 支持快捷键 Ctrl+S 保存\n`);
    }
  };

  // 保存文件内容
  const handleSave = async () => {
    if (!props.filePath) return;
    if (isTauri()) {
      try {
        await ctx.call('save', {
          path: props.filePath,
          content: content(),
        });
        setIsSaved(true);
        setSaveStatusText('已保存 ✓');
        setTimeout(() => setSaveStatusText('已同步'), 2000);
      } catch (err: any) {
        setSaveStatusText(`保存失败: ${err?.message || err}`);
      }
    } else {
      setIsSaved(true);
      setSaveStatusText('[预览] 已保存');
    }
  };

  // 关闭独立编辑器窗口
  const handleClose = async () => {
    if (isTauri()) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().close();
      } catch {
        window.close();
      }
    } else {
      window.close();
    }
  };

  // 监听键盘快捷键：Ctrl+S 保存，Esc 关闭
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    }
  };

  onMount(() => {
    loadFile();
    window.addEventListener('keydown', handleKeyDown);
  });

  onCleanup(() => {
    window.removeEventListener('keydown', handleKeyDown);
  });

  const handleInput = (val: string) => {
    setContent(val);
    setIsSaved(false);
    setSaveStatusText('未保存 *');
  };

  return (
    // 定尺寸窗：文件名在标题栏（宿主 title_param 注入到任务栏，这里同步展示），
    // 保存状态进状态栏；Ctrl+S / Esc 快捷键不经过标题栏，不受收编影响
    <PopupFrame
      fill
      title={<span>📝 {props.title}</span>}
      actions={
        <>
          <div class="editor-tab-switch">
            <button
              class={`tab-btn ${activeTab() === 'split' ? 'active' : ''}`}
              onClick={() => setActiveTab('split')}
            >
              分栏
            </button>
            <button
              class={`tab-btn ${activeTab() === 'edit' ? 'active' : ''}`}
              onClick={() => setActiveTab('edit')}
            >
              编辑
            </button>
            <button
              class={`tab-btn ${activeTab() === 'preview' ? 'active' : ''}`}
              onClick={() => setActiveTab('preview')}
            >
              预览
            </button>
          </div>
          <button class="editor-save-btn" onClick={handleSave} title="保存 (Ctrl+S)">
            💾 保存 (Ctrl+S)
          </button>
        </>
      }
      onClose={() => void handleClose()}
      footer={
        <span class="editor-foot">
          <span class={`editor-save-badge ${isSaved() ? 'saved' : 'unsaved'}`}>
            {saveStatusText()}
          </span>
        </span>
      }
    >
      <div class="editor-window-root">
        {/* 核心工作区 */}
        <main class={`editor-body mode-${activeTab()}`}>
          {/* 左侧编辑区域 */}
          {(activeTab() === 'split' || activeTab() === 'edit') && (
            <div class="editor-pane edit-pane">
              <textarea
                class="editor-textarea"
                value={content()}
                onInput={(e) => handleInput(e.currentTarget.value)}
                placeholder="在此编写 Markdown 笔记..."
                spellcheck={false}
              />
            </div>
          )}

          {/* 右侧实时渲染预览区域 */}
          {(activeTab() === 'split' || activeTab() === 'preview') && (
            <div class="editor-pane preview-pane">
              <div
                class="markdown-rendered-content"
                innerHTML={renderMarkdownPreview(content())}
              />
            </div>
          )}
        </main>
      </div>
    </PopupFrame>
  );
};
