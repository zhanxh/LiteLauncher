/**
 * 挂件倒计时的纯逻辑（与渲染分离，便于单测）。
 *
 * 为什么抽出来：秒数取整、进度比例、格式化是最容易出边界错的地方
 * （59.6 秒显示成"00:60"、进度算成负数、跨过零点时长为负），
 * 而这些恰好都能用纯函数测。
 */

/**
 * 一个番茄钟的对外快照 */
export interface TimerSnapshot {
  /** 绝对结束时间戳（ms）。0 表示未在计时 */
  target: number;
  /** 任务标签 */
  label: string;
  /** 总时长（分钟） */
  minutes: number;
}

/**
 * 把 sidecar 写进 settings 的 `target` 归一成**毫秒**。
 *
 * ## 为什么必须做
 *
 * sidecar 是 Python，内部计时全用 `time.time()` —— **秒级**时间戳（约 1.79e9）。
 * 而 `deriveView` 要拿 `target` 和 `Date.now()`（**毫秒**，约 1.79e12）相减。
 * 两者直接相比恒为巨大负数 → 永远命中 `remainingMs <= 0` 分支 →
 * 挂件恒显示 `00:00`、进度环恒为走满，**且全程零报错**。
 *
 * 这个 bug 极隐蔽：类型都是 number，TS 查不出来，只有真机看倒计时才发现。
 *
 * ## 为什么按量级自动判定而不是写死 `* 1000`
 *
 * settings 是**持久化**的。若将来 sidecar 改用毫秒，或用户本地留着旧数据，
 * 硬编码换算会再次静默出错——而且错的方向相反，更难察觉。
 *
 * 阈值 1e11 的依据：秒级时间戳到公元 2286 年才到 1e10（现在约 1.79e9）；
 * 毫秒级时间戳 1973 年之后就超过 1e11（现在约 1.79e12）。中间留了三个数量级余量。
 */
export function normalizeTargetMs(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  const v = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v < 1e11 ? v * 1000 : v;
}

/** 面板/挂件的展示态 */
export interface TimerView {
  /** 是否正在计时 */
  running: boolean;
  /** mm:ss 文本 */
  text: string;
  /** 剩余秒数（向上取整，UI 显示用） */
  remainingSec: number;
  /** 已过比例 0~1，供进度环使用 */
  progress: number;
  /** 任务标签，空则给默认文案 */
  label: string;
  /** 总时长（分钟），未运行时为 0 */
  minutes: number;
  /** 预计结束时刻的 HH:MM */
  endAt: string;
}

export const IDLE_VIEW: TimerView = {
  running: false,
  text: '25:00',
  remainingSec: 25 * 60,
  progress: 0,
  label: '准备开始',
  minutes: 25,
  endAt: '',
};

/**
 * 把剩余毫秒格式化为 mm:ss。
 *
 * 用 ceil 而不是 floor：剩 59.6 秒时用户预期看到 01:00（还有一分钟），
 * floor 会显示 00:59，凭空少一秒。反过来剩 0.2 秒时 ceil 给 00:01，
 * 到点归零由外层处理。
 */
