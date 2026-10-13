import { Component, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { SearchBar } from './components/SearchBar';
import { PreviewCapsule } from './components/PreviewCapsule';
import { ResultPanel } from './components/ResultPanel';
import { Toast } from './components/Toast';
import { SettingsPanel } from './components/SettingsPanel';
import { initTheme, listenThemeChange } from './theme';
import { parseCommand } from './core/parser';
import { searchRegistry } from '@ll/sdk';
import { getView } from '@ll/sdk';
import { ActionPreviewCapsule, PanelItem } from '@ll/sdk';
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
  // 主题：每个窗口加载时读取设置并应用，同时监听其他窗口的主题切换广播
  void initTheme().then(() => listenThemeChange());

  // 独立窗口视图路由：查插件注册表（壳层不 import 任何插件视图组件）
  const urlParams = new URLSearchParams(window.location.search);
  const viewParam = urlParams.get('view');
  if (viewParam) {
    const ViewComponent = getView(viewParam);
    if (ViewComponent) {
      return <ViewComponent />;
    }
  }

  // 应用设置面板窗口 (index.html?view=settings，核心设置中心)
  if (viewParam === 'settings') {
    return <SettingsPanel />;
  }

  const [inputValue, setInputValue] = createSignal('');
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  // 裸文本聚合搜索的防抖计时器与查询序号（陈旧结果取消）
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchSeq = 0;
  // 指令插件 query() 的防抖计时器：插件可声明 queryDebounceMs 覆盖默认 0（立即）
  // 见 CommandPlugin.queryDebounceMs——网络类插件靠它把"两次回车"变回"输入即出结果"
  let pluginQueryTimer: ReturnType<typeof setTimeout> | null = null;
  let pluginQuerySeq = 0;
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
        // 参数提示拼在描述尾部：新用户往往不知道 `/shot -d3` 怎么写，
        // 直接把语法骨架摆出来能省掉一次试错
        description: p.argsHint ? `${p.description}　用法：${p.trigger} ${p.argsHint}` : p.description,
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

        // 插件声明 showItemsInActionMode 时（如 /app add），在胶囊下方同步展示候选列表
        if (result.plugin.showItemsInActionMode && result.plugin.query) {
          result.plugin.query(result.parsed).then((data) => {
            setPanelItems(data.items);
            setEmptyText(data.emptyText || '');
            setSelectedIndex(0);
            const listHeight = data.items.length > 0 ? Math.min(64 + data.items.length * 56, 460) : 0;
            updateWindowHeight((preview ? 124 : 70) + listHeight);
          });
        } else {
          setPanelItems([]);
          updateWindowHeight(preview ? 124 : 70);
        }
        return;
      }

      // 3.2 查询模式（Query 模式）
      setActionCapsule(null);
      if (result.plugin.query) {
        const plugin = result.plugin;
        const parsed = result.parsed;
        const queryId = ++pluginQuerySeq;

        // 应用结果：序号校验保证陈旧响应被丢弃（防抖后并发窗口更大，必须查）
        const applyQuery = async () => {
          const data = await plugin.query!(parsed);
          if (queryId !== pluginQuerySeq) return; // 输入已变更 → 丢弃过时结果
          setPanelItems(data.items);
          setEmptyText(data.emptyText || '未检索到内容');
          setSelectedIndex(0);
          updateWindowHeight(data.items.length > 0 ? 420 : 160);
        };

        // 插件声明了防抖就等它；没声明则保持逐键立即（纯计算插件零延迟）
        const debounce = plugin.queryDebounceMs ?? 0;
        if (pluginQueryTimer !== null) clearTimeout(pluginQueryTimer);
        if (debounce > 0) {
          pluginQueryTimer = setTimeout(() => void applyQuery(), debounce);
        } else {
          void applyQuery();
        }
      }
      return;
    }

    // 4. 普通搜索文本或空状态（聚合所有 SearchProvider + 候选指令，壳层无任何搜索业务）
    setPrefixIcon('🔍');
    setActionCapsule(null);
    // 离开指令模式：作废待触发的防抖查询，否则它会在裸文本搜索期间
    // 把上一个插件的结果刷进面板（序号校验拦得住结果，拦不住这次副作用）
    if (pluginQueryTimer !== null) {
      clearTimeout(pluginQueryTimer);
      pluginQueryTimer = null;
      pluginQuerySeq++;
    }

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
      description: p.argsHint ? `${p.description}　用法：${p.trigger} ${p.argsHint}` : p.description,
      icon: p.icon,
      badge: '指令',
      metadata: { trigger: p.trigger },
    }));

    // 4.2 并行聚合搜索提供者（R1 按键扇出预算：50ms debounce + 陈旧结果取消）
    const queryId = ++searchSeq;
    if (searchTimer !== null) {
      clearTimeout(searchTimer);
    }
    searchTimer = setTimeout(() => {
      const queries = searchRegistry.getAll().map((provider) =>
        provider
          .search(raw)
          .then((items) => ({ provider, items }))
          .catch(() => ({ provider, items: [] as PanelItem[] })),
      );
      Promise.all(queries).then((settled) => {
        // 异步返回时输入已变更 → 丢弃过时结果
        if (queryId !== searchSeq || inputValue().trim() !== raw) return;

        const providerItems: PanelItem[] = [];
        for (const { provider, items } of settled) {
          for (const item of items) {
            providerItems.push({
              ...item,
              metadata: { ...(item.metadata || {}), providerId: provider.id },
            });
          }
        }

        // 综合排序：搜索提供者（priority 序）→ 候选指令
        const combined = [...providerItems, ...pluginCandidateItems];
        setPanelItems(combined);
        setSelectedIndex(0);
        updateWindowHeight(Math.min(70 + combined.length * 62, 420));
      });
    }, 50);
  });

  /**
   * 壳层唯一的剪贴板写入口（G-1：此前数学结果走 navigator.clipboard，
   * 插件 copy 走宿主 clipboard_write，两套实现行为不一致——窗口即将隐藏时
   * webview 的 navigator.clipboard 会被策略拒绝，表现为"有时能复制有时不能"）。
   *
   * 优先走宿主原生命令：它是同步落剪贴板的，不受窗口可见性影响；
   * 浏览器预览环境（无 Tauri）才退回navigator.clipboard。
   */
  const applyCopy = async (text?: string) => {
    if (!text) return;
    try {
      if (isTauriEnvironment()) {
        await invoke('clipboard_write', { text });
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      showToast('复制失败（剪贴板不可用）');
    }
  };

  // 处理 Enter 回车确认
  const handleEnter = async () => {
    const result = parseCommand(inputValue());

    // 1. 数学计算复制（与插件 copy 共用同一入口，避免两套实现的差异）
    if (result.isMathExpression && result.mathResult !== undefined) {
      await applyCopy(result.mathResult);
      showToast(`已复制结果: ${result.mathResult}`);
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

    // 3. 面板列表项执行（cli/web 兜底 provider 恒有产出，无需额外 fallback）
    const items = panelItems();
    if (items.length > 0) {
      const current = items[selectedIndex()];
      if (current) {
        await handleSelectItem(current);
        return;
      }
    }
  };

  // 选中某一项并执行
  const handleSelectItem = async (item: PanelItem) => {
    // 通用剪贴板能力：插件经 AfterSelect.copy 声明要复制的文本，壳层不理解插件语义。

    // 1. 候选指令补全（例如选中 /todo，在输入框填入 "/todo "）
    if (item.metadata?.trigger) {
      // 参数提示只展示在面板项描述里，**不塞进输入框**——塞进去的话
      // 用户还得手动删掉，等于凭空多一步
      setInputValue(item.metadata.trigger + ' ');
      return;
    }

    // 2. 裸文本搜索提供者条目：选中行为由提供者 onSelect 声明（壳层无业务特判）
    if (item.metadata?.providerId) {
      const provider = searchRegistry.getById(item.metadata.providerId as string);
      if (provider?.onSelect) {
        const after = (await provider.onSelect(item)) || {};
        recordHistory(item.title, provider.id);
        await applyCopy(after.copy);
        if (after.toast) {
          showToast(after.toast);
        }
        if (after.clearInput ?? after.close) {
          setInputValue('');
        }
        if (after.close) {
          updateWindowHeight(70);
          hideWindow();
        }
      }
      return;
    }

    // 3. 指令插件面板项：壳层行为由插件经 AfterSelect 声明（关窗/清空/提示/刷新/复制）
    const result = parseCommand(inputValue());
    if (result.plugin && result.plugin.onSelect) {
      const after = (await result.plugin.onSelect(item)) || {};
      recordHistory(result.plugin.trigger, result.plugin.id);

      await applyCopy(after.copy);
      if (after.toast) {
        showToast(after.toast);
      }
      if (after.clearInput ?? after.close) {
        setInputValue('');
      }
      if (after.close) {
        updateWindowHeight(70);
        hideWindow();
        return;
      }
      if (after.refresh && result.plugin.query) {
        // 重新执行查询以刷新面板状态（如待办完成状态）
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
