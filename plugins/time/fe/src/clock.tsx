/**
 * 桌面墙面时钟（视图窗口 `?view=clock&city=悉尼&tz=Australia/Sydney&fallback=10`）
 *
 * ## 与 pomo 挂件同款的生命周期
 *
 * 打开即尝试挂到桌面壁纸层（`windows.attachDesktop`，Windows 上是注入
 * Explorer 的 WorkerW）：挂上后就是"真·桌面时钟"，被图标与窗口自然遮挡；
 * 挂不上（Wayland / 异常）时窗口仍是 always_on_top 浮窗，挂件上会如实显示
 * "浮动模式"角标——绝不把降级状态假装成已贴桌面（SDK 文档的红线）。
 *
 * ## ⚠️ 窗口必须保持不透明（manifest 里 rounded:false，不能改）
 *
 * 本窗口打开后要被 SetParent 进 Explorer 的 WorkerW（跨进程 reparent）。
 * 透明窗（rounded:true → 宿主 transparent(true)）被跨进程 reparent 会直接
 * 崩掉整个进程（2026-10-26 真机两次复现：时钟窗一闪即逝、主程序退出；
 * pomo 同路径不透明窗则一切正常）。所以时钟做成不透明卡片，不追求
 * "圆形表盘漂浮在桌面上"的效果。
 *
 * ## 为什么在挂件里自查 attach 而不是由面板调用
 *
 * 窗口标签带 `unique_by` 的净化哈希（中文城市名净化后只剩哈希），调用方
 * 算不出也不该算这个标签；而挂件自己用 `getCurrentWindow().label` 拿到的
 * 就是真标签，天然不可能越权到别人的窗口。
 *
 * ## 时钟数据的口径
 *
 * 与面板共享 time.ts 的 Intl 换算（zoneParts/zoneOffsetMinutes），
 * 秒针每秒一跳（对齐秒边界，不做等间隔轮询），表盘为 SVG 矢量。
 *
 * ## Solid 注意
 *
 * 组件函数只跑一次，所有随时间变化的量都必须走 createMemo/getter，
 * 组件体里的普通赋值只会求值一次（表盘会冻在首帧）。
 */
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getPluginContext } from '@ll/sdk';
import { localZoneName, utcOffsetLabel, zoneOffsetMinutes, zoneParts, type ZoneParts } from './time';
import './clock.css';

const ctx = getPluginContext('time');

interface ClockParams {
  city: string;
  tz: string;
  /** Intl 不认识 tz 时退回的固定偏移小时数（来自 CITIES 表） */
  fallbackHours: number;
}

function readParams(): ClockParams {
  const sp = new URLSearchParams(window.location.search);
  const rawTz = sp.get('tz')?.trim() || '';
  const tz = rawTz || localZoneName();
  const city = sp.get('city')?.trim() || (rawTz ? tz : '本地');
  const fb = Number(sp.get('fallback'));
  return { city, tz, fallbackHours: Number.isFinite(fb) ? fb : 0 };
}

