/**
 * 弹出式基窗的前端半边（配合 manifest 视图的 `auto_height`）
 *
 * 宿主建出来的窗口首帧只有"声明高度"，本模块负责把真实内容高度报回去，
 * 让窗口收缩到卡片本身的高度——于是插件看到的就是一张浮在桌面上的弹窗，
 * 而不是一个装着卡片的空窗口。
 *
 * ## 为什么默认测的是自然高度，而不是窗口高度
 * 被 `max_height` 截断时窗口比内容矮，测量元素仍按内容铺开（基窗让滚动只
 * 发生在内容区）。所以上报值恒等于内容高度，不会因为"窗口矮 → 量出来矮
 * → 窗口更矮"自己跟自己振荡。
 *
 * ## 为什么宽度不自动
 * 宽度自动会让"内容变宽 → 换行变少 → 高度变矮 → 又变窄"回流不收敛。
 * 弹窗的宽度是设计时定死的，要伸缩的是高度。
 *
 * ## 不传 pluginId = 只借骨架
 * 固定尺寸窗口（日历、设置这类用户自己拽大小的）没有可上报的高度，
 * 传 pluginId 反而会被宿主以"未声明 auto_height"拒掉。此时本模块只负责
 * 打 body 类（popup.css 全靠它作用域）和标记拖拽区。
 *
 * 本文件刻意不依赖 solid，也不碰 `@tauri-apps/*`：行为要能被 Node 侧
 * 回归脚本直接跑（见 tools/test-fe-plugins.mjs 的导入边界断言）。
 */
import { getPluginContext, isHostAvailable } from './lps';

/**
 * 基窗的样式作用域类名；popup.css 里每条选择器都挂在它下面。
 * 挂在 body 上（而非 html）：`index.html` 给 `html,body,#root` 写死了
 * `background-color` / `overflow:hidden` 的 `!important`，body 这一层就能同时
 * 压住自己的底色并接管窗口，`html` 保持 hidden 正好避免双滚动条。
 */
export const POPUP_BODY_CLASS = 'll-popup-mode';

/** 两次上报的最小差值：1px 级别的抖动不值得打一次 IPC */
const DEFAULT_DEAD_BAND_PX = 2;

export interface PopupHandle {
  /** 停止观察并摘掉 body 类（组件 onCleanup 里调） */
  dispose(): void;
  /** 主动要求重新量一次（内容切换、异步数据到位时） */
  refresh(): void;
}

export interface PopupOptions {
  /**
   * 用哪个插件上下文上报（= manifest 的 id）。
   * 省略 = 不上报尺寸（固定尺寸窗口只借骨架：body 类 + 拖拽区标记）。
   */
  pluginId?: string;
  /**
   * 主观察目标：默认测量取它的自然高度，ResizeObserver 也盯着它。
   * 内容变化但它纹丝不动时（比如三段式骨架里内容区被窗口夹住），
   * 把真正会变的元素放进 `watch`。
   */
  content: HTMLElement;
  /**
   * 覆盖默认测量。三段式骨架的窗口高度 = 标题栏 + 内容自然高 + 状态栏，
   * 没有单个元素量得出来，由调用方把三段加好传进来。
   */
  measure?: () => number;
  /** 额外观察目标：任一元素尺寸变化都会触发重新测量上报 */
  watch?: HTMLElement[];
  /**
   * 拖拽区元素，会被打上 `data-tauri-drag-region="deep"`。
   *
   * 不自己写 mousedown → startDragging()：Tauri 注入的拖拽脚本已经会跳过
   * button / input / a / [tabindex] / [role=button]，手写的那份反而每处都要
   * 记得排除按钮（提醒卡、pomo 挂件过去各写了一遍）。
   */
  drag?: HTMLElement | null;
  deadBandPx?: number;
}

export function mountPopup(opts: PopupOptions): PopupHandle {
  const deadBand = opts.deadBandPx ?? DEFAULT_DEAD_BAND_PX;
  const { pluginId, content } = opts;
  document.body.classList.add(POPUP_BODY_CLASS);

  const dragEl = opts.drag ?? null;
  dragEl?.setAttribute('data-tauri-drag-region', 'deep');

  /**
   * 拖拽期间挂起上报。元素 handler 先于 Tauri 挂在 document 上的冒泡 handler
   * 跑，所以这个挂起点是可靠的。pomo 挂件当年"拖完弹回"就是缺这一步：
   * 系统拖拽事务进行中改窗口几何，松手瞬间会被拖拽的基准覆盖一下。
   */
  let dragging = false;
  let reported = -1;
  let queued = false;

  const measure = (): number =>
    opts.measure ? opts.measure() : content.getBoundingClientRect().height;

  const flush = (): void => {
    queued = false;
    if (dragging || !pluginId || !isHostAvailable()) return;
    const h = Math.ceil(measure());
    if (!Number.isFinite(h) || h <= 0 || Math.abs(h - reported) < deadBand) return;
    reported = h;
    void getPluginContext(pluginId)
      .windows.setContentSize({ height: h })
      .catch((err) => console.error('上报内容高度失败:', err));
  };

  const queue = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(flush);
  };

  const onDragStart = (): void => {
    dragging = true;
  };
  const onDragEnd = (): void => {
    dragging = false;
    // 拖拽期间内容若有变化，这一次补上，否则窗口停在拖拽前的尺寸
    queue();
  };
  dragEl?.addEventListener('mousedown', onDragStart);
  window.addEventListener('mouseup', onDragEnd);

  const observer = new ResizeObserver(queue);
  observer.observe(content);
  for (const el of opts.watch ?? []) observer.observe(el);
  /**
   * 窗口被改大时内容元素可以纹丝不动（多出来的是空白），RO 不会响。
   * Linux 上 auto_height 窗口必须保持可 resize（GTK 否则忽略应用侧 set_size），
   * 于是用户真能拽到边框 —— 这个监听就是"拖完弹回内容高度"的那半步。
   */
  window.addEventListener('resize', queue);
  queue();

  return {
    refresh: queue,
    dispose() {
      observer.disconnect();
      window.removeEventListener('resize', queue);
      window.removeEventListener('mouseup', onDragEnd);
      dragEl?.removeEventListener('mousedown', onDragStart);
      document.body.classList.remove(POPUP_BODY_CLASS);
    },
  };
}
