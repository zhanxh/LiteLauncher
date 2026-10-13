/**
 * 截图标注层（视图窗口`?view=annotate`）
 *
 * 定位：对齐 Snipaste / PixPin / ShareX 的"截图后立刻标注"主路径——
 * 框选完**不直接出图**，而是进这里画箭头/马赛克/文字，确认后才落盘+进剪贴板。
 * 用户不需要"先截图 → 打开画图软件 → 导入 → 导出 → 再粘贴"这一整套。
 *
 * 为什么在插件侧做：标注是纯前端 Canvas 合成，宿主只提供"PNG 字节 → 落盘/剪贴板"
 * （svc.screen.savePng）。若把绘图逻辑塞进宿主，就等于把一个插件的功能硬编码进壳层。
 *
 * 绘制/几何计算在 ./annotate.ts（纯函数，可被 node 测试直接跑）。
 */
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getPluginContext } from '@ll/sdk';
import {
  arrowHead,
  DEFAULT_WIDTH,
  isTooShort,
  mosaicBlocks,
  normBox,
  stepNumbers,
  PALETTE,
  type Annotation,
  type DraftShape,
  type ToolKind,
} from './annotate';

const ctx = getPluginContext('shot');

/** 工具栏定义：顺序即用户找工具的顺序（最常用的排前面） */
const TOOLS: { id: Exclude<ToolKind, 'none'>; label: string; icon: string; hint: string }[] = [
  { id: 'arrow', label: '箭头', icon: '➚', hint: '按住拖拽画箭头' },
  { id: 'rect', label: '矩形', icon: '▭', hint: '按住拖拽画矩形' },
  { id: 'ellipse', label: '椭圆', icon: '◯', hint: '按住拖拽画椭圆' },
  { id: 'line', label: '直线', icon: '╱', hint: '按住拖拽画直线' },
  { id: 'mosaic', label: '马赛克', icon: '▦', hint: '拖拽遮挡敏感区域' },
  { id: 'text', label: '文字', icon: 'T', hint: '点击后输入文字' },
  { id: 'step', label: '步骤号', icon: '①', hint: '点击标序号，按阅读顺序自动编号' },
];

const MIN_DRAG = 4;

