/**
 * 挂件「悬停展开 / 移开收拢」的宽度取值（与窗口 API 分离，便于单测）。
 *
 * ## 为什么必须缩窗口，而不是只藏按钮
 *
 * 挂件窗口的底色不能透明（WebView2 真机会露白底，见 widget.css 的说明），
 * 所以窗口矩形就是卡片本身。上一版只把按钮从 DOM 里拿掉，窗口仍是展开宽度
 * ——右侧留下一段空白，观感就是"按钮没了但框还在"。要真正缩短，只能改窗口尺寸。
 *
 * ## 只管宽度
 *
 * 挂件停在屏幕右上角，展开时若左边缘不动就会把按钮推出屏外，所以右边缘必须钉住、
 * 向左生长。这条锚定规则连同物理↔逻辑像素换算都在宿主的
 * `svc.window.setContentSize` 里（算法是 ll-plugin-api 的 `popup_rect_after_size`，
 * 有单测），本文件不再算坐标——插件侧只回答"这个悬停态该多宽"。
 */

/** 卡片左右内边距（widget.css 的 .pw-card padding: 0 14px） */
export const PAD_X = 14;
/** 进度环直径（.pw-ring 64×64） */
export const RING = 64;
/** 卡片 flex 的 element-gap */
export const GAP = 10;
/** 收拢态标签上限（.pw-label max-width） */
export const LABEL_W = 84;
/** 展开态标签上限（.pw-root.pw-hovered .pw-label max-width）——hold 文案要比收拢态长 */
export const LABEL_W_HOVER = 120;
/** 按钮边长与按钮间距 */
export const BTN = 22;
export const BTN_GAP = 4;
/** 展开态最多同时出现的按钮数：自动衔接开关 + 当前动作（暂停/继续/下一段）+ 停止 */
export const MAX_BTNS = 3;

/**
 * 收拢宽度 = 内边距 + 环 + 间距 + 标签。
 * 必须与 manifest 的 `width` 一致：窗口默认就是这个尺寸，对不上会出现首帧被裁。
 */
export const COLLAPSED_W = PAD_X * 2 + RING + GAP + LABEL_W;
/** 展开宽度 = 收拢内容 + 加宽的标签 + 按钮区 */
export const EXPANDED_W =
  PAD_X * 2 + RING + GAP + LABEL_W_HOVER + GAP + (MAX_BTNS * BTN + (MAX_BTNS - 1) * BTN_GAP);
/** 窗口高度（与 manifest 的 height 一致，伸缩过程中不变；宿主不改高，只改宽） */
export const WIDGET_H = 88;
/** 单程动画时长。再长会拖慢"划过去就出按钮"的跟手感 */
export const ANIM_MS = 170;

export function widthFor(hovered: boolean): number {
  return hovered ? EXPANDED_W : COLLAPSED_W;
}

/** ease-out：起步快、收尾缓，符合"响应即开始、落位要稳"的手感 */
export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

export function clamp01(t: number): number {
  // NaN 必须兜成 0：时间计算里混进 NaN 会让整条插值链变成 NaN，
  // 窗口尺寸被设成 NaN 后 Tauri 直接报错或留下一个畸形矩形
  if (!Number.isFinite(t)) return 0;
  return Math.min(1, Math.max(0, t));
}

export function lerp(from: number, to: number, p: number): number {
  return from + (to - from) * clamp01(p);
}
