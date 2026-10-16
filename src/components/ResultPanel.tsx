import { Component, For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { PanelItem } from '@ll/sdk';

interface ResultPanelProps {
  items: PanelItem[];
  selectedIndex: number;
  emptyText?: string;
  onSelectItem: (item: PanelItem) => void;
  /** 鼠标悬停某条时同步键盘选中项——否则 Enter 执行的不是眼前那条 */
  onHoverIndex?: (index: number) => void;
}

/** 判定"还有更多"的容差（px）：差这么几个像素不算溢出，避免亚像素抖动导致提示闪烁 */
const OVERFLOW_TOLERANCE = 2;

/**
 * 查询结果展示面板组件
 *
 * G-2：面板高度是壳层写死的（updateWindowHeight），条目一多就被裁掉，
 * 而 6px 的滚动条太细，用户看不出下面还有内容。这里补一个显式信号：
 * 底部渐隐遮罩+ "还有 N 项"提示。
 *
 * 溢出项数由实际测量得出（而不是 `总数 - 页大小`），因为条目高度随 badge /
 * 描述行数变化，写死页大小会算错。
 */
export const ResultPanel: Component<ResultPanelProps> = (props) => {
  let scroller: HTMLDivElement | undefined;
  const [hiddenCount, setHiddenCount] = createSignal(0);

  /** 测量视口底部还有多少条目不可见 */
  const measure = () => {
    const el = scroller;
    if (!el) return;
    // 已经滚到底就不提示——提示的意义是"往下还有"，不是"曾经溢出过"
    if (el.scrollHeight - el.clientHeight - el.scrollTop <= OVERFLOW_TOLERANCE) {
      setHiddenCount(0);
      return;
    }
    const viewportBottom = el.scrollTop + el.clientHeight;
    const rows = Array.from(el.querySelectorAll<HTMLElement>('.panel-item'));
    let hidden = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.offsetTop + row.offsetHeight > viewportBottom + OVERFLOW_TOLERANCE) hidden += 1;
      else break;
    }
    setHiddenCount(hidden);
  };

  onMount(() => {
    // 首次渲染时布局尚未稳定，下一帧再量
    const raf = requestAnimationFrame(measure);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  createEffect(() => {
    // 依赖 items：换一批结果（长度或首项 id 变化）时回到顶部并重量。
    // 不重置滚动位置的话，用户会落在新结果的中间，且提示计数会显得莫名其妙。
    void props.items.length;
    void props.items[0]?.id;
    if (scroller) scroller.scrollTop = 0;
    const raf = requestAnimationFrame(measure);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  createEffect(() => {
    // 选中项变化时确保它落在视口内：长列表（/app、/find、/note 搜索）
    // 用键盘选到面板下方时，没有这一步选中项会滚出可视区，
    // 用户按 Enter 时根本看不到自己选的是哪一条。
    void props.selectedIndex;
    const active = scroller?.querySelector<HTMLElement>('.panel-item.active');
    active?.scrollIntoView({ block: 'nearest' });
  });

  return (
    <div class="panel-wrapper">
      <div class="panel-container" ref={scroller} onScroll={measure}>
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
                onMouseEnter={() => props.onHoverIndex?.(index())}
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
                  <div class={`item-description${item.description?.includes('\n') ? ' multiline' : ''}`}>{item.description}</div>
                </Show>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>

      {/* 溢出信号：渐隐遮罩暗示"下面被裁掉了"，配一句明确计数 */}
      <Show when={hiddenCount() > 0}>
        <div class="panel-more-hint">
          <div class="panel-more-fade" />
          <div class="panel-more-text">还有 {hiddenCount()} 项 · 滚动查看</div>
        </div>
      </Show>
    </div>
  );
};