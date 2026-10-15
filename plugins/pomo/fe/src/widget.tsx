/**
 * 番茄钟桌面挂件（视图窗口 `?view=widget`）
 *
 * ## 为什么挂件自己读 settings 而不是问 sidecar
 *
 * 计时状态存在 LLP sidecar 的**进程内存**里，而挂件是独立的 Webview 窗口，
 * 与 sidecar 是不同的 JS 上下文——拿不到那份内存。
 * 但 sidecar 每次状态变化都会把整份状态写进 `ctx.settings`（宿主强制 `${pluginId}.`
 * 前缀隔离），那是**跨进程共享**的：单键 `snap` 是 JSON 快照，
 * 另外还有一组同名散装键作为旧版本/异常时的回退数据源。
 * 所以挂件以 settings 为唯一数据源，每秒轮询一次。
 *
 * 代价是轮询而非推送，但对一个 1Hz 刷新的小挂件完全够用，
 * 且避免了"挂件窗口与 sidecar 建立额外 IPC 通道"这套复杂度。
 */
import { createSignal, createMemo, onCleanup, onMount, Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getPluginContext } from '@ll/sdk';
import {
  arcDasharray,
  deriveHold,
  derivePaused,
  deriveView,
  parseSidecarState,
  phaseName,
  stateFromParts,
  type TimerSnapshot,
  type WidgetState,
} from './timer';
import { ANIM_MS, COLLAPSED_W, EXPANDED_W, easeOutCubic, lerp, widthFor } from './hover-size';
import './widget.css';

const ctx = getPluginContext('pomo');

/** 轮询间隔：1s。挂件的精度需求就是"秒级"，再密只是白烧 CPU */
const TICK_MS = 1000;
/** 进度环半径（与 timer.ts 的 arcDasharray 默认值保持一致） */
const RADIUS = 26;

/** 首帧（还没读到 sidecar 任何状态）用的空态，字段与 WidgetState 一一对应 */
const EMPTY_STATE: WidgetState = {
  targetMs: 0,
  label: '',
  minutes: 0,
  pausedRemain: 0,
  phase: 'focus',
  nextPhase: 'break',
  rounds: 0,
  auto: true,
  hold: false,
};

function readSetting(key: string): Promise<string | null> {
  // settings.get 返回 null 表示键不存在；sidecar 可能还没写过
  return ctx.settings.get(key).catch(() => null);
}

export function PomoWidget() {
  const [st, setSt] = createSignal<WidgetState>(EMPTY_STATE);
  const [now, setNow] = createSignal(Date.now());
  /** 已到点的终态：到点后仍要显示 00:00 + "时间到"，不能退回未计时 */
  const [finished, setFinished] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);

  let timer: ReturnType<typeof setInterval> | null = null;
  let alive = true;

  /**
   * 伸缩动画令牌：每次悬停状态变化都让上一段动画作废。
   * 两段动画并发写窗口尺寸会互相拖拽（快速划过时表现为抖动或停在半开状态）。
   */
  let animToken = 0;

  /**
   * 把窗口宽度动画到 `to`。
   *
   * 只报宽度：物理↔逻辑换算、"钉住右边缘向左生长"和夹回屏幕都由宿主
   * `svc.window.setContentSize` 负责（锚定算法在 ll-plugin-api 的
   * `popup_rect_after_size` 里，能单测）。挂件自己读 `outerPosition()`
   * 做除法的历史版本，在 HiDPI 与多屏下都是要人守的坑。
   */
  async function resizeTo(to: number) {
    const token = ++animToken;
    const from = window.innerWidth;
    const t0 = performance.now();
    const step = () => {
      if (token !== animToken || !alive) return;
      const p = (performance.now() - t0) / ANIM_MS;
      const width = lerp(from, to, easeOutCubic(p));
      void ctx.windows.setContentSize({ width }).catch(() => undefined);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function onEnter() {
    setHovered(true);
    void resizeTo(EXPANDED_W);
  }

  function onLeave() {
    setHovered(false);
    void resizeTo(COLLAPSED_W);
  }

  const snap = createMemo<TimerSnapshot>(() => ({
    target: st().targetMs,
    label: st().label,
    minutes: st().minutes,
  }));

  /** 是否处于「这段跑完了、等点下一段」 */
  const holding = () => st().targetMs <= 0 && st().pausedRemain <= 0 && st().hold;

  const view = createMemo(() => {
    // 暂停态优先判定：target=0 且 paused_remain>0。
    // 不判定的话会落到 IDLE_VIEW（"准备开始 25:00"），冻结时间丢失、
    // 也没有继续入口——正是"暂停后无法恢复"事故的根源。
    if (st().targetMs <= 0 && st().pausedRemain > 0) {
      return derivePaused(st().pausedRemain, st().label, st().minutes);
    }
    // hold 次优先：sidecar 到点也把 target 归零，与"从未计时"读数完全相同。
    // 不单独判定就会显示「25:00 准备开始」，用户以为倒计时从没跑过——
    // 这是"5 分钟提醒结束后窗口显示 25:00"反馈的直接原因。
    if (holding()) {
      return deriveHold(st().rounds, st().minutes);
    }
    const v = deriveView(snap(), now());
    return finished() && !v.running ? { ...v, label: `${v.label} · 时间到` } : v;
  });

  /** 拉一次 sidecar 写入的状态 */
  async function sync() {
    if (!alive) return;
    // 首选单键 JSON 快照：一趟 IPC、且字段天然一致（分 9 次读会读到撕裂态）
    const rawSnap = await readSetting('snap');
    if (!alive) return;
    let next = parseSidecarState(rawSnap);
    if (!next) {
      // 回退：升级前留下的状态没有 snap 键，或 sidecar 写坏了 JSON
      const [t, l, m, pr, ph, np, rd, au, hd] = await Promise.all([
        readSetting('target'),
        readSetting('label'),
        readSetting('minutes'),
        readSetting('paused_remain'),
        readSetting('phase'),
        readSetting('next_phase'),
        readSetting('rounds'),
        readSetting('auto'),
        readSetting('hold'),
      ]);
      next = stateFromParts({
        target: t,
        label: l,
        minutes: m,
        pausedRemain: pr,
        phase: ph,
        nextPhase: np,
        rounds: rd,
        auto: au,
        hold: hd,
      });
    }
    if (!alive || !next) return;
    setSt(next);

    // 到点判定放在这里而不是 deriveView：
    // 后者对"target 已过"和"从未计时"都返回 running=false，无法区分，
    // 而 UI 必须区分（前者显示"时间到"，后者显示"准备开始"）
    const t0 = Date.now();
    setNow(t0);
    setFinished(next.targetMs > 0 && next.targetMs <= t0);
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

  /**
   * 拖拽开始前先收掉在跑的伸缩动画。
   *
   * 拖拽区本身是卡片上的 `data-tauri-drag-region="deep"`（按钮由 Tauri 的
   * 拖拽脚本自动跳过）。这里只剩插件侧策略：动画记的是**拖动前**的右边缘，
   * 若拖拽事务进行中还发 setSize，松手瞬间窗口会被拽回旧坐标（"拖不动/弹回"）。
   * 作废令牌后直接落到当前悬停态的最终宽度，位置交给系统拖动。
   */
  function settleBeforeDrag() {
    animToken += 1;
    void ctx.windows.setContentSize({ width: widthFor(hovered()) }).catch(() => undefined);
  }

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
  async function sendCommand(cmd: string) {
    // 带时间戳：确保值一定变化，否则"连点两次"可能被 KV 判为未变更而丢掉第二次
    await ctx.settings.set('cmd', `${cmd}:${Date.now()}`);
    await sync();
  }

  async function pause() {
    if (!view().running) return;
    await sendCommand('pause');
  }

  /** 继续计时：sidecar 把暂停时记下的剩余时间重新变成绝对目标时刻 */
  async function resume() {
    if (view().running) return;
    await sendCommand('resume');
  }

  /** hold 态手动开始下一段（专注↔短休交替） */
  async function nextSegment() {
    if (!holding()) return;
    await sendCommand('next');
  }

  /** 自动衔接开关：开=到点直接接下一段，关=每段结束停在 hold 等人工点击 */
  async function toggleAuto() {
    await sendCommand(st().auto ? 'auto:off' : 'auto:on');
  }

  /**
   * 停止计时并关闭挂件。
   *
   * ⚠️ 用 destroy() 而不是 close()：close() 会走 onCloseRequested 的
   * "请求-确认"流程（JS handler 参与关闭决策），任何一环 promise 不 resolve
   * 窗口就关不掉——这正是"关闭按钮无效"的观感来源之一。挂件关闭没有
   * 任何需要确认的场景，直接销毁窗口是最可靠路径。
   */
  async function stop() {
    await sendCommand('stop');
    await getCurrentWindow()
      .destroy()
      .catch(() => undefined);
    alive = false;
    if (timer) clearInterval(timer);
  }

  const dash = () => arcDasharray(view().progress, RADIUS);

  return (
    <div
      class="pw-root"
      classList={{ 'pw-hovered': hovered(), 'pw-idle': !view().running }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {/* 卡片单独一层：根元素铺满窗口，背景/圆角/边框画在内层才不会被窗口矩形切出四角。
          整张卡片都是拖拽区（deep），按钮由 Tauri 的拖拽脚本自动排除 */}
      <div class="pw-card" data-tauri-drag-region="deep" onMouseDown={settleBeforeDrag}>
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
          {/* hold 态把"下一步点哪"写在第二行：这行较宽，收拢态也放得下，
              而标签行只有 84px，写「已完成 N 轮 · 点 ▶ 开始短休」会被省略号截断 */}
          <Show when={holding()}>
            <div class="pw-end">悬停点 ▶ 开始{phaseName(st().nextPhase)}</div>
          </Show>
        </div>

        {/* 悬停才出现的操作区：不占常态视觉空间，也避免小窗被误触。
            最多 3 个按钮（↻ 自动衔接 + 当前动作 + ✕），hover-size.ts 的
            MAX_BTNS 就是按这个上限算展开宽度的，加按钮要同步改它。
            ❚❚/▶ = 暂停、继续或开始下一段（随状态切换），↻ = 到点是否自动衔接，
            ✕ = 停止计时并关闭挂件。
            上一版还有一个「⌃ 收起」按钮，已删：它只是隐藏窗口、计时继续、
            需要 /pomo 找回——与「暂停」（时间冻结、状态可见）语义缠绕，
            真机用户完全分不清两者差别。隐藏需求由 /pomo widget 覆盖即可。 */}
        <Show when={hovered()}>
          <div class="pw-actions">
            <button
              class="pw-btn"
              classList={{ 'pw-btn--on': st().auto }}
              title={
                st().auto
                  ? '自动衔接：开（每段结束自动开始下一段）'
                  : '自动衔接：关（每段结束等你点 ▶）'
              }
              onClick={() => void toggleAuto()}
            >
              ↻
            </button>
            <Show when={view().running}>
              <button class="pw-btn" title="暂停" onClick={() => void pause()}>
                ❚❚
              </button>
            </Show>
            <Show when={!view().running && st().pausedRemain > 0}>
              <button class="pw-btn" title="继续计时" onClick={() => void resume()}>
                ▶
              </button>
            </Show>
            <Show when={holding()}>
              <button
                class="pw-btn"
                title={`开始${phaseName(st().nextPhase)}`}
                onClick={() => void nextSegment()}
              >
                ▶
              </button>
            </Show>
            <button class="pw-btn pw-btn--danger" title="停止计时并关闭" onClick={() => void stop()}>
              ✕
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
