/**
 * /cal 指令插件（后端 id 仍是 `todo`）
 *
 * `plugin_id` 不能跟着改名：宿主 `plugin_call` 是按 webview 的 pluginId 找后端的，
 * 只有 `svc.*` 走服务表。所以这里改的只有**触发词**（`/cal`，`/todo` 留作隐藏别名）
 * 与语法，用户既有数据、设置键和窗口标签全部原地可用。
 */
import { CommandPlugin, ParsedInput, ActionPreviewCapsule, PanelData, PanelItem } from '@ll/sdk';
import { getPluginContext } from '@ll/sdk';
import { CalDraft, describeDraft, matchCalendarId, parseCalArgs, repeatLabel } from './dsl';

// 经宿主统一通道访问 todo 插件后端（不再直接 invoke 业务命令）
const ctx = getPluginContext('todo');

export { repeatLabel };

interface TodoBackend {
  id: string;
  content: string;
  remind_at: string | null;
  repeat_rule: string | null;
  completed: boolean;
  raw_input: string;
  created_at: number;
}

interface CalendarRow {
  id: string;
  name: string;
  color: string;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 从 namedArgs 还原语法结果。
 *
 * `enrichParsed` 已经把 args 剥成只剩标题，所以预览与执行**不能**再对 args 二次解析
 * （二次解析会把 `10-15 14:00` 当成裸词看回来，胶囊显示"未定时"）。
 * namedArgs 是这条链上唯一的载体。
 */
function draftOf(input: ParsedInput): CalDraft | undefined {
  const sub = input.subcommand;
  if (!sub || !SYNTAX_SUBS.has(sub)) return undefined;
  const n = input.namedArgs ?? {};
  return {
    title: n['cal.title'] ?? '',
    startAt: n['cal.time'] ?? '',
    endAt: n['cal.end'] ?? '',
    allDay: n['cal.allday'] === '1',
    alarms: (n['cal.alarms'] ?? '').split(',').filter(Boolean).map(Number),
    location: n['cal.where'] ?? '',
    description: n['cal.note'] ?? '',
    calendarName: n['cal.name'] ?? '',
    status: n['cal.status'] ?? '',
    repeatRule: n['cal.repeat'] ?? '',
  };
}

/**
 * 会把语法吃进"日期/时间/flag"的子命令。
 * 其余（list/import/export/cal）必须原样透传：搜 `10-15` 这类关键词、
 * 或拿路径当参数时，被语法吃掉就是错。
 */
const SYNTAX_SUBS = new Set(['new', 'add', 'open', 'day', 'week', 'today', 'del', 'done']);

const pad2 = (n: number) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** 语法消费掉的 token 不再进关键词，del/open 的匹配词因此和标题同源 */
function keywordOf(input: ParsedInput, draft?: CalDraft): string {
  const fromDraft = draft?.title?.trim();
  if (fromDraft) return fromDraft;
  return (input.queryText ?? '').trim();
}

/** 日程落库参数：`save` 的字段一次填齐，缺省项交后端按默认处理 */
function toSaveArgs(draft: CalDraft, calendarId: string, rawInput: string) {
  return {
    content: draft.title,
    start_at: draft.startAt,
    end_at: draft.endAt,
    all_day: draft.allDay ? 1 : 0,
    location: draft.location,
    description: draft.description,
    calendar_id: calendarId,
    status: draft.status,
    repeat_rule: draft.repeatRule,
    alarms: draft.alarms,
    raw_input: rawInput,
  };
}

// 供浏览器前端开发环境回退暂存
const fallbackTodos: TodoBackend[] = [
  { id: '1', content: '团队下午技术周会', remind_at: '14:30', repeat_rule: null, completed: false, raw_input: '', created_at: Date.now() },
  { id: '2', content: 'LiteLauncher 架构重构', remind_at: '17:00', repeat_rule: null, completed: false, raw_input: '', created_at: Date.now() },
  { id: '3', content: '提交代码到版本控制仓库', remind_at: null, repeat_rule: null, completed: true, raw_input: '', created_at: Date.now() },
];

/**
 * 待办/日程指令插件：主触发词 `/cal`，`/todo` 为隐藏别名（同一个 id）
 */
export const todoPlugin: CommandPlugin = {
  id: 'todo',
  trigger: '/cal',
  name: '日程管理',
  description:
    '日程与待办：/cal 首行直达日程窗口（/cal app 同义）；/cal new "评审" 10-15 14:00-15:30 --al 10,30 到点弹窗+系统通知',
  icon: '🗓',
  argsHint: 'new|list|today|week|open|del|done|cal|import|export',
  examples: [
    '/cal —— 列出日程，首行「打开日程管理」回车即开窗口',
    '/cal app —— 打开日程窗口（月/周/日三视图）',
    '/cal new 明天下午三点 项目评审 —— 自然语言时间，剩余文本自动作标题',
    '/cal new "需求评审" 10-15 14:00-15:30 —— 指定区间，默认提前 0 分钟提醒',
    '/cal new "周报" friday 17:00 every:1week --al 30,10 —— 每周五 17:00，提前 30 与 10 分钟各提醒一次',
    '/cal new "出差" 10-20 --all-day --where 上海 —— 全天事项（时间轴上不占格子）',
    '/cal new "健身" 19:00 --cal 生活 --free —— 归到「生活」分类，且标为空闲',
    '/cal today —— 只看今天 · /cal list 会议 —— 按关键词搜',
    '/cal done 周报 · /cal del 周报 —— 按标题匹配（多条命中不会误删）',
    '/cal cal add 工作 #4c8dff —— 新建分类日历',
    '/cal import ~/downloads/plan.ics · /cal export —— .ics 双向（导出落在"下载"目录）',
  ],

  isAction(input: ParsedInput): boolean {
    const sub = input.subcommand;
    if (!sub) return false;
    return (
      sub === 'new' ||
      sub === 'add' ||
      sub === 'app' ||
      sub === 'today' ||
      sub === 'week' ||
      sub === 'day' ||
      sub === 'open' ||
      sub === 'del' ||
      sub === 'done' ||
      sub === 'cal' ||
      sub === 'import' ||
      sub === 'export'
    );
  },

  enrichParsed(tokens: string[], _input: ParsedInput): Partial<ParsedInput> {
    const sub = _input.subcommand;
    if (!sub || !SYNTAX_SUBS.has(sub)) return {};
    const draft = parseCalArgs(tokens, new Date(), _input.quotedArgs);
    const namedArgs: Record<string, string> = { ..._input.namedArgs };
    // 时间/重复同时写进老键名：外部按 namedArgs['time'] 取值的写法不该因为改名而失效
    if (draft.startAt) {
      namedArgs['time'] = draft.startAt;
      namedArgs['cal.time'] = draft.startAt;
    }
    if (draft.endAt) namedArgs['cal.end'] = draft.endAt;
    if (draft.repeatRule) {
      namedArgs['repeat'] = draft.repeatRule;
      namedArgs['cal.repeat'] = draft.repeatRule;
    }
    if (draft.title) namedArgs['cal.title'] = draft.title;
    if (draft.allDay) namedArgs['cal.allday'] = '1';
    if (draft.alarms.length) namedArgs['cal.alarms'] = draft.alarms.join(',');
    if (draft.location) namedArgs['cal.where'] = draft.location;
    if (draft.description) namedArgs['cal.note'] = draft.description;
    if (draft.calendarName) namedArgs['cal.name'] = draft.calendarName;
    if (draft.status) namedArgs['cal.status'] = draft.status;
    return { args: draft.title ? [draft.title] : [], namedArgs };
  },

  getPreview(input: ParsedInput): ActionPreviewCapsule | null {
    const sub = input.subcommand;
    if (!sub) return null;
    const draft = draftOf(input);

    if (sub === 'app') {
      return {
        title: '打开日程窗口',
        detail: '月/周/日三视图 · 拖拽建改 · 分类日历与 .ics 导入导出都在窗口内',
        badge: '即时动作',
        hint: '按 Enter 回车打开日程窗口',
      };
    }
    if (sub === 'today' || sub === 'week' || sub === 'day') {
      const day = sub === 'day' ? draft?.startAt?.slice(0, 10) ?? '' : '';
      return {
        title:
          sub === 'week'
            ? '打开本周的周视图'
            : sub === 'day'
              ? `打开 ${day || '指定'} 的日视图`
              : '打开今天的日视图',
        detail: '时间轴按 15 分钟吸附，按住空白处拖动即可新建',
        badge: '即时动作',
        hint: '按 Enter 回车打开日程窗口',
      };
    }
    if (sub === 'new' || sub === 'add') {
      const content = draft?.title || '（请输入日程标题）';
      return {
        title: '新建日程 (SQLite)',
        detail: `"${content}"  |  ${draft ? describeDraft(draft) : ''}`,
        badge: '即时动作',
        hint: '按 Enter 回车保存并在日历上落位',
      };
    }
    if (sub === 'open' || sub === 'del' || sub === 'done') {
      const kw = keywordOf(input, draft);
      const verb = sub === 'open' ? '跳到日历' : sub === 'del' ? '删除日程' : '标记完成';
      return {
        title: `${verb} (SQLite)`,
        detail: kw ? `按标题匹配: "${kw}"` : '缺少关键词，需能唯一命中一条日程',
        badge: '即时动作',
        hint: sub === 'del' ? '按 Enter 执行（命中多条会拒绝并提示）' : '按 Enter 执行',
      };
    }
    if (sub === 'cal') {
      const [act, ...rest] = input.args;
      return {
        title: '分类日历管理',
        detail: `用法：/cal cal add 名称 #颜色 | rm 名称 | list`,
        badge: '即时动作',
        hint: act ? `按 Enter 执行 ${act}：${rest.join(' ')}` : '按 Enter 列出全部分类',
      };
    }
    if (sub === 'export') {
      return {
        title: '导出 .ics',
        detail: '导出未来 90 天的日程（重复规则原样带出，交对端日历展开）',
        badge: '即时动作',
        hint: '按 Enter 导出，完成后提示文件路径',
      };
    }
    if (sub === 'import') {
      const path = keywordOf(input, draft);
      return {
        title: '导入 .ics',
        detail: path ? `读取: ${path}` : '缺少文件路径，如 /cal import ~/downloads/plan.ics',
        badge: '即时动作',
        hint: '按 Enter 导入（按 UID 去重，同一条重复导入只会更新）',
      };
    }
    return null;
  },

  async execute(input: ParsedInput): Promise<{ success: boolean; message: string }> {
    const sub = input.subcommand;
    if (!sub) return { success: false, message: '缺少子命令，如 /cal new "评审" 14:00' };
    const draft = draftOf(input);

    if (sub === 'app') return openCalendar('', '');
    if (sub === 'today') return openCalendar('day', todayStr());
    if (sub === 'week') return openCalendar('week', todayStr());
    if (sub === 'day') {
      const d = draft?.startAt?.slice(0, 10) || todayStr();
      return openCalendar('day', d);
    }

    if (!isTauri()) {
      if (sub === 'new' || sub === 'add') {
        const content = draft?.title ?? '';
        if (!content) return { success: false, message: '标题不能为空，请用引号包裹如："买咖啡"' };
        fallbackTodos.unshift({
          id: Date.now().toString(),
          content,
          remind_at: draft?.startAt || null,
          repeat_rule: draft?.repeatRule || null,
          completed: false,
          raw_input: input.raw,
          created_at: Date.now(),
        });
        return { success: true, message: `[预览模式] 已添加日程: "${content}"` };
      }
      return { success: true, message: '[预览模式] 已执行' };
    }

    try {
      switch (sub) {
        case 'new':
        case 'add': {
          const content = draft?.title ?? '';
          if (!content.trim()) {
            return { success: false, message: '标题不能为空，请用引号包裹如："买咖啡"' };
          }
          const cal = await resolveCalendar(draft!);
          const saved = await ctx.call<{ start_at?: string; end_at?: string }>('save', {
            ...toSaveArgs(draft!, cal.id, input.raw),
          });
          // 指定的分类名对不上时不报错，但在消息里点一句，免得用户以为归错类是 bug
          const miss =
            draft!.calendarName && !cal.matched ? `（没有叫「${draft!.calendarName}」的分类）` : '';
          const conflict = await conflictHint(saved?.start_at, saved?.end_at);
          return {
            success: true,
            message: `已保存: "${content}"  |  ${describeDraft(draft!)}${miss}${conflict}`,
          };
        }
        case 'open': {
          const kw = keywordOf(input, draft);
          const hit = await findOne(kw);
          if (!hit) return { success: false, message: missMessage(kw) };
          // list 视图不带 start_at，remind_at 与它同值（后端 save 会同步这两列）
          const day = String(hit['remind_at'] ?? '').slice(0, 10);
          return openCalendar(day ? 'day' : '', day);
        }
        case 'del': {
          const kw = keywordOf(input, draft);
          const hit = await findOne(kw);
          if (!hit) return { success: false, message: missMessage(kw) };
          await ctx.call('delete', { id: String(hit['id']) });
          return { success: true, message: `已删除: "${hit['content']}"` };
        }
        case 'done': {
          const kw = keywordOf(input, draft);
          const hit = await findOne(kw, true);
          if (!hit) return { success: false, message: missMessage(kw) };
          if (hit['completed'] === true || hit['completed'] === 1) {
            return { success: true, message: `"${hit['content']}" 已经是完成状态` };
          }
          await ctx.call('toggle', { id: String(hit['id']) });
          return { success: true, message: `已完成: "${hit['content']}"` };
        }
        case 'cal': {
          const [act, ...rest] = input.args;
          return await runCalendarCmd(act ?? 'list', rest);
        }
        case 'export': {
          // 命令行只给"往后多少天"，窗口内导出则由 CalendarApp 按当前视图区间请求
          const days = Number(input.args[0]) || 90;
          const res = await ctx.call<{ path: string; count: number }>('export_ics', {
            from: todayStr(),
            to: plusDays(todayStr(), days),
          });
          return { success: true, message: `已导出 ${res.count} 条：${res.path}` };
        }
        case 'import': {
          const path = (input.args.join(' ') || input.queryText).trim();
          if (!path) return { success: false, message: '缺少文件路径，如 /cal import ~/downloads/plan.ics' };
          const res = await ctx.call<{ added: number; updated: number; skipped: number; total: number }>(
            'import_ics',
            { path },
          );
          return {
            success: true,
            message: `导入 ${res.total} 条：新增 ${res.added}、更新 ${res.updated}${res.skipped ? `、跳过 ${res.skipped}` : ''}`,
          };
        }
        default:
          return { success: false, message: `未知子命令: ${sub}` };
      }
    } catch (err: any) {
      return { success: false, message: `执行失败: ${err?.message || err}` };
    }
  },

  async query(input: ParsedInput): Promise<PanelData> {
    const keyword = (input.queryText ?? '').trim();
    // 固定入口：第一行直达日程窗口，用户不必先记住 `/cal app` 这条子命令
    // （与 /note 的「打开笔记管理面板」同款）
    const managerItem: PanelItem = {
      id: '__cal_open_manager__',
      title: '打开日程管理',
      description: '月/周/日三视图 · 拖拽建改 · 分类日历与 .ics 导入导出',
      icon: '📅',
      badge: '面板',
      metadata: { openManager: true },
    };

    if (isTauri()) {
      try {
        const todos = await ctx.call<TodoBackend[]>('list', { keyword: keyword || null });
        const items: PanelItem[] = todos.map((todo) => {
          const timeDesc = todo.remind_at
            ? `提醒: ${todo.remind_at}${todo.repeat_rule ? ` (${repeatLabel(todo.repeat_rule)})` : ''}`
            : '无提醒';
          return {
            id: todo.id,
            title: todo.content,
            description: timeDesc,
            badge: todo.completed ? '已完成' : '待办',
            icon: todo.completed ? '☑️' : '🔘',
            metadata: todo,
          };
        });
        return {
          items: [managerItem, ...items],
          emptyText: '暂无日程，输入 /cal new "内容" 14:00-15:30 可快速添加',
        };
      } catch (err) {
        console.warn('读取日程失败:', err);
      }
    }

    const filtered = fallbackTodos.filter((item) => {
      if (!keyword) return true;
      return item.content.toLowerCase().includes(keyword.toLowerCase());
    });

    return {
      items: [
        managerItem,
        ...filtered.map((item) => ({
          id: item.id,
          title: item.content,
          description: item.remind_at ? `提醒: ${item.remind_at}` : '无提醒',
          badge: item.completed ? '已完成' : '待办',
          icon: item.completed ? '☑️' : '🔘',
          metadata: item,
        })),
      ],
      emptyText: '暂无日程',
    };
  },

  async onSelect(item: PanelItem) {
    // 固定入口：打开日程窗口（等同 /cal app）。必须排在 toggle 之前——
    // 它的 id 不是日程 id，落到 toggle 会是一次无意义的写库
    if (item.metadata?.openManager) {
      const r = await openCalendar('', '');
      return { toast: r.message, close: r.success } as const;
    }
    if (isTauri()) {
      try {
        const newState = await ctx.call<boolean>('toggle', { id: item.id });
        item.badge = newState ? '已完成' : '待办';
        item.icon = newState ? '☑️' : '🔘';
        return { toast: `已选择: ${item.title}`, refresh: true } as const;
      } catch (err) {
        console.error('切换日程状态失败:', err);
        return;
      }
    }
    const todo = fallbackTodos.find((t) => t.id === item.id);
    if (todo) todo.completed = !todo.completed;
    return { toast: `已选择: ${item.title}`, refresh: true } as const;
  },
};

/** `/cal` 的隐藏别名：精确敲 `/todo` 仍旧可用，但不出现在补全/帮助里（见 registry.getAll） */
export const todoAlias: CommandPlugin = { ...todoPlugin, trigger: '/todo', hidden: true };

// ───────────────────────────── 执行辅助 ─────────────────────────────

async function openCalendar(mode: string, day: string): Promise<{ success: boolean; message: string }> {
  if (!isTauri()) return { success: true, message: '[预览模式] 打开日程窗口' };
  try {
    await ctx.call('open_manager', { mode, day });
    return { success: true, message: day ? `已打开日程窗口（${day}）` : '已打开日程窗口' };
  } catch (err: any) {
    return { success: false, message: `打开窗口失败: ${err?.message || err}` };
  }
}

/** `--cal 工作` → 分类 id。对不上就落默认分类，由调用方在消息里点一句 */
async function resolveCalendar(draft: CalDraft): Promise<{ id: string; matched: boolean }> {
  if (!draft.calendarName) return { id: 'default', matched: false };
  const rows = await ctx.call<CalendarRow[]>('list_calendars', {});
  const hit = matchCalendarId(draft.calendarName, rows ?? []);
  return { id: hit || 'default', matched: !!hit };
}

/** 后端 save 已返回真实起止时间，冲突只提示不拦截（用户要的是"存下了"） */
async function conflictHint(startAt?: string, endAt?: string): Promise<string> {
  if (!startAt || !endAt) return '';
  try {
    const res = await ctx.call<{ conflicts?: unknown[] }>('check_conflict', {
      start_at: startAt,
      end_at: endAt,
    });
    const n = res?.conflicts?.length ?? 0;
    return n > 0 ? `  |  ⚠ 与 ${n} 条日程重叠` : '';
  } catch {
    return '';
  }
}

/**
 * 关键词命中一条才返回；命中多条返回 null 让调用方拒绝执行。
 * del/done 是不可逆操作，"取第一条"这种猜测代价太高。
 */
async function findOne(keyword: string, onlyOpen = false): Promise<Record<string, unknown> | null> {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return null;
  const rows = (await ctx.call<Record<string, unknown>[]>('list', { keyword })) ?? [];
  const hit = rows.filter((r) => String(r['content'] ?? '').toLowerCase().includes(kw));
  const pool = onlyOpen ? hit.filter((r) => r['completed'] !== true && r['completed'] !== 1) : hit;
  if (pool.length !== 1) return null;
  return pool[0];
}

function missMessage(keyword: string): string {
  const kw = keyword.trim();
  if (!kw) return '缺少关键词，如 /cal done 周报';
  return `未能唯一命中「${kw}」——要么没有，要么不止一条；换个更具体的关键词`;
}

function plusDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + Math.max(1, Math.min(n, 3660)));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

