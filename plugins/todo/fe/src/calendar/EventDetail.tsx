/**
 * 日程详情（提醒卡片「查看详情」打开的独立窗口）
 *
 * 做成只读而不是"禁用的表单"：一整套灰掉的输入框看起来像坏了，
 * 而详情要回答的只是"这是哪条日程、几点、哪个日历"。
 * 「编辑」就地换成 EventModal，不另开窗口——重复日程没有单次例外
 * （模型里连 EXDATE 都没有），改哪一次都是改整条规则，分两个面板反而说不清。
 */
import { Component, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { getPluginContext, isHostAvailable } from '@ll/sdk';
import { alarmLabel, asSpan, formatSpan, repeatLabel } from '../remindfmt';
import { CalendarMeta, UNCLASSIFIED, colorOf, nameOf } from './calendars';
import { EventModal } from './EventModal';

const ctx = getPluginContext('todo');

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

export interface DetailSeed {
  eventId: string;
  /** 卡片上的"这一次"：重复日程展开出的实例跟锚点不同，只读态以它为准 */
  start: string;
  end: string;
  allDay: boolean;
}

interface Props {
  seed: DetailSeed;
  onClose: () => void;
}

/** 详情窗口的 URL 只带定位用的四个参数，正文一律现取 */
export function parseDetail(search: string): DetailSeed {
  const q = new URLSearchParams(search);
  return {
    eventId: q.get('event') ?? '',
    // 脏参直接丢空，让 span() 回落到日程自己的锚点
    start: asSpan((q.get('start') ?? '').trim()),
    end: asSpan((q.get('end') ?? '').trim()),
    allDay: q.get('all_day') === '1',
  };
}

export const EventDetail: Component<Props> = (props) => {
  const [event, setEvent] = createSignal<Record<string, unknown> | null>(null);
  const [calendars, setCalendars] = createSignal<CalendarMeta[]>([]);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [editing, setEditing] = createSignal(false);

  /**
   * 区间文案：卡片给的"这一次"优先，没有（比如以后从日程窗点开）才用锚点。
   * 只给了 start 没给 end 时不能把锚点的 end 拼上来——那是另一天的收尾。
   */
  const span = (row: Record<string, unknown>): string => {
    const overridden = !!props.seed.start;
    return formatSpan(
      props.seed.start || str(row.start_at),
      overridden ? props.seed.end : str(row.end_at),
      props.seed.allDay || num(row.all_day) !== 0,
      new Date(),
    );
  };

  const load = async () => {
    if (!isHostAvailable() || !props.seed.eventId) {
      setError('缺少日程标识，无法打开详情');
      return;
    }
    try {
      setEvent(await ctx.call<Record<string, unknown>>('get_event', { id: props.seed.eventId }));
      setError('');
    } catch (err) {
      setError(`读取日程失败: ${err}`);
      setEvent(null);
    }
  };

  onMount(() => {
    document.body.classList.add('detail-mode');
    void load();
    void (async () => {
      try {
        const rows = await ctx.call<Record<string, unknown>[]>('list_calendars', {});
        setCalendars(Array.isArray(rows) ? (rows as unknown as CalendarMeta[]) : []);
      } catch {
        // 分类拿不到就退回"未分类"，不该让详情整页打不开
      }
    })();
    // 独立窗口，日程窗那套 Esc 处理不在这页里，自己收口
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editing()) setEditing(false);
      else props.onClose();
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('detail-mode');
    });
  });

  const emitChanged = () => {
    if (!isHostAvailable()) return;
    // 已经开着的日程窗只在自己保存后重取，从详情窗改了时间它不会动
    void ctx.events.emit('cal-changed', { id: props.seed.eventId }).catch(() => undefined);
  };

  const closeWindow = async () => {
    if (!isHostAvailable()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().destroy();
    } catch (err) {
      console.error('关闭详情窗口失败:', err);
    }
  };

  const row = () => event();

  return (
    <div class="cal-modal-mask cal-detail-root">
      <Show when={!editing()}>
        <div class="cal-modal">
          <div class="cal-modal-head">
            <span class="cal-modal-title">日程详情</span>
            <span class="cal-foot-space" />
            <Show when={row()}>
              <button
                type="button"
                class="btn ghost"
                onClick={() => {
                  setNotice('');
                  setEditing(true);
                }}
              >
                编辑
              </button>
            </Show>
            <button
              type="button"
              class="cal-btn cal-btn--icon"
              title="关闭"
              onClick={() => void closeWindow()}
            >
              ✕
            </button>
          </div>

          <div class="cal-modal-body">
            <Show when={row()}>
              {(ev) => (
                <>
                  <div class="cal-detail-title">{str(ev().content)}</div>
                  <div class="cal-field">
                    <span class="cal-field-label">时间</span>
                    <span class="cal-detail-value">{span(ev())}</span>
                  </div>
                  <div class="cal-field">
                    <span class="cal-field-label">日历</span>
                    <span class="cal-dot" style={{ background: colorOf(calendars(), str(ev().calendar_id) || UNCLASSIFIED) }} />
                    <span class="cal-detail-value">
                      {nameOf(calendars(), str(ev().calendar_id) || UNCLASSIFIED)}
                    </span>
                  </div>
                  <Show when={str(ev().location)}>
                    <div class="cal-field">
                      <span class="cal-field-label">地点</span>
                      <span class="cal-detail-value">{str(ev().location)}</span>
                    </div>
                  </Show>
                  <Show when={str(ev().description)}>
                    <div class="cal-field cal-field--top">
                      <span class="cal-field-label">备注</span>
                      <span class="cal-detail-value cal-detail-desc">{str(ev().description)}</span>
                    </div>
                  </Show>
                  <div class="cal-field">
                    <span class="cal-field-label">重复</span>
                    <span class="cal-detail-value">{repeatLabel(str(ev().repeat_rule))}</span>
                  </div>
                  <div class="cal-field">
                    <span class="cal-field-label">提醒</span>
                    <span class="cal-detail-value">
                      {alarmLabel(
                        Array.isArray(ev().alarms) ? (ev().alarms as number[]) : [],
                      )}
                    </span>
                  </div>
                  <div class="cal-field">
                    <span class="cal-field-label">忙闲</span>
                    <span class="cal-detail-value">{ev().status === 'free' ? '空闲' : '忙碌'}</span>
                  </div>
                </>
              )}
            </Show>

            <Show when={notice() && !row()}>
              <div class="cal-hint">{notice()}</div>
            </Show>
            {/* 从编辑态回来一律重取：日程被删了必然取不到，那句"未找到"不该盖掉"已删除日程" */}
            <Show when={error() && !notice()}>
              <div class="cal-error">{error()}</div>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={editing()}>
        <EventModal
          seed={{
            eventId: props.seed.eventId,
            // 实例区间覆盖过锚点 + 有重复规则 = 改的确实是整条规则，编辑面板要讲明白
            isVirtual: !!props.seed.start && !!str(row()?.repeat_rule),
          }}
          calendars={calendars()}
          onClose={() => {
            setEditing(false);
            void load();
          }}
          onSaved={(msg) => setNotice(msg)}
          onChanged={emitChanged}
        />
      </Show>
    </div>
  );
};