export function formatCountdown(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '00:00';
  const totalSec = Math.ceil(remainingMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** 补零的 HH:MM */
export function formatClock(tsMs: number): string {
  const d = new Date(tsMs);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** 专注 : 短休 = 5 : 1（与 sidecar 的 BREAK_RATIO 必须一致） */
export const BREAK_RATIO = 5;

/**
 * 短休分钟数。必须与 `pomo.py` 的 `break_minutes_of` 同结果，否则面板写着
 * "接 5 分钟短休"、挂件环按别的分母画。
 *
 * 整数输入下不会出现 .5 的平局（m/5 = k+0.5 要求 m 非整数），所以 JS 的
 * Math.round（.5 向上）与 Python 的 round（.5 向偶）在这里不会分叉。
 */
export function breakMinutesOf(minutes: number): number {
  const m = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 25;
  return Math.max(1, Math.round(m / BREAK_RATIO));
}

/** 段别：专注 / 短休 */
export type Phase = 'focus' | 'break';

export function phaseName(phase: Phase | string | undefined): string {
  return phase === 'break' ? '短休' : '专注';
}

/**
 * sidecar 状态的规整形态——挂件唯一认的数据形状。
 *
 * 数据来源有两种（见 `parseSidecarState` / `stateFromParts`），但往下只走这一个结构，
 * 避免"从 snap 取的 auto 是布尔、从散装键取的是 '1'/'0'"这种分叉渗到渲染层。
 */
export interface WidgetState {
  /** 当前段结束时刻（**毫秒**），0 表示没在计时 */
  targetMs: number;
  label: string;
  minutes: number;
  pausedRemain: number;
  phase: Phase;
  nextPhase: Phase;
  rounds: number;
  auto: boolean;
  hold: boolean;
}

const PHASE_BREAK = 'break';

function coercePhase(v: unknown): Phase {
  return v === PHASE_BREAK ? 'break' : 'focus';
}

/** Python 的 json 布尔是 true/false，散装 settings 是 '1'/'0'——两者都算 */
function coerceBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '0' && v !== '' && v.toLowerCase() !== 'false';
  return false;
}

function coerceCount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? '0'));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function coerceMinutes(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? '0'));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 解析 sidecar 写的单键 JSON 快照（`settings.snap`）。
 *
 * 为什么用单键而不是继续读 9 个散装键：挂件每秒轮询一次，`settings.get` 每次
 * 都是一趟 webview→宿主→SQLite 的 IPC；读 9 个键就是每秒 9 趟。单键一次搞定，
 * 而且天然**一致**——散装键分 9 次读，可能读到"本轮已写、下一轮未写"的撕裂状态。
 *
 * 解析失败（JSON 损坏、字段缺失）返回 null，由调用方回退到散装键。
 */
export function parseSidecarState(raw: string | null | undefined): WidgetState | null {
  if (!raw) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    targetMs: normalizeTargetMs(obj.target as number | string),
    label: typeof obj.label === 'string' ? obj.label : '',
    minutes: coerceMinutes(obj.minutes),
    pausedRemain: coerceMinutes(obj.paused_remain),
    phase: coercePhase(obj.phase),
    nextPhase: coercePhase(obj.next_phase),
    rounds: coerceCount(obj.rounds),
    auto: coerceBool(obj.auto),
    hold: coerceBool(obj.hold),
  };
}

/** 散装键（旧版本没有 snap，或 snap 写坏了）形态的输入 */
export interface SidecarParts {
  target: string | null | undefined;
  label: string | null | undefined;
  minutes: string | null | undefined;
  pausedRemain: string | null | undefined;
  phase: string | null | undefined;
  nextPhase: string | null | undefined;
  rounds: string | null | undefined;
  auto: string | null | undefined;
  hold: string | null | undefined;
}

/** 由散装 settings 拼出同一个 `WidgetState`，让回退路径与主路径形状一致 */
export function stateFromParts(p: SidecarParts): WidgetState {
  return {
    targetMs: normalizeTargetMs(p.target),
    label: p.label ?? '',
    minutes: coerceMinutes(p.minutes),
    pausedRemain: coerceMinutes(p.pausedRemain),
    phase: coercePhase(p.phase),
    nextPhase: coercePhase(p.nextPhase),
    rounds: coerceCount(p.rounds),
    // 缺键即默认开启：与 sidecar 的 `_start_new` 一致（"初始 add 后就是自动勾选"）
    auto: p.auto === null || p.auto === undefined || p.auto === '' ? true : coerceBool(p.auto),
    hold: coerceBool(p.hold),
  };
}

/**
 * 「这段跑完了、等用户点下一段」的展示态。
 *
 * ## 为什么单独一个函数
 *
 * sidecar 停在 hold 时把 target 归零，于是挂件读到的快照与"从未计时"完全一样，
 * 直接喂给 `deriveView` 得到 IDLE_VIEW——用户看到的是「25:00 准备开始」，
 * 而不是「刚才那 5 分钟跑完了」。真机反馈正是这个：倒计时结束后窗口显示 25:00 准备开始，
 * 好像计时从没发生过。hold 必须自己成一个视图，把"结束"这件事显式说出来。
 */
