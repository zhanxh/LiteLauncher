import { CommandPlugin, ParsedInput, ActionPreviewCapsule, PanelData, PanelItem } from '../types/command';
import { invoke } from '@tauri-apps/api/core';

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
  description: '管理待办日程；支持 /todo new "事项" [时间] [规则]',
  icon: '✅',

  isAction(input: ParsedInput): boolean {
    return input.subcommand === 'new';
  },

  getPreview(input: ParsedInput): ActionPreviewCapsule | null {
    if (input.subcommand !== 'new') return null;

    const content = input.args.length > 0 ? input.args.join(' ') : '（请输入待办内容）';
    const timeInfo = input.namedArgs['time'] ? `⏰ ${input.namedArgs['time']}` : '无提醒';
    const repeatInfo = input.namedArgs['repeat'] ? ` 🔁 ${input.namedArgs['repeat']}` : '';

    return {
      title: '新建待办事项 (SQLite)',
      detail: `内容: "${content}"  |  提醒: ${timeInfo}${repeatInfo}`,
      badge: '即时动作',
      hint: '按 Enter 回车键保存至本地数据库',
    };
  },

  async execute(input: ParsedInput): Promise<{ success: boolean; message: string }> {
    const content = input.args.join(' ').trim();
    if (!content) {
      return { success: false, message: '待办内容不能为空，请用引号包裹如："买咖啡"' };
    }

    const remind_at = input.namedArgs['time'] || null;
    const repeat_rule = input.namedArgs['repeat'] || null;

    if (isTauri()) {
      try {
        await invoke('create_todo', {
          content,
          remindAt: remind_at,
          repeatRule: repeat_rule,
          rawInput: input.raw,
        });
        const timeDesc = remind_at ? ` (${remind_at})` : '';
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
        const todos = await invoke<TodoBackend[]>('list_todos', {
          keyword: keyword || null,
        });

        const items: PanelItem[] = todos.map((todo) => {
          const timeDesc = todo.remind_at
            ? `提醒: ${todo.remind_at}${todo.repeat_rule ? ` (${todo.repeat_rule})` : ''}`
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

  async onSelect(item: PanelItem): Promise<void> {
    if (isTauri()) {
      try {
        const newState = await invoke<boolean>('toggle_todo', { id: item.id });
        item.badge = newState ? '已完成' : '待办';
        item.icon = newState ? '☑️' : '🔘';
      } catch (err) {
        console.error('切换待办状态失败:', err);
      }
    } else {
      const todo = fallbackTodos.find((t) => t.id === item.id);
      if (todo) {
        todo.completed = !todo.completed;
      }
    }
  },
};
