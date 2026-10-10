import { Component, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { SearchBar } from './components/SearchBar';
import { PreviewCapsule } from './components/PreviewCapsule';
import { ResultPanel } from './components/ResultPanel';
import { Toast } from './components/Toast';
import { NoteEditor } from './components/NoteEditor';
import { ReminderToast } from './components/ReminderToast';
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

interface AppBackendItem {
  id: string;
  name: string;
  path: string;
  icon: string;
  description: string;
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

  // 检查是否为待办提醒弹窗模式 (index.html?view=reminder&id=...&content=...)
  if (urlParams.get('view') === 'reminder') {
    return (
      <ReminderToast
        id={urlParams.get('id') || ''}
        content={urlParams.get('content') || ''}
      />
    );
  }

  const [inputValue, setInputValue] = createSignal('');
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [panelItems, setPanelItems] = createSignal<PanelItem[]>([]);
  const [emptyText, setEmptyText] = createSignal<string>('未检索到内容');
  const [actionCapsule, setActionCapsule] = createSignal<ActionPreviewCapsule | null>(null);
  const [prefixIcon, setPrefixIcon] = createSignal('🔍');
  
  // 调试常驻开关（常驻时不触发失焦隐藏，便于 DevTools 调试）
  const [isDebugPin] = createSignal(false);

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

  // 智能调节窗口物理高度，高度未发生实质变化时不重复触发 IPC，避免 DWM 重复刷新
  let currentWindowHeight = 70;
  const updateWindowHeight = async (targetHeight: number) => {
    if (!isTauriEnvironment()) return;
    if (Math.abs(currentWindowHeight - targetHeight) < 2) return;
    currentWindowHeight = targetHeight;
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

    // 焦点管理状态机：只有在窗口真正获得过焦点之后且过了初次挂载保护期，失焦才执行自动隐藏
    let hasBeenFocused = false;
    let blurTimer: any = null;
    const mountTime = Date.now();

    const handleFocus = () => {
      hasBeenFocused = true;
      if (blurTimer) {
        clearTimeout(blurTimer);
        blurTimer = null;
      }
    };

    const handleBlur = () => {
      // 刚启动的前 1500ms 保护期，防止启动时 Windows 桌面激活冲突导致瞬间误隐藏
      if (Date.now() - mountTime < 1500) return;
      // 若处于常驻模式、尚未聚焦过、或输入框内有草稿内容，则不自动隐藏
      if (isDebugPin() || !hasBeenFocused || inputValue().trim().length > 0) return;
      blurTimer = setTimeout(() => {
        hideWindow();
      }, 250);
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
    const raw = inputValue().trim();
    const result = parseCommand(inputValue());

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

    // 2. 以斜杠开头的显式指令模式，但未完全输入（例如输入 "/"、"/t"）
    if (inputValue().startsWith('/') && result.candidatePlugins.length > 0 && !result.plugin) {
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
      updateWindowHeight(items.length > 0 ? 420 : 70);
      return;
    }

    // 3. 匹配到具体插件（例如 /todo, /note, /app, /help）
    if (result.plugin) {
      setPrefixIcon(result.plugin.icon);

      // 3.1 即时动作模式（Action 模式）
      if (result.parsed.isAction && result.plugin.getPreview) {
        const preview = result.plugin.getPreview(result.parsed);
        setActionCapsule(preview);
        setPanelItems([]);
        updateWindowHeight(preview ? 124 : 70);
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

    // 4. 普通搜索文本或空状态（通用启动器模式：聚合本地应用、系统命令、候选指令与网络搜索）
    setPrefixIcon('🔍');
    setActionCapsule(null);

    if (!raw) {
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
          updateWindowHeight(70);
        }
      });
      return;
    }

    // 4.1 候选指令（模糊匹配到插件触发词或别名，例如输入 "todo" 推荐 /todo）
    const pluginCandidateItems: PanelItem[] = result.candidatePlugins.map((p) => ({
      id: `plugin-${p.id}`,
      title: `${p.trigger} - ${p.name}`,
      description: p.description,
      icon: p.icon,
      badge: '指令',
      metadata: { trigger: p.trigger },
    }));

    // 4.2 系统命令直接运行项
    const cliItem: PanelItem = {
      id: `cli-${raw}`,
      title: `运行系统命令: "${raw}"`,
      description: `调用系统环境执行 "${raw}" 命令或程序`,
      icon: '⚡',
      badge: '系统运行',
      metadata: { command: raw, isCliLaunch: true },
    };

    // 4.3 网络搜索兜底项
    const webItem: PanelItem = {
      id: 'web-search',
      title: `在浏览器中搜索 "${raw}"`,
      description: '调用默认搜索引擎检索互联网',
      icon: '🌐',
      badge: '网络搜索',
      metadata: { query: raw, isWebSearch: true },
    };

    // 4.4 并发异步检索本地应用
    if (isTauriEnvironment()) {
      invoke<AppBackendItem[]>('list_applications', { keyword: raw })
        .then((apps) => {
          // 若异步返回时输入内容已变更，丢弃过时结果
          if (inputValue().trim() !== raw) return;

          const appItems: PanelItem[] = apps.map((a) => ({
            id: `app-${a.id}`,
            title: a.name,
            description: a.description,
            icon: a.icon || '🚀',
            badge: '启动应用',
            metadata: { path: a.path, isAppLaunch: true },
          }));

          // 综合排序：本地应用优先 -> 插件候选 -> 系统运行命令 -> 网络搜索
          const combined = [...appItems, ...pluginCandidateItems, cliItem, webItem];
          setPanelItems(combined);
          setSelectedIndex(0);
          updateWindowHeight(Math.min(70 + combined.length * 62, 420));
        })
        .catch(() => {
          const fallback = [...pluginCandidateItems, cliItem, webItem];
          setPanelItems(fallback);
          setSelectedIndex(0);
          updateWindowHeight(Math.min(70 + fallback.length * 62, 420));
        });
    } else {
      const combined = [...pluginCandidateItems, cliItem, webItem];
      setPanelItems(combined);
      setSelectedIndex(0);
      updateWindowHeight(Math.min(70 + combined.length * 62, 420));
    }
  });

  // 处理 Enter 回车确认
  const handleEnter = async () => {
    const raw = inputValue().trim();
    const result = parseCommand(inputValue());

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

    // 2. Action 即时命令执行（例如 /todo 购买电池 或 /app add "记事本" "notepad"）
    if (result.plugin && result.parsed.isAction && result.plugin.execute) {
      try {
        const res = await result.plugin.execute(result.parsed);
        if (res.success) {
          recordHistory(result.plugin.trigger, result.plugin.id);
          showToast(res.message);
          setInputValue('');
          updateWindowHeight(70);
          hideWindow();
        } else {
          showToast(`❌ ${res.message}`);
        }
      } catch (err: any) {
        showToast(`执行异常: ${err?.message || err}`);
      }
      return;
    }

    // 3. 面板列表项执行
    const items = panelItems();
    if (items.length > 0) {
      const current = items[selectedIndex()];
      if (current) {
        await handleSelectItem(current);
        return;
      }
    }

    // 4. 若无面板项但有非空输入，默认作为系统命令尝试启动
    if (raw && isTauriEnvironment()) {
      try {
        await invoke('launch_application', { path: raw });
        recordHistory(raw, 'cli');
        setInputValue('');
        updateWindowHeight(70);
        hideWindow();
      } catch {
        // 打开浏览器搜索
        const url = `https://www.bing.com/search?q=${encodeURIComponent(raw)}`;
        window.open(url, '_blank');
        setInputValue('');
        updateWindowHeight(70);
        hideWindow();
      }
    }
  };

  // 选中某一项并执行
  const handleSelectItem = async (item: PanelItem) => {
    // 1. 候选指令补全（例如选中 /todo，在输入框填入 "/todo "）
    if (item.metadata?.trigger) {
      setInputValue(item.metadata.trigger + ' ');
      return;
    }

    // 2. 本地应用启动
    if (item.metadata?.isAppLaunch && item.metadata?.path) {
      if (isTauriEnvironment()) {
        try {
          await invoke('launch_application', { path: item.metadata.path });
          recordHistory(item.title, 'app');
          setInputValue('');
          updateWindowHeight(70);
          hideWindow();
          showToast(`已启动: ${item.title}`);
        } catch (err: any) {
          showToast(`启动失败: ${err?.message || err}`);
        }
      } else {
        showToast(`[预览] 启动应用: ${item.metadata.path}`);
      }
      return;
    }

    // 3. 直接系统命令运行
    if (item.metadata?.isCliLaunch && item.metadata?.command) {
      if (isTauriEnvironment()) {
        try {
          await invoke('launch_application', { path: item.metadata.command });
          recordHistory(item.metadata.command, 'cli');
          setInputValue('');
          updateWindowHeight(70);
          hideWindow();
          showToast(`已执行: ${item.metadata.command}`);
        } catch (err: any) {
          showToast(`执行失败: ${err?.message || err}`);
        }
      } else {
        showToast(`[预览] 执行命令: ${item.metadata.command}`);
      }
      return;
    }

    // 4. 浏览器搜索
    if (item.id === 'web-search' || item.metadata?.isWebSearch) {
      const q = item.metadata?.query || inputValue();
      const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
      window.open(url, '_blank');
      setInputValue('');
      updateWindowHeight(70);
      hideWindow();
      return;
    }

    // 5. 插件自身回调（如 /note 弹出独立编辑窗口，或 /todo 切换完成状态）
    const result = parseCommand(inputValue());
    if (result.plugin && result.plugin.onSelect) {
      await result.plugin.onSelect(item);
      recordHistory(result.plugin.trigger, result.plugin.id);

      // 笔记插件：已弹出独立编辑窗口，立即关闭并隐藏主搜索框，归还焦点
      if (result.plugin.id === 'notes') {
        setInputValue('');
        updateWindowHeight(70);
        hideWindow();
        return;
      }

      // 应用插件：已启动应用，立即关闭并隐藏主搜索框
      if (result.plugin.id === 'app') {
        setInputValue('');
        updateWindowHeight(70);
        hideWindow();
        return;
      }

      showToast(`已选择: ${item.title}`);
      // 重新执行查询以刷新待办列表等面板状态
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