async function runCalendarCmd(act: string, rest: string[]): Promise<{ success: boolean; message: string }> {
  const name = rest[0] ?? '';
  const color = rest.find((t) => /^#[0-9a-fA-F]{3,6}$/.test(t)) ?? '';
  if (act === 'list') {
    const rows = await ctx.call<CalendarRow[]>('list_calendars', {});
    if (!rows?.length) return { success: true, message: '暂无分类日历' };
    return { success: true, message: rows.map((c) => `${c.name} ${c.color}`).join(' · ') };
  }
  if (act === 'add' || act === 'new') {
    if (!name) return { success: false, message: '用法：/cal cal add 名称 #颜色' };
    await ctx.call('save_calendar', { name, color });
    return { success: true, message: `已新建日历：${name}` };
  }
  if (act === 'rm' || act === 'del' || act === 'remove') {
    if (!name) return { success: false, message: '用法：/cal cal rm 名称' };
    const rows = await ctx.call<CalendarRow[]>('list_calendars', {});
    const id = matchCalendarId(name, rows ?? []);
    if (!id) return { success: false, message: `未找到分类：${name}` };
    await ctx.call('delete_calendar', { id });
    return { success: true, message: `已删除日历：${name}（其中日程转为未分类）` };
  }
  return { success: false, message: `未知子命令：/cal cal ${act}（支持 add | rm | list）` };
}
