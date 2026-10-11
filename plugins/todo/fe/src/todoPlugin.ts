import { CommandPlugin, ParsedInput, ActionPreviewCapsule, PanelData, PanelItem } from '@ll/sdk';
import { getPluginContext } from '@ll/sdk';

// 经宿主统一通道访问 todo 插件后端（不再直接 invoke 业务命令）
const ctx = getPluginContext('todo');

interface TodoBackend {
  id: string;
  content: string;
  remind_at: string | null;
  repeat_rule: string | null;
  completed: boolean;
  raw_input: string;
  created_at: number;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 重复规则存储格式（every:N{min|hour|day|week|month}）→ 中文标签 */
export function repeatLabel(rule?: string | null): string {
  if (!rule) return '';
  const m = rule.match(/^every:(\d+)(min|hour|day|week|month)$/);
  if (!m) return rule;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const single: Record<string, string> = {
    day: '每天',
    week: '每周',
    month: '每月',
    hour: '每小时',
    min: '每分钟',
  };
  if (n === 1 && single[unit]) return single[unit];
  const units: Record<string, string> = {
    min: '分钟',
    hour: '小时',
    day: '天',
    week: '周',
    month: '个月',
  };
  return `每 ${n} ${units[unit] ?? unit}`;
}

/**
 * todo 专属时间/重复规则语法解析（自 core/tokenizer 迁入，LPS-1 enrichParsed 钩子）
 *
 * 支持时间格式：HH:MM[:SS]、YYYY-MM-DD、YYYY-MM-DD HH:MM（相邻 Token 或引号包裹）
 * 支持重复规则：daily/weekly/mon..sun 关键词与 every:30min 间隔语法
 * 规范化为与后端一致的 every:N{min|hour|day|week|month}
 */
function extractTimeAndRule(args: string[]): {
  cleanArgs: string[];
  time?: string;
  repeatRule?: string;
} {
  const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
  const dateRegex = /^\d{4}-\d{1,2}-\d{1,2}$/;
  const dateTimeRegex = /^\d{4}-\d{1,2}-\d{1,2}[ T]([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
  const intervalRegex = /^(?:every|repeat):(\d{1,3})(min(?:ute)?s?|h(?:our)?s?|d(?:ay)?s?|w(?:eek)?s?|mo(?:nth)?s?|m)$/i;
  const repeatKeywords = ['daily', 'weekly', 'fri', 'mon', 'tue', 'wed', 'thu', 'sat', 'sun'];

  let time: string | undefined;
  let repeatRule: string | undefined;
  const cleanArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const lower = arg.toLowerCase();

    const intervalMatch = arg.match(intervalRegex);
    if (intervalMatch) {
      const n = intervalMatch[1];
      const u = intervalMatch[2].toLowerCase();
      const unit = u.startsWith('min')
        ? 'min'
        : u.startsWith('h')
          ? 'hour'
          : u.startsWith('d')
            ? 'day'
            : u.startsWith('w')
              ? 'week'
              : 'month';
      repeatRule = `every:${n}${unit}`;
    } else if (dateTimeRegex.test(arg)) {
      time = arg.replace('T', ' ');
    } else if (dateRegex.test(arg)) {
      if (i + 1 < args.length && timeRegex.test(args[i + 1])) {
        time = `${arg} ${args[i + 1]}`;
        i++;
      } else {
        time = arg;
      }
    } else if (timeRegex.test(arg)) {
      time = arg;
    } else if (repeatKeywords.includes(lower)) {
      repeatRule = lower;
    } else {
      cleanArgs.push(arg);
    }
  }

  return { cleanArgs, time, repeatRule };
}

// 供浏览器纯前端开发环境回退暂存
const fallbackTodos: TodoBackend[] = [
  { id: '1', content: '团队下午技术周会', remind_at: '14:30', repeat_rule: null, completed: false, raw_input: '', created_at: Date.now() },
  { id: '2', content: 'LiteLauncher 架构重构', remind_at: '17:00', repeat_rule: null, completed: false, raw_input: '', created_at: Date.now() },
  { id: '3', content: '提交代码到版本控制仓库', remind_at: null, repeat_rule: null, completed: true, raw_input: '', created_at: Date.now() },
];

/**
 * 待办指令插件：/todo
 */
export const todoPlugin: CommandPlugin = {
  id: 'todo',
  trigger: '/todo',
  name: '待办事项',
  description:
    '待办管理：/todo app 打开管理面板；/todo new "事项" 14:30 [every:30min] 到点弹窗+系统通知',
  icon: '✅',

  isAction(input: ParsedInput): boolean {
    return input.subcommand === 'new' || input.subcommand === 'app';
  },

  enrichParsed(tokens: string[], _input: ParsedInput): Partial<ParsedInput> {
    const { cleanArgs, time, repeatRule } = extractTimeAndRule(tokens);
    const namedArgs: Record<string, string> = {};
    if (time) namedArgs['time'] = time;
    if (repeatRule) namedArgs['repeat'] = repeatRule;
    return { args: cleanArgs, namedArgs };
  },

  getPreview(input: ParsedInput): ActionPreviewCapsule | null {
    if (input.subcommand === 'app') {
      return {
        title: '打开待办管理面板',
        detail: '查看/编辑/完成待办，管理弹窗提醒倒计时时长',
        badge: '即时动作',
        hint: '按 Enter 回车打开面板窗口',
      };
    }
    if (input.subcommand !== 'new') return null;

    const content = input.args.length > 0 ? input.args.join(' ') : '（请输入待办内容）';
    const timeInfo = input.namedArgs['time'] ? `⏰ ${input.namedArgs['time']}` : '无提醒';
    const repeatInfo = input.namedArgs['repeat'] ? ` 🔁 ${repeatLabel(input.namedArgs['repeat'])}` : '';

    return {
      title: '新建待办事项 (SQLite)',
      detail: `内容: "${content}"  |  提醒: ${timeInfo}${repeatInfo}`,
      badge: '即时动作',
      hint: '按 Enter 回车键保存至本地数据库',
    };
  },

  async execute(input: ParsedInput): Promise<{ success: boolean; message: string }> {
    if (input.subcommand === 'app') {
      if (isTauri()) {
        try {
          await ctx.call('open_manager');
          return { success: true, message: '已打开待办管理面板' };
        } catch (err: any) {
          return { success: false, message: `打开面板失败: ${err?.message || err}` };
        }
      }
      return { success: true, message: '[预览模式] 打开待办管理面板' };
    }

    const content = input.args.join(' ').trim();
    if (!content) {
      return { success: false, message: '待办内容不能为空，请用引号包裹如："买咖啡"' };
    }

    const remind_at = input.namedArgs['time'] || null;
    const repeat_rule = input.namedArgs['repeat'] || null;

    if (isTauri()) {
      try {
        const saved = await ctx.call<TodoBackend>('create', {
          content,
          remind_at: remind_at,
          repeat_rule: repeat_rule,
          raw_input: input.raw,
        });
        const timeDesc = saved.remind_at ? ` (${saved.remind_at})` : '';
        return { success: true, message: `已成功保存待办: "${content}"${timeDesc}` };
      } catch (err: any) {
        return { success: false, message: `保存失败: ${err?.message || err}` };
      }
    }

    // 浏览器预览回退
    fallbackTodos.unshift({
      id: Date.now().toString(),
      content,
      remind_at,
      repeat_rule,
      completed: false,
      raw_input: input.raw,
      created_at: Date.now(),
    });
    return { success: true, message: `[预览模式] 已添加待办: "${content}"` };
  },

  async query(input: ParsedInput): Promise<PanelData> {
    const keyword = input.queryText.trim();

    if (isTauri()) {
      try {
        const todos = await ctx.call<TodoBackend[]>('list', {
          keyword: keyword || null,
        });

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
          items,
          emptyText: '暂无待办事项，输入 /todo new "内容" 可快速添加',
        };
      } catch (err) {
        console.warn('读取待办失败:', err);
      }
    }

    // 浏览器环境回退
    const filtered = fallbackTodos.filter((item) => {
      if (!keyword) return true;
      return item.content.toLowerCase().includes(keyword.toLowerCase());
    });

    return {
      items: filtered.map((item) => ({
        id: item.id,
        title: item.content,
        description: item.remind_at ? `提醒: ${item.remind_at}` : '无提醒',
        badge: item.completed ? '已完成' : '待办',
        icon: item.completed ? '☑️' : '🔘',
        metadata: item,
      })),
      emptyText: '暂无待办事项',
    };
  },

  async onSelect(item: PanelItem) {
    if (isTauri()) {
      try {
        const newState = await ctx.call<boolean>('toggle', { id: item.id });
        item.badge = newState ? '已完成' : '待办';
        item.icon = newState ? '☑️' : '🔘';
        return { toast: `已选择: ${item.title}`, refresh: true } as const;
      } catch (err) {
        console.error('切换待办状态失败:', err);
        return;
      }
    } else {
      const todo = fallbackTodos.find((t) => t.id === item.id);
      if (todo) {
        todo.completed = !todo.completed;
      }
      return { toast: `已选择: ${item.title}`, refresh: true } as const;
    }
  },
};
