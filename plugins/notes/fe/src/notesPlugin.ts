import { CommandPlugin, ParsedInput, PanelData, PanelItem } from '@ll/sdk';
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
  description: '搜索并浏览本地 Markdown 笔记文档（按回车弹出独立编辑窗口）',
  icon: '📝',

  isAction(_input: ParsedInput): boolean {
    return false;
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

        return {
          items,
          emptyText: '未检索到 Markdown 笔记，可在 LiteNotes 文件夹中创建 .md 文档',
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
