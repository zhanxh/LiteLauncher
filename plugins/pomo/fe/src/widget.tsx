/**
 * 番茄钟桌面挂件（视图窗口 `?view=widget`）
 *
 * ## 为什么挂件自己读 settings 而不是问 sidecar
 *
 * 计时状态存在 LLP sidecar 的**进程内存**里，而挂件是独立的 Webview 窗口，
 * 与 sidecar 是不同的 JS 上下文——拿不到那份内存。
 * 但 sidecar 每次 start/stop 都会把 `target`/`label`/`minutes` 写进
 * `ctx.settings`（宿主强制 `${pluginId}.` 前缀隔离），那是**跨进程共享**的。
 * 所以挂件以 settings 为唯一数据源，每秒轮询一次。
 *
 * 代价是轮询而非推送，但对一个 1Hz 刷新的小挂件完全够用，
 * 且避免了"挂件窗口与 sidecar 建立额外 IPC 通道"这套复杂度。
 */
import { createSignal, createMemo, onCleanup, onMount, Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getPluginContext } from '@ll/sdk';
import { deriveView, arcDasharray, type TimerSnapshot } from './timer';
import './widget.css';

const ctx = getPluginContext('pomo');

/** 轮询间隔：1s。挂件的精度需求就是"秒级"，再密只是白烧 CPU */
const TICK_MS = 1000;
/** 进度环半径（与 timer.ts 的 arcDasharray 默认值保持一致） */
const RADIUS = 26;

function readSetting(key: string): Promise<string | null> {
  // settings.get 返回 null 表示键不存在；sidecar 可能还没写过
  return ctx.settings.get(key).catch(() => null);
}

export function PomoWidget() {
  const [target, setTarget] = createSignal(0);
  const [label, setLabel] = createSignal('');
  const [minutes, setMinutes] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  /** 已到点的终态：到点后仍要显示 00:00 + "时间到"，不能退回未计时 */
  const [finished, setFinished] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);

  let timer: ReturnType<typeof setInterval> | null = null;
  let alive = true;

  const snap = createMemo<TimerSnapshot>(() => ({
    target: target(),
    label: label(),
    minutes: minutes(),
  }));

  const view = createMemo(() => {
    const v = deriveView(snap(), now());
    return finished() && !v.running ? { ...v, label: `${v.label} · 时间到` } : v;
  });

  /** 拉一次 sidecar 写入的状态 */
  async function sync() {
    if (!alive) return;
    const [t, l, m] = await Promise.all([
      readSetting('target'),
      readSetting('label'),
      readSetting('minutes'),
    ]);
    if (!alive) return;
    const parsed = Number.parseFloat(t ?? '0');
    setTarget(Number.isFinite(parsed) ? parsed : 0);
    setLabel(l ?? '');
    setMinutes(Number.parseInt(m ?? '0', 10) || 0);

    // 到点判定放在这里而不是 deriveView：
    // 后者对"target 已过"和"从未计时"都返回 running=false，无法区分，
    // 而 UI 必须区分（前者显示"时间到"，后者显示"准备开始"）
    const t0 = Date.now();
    setNow(t0);
    if (Number.isFinite(parsed) && parsed > 0) {
      if (parsed <= t0) setFinished(true);
      else setFinished(false);
    } else {
      setFinished(false);
    }
  }

  onMount(() => {
    void sync();
    timer = setInterval(() => {
      void sync();
    }, TICK_MS);

    // 关闭挂件：只关窗口，不动 sidecar 的计时（用户可能只是想收起浮窗）。
    // onCleanup 也会做同样的清理，这里提前做是为了让关闭瞬间就不再轮询。
    void getCurrentWindow()
      .onCloseRequested(() => {
        // 不 preventDefault —— 让窗口正常关闭；
        // 计时在 sidecar 里继续，到点照常通知，重新 /pomo 可以再打开
        alive = false;
        if (timer) clearInterval(timer);
      })
      .catch(() => {
        /* 非桌面挂件环境（如调试页）没有窗口 API，忽略 */
      });
  });

  onCleanup(() => {
    alive = false;
    if (timer) clearInterval(timer);
  });

  /** 暂停/继续：把剩余时间写回 settings 由 sidecar 接管，视图只负责发意图 */
  /**
   * 跨进程下发命令。
   *
   * 为什么不用 `ctx.call('plugin.pause')`：sidecar 是独立进程，前端 `call` 只能打到
   * **宿主**的 `svc.*` 命名空间，没有任何通道能直接 invoke 到 sidecar 的 handler；
   * events 也是单向 emit（前端→宿主），sidecar 同样收不到。
   *
   * 真正能闭环的是 `ctx.settings`：宿主持有的 KV 是**跨进程共享**的，而 sidecar
   * 本来就每秒读一次 settings 做同步。于是"前端写命令键 → sidecar 读到并清空"
   * 就是一条现成的反向通道，无需新增宿主能力或改协议。
   */
  async function sendCommand(cmd: 'pause' | 'stop') {
    // 带时间戳：确保值一定变化，否则"连点两次"可能被 KV 判为未变更而丢掉第二次
    await ctx.settings.set('cmd', `${cmd}:${Date.now()}`);
    await sync();
  }

  async function pause() {
    if (!view().running) return;
    await sendCommand('pause');
  }

  async function stop() {
    await sendCommand('stop');
    await sync();
  }

  const dash = () => arcDasharray(view().progress, RADIUS);

  return (
    <div
      class="pw-root"
      classList={{ 'pw-hovered': hovered(), 'pw-idle': !view().running }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div class="pw-ring">
        <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
          <circle class="pw-track" cx="32" cy="32" r={RADIUS} fill="none" stroke-width="4" />
          <circle
            class="pw-arc"
            cx="32"
            cy="32"
            r={RADIUS}
            fill="none"
            stroke-width="4"
            stroke-linecap="round"
            stroke-dasharray={dash()}
            transform="rotate(-90 32 32)"
          />
        </svg>
        <div class="pw-text">{view().text}</div>
      </div>

      <div class="pw-meta">
        <div class="pw-label" title={view().label}>
          {view().label}
        </div>
        <Show when={view().running && view().endAt}>
          <div class="pw-end">{view().endAt} 结束</div>
        </Show>
      </div>

      {/* 悬停才出现的操作区：不占常态视觉空间，也避免小窗被误触 */}
      <Show when={hovered()}>
        <div class="pw-actions">
          <Show when={view().running}>
            <button class="pw-btn" title="暂停" onClick={() => void pause()}>
              ❚❚
            </button>
          </Show>
          <button class="pw-btn" title="停止并收起" onClick={() => void stop()}>
            ✕
          </button>
        </div>
      </Show>
    </div>
  );
}
