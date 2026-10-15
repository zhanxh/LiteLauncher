/**
 * 日程主窗口（?view=calendar）：月 / 周 / 日三视图 + 分类侧栏 + 编辑器
 *
 * 数据只有一条通道：按当前视图的区间向后端要一次展开好的实例，本地按分类勾选过滤。
 * 分类筛选放前端而不是每次重查，是因为勾选要同时看多个分类，
 * 后端 query_range 的 calendar_id 只支持单值。
 */
import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { listen } from '@tauri-apps/api/event';
import { getPluginContext, isHostAvailable } from '@ll/sdk';
import { daysInMonth, firstWeekday, dateKey, todayKey } from './grid';
import { CalInstance, parseLocal } from './daymath';
import { CalendarMeta, UNCLASSIFIED, toggleId } from './calendars';
import { shiftDays, weekStart } from './layout';
import { minToAt } from './EventModal';
import { MonthGrid } from './MonthGrid';
import { TimeGrid } from './TimeGrid';
import { CalSidebar } from './CalSidebar';
import { EventModal } from './EventModal';
import './calendar.css';

// 与后端同属 todo 插件（窗口标签 todo-calendar 也由这个 id 拼出）
const ctx = getPluginContext('todo');

type ViewKind = 'month' | 'week' | 'day';

interface RangeResult {
  instances: CalInstance[];
  truncated: boolean;
}

type Seed = {
  eventId?: string;
  openKey?: string;
  isVirtual?: boolean;
  startMin?: number;
  endMin?: number;
} | null;

const keyOf = (d: Date) => dateKey(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * 月视图的网格起止：连补齐的首尾空行一起算，跨月的邻日也显示条目，
 * 否则上下两行的"本月/下月"看起来像空的，用户会以为那几天没安排。
 */
function monthRange(day: string) {
  const d = parseLocal(day) ?? new Date();
  const year = d.getFullYear();
  const month = d.getMonth();
  const lead = firstWeekday(year, month);
  const total = daysInMonth(year, month);
  const rows = Math.max(6, Math.ceil((lead + total) / 7));
  const start = new Date(year, month, 1 - lead);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + rows * 7 - 1);
  return { from: keyOf(start), to: keyOf(end) };
}

/** 当前视图要问后端的区间（周/日按天，月按补齐后的网格） */
function viewRange(view: ViewKind, anchor: string) {
  if (view === 'month') return monthRange(anchor);
  if (view === 'day') return { from: anchor, to: anchor };
  const from = weekStart(anchor);
  return { from, to: shiftDays(from, 6) };
}

/** 周/日视图的天格子 */
function viewDays(view: ViewKind, anchor: string): string[] {
  if (view === 'day') return [anchor];
  if (view === 'week') {
    const from = weekStart(anchor);
    return Array.from({ length: 7 }, (_, i) => shiftDays(from, i));
  }
  return [];
}

const VIEWS: { id: ViewKind; label: string }[] = [
  { id: 'month', label: '月' },
  { id: 'week', label: '周' },
  { id: 'day', label: '日' },
];

/**
 * `/cal today`、`/cal week` 这类指令把落点写在窗口 URL 上（`?view=calendar&mode=day&day=`）。
 * 只在**开窗那一次**读：窗口 `on_existing:"focus"`，已开着时宿主不会重建，
 * 所以定位对第二次调用无效——这是宿主行为，前端不做兜圈子的轮询。
 */
function bootPosition(): { mode: ViewKind; day: string } {
  const q = new URLSearchParams(window.location.search);
  const mode = q.get('mode');
  const day = q.get('day') ?? '';
  const validMode: ViewKind[] = ['month', 'week', 'day'];
  return {
    mode: mode && (validMode as string[]).includes(mode) ? (mode as ViewKind) : 'month',
    day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : todayKey(),
  };
}

