/**
 * 日程编辑器（月/周/日视图共用的浮层）
 *
 * 打开即向后端要一次全文：网格上的实例是展开出来的虚拟副本，
 * 缺 repeat_until / uid 这类不参与渲染的列，直接拿来回填会让保存悄悄吃掉这些值。
 */
import { Component, For, Show, createEffect, createMemo, createSignal, untrack } from 'solid-js';
import { getPluginContext, isHostAvailable } from '@ll/sdk';
import { RepeatPicker } from '../RepeatPicker';
import { CalendarMeta, nameOf, soften, UNCLASSIFIED } from './calendars';
import { CalInstance } from './daymath';
import { DateTimeField } from './DateTimeField';
import { dateOf } from './dtfield';
import { todayKey } from './grid';

const ctx = getPluginContext('todo');

/** 提醒快捷档（分钟）：个人日程真正常用的是这几个 */
const ALARM_PRESETS = [0, 5, 10, 15, 30, 60, 1440];

interface Draft {
  id: string;
  content: string;
  all_day: boolean;
  start_at: string;
  end_at: string;
  location: string;
  description: string;
  calendar_id: string;
  status: 'busy' | 'free';
  repeat_rule: string;
  repeat_until: string;
  alarms: number[];
  /** 从虚拟实例打开：改动作用于整条重复规则，保存前要讲明白 */
  fromVirtual: boolean;
}

const emptyDraft = (startAt: string, calendarId: string): Draft => ({
  id: '',
  content: '',
  all_day: false,
  start_at: startAt,
  end_at: '',
  location: '',
  description: '',
  calendar_id: calendarId,
  status: 'busy',
  repeat_rule: '',
  repeat_until: '',
  alarms: [],
  fromVirtual: false,
});

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

/** 后端行 → 编辑草稿；all_day/completed 在 SQLite 里是 0/1 */
function toDraft(ev: Record<string, unknown>, fromVirtual: boolean): Draft {
  return {
    id: str(ev.id),
    content: str(ev.content),
    all_day: num(ev.all_day) !== 0,
    start_at: str(ev.start_at),
    end_at: str(ev.end_at),
    location: str(ev.location),
    description: str(ev.description),
    calendar_id: str(ev.calendar_id) || UNCLASSIFIED,
    status: ev.status === 'free' ? 'free' : 'busy',
    repeat_rule: str(ev.repeat_rule),
    repeat_until: str(ev.repeat_until),
    alarms: Array.isArray(ev.alarms) ? (ev.alarms as number[]) : [],
    fromVirtual,
  };
}

interface Props {
  /** null = 关闭。有 eventId 是编辑，否则按 openKey 新建（该日 09:00 起，给了 startMin 则按拖出来的区间） */
  seed: {
    eventId?: string;
    openKey?: string;
    isVirtual?: boolean;
    startMin?: number;
    endMin?: number;
  } | null;
  calendars: CalendarMeta[];
  onClose: () => void;
  onSaved: (msg: string) => void;
  /** 保存/删除成功后让宿主重取区间 */
  onChanged: () => void;
  /**
   * overlay（默认）= 日历窗内的遮罩浮层；inline = 嵌进宿主基窗（详情窗口）。
   * inline 时遮罩和自己那层头部都不渲染——标题与关闭由基窗的 PopupFrame 提供，
   * 高度上限由窗口承接，所以那对 `calc(100vh - 48px)` 也必须让位。
   */
  variant?: 'overlay' | 'inline';
}

/**
 * 当天分钟数 → 后端时间串。拖到 24:00 收尾的块要落到次日零点：
 * 后端按 'YYYY-MM-DD HH:MM' 串比较，"24:00" 会排到次日之后。
 */
