import { Component, For, Show, createSignal, } from 'solid-js';

/** 分钟列步长（5 分钟一格：00,05,…,55） */
const MINUTE_STEP = 5;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

interface Props {
  /** 规范值 "YYYY-MM-DD HH:MM"，空串 = 无提醒 */
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}

const pad = (n: number) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * 自绘日期时间选择器（深色主题，替代原生控件——WebKitGTK 原生日历弹层不跟随暗色皮肤）
 * 布局：触发按钮 → 内联展开面板（月历网格 + 0-23/分钟双列滚动 + 清除/确定）
 */
export const DateTimePicker: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [viewY, setViewY] = createSignal(2026);
  const [viewM, setViewM] = createSignal(0); // 0-11
  const [selDate, setSelDate] = createSignal('');
  const [selHour, setSelHour] = createSignal(9);
  const [selMin, setSelMin] = createSignal(0);
  let panelRef: HTMLDivElement | undefined;

  const parseValue = (v: string) => {
    if (v.length >= 16 && v.includes(' ')) {
      const [d, t] = v.split(' ');
      setSelDate(d);
      setSelHour(parseInt(t.slice(0, 2), 10) || 0);
      setSelMin(parseInt(t.slice(3, 5), 10) || 0);
      const [y, m] = d.split('-').map(Number);
      setViewY(y);
      setViewM(m - 1);
    } else {
      const now = new Date();
      setSelDate('');
      setSelHour(9);
      setSelMin(0);
      setViewY(now.getFullYear());
      setViewM(now.getMonth());
    }
  };

  const toggle = () => {
    if (!open()) {
      parseValue(props.value);
      setOpen(true);
      // 展开后把选中项滚进可视区
      setTimeout(() => {
        panelRef
          ?.querySelectorAll('.time-col')
          .forEach((col) => col.querySelector('.time-item.sel')?.scrollIntoView({ block: 'center' }));
      }, 30);
    } else {
      setOpen(false);
    }
  };

  const confirm = () => {
    props.onChange(
      selDate() ? `${selDate()} ${pad(selHour())}:${pad(selMin())}` : '',
    );
    setOpen(false);
  };

  const clear = () => {
    props.onChange('');
    setOpen(false);
  };

  // 月历网格：周一开头，前置空位补齐
  const firstWeekday = () => (new Date(viewY(), viewM(), 1).getDay() + 6) % 7;
  const daysInMonth = () => new Date(viewY(), viewM() + 1, 0).getDate();
  const cells = () => [
    ...Array.from({ length: firstWeekday() }, () => null as number | null),
    ...Array.from({ length: daysInMonth() }, (_, i) => i + 1),
  ];

  return (
    <div class="dtp">
      <button type="button" class="ti dtp-trigger" onClick={toggle}>
        <Show when={props.value} fallback={<span class="dtp-placeholder">{props.placeholder ?? '点击选择提醒时间（可空）'}</span>}>
          <span class="dtp-value">🗓 {props.value}</span>
        </Show>
      </button>

      <Show when={open()}>
        <div class="dt-pop" ref={panelRef}>
          <div class="cal-head">
            <button type="button" class="cal-nav" onClick={() => setViewM((m) => (m === 0 ? (setViewY((y) => y - 1), 11) : m - 1))}>
              ‹
            </button>
            <span class="cal-title">
              {viewY()} 年 {viewM() + 1} 月
            </span>
            <button type="button" class="cal-nav" onClick={() => setViewM((m) => (m === 11 ? (setViewY((y) => y + 1), 0) : m + 1))}>
              ›
            </button>
          </div>

          <div class="cal-grid">
            <For each={WEEKDAYS}>{(w) => <span class="cal-wd">{w}</span>}</For>
            <For each={cells()}>
              {(day) => (
                <Show
                  when={day !== null}
                  fallback={<span />}
                >
                  <button
                    type="button"
                    class="cal-cell"
                    classList={{
                      sel: selDate() === `${viewY()}-${pad(viewM() + 1)}-${pad(day!)}`,
                      today: selDate() !== `${viewY()}-${pad(viewM() + 1)}-${pad(day!)}` && `${viewY()}-${pad(viewM() + 1)}-${pad(day!)}` === todayStr(),
                    }}
                    onClick={() => setSelDate(`${viewY()}-${pad(viewM() + 1)}-${pad(day!)}`)}
                  >
                    {day}
                  </button>
                </Show>
              )}
            </For>
          </div>

          <div class="time-cols">
            <div class="time-col" data-label="时">
              <For each={HOURS}>
                {(h) => (
                  <button
                    type="button"
                    class="time-item"
                    classList={{ sel: selHour() === h }}
                    onClick={() => setSelHour(h)}
                  >
                    {pad(h)}
                  </button>
                )}
              </For>
            </div>
            <div class="time-col" data-label="分">
              <For each={MINUTES}>
                {(m) => (
                  <button
                    type="button"
                    class="time-item"
                    classList={{ sel: selMin() === m }}
                    onClick={() => setSelMin(m)}
                  >
                    {pad(m)}
                  </button>
                )}
              </For>
            </div>
          </div>

          <div class="dt-pop-actions">
            <button type="button" class="btn ghost small" onClick={clear}>清除</button>
            <button type="button" class="btn primary small" onClick={confirm}>确定</button>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default DateTimePicker;
