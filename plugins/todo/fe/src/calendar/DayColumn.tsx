/**
 * 时间轴的一列（00–24）：定时日程按分钟定位成块，重叠的并排分道。
 *
 * 拖拽在这里就地做完，只把"结果区间"交给上层落库——列本身不知道日期之外的信息，
 * 上层也就无需关心指针是怎么动的。
 */
import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import { CalInstance } from './daymath';
import { CalendarMeta, colorOf, soften } from './calendars';
import { MINUTES_PER_DAY, Placed, Span, packLanes, timelineSpan } from './layout';
import { minAtOffset, moveSpan, normalizeDrag, PX_PER_MIN, resizeSpan, RESIZE_ZONE_PX } from './drag';

type Mode = 'create' | 'move' | 'resize';

interface Drag {
  mode: Mode;
  inst: CalInstance | null;
  span: Span;
  /** 按下点与块起点的差，移动时用它保持"抓在哪"的手感 */
  grabMin: number;
}

interface Props {
  day: string;
  instances: CalInstance[];
  calendars: CalendarMeta[];
  showNow: boolean;
  onSelectEvent: (inst: CalInstance) => void;
  onCreateSpan: (day: string, startMin: number, endMin: number) => void;
  onMoveSpan: (inst: CalInstance, startMin: number, endMin: number) => void;
}

export const DayColumn: Component<Props> = (props) => {
  const ppm = PX_PER_MIN;
  let colRef: HTMLDivElement | undefined;
  const [drag, setDrag] = createSignal<Drag | null>(null);

  const placed = createMemo<Placed<CalInstance>[]>(() => {
    const withSpan = props.instances
      .map((inst) => ({ inst, span: timelineSpan(inst, props.day) }))
      .filter((x): x is { inst: CalInstance; span: Span } => x.span !== null)
      .map((x) => ({ ...x.span, item: x.inst }));
    return packLanes(withSpan);
  });

  const offsetY = (clientY: number) => {
    const rect = colRef?.getBoundingClientRect();
    return rect ? clientY - rect.top : 0;
  };

  const blockSpan = (p: Placed<CalInstance>): Span => ({ startMin: p.startMin, endMin: p.endMin });

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const y = offsetY(e.clientY);
    const hit = (e.target as HTMLElement).closest('[data-occ]') as HTMLElement | null;
    colRef?.setPointerCapture(e.pointerId);
    if (!hit) {
      const m = minAtOffset(y, ppm);
      setDrag({ mode: 'create', inst: null, span: normalizeDrag(m, m), grabMin: 0 });
      return;
    }
    const inst = placed().find((p) => p.item.occ_key === hit.dataset.occ)?.item;
    const p = placed().find((x) => x.item.occ_key === hit.dataset.occ);
    if (!inst || !p) return;
    const m = minAtOffset(y, ppm);
    const nearBottom = p.endMin - m <= RESIZE_ZONE_PX / ppm;
    setDrag({
      mode: nearBottom ? 'resize' : 'move',
      inst,
      span: blockSpan(p),
      grabMin: m - p.startMin,
    });
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag();
    if (!d) return;
    const m = minAtOffset(offsetY(e.clientY), ppm);
    if (d.mode === 'create') setDrag({ ...d, span: normalizeDrag(d.span.startMin, m) });
    else if (d.mode === 'resize') setDrag({ ...d, span: resizeSpan(d.span, m) });
    else setDrag({ ...d, span: moveSpan(d.span, m - d.grabMin - d.span.startMin) });
  };

  const onPointerUp = (e: PointerEvent) => {
    const d = drag();
    setDrag(null);
    colRef?.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.mode === 'create') {
      // 单击（没拖出长度）留一格，方便"点一下就建"
      props.onCreateSpan(props.day, d.span.startMin, d.span.endMin);
    } else if (d.inst && (d.span.startMin !== placedOf(d.inst)?.startMin || d.span.endMin !== placedOf(d.inst)?.endMin)) {
      props.onMoveSpan(d.inst, d.span.startMin, d.span.endMin);
    } else if (d.inst) {
      props.onSelectEvent(d.inst);
    }
  };

  const placedOf = (inst: CalInstance) => {
    const p = placed().find((x) => x.item.occ_key === inst.occ_key);
    return p ? { startMin: p.startMin, endMin: p.endMin } : null;
  };

  const styleFor = (span: Span, lane: number, lanes: number) => ({
    top: `${span.startMin * ppm}px`,
    height: `${Math.max(18, (span.endMin - span.startMin) * ppm - 2)}px`,
    left: `calc(${(lane / lanes) * 100}% + 2px)`,
    width: `calc(${100 / lanes}% - 4px)`,
  });

  const nowMin = () => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  };

  return (
    <div
      class="cal-tl-col"
      ref={colRef}
      style={{ height: `${MINUTES_PER_DAY * ppm}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <Show when={props.showNow}>
        <div class="cal-tl-now" style={{ top: `${nowMin() * ppm}px` }} />
      </Show>

      <For each={placed()}>
        {(p) => (
          <div
            class={['cal-tl-block', p.item.completed ? 'cal-tl-block--done' : '', p.item.status === 'free' ? 'cal-tl-block--free' : ''].join(' ')}
            data-occ={p.item.occ_key}
            style={{
              ...styleFor({ startMin: p.startMin, endMin: p.endMin }, p.lane, p.lanes),
              background: soften(colorOf(props.calendars, p.item.calendar_id), 0.18),
              'border-left-color': colorOf(props.calendars, p.item.calendar_id),
            }}
            title={`${p.item.content}${p.item.location ? ` · ${p.item.location}` : ''}`}
          >
            <span class="cal-tl-time">{p.item.start.slice(11, 16)}</span>
            <span class="cal-tl-text">{p.item.content}</span>
          </div>
        )}
      </For>

      <Show when={drag()}>
        {(d) => (
          <div
            class="cal-tl-ghost"
            style={styleFor(d().span, 0, 1)}
          >
            <span class="cal-tl-time">
              {fmtMin(d().span.startMin)}–{fmtMin(d().span.endMin)}
            </span>
          </div>
        )}
      </Show>
    </div>
  );
};

/** 分钟数 → "HH:MM"，拖拽时给实时反馈 */
function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
