/**
 * 月视图网格：6×7 固定行数，每格堆当日条目前 3 条。
 *
 * 行数必须固定，否则条目多的月份会把网格撑高，格子高度跟着跳，读不出日期。
 */
import { Component, For, Show, createMemo } from 'solid-js';
import { monthCells, todayKey, WEEKDAY_LABELS, MonthCell } from './grid';
import { CalInstance, bucketByDay, ellipsis, timeLabel } from './daymath';
import { CalendarMeta, colorOf, soften } from './calendars';

interface Props {
  year: number;
  month: number; // 0-11
  instances: CalInstance[];
  calendars: CalendarMeta[];
  onSelectDay: (key: string) => void;
  onSelectEvent: (inst: CalInstance) => void;
}

const MAX_CHIPS = 3;

export const MonthGrid: Component<Props> = (props) => {
  const byDay = createMemo(() => bucketByDay(props.instances));
  const today = todayKey();

  return (
    <div class="cal-month">
      <div class="cal-month-head">
        <For each={WEEKDAY_LABELS}>
          {(w, i) => (
            <span class={['cal-month-wd', i() >= 5 ? 'cal-month-wd--wknd' : ''].join(' ')}>
              {w}
            </span>
          )}
        </For>
      </div>

      <div class="cal-month-grid">
        <For each={monthCells(props.year, props.month)}>
          {(cell: MonthCell) => {
            const key = cell.key;
            const items = () => byDay().get(key) ?? [];
            return (
              <div
                class={[
                  'cal-month-cell',
                  cell.out ? 'cal-month-cell--out' : '',
                  key === today ? 'cal-month-cell--today' : '',
                  items().length ? 'cal-month-cell--has' : '',
                ].join(' ')}
                onClick={() => props.onSelectDay(key)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    props.onSelectDay(key);
                  }
                }}
              >
                <span class="cal-month-day">{cell.day}</span>
                <div class="cal-month-chips">
                  <For each={items().slice(0, MAX_CHIPS)}>
                    {(inst) => (
                      <div
                        class={[
                          'cal-chip',
                          inst.all_day ? 'cal-chip--allday' : '',
                          inst.completed ? 'cal-chip--done' : '',
                          inst.status === 'free' ? 'cal-chip--free' : '',
                        ].join(' ')}
                        style={{
                          background: soften(colorOf(props.calendars, inst.calendar_id), 0.18),
                          'border-left-color': colorOf(props.calendars, inst.calendar_id),
                        }}
                        title={`${timeLabel(inst)} ${inst.content}${inst.location ? ` · ${inst.location}` : ''}`}
                        onClick={(e) => {
                          // 点开条目不该顺带选中整天
                          e.stopPropagation();
                          props.onSelectEvent(inst);
                        }}
                      >
                        <Show when={!inst.all_day}>
                          <span class="cal-chip-time">{timeLabel(inst)}</span>
                        </Show>
                        <span class="cal-chip-text">{ellipsis(inst.content)}</span>
                      </div>
                    )}
                  </For>
                  <Show when={items().length > MAX_CHIPS}>
                    <div class="cal-chip-more">+{items().length - MAX_CHIPS} 更多</div>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
};
