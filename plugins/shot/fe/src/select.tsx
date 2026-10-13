/**
 * 区域框选层（全屏透明窗口视图，`?view=select`）
 *
 * 交互流程（对齐 Snipaste / ShareX / Win+Shift+S 的主路径）：
 *   1. 窗口打开（全屏、透明、置顶、跳过任务栏 —— 见 manifest 的 view 声明）
 *   2. **先抓一张当前屏作为底图**（此刻遮罩层自己还在，xcap 会把它拍进来，
 *      所以抓图时传 hideWindows 让宿主先隐藏所有 LiteLauncher 窗口，抓完再显示）
 *   3. 底图铺满作为背景，用户在上面拖拽框选
 *   4. 回车 / 松手确认 → 调 svc.screen.capture({region}) 截那块区域
 *      → 图片本体进剪贴板 → 关闭本窗口
 *   5. Esc 取消 → 关闭本窗口，不产生任何副作用
 *
 * 为什么底图必须"抓完再显示"：遮罩层一旦可见，就会被 xcap 拍进截图里，
 * 用户框选时会看到一层灰蒙蒙的遮罩压在内容上。顺序反了就会露馅。
 */
import { createSignal, onCleanup, onMount } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getPluginContext, type CaptureResult, type MonitorInfo } from '@ll/sdk';
import { cssToGlobal, describeSize, isTinyDrag, normalizeDrag, type DragState } from './geometry';

const ctx = getPluginContext('shot');

/** 低于该尺寸视为"单击误触"，直接忽略 */
const MIN_DRAG = 4;

/** 标注视图（manifest 的 views[].id 必须一致） */
const VIEW_ANNOTATE = 'annotate';

