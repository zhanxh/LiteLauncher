/**
 * 时间轴容器：周视图（7 列）与日视图（1 列）共用，差别只在传进来的天数。
 *
 * 三段（表头 / 全天带 / 时间轴）用同一个 grid 模板，列宽才不会在滚动时错位；
 * 横向不滚动，所以竖向滚动条只吃掉时间轴那一段的高度。
 */
import { Component, For } from 'solid-js';
import { CalInstance, dayKeysOf } from './daymath';
import { CalendarMeta, colorOf, nameOf, soften } from './calendars';
import { WEEKDAY_LABELS } from './grid';
import { PX_PER_MIN } from './drag';
import { DayColumn } from './DayColumn';

interface Props {
  days: string[];
  instances: CalInstance[];
  calendars: CalendarMeta[];
  today: string;
  onSelectEvent: (inst: CalInstance) => void;
  onCreateSpan: (day: string, startMin: number, endMin: number) => void;
  onMoveSpan: (inst: CalInstance, startMin: number, endMin: number) => void;
  onSelectDay: (day: string) => void;
}

const dayOf = (key: string) => Number(key.slice(8, 10));

export const TimeGrid: Component<Props> = (props) => {
  const template = () => `56px repeat(${props.days.length}, minmax(0, 1fr))`;

  const allDayFor = (day: string) =>
    props.instances.filter((i) => i.all_day && dayKeysOf(i).includes(day));

  const wdOf = (day: string) => {
    const [y, m, d] = day.split('-').map(Number);
    return WEEKDAY_LABELS[(new Date(y, m - 1, d).getDay() + 6) % 7];
  };

  const label = (day: string) => (
    <button
      type="button"
      class={['cal-tl-dayhead', day === props.today ? 'cal-tl-dayhead--today' : ''].join(' ')}
      onClick={() => props.onSelectDay(day)}
      title={`在 ${day} 新建日程`}
    >
      <span class="cal-tl-wd">{wdOf(day)}</span>
      <span class="cal-tl-date">{dayOf(day)}</span>
    </button>
  );

  return (
    <div class="cal-tl">
      <div class="cal-tl-head" style={{ 'grid-template-columns': template() }}>
        <div class="cal-tl-gutter" />
        <For each={props.days}>{(day) => label(day)}</For>
      </div>

      <div class="cal-tl-allday" style={{ 'grid-template-columns': template() }}>
        <div class="cal-tl-gutter cal-tl-allday-tag">全天</div>
        <For each={props.days}>
          {(day) => (
            <div class="cal-tl-allday-col" onClick={() => props.onSelectDay(day)}>
              <For each={allDayFor(day)}>
                {(inst) => (
                  <div
                    class={['cal-chip', inst.completed ? 'cal-chip--done' : ''].join(' ')}
                    style={{
                      background: soften(colorOf(props.calendars, inst.calendar_id), 0.18),
                      'border-left-color': colorOf(props.calendars, inst.calendar_id),
                    }}
                    title={`${nameOf(props.calendars, inst.calendar_id)} · ${inst.content}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onSelectEvent(inst);
                    }}
                  >
                    <span class="cal-chip-text">{inst.content}</span>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>

      <div class="cal-tl-scroll">
        <div class="cal-tl-body" style={{ 'grid-template-columns': template() }}>
          <div class="cal-tl-gutter cal-tl-hours" style={{ height: `${1440 * PX_PER_MIN}px` }}>
            <For each={Array.from({ length: 24 }, (_, h) => h)}>
              {(h) => (
                <div class="cal-tl-hour" style={{ top: `${h * 60 * PX_PER_MIN}px` }}>
                  {String(h).padStart(2, '0')}:00
                </div>
              )}
            </For>
          </div>
          <For each={props.days}>
            {(day) => (
              <DayColumn
                day={day}
                instances={props.instances}
                calendars={props.calendars}
                showNow={day === props.today}
                onSelectEvent={props.onSelectEvent}
                onCreateSpan={props.onCreateSpan}
                onMoveSpan={props.onMoveSpan}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
};