export const CalendarApp: Component = () => {
  const boot = bootPosition();
  const [view, setView] = createSignal<ViewKind>(boot.mode);
  const [anchor, setAnchor] = createSignal(boot.day);
  const [instances, setInstances] = createSignal<CalInstance[]>([]);
  const [calendars, setCalendars] = createSignal<CalendarMeta[]>([]);
  const [hidden, setHidden] = createSignal<Set<string>>(new Set());
  const [truncated, setTruncated] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [statusText, setStatusText] = createSignal('');
  const [selectedDay, setSelectedDay] = createSignal('');
  const [seed, setSeed] = createSignal<Seed>(null);
  // 宿主没有 svc.fs/svc.dialog，选文件只能靠原生 input；后端拿到的是读出来的文本
  let fileInput: HTMLInputElement | undefined;

  // 月视图的 year/month 从这里派生，别在 JSX 里反复 new Date：
  // 每次渲染都是新对象，Solid 会当成变化重排整张网格
  const anchorDate = createMemo(() => parseLocal(anchor()) ?? new Date());

  let flashTimer = 0;
  // 导出路径要看得见、也来得及复制到文件管理器，提示给得比常规操作长
  const flash = (msg: string, ms = 2600) => {
    setStatusText(msg);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setStatusText(''), ms);
  };

  const load = async () => {
    if (!isHostAvailable()) return;
    setBusy(true);
    try {
      const { from, to } = viewRange(view(), anchor());
      const res = await ctx.call<RangeResult>('query_range', { from, to });
      setInstances(res.instances ?? []);
      setTruncated(res.truncated === true);
    } catch (err) {
      flash(`读取日程失败: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  const loadCalendars = async () => {
    if (!isHostAvailable()) return;
    try {
      setCalendars(await ctx.call<CalendarMeta[]>('list_calendars', {}));
    } catch (err) {
      flash(`读取日历分类失败: ${err}`);
    }
  };

  // 换视图或挪日期即重取：一次最多 6 周，展开量可控，不值得做增量缓存
  createEffect(() => {
    view();
    anchor();
    void load();
  });

  createEffect(() => {
    void loadCalendars();
  });

  // Esc 关掉编辑器；日期/时间浮层开着时先让给浮层，否则一次 Esc 两层一起没
  createEffect(() => {
    if (!seed()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.dtf-pop')) setSeed(null);
    };
    // 捕获阶段：Kobalte 在 document 上处理 Esc 并同步卸载浮层，冒泡阶段再查
    // DOM 永远查不到，一次 Esc 就把浮层和编辑器一起关了
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  /**
   * 详情窗（提醒卡片「查看详情」）保存后要能看见新值：本窗口的重取只挂在自己
   * 保存/切月的路径上，不监听就得手动翻个月份才刷新。
   */
  createEffect(() => {
    if (!isHostAvailable()) return;
    let unlisten: (() => void) | undefined;
    void listen<{ pluginId: string; event: string }>('plugin-event', (e) => {
      const p = e.payload;
      if (p.pluginId === 'todo' && p.event === 'cal-changed') void load();
    })
      .then((un) => {
        unlisten = un;
      })
      // 没有 events 权限时退化成"要手动切月份才更新"，不影响数据正确性
      .catch(() => undefined);
    onCleanup(() => unlisten?.());
  });

  const shift = (delta: number) => {
    const v = view();
    if (v === 'month') {
      const d = parseLocal(anchor()) ?? new Date();
      const next = new Date(d.getFullYear(), d.getMonth() + delta, 1);
      setAnchor(keyOf(next));
    } else {
      setAnchor(shiftDays(anchor(), delta * (v === 'week' ? 7 : 1)));
    }
  };

  const goToday = () => setAnchor(todayKey());

  const shown = createMemo(() => {
    const off = hidden();
    return instances().filter((i) => !off.has(i.calendar_id ?? UNCLASSIFIED));
  });

  const dayCount = createMemo(() => new Set(shown().map((i) => i.start.slice(0, 10))).size);
  const hasUnclassified = createMemo(() =>
    instances().some((i) => (i.calendar_id ?? UNCLASSIFIED) === UNCLASSIFIED),
  );

  const title = createMemo(() => {
    const d = anchorDate();
    if (view() === 'month') return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
    if (view() === 'day') return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    const from = viewDays('week', anchor())[0];
    const to = viewDays('week', anchor())[6];
    const f = parseLocal(from);
    const t = parseLocal(to);
    if (!f || !t) return '';
    return `${f.getMonth() + 1}月${f.getDate()}日 – ${t.getMonth() + 1}月${t.getDate()}日`;
  });

  // 没点选日期时落在今天：从顶栏直接建日程，用户要的几乎总是"今天/接下来"
  const newEvent = () => setSeed({ openKey: selectedDay() || anchor() });

  const editEvent = (inst: CalInstance) =>
    setSeed({ eventId: inst.event_id, isVirtual: inst.is_virtual });

  const createAtSpan = (day: string, startMin: number, endMin: number) =>
    setSeed({ openKey: day, startMin, endMin });

  /**
   * 时间轴上拖拽改期：直接落库，不弹编辑器——拖完再点一次"保存"会把拖拽的即时感抹掉。
   * 重复日程展开出的虚拟实例改不得（后端没有实例级例外），只提示。
   */
  const moveSpan = async (inst: CalInstance, startMin: number, endMin: number) => {
    if (inst.is_virtual) {
      flash('重复日程的某一次不能单独改期，改动会落到整条规则');
      return;
    }
    const day = inst.start.slice(0, 10);
    const startAt = minToAt(day, startMin);
    const endAt = minToAt(day, endMin);
    try {
      await ctx.call('save', {
        id: inst.event_id,
        content: inst.content,
        all_day: 0,
        start_at: startAt,
        end_at: endAt,
        location: inst.location ?? '',
        description: inst.description ?? '',
        calendar_id: inst.calendar_id ?? UNCLASSIFIED,
        status: inst.status,
        repeat_rule: inst.repeat_rule ?? '',
        alarms: inst.alarms,
      });
      // 拖完再问冲突：先落库再提示，用户要的是"改成了"，重叠只是提醒不是拦截
      let hint = '';
      try {
        const res = await ctx.call<{ conflicts?: CalInstance[] }>('check_conflict', {
          id: inst.event_id,
          start_at: startAt,
          end_at: endAt,
        });
        const n = res.conflicts?.length ?? 0;
        if (n > 0) hint = `，与 ${n} 条重叠`;
      } catch {
        // 冲突提示失败不该影响改期结果
      }
      flash(`已改到 ${startAt.slice(11)}${hint}`);
      await load();
    } catch (err) {
      flash(`改期失败: ${err}`);
    }
  };

  const createCalendar = async (name: string, color: string) => {
    try {
      await ctx.call('save_calendar', { name, color });
      await loadCalendars();
      flash(`已新建日历：${name}`);
    } catch (err) {
      flash(`新建日历失败: ${err}`);
    }
  };

  const renameCalendar = async (id: string, name: string, color: string) => {
    try {
      await ctx.call('save_calendar', { id, name, color });
      await loadCalendars();
    } catch (err) {
      flash(`改名失败: ${err}`);
    }
  };

  const deleteCalendar = async (id: string) => {
    try {
      await ctx.call('delete_calendar', { id });
      // 该分类的日程降级成"未分类"：勾选状态跟着清理，并把未分类显式打开，
      // 否则用户会觉得删个分类把日程一起删了。
      setHidden((s) => {
        const n = new Set(s);
        n.delete(id);
        n.delete(UNCLASSIFIED);
        return n;
      });
      await loadCalendars();
      await load();
      flash('已删除日历，其中的日程转为未分类');
    } catch (err) {
      flash(`删除日历失败: ${err}`);
    }
  };

  const exportIcs = async () => {
    const { from, to } = viewRange(view(), anchor());
    try {
      const res = await ctx.call<{ path: string; count: number }>('export_ics', { from, to });
      flash(`已导出 ${res.count} 条到 ${res.path}`);
    } catch (err) {
      flash(`导出失败: ${err}`);
    }
  };

  const readFile = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result ?? ''));
      fr.onerror = () => reject(fr.error);
      fr.readAsText(f);
    });

  const onPickFile = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    try {
      const text = await readFile(f);
      const res = await ctx.call<{ added: number; updated: number; skipped: number; total: number }>(
        'import_ics',
        { text },
      );
      await load();
      flash(`导入 ${f.name}：新增 ${res.added}、更新 ${res.updated}（共 ${res.total} 条）`);
    } catch (err) {
      flash(`导入失败: ${err}`);
    } finally {
      // 同一个文件连选两次也要触发 change，否则第二次没反应
      if (fileInput) fileInput.value = '';
    }
  };

  const visible = createMemo(
    () =>
      new Set(
        [...calendars().map((c) => c.id), UNCLASSIFIED].filter((id) => !hidden().has(id)),
      ),
  );

  const pickDay = (key: string) => {
    setSelectedDay(key);
    setAnchor(key);
  };

  return (
    <div class="cal-root">
      <header class="cal-bar">
        <div class="cal-head-nav">
          <button type="button" class="cal-btn cal-btn--icon" onClick={() => shift(-1)} title="上一段">
            ‹
          </button>
          <span class="cal-head-title">{title()}</span>
          <button type="button" class="cal-btn cal-btn--icon" onClick={() => shift(1)} title="下一段">
            ›
          </button>
          <button type="button" class="cal-btn" onClick={goToday}>
            今天
          </button>
          <div class="cal-seg">
            <For each={VIEWS}>
              {(v) => (
                <button
                  type="button"
                  class="cal-seg-btn"
                  classList={{ sel: view() === v.id }}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </button>
              )}
            </For>
          </div>
        </div>
        <div class="cal-meta">
          <Show when={busy()}>
            <span class="cal-muted">载入中…</span>
          </Show>
          <Show when={!busy()}>
            <span class="cal-muted">{dayCount()} 天有安排</span>
          </Show>
          <Show when={truncated()}>
            <span class="cal-warn">这段区间的重复实例过多，仅显示前 5000 条</span>
          </Show>
          <button type="button" class="btn small" onClick={() => fileInput?.click()}>
            导入
          </button>
          <button type="button" class="btn small" onClick={() => void exportIcs()}>
            导出
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".ics,text/calendar"
            class="cal-hidden-input"
            onChange={(e) => void onPickFile(e.currentTarget.files)}
          />
          <button type="button" class="btn primary small" onClick={newEvent}>
            ＋ 新建日程
          </button>
        </div>
      </header>

      <div class="cal-main">
        <CalSidebar
          calendars={calendars()}
          visible={visible()}
          onToggle={(id) => setHidden((s) => toggleId(s, id))}
          onCreate={(name, color) => void createCalendar(name, color)}
          onDelete={(id) => void deleteCalendar(id)}
          onRename={(id, name, color) => void renameCalendar(id, name, color)}
          hasUnclassified={hasUnclassified()}
        />

        <Show
          when={view() === 'month'}
          fallback={
            <TimeGrid
              days={viewDays(view(), anchor())}
              instances={shown()}
              calendars={calendars()}
              today={todayKey()}
              onSelectEvent={editEvent}
              onCreateSpan={createAtSpan}
              onMoveSpan={(inst, s, e) => void moveSpan(inst, s, e)}
              onSelectDay={pickDay}
            />
          }
        >
          <MonthGrid
            year={anchorDate().getFullYear()}
            month={anchorDate().getMonth()}
            instances={shown()}
            calendars={calendars()}
            onSelectDay={pickDay}
            onSelectEvent={editEvent}
          />
        </Show>
      </div>

      <footer class="cal-foot">
        <Show when={selectedDay()}>
          <button
            type="button"
            class="cal-mini"
            title={`在 ${selectedDay()} 新建日程`}
            onClick={newEvent}
          >
            ＋ {selectedDay()}
          </button>
        </Show>
        <Show when={view() !== 'month'}>
          <span class="cal-muted">在时间轴上按住拖动即可新建，拖动已有日程可改期</span>
        </Show>
        <Show when={statusText()}>
          <span class="cal-status">{statusText()}</span>
        </Show>
      </footer>

      <EventModal
        seed={seed()}
        calendars={calendars()}
        onClose={() => setSeed(null)}
        onSaved={flash}
        onChanged={() => void load()}
      />
    </div>
  );
};