export function ShotSelect() {
  const params = new URLSearchParams(window.location.search);
  /** -1 = 光标所在屏；0..n = 指定屏 */
  const monitor = Number.parseInt(params.get('monitor') ?? '-1', 10);
  const delayMs = Number.parseInt(params.get('delayMs') ?? '0', 10) || 0;
  /** 是否在框选后直接进标注层（用户在 /shot 面板里选"标注"时才为真） */
  const annotateMode = params.get('annotate') === '1';

  /** 底图（PNG 的 data URL），null = 还没抓好 */
  const [backdrop, setBackdrop] = createSignal<string | null>(null);
  const [drag, setDrag] = createSignal<DragState | null>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  /** 提示条（快捷键说明），鼠标静止 2s 后淡出 */
  const [hintOn, setHintOn] = createSignal(true);

  /** 遮罩层自身的 CSS 尺寸 = 屏幕物理尺寸 / scaleFactor */
  let cssW = 0;
  let cssH = 0;
  /** 目标屏在虚拟桌面中的原点（副屏可为负） */
  let originX = 0;
  let originY = 0;
  /** 目标屏缩放因子 */
  let scale = 1;

  let dragging = false;
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

    // 遮罩层窗口已被宿主铺满该屏；CSS 尺寸 = 物理尺寸 / scale
    const size = await win.outerSize();
    cssW = size.width;
    cssH = size.height;
    // 兜底：拿不到窗口尺寸时按显示器推算
    if (!cssW || !cssH) {
      cssW = Math.round(chosen.width / scale);
      cssH = Math.round(chosen.height / scale);
    }
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
   * `hideWindows: true` 让宿主先把**所有** LiteLauncher 窗口（含本遮罩层）隐藏
   * 再抓屏，抓完恢复——否则底图里会出现自己这层遮罩。
   * 注意这里**不要** toClipboard：用户还没框选，不该有任何剪贴板副作用。
   */
  async function grabBackdrop(): Promise<void> {
    const shot: CaptureResult = await ctx.screen.capture({
      monitor,
      hideWindows: true,
      delayMs,
    });

    // 走 fetch 把本地 PNG 转成 data URL 供 <img> 展示。
    // Tauri 的 convertFileSrc 是给本地资源 URL 用的；这里用 fetch 读字节更直白。
    const bytes = await fetchFileAsDataUrl(shot.path);
    setBackdrop(bytes);
  }

  /** 读本地 PNG 文件并转 data URL（避免依赖 convertFileSrc 的 CSP 配置差异） */
  async function fetchFileAsDataUrl(filePath: string): Promise<string> {
    const resp = await fetch(`file:///${filePath.replace(/\\/g, '/').replace(/^\/+/, '')}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    // 二进制转 base64：分块避免 apply 的参数上限
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      bin += String.fromCharCode(...buf.subarray(i, i + chunk));
    }
    return `data:image/png;base64,${btoa(bin)}`;
  }

  /** 用户确认：截取选区 */
  async function confirm(): Promise<void> {
    if (busy()) return;
    const d = drag();
    if (!d) return;
    const rect = normalizeDrag(d);
    if (isTinyDrag(rect, MIN_DRAG)) {
      setError('选区太小，请拖拽框选一块区域');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const region = cssToGlobal(rect, scale, { x: originX, y: originY });
      const shot = await ctx.screen.capture({
        region,
        hideWindows: true,
        // 标注模式下先不写剪贴板：最终成品还没画完，
        // 过早写进去会让用户 Ctrl+V 贴到一张没标注的图
        toClipboard: !annotateMode,
      });

      // 标注模式：把原图与选区偏移交给标注视图，由它合成后统一落盘+进剪贴板
      if (annotateMode) {
        // 只传原图路径：capture({region}) 的产物已经是选区本身，
        // 标注层按1:1 铺开即可。再传偏移/缩放只会引入坐标系错位。
        await ctx.windows.open(VIEW_ANNOTATE, { src: shot.path }).catch(() => undefined);
        // 标注层有自己的窗口，关掉本遮罩层
        await win.close().catch(() => undefined);
        return;
      }

      // 记忆最近一次，供主面板"打开/打开文件夹"用（跨窗口共享，故落 KV）
      await ctx.settings.setJson('lastShot', {
        path: shot.path,
        width: shot.width,
        height: shot.height,
      });

      // 启动器主窗口是隐藏态，toast 用户看不到 —— 用系统通知反馈结果
      await ctx.notify
        .send(
          '区域截图完成',
          shot.clipboardImage
            ? `${shot.width}×${shot.height} · 图片已复制，可直接粘贴`
            : `${shot.width}×${shot.height} · 已保存到 ${shot.path}`,
        )
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
    // 先读光标位置（选屏要用），再抓底图，最后才显示遮罩内容
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
        await grabBackdrop();
      } catch (err) {
        setError(`无法准备框选层：${messageOf(err)}`);
      }
    })();

    window.addEventListener('keydown', onKeyDown);
    // 提示条 2.5s 后淡出，别长期遮挡内容
    hintTimer = setTimeout(() => setHintOn(false), 2500);

    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown);
      if (hintTimer) clearTimeout(hintTimer);
      void win.close().catch(() => undefined);
    });
  });

  function onPointerDown(e: PointerEvent): void {
    if (busy()) return;
    dragging = true;
    const pt = localPoint(e);
    setDrag({ startX: pt.x, startY: pt.y, curX: pt.x, curY: pt.y });
    setHintOn(false);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const pt = localPoint(e);
    setDrag((d) => (d ? { ...d, curX: pt.x, curY: pt.y } : d));
  }

  function onPointerUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    const pt = localPoint(e);
    const next: DragState = {
      startX: drag()?.startX ?? pt.x,
      startY: drag()?.startY ?? pt.y,
      curX: pt.x,
      curY: pt.y,
    };
    setDrag(next);
    const rect = normalizeDrag(next);
    // 松手即确认（对齐主流截图工具：拖完直接出结果，不用再按回车）；
    // 误触（点了一下）则忽略并保留遮罩层
    if (!isTinyDrag(rect, MIN_DRAG)) void confirm();
  }

  /** 指针相对遮罩层的 CSS 坐标 */
  function localPoint(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  const rectNow = () => {
    const d = drag();
    return d ? normalizeDrag(d) : null;
  };

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
        background: backdrop() ? 'transparent' : 'rgba(0,0,0,0.6)',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* 底图：抓屏那一刻的画面 */}
      {backdrop() && (
        <img
          src={backdrop()!}
          alt="屏幕快照"
          draggable={false}
          style={{
            position: 'absolute',
            left: '0',
            top: '0',
            width: `${cssW}px`,
            height: `${cssH}px`,
            'pointer-events': 'none',
          }}
        />
      )}

      {/* 未选区时的整体压暗，突出"这是一层遮罩" */}
      {!rectNow() && (
        <div
          style={{
            position: 'absolute',
            inset: '0',
            background: 'rgba(0,0,0,0.28)',
            'pointer-events': 'none',
          }}
        />
      )}

      {/* 选区：区内透明、区外压暗 —— 这是所有截图工具一致的视觉语言 */}
      {rectNow() && (() => {
        const r = rectNow()!;
        return (
          <>
            <div
              style={{
                position: 'absolute',
                left: '0',
                top: '0',
                width: `${cssW}px`,
                height: `${Math.max(0, r.y)}px`,
                background: 'rgba(0,0,0,0.45)',
                'pointer-events': 'none',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: '0',
                top: `${r.y + r.height}px`,
                width: `${cssW}px`,
                height: `${Math.max(0, cssH - r.y - r.height)}px`,
                background: 'rgba(0,0,0,0.45)',
                'pointer-events': 'none',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: '0',
                top: `${r.y}px`,
                width: `${Math.max(0, r.x)}px`,
                height: `${r.height}px`,
                background: 'rgba(0,0,0,0.45)',
                'pointer-events': 'none',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: `${r.x + r.width}px`,
                top: `${r.y}px`,
                width: `${Math.max(0, cssW - r.x - r.width)}px`,
                height: `${r.height}px`,
                background: 'rgba(0,0,0,0.45)',
                'pointer-events': 'none',
              }}
            />
            {/* 选区边框 */}
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
            {/* 尺寸标签 */}
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

      {/* 快捷键提示 */}
      {hintOn() && !error() && (
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
          拖拽框选 · 松手或回车确认 · Esc 取消
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
        </div>
      )}
    </div>
  );
}
