/**
 * 区域框选层（全屏透明窗口视图，`?view=select`）
 *
 * 交互流程（对齐 flameshot：先抓帧、再冻结置顶、框选只裁剪不重拍）：
 *   1. 窗口打开（全屏、透明、置顶、跳过任务栏 —— 见 manifest 的 view 声明）；
 *      **首帧保持全透明**——此刻还没抓到底图，画什么都可能被拍进底图
 *   2. 等首帧真正合成出去（rAF 门控），再抓一张当前屏作为底图：
 *      hideWindows 让宿主把**其余** LiteLauncher 窗口隐藏再抓，抓完恢复；
 *      本遮罩层全透明且被宿主**排除在避让外**（skip_window = 调用者自身），
 *      拍不进底图，也不会被 hide→restore 动过——X11 上 unmap→remap 会让
 *      mutter 把全屏窗口重新最大化到工作区，框选坐标系随之整体错位
 *   3. 底图铺满作为"冻结的屏幕"置顶显示，**选区外虚化 + 压暗**（模糊底图
 *      打底 + 锐利底图按选区裁剪 + 选区外压暗矩形），用户在上面拖拽框选
 *   4. 松手后选区固定，出现工具栏：画笔 / 矩形 / 圆形 / 箭头 / 马赛克 +
 *      配色板 + 撤销，全部直接画在冻结画面上（flameshot 式即时绘图）；
 *      确认时**前端合成**：底图裁剪 ∪ 绘图 Canvas，不再二次抓屏——
 *      省掉隐藏/恢复窗口的闪烁，且保证拿到的就是用户框选那一刻的画面
 *   5. Enter / ✓ → savePng 落盘+进剪贴板 → 选区原位开钉图（或转标注层）；
 *      Esc / ✕ 取消，不产生任何副作用
 *
 * 为什么底图必须"抓完再显示"：遮罩层一旦可见（哪怕半透明压暗），就会被
 * xcap 拍进截图里，用户框选时会看到一层灰蒙蒙的遮罩压在内容上。顺序反了就会露馅。
 */
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getPluginContext, type CaptureResult, type MonitorInfo } from '@ll/sdk';
import {
  cssToGlobal,
  describeSize,
  isTinyDrag,
  normalizeDrag,
  type DragState,
  type NormRect,
} from './geometry';
import { PALETTE, type Point } from './annotate';
import {
  applyHandle,
  handleAt,
  handleCursor,
  renderShapes,
  toolWidth,
  toolbarOrigin,
  type DrawShape,
  type DrawTool,
  type HandleKind,
} from './drawings';

const ctx = getPluginContext('shot');

/** 低于该尺寸视为"单击误触"，直接忽略 */
const MIN_DRAG = 4;

/** 标注视图（manifest 的 views[].id 必须一致） */
const VIEW_ANNOTATE = 'annotate';
/** 钉图视图（manifest 的 views[].id 必须一致） */
const VIEW_PIN = 'pin';

/** 抓图前等首帧真正合成出去的双 rAF + 合成器余量 */
const FIRST_PAINT_SETTLE_MS = 80;

/** 选区外长按判定为"重新框选"的时长（flameshot 同款手势） */
const REPICK_HOLD_MS = 260;

/** 选区外虚化的模糊半径（CSS 像素）与压暗浓度 */
const BLUR_PX = 7;
const DIM_ALPHA = 0.28;

/** 马赛克像素块的物理边长：越小越"细"，越大越"糊" */
const MOSAIC_BLOCK = 12;

/** 工具栏尺寸（与 JSX 里各按钮的实际尺寸一一对应，供摆位计算用）。
 * 各按钮显式 padding:0 + box-sizing + min-width:0，压掉壳层全局 button 样式的
 * 撑宽，否则实际渲染宽度会大于建模值，"右对齐贴选区"就会偏出去 */
const BAR_H = 36;
const BAR_W = 396;

const TOOLS: { id: Exclude<DrawTool, 'none'>; label: string; icon: string }[] = [
  { id: 'pen', label: '画笔', icon: '✎' },
  { id: 'rect', label: '矩形框', icon: '▭' },
  { id: 'ellipse', label: '圆形框', icon: '◯' },
  { id: 'arrow', label: '箭头', icon: '➚' },
  { id: 'mosaic', label: '马赛克', icon: '▦' },
];

