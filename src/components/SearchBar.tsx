import { Component, onCleanup, onMount } from 'solid-js';

interface SearchBarProps {
  value: string;
  placeholder?: string;
  prefixIcon?: string;
  hasContent: boolean;
  onInput: (val: string) => void;
  /** 回车时带上修饰键：壳层据此匹配 PanelItem.actions 的 accel */
  onEnter: (mods: { ctrl: boolean; shift: boolean; alt: boolean }) => void;
  onArrowDown: () => void;
  onArrowUp: () => void;
  onEscape: () => void;
  onClear: () => void;
}

/** 长按判定阈值：按住超过该时长未松开 → 进入窗口拖拽（否则视为普通点击聚焦） */
const HOLD_DRAG_MS = 250;

/**
 * 启动器核心搜索框组件
 */
export const SearchBar: Component<SearchBarProps> = (props) => {
  let inputRef: HTMLInputElement | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  /** 长按输入框拖拽窗口：按下超过阈值调用 startDragging（短点按仍走原生聚焦/选区） */
  const startHoldDrag = () => {
    clearHoldDrag();
    holdTimer = setTimeout(async () => {
      holdTimer = undefined;
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().startDragging();
      } catch (err) {
        console.warn('窗口拖拽启动失败:', err);
      }
    }, HOLD_DRAG_MS);
  };
  const clearHoldDrag = () => {
    if (holdTimer !== undefined) {
      clearTimeout(holdTimer);
      holdTimer = undefined;
    }
  };

  onMount(() => {
    // 组件挂载时默认获得焦点
    inputRef?.focus();
    setTimeout(() => {
      inputRef?.focus();
    }, 50);

    // 每次窗口重新获得焦点（如快捷键唤起）时，自动强制重定向光标到输入框。
    // DOM 'focus' 事件在 Linux 上 hide→show 后不可靠，改用 Tauri 原生窗口事件兜底。
    const handleWindowFocus = () => {
      setTimeout(() => {
        inputRef?.focus();
      }, 30);
    };
    window.addEventListener('focus', handleWindowFocus);

    let unlistenTauriFocus: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        unlistenTauriFocus = await getCurrentWindow().listen('tauri://focus', () => {
          setTimeout(() => {
            inputRef?.focus();
          }, 30);
        });
      } catch (err) {
        console.warn('tauri://focus 监听失败:', err);
      }
    })();

    onCleanup(() => {
      window.removeEventListener('focus', handleWindowFocus);
      unlistenTauriFocus?.();
      clearHoldDrag();
    });
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.isComposing) return; // 输入法组合中不触发，避免选词回车误执行
      props.onEnter({ ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      props.onEscape();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      props.onArrowDown();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      props.onArrowUp();
    }
  };

  return (
    <div
      class={`search-container ${props.hasContent ? 'has-content' : ''}`}
      data-tauri-drag-region
      onClick={() => inputRef?.focus()}
    >
      <div class="search-prefix-icon" data-tauri-drag-region>{props.prefixIcon || '🔍'}</div>
      <input
        ref={inputRef}
        type="text"
        class="search-input"
        autofocus
        placeholder={props.placeholder || '键入 / 查看支持的指令，或直接搜索与计算...'}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onMouseDown={startHoldDrag}
        onMouseUp={clearHoldDrag}
        onMouseLeave={clearHoldDrag}
        spellcheck={false}
        autocomplete="off"
      />
      <div class="search-actions">
        {props.value ? (
          <button class="clear-btn" onClick={props.onClear} title="清空 (Esc)">
            ✕
          </button>
        ) : (
          <span class="key-hint">Alt+Space</span>
        )}
      </div>
    </div>
  );
};