/** Intl 换算一次就够；失败的时区走固定偏移并打标 */
function zoneUsable(tz: string): boolean {
  try {
    // 返回值不使用：能 format 就算认识
    new Intl.DateTimeFormat('en-GB', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** 对齐到下一个秒边界，而不是死等 1000ms——否则每次跳秒都懒最多 1s */
function tickAtSecondBoundary(fn: () => void): number {
  const delay = 1000 - (Date.now() % 1000) + 15;
  return window.setTimeout(fn, delay);
}

export function ClockWidget() {
  const params = readParams();
  const usable = zoneUsable(params.tz);

  const [now, setNow] = createSignal(new Date());
  /** wallpaper=已贴壁纸层；floating=降级置顶浮窗；unsupported=会话不支持 */
  const [attach, setAttach] = createSignal<'pending' | 'wallpaper' | 'floating' | 'unsupported'>(
    'pending',
  );
  const [hovered, setHovered] = createSignal(false);

  let tickTimer: number | null = null;
  let disposed = false;

  const scheduleTick = () => {
    if (disposed) return;
    tickTimer = tickAtSecondBoundary(() => {
      if (disposed) return;
      setNow(new Date());
      scheduleTick();
    });
  };

  onMount(() => {
    scheduleTick();
    // 挂壁纸层的时机：等首帧渲染完成再入桌。早期版本在组件挂载的同一瞬
    // 就 SetParent，撞上 webview 首次合成窗口会出现不可见问题；且 pomo 的
    // 经验是“晚挂”渲染稳定。用户看到的是“先浮动一秒，随后沉入壁纸层”。
    void waitFirstPaint().then(() => {
      if (!disposed) void attachToDesktop();
    });
  });

  onCleanup(() => {
    disposed = true;
    if (tickTimer !== null) clearTimeout(tickTimer);
  });

  /** 首帧渲染完成的近似信号：两帧 rAF + 字体就绪 + 少量缓冲 */
  async function waitFirstPaint(): Promise<void> {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    try {
      await document.fonts.ready;
    } catch {
      // 字体 API 不可用时忽略
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  async function attachToDesktop() {
    try {
      if (!(await ctx.windows.desktopSupported())) {
        setAttach('unsupported');
        return;
      }
      // 挂自己：标签从当前窗口取；宿主侧 attach 只做层级操作，不涉及越权
      const res = await ctx.windows.attachDesktop(getCurrentWindow().label);
      setAttach(res.onWallpaper ? 'wallpaper' : 'floating');
    } catch {
      setAttach('floating');
    }
  }

  async function close() {
    disposed = true;
    if (tickTimer !== null) clearTimeout(tickTimer);
    // destroy 而非 close：挂件关闭没有需要确认的场景，close 的请求-确认链
    // 任何一环不 resolve 窗口就关不掉（pomo 挂件踩过的坑）
    await getCurrentWindow()
      .destroy()
      .catch(() => undefined);
  }

  /**
   * 随时间变化的全部派生量，一个 memo 出齐：表盘角度、数字读数、日期、
   * UTC 偏移与"退回固定偏移"标记。Intl 缺该时区时退回固定偏移并如实打标，
   * 与面板的降级口径一致。
   */
  const dial = createMemo(() => {
    const d = now();
    let parts: ZoneParts;
    let offsetMin = params.fallbackHours * 60;
    let degraded = !usable;
    if (usable) {
      try {
        parts = zoneParts(d, params.tz);
        offsetMin = zoneOffsetMinutes(d, params.tz);
      } catch {
        degraded = true;
        parts = fixedParts(d);
      }
    } else {
      parts = fixedParts(d);
    }
    return {
      parts,
      offsetMin,
      degraded,
      date: d,
      hourDeg: (parts.hour % 12) * 30 + parts.minute * 0.5 + parts.second * (0.5 / 60),
      minDeg: parts.minute * 6 + parts.second * 0.1,
      secDeg: parts.second * 6,
    };
  });

  function fixedParts(d: Date): ZoneParts {
    const shifted = new Date(d.getTime() + params.fallbackHours * 3600_000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
  }

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const digital = () => {
    const p = dial().parts;
    return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
  };
  const dateText = () => {
    const p = dial().parts;
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  };
  const weekdayText = () => new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(dial().date);

  // ── 表盘几何（viewBox 0 0 200 200，圆心 100,100；与时间无关，算一次）────
  const CENTER = 100;
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const major = i % 5 === 0;
    const rad = ((i * 6 - 90) * Math.PI) / 180;
    const outer = 92;
    const len = major ? 11 : 5;
    return {
      key: i,
      major,
      x1: CENTER + outer * Math.cos(rad),
      y1: CENTER + outer * Math.sin(rad),
      x2: CENTER + (outer - len) * Math.cos(rad),
      y2: CENTER + (outer - len) * Math.sin(rad),
    };
  });

  const attachBadge = () => {
    switch (attach()) {
      case 'floating':
        return '浮动模式 · 未能贴到桌面壁纸层';
      case 'unsupported':
        return '浮动模式 · 当前桌面会话不支持壁纸层';
      default:
        return null;
    }
  };

  return (
    <div
      class="tc-root"
      classList={{ 'tc-hover': hovered() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div class="tc-stage" data-tauri-drag-region="deep">
        <div class="tc-face">
          <svg class="tc-dial" viewBox="0 0 200 200" aria-hidden="true">
            <circle class="tc-face-ring" cx={CENTER} cy={CENTER} r="97" />
            <circle class="tc-face-inner" cx={CENTER} cy={CENTER} r="90" />
            {ticks.map((t) => (
              <line
                classList={{ 'tc-tick': true, 'tc-tick--major': t.major }}
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
              />
            ))}
            <text class="tc-num" x={CENTER} y="30" text-anchor="middle">
              12
            </text>
            <text class="tc-num" x="174" y={CENTER + 6} text-anchor="middle">
              3
            </text>
            <text class="tc-num" x={CENTER} y="180" text-anchor="middle">
              6
            </text>
            <text class="tc-num" x="26" y={CENTER + 6} text-anchor="middle">
              9
            </text>
            <line
              class="tc-hand tc-hour"
              x1={CENTER}
              y1={CENTER + 12}
              x2={CENTER}
              y2="52"
              transform={`rotate(${dial().hourDeg} ${CENTER} ${CENTER})`}
            />
            <line
              class="tc-hand tc-minute"
              x1={CENTER}
              y1={CENTER + 14}
              x2={CENTER}
              y2="28"
              transform={`rotate(${dial().minDeg} ${CENTER} ${CENTER})`}
            />
            <line
              class="tc-hand tc-second"
              x1={CENTER}
              y1={CENTER + 20}
              x2={CENTER}
              y2="22"
              transform={`rotate(${dial().secDeg} ${CENTER} ${CENTER})`}
            />
            <circle class="tc-cap" cx={CENTER} cy={CENTER} r="4.5" />
          </svg>
          <button class="tc-close" title="关闭时钟" onClick={() => void close()}>
            ✕
          </button>
        </div>

        <div class="tc-city">
          <span class="tc-city-name" title={`${params.city} · ${params.tz}`}>
            {params.city}
          </span>
          <span class="tc-city-offset">
            {utcOffsetLabel(dial().offsetMin)}
            {dial().degraded ? '（夏令时可能不准）' : ''}
          </span>
        </div>
        <div class="tc-digital">{digital()}</div>
        <div class="tc-date">
          {dateText()} {weekdayText()}
        </div>
        {attachBadge() && (
          <div class="tc-attach" title={attachBadge() ?? undefined}>
            {attachBadge()}
          </div>
        )}
      </div>
    </div>
  );
}