export function minToAt(day: string, min: number): string {
  const total = Math.round(min);
  if (total >= 1440) {
    const [y, m, d] = day.split('-').map(Number);
    const next = new Date(y, m - 1, d + 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(
      next.getDate(),
    ).padStart(2, '0')} 00:00`;
  }
  const h = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${day} ${h}:${mm}`;
}

export const EventModal: Component<Props> = (props) => {
  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [conflicts, setConflicts] = createSignal<CalInstance[]>([]);

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  // seed 变化 = 换一个编辑目标，必须重新拉全文（同一浮层复用，不能留上一次的脏值）
  createEffect(() => {
    const seed = props.seed;
    if (!seed) {
      setDraft(null);
      return;
    }
    setError('');
    setConflicts([]);
    if (seed.eventId) {
      void (async () => {
        try {
          const ev = await ctx.call<Record<string, unknown>>('get_event', { id: seed.eventId });
          setDraft(toDraft(ev, seed.isVirtual === true));
        } catch (err) {
          setError(`读取日程失败: ${err}`);
          setDraft(emptyDraft('', UNCLASSIFIED));
        }
      })();
    } else {
      const key = seed.openKey ?? '';
      const base = emptyDraft(
        key ? (seed.startMin !== undefined ? minToAt(key, seed.startMin) : `${key} 09:00`) : '',
        props.calendars[0]?.id ?? UNCLASSIFIED,
      );
      setDraft(
        key && seed.endMin !== undefined ? { ...base, end_at: minToAt(key, seed.endMin) } : base,
      );
    }
  });

  /**
   * 只跟随"会影响重叠判断"的字段：草稿对象每次输入都是新建的，
   * 若 effect 直接读 draft()，敲标题就会多发一次 check_conflict。
   */
  const spanKey = createMemo(() => {
    const d = draft();
    return d ? `${d.id}|${d.start_at}|${d.end_at}|${d.all_day}` : '';
  });

  createEffect(() => {
    spanKey();
    const d = untrack(draft);
    if (!d || !isHostAvailable() || d.all_day || !d.start_at) {
      setConflicts([]);
      return;
    }
    void (async () => {
      try {
        const res = await ctx.call<{ conflicts?: CalInstance[] }>('check_conflict', {
          id: d.id || undefined,
          start_at: d.start_at,
          end_at: d.end_at,
        });
        setConflicts(res.conflicts ?? []);
      } catch {
        // 冲突提示失败不该拦住编辑
        setConflicts([]);
      }
    })();
  });

  const close = () => props.onClose();

  const canSave = createMemo(() => {
    const d = draft();
    return !!d && d.content.trim().length > 0 && !busy();
  });

  const save = async () => {
    const d = draft();
    if (!d) return;
    // 定宽串可直接比较；两半分开选之后，结束早于开始成了手可达的错，别静默存下去
    if (d.end_at && d.start_at && d.end_at < d.start_at) {
      setError('结束时间早于开始时间');
      return;
    }
    if (!isHostAvailable()) return;
    setBusy(true);
    try {
      await ctx.call('save', {
        id: d.id || undefined,
        content: d.content.trim(),
        all_day: d.all_day ? 1 : 0,
        start_at: d.start_at,
        end_at: d.end_at,
        location: d.location,
        description: d.description,
        calendar_id: d.calendar_id,
        status: d.status,
        repeat_rule: d.repeat_rule,
        repeat_until: d.repeat_until,
        alarms: d.alarms,
      });
      props.onSaved(d.id ? '已保存日程' : '已新建日程');
      props.onChanged();
      close();
    } catch (err) {
      setError(`保存失败: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const d = draft();
    if (!d?.id || !isHostAvailable()) return;
    setBusy(true);
    try {
      await ctx.call('delete', { id: d.id });
      props.onSaved('已删除日程');
      props.onChanged();
      close();
    } catch (err) {
      setError(`删除失败: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const customAlarms = createMemo(() => (draft()?.alarms ?? []).filter((m) => !ALARM_PRESETS.includes(m)));

  // 新建直接进标题框：打开浮层的人下一步就是打字，省一次点击
  let titleEl: HTMLInputElement | undefined;
  createEffect(() => {
    const cur = draft();
    if (cur && !cur.id) queueMicrotask(() => titleEl?.focus());
  });

  const toggleAlarm = (min: number) => {
    const d = draft();
    if (!d) return;
    const next = d.alarms.includes(min) ? d.alarms.filter((m) => m !== min) : [...d.alarms, min];
    patch({ alarms: next.sort((a, b) => b - a) });
  };

  /** inline = 嵌进宿主基窗：遮罩与自己那层头部都让位给 PopupFrame */
  const inline = () => props.variant === 'inline';

  return (
    <Show when={draft()}>
      {(ev) => (
        <div
          class={inline() ? 'cal-modal-inline-wrap' : 'cal-modal-mask'}
          onClick={() => {
            if (!inline()) close();
          }}
        >
          {/* 点遮罩关闭，面板本体要挡住冒泡，否则拖到边界就没了 */}
          <div class={inline() ? 'cal-modal cal-modal--inline' : 'cal-modal'} onClick={(e) => e.stopPropagation()}>
            <Show when={!inline()}>
              <div class="cal-modal-head">
                <span class="cal-modal-title">{ev().id ? '编辑日程' : '新建日程'}</span>
                <button type="button" class="cal-btn cal-btn--icon" onClick={close} title="关闭">
                  ✕
                </button>
              </div>
            </Show>

            <div class="cal-modal-body">
              <Show when={ev().fromVirtual}>
                <div class="cal-hint">这是重复日程展开出的一次，改动会作用于整条重复规则。</div>
              </Show>

              <input
                class="ti cal-title-input"
                placeholder="日程标题"
                value={ev().content}
                ref={titleEl}
                onInput={(e) => patch({ content: e.currentTarget.value })}
              />

              <label class="cal-check">
                <input
                  type="checkbox"
                  checked={ev().all_day}
                  onChange={(e) => patch({ all_day: e.currentTarget.checked })}
                />
                全天
              </label>

              <div class="cal-field">
                <span class="cal-field-label">开始</span>
                <DateTimeField
                  value={ev().start_at}
                  datePlaceholder="日期"
                  timePlaceholder="时间"
                  onChange={(v) => patch({ start_at: v })}
                />
              </div>

              <Show when={!ev().all_day}>
                <div class="cal-field">
                  <span class="cal-field-label">结束</span>
                  {/* 只点时间不点日期时落到开始那天，否则结束会掉到今天，跟开始差出一个未来 */}
                  <DateTimeField
                    value={ev().end_at}
                    datePlaceholder="日期"
                    timePlaceholder="时间"
                    fallbackDate={dateOf(ev().start_at) || todayKey()}
                    onChange={(v) => patch({ end_at: v })}
                  />
                  <Show when={!ev().end_at}>
                    <span class="cal-field-hint">留空 = 默认时长</span>
                  </Show>
                </div>
              </Show>

              <div class="cal-field">
                <span class="cal-field-label">地点</span>
                <input
                  class="ti"
                  placeholder="可选"
                  value={ev().location}
                  onInput={(e) => patch({ location: e.currentTarget.value })}
                />
              </div>

              <div class="cal-field cal-field--top">
                <span class="cal-field-label">备注</span>
                <textarea
                  class="ti cal-textarea"
                  rows={2}
                  placeholder="可选"
                  value={ev().description}
                  onInput={(e) => patch({ description: e.currentTarget.value })}
                />
              </div>

              <div class="cal-field">
                <span class="cal-field-label">日历</span>
                <div class="cal-cal-picker">
                  <For each={props.calendars}>
                    {(c) => (
                      <button
                        type="button"
                        class="cal-dot-chip"
                        classList={{ sel: c.id === ev().calendar_id }}
                        style={{
                          'border-color': c.color,
                          background: soften(c.color, c.id === ev().calendar_id ? 0.28 : 0.12),
                        }}
                        onClick={() => patch({ calendar_id: c.id })}
                      >
                        {c.name}
                      </button>
                    )}
                  </For>
                  <Show when={!props.calendars.some((c) => c.id === ev().calendar_id)}>
                    <button
                      type="button"
                      class="cal-dot-chip sel"
                      onClick={() => patch({ calendar_id: UNCLASSIFIED })}
                    >
                      {nameOf(props.calendars, null)}
                    </button>
                  </Show>
                </div>
              </div>

              <div class="cal-field">
                <span class="cal-field-label">忙闲</span>
                <div class="cal-seg">
                  <button
                    type="button"
                    class="cal-seg-btn"
                    classList={{ sel: ev().status === 'busy' }}
                    onClick={() => patch({ status: 'busy' })}
                  >
                    忙碌
                  </button>
                  <button
                    type="button"
                    class="cal-seg-btn"
                    classList={{ sel: ev().status === 'free' }}
                    onClick={() => patch({ status: 'free' })}
                  >
                    空闲
                  </button>
                </div>
              </div>

              <div class="cal-field cal-field--stack">
                <span class="cal-field-label">重复</span>
                <RepeatPicker value={ev().repeat_rule} onChange={(v) => patch({ repeat_rule: v })} />
              </div>

              <div class="cal-field">
                <span class="cal-field-label">提醒</span>
                <div class="cal-alarm-row">
                  <For each={ALARM_PRESETS}>
                    {(min) => (
                      <button
                        type="button"
                        class="cal-dot-chip"
                        classList={{ sel: ev().alarms.includes(min) }}
                        onClick={() => toggleAlarm(min)}
                      >
                        {min === 0 ? '准时' : min >= 1440 ? `${min / 1440} 天前` : `提前 ${min} 分`}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <Show when={customAlarms().length > 0}>
                <div class="cal-alarm-row">
                  <For each={customAlarms()}>
                    {(min) => (
                      <button
                        type="button"
                        class="cal-dot-chip sel"
                        onClick={() => toggleAlarm(min)}
                        title="点击移除"
                      >
                        提前 {min} 分 ✕
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={conflicts().length > 0}>
                <div class="cal-conflict">
                  与 {conflicts().length} 条日程重叠：
                  {conflicts()
                    .slice(0, 3)
                    .map((c) => `${c.start.slice(5, 16)} ${c.content}`)
                    .join('、')}
                  {conflicts().length > 3 ? '…' : ''}
                </div>
              </Show>

              <Show when={error()}>
                <div class="cal-error">{error()}</div>
              </Show>
            </div>

            <div class="cal-modal-foot">
              <Show when={ev().id}>
                <button type="button" class="btn danger ghost" onClick={() => void remove()}>
                  删除
                </button>
              </Show>
              <span class="cal-foot-space" />
              <button type="button" class="btn ghost" onClick={close}>
                取消
              </button>
              <button
                type="button"
                class="btn primary"
                disabled={!canSave()}
                onClick={() => void save()}
              >
                {busy() ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};
