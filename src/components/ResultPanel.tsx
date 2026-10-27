import { Component, For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { PanelItem } from '@ll/sdk';

interface ResultPanelProps {
  items: PanelItem[];
  selectedIndex: number;
  emptyText?: string;
  /** 150ms 后才为 true：避免纯计算插件闪骨架 */
  loading?: boolean;
  /** 8s 仍未返回：顶部显示慢查询提示 */
  slow?: boolean;
  /** 查询失败/超时：渲染错误态 + 重试 */
  error?: string | null;
  onRetry?: () => void;
  onSelectItem: (item: PanelItem) => void;
  /** 挂载滚动容器（App 侧在实时面板刷新时保存/恢复滚动位置用） */
  onScrollerRef?: (el: HTMLDivElement | undefined) => void;
  /** 鼠标悬停某条时同步键盘选中项——否则 Enter 执行的不是眼前那条 */
  onHoverIndex?: (index: number) => void;
}

/** 判定"还有更多"的容差（px）：差这么几个像素不算溢出，避免亚像素抖动导致提示闪烁 */
const OVERFLOW_TOLERANCE = 2;

/**
 * 图标是否是图片资源。
 *
 * `ll-icon://` 由宿主协议提供（应用真实图标），`data:`/`http(s)` 留给插件
 * 自行声明的图片图标；其余一律按文本（emoji）渲染，保持老插件零改动。
 */
function isImageIcon(icon?: string): boolean {
  if (!icon) return false;
  return (
    icon.startsWith('ll-icon://') ||
    icon.startsWith('http://') ||
    icon.startsWith('https://') ||
    icon.startsWith('data:image/')
  );
}

/** 插件可声明的图标边长上限：超过这个值面板就装不下了 */
const ICON_MAX_PX = 224;

/**
 * 插件声明的大图标边长（`PanelItem.iconSize`）。
 *
 * 只有图片图标才响应：emoji 图标放大盒子只会多出一圈空白。尺寸在这里夹取而不是
 * 照插件给的值直接写进样式——上限握在壳层，插件才不能把主窗口撑破。
 */
function iconBoxPx(item: PanelItem): number | undefined {
  if (!isImageIcon(item.icon)) return undefined;
  const size = item.iconSize;
  if (typeof size !== 'number' || !Number.isFinite(size)) return undefined;
  return Math.min(ICON_MAX_PX, Math.max(28, Math.round(size)));
}

/** 未声明 iconSize 时返回 undefined：老条目的 DOM 必须与改动前一致（不出现空 style） */
function iconBoxStyle(item: PanelItem): { width: string; height: string } | undefined {
  const px = iconBoxPx(item);
  return px === undefined ? undefined : { width: `${px}px`, height: `${px}px` };
}

/** 动作快捷键的展示文案 */
function accelLabel(accel?: string): string {
  if (accel === 'ctrl+enter') return 'Ctrl+↵';
  if (accel === 'shift+enter') return 'Shift+↵';
  if (accel === 'alt+enter') return 'Alt+↵';
  return '↵';
}

/**
 * Windows 上 WebView2 不认自定义 scheme，wry 把请求暴露为
 * `http://<scheme>.localhost/...`；`<img>` 子资源必须走这个形态。
 * Linux/macOS 保持 `ll-icon://`。两端的路径段都已提前 percent-encode，不再二次编码。
 */
function resolveIconUrl(icon?: string): string | undefined {
  if (!icon || !icon.startsWith('ll-icon://localhost/')) return icon;
  if (/Windows/i.test(navigator.userAgent)) {
    return icon.replace('ll-icon://localhost/', 'http://ll-icon.localhost/');
  }
  return icon;
}

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
  // 图标加载失败（exe 被删/快捷方式损坏）时按条目回退 emoji，不能让列表出现破图
  const [failedIcons, setFailedIcons] = createSignal<Record<string, boolean>>({});
  const iconFailed = (id: string) => Boolean(failedIcons()[id]);
  const markIconFailed = (id: string) =>
    setFailedIcons((prev) => ({ ...prev, [id]: true }));

  /** 测量视口底部还有多少条目不可见 */
  const measure = () => {
    const el = scroller;
    if (!el || el.clientHeight === 0) return; // 布局未稳定时别把全部条目误判为隐藏
    // 已经滚到底就不提示——提示的意义是"往下还有"，不是"曾经溢出过"
    if (el.scrollHeight - el.clientHeight - el.scrollTop <= OVERFLOW_TOLERANCE) {
      setHiddenCount(0);
      return;
    }
    // 用视口坐标而不是 offsetTop：条目的 offsetParent 不一定是滚动容器，
    // 尤其面板底部加了动作条之后，offsetTop 会把头部高度也算进去，导致全量误报。
    const viewportBottom = el.getBoundingClientRect().top + el.clientHeight;
    const rows = Array.from(el.querySelectorAll<HTMLElement>('.panel-item'));
    let hidden = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const rect = rows[i].getBoundingClientRect();
      if (rect.top + rect.height > viewportBottom + OVERFLOW_TOLERANCE) hidden += 1;
      else break;
    }
    setHiddenCount(hidden);
  };

  onMount(() => {
    // 首次渲染时布局尚未稳定，下一帧再量
    const raf = requestAnimationFrame(measure);
    // 窗口高度/底栏出现/字体加载都会改变可视区，重新量一次才不会留下错误计数
    const observer = new ResizeObserver(() => measure());
    if (scroller) observer.observe(scroller);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    });
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

  const selected = () => props.items[props.selectedIndex];

  return (
    <div class="panel-wrapper">
      <Show when={props.slow && !props.error}>
        <div class="panel-slow-hint">
          仍在查询（网络或 Python 环境较慢）… 按 Esc 可先收起
        </div>
      </Show>
      <div
        class="panel-container"
        ref={(el) => {
          scroller = el;
          props.onScrollerRef?.(el);
        }}
        onScroll={measure}
      >
        <Show
          when={props.items.length > 0}
          fallback={
            <Show
              when={!props.loading || props.error}
              fallback={
                <div class="panel-skeleton" aria-label="正在查询">
                  <For each={[0, 1, 2]}>
                    {() => (
                      <div class="skeleton-row">
                        <span class="skeleton-icon" />
                        <div class="skeleton-lines">
                          <span class="skeleton-line w60" />
                          <span class="skeleton-line w40" />
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              }
            >
              <Show
                when={props.error}
                fallback={
                  <div class="panel-empty">
                    <span>{props.emptyText || '未检索到相关内容'}</span>
                  </div>
                }
              >
                <div class="panel-error">
                  <div class="panel-error-icon">⚠️</div>
                  <div class="panel-error-text">{props.error}</div>
                  <button class="panel-retry" onClick={() => props.onRetry?.()}>
                    重试
                  </button>
                </div>
              </Show>
            </Show>
          }
        >
          <For each={props.items}>
            {(item, index) => (
              <>
                {/* 连续同组才显示标题；组标题纯展示，不参与键盘索引 */}
                <Show when={item.group && item.group !== props.items[index() - 1]?.group}>
                  <div class="panel-group">{item.group}</div>
                </Show>
              <div
                class={`panel-item ${index() === props.selectedIndex ? 'active' : ''} ${item.kind === 'info' ? 'info' : ''}`}
                aria-disabled={item.kind === 'info'}
                onClick={() => props.onSelectItem(item)}
                onMouseEnter={() => item.kind !== 'info' && props.onHoverIndex?.(index())}
              >
                <div
                  class={`item-icon${iconBoxPx(item) ? ' sized' : ''}`}
                  style={iconBoxStyle(item)}
                >
                  <Show
                    when={isImageIcon(item.icon) && !iconFailed(item.id)}
                    fallback={<span>{isImageIcon(item.icon) ? '📌' : item.icon || '📌'}</span>}
                  >
                    <img
                      src={resolveIconUrl(item.icon)}
                      alt=""
                      loading="lazy"
                      draggable={false}
                      onError={() => markIconFailed(item.id)}
                    />
                  </Show>
                </div>
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
              </>
            )}
          </For>
        </Show>
      </div>

      {/* 底部动作条：始终告诉用户"回车会做什么、还支持哪些修饰键" */}
      <Show when={props.items.length > 0}>
        <div class="panel-footer">
          <div class="panel-footer-hints">
            <span>
              <kbd>↵</kbd> {selected()?.metadata?.trigger ? '补全' : '执行'}
            </span>
            <For each={selected()?.actions ?? []}>
              {(action) => (
                <span>
                  <kbd>{accelLabel(action.accel)}</kbd> {action.label}
                </span>
              )}
            </For>
          </div>
          <span class="panel-footer-count">{props.items.length} 项</span>
        </div>
      </Show>

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