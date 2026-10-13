/**
 * 挂件倒计时的纯逻辑（与渲染分离，便于单测）。
 *
 * 为什么抽出来：秒数取整、进度比例、格式化是最容易出边界错的地方
 * （59.6 秒显示成"00:60"、进度算成负数、跨过零点时长为负），
 * 而这些恰好都能用纯函数测。
 */

/** 一个番茄钟的对外快照 */
export interface TimerSnapshot {
  /** 绝对结束时间戳（ms）。0 表示未在计时 */
  target: number;
  /** 任务标签 */
  label: string;
  /** 总时长（分钟） */
  minutes: number;
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
