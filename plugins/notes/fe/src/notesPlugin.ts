import { CommandPlugin, ParsedInput, PanelData, PanelItem, ActionPreviewCapsule } from '@ll/sdk';
import { getPluginContext } from '@ll/sdk';

// 经宿主统一通道访问 notes 插件后端
const ctx = getPluginContext('notes');

interface NoteBackend {
  path: string;
  title: string;
  mtime: number;
  snippet: string;
  tags: string;
}

interface CreatedNote {
  path: string;
  title: string;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 笔记指令插件：/note
 */
export const notesPlugin: CommandPlugin = {
  id: 'notes',
  trigger: '/note',
  name: 'Markdown 笔记',
  description:
    '笔记管理：/note 检索本地 Markdown；/note new [标题] 新建笔记；/note app 打开笔记本管理面板（目录树/编辑预览/搜索）',
  icon: '📝',
  argsHint: 'new|app|关键词',
  examples: [
    '/note —— 检索本地笔记（首项可进管理面板）',
    '/note app —— 打开笔记本管理面板（目录树 + 编辑预览 + 搜索）',
    '/note new 需求评审纪要 —— 新建笔记并打开编辑器',
  ],

  isAction(input: ParsedInput): boolean {
    return input.subcommand === 'new' || input.subcommand === 'app';
  },

  getPreview(input: ParsedInput): ActionPreviewCapsule | null {
    if (input.subcommand === 'app') {
      return {
        title: '打开笔记管理面板',
        detail: '左侧目录树（右键改名/移动/删除/复制/系统打开）｜右侧编辑与预览｜全文搜索',
        badge: '即时动作',
        hint: '按 Enter 回车打开管理面板',
      };
    }
    if (input.subcommand !== 'new') return null;
    const title = input.args.join(' ').trim() || '未命名笔记';
    return {
      title: '新建 Markdown 笔记',
      detail: `标题: "${title}"  |  位置: 文档/LiteNotes`,
      badge: '即时动作',
      hint: '按 Enter 回车创建并打开编辑器',
    };
  },

  async execute(input: ParsedInput): Promise<{ success: boolean; message: string }> {
    if (input.subcommand === 'app') {
      if (!isTauri()) {
        return { success: true, message: '[预览模式] 打开笔记管理面板' };
      }
      try {
        await ctx.call('open_manager', {});
        return { success: true, message: '已打开笔记管理面板' };
      } catch (err: any) {
        return { success: false, message: `打开管理面板失败: ${err?.message || err}` };
      }
    }
    if (input.subcommand !== 'new') {
      return { success: false, message: `未知子命令: ${input.subcommand}` };
    }
    const title = input.args.join(' ').trim();

    if (isTauri()) {
      try {
        const created = await ctx.call<CreatedNote>('create', { title: title || null });
        await ctx.call('open_editor', { path: created.path, title: created.title });
        return { success: true, message: `已创建笔记「${created.title}」并打开编辑器` };
      } catch (err: any) {
        return { success: false, message: `创建笔记失败: ${err?.message || err}` };
      }
    }
    return { success: true, message: `[预览模式] 将创建笔记: "${title || '未命名笔记'}"` };
  },

  async query(input: ParsedInput): Promise<PanelData> {
    const keyword = input.queryText.trim();

    if (isTauri()) {
      try {
        const notes = await ctx.call<NoteBackend[]>('search', {
          keyword: keyword || null,
        });

        const items: PanelItem[] = notes.map((note) => {
          const dateStr = note.mtime > 0
            ? new Date(note.mtime * 1000).toLocaleDateString()
            : '';
          const snippetDisplay = note.snippet
            ? note.snippet.slice(0, 70) + (note.snippet.length > 70 ? '...' : '')
            : '（暂无纯文本摘要）';

          return {
            id: note.path,
            title: note.title,
            description: `${snippetDisplay}  ${dateStr ? `· ${dateStr}` : ''}`,
            icon: '📄',
            badge: 'Markdown',
            metadata: { path: note.path, title: note.title },
          };
        });

        // 固定入口：笔记本管理面板（等同 /note app）
        items.unshift({
          id: '__note_open_manager__',
          title: '打开笔记管理面板',
          description: '目录树管理 · 编辑与预览 · 全文搜索',
          icon: '📔',
          badge: '面板',
          metadata: { openManager: true },
        });

        // 有关键词时首项直达"新建"：回车即创建同名笔记并打开编辑器
        if (keyword) {
          items.unshift({
            id: '__note_create_new__',
            title: `新建笔记「${keyword}」`,
            description: '回车创建 Markdown 文档并打开编辑器',
            icon: '✨',
            badge: '新建',
            metadata: { createNew: true, title: keyword },
          });
        }

        return {
          items,
          emptyText: '未检索到 Markdown 笔记，输入标题回车新建，或用 /note new [标题] 创建',
        };
      } catch (err) {
        console.warn('检索笔记失败:', err);
      }
    }

    // 浏览器预览回退
    return {
      items: [
        {
          id: 'note-1',
          title: 'LiteLauncher 快速入门指南.md',
          description: '欢迎使用 LiteLauncher！这是一款以搜索框为唯一交互入口的生产力启动器...',
          icon: '📄',
          badge: 'Markdown',
          metadata: { path: 'LiteLauncher 快速入门指南.md', title: 'LiteLauncher 快速入门指南' },
        },
        {
          id: 'note-2',
          title: '生产力与极简哲学.md',
          description: 'Command-First, Window-as-Context, Plugin-Driven...',
          icon: '📄',
          badge: 'Markdown',
          metadata: { path: '生产力与极简哲学.md', title: '生产力与极简哲学' },
        },
      ],
      emptyText: '未检索到笔记',
    };
  },

  async onSelect(item: PanelItem) {
    // 固定入口：打开笔记本管理面板
    if (item.metadata?.openManager) {
      if (isTauri()) {
        try {
          await ctx.call('open_manager', {});
          return { close: true };
        } catch (err) {
          console.error('打开笔记管理面板失败:', err);
        }
      } else {
        console.log('[预览环境] 打开笔记管理面板');
      }
      return;
    }

    // 面板"新建"入口：直接创建并打开编辑器
    if (item.metadata?.createNew) {
      const title = String(item.metadata?.title || item.title || '').trim();
      if (isTauri()) {
        try {
          const created = await ctx.call<CreatedNote>('create', { title: title || null });
          await ctx.call('open_editor', { path: created.path, title: created.title });
          return { close: true };
        } catch (err) {
          console.error('新建笔记失败:', err);
        }
      } else {
        console.log('[预览环境] 新建笔记:', title);
      }
      return;
    }

    const path = item.metadata?.path;
    const title = item.metadata?.title || item.title;
    if (!path) return;

    if (isTauri()) {
      try {
        await ctx.call('open_editor', { path, title });
        // 编辑器窗口已打开，声明壳层关闭启动器归还焦点
        return { close: true };
      } catch (err) {
        console.error('打开独立 Markdown 编辑器窗口失败:', err);
      }
    } else {
      console.log('[预览环境] 打开笔记编辑器:', title, path);
    }
  },
};
