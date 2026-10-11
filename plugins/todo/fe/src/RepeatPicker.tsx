import { Component, For, createEffect, createSignal, Show } from 'solid-js';

/** 自绘下拉：原生 select 弹层跟随 GTK 主题（暗色不可控），统一自绘保持肤色一致 */
const UnitSelect: Component<{
  value: string;
  onChange: (v: string) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const current = () => UNITS.find((u) => u.v === props.value)?.label ?? props.value;

  return (
    <div class="select-wrap">
      <button type="button" class="ti select-btn" onClick={() => setOpen((v) => !v)}>
        {current()} ▾
      </button>
      <Show when={open()}>
        <div class="select-overlay" onClick={() => setOpen(false)} />
        <div class="select-pop">
          <For each={UNITS}>
            {(u) => (
              <button
                type="button"
                class="select-item"
                classList={{ sel: u.v === props.value }}
                onClick={() => {
                  props.onChange(u.v);
                  setOpen(false);
                }}
              >
                {u.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

const UNITS: Array<{ v: string; label: string }> = [
  { v: 'min', label: '分钟' },
  { v: 'hour', label: '小时' },
  { v: 'day', label: '天' },
  { v: 'week', label: '周' },
  { v: 'month', label: '个月' },
];

interface Props {
  /** 规范重复规则 "every:N{min|hour|day|week|month}"，空串 = 不重复 */
  value: string;
  onChange: (v: string) => void;
}

/** 解析规范规则；不匹配（历史手工输入的关键词等）返回 null */
const parseRule = (v: string): { n: number; unit: string } | null => {
  const m = v.trim().match(/^every:(\d+)(min|hour|day|week|month)$/);
  if (!m) return null;
  return { n: parseInt(m[1], 10), unit: m[2] };
};

/**
 * 重复周期选择：勾选框 + 间隔数字 + 周期单位下拉
 * 输出与后端一致的规范格式 every:N{min|hour|day|week|month}
 */
export const RepeatPicker: Component<Props> = (props) => {
  const parsed = parseRule(props.value);
  const [enabled, setEnabled] = createSignal(parsed !== null);
  const [n, setN] = createSignal(parsed?.n ?? 30);
  const [unit, setUnit] = createSignal(parsed?.unit ?? 'min');
  const [rawFallback, setRawFallback] = createSignal(
    parsed === null && props.value.trim() !== '' ? props.value : '',
  );

  // 外部值变化（编辑回填）时重新解析
  createEffect(() => {
    const v = props.value;
    const p = parseRule(v);
    setEnabled(p !== null);
    if (p) {
      setN(p.n);
      setUnit(p.unit);
      setRawFallback('');
    } else if (v.trim() !== '') {
      setEnabled(true);
      setRawFallback(v);
    } else {
      setRawFallback('');
    }
  });

  const emit = (
    opts: { enabled?: boolean; n?: number; unit?: string; raw?: string } = {},
  ) => {
    const en = opts.enabled ?? enabled();
    const num = opts.n ?? n();
    const un = opts.unit ?? unit();
    const raw = opts.raw ?? rawFallback();
    if (!en) {
      props.onChange('');
    } else if (raw) {
      props.onChange(raw); // 历史 keyword 值原样保留
    } else {
      props.onChange(`every:${Math.max(1, Math.min(999, num))}${un}`);
    }
  };

  return (
    <div class="repeat-row">
      <label class="repeat-toggle">
        <input
          type="checkbox"
          checked={enabled()}
          onChange={(e) => {
            setEnabled(e.currentTarget.checked);
            emit({ enabled: e.currentTarget.checked });
          }}
        />
        重复
      </label>

      <Show
        when={enabled()}
        fallback={<span class="repeat-off">不重复（勾选后按周期提醒）</span>}
      >
        <Show
          when={!rawFallback()}
          fallback={
            <input
              class="ti"
              value={rawFallback()}
              onInput={(e) => {
                setRawFallback(e.currentTarget.value);
                emit({ raw: e.currentTarget.value });
              }}
            />
          }
        >
          <input
            class="ti repeat-num"
            type="number"
            min="1"
            max="999"
            value={n()}
            onInput={(e) => {
              const v = Math.max(1, Math.min(999, parseInt(e.currentTarget.value, 10) || 1));
              setN(v);
              emit({ n: v });
            }}
          />
          <UnitSelect
            value={unit()}
            onChange={(v) => {
              setUnit(v);
              emit({ unit: v });
            }}
          />
          <span class="repeat-once">一次</span>
        </Show>
      </Show>
    </div>
  );
};

export default RepeatPicker;
