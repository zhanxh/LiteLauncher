import { Component, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { SearchBar } from './components/SearchBar';
import { PreviewCapsule } from './components/PreviewCapsule';
import { ResultPanel } from './components/ResultPanel';
import { Toast } from './components/Toast';
import { SettingsPanel } from './components/SettingsPanel';
import { WelcomePanel } from './components/WelcomePanel';
import { initTheme, listenThemeChange } from './theme';
import { parseCommand } from './core/parser';
import { toUserMessage, rawError } from './core/errors';
import { checkForUpdate } from './core/updater';
import { getPluginContext, pluginRegistry, searchRegistry } from '@ll/sdk';
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

/**
 * 空状态的静态推荐指令。
 *
 * 图标与名称从插件注册表取：插件改名/换图标后这里自动跟随，不会留下
 * 写死的旧文案。选择后只补全输入框（metadata.trigger），不直接执行——
 * 让用户看到参数骨架再决定，比"选中即跑"更可控。
 */
function buildSuggestedItems(): PanelItem[] {
  const specs: Array<{ trigger: string; fallbackIcon: string; description: string }> = [
    { trigger: '/app', fallbackIcon: '🚀', description: '打开已安装应用，支持拼音首字母' },
    { trigger: '/find', fallbackIcon: '🔍', description: '按名称毫秒级搜索文件' },
    { trigger: '/shot', fallbackIcon: '📸', description: '区域截图，图片直接进剪贴板' },
    { trigger: '/clip', fallbackIcon: '📋', description: '找回最近复制的内容' },
    { trigger: '/note', fallbackIcon: '📝', description: '搜索并打开 Markdown 笔记' },
    { trigger: '/cal today', fallbackIcon: '🗓️', description: '直接看今天的日程' },
  ];

  return specs.map(({ trigger, fallbackIcon, description }) => {
    const plugin = pluginRegistry.get(trigger.split(' ')[0]);
    return {
      id: `suggest-${trigger}`,
      title: plugin ? `${trigger} · ${plugin.name}` : trigger,
      description,
      icon: plugin?.icon || fallbackIcon,
      badge: '推荐',
      group: '推荐指令',
      metadata: { trigger },
    };
  });
}

/** 面板底部动作条高度（与 launcher.css 的 .panel-footer 保持一致） */
const PANEL_FOOTER_HEIGHT = 34;
/** 加载骨架/错误态高度：没有旧结果时给面板一个不塌陷的最小高度 */
const PANEL_LOADING_HEIGHT = 220;
const PANEL_ERROR_HEIGHT = 190;

/** 首个可执行项：说明项（kind=info）不参与键盘选中 */
function firstSelectableIndex(items: PanelItem[]): number {
  const index = items.findIndex((item) => item.kind !== 'info');
  return index >= 0 ? index : 0;
}

/** 修饰键 → 动作 id；未按修饰键返回 undefined（走主动作） */
function actionFromMods(
  item: PanelItem | undefined,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean },
): string | undefined {
  if (!item || item.kind === 'info' || !item.actions?.length) return undefined;
  const accel = mods.ctrl
    ? 'ctrl+enter'
    : mods.shift
      ? 'shift+enter'
      : mods.alt
        ? 'alt+enter'
        : undefined;
  if (!accel) return undefined;
  return item.actions.find((action) => action.accel === accel)?.id;
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

  // 首启欢迎引导窗口 (index.html?view=welcome)
  if (viewParam === 'welcome') {
    return <WelcomePanel />;
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

  // 查询态：150ms 后才显示骨架（纯计算插件不闪）；8s 慢查询提示；15s 超时重试
  const [queryLoading, setQueryLoading] = createSignal(false);
  const [querySlow, setQuerySlow] = createSignal(false);
  const [queryError, setQueryError] = createSignal<string | null>(null);
  const [queryNonce, setQueryNonce] = createSignal(0);
  let querySkeletonTimer: ReturnType<typeof setTimeout> | null = null;
  let querySlowTimer: ReturnType<typeof setTimeout> | null = null;
  let queryTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const clearQueryTimers = () => {
    if (querySkeletonTimer !== null) {
      clearTimeout(querySkeletonTimer);
      querySkeletonTimer = null;
    }
    if (querySlowTimer !== null) {
      clearTimeout(querySlowTimer);
      querySlowTimer = null;
    }
    if (queryTimeoutTimer !== null) {
      clearTimeout(queryTimeoutTimer);
      queryTimeoutTimer = null;
    }
  };

  const beginQuery = () => {
    clearQueryTimers();
    setQueryError(null);
    setQuerySlow(false);
    setQueryLoading(false);
    // 没有旧结果时才需要撑住高度；有旧结果就原地等新结果，避免列表跳动
    if (panelItems().length === 0) {
      updateWindowHeight(PANEL_LOADING_HEIGHT);
    }
    querySkeletonTimer = setTimeout(() => setQueryLoading(true), 150);
    querySlowTimer = setTimeout(() => setQuerySlow(true), 8000);
    queryTimeoutTimer = setTimeout(() => {
      setQuerySlow(false);
      setQueryError('查询超过 15 秒仍未返回，可能网络或 Python 环境较慢');
      setPanelItems([]);
      updateWindowHeight(PANEL_ERROR_HEIGHT);
    }, 15000);
  };

  const endQuery = () => {
    clearQueryTimers();
    setQueryLoading(false);
    setQuerySlow(false);
  };

  const resetQueryState = () => {
    endQuery();
    setQueryError(null);
  };

  const retryQuery = () => {
    resetQueryState();
    setQueryNonce((n) => n + 1);
  };
  
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

  // 空态条高度：搜索栏 68 + 一条居中空态文案。此前 query 无结果时窗口撑到 160
  // 而面板因外层条件不渲染，用户看到的是一条空白——空态文案永远到不了屏上。
  const EMPTY_PANEL_HEIGHT = 132;

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

  // 关闭前给 Toast 留出可读时间：复制/执行成功后若与 hideWindow 同帧执行，
  // 窗口瞬间消失，用户根本看不到"已复制"的确认——反馈闭环在这里断掉。
  const hideWindowDelayed = (delayMs = 400) => {
    if (!isTauriEnvironment()) return;
    setTimeout(() => void hideWindow(), delayMs);
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

  /**
   * 首次启动自动打开欢迎引导。
   *
   * 只弹一次：打开成功后才写 `onboarding.version`，这样建窗失败（例如
   * 窗口被系统策略拦截）下次启动还能重试。数量由主窗口取好带进窗口——
   * 欢迎窗自身没有插件调用权限。
   */
  const maybeOpenWelcome = async () => {
    if (!isTauriEnvironment()) return;
    try {
      const seen = await invoke<string | null>('get_setting', { key: 'onboarding.version' });
      if (seen) return;

      // 给后台预热一点时间，让首次启动的目录导入先完成
      await new Promise((resolve) => setTimeout(resolve, 600));

      let apps = 0;
      try {
        const stats = await getPluginContext('apps').call<{ total?: number }>('stats', {});
        apps = stats?.total ?? 0;
      } catch (err) {
        console.warn('读取应用目录统计失败（引导照常打开）:', err);
      }

      // 必须在建欢迎窗**之前**隐藏主窗：主窗是 alwaysOnTop，且启动保护期
      // （1.5s）内失焦不会自动隐藏——不显式隐藏就会盖在欢迎窗上面。
      await invoke('hide_main_window');
      try {
        await invoke('open_welcome_window', { apps: apps > 0 ? apps : null });
      } catch (err) {
        // 建窗失败时把主窗还回来，别让用户面对一个什么都没有的桌面
        await invoke('show_main_window');
        throw err;
      }
      await invoke('set_setting', { key: 'onboarding.version', value: '1' });
    } catch (err) {
      console.warn('打开欢迎引导失败:', err);
    }
  };

  /** 每天最多静默检查一次更新；失败不打扰用户，设置页可手动检查 */
  const autoCheckUpdate = async () => {
    if (!isTauriEnvironment()) return;
    try {
      const last = await invoke<string | null>('get_setting', { key: 'update.lastCheck' });
      if (last && Date.now() - Number(last) < 24 * 3600 * 1000) return;
      await invoke('set_setting', {
        key: 'update.lastCheck',
        value: String(Date.now()),
      });
      const result = await checkForUpdate();
      if (result.available && result.info) {
        showToast(`发现新版本 ${result.info.version}，可在「设置 → 关于」更新`);
      }
    } catch (err) {
      // 自动检查失败保持静默，避免启动时用网络错误打扰用户
      console.warn('自动检查更新失败:', err);
    }
  };

  onMount(() => {
    const updateTimer = setTimeout(() => void autoCheckUpdate(), 5000);
    onCleanup(() => clearTimeout(updateTimer));
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

    // 欢迎引导：首启自动弹一次；欢迎窗点示例时把命令填回主窗口
    let unlistenWelcome: (() => void) | undefined;
    if (isTauriEnvironment()) {
      void listen<{ text: string }>('welcome-command', async (event) => {
        const text = event.payload?.text ?? '';
        if (!text) return;
        setInputValue(text);
        try {
          await invoke('show_main_window');
        } catch (err) {
          console.warn('显示主窗口失败:', err);
        }
      }).then((fn) => {
        unlistenWelcome = fn;
      });
      void maybeOpenWelcome();
    }

    onCleanup(() => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      unlistenWelcome?.();
      if (blurTimer) clearTimeout(blurTimer);
    });
  });

  // 核心响应式监听：解析输入并驱动视图状态与窗口高度
  createEffect(() => {
    void queryNonce();
    resetQueryState();
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
      setSelectedIndex(firstSelectableIndex(items));
      updateWindowHeight(items.length > 0 ? 420 + PANEL_FOOTER_HEIGHT : 70);
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
          beginQuery();
          result.plugin
            .query(result.parsed)
            .then((data) => {
              setPanelItems(data.items);
              setEmptyText(data.emptyText || '');
              setSelectedIndex(firstSelectableIndex(data.items));
              const listHeight = data.items.length > 0 ? Math.min(64 + data.items.length * 56, 460) : 0;
              updateWindowHeight(
                (preview ? 124 : 70) + listHeight + (data.items.length > 0 ? PANEL_FOOTER_HEIGHT : 0),
              );
            })
            .catch((err) => {
              console.error('动作模式查询失败:', rawError(err));
              setQueryError(toUserMessage(err));
              setPanelItems([]);
              updateWindowHeight(PANEL_ERROR_HEIGHT);
            })
            .finally(endQuery);
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
          beginQuery();
          try {
            const data = await plugin.query!(parsed);
            if (queryId !== pluginQuerySeq) return; // 输入已变更 → 丢弃过时结果
            if (data.error) {
              console.error('插件查询失败:', rawError(data.error));
              setQueryError(toUserMessage(data.error));
              setPanelItems([]);
              setEmptyText('');
              updateWindowHeight(PANEL_ERROR_HEIGHT);
              return;
            }
            setQueryError(null);
            setPanelItems(data.items);
            setEmptyText(data.emptyText || '未检索到内容');
            setSelectedIndex(firstSelectableIndex(data.items));
            updateWindowHeight(
              data.items.length > 0 ? 420 + PANEL_FOOTER_HEIGHT : EMPTY_PANEL_HEIGHT,
            );
          } catch (err) {
            if (queryId !== pluginQuerySeq) return; // 过时请求的异常不覆盖新查询
            console.error('插件查询异常:', rawError(err));
            setQueryError(toUserMessage(err));
            setPanelItems([]);
            setEmptyText('');
            updateWindowHeight(PANEL_ERROR_HEIGHT);
          } finally {
            if (queryId === pluginQuerySeq) endQuery();
          }
        };

        // 插件声明了防抖就等它；没声明则保持逐键立即（纯计算插件零延迟）
        const debounce = plugin.queryDebounceMs ?? 0;
        if (pluginQueryTimer !== null) clearTimeout(pluginQueryTimer);
        if (debounce > 0) {
          pluginQueryTimer = setTimeout(() => {
            pluginQueryTimer = null;
            void applyQuery();
          }, debounce);
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
      // 空状态：最近使用 + 声明 searchOnEmpty 的 provider + 静态推荐指令。
      // 三者并行取，任何一个失败都只是少一块，不会让空状态退化成 70px 空框。
      const emptySeq = ++searchSeq;
      const providers = searchRegistry.getAll().filter((p) => p.searchOnEmpty);
      const historyPromise = loadRecentHistory().catch(() => [] as CommandHistoryItem[]);
      const providersPromise = Promise.all(
        providers.map(async (provider) => ({
          provider,
          items: await provider.search('').catch(() => [] as PanelItem[]),
        })),
      );

      void Promise.all([historyPromise, providersPromise]).then(([history, providerResults]) => {
        // 输入已变（用户开始打字）→ 丢弃这批空状态结果
        if (emptySeq !== searchSeq || inputValue().trim() !== '') return;

        const items: PanelItem[] = [];
        for (const h of history.slice(0, 3)) {
          items.push({
            id: `history-${h.input}`,
            title: h.input,
            description: `使用频次: ${h.use_count} 次`,
            icon: '🕒',
            badge: '历史',
            group: '最近使用',
            metadata: { trigger: h.input },
          });
        }
        for (const { provider, items: providerItems } of providerResults) {
          for (const item of providerItems) {
            items.push({
              ...item,
              group: item.group || '常用应用',
              metadata: { ...(item.metadata || {}), providerId: provider.id },
            });
          }
        }
        items.push(...buildSuggestedItems());

        setPanelItems(items);
        setEmptyText('');
        setSelectedIndex(firstSelectableIndex(items));
        // 条目 56px + 组标题约 26px + 底部动作条；上限 514 避免空状态撑满整屏
        updateWindowHeight(
          Math.min(70 + items.length * 56 + 3 * 26 + PANEL_FOOTER_HEIGHT, 514),
        );
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
      searchTimer = null;
      beginQuery();
      const queries = searchRegistry.getAll().map((provider) =>
        provider
          .search(raw)
          .then((items) => ({ provider, items, error: undefined as string | undefined }))
          .catch((err) => ({
            provider,
            items: [] as PanelItem[],
            error: rawError(err),
          })),
      );
      Promise.all(queries)
        .then((settled) => {
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
          const failures = settled.filter((entry) => entry.error);
          setPanelItems(combined);
          setSelectedIndex(firstSelectableIndex(combined));
          if (combined.length === 0 && settled.length > 0 && failures.length === settled.length) {
            setQueryError(toUserMessage(failures[0]?.error));
            updateWindowHeight(PANEL_ERROR_HEIGHT);
          } else if (combined.length > 0) {
            updateWindowHeight(Math.min(70 + combined.length * 62 + PANEL_FOOTER_HEIGHT, 454));
          } else {
            // 无结果也不能缩回一条光杆：给一句明确的空态，而不是沉默
            setEmptyText('未检索到相关内容');
            updateWindowHeight(EMPTY_PANEL_HEIGHT);
          }
        })
        .finally(() => {
          if (queryId === searchSeq) endQuery();
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

  // 处理 Enter 回车确认（带修饰键时优先匹配当前项声明的高级动作）
  const handleEnter = async (mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => {
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
          hideWindowDelayed();
        } else {
          showToast(`❌ ${res.message}`);
        }
      } catch (err) {
        console.error('执行异常:', rawError(err));
        showToast(toUserMessage(err));
      }
      return;
    }

    // 3. 面板列表项执行
    const items = panelItems();
    if (items.length > 0) {
      const current = items[selectedIndex()];
      if (current) {
        await handleSelectItem(current, actionFromMods(current, mods));
        return;
      }
    }
    // 3.1 空面板兜底：没有可执行条目时给一句反馈，否则按回车像卡死一样
    // 毫无反应。聚合搜索在途（searchTimer 非空）时静默，避免误报。
    if (items.length === 0 && searchTimer === null) {
      showToast('没有可执行的条目');
    }
  };

  // 选中某一项并执行；actionId 来自 Ctrl/Shift/Alt + Enter
  const handleSelectItem = async (item: PanelItem, actionId?: string) => {
    // 通用剪贴板能力：插件经 AfterSelect.copy 声明要复制的文本，壳层不理解插件语义。

    // 0. 说明项：只展示不执行，避免"按了没反应"的死条目
    if (item.kind === 'info') {
      showToast('该项仅用于说明');
      return;
    }

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
        try {
          const after = (await provider.onSelect(item, actionId)) || {};
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
            hideWindowDelayed();
          }
        } catch (err) {
          console.error('搜索提供者执行失败:', rawError(err));
          showToast(toUserMessage(err));
        }
      }
      return;
    }

    // 3. 指令插件面板项：壳层行为由插件经 AfterSelect 声明（关窗/清空/提示/刷新/复制）
    const result = parseCommand(inputValue());
    if (result.plugin && result.plugin.onSelect) {
      try {
        const after = (await result.plugin.onSelect(item, actionId)) || {};
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
          hideWindowDelayed();
          return;
        }
        if (after.refresh && result.plugin.query) {
          // 重新执行查询以刷新面板状态（如待办完成状态）
          const data = await result.plugin.query(result.parsed);
          setPanelItems(data.items);
          setSelectedIndex(firstSelectableIndex(data.items));
        }
      } catch (err) {
        console.error('插件选择执行失败:', rawError(err));
        showToast(toUserMessage(err));
      }
    }
  };

  /** 只含可执行项的下标序列：说明项不参与 ↑↓ 导航 */
  const selectableEntries = () =>
    panelItems()
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.kind !== 'info');

  // 键盘向下导航
  const handleArrowDown = () => {
    const list = selectableEntries();
    if (list.length === 0) return;
    const pos = list.findIndex((entry) => entry.index === selectedIndex());
    const next = list[pos < 0 ? 0 : (pos + 1) % list.length];
    setSelectedIndex(next.index);
  };

  // 键盘向上导航
  const handleArrowUp = () => {
    const list = selectableEntries();
    if (list.length === 0) return;
    const pos = list.findIndex((entry) => entry.index === selectedIndex());
    const next = list[pos < 0 ? list.length - 1 : (pos - 1 + list.length) % list.length];
    setSelectedIndex(next.index);
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

      {/* Query 模式或候选指令下的结果面板（含空态条） */}
      {(panelItems().length > 0 || emptyText() || queryError() || queryLoading()) && (
        <ResultPanel
          items={panelItems()}
          selectedIndex={selectedIndex()}
          emptyText={emptyText()}
          loading={queryLoading()}
          slow={querySlow()}
          error={queryError()}
          onRetry={retryQuery}
          onSelectItem={handleSelectItem}
          onHoverIndex={(index) => {
            const item = panelItems()[index];
            if (item && item.kind !== 'info') setSelectedIndex(index);
          }}
        />
      )}

      {/* 操作结果反馈 Toast */}
      <Toast message={toastMessage()} visible={toastVisible()} />
    </div>
  );
};

export default App;