export function ShotSelect() {
  const params = new URLSearchParams(window.location.search);
  /** -1 = 光标所在屏；0..n = 指定屏 */
  const monitor = Number.parseInt(params.get('monitor') ?? '-1', 10);
  const delayMs = Number.parseInt(params.get('delayMs') ?? '0', 10) || 0;
  /** 是否在框选后直接进标注层（用户在 /shot 面板里选"标注"时才为真） */
  const annotateMode = params.get('annotate') === '1';

  /** 底图（PNG 的 data URL），null = 还没抓好 */
  const [backdrop, setBackdrop] = createSignal<string | null>(null);
  /** 选区拖拽的中间态（选区确定后清空，改由 sel() 承接） */
  const [drag, setDrag] = createSignal<DragState | null>(null);
  /** 已确定的选区（CSS 像素）；null = 还没框出来 */
  const [sel, setSel] = createSignal<NormRect | null>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  /** 提示条（快捷键说明），鼠标静止 2s 后淡出 */
  const [hintOn, setHintOn] = createSignal(true);
  /** 当前绘图工具与颜色 */
  const [tool, setTool] = createSignal<DrawTool>('none');
  const [color, setColor] = createSignal<string>(PALETTE[0]);
  /** 已提交的绘图（工具栏"撤销"按钮的可用性也由它驱动） */
  const [shapes, setShapes] = createSignal<DrawShape[]>([]);

  /** 遮罩层自身的 CSS 尺寸 = 屏幕物理尺寸 / scaleFactor（先按视口估，抓屏后校正） */
  let cssW = window.innerWidth;
  let cssH = window.innerHeight;
  /** 目标屏在虚拟桌面中的原点（副屏可为负） */
  let originX = 0;
  let originY = 0;
  /** 目标屏缩放因子 */
  let scale = 1;

  /** 底图元素：锐利层/马赛克源/合成导出共用一份解码结果 */
  let backdropEl: HTMLImageElement | null = null;
  /** 已提交绘图烘焙画布 / 进行中绘图画布（物理分辨率，随底图就绪后定尺寸） */
  let bakedCanvas: HTMLCanvasElement | null = null;
  let draftCanvas: HTMLCanvasElement | null = null;
  /** 马赛克三件套：整幅像素化底图 + 合成用临时画布（见 drawings.ts RenderOpts） */
  let mosaicCanvas: HTMLCanvasElement | null = null;
  let mosaicScratch: HTMLCanvasElement | null = null;

  /** 选区拖拽 / 形状绘制 / 选区调整互斥 */
  let dragging = false;
  let drawing = false;
  /** 选区调整中：按住的把手 + 拖拽起点时的指针位置 */
  let resizing: { handle: HandleKind } | null = null;
  /** 长按重选：按住时的定时器句柄（松手前触发则进入重新框选） */
  let repickTimer: ReturnType<typeof setTimeout> | null = null;
  /** 长按已判定为"重新框选"后，这次按下不再参与其他逻辑 */
  let repicking = false;
  let draft: DrawShape | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;

  const win = getCurrentWindow();

  function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /** 定位目标显示器，换算 CSS↔物理坐标系所需的三个量 */
  async function resolveMonitor(): Promise<void> {
    const list = await ctx.screen.list();
    const target = monitor === -1 ? pickByCursor(list) : list[monitor];
    const chosen = target ?? list[0];
    if (!chosen) throw new Error('未找到可用显示器');

    originX = chosen.x;
    originY = chosen.y;
    scale = chosen.scaleFactor || 1;

    // 遮罩层窗口已被宿主铺满该屏，视口本身就是该屏的 CSS 尺寸。
    // 不要读 `outerSize()`：它返回**物理像素**，HiDPI（125%/150%）下会把底图
    // 放大同样倍数，框选出的坐标也跟着整体偏移。视口宽高才是 CSS 像素的唯一真相。
    cssW = window.innerWidth || Math.round(chosen.width / scale);
    cssH = window.innerHeight || Math.round(chosen.height / scale);
  }

  /** 光标所在的那块屏 */
  function pickByCursor(list: MonitorInfo[]) {
    for (const m of list) {
      if (
        m.x <= cursorCache.x &&
        cursorCache.x < m.x + m.width &&
        m.y <= cursorCache.y &&
        cursorCache.y < m.y + m.height
      ) {
        return m;
      }
    }
    return list[0];
  }

  /** 缓存一次光标位置（open 时读一次即可，框选过程中光标会被遮罩捕获） */
  const cursorCache = { x: 0, y: 0 };

  /**
   * 抓底图。
   *
   * `hideWindows: true` 让宿主先把**其余** LiteLauncher 窗口（主窗、挂件等）
   * 隐藏再抓屏，抓完恢复——否则底图里会出现它们。本遮罩层由宿主按
   * skip_window（= IPC 调用者）排除在避让外：它此刻全透明，拍不进画面；
   * 若把它也藏起来，hide→restore 的重映射会让 mutter 重新最大化全屏窗口，
   * 框选坐标整体错位（真机踩过）。
   * 注意这里**不要** toClipboard：用户还没框选，不该有任何剪贴板副作用。
   *
   * `inline: true` 让宿主把 PNG 以 data URL 顺路带回：WebView2 不允许页面
   * `fetch('file:///…')` 读本地文件（跨源被拒），自己拼 file URL 的后果就是
   * "遮罩层一片黑、底图永远出不来"。
   */
  async function grabBackdrop(): Promise<void> {
    const shot: CaptureResult = await ctx.screen.capture({
      monitor,
      hideWindows: true,
      delayMs,
      inline: true,
    });
    if (!shot.dataUrl) throw new Error('宿主未回传底图数据（inline 参数丢失？）');
    setBackdrop(shot.dataUrl);
  }

  /** 等首帧真正合成出去：抓图时本窗口必须已经是"确定无疑的全透明"，
   * 否则未初始化的窗体缓冲可能被拍进底图（双 rAF 保证跨过一次完整合成） */
  function firstPaintSettled(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setTimeout(resolve, FIRST_PAINT_SETTLE_MS));
      });
    });
  }

  /** 底图 data URL → 解码好的 Image（锐利层/马赛克/合成共用） */
  function loadBackdropEl(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = src;
      if (img.complete && img.naturalWidth > 0) return resolve(img);
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('底图加载失败'));
    });
  }

  /** 马赛克源 = 整幅底图按 MOSAIC_BLOCK 像素化（缩小再无平滑放大） */
  function ensureMosaicKit(): void {
    if (!backdropEl) return;
    const w = backdropEl.naturalWidth;
    const h = backdropEl.naturalHeight;
    if (!mosaicCanvas) {
      mosaicCanvas = document.createElement('canvas');
      mosaicScratch = document.createElement('canvas');
    }
    if (mosaicCanvas.width === w && mosaicCanvas.height === h) return;
    mosaicCanvas.width = w;
    mosaicCanvas.height = h;
    mosaicScratch!.width = w;
    mosaicScratch!.height = h;
    const g = mosaicCanvas.getContext('2d');
    if (!g) return;
    const tw = Math.max(1, Math.round(w / MOSAIC_BLOCK));
    const th = Math.max(1, Math.round(h / MOSAIC_BLOCK));
    const tiny = document.createElement('canvas');
    tiny.width = tw;
    tiny.height = th;
    tiny.getContext('2d')?.drawImage(backdropEl, 0, 0, tw, th);
    g.imageSmoothingEnabled = false;
    g.drawImage(tiny, 0, 0, w, h);
  }

  /** 绘图画布物理尺寸必须在首笔之前定好（= 底图物理分辨率） */
  function ensureCanvases(): boolean {
    if (!backdropEl) return false;
    const w = backdropEl.naturalWidth;
    const h = backdropEl.naturalHeight;
    for (const c of [bakedCanvas, draftCanvas]) {
      if (!c) return false;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    return true;
  }

  function mosaicKit() {
    if (!ensureCanvases()) return null;
    ensureMosaicKit();
    return mosaicCanvas && mosaicScratch
      ? { src: mosaicCanvas, scratch: mosaicScratch, cssW, cssH }
      : null;
  }

  /** 把已提交的绘图整体重绘到烘焙画布（提交/撤销后各跑一次） */
  function renderBaked(): void {
    const c = bakedCanvas;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    const s = sel();
    renderShapes(g, shapes(), {
      scale,
      clip: s ? { x: s.x, y: s.y, w: s.width, h: s.height } : null,
      mosaic: mosaicKit(),
    });
  }

  /** 进行中的绘图单独一层：每帧只清重这一笔，烘焙层不动 */
  function renderDraft(): void {
    const c = draftCanvas;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    const s = sel();
    if (draft) {
      renderShapes(g, [draft], {
        scale,
        clip: s ? { x: s.x, y: s.y, w: s.width, h: s.height } : null,
        mosaic: mosaicKit(),
      });
    }
  }

  /**
   * 合成最终图：底图裁剪 ∪ 烘焙绘图 ∪ 进行中绘图（物理像素 1:1 叠放）。
   * 不再二次抓屏——flameshot 同款，这是全程无闪烁的关键。
   */
  async function composeFinal(rect: NormRect): Promise<string> {
    const src = backdrop();
    if (!src || !backdropEl) throw new Error('底图未就绪');
    // CSS → 物理，并夹回底图边界（亚像素取整可能超出 1px）
    const sx = Math.min(Math.max(0, Math.round(rect.x * scale)), backdropEl.naturalWidth - 1);
    const sy = Math.min(Math.max(0, Math.round(rect.y * scale)), backdropEl.naturalHeight - 1);
    const sw = Math.max(1, Math.min(Math.round(rect.width * scale), backdropEl.naturalWidth - sx));
    const sh = Math.max(1, Math.min(Math.round(rect.height * scale), backdropEl.naturalHeight - sy));

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('无法创建画布');
    g.drawImage(backdropEl, sx, sy, sw, sh, 0, 0, sw, sh);
    for (const c of [bakedCanvas, draftCanvas]) {
      if (c && c.width === backdropEl.naturalWidth) {
        g.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
      }
    }
    return canvas.toDataURL('image/png');
  }

  /** 用户确认：合成选区+绘图 → 落盘/剪贴板 → 钉图或进标注层 */
  async function confirm(): Promise<void> {
    if (busy()) return;
    const rect = sel();
    if (!rect) return;
    if (!backdrop()) {
      setError('底图未就绪，请稍候重试');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const dataUrl = await composeFinal(rect);
      // 标注模式下先不写剪贴板：最终成品还没画完，
      // 过早写进去会让用户 Ctrl+V 贴到一张没标注的图
      const saved = await ctx.screen.savePng(dataUrl, { toClipboard: !annotateMode });

      // 记忆最近一次，供主面板"打开/打开文件夹"用（跨窗口共享，故落 KV）
      await ctx.settings.setJson('lastShot', {
        path: saved.path,
        width: saved.width,
        height: saved.height,
      });

      if (annotateMode) {
        // 只传原图路径：合成产物已经是选区+绘图本身，标注层按 1:1 铺开即可。
        // 再传偏移/缩放只会引入坐标系错位。
        await ctx.windows.open(VIEW_ANNOTATE, { src: saved.path }).catch(() => undefined);
        await win.close().catch(() => undefined);
        return;
      }

      // 钉图（flameshot 的 Pin）：选区**原位**置顶，右键复制/关闭。
      // x/y/w/h 传桌面全局物理像素，宿主按落点显示器缩放换算后建窗。
      const region = cssToGlobal(rect, scale, { x: originX, y: originY });
      await ctx.windows
        .open(VIEW_PIN, {
          src: saved.path,
          pinId: `${Date.now().toString(36)}`,
          x: region.x,
          y: region.y,
          w: region.width,
          h: region.height,
        })
        .catch(() => undefined);

      await win.close();
    } catch (err) {
      setError(`截图失败：${messageOf(err)}`);
      setBusy(false);
    }
  }

  /** 取消：什么都不做 */
  async function cancel(): Promise<void> {
    await win.close().catch(() => undefined);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      void cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void confirm();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      // Ctrl+C 也当确认：肌肉记忆
      e.preventDefault();
      void confirm();
    }
  }

  onMount(() => {
    // 顺序：读光标（选屏要用）→ 等首帧合成 → 抓底图 → 显示"冻结的屏幕"。
    // 出错也要画出错误横幅（窗口从建窗起就映射着，横幅用户看得见）。
    void (async () => {
      try {
        try {
          const c = await ctx.screen.cursor();
          cursorCache.x = c.x;
          cursorCache.y = c.y;
        } catch {
          // 读不到光标就退到主屏，不阻断流程
        }
        await resolveMonitor();
        await firstPaintSettled();
        await grabBackdrop();
        backdropEl = await loadBackdropEl(backdrop()!);
      } catch (err) {
        setError(`无法准备框选层：${messageOf(err)}`);
      }
    })();

    window.addEventListener('keydown', onKeyDown);
    // 提示条 2.5s 后淡出，别长期遮挡内容
    hintTimer = setTimeout(() => setHintOn(false), 2500);
    // mutter 的防抢焦点会拒绝给"非活跃应用"刚映射的窗口键盘焦点（真机复现：
    // 窗口带着 DEMANDS_ATTENTION 却拿不到 FOCUSED，Esc/回车全部落空）。
    // 立即 + 延迟各补一次 setFocus（与主窗口 present 的补偿同款节奏）。
    const claimFocus = () => void win.setFocus().catch(() => undefined);
    claimFocus();
    const focusRetry = setTimeout(claimFocus, 250);

    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown);
      if (hintTimer) clearTimeout(hintTimer);
      clearTimeout(focusRetry);
      if (repickTimer) clearTimeout(repickTimer);
      void win.close().catch(() => undefined);
    });
  });

  /** 悬停光标：把手随方向、选区内默认、选区外长按重选用 crosshair */
  function onPointerHover(e: PointerEvent): void {
    if (dragging || drawing || resizing || repicking || busy()) return;
    const s = sel();
    if (!s) return;
    const pt = localPoint(e);
    const el = e.currentTarget as HTMLElement;
    const h = handleAt(s, pt.x, pt.y);
    if (h) {
      el.style.cursor = handleCursor(h);
    } else if (pt.x >= s.x && pt.x < s.x + s.width && pt.y >= s.y && pt.y < s.y + s.height) {
      el.style.cursor = 'default';
    } else {
      el.style.cursor = 'crosshair';
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (busy()) return;
    const pt = localPoint(e);
    const s = sel();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    // 阶段二：按在把手上 → 调整选区尺寸
    if (s) {
      const h = handleAt(s, pt.x, pt.y);
      if (h) {
        resizing = { handle: h };
        return;
      }
      // 选了工具且按在选区内 → 在冻结画面上作画
      const t = tool();
      if (t !== 'none' && pt.x >= s.x && pt.x < s.x + s.width && pt.y >= s.y && pt.y < s.y + s.height) {
        drawing = true;
        draft = { kind: t, color: color(), size: toolWidth(t), points: [pt, pt] };
        renderDraft();
        return;
      }
      // 选区外（含未选工具时按在选区内空白）：长按后重新框选。
      // 立即清掉旧选区会闪一下"整屏虚化"，长按判定过了再清才平滑。
      repicking = false;
      repickTimer = setTimeout(() => {
        repicking = true;
        setSel(null);
        setShapes([]);
        setTool('none');
        if (bakedCanvas) bakedCanvas.getContext('2d')?.clearRect(0, 0, bakedCanvas.width, bakedCanvas.height);
        if (draftCanvas) draftCanvas.getContext('2d')?.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
        dragging = true;
        setDrag({ startX: pt.x, startY: pt.y, curX: pt.x, curY: pt.y });
      }, REPICK_HOLD_MS);
      return;
    }

    // 阶段一：还没有选区，这次拖拽用来框选
    dragging = true;
    setDrag({ startX: pt.x, startY: pt.y, curX: pt.x, curY: pt.y });
    setHintOn(false);
  }

  function onPointerMove(e: PointerEvent): void {
    if (dragging) {
      const pt = localPoint(e);
      setDrag((d) => (d ? { ...d, curX: pt.x, curY: pt.y } : d));
      return;
    }
    if (resizing) {
      const pt = localPoint(e);
      setSel((cur) => (cur ? applyHandle(cur, resizing!.handle, pt.x, pt.y) : cur));
      return;
    }
    if (drawing && draft) {
      const pt = localPoint(e);
      if (draft.kind === 'pen' || draft.kind === 'mosaic') {
        // 自由笔迹：采样点按最小间距过滤，拖快拖慢密度一致
        const last = draft.points[draft.points.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < 1.5) return;
        draft.points.push(pt);
      } else {
        draft.points[1] = pt;
      }
      renderDraft();
      return;
    }
    onPointerHover(e);
  }

  function onPointerUp(): void {
    if (repickTimer) {
      clearTimeout(repickTimer);
      repickTimer = null;
    }
    // 长按判定已触发：这次按压归"重新框选"，不走下面的分支
    if (repicking) {
      repicking = false;
    }
    if (dragging) {
      dragging = false;
      const d = drag();
      if (!d) return;
      const rect = normalizeDrag(d);
      setDrag(null);
      if (isTinyDrag(rect, MIN_DRAG)) {
        setError('选区太小，请拖拽框选一块区域');
        return;
      }
      setSel(rect);
      setError('');
      return;
    }
    if (resizing) {
      resizing = null;
      const s = sel();
      if (s && (s.width < MIN_DRAG || s.height < MIN_DRAG)) {
        setError('选区太小，请拖拽框选一块区域');
      }
      return;
    }
    if (drawing && draft) {
      drawing = false;
      const d = draft;
      draft = null;
      // 笔类单击留点；框类太短视为误触丢弃
      const tinyShape =
        (d.kind === 'rect' || d.kind === 'ellipse' || d.kind === 'arrow') &&
        Math.abs(d.points[1].x - d.points[0].x) < MIN_DRAG &&
        Math.abs(d.points[1].y - d.points[0].y) < MIN_DRAG;
      if (tinyShape) {
        renderDraft();
        return;
      }
      setShapes((list) => [...list, d]);
      renderBaked();
      renderDraft();
    }
  }

  /** 工具栏点击后的统一收尾：弹开焦点，防止 Enter 触发浏览器原生按钮行为 */
  function toolbarAct(fn: () => void): (e: MouseEvent) => void {
    return (e) => {
      fn();
      (e.currentTarget as HTMLElement).blur();
    };
  }

  /** 撤销最后一笔并整体重烘焙（马赛克也要重合成，所以不能只清一块） */
  function undoLast(): void {
    setShapes((list) => list.slice(0, -1));
    renderBaked();
  }

  /** 指针相对遮罩层的 CSS 坐标 */
  function localPoint(e: PointerEvent | MouseEvent): Point {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  const rectNow = () => sel();

  /**
   * 视觉层的实时矩形 = 已提交选区 ?? 拖拽中的矩形。
   *
   * 拖拽（首次框选 / 长按重选）期间 sel() 是 null，若视觉层只读 sel()，
   * 用户拖拽全程看不到边框和选区内预览，松手瞬间才"啪"地出现——很突兀。
   * 全部视觉（锐利层/压暗/边框/把手/尺寸标签）跟着 liveRect 走，拖到哪亮到哪。
   */
  const liveRect = (): NormRect | null => {
    const committed = sel();
    if (committed) return committed;
    const d = drag();
    return d ? normalizeDrag(d) : null;
  };

  const sharpClip = () => {
    const r = liveRect();
    if (!r) return undefined;
    return `inset(${r.y}px ${Math.max(0, cssW - r.x - r.width)}px ${Math.max(0, cssH - r.y - r.height)}px ${r.x}px)`;
  };

  const dimStyle = {
    background: `rgba(0,0,0,${DIM_ALPHA})`,
    'pointer-events': 'none',
  } as const;

  const barBtn = {
    display: 'inline-flex',
    'align-items': 'center',
    'justify-content': 'center',
    width: '28px',
    height: '28px',
    padding: '0',
    'min-width': '0',
    'box-sizing': 'border-box',
    border: 'none',
    'border-radius': '6px',
    background: 'transparent',
    color: '#E2E8F0',
    font: '14px/1 ui-sans-serif, system-ui, sans-serif',
    cursor: 'pointer',
  } as const;

  const barBtnActive = {
    ...barBtn,
    background: '#0EA5E9',
    color: '#fff',
  } as const;

  return (
    <div
      style={{
        position: 'fixed',
        inset: '0',
        width: `${cssW}px`,
        height: `${cssH}px`,
        overflow: 'hidden',
        cursor: 'crosshair',
        'user-select': 'none',
        // 首帧必须全透明：底图还没抓到时画任何东西（哪怕是压暗层）都会
        // 被 xcap 拍进底图/闪一下。底图就绪后才由下面几层画出"冻结的屏幕"。
        background: 'transparent',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* 底层：模糊底图——选区外的"虚化"来源；未框选时整屏虚化 */}
      <Show when={backdrop()}>
        <img
          src={backdrop()!}
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            inset: '0',
            width: `${cssW}px`,
            height: `${cssH}px`,
            filter: `blur(${BLUR_PX}px)`,
            'pointer-events': 'none',
          }}
        />
      </Show>

      {/* 锐利底图：只在(实时)选区内露出（clip-path 内缩四边）——拖拽中实时跟随 */}
      <Show when={backdrop() && liveRect()}>
        <img
          src={backdrop()!}
          alt="屏幕快照"
          draggable={false}
          style={{
            position: 'absolute',
            inset: '0',
            width: `${cssW}px`,
            height: `${cssH}px`,
            'clip-path': sharpClip(),
            'pointer-events': 'none',
          }}
        />
      </Show>

      {/* 压暗：无(实时)选区时整屏一层；有则只压选区外四条（锐利图之上） */}
      <Show when={backdrop() && !liveRect()}>
        <div style={{ position: 'absolute', inset: '0', ...dimStyle }} />
      </Show>
      <Show when={backdrop() && liveRect()}>
        {(() => {
          const r = liveRect()!;
          return (
            <>
              <div
                style={{
                  position: 'absolute',
                  left: '0',
                  top: '0',
                  width: `${cssW}px`,
                  height: `${Math.max(0, r.y)}px`,
                  ...dimStyle,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: '0',
                  top: `${r.y + r.height}px`,
                  width: `${cssW}px`,
                  height: `${Math.max(0, cssH - r.y - r.height)}px`,
                  ...dimStyle,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: '0',
                  top: `${r.y}px`,
                  width: `${Math.max(0, r.x)}px`,
                  height: `${r.height}px`,
                  ...dimStyle,
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: `${r.x + r.width}px`,
                  top: `${r.y}px`,
                  width: `${Math.max(0, cssW - r.x - r.width)}px`,
                  height: `${r.height}px`,
                  ...dimStyle,
                }}
              />
            </>
          );
        })()}
      </Show>

      {/* 绘图层：烘焙（已提交）+ 草稿（进行中），都按选区裁剪 */}
      <canvas
        ref={(el) => (bakedCanvas = el)}
        style={{
          position: 'absolute',
          inset: '0',
          width: `${cssW}px`,
          height: `${cssH}px`,
          'pointer-events': 'none',
        }}
      />
      <canvas
        ref={(el) => (draftCanvas = el)}
        style={{
          position: 'absolute',
          inset: '0',
          width: `${cssW}px`,
          height: `${cssH}px`,
          'pointer-events': 'none',
        }}
      />

      {/* 选区边框 + 四角四边把手（视觉提示"可拖拽调整"）+ 尺寸标签 —— 拖拽中实时跟随 */}
      {liveRect() && (() => {
        const r = liveRect()!;
        const handles: { h: HandleKind; x: number; y: number; w: number; hh: number }[] = [
          { h: 'nw', x: r.x, y: r.y, w: 10, hh: 10 },
          { h: 'ne', x: r.x + r.width - 10, y: r.y, w: 10, hh: 10 },
          { h: 'sw', x: r.x, y: r.y + r.height - 10, w: 10, hh: 10 },
          { h: 'se', x: r.x + r.width - 10, y: r.y + r.height - 10, w: 10, hh: 10 },
          { h: 'n', x: r.x + r.width / 2 - 8, y: r.y - 2, w: 16, hh: 5 },
          { h: 's', x: r.x + r.width / 2 - 8, y: r.y + r.height - 3, w: 16, hh: 5 },
          { h: 'w', x: r.x - 2, y: r.y + r.height / 2 - 8, w: 5, hh: 16 },
          { h: 'e', x: r.x + r.width - 3, y: r.y + r.height / 2 - 8, w: 5, hh: 16 },
        ];
        return (
          <>
            <div
              style={{
                position: 'absolute',
                left: `${r.x}px`,
                top: `${r.y}px`,
                width: `${r.width}px`,
                height: `${r.height}px`,
                border: '1px solid #38BDF8',
                'box-sizing': 'border-box',
                'pointer-events': 'none',
              }}
            />
            {handles.map((k) => (
              <div
                style={{
                  position: 'absolute',
                  left: `${k.x}px`,
                  top: `${k.y}px`,
                  width: `${k.w}px`,
                  height: `${k.hh}px`,
                  background: '#38BDF8',
                  'border-radius': '2px',
                  'pointer-events': 'none',
                }}
              />
            ))}
            <div
              style={{
                position: 'absolute',
                left: `${r.x}px`,
                top: `${Math.max(0, r.y - 24)}px`,
                padding: '2px 8px',
                background: '#0EA5E9',
                color: '#fff',
                font: '12px/1.6 ui-sans-serif, system-ui, sans-serif',
                'border-radius': '3px',
                'white-space': 'nowrap',
                'pointer-events': 'none',
              }}
            >
              {describeSize(r, scale)}
            </div>
          </>
        );
      })()}

      {/* 工具栏：绘图工具 ×5 + 配色板 ×6 + 撤销 + 取消 + 确认 */}
      <Show when={rectNow() && !busy() && backdrop()}>
        {(() => {
          const r = rectNow()!;
          const pos = toolbarOrigin(r, cssW, cssH, BAR_W, BAR_H);
          return (
            <div
              style={{
                position: 'fixed',
                left: `${pos.x}px`,
                top: `${pos.y}px`,
                display: 'flex',
                'align-items': 'center',
                gap: '4px',
                padding: '4px',
                background: 'rgba(15,23,42,0.96)',
                border: '1px solid rgba(148,163,184,0.25)',
                'border-radius': '8px',
                'box-shadow': '0 8px 24px rgba(0,0,0,0.45)',
                cursor: 'default',
                'z-index': '20',
              }}
              // 工具栏内的按下不能落进画布逻辑（否则点按钮会先起一笔）
              onPointerDown={(e: PointerEvent) => e.stopPropagation()}
              onContextMenu={(e: MouseEvent) => e.preventDefault()}
            >
              {TOOLS.map((t) => (
                <button
                  title={t.label}
                  style={tool() === t.id ? barBtnActive : barBtn}
                  onClick={toolbarAct(() => setTool((cur) => (cur === t.id ? 'none' : t.id)))}
                >
                  {t.icon}
                </button>
              ))}
              <div style={{ width: '1px', height: '20px', background: 'rgba(148,163,184,0.3)' }} />
              {PALETTE.map((c) => (
                <button
                  title="配色"
                  style={{
                    ...barBtn,
                    width: '16px',
                    height: '16px',
                    'border-radius': '999px',
                    background: c,
                    opacity: color() === c ? 1 : 0.55,
                    'box-shadow': color() === c ? '0 0 0 2px #38BDF8' : 'none',
                  }}                  onClick={toolbarAct(() => setColor(c))}
                />
              ))}
              <div style={{ width: '1px', height: '20px', background: 'rgba(148,163,184,0.3)' }} />
              <button
                title="撤销上一笔"
                style={{ ...(shapes().length === 0 ? { ...barBtn, opacity: 0.4, cursor: 'default' } : barBtn) }}
                onClick={toolbarAct(() => undoLast())}
              >
                ↩
              </button>
              <button title="取消截图" style={barBtn} onClick={toolbarAct(() => void cancel())}>
                ✕
              </button>
              <button
                title="确认截图（Enter）"
                style={{
                  ...barBtn,
                  width: '34px',
                  background: '#0EA5E9',
                  color: '#fff',
                  'font-weight': 700,
                }}
                onClick={toolbarAct(() => void confirm())}
              >
                ✓
              </button>
            </div>
          );
        })()}
      </Show>

      {/* 快捷键提示（底图就绪后才出现，别让提示先于"冻结的屏幕"冒出来） */}
      {hintOn() && !error() && backdrop() && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '48px',
            transform: 'translateX(-50%)',
            padding: '6px 14px',
            background: 'rgba(0,0,0,0.72)',
            color: '#E2E8F0',
            font: '12px/1.6 ui-sans-serif, system-ui, sans-serif',
            'border-radius': '999px',
            'pointer-events': 'none',
          }}
        >
          拖拽框选 · 边角可调整 · 选区外长按重选 · Enter 确认 · Esc 取消
        </div>
      )}

      {/* 错误提示（选区过小 / 截图失败） */}
      {error() && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '48px',
            transform: 'translateX(-50%)',
            padding: '8px 16px',
            background: 'rgba(190,18,60,0.92)',
            color: '#fff',
            font: '13px/1.6 ui-sans-serif, system-ui, sans-serif',
            'border-radius': '6px',
            'pointer-events': 'none',
          }}
        >
          {error()}
          {!backdrop() && ' · Esc 关闭'}
        </div>
      )}
    </div>
  );
}