export function deriveHold(rounds: number, minutes: number): TimerView {
  return {
    running: false,
    // 环心只有 64px（内径约 56px）放得下三个汉字；轮数放在标签行里说
    text: '待开始',
    remainingSec: 0,
    // 进度环走满：这段确实跑完了，画成空环会让人以为被重置了
    progress: 1,
    // 标签只说"完成了什么"，"接下来点哪里"交给挂件的第二行（那里能显示
    // 完整的「点 ▶ 开始短休」，塞进本行的话会在 84px 收拢宽度上被省略号截断）
    label: `已完成 ${Math.max(0, Math.round(rounds))} 轮`,
    minutes,
    endAt: '',
  };
}

/**
 * 由绝对目标时间推导展示态。
 *
 * `now` 必须由调用方传入（而不是函数内部取 Date.now()）——
 * 这样单测能注入固定时钟，不受真实时间影响。
 */
export function deriveView(snap: TimerSnapshot, now: number): TimerView {
  if (!snap || !snap.target || snap.target <= 0) return { ...IDLE_VIEW };

  const remainingMs = snap.target - now;
  if (remainingMs <= 0) {
    // 已到点：进度走满，文本归零。**不能**返回 idle——
    // 挂件需要据此显示"时间到"的终态，而不是装作没在计时。
    return {
      running: false,
      text: '00:00',
      remainingSec: 0,
      progress: 1,
      label: snap.label || '专注',
      minutes: snap.minutes,
      endAt: formatClock(snap.target),
    };
  }

  const totalMs = Math.max(1, snap.minutes * 60_000);
  // 进度是"已过比例"，剩余越多进度越小
  const elapsedRatio = 1 - remainingMs / totalMs;

  return {
    running: true,
    text: formatCountdown(remainingMs),
    remainingSec: Math.ceil(remainingMs / 1000),
    progress: Math.min(1, Math.max(0, elapsedRatio)),
    label: snap.label || '专注',
    minutes: snap.minutes,
    endAt: formatClock(snap.target),
  };
}

/**
 * 暂停态的展示推导。
 *
 * ## 为什么要单独一个函数
 *
 * sidecar 暂停时把 `target` 归零（防止 worker 线程继续走）、把剩余秒数
 * 存进 `paused_remain`。于是挂件读到的快照是 target=0 —— 直接喂给
 * `deriveView` 会得到 IDLE_VIEW（「准备开始 25:00」），冻结的剩余时间
 * 和「已暂停」的状态全部丢失，UI 上也没有任何恢复入口——用户暂停后
 * 只能干瞪眼，这是真机反馈的实际事故。
 *
 * 进度环仍按「已过比例」画：暂停在正中就是约 0.5。
 */
export function derivePaused(
  pausedRemainSec: number,
  label: string,
  minutes: number,
): TimerView {
  const remainMs = Math.max(0, pausedRemainSec * 1000);
  const totalMs = Math.max(1, minutes * 60_000);
  const elapsedRatio = 1 - remainMs / totalMs;
  return {
    running: false,
    text: formatCountdown(remainMs),
    remainingSec: Math.ceil(remainMs / 1000),
    progress: Math.min(1, Math.max(0, elapsedRatio)),
    // 空标签回落「专注」，并标出暂停态——用户必须能一眼分清
    // 「没在计时」和「暂停了」
    label: `${label || '专注'} · 已暂停`,
    minutes,
    endAt: '',
  };
}

/**
 * 进度环的 stroke-dasharray。
 *
 * 半径固定 26，周长 = 2πr ≈ 163.36；用 dasharray 表示"已走过的弧长"，
 * dashoffset 恒为周长（即完全不显示），靠 dasharray 的长度控制进度。
 */
export function arcDasharray(progress: number, radius = 26): string {
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(1, Math.max(0, progress));
  return `${(circumference * clamped).toFixed(2)} ${circumference.toFixed(2)}`;
}
