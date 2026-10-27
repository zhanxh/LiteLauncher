/**
 * 框选层即时绘图（flameshot 式"冻结画面上直接画"）——纯逻辑 + canvas 渲染
 *
 * 与 annotate.ts 的分工：annotate.ts 服务"截完之后的标注窗口"（选区局部坐标，
 * 带文字/步骤号等重工具）；这里服务"框选过程中在遮罩层上作画"——
 * 坐标是遮罩层视口的 CSS 像素，渲染时统一乘 scaleFactor 落到物理像素 Canvas，
 * 与底图裁剪共用同一套换算（geometry.ts 的 cssToGlobal），保证导出不糊、不错位。
 *
 * canvas 渲染函数**不 new 任何 DOM**：画布与马赛克专用临时画布由调用方
 * （select.tsx）创建并传入，本模块在 node 测试里可安全加载。
 */
import { arrowHead, type Point } from './annotate';

/** 框选层内的即时绘图工具；`none` = 未选工具（当前拖拽用于框选区） */
export type DrawTool = 'none' | 'pen' | 'rect' | 'ellipse' | 'arrow' | 'mosaic';

/** 一条已提交/进行中的绘图（视口 CSS 坐标） */
export interface DrawShape {
  kind: Exclude<DrawTool, 'none'>;
  color: string;
  /** 线宽 / 笔刷直径（CSS 像素） */
  size: number;
  /** pen/mosaic：沿途路径点；rect/ellipse/arrow：恰好 [起点, 终点] */
  points: Point[];
}

/** 各工具线宽：画笔/形状描边纤细，马赛克笔刷要粗才能一次糊住内容 */
export function toolWidth(kind: Exclude<DrawTool, 'none'>): number {
  return kind === 'mosaic' ? 14 : 3;
}

/** 两点形状的包围盒（方向无关，负宽高在这里归一） */
export function pointsBox(points: Point[]): { x: number; y: number; w: number; h: number } {
  const [a, b] = [points[0], points[points.length - 1]];
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 选区调整（flameshot 式）：四角 + 四边把手拖拽改尺寸，长按选区外重新框选
// ─────────────────────────────────────────────────────────────────────────────

/** 选区调整把手 */
export type HandleKind = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** 把手命中半径（CSS 像素）：光标离边/角这么近就算按到了把手 */
const HANDLE_HIT = 6;

/**
 * 判定指针落在选区的哪个把手上；选区外或距边都远时返回 null。
 *
 * 角优先于边（角是两条边的交集，先判角才能保证角落 6px 内都归角）；
 * 边的命中带是"距该边 ≤ 6px 且在另一轴的选区范围内"——在边延长线外不算，
 * 那里该留给下一层的长按重选。
 */
export function handleAt(
  sel: { x: number; y: number; width: number; height: number },
  px: number,
  py: number,
): HandleKind | null {
  const nearL = Math.abs(px - sel.x) <= HANDLE_HIT;
  const nearR = Math.abs(px - (sel.x + sel.width)) <= HANDLE_HIT;
  const nearT = Math.abs(py - sel.y) <= HANDLE_HIT;
  const nearB = Math.abs(py - (sel.y + sel.height)) <= HANDLE_HIT;
  const inX = px >= sel.x - HANDLE_HIT && px <= sel.x + sel.width + HANDLE_HIT;
  const inY = py >= sel.y - HANDLE_HIT && py <= sel.y + sel.height + HANDLE_HIT;

  if (nearL && nearT) return 'nw';
  if (nearR && nearT) return 'ne';
  if (nearL && nearB) return 'sw';
  if (nearR && nearB) return 'se';
  if (nearT && inX) return 'n';
  if (nearB && inX) return 's';
  if (nearL && inY) return 'w';
  if (nearR && inY) return 'e';
  return null;
}

/** 把手对应的鼠标光标（对角双向箭头 / 边单向箭头） */
export function handleCursor(h: HandleKind | null): string {
  switch (h) {
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    default:
      return 'crosshair';
  }
}

/**
 * 按住某个把手把指针 (px, py) 应用到选区上，返回调整后的选区。
 *
 * 拖过对边（比如把左边拖到右边右边去）必须走 normalize——宽高恒为正、
 * 原点恒为左上，否则渲染层和坐标换算都会拿到负值。
 */
export function applyHandle(
  sel: { x: number; y: number; width: number; height: number },
  h: HandleKind,
  px: number,
  py: number,
): { x: number; y: number; width: number; height: number } {
  // 先算"动的边"的原始坐标，再 min/max 归一化
  let x1 = sel.x;
  let y1 = sel.y;
  let x2 = sel.x + sel.width;
  let y2 = sel.y + sel.height;
  if (h.includes('w')) x1 = px;
  if (h.includes('e')) x2 = px;
  if (h.includes('n')) y1 = py;
  if (h.includes('s')) y2 = py;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/**
 * 工具栏摆放：优先右对齐贴选区**下方** 8px；下方放不下改上方 8px；
 * 水平/垂直都夹回视口内（小选区贴边时工具栏不能伸出屏幕）。
 */
export function toolbarOrigin(
  sel: { x: number; y: number; width: number; height: number },
  viewW: number,
  viewH: number,
  barW: number,
  barH: number,
): Point {
  const x = Math.max(8, Math.min(sel.x + sel.width - barW, viewW - barW - 8));
  let y = sel.y + sel.height + 8;
  if (y + barH > viewH - 8) y = sel.y - barH - 8;
  y = Math.max(8, Math.min(y, viewH - barH - 8));
  return { x, y };
}

/** 渲染选项：scale = CSS→物理；clip = 绘图只落选区内；马赛克三件套见 buildMosaicKit */
export interface RenderOpts {
  scale: number;
  clip?: { x: number; y: number; w: number; h: number } | null;
  /**
   * 马赛克三件套：`mosaicSrc` 是**整幅马赛克化的底图**（物理分辨率），
   * `scratch` 是同尺寸临时画布（做"笔刷路径 ∩ 马赛克图"的合成），
   * `cssW/cssH` 用于把物理画布贴回带 scale 变换的主画布。
   * 缺任何一件时马赛克降级为半透明灰笔——绝不能静默不画，
   * 用户会以为内容已经打上码了。
   */
  mosaic?: {
    src: CanvasImageSource;
    scratch: HTMLCanvasElement;
    cssW: number;
    cssH: number;
  } | null;
}

/**
 * 把一批绘图渲染到 2D 上下文。
 *
 * 约定：调用前 `g` 的画布尺寸 = 物理分辨率（CSS × scale）；本函数自己设
 * transform/clip，调用方不需要预处理。stroke 排在形状各自分支里，
 * pen 的路径点可能有几百个，逐段 lineTo 即可（Canvas 对这种量级毫无压力）。
 */
export function renderShapes(g: CanvasRenderingContext2D, shapes: DrawShape[], opts: RenderOpts): void {
  g.save();
  g.setTransform(opts.scale, 0, 0, opts.scale, 0, 0);
  if (opts.clip) {
    g.beginPath();
    g.rect(opts.clip.x, opts.clip.y, opts.clip.w, opts.clip.h);
    g.clip();
  }
  g.lineCap = 'round';
  g.lineJoin = 'round';

  for (const s of shapes) {
    if (s.kind === 'pen') {
      g.strokeStyle = s.color;
      g.lineWidth = s.size;
      g.beginPath();
      s.points.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
      if (s.points.length === 1) {
        // 单击也留点：一个圆点，别让用户点一下什么都没有
        const p = s.points[0];
        g.arc(p.x, p.y, s.size / 2, 0, Math.PI * 2);
        g.fillStyle = s.color;
        g.fill();
      } else {
        g.stroke();
      }
    } else if (s.kind === 'rect') {
      const b = pointsBox(s.points);
      g.strokeStyle = s.color;
      g.lineWidth = s.size;
      g.strokeRect(b.x, b.y, b.w, b.h);
    } else if (s.kind === 'ellipse') {
      const b = pointsBox(s.points);
      g.strokeStyle = s.color;
      g.lineWidth = s.size;
      g.beginPath();
      g.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w / 2, 0.5), Math.max(b.h / 2, 0.5), 0, 0, Math.PI * 2);
      g.stroke();
    } else if (s.kind === 'arrow') {
      const [a, b] = [s.points[0], s.points[s.points.length - 1]];
      g.strokeStyle = s.color;
      g.lineWidth = s.size;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      const [l, r] = arrowHead(a.x, a.y, b.x, b.y, Math.max(10, s.size * 4));
      g.beginPath();
      g.moveTo(l.x, l.y);
      g.lineTo(b.x, b.y);
      g.lineTo(r.x, r.y);
      g.stroke();
    } else if (s.kind === 'mosaic') {
      renderMosaic(g, s, opts);
    }
  }
  g.restore();
}

