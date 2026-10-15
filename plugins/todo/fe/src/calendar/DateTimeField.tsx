/**
 * 钉钉式的日期 + 时间字段：两个触发器各弹一个浮层。
 *
 * 浮层走 Kobalte Popover（portal 到 body）而不是绝对定位在字段下面——
 * 日程编辑器的正文是 `overflow-y:auto` 的滚动容器，树内浮层会被裁掉，
 * RepeatPicker 那套 `.select-pop` + 全屏遮罩的自绘下拉在这里必然翻车。
 */
import { Component, For, Show, createMemo, createSignal, onMount } from 'solid-js';
import {
  Content as KPopoverContent,
  Portal as KPopoverPortal,
  Root as KPopover,
  Trigger as KPopoverTrigger,
} from '@kobalte/core/popover';
import { WEEKDAY_LABELS, monthCells, todayKey } from './grid';
import {
  ROW_HEIGHT,
  TIME_SLOTS,
  dateOf,
  headTitle,
  isSlotDisabled,
  monthOfDate,
  pickDate,
  pickTime,
  scrollTargetIndex,
  shiftMonth,
  timeOf,
} from './dtfield';
import './dtfield.css';

interface Props {
  /** 规范值 "YYYY-MM-DD HH:MM"，空串 = 无值 */
  value: string;
  onChange: (v: string) => void;
  datePlaceholder?: string;
  timePlaceholder?: string;
  /** 只点了时间、日期还空着时落到哪天（结束字段传开始的日期） */
  fallbackDate?: string;
  /** 提醒时间允许清空（空 = 无提醒）；日程起止时间不给这个入口 */
  allowClear?: boolean;
}

/** 只在浮层打开时挂载，所以时钟取挂载那一刻、列表滚到该看的那一格 */
const TimeList: Component<{ date: string; selected: string; onPick: (label: string) => void }> = (
  props,
) => {
  const now = new Date();
  // 行高固定 → 目标位置是纯算式。挂载时列表还没进文档， scrollTop 只能等到 onMount
  // 之后再设，否则会被当成越界值夹成 0。
  const top = scrollTargetIndex(props.selected, props.date, now) * ROW_HEIGHT;
  let listEl: HTMLDivElement | undefined;
  onMount(() => {
    if (listEl) listEl.scrollTop = top;
  });

  return (
    <div class="dtf-list" ref={listEl} style={{ '--dtf-row': `${ROW_HEIGHT}px` }}>
      <For each={TIME_SLOTS}>
        {(slot) => (
          <button
            type="button"
            class="dtf-slot"
            classList={{
              sel: props.selected === slot.label,
              off: isSlotDisabled(slot, props.date, now),
            }}
            disabled={isSlotDisabled(slot, props.date, now)}
            onClick={() => props.onPick(slot.label)}
          >
            {slot.label}
          </button>
        )}
      </For>
    </div>
  );
};

export const DateTimeField: Component<Props> = (props) => {
  const date = createMemo(() => dateOf(props.value));
  const time = createMemo(() => timeOf(props.value));
  const [openDate, setOpenDate] = createSignal(false);
  const [openTime, setOpenTime] = createSignal(false);
  // 翻页只挪视图，不动已选值：翻到明年看一眼，不该把日程改到明年
  const [view, setView] = createSignal(monthOfDate(date(), todayKey()));

  const fallback = () => props.fallbackDate || todayKey();

  return (
    <div class="dtf">
      <KPopover
        placement="bottom-start"
        gutter={6}
        open={openDate()}
        onOpenChange={(o) => {
          if (o) setView(monthOfDate(date(), fallback()));
          setOpenDate(o);
        }}
      >
        <KPopoverTrigger class="dtf-btn" classList={{ empty: !date() }}>
          {date() || props.datePlaceholder || '选择日期'}
        </KPopoverTrigger>
        <KPopoverPortal>
          <KPopoverContent class="dtf-pop dtf-pop--date">
            <div class="dtf-head">
              <span class="dtf-title">{headTitle(date(), view().year, view().month, fallback())}</span>
              <span class="dtf-head-nav">
                <button
                  type="button"
                  class="dtf-nav"
                  aria-label="上个月"
                  onClick={() => setView((v) => shiftMonth(v.year, v.month, -1))}
                >
                  ‹
                </button>
                <button
                  type="button"
                  class="dtf-nav"
                  aria-label="下个月"
                  onClick={() => setView((v) => shiftMonth(v.year, v.month, 1))}
                >
                  ›
                </button>
              </span>
            </div>

            <div class="dtf-grid">
              <For each={WEEKDAY_LABELS}>{(w) => <span class="dtf-wd">{w}</span>}</For>
              <For each={monthCells(view().year, view().month)}>
                {(cell) => (
                  <button
                    type="button"
                    class="dtf-cell"
                    classList={{
                      out: cell.out,
                      sel: cell.key === date(),
                      today: cell.key === todayKey() && cell.key !== date(),
                    }}
                    onClick={() => {
                      props.onChange(pickDate(props.value, cell.key));
                      setOpenDate(false);
                    }}
                  >
                    {cell.day}
                  </button>
                )}
              </For>
            </div>

            <div class="dtf-foot">
              <Show when={props.allowClear}>
                <button
                  type="button"
                  class="dtf-link"
                  onClick={() => {
                    props.onChange('');
                    setOpenDate(false);
                  }}
                >
                  清除
                </button>
              </Show>
              <span class="dtf-foot-space" />
              <button
                type="button"
                class="dtf-link"
                onClick={() => {
                  props.onChange(pickDate(props.value, todayKey()));
                  setOpenDate(false);
                }}
              >
                今天
              </button>
            </div>
          </KPopoverContent>
        </KPopoverPortal>
      </KPopover>

      <KPopover placement="bottom-start" gutter={6} open={openTime()} onOpenChange={setOpenTime}>
        <KPopoverTrigger class="dtf-btn dtf-btn--time" classList={{ empty: !time() }}>
          {time() || props.timePlaceholder || '选择时间'}
        </KPopoverTrigger>
        <KPopoverPortal>
          <KPopoverContent class="dtf-pop dtf-pop--time">
            <TimeList
              date={date() || fallback()}
              selected={time()}
              onPick={(label) => {
                props.onChange(pickTime(props.value, fallback(), label));
                setOpenTime(false);
              }}
            />
          </KPopoverContent>
        </KPopoverPortal>
      </KPopover>
    </div>
  );
};

export default DateTimeField;
