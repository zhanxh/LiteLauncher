/**
 * 取色台（浮动窗口视图，`?view=panel`）
 *
 * 交互模型：面板固定在屏幕右下角，**持续采样鼠标所在位置的像素**并实时显示
 * 放大镜与 HEX/RGB/HSL；鼠标一旦移进面板就冻结显示（否则采到的会是面板自己的
 * 颜色），此时点按钮复制。也可随时按全局热键 alt+p 直接确认。
 *
 * 为什么不做全屏遮罩式取色（PowerToys 那种）：ViewSpec 目前没有
 * fullscreen / transparent 声明位，宿主也还没提供"窗口跟随光标"的能力。
 */
import { createSignal, onCleanup, onMount, For } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getPluginContext, type PixelResult } from '@ll/sdk';
import { formatColor, readableOn, rgbToHsl, type ColorFormat } from './color';
import { pushHistory, setPanelOpen } from './history';

const ctx = getPluginContext('pick');

/** 采样间隔（ms）：约 7Hz——既跟手又不至于把宿主抓帧线程压满 */
const POLL_MS = 140;
/** 放大镜半径：7 → 15×15 方格 */
const RADIUS = 7;
/** 与 manifest 的 `shortcut:alt+p` 声明保持一致 */
const HOTKEY = 'alt+p';

export function PickPanel() {
  const [pixel, setPixel] = createSignal<PixelResult | null>(null);
  const [frozen, setFrozen] = createSignal(false);
  const [error, setError] = createSignal('');
  const [copied, setCopied] = createSignal('');

  let timer: ReturnType<typeof setTimeout> | null = null;
  let alive = true;
  let unlisten: (() => void) | null = null;
  // 面板自身的屏幕矩形（物理像素，与 ctx.screen 的坐标系一致）
  let rect = { x: 0, y: 0, w: 0, h: 0 };

  async function refreshRect(): Promise<void> {
    try {
      const win = getCurrentWindow();
      const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
      rect = { x: pos.x, y: pos.y, w: size.width, h: size.height };
    } catch {
      // 拿不到窗口几何时退化为"永不冻结"，功能仍可用（只是按钮会采到面板色）
      ctx.log.warn('取色台无法读取窗口位置，冻结逻辑已降级');
    }
  }

  function pointInside(x: number, y: number): boolean {
    return rect.w > 0 && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
  }

  async function tick(): Promise<void> {
    if (!alive) return;
    try {
      // 不传坐标：宿主自行取当前光标位置并采样，一次调用拿到"位置 + 颜色 + 放大镜"
      const res = await ctx.screen.pixel({ radius: RADIUS });
      if (pointInside(res.sample.x, res.sample.y)) {
        // 光标在面板上 → 冻结，保留上一次"面板外"的采样
        setFrozen(true);
      } else {
        setPixel(res);
        setFrozen(false);
        setError('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    if (alive) timer = setTimeout(() => void tick(), POLL_MS);
  }

  async function confirm(format: ColorFormat): Promise<void> {
    const current = pixel()?.sample;
    if (!current) {
      setCopied('还没有取到颜色');
      return;
    }
    const text = formatColor(current, format);
    try {
      await ctx.clipboard.write(text);
      await pushHistory(current.hex);
      setCopied(`已复制 ${text}`);
      // 复制成功后立刻收工：取色的下一步通常是去粘贴
      setTimeout(() => {
        void getCurrentWindow().close();
      }, 120);
    } catch (err) {
      setCopied(`复制失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onMount(() => {
    void (async () => {
      await setPanelOpen(true);
      await refreshRect();
      // 窗口位置可能被系统改（多屏切换、DPI 变化），每 2 秒刷新一次几何
      const rectTimer = setInterval(() => void refreshRect(), 2000);
      onCleanup(() => clearInterval(rectTimer));

      unlisten = await ctx.shortcuts.on(HOTKEY, () => void confirm('hex'), { scope: 'any' });
      void tick();
    })();

    onCleanup(() => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (unlisten) unlisten();
      void setPanelOpen(false);
    });
  });

  const sample = () => pixel()?.sample ?? null;
  const grid = () => pixel()?.grid ?? null;
  const hsl = () => {
    const s = sample();
    return s ? rgbToHsl(s.r, s.g, s.b) : null;
  };

  return (
    <div
      style={{
        'font-family': 'system-ui, -apple-system, "Segoe UI", sans-serif',
        'font-size': '12px',
        color: '#e8e8ea',
        background: '#1b1b1f',
        height: '100vh',
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
        padding: '10px',
        'box-sizing': 'border-box',
        'user-select': 'none',
      }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
        <span style={{ 'font-weight': '600' }}>取色台</span>
        <span style={{ opacity: 0.55, 'font-size': '11px' }}>
          {frozen() ? '已冻结（鼠标在面板上）' : '跟随鼠标'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: '10px', 'align-items': 'flex-start' }}>
        {/* 放大镜：每格 12px 的像素方块（硬边，不用插值） */}
        <div
          style={{
            display: 'grid',
            'grid-template-columns': `repeat(${grid()?.cols ?? RADIUS * 2 + 1}, 12px)`,
            'grid-template-rows': `repeat(${grid()?.rows ?? RADIUS * 2 + 1}, 12px)`,
            border: '1px solid #3a3a42',
            'border-radius': '4px',
            overflow: 'hidden',
            'flex-shrink': 0,
          }}
        >
          <For each={grid()?.cells ?? []}>
            {(cell, index) => (
              <div
                style={{
                  background: cell,
                  outline: index() === grid()?.center ? '2px solid #ffffff' : 'none',
                  'outline-offset': '-2px',
                }}
              />
            )}
          </For>
        </div>

        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', flex: 1 }}>
          <div
            style={{
              height: '34px',
              'border-radius': '4px',
              background: sample()?.hex ?? '#2a2a30',
              border: '1px solid #3a3a42',
              color: sample() ? readableOn(sample()!) : '#e8e8ea',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
              'font-weight': '600',
            }}
          >
            {sample()?.hex ?? '—'}
          </div>
          <div style={{ 'font-family': 'ui-monospace, monospace', opacity: 0.75 }}>
            {sample() ? `rgb(${sample()!.r}, ${sample()!.g}, ${sample()!.b})` : '—'}
          </div>
          <div style={{ 'font-family': 'ui-monospace, monospace', opacity: 0.75 }}>
            {hsl() ? `hsl(${hsl()!.h}, ${hsl()!.s}%, ${hsl()!.l}%)` : '—'}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '6px' }}>
        <button style={buttonStyle} onClick={() => void confirm('hex')}>
          复制 HEX
        </button>
        <button style={buttonStyle} onClick={() => void confirm('rgb')}>
          RGB
        </button>
        <button style={buttonStyle} onClick={() => void confirm('hsl')}>
          HSL
        </button>
        <button style={{ ...buttonStyle, 'margin-left': 'auto' }} onClick={() => void getCurrentWindow().close()}>
          关闭
        </button>
      </div>

      <div style={{ 'font-size': '11px', opacity: 0.6, 'min-height': '14px' }}>
        {error() ? `采样失败：${error()}` : copied() || `移到目标颜色上，回到面板点复制；或按 ${HOTKEY} 直接确认`}
      </div>
    </div>
  );
}

const buttonStyle = {
  flex: '0 0 auto',
  padding: '5px 10px',
  'border-radius': '4px',
  border: '1px solid #45454f',
  background: '#2a2a30',
  color: '#e8e8ea',
  'font-size': '12px',
  cursor: 'pointer',
} as const;
