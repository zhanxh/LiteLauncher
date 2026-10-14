/**
 * 挂件「悬停展开 / 移开收拢」的纯几何逻辑（与窗口 API 分离，便于单测）。
 *
 * ## 为什么必须缩窗口，而不是只藏按钮
 *
 * 挂件窗口的底色不能透明（WebView2 真机会露白底，见 widget.css 的说明），
 * 所以窗口矩形就是卡片本身。上一版只把按钮从 DOM 里拿掉，窗口仍是展开宽度
 * ——右侧留下一段空白，观感就是"按钮没了但框还在"。要真正缩短，只能改窗口尺寸。
 *
 * ## 为什么右边对齐（向左生长）
 *
 * 挂件默认停在屏幕右上角，右边缘距屏边只有 CORNER_MARGIN。若保持左边缘不动
 * 向右扩，展开时会把按钮推出屏幕外。反过来让右边缘钉住、向左生长，
 * 按钮永远完整可见；代价是收拢时环和标签整体右移，这由动画掩盖。
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
/** 窗口高度（与 manifest 的 height 一致，伸缩过程中不变） */
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

/**
 * 由钉住的右边缘算窗口左边缘（全部逻辑像素）。
 *
 * 右边缘是 `anchorRight`，宽度 `w`，则 x = anchorRight - w：
 * 宽度变化只发生在左侧，右边缘纹丝不动。
 */
export function leftEdgeOf(anchorRight: number, w: number): number {
  return anchorRight - Math.max(0, w);
}

/** 一帧的目标尺寸与位置 */
export interface HoverFrame {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * 算出 `t`（0~1，已 easing 前的原始进度）这一帧应该把窗口设成什么。
 *
 * `anchorRight` / `top` 由调用方在动画开始时**一次性**读取（之后不再读），
 * 这样每帧的位置都由同一个基准推导，命令到达顺序即使颠倒也不会累积误差。
 */
export function frameAt(
  fromW: number,
  toW: number,
  anchorRight: number,
  top: number,
  t: number,
): HoverFrame {
  const w = lerp(fromW, toW, easeOutCubic(t));
  return { width: w, height: WIDGET_H, x: leftEdgeOf(anchorRight, w), y: top };
}
