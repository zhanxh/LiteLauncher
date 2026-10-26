/**
 * 截图钉图（视图窗口 `?view=pin`，flameshot 的 Pin 对应物）
 *
 * 定位：区域框选确认后，选区**原位**变成一张置顶小图钉在桌面上——
 * 参照物、对照稿、临时贴纸。图片本体已自动进剪贴板，钉图是"看得见的收据"。
 *
 * 交互（对齐 flameshot 钉图）：
 *   - 左键按住拖动 → 移动钉图（startDragging，交给 WM，不自己逐帧 setPosition）
 *   - 右键 → 自绘菜单：复制到剪贴板 / 关闭（Esc 同关闭）
 *
 * 实现说明：
 *   - 窗口几何由宿主按 open 参数（全局物理像素）落在选区原位（manifest 的
 *     `geometry_from_params`），前端只管把图 1:1 铺满窗口；HiDPI 下物理像素
 *     图显示在 宽/缩放 的 CSS 尺寸里，观感与截图时的那块屏幕区域完全一致。
 *   - 菜单是自绘 HTML 而非系统菜单：WebKitGTK 的原生弹层不吃 web 主题
 *     （深色应用里会弹白框）。菜单无法溢出窗口矩形，窗口比菜单还小的极端
 *     钉图（几像素高的误触选区）会被裁——那种图本身没有钉的价值。
 *   - 复制走 `svc.screen.copyPng`：图早已落盘，直接进剪贴板，不生成副本文件。
 */
import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getPluginContext } from '@ll/sdk';

const ctx = getPluginContext('shot');

/** 复制成功的角标显示时长 */
const COPIED_FLASH_MS = 1600;

export function ShotPin() {
  const params = new URLSearchParams(window.location.search);
  /** select 视图落盘的截图路径（宿主只放行本插件截图目录） */
  const srcPath = params.get('src') ?? '';

  const win = getCurrentWindow();

  const [img, setImg] = createSignal('');
  const [error, setError] = createSignal('');
  /** 右键菜单开关与位置（窗口内坐标） */
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = createSignal(false);

  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  async function close(): Promise<void> {
    await win.close().catch(() => undefined);
  }

  async function copyToClipboard(): Promise<void> {
    try {
      await ctx.screen.copyPng(srcPath);
      setCopied(true);
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    } catch (err) {
      setError(`复制失败：${messageOf(err)}`);
    }
    setMenu(null);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      void close();
    }
  }

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    // 菜单贴着光标弹出，但整个菜单必须留在窗口矩形内（HTML 无法溢出窗口）
    const menuW = 148;
    const menuH = 84;
    setMenu({
      x: Math.max(0, Math.min(e.clientX, window.innerWidth - menuW - 4)),
      y: Math.max(0, Math.min(e.clientY, window.innerHeight - menuH - 4)),
    });
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button === 0) {
      // 左键：菜单开着就先收菜单，否则进入拖动（交给 WM 处理整窗移动）
      if (menu()) {
        setMenu(null);
        return;
      }
      void win.startDragging().catch(() => undefined);
    }
  }

  onMount(() => {
    void (async () => {
      try {
        if (!srcPath) throw new Error('缺少截图路径（src 参数为空）');
        setImg(await ctx.screen.readPng(srcPath));
      } catch (err) {
        setError(messageOf(err));
      }
    })();

    window.addEventListener('keydown', onKeyDown);
    // 焦点补偿：mutter 防抢焦点可能拒绝给刚映射的窗口键盘焦点，Esc 会落空；
    // 立即 + 延迟各试一次（与主窗口 present 的补偿同款节奏）
    const claimFocus = () => void win.setFocus().catch(() => undefined);
    claimFocus();
    const focusRetry = setTimeout(claimFocus, 250);
    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown);
      if (copiedTimer) clearTimeout(copiedTimer);
      clearTimeout(focusRetry);
    });
  });

  const menuItemStyle: JSX.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '6px 12px',
    border: 'none',
    background: 'transparent',
    color: '#E2E8F0',
    font: '12px/1.6 ui-sans-serif, system-ui, sans-serif',
    'text-align': 'left',
    cursor: 'pointer',
    'white-space': 'nowrap',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: '0',
        overflow: 'hidden',
        'user-select': 'none',
        background: 'transparent',
        cursor: 'move',
        // 发丝边框把钉图与同色桌面内容区分开（截图内容本身不可改）
        'box-shadow':
          'inset 0 0 0 1px rgba(2,6,23,0.55), inset 0 0 0 2px rgba(255,255,255,0.18)',
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      <Show when={img()} fallback={null}>
        <img
          src={img()}
          alt="截图钉图"
          draggable={false}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            // 钉住的是原始像素：等比缩放到窗口即可，不做平滑之外的加工
            'object-fit': 'fill',
            'pointer-events': 'none',
          }}
        />
      </Show>

      {/* 复制成功角标：不抢焦点、不打断，1.6s 后自动消失 */}
      <Show when={copied()}>
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '10px',
            transform: 'translateX(-50%)',
            padding: '3px 10px',
            background: 'rgba(15,23,42,0.88)',
            color: '#7DD3FC',
            font: '12px/1.5 ui-sans-serif, system-ui, sans-serif',
            'border-radius': '999px',
            'pointer-events': 'none',
            'white-space': 'nowrap',
          }}
        >
          已复制
        </div>
      </Show>

      {/* 加载/复制失败的横幅（窗口极小时可能被裁剪，属可接受的退化） */}
      <Show when={error()}>
        <div
          style={{
            position: 'absolute',
            left: '0',
            right: '0',
            top: '0',
            padding: '4px 8px',
            background: 'rgba(190,18,60,0.92)',
            color: '#fff',
            font: '12px/1.5 ui-sans-serif, system-ui, sans-serif',
            'pointer-events': 'none',
          }}
        >
          {error()} · Esc 关闭
        </div>
      </Show>

      {/* 右键菜单（自绘：WebKitGTK 原生弹层不吃 web 深色主题） */}
      <Show when={menu()}>
        {(m) => (
          <div
            style={{
              position: 'fixed',
              left: `${m().x}px`,
              top: `${m().y}px`,
              width: '148px',
              padding: '4px',
              background: 'rgba(15,23,42,0.96)',
              border: '1px solid rgba(148,163,184,0.25)',
              'border-radius': '8px',
              'box-shadow': '0 8px 24px rgba(0,0,0,0.45)',
              'z-index': '10',
            }}
            // 菜单自身吃掉按下事件，避免触发底层"收菜单/拖动"
            onPointerDown={(e: PointerEvent) => e.stopPropagation()}
            onContextMenu={(e: MouseEvent) => e.preventDefault()}
          >
            <button style={menuItemStyle} onClick={() => void copyToClipboard()}>
              📋 复制到剪贴板
            </button>
            <button style={menuItemStyle} onClick={() => void close()}>
              ✕ 关闭
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}
