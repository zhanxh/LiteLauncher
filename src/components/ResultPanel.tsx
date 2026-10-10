import { Component, For, Show } from 'solid-js';
import { PanelItem } from '../types/command';

interface ResultPanelProps {
  items: PanelItem[];
  selectedIndex: number;
  emptyText?: string;
  onSelectItem: (item: PanelItem) => void;
}

/**
 * 查询结果展示面板组件
 */
export const ResultPanel: Component<ResultPanelProps> = (props) => {
  return (
    <div class="panel-container">
      <Show
        when={props.items.length > 0}
        fallback={
          <div class="panel-empty">
            <span>{props.emptyText || '未检索到相关内容'}</span>
          </div>
        }
      >
        <For each={props.items}>
          {(item, index) => (
            <div
              class={`panel-item ${index() === props.selectedIndex ? 'active' : ''}`}
              onClick={() => props.onSelectItem(item)}
            >
              <div class="item-icon">{item.icon || '📌'}</div>
              <div class="item-content">
                <div class="item-title-row">
                  <span class="item-title">{item.title}</span>
                  <Show when={item.badge}>
                    <span class="item-badge">{item.badge}</span>
                  </Show>
                </div>
                <Show when={item.description}>
                  <div class="item-description">{item.description}</div>
                </Show>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
};
