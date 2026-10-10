import { Component, onMount } from 'solid-js';

interface SearchBarProps {
  value: string;
  placeholder?: string;
  prefixIcon?: string;
  hasContent: boolean;
  onInput: (val: string) => void;
  onEnter: () => void;
  onArrowDown: () => void;
  onArrowUp: () => void;
  onEscape: () => void;
  onClear: () => void;
}

/**
 * 启动器核心搜索框组件
 */
export const SearchBar: Component<SearchBarProps> = (props) => {
  let inputRef: HTMLInputElement | undefined;

  onMount(() => {
    // 组件挂载时默认获得焦点
    inputRef?.focus();
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      props.onEnter();
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
    <div class={`search-container ${props.hasContent ? 'has-content' : ''}`}>
      <div class="search-prefix-icon">{props.prefixIcon || '🔍'}</div>
      <input
        ref={inputRef}
        type="text"
        class="search-input"
        placeholder={props.placeholder || '键入 / 查看支持的指令，或直接搜索与计算...'}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
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