export function ShotAnnotate() {
  const params = new URLSearchParams(window.location.search);
  /**
   * 上一步截出来的图（select 视图落在磁盘上的路径）。
   *
   * 注意：`capture({region})` 返回的图**已经就是选区本身**（宿主按区域裁好了），
   * 所以这里不需要、也不应该再传裁剪偏移或缩放——多传一层坐标系只会引入错位。
   */
  const srcPath = params.get('src') ?? '';

  const [tool, setTool] = createSignal<Exclude<ToolKind, 'none'>>('arrow');
  const [color, setColor] = createSignal<string>(PALETTE[0]);
  const [annotations, setAnnotations] = createSignal<Annotation[]>([]);
  const [draft, setDraft] = createSignal<DraftShape | null>(null);
  const [imgSrc, setImgSrc] = createSignal<string>('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  /** 文字输入：非空时弹出一个输入框 */
  const [textDraft, setTextDraft] = createSignal<{ x: number; y: number; value: string } | null>(null);

  const win = getCurrentWindow();
  let canvasRef: HTMLCanvasElement | undefined;
  let seq = 0;
  let drawing = false;

  function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /** 图片元素：标注绘制（尤其马赛克取色）都需要它的尺寸做基准 */
  let imgEl: HTMLImageElement | undefined;

  onMount(() => {
    // Ctrl+Z 撤销：提示条里承诺了就得真的能用
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));

    if (!srcPath) {
      setError('缺少原图路径（请从 /shot 区域框选进入）');
      return;
    }
    void (async () => {
      try {
        const dataUrl = await fetchFileAsDataUrl(srcPath);
        setImgSrc(dataUrl);
        const img = new Image();
        img.onload = () => {
          imgEl = img;
          redraw();
        };
        img.src = dataUrl;
      } catch (err) {
        setError(`载入原图失败：${messageOf(err)}`);
      }
    })();
  });

  /** 读本地文件为 data URL（与 select 视图同一做法，避免 convertFileSrc 的 CSP 差异） */
  async function fetchFileAsDataUrl(filePath: string): Promise<string> {
    const resp = await fetch(`file:///${filePath.replace(/\\/g, '/').replace(/^\/+/, '')}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      bin += String.fromCharCode(...buf.subarray(i, i + chunk));
    }
    return `data:image/png;base64,${btoa(bin)}`;
  }

/** 把 srcPath 那张 PNG 铺到 canvas 上作为标注底图 */
function drawBase(): void {
    const cv = canvasRef;
    if (!cv || !imgEl) return;
    const g = cv.getContext('2d');
    if (!g) return;
    // 原图即选区，1:1 铺满（physical pixel = image pixel），保证导出不糊
    cv.width = imgEl.naturalWidth;
    cv.height = imgEl.naturalHeight;
    g.drawImage(imgEl, 0, 0);
  }

  /** 重绘：底图 + 已落标注 + 正在拖拽的草稿 */
  function redraw(): void {
    drawBase();
    const cv = canvasRef;
    if (!cv) return;
    const g = cv.getContext('2d');
    if (!g) return;
    // 恢复 drawBase 可能改过的合成模式
    g.globalCompositeOperation = 'source-over';

    for (const a of annotations()) drawAnnotation(g, a, stepNumbers(annotations()));
    const d = draft();
    if (d) {
      drawAnnotation(g, { ...toAnnotation(d), id: 'draft', color: color(), size: sizeOf(tool()) });
    }
  }

  function sizeOf(t: Exclude<ToolKind, 'none'>): number {
    return DEFAULT_WIDTH[t];
  }

  function toAnnotation(d: DraftShape): Omit<Annotation, 'id' | 'color' | 'size'> {
    return { kind: d.kind, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 };
  }

  /** 画一条标注 */
  function drawAnnotation(
    g: CanvasRenderingContext2D,
    a: Pick<Annotation, 'kind' | 'x1' | 'y1' | 'x2' | 'y2' | 'text' | 'color' | 'size'> & { id?: string },
    stepNums?: Map<string, number>,
  ): void {
    g.save();
    g.strokeStyle = a.color;
    g.fillStyle = a.color;
    g.lineWidth = Math.max(1, a.size);
    g.lineCap = 'round';
    g.lineJoin = 'round';

    switch (a.kind) {
      case 'arrow': {
        g.beginPath();
        g.moveTo(a.x1, a.y1);
        g.lineTo(a.x2, a.y2);
        g.stroke();
        const [p1, p2] = arrowHead(a.x1, a.y1, a.x2, a.y2, Math.max(10, a.size * 4));
        g.beginPath();
        g.moveTo(a.x2, a.y2);
        g.lineTo(p1.x, p1.y);
        g.moveTo(a.x2, a.y2);
        g.lineTo(p2.x, p2.y);
        g.stroke();
        break;
      }
      case 'rect': {
        const b = normBox({ kind: 'rect', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 });
        g.strokeRect(b.x, b.y, b.w, b.h);
        break;
      }
      case 'ellipse': {
        const b = normBox({ kind: 'ellipse', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 });
        g.beginPath();
        g.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(0.5, b.w / 2), Math.max(0.5, b.h / 2), 0, 0, Math.PI * 2);
        g.stroke();
        break;
      }
      case 'line': {
        g.beginPath();
        g.moveTo(a.x1, a.y1);
        g.lineTo(a.x2, a.y2);
        g.stroke();
        break;
      }
      case 'mosaic': {
        // 先用底图画一块"马赛克化"的预览贴上去，再叠半透明色块——
        // 真实打码在导出时做（见 exportComposite）
        g.globalAlpha = 0.85;
        for (const b of mosaicBlocks(a.x1, a.y1, a.x2, a.y2, Math.max(4, a.size))) {
          g.fillRect(b.x, b.y, b.size, b.size);
        }
        g.globalAlpha = 1;
        break;
      }
      case 'text': {
        g.font = `600 ${Math.max(12, a.size)}px ui-sans-serif, system-ui, sans-serif`;
        g.textBaseline = 'top';
        g.fillText(a.text ?? '', a.x1, a.y1);
        break;
      }
      case 'step': {
        const n = (a.id && stepNums?.get(a.id)) || 1;
        const r = 14;
        g.beginPath();
        g.arc(a.x1, a.y1, r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#FFFFFF';
        g.font = `700 ${Math.round(r * 1.2)}px ui-sans-serif, system-ui, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(n), a.x1, a.y1 + 1);
        break;
      }
      default:
        break;
    }
    g.restore();
  }

  function localPoint(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const cv = canvasRef!;
    const box = cv.getBoundingClientRect();
    // canvas 可能被 CSS 缩放显示（窗口小图大），要按比例换算回canvas 像素
    return {
      x: ((e.clientX - box.left) / box.width) * cv.width,
      y: ((e.clientY - box.top) / box.height) * cv.height,
    };
  }

  function onPointerDown(e: PointerEvent): void {
    if (busy()) return;
    const pt = localPoint(e);
    drawing = true;
    // 文字/步骤号是"点击即放置"，不需要拖拽
    if (tool() === 'text') {
      setTextDraft({ x: pt.x, y: pt.y, value: '' });
      setDraft(null);
      return;
    }
    if (tool() === 'step') {
      pushAnnotation({ kind: 'step', x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, size: 0 });
      drawing = false;
      return;
    }
    setDraft({ kind: tool(), x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
    canvasRef?.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drawing) return;
    const d = draft();
    if (!d) return;
    const pt = localPoint(e);
    const next = { ...d, x2: pt.x, y2: pt.y };
    setDraft(next);
    // 草稿也画出来：用户松手前要能看到实时预览
    redraw();
  }

  function onPointerUp(): void {
    if (!drawing) return;
    drawing = false;
    const d = draft();
    setDraft(null);
    if (!d) return;
    if (isTooShort(d, MIN_DRAG)) {
      redraw();
      return;
    }
    pushAnnotation({ ...toAnnotation(d), size: sizeOf(tool()) });
  }

  function pushAnnotation(a: Omit<Annotation, 'id' | 'color'> & { color?: string }): void {
    seq += 1;
    setAnnotations((prev) => [...prev, { ...a, id: `a${seq}`, color: a.color ?? color() }]);
  }

  /** 提交文字标注 */
  function commitText(): void {
    const t = textDraft();
    if (!t) return;
    const value = t.value.trim();
    if (value) {
      pushAnnotation({ kind: 'text', x1: t.x, y1: t.y, x2: t.x, y2: t.y, text: value, size: 20 });
    }
    setTextDraft(null);
  }

  function undo(): void {
    setAnnotations((prev) => prev.slice(0, -1));
  }

  function clearAll(): void {
    setAnnotations([]);
  }

  /**
   * 导出成品：把标注按物理像素尺度烘焙进PNG，交给宿主落盘 + 进剪贴板。
   *
   * 关键：**马赛克必须在这里做真实的像素化**。
   * 预览时是半透明色块（那样用户看得见自己遮住了哪），
   * 但导出的图必须是真的糊掉——否则"打码"只是遮了颜色，图片信息还在。
   */
  async function exportComposite(): Promise<void> {
    const cv = canvasRef;
    if (!cv) return;
    setBusy(true);
    setError('');
    try {
      const out = document.createElement('canvas');
      out.width = cv.width;
      out.height = cv.height;
      const g = out.getContext('2d');
      if (!g) throw new Error('无法创建导出画布');
      g.drawImage(cv, 0, 0);

      // 真实像素化：对每个马赛克区域，取区域均值色填块
      const mosaics = annotations().filter((a) => a.kind === 'mosaic');
      if (mosaics.length > 0 && imgEl) {
        const src = document.createElement('canvas');
        src.width = cv.width;
        src.height = cv.height;
        const sg = src.getContext('2d');
        if (sg) {
          sg.drawImage(imgEl, 0, 0, out.width, out.height);
          for (const m of mosaics) {
            for (const blk of mosaicBlocks(m.x1, m.y1, m.x2, m.y2, Math.max(4, m.size))) {
              const x = Math.max(0, Math.floor(blk.x));
              const y = Math.max(0, Math.floor(blk.y));
              const w = Math.max(1, Math.min(Math.floor(blk.size), out.width - x));
              const h = Math.max(1, Math.min(Math.floor(blk.size), out.height - y));
              if (w <= 0 || h <= 0) continue;
              const region = sg.getImageData(x, y, w, h);
              let sr = 0;
              let sg2 = 0;
              let sb = 0;
              const n = region.data.length / 4 || 1;
              for (let i = 0; i < region.data.length; i += 4) {
                sr += region.data[i];
                sg2 += region.data[i + 1];
                sb += region.data[i + 2];
              }
              g.fillStyle = `rgb(${Math.round(sr / n)},${Math.round(sg2 / n)},${Math.round(sb / n)})`;
              g.fillRect(x, y, w, h);
            }
          }
        }
      }

      const dataUrl = out.toDataURL('image/png');
      const saved = await ctx.screen.savePng(dataUrl, { toClipboard: true });

      await ctx.settings.setJson('lastShot', {
        path: saved.path,
        width: saved.width,
        height: saved.height,
      });
      await ctx.notify
        .send(
          '标注截图完成',
          saved.clipboardImage
            ? `${saved.width}×${saved.height} · 图片已复制，可直接粘贴`
            : `${saved.width}×${saved.height} · 已保存到 ${saved.path}`,
        )
        .catch(() => undefined);
      await win.close();
    } catch (err) {
      setError(`导出失败：${messageOf(err)}`);
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100vh',
        background: 'var(--bg-solid)',
        color: 'var(--text-main)',
        'font-family': 'var(--font-family)',
      }}
    >
      {/* 工具栏 */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '6px',
          padding: '8px 10px',
          'border-bottom': `1px solid var(--border-subtle)`,
          'flex-wrap': 'wrap',
        }}
      >
        <For each={TOOLS}>
          {(t) => (
            <button
              title={t.hint}
              onClick={() => setTool(t.id)}
              style={{
                padding: '4px 10px',
                'font-size': '12px',
                cursor: 'pointer',
                'border-radius': '6px',
                border: `1px solid ${tool() === t.id ? 'var(--accent-color)' : 'var(--border-subtle)'}`,
                background: tool() === t.id ? 'var(--accent-light)' : 'transparent',
                color: 'var(--text-main)',
              }}
            >
              {t.icon} {t.label}
            </button>
          )}
        </For>

        <span style={{ width: '8px' }} />

        {/* 色板 */}
        <For each={PALETTE}>
          {(c) => (
            <button
              title={c}
              onClick={() => setColor(c)}
              style={{
                width: '18px',
                height: '18px',
                'border-radius': '50%',
                cursor: 'pointer',
                background: c,
                border: color() === c ? '2px solid var(--text-main)' : '1px solid var(--border-subtle)',
              }}
            />
          )}
        </For>

        <span style={{ flex: '1' }} />

        <button
          onClick={undo}
          disabled={annotations().length === 0}
          style={{
            padding: '4px 10px', 'font-size': '12px', cursor: 'pointer',
            'border-radius': '6px', border: '1px solid var(--border-subtle)',
            background: 'transparent', color: 'var(--text-main)',
            opacity: annotations().length === 0 ? 0.4 : 1,
          }}
        >
          ↶ 撤销
        </button>
        <button
          onClick={clearAll}
          disabled={annotations().length === 0}
          style={{
            padding: '4px 10px', 'font-size': '12px', cursor: 'pointer',
            'border-radius': '6px', border: '1px solid var(--border-subtle)',
            background: 'transparent', color: 'var(--text-main)',
            opacity: annotations().length === 0 ? 0.4 : 1,
          }}
        >
          清空
        </button>
        <button
          onClick={() => void exportComposite()}
          disabled={busy()}
          style={{
            padding: '4px 12px', 'font-size': '12px', cursor: 'pointer', 'font-weight': '600',
            'border-radius': '6px', border: '1px solid var(--accent-color)',
            background: 'var(--accent-color)', color: '#fff',
            opacity: busy() ? 0.6 : 1,
          }}
        >
          {busy() ? '导出中…' : '✓ 完成并复制'}
        </button>
      </div>

      {/* 画布区 */}
      <div style={{ flex: '1', position: 'relative', overflow: 'auto', background: 'var(--bg-launcher, #222)' }}>
        <Show
          when={imgSrc()}
          fallback={<div style={{ padding: '20px', color: 'var(--text-muted)' }}>{error() || '载入中…'}</div>}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{
              display: 'block',
              cursor: tool() === 'text' || tool() === 'step' ? 'crosshair' : 'crosshair',
              'max-width': '100%',
            }}
          />
        </Show>

        {/* 文字输入浮层 */}
        <Show when={textDraft()}>
          {(t) => (
            <input
              autofocus
              value={t().value}
              placeholder="输入文字后回车"
              onInput={(e) => setTextDraft({ ...t(), value: e.currentTarget.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitText();
                if (e.key === 'Escape') setTextDraft(null);
              }}
              onBlur={commitText}
              style={{
                position: 'absolute',
                left: `${(t().x / (canvasRef?.width || 1)) * 100}%`,
                top: `${(t().y / (canvasRef?.height || 1)) * 100}%`,
                padding: '4px 8px',
                'font-size': '13px',
                border: '1px solid var(--accent-color)',
                'border-radius': '4px',
                background: 'var(--surface-raised)',
                color: 'var(--text-main)',
                outline: 'none',
              }}
            />
          )}
        </Show>

        {/* 错误提示 */}
        <Show when={error()}>
          <div
            style={{
              position: 'absolute', left: '50%', top: '12px', transform: 'translateX(-50%)',
              padding: '6px 14px', background: 'var(--danger-soft)', color: 'var(--danger-text)',
              'border-radius': '6px', 'font-size': '12px',
            }}
          >
            {error()}
          </div>
        </Show>
      </div>

      {/* 底部提示 */}
      <div
        style={{
          padding: '6px 12px',
          'border-top': `1px solid var(--border-subtle)`,
          'font-size': '11px',
          color: 'var(--text-muted)',
        }}
      >
        在图上按住拖拽即可标注 · 步骤号按阅读顺序自动编号 · 马赛克导出时会真正像素化 · Ctrl+Z 撤销
      </div>
    </div>
  );
}