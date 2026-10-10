import { Component, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { SearchBar } from './components/SearchBar';
import { PreviewCapsule } from './components/PreviewCapsule';
import { ResultPanel } from './components/ResultPanel';
import { Toast } from './components/Toast';
import { NoteEditor } from './components/NoteEditor';
import { registerBuiltinPlugins } from './plugins';
import { parseCommand } from './core/parser';
import { ActionPreviewCapsule, PanelItem } from './types/command';
import './styles/launcher.css';

/**
 * 判断是否运行在 Tauri 桌面客户端容器中
 */
function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface CommandHistoryItem {
  input: string;
  plugin_id: string;
  used_at: number;
  use_count: number;
}

export const App: Component = () => {
  // 检查是否为独立编辑窗口模式 (index.html?view=editor&path=...&title=...)
  const urlParams = new URLSearchParams(window.location.search);
  const isEditorView = urlParams.get('view') === 'editor';
  const editorPath = urlParams.get('path') || '';
  const editorTitle = urlParams.get('title') || '未命名笔记';

  if (isEditorView) {
    return <NoteEditor filePath={editorPath} title={editorTitle} />;
  }

  const [inputValue, setInputValue] = createSignal('');
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [panelItems, setPanelItems] = createSignal<PanelItem[]>([]);
  const [emptyText, setEmptyText] = createSignal<string>('未检索到内容');
  const [actionCapsule, setActionCapsule] = createSignal<ActionPreviewCapsule | null>(null);
  const [prefixIcon, setPrefixIcon] = createSignal('🔍');
  
  // 调试常驻开关（常驻时不触发失焦隐藏，便于 DevTools 调试）
  const [isDebugPin, setIsDebugPin] = createSignal(false);

  // Toast 反馈状态
  const [toastMessage, setToastMessage] = createSignal('');
  const [toastVisible, setToastVisible] = createSignal(false);

  // 显示 Toast 提示
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setToastVisible(true);
    setTimeout(() => {
      setToastVisible(false);
    }, 2200);
  };

  // 请求 Rust 调整窗口物理高度（具备高度缓存，避免同尺寸重复重绘）
  let lastWindowHeight = 64;
  const updateWindowHeight = async (targetHeight: number) => {
    if (!isTauriEnvironment()) return;
    if (lastWindowHeight === targetHeight) return;
    lastWindowHeight = targetHeight;
    try {
      await invoke('set_main_window_height', { height: targetHeight });
    } catch (err) {
      console.warn('调整窗口高度失败:', err);
    }
  };

  // 隐藏窗口
  const hideWindow = async () => {
    if (!isTauriEnvironment()) return;
    try {
      await invoke('hide_main_window');
    } catch (err) {
      console.warn('隐藏窗口失败:', err);
    }
  };

  // 记录指令使用历史
  const recordHistory = async (inputStr: string, pluginId: string) => {
    if (!isTauriEnvironment()) return;
    try {
      await invoke('record_command_usage', { input: inputStr, pluginId });
    } catch (err) {
      console.warn('记录指令历史失败:', err);
    }
  };

  // 加载高频指令历史（用于空状态智能推荐）
  const loadRecentHistory = async () => {
    if (!isTauriEnvironment()) return [];
    try {
      return await invoke<CommandHistoryItem[]>('get_recent_commands', { limit: 5 });
    } catch {
      return [];
    }
  };

  onMount(() => {
    registerBuiltinPlugins();

    // 失焦自动隐藏处理（生产模式生效，防抖 180ms）
    let blurTimer: any = null;
    const handleBlur = () => {
      if (isDebugPin()) return;
      blurTimer = setTimeout(() => {
        hideWindow();
      }, 180);
    };

    const handleFocus = () => {
      if (blurTimer) {
        clearTimeout(blurTimer);
        blurTimer = null;
      }
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    onCleanup(() => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      if (blurTimer) clearTimeout(blurTimer);
    });
  });

  // 核心响应式监听：解析输入并驱动视图状态与窗口高度
  createEffect(() => {
    const raw = inputValue();
    const result = parseCommand(raw);

    // 1. 数学计算器模式
    if (result.isMathExpression && result.mathResult !== undefined) {
      setPrefixIcon('🧮');
      setActionCapsule({
        title: '数学计算',
        detail: `${raw} = ${result.mathResult}`,
        badge: '即时计算',
        hint: '按 Enter 复制结果',
      });
      setPanelItems([]);
      updateWindowHeight(124);
      return;
    }

    // 2. 候选指令列表推荐模式（例如输入 "/"、"/t"、或直接输入 "todo"）
    if (result.candidatePlugins.length > 0 && !result.plugin) {
      setPrefixIcon('⚡');
      setActionCapsule(null);
      const items: PanelItem[] = result.candidatePlugins.map((p) => ({
        id: p.id,
        title: `${p.trigger} - ${p.name}`,
        description: p.description,
        icon: p.icon,
        badge: '指令',
        metadata: { trigger: p.trigger },
      }));
      setPanelItems(items);
      setEmptyText('未找到匹配指令');
      setSelectedIndex(0);
      updateWindowHeight(items.length > 0 ? 420 : 64);
      return;
    }

    // 3. 匹配到具体插件
    if (result.plugin) {
      setPrefixIcon(result.plugin.icon);

      // 3.1 即时动作模式（Action 模式）
      if (result.parsed.isAction && result.plugin.getPreview) {
        const preview = result.plugin.getPreview(result.parsed);
        setActionCapsule(preview);
        setPanelItems([]);
        updateWindowHeight(preview ? 124 : 64);
        return;
      }

      // 3.2 查询模式（Query 模式）
      setActionCapsule(null);
      if (result.plugin.query) {
        result.plugin.query(result.parsed).then((data) => {
          setPanelItems(data.items);
          setEmptyText(data.emptyText || '未检索到内容');
          setSelectedIndex(0);
          updateWindowHeight(data.items.length > 0 ? 420 : 160);
        });
      }
      return;
    }

    // 4. 普通搜索文本或空状态
    setPrefixIcon('🔍');
    setActionCapsule(null);
    if (!raw.trim()) {
      // 空状态：尝试查询历史常用项
      loadRecentHistory().then((history) => {
        if (history.length > 0 && !inputValue().trim()) {
          const items: PanelItem[] = history.map((h) => ({
            id: `history-${h.input}`,
            title: h.input,
            description: `使用频次: ${h.use_count} 次`,
            icon: '🕒',
            badge: '历史',
            metadata: { trigger: h.input },
          }));
          setPanelItems(items);
          setSelectedIndex(0);
          updateWindowHeight(260);
        } else {
          setPanelItems([]);
          updateWindowHeight(64);
        }
      });
    } else {
      // 默认搜索引擎快捷
      setPanelItems([
        {
          id: 'web-search',
          title: `在浏览器中搜索 "${raw}"`,
          description: '调用默认搜索引擎检索互联网',
          icon: '🌐',
          badge: '网络搜索',
          metadata: { query: raw },
        },
      ]);
      setSelectedIndex(0);
      updateWindowHeight(150);
    }
  });

  // 处理 Enter 回车确认
  const handleEnter = async () => {
    const raw = inputValue();
    const result = parseCommand(raw);

    // 1. 数学计算复制
    if (result.isMathExpression && result.mathResult !== undefined) {
      try {
        await navigator.clipboard.writeText(result.mathResult);
        showToast(`已复制结果: ${result.mathResult}`);
      } catch {
        showToast(`计算结果: ${result.mathResult}`);
      }
      return;
    }

    // 2. 候选指令补全选中
    if (result.candidatePlugins.length > 0 && !result.plugin) {
      const items = panelItems();
      const current = items[selectedIndex()];
      if (current && current.metadata?.trigger) {
        setInputValue(current.metadata.trigger + ' ');
      }
      return;
    }

    // 3. Action 即时命令执行
    if (result.plugin && result.parsed.isAction && result.plugin.execute) {
      try {
        const res = await result.plugin.execute(result.parsed);
        if (res.success) {
          recordHistory(result.plugin.trigger, result.plugin.id);
          showToast(res.message);
          setInputValue('');
        } else {
          showToast(`❌ ${res.message}`);
        }
      } catch (err: any) {
        showToast(`执行异常: ${err?.message || err}`);
      }
      return;
    }

    // 4. Query 模式下选中项执行
    const items = panelItems();
    if (items.length > 0) {
      const current = items[selectedIndex()];
      if (current) {
        handleSelectItem(current);
      }
    }
  };

  // 选中某一项
  const handleSelectItem = async (item: PanelItem) => {
    // 候选指令补全
    if (item.metadata?.trigger) {
      setInputValue(item.metadata.trigger + ' ');
      return;
    }

    // 浏览器搜索
    if (item.id === 'web-search' && item.metadata?.query) {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(item.metadata.query)}`;
      window.open(url, '_blank');
      hideWindow();
      return;
    }

    // 插件自身回调
    const result = parseCommand(inputValue());
    if (result.plugin && result.plugin.onSelect) {
      await result.plugin.onSelect(item);
      recordHistory(result.plugin.trigger, result.plugin.id);
      showToast(`已选择: ${item.title}`);
      // 重新执行查询以刷新面板状态
      if (result.plugin.query) {
        const data = await result.plugin.query(result.parsed);
        setPanelItems(data.items);
      }
    }
  };

  // 键盘向下导航
  const handleArrowDown = () => {
    const len = panelItems().length;
    if (len === 0) return;
    setSelectedIndex((prev) => (prev + 1) % len);
  };

  // 键盘向上导航
  const handleArrowUp = () => {
    const len = panelItems().length;
    if (len === 0) return;
    setSelectedIndex((prev) => (prev - 1 + len) % len);
  };

  // Esc 键逻辑：有文字则清空；为空则隐藏窗口
  const handleEscape = () => {
    if (inputValue().length > 0) {
      setInputValue('');
    } else {
      hideWindow();
    }
  };

  return (
    <div class="launcher-root">
      {/* 顶部搜索栏 */}
      <SearchBar
        value={inputValue()}
        prefixIcon={prefixIcon()}
        hasContent={!!inputValue() || panelItems().length > 0 || !!actionCapsule()}
        onInput={setInputValue}
        onEnter={handleEnter}
        onArrowDown={handleArrowDown}
        onArrowUp={handleArrowUp}
        onEscape={handleEscape}
        onClear={() => setInputValue('')}
      />

      {/* Action 模式下的实时语义预览胶囊 */}
      {actionCapsule() && (
        <PreviewCapsule
          capsule={actionCapsule()!}
          onExecute={handleEnter}
        />
      )}

      {/* Query 模式或候选指令下的结果面板 */}
      {panelItems().length > 0 && (
        <ResultPanel
          items={panelItems()}
          selectedIndex={selectedIndex()}
          emptyText={emptyText()}
          onSelectItem={handleSelectItem}
        />
      )}

      {/* 操作结果反馈 Toast */}
      <Toast message={toastMessage()} visible={toastVisible()} />
    </div>
  );
};

export default App;