/** 马赛克一笔：笔刷路径做 mask，从马赛克化底图里抠出像素块贴进主画布 */
function renderMosaic(g: CanvasRenderingContext2D, s: DrawShape, opts: RenderOpts): void {
  const kit = opts.mosaic;
  if (!kit) {
    // 降级：没有马赛克源（底图未就绪等）也要画出可见痕迹
    g.strokeStyle = 'rgba(148,163,184,0.75)';
    g.lineWidth = s.size;
    g.beginPath();
    s.points.forEach((p, i) => (i === 0 ? g.moveTo(p.x, p.y) : g.lineTo(p.x, p.y)));
    g.stroke();
    return;
  }
  const sg = kit.scratch.getContext('2d');
  if (!sg) return;
  // 1) 笔刷路径 = mask（物理坐标 = CSS × scale）
  sg.save();
  sg.setTransform(1, 0, 0, 1, 0, 0);
  sg.clearRect(0, 0, kit.scratch.width, kit.scratch.height);
  sg.scale(opts.scale, opts.scale);
  sg.lineCap = 'round';
  sg.lineJoin = 'round';
  sg.lineWidth = s.size;
  sg.strokeStyle = '#000';
  sg.beginPath();
  s.points.forEach((p, i) => (i === 0 ? sg.moveTo(p.x, p.y) : sg.lineTo(p.x, p.y)));
  sg.stroke();
  sg.restore();
  // 2) source-in：只保留 mask 覆盖到的马赛克像素（恒等变换下 1:1 贴源图）
  sg.globalCompositeOperation = 'source-in';
  sg.drawImage(kit.src, 0, 0);
  sg.globalCompositeOperation = 'source-over';

  // 3) 贴回主画布：主画布此刻在 scale 变换里，切回恒等变换按物理 1:1 贴
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(kit.scratch, 0, 0);
  g.restore();
}
