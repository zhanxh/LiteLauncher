import { CommandPlugin, ParsedInput, ActionPreviewCapsule, PanelData, PanelItem, PanelAction, SearchProvider } from '@ll/sdk';
import { getPluginContext } from '@ll/sdk';

// 经宿主统一通道访问 app 插件后端
const ctx = getPluginContext('apps');

/** 应用条目的次级动作：定位到文件夹 / 复制路径（后者不关窗，便于连续取用） */
const APP_ACTIONS: PanelAction[] = [
  { id: 'reveal', label: '打开所在文件夹', accel: 'ctrl+enter' },
  { id: 'copy-path', label: '复制路径', accel: 'shift+enter' },
];

interface AppItemBackend {
  id: string;
  name: string;
  path: string;
  icon: string;
  description: string;
  /** 宿主按 source 给的来源徽标：已安装 / 自定义（旧后端没有该字段） */
  badge?: string;
}

interface SystemAppItem {
  name: string;
  path: string;
  detail: string;
  kind: 'desktop' | 'exec' | 'startmenu' | string;
  added: boolean;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const KIND_ICONS: Record<string, string> = {
  desktop: '🚀',
  exec: '⚙️',
  startmenu: '🖥️',
};

function toCandidateItem(app: SystemAppItem): PanelItem {
  return {
    id: `sys-${app.kind}-${app.path}`,
    title: app.name,
    description: app.detail,
    icon: KIND_ICONS[app.kind] || '🚀',
    badge: app.added ? '✅ 已添加' : '➕ 未添加',
    metadata: { isAppAdd: true, name: app.name, path: app.path, added: app.added },
  };
}

/**
 * 应用启动插件：/app
 * add 模式下根据输入实时列出系统应用候选（桌面应用/可执行命令/开始菜单），
 * 点击候选直接添加；列表中以徽标区分已添加/未添加
 */
export const appPlugin: CommandPlugin = {
  id: 'app',
  trigger: '/app',
  name: '应用启动器',
  description:
    '应用检索与启动：已装应用会自动收录，直接输入名称或拼音首字母即可；/app add 名称 可补充未收录的程序，/app rescan 重新扫描。',
  icon: '🚀',
  argsHint: '[关键字] | add 名称 [路径] | rescan',
  examples: ['/app wx', '/app add 微信', '/app rescan'],
  showItemsInActionMode: true,

  isAction(input: ParsedInput): boolean {
    return input.subcommand === 'add' || input.subcommand === 'rescan';
  },

  getPreview(input: ParsedInput): ActionPreviewCapsule | null {
    if (input.subcommand === 'rescan') {
      return {
        title: '重新扫描已安装应用',
        detail: '扫描开始菜单与桌面，已添加的自定义条目不会被覆盖',
        badge: '即时动作',
        hint: 'Enter 开始扫描',
      };
    }
    if (input.subcommand !== 'add') return null;

    const name = input.args[0] || '（请输入应用名称）';
    const path = input.args[1] || '（可省略，回车自动匹配）';

    return {
      title: '添加应用捷径',
      detail: `应用名: "${name}"  |  路径: "${path}"`,
      badge: '即时动作',
      hint: 'Enter 添加；或点击下方候选直接加入',
    };
  },

  async execute(input: ParsedInput): Promise<{ success: boolean; message: string }> {
    if (input.subcommand === 'rescan') {
      if (!isTauri()) {
        return { success: true, message: '[预览模式] 已重新扫描应用' };
      }
      try {
        const res = await ctx.call<{ added: number; updated: number; total: number; skipped?: boolean }>(
          'rescan',
          {},
        );
        if (res?.skipped) {
          return { success: false, message: '扫描正在进行中，请稍后再试' };
        }
        return {
          success: true,
          message: `扫描完成：新增 ${res?.added ?? 0} 个，共 ${res?.total ?? 0} 个应用`,
        };
      } catch (err: any) {
        return { success: false, message: `扫描失败: ${err?.message || err}` };
      }
    }

    const name = input.args[0]?.trim();
    const path = input.args[1]?.trim();

    // 仅输入名称：唯一匹配直接添加；多个/零个提示从候选选择
    if (name && !path) {
      if (isTauri()) {
        try {
          const apps = await ctx.call<SystemAppItem[]>('search_system', {
            keyword: name,
            limit: null,
          });
          if (apps.length === 1) {
            const app = apps[0];
            if (app.added) {
              return { success: false, message: `"${app.name}" 已在应用列表中，无需重复添加` };
            }
            await ctx.call('add', { name: app.name, path: app.path });
            return { success: true, message: `已添加应用: ${app.name}` };
          }
          if (apps.length > 1) {
            return { success: false, message: `找到 ${apps.length} 个匹配，请点击下方候选选择` };
          }
          return {
            success: false,
            message: '未找到匹配的系统应用，可补全路径：/app add "名称" "可执行路径"',
          };
        } catch (err: any) {
          return { success: false, message: `搜索系统应用失败: ${err?.message || err}` };
        }
      }
      return { success: true, message: `[预览模式] 已添加应用: ${name}` };
    }

    if (!name || !path) {
      return {
        success: false,
        message: '请输入应用名称，或从下方系统应用候选中选择',
      };
    }

    if (isTauri()) {
      try {
        await ctx.call('add', { name, path });
        return { success: true, message: `已保存应用快捷方式: ${name}` };
      } catch (err: any) {
        return { success: false, message: `保存失败: ${err?.message || err}` };
      }
    }

    return { success: true, message: `[预览模式] 已添加应用: ${name}` };
  },

  async query(input: ParsedInput): Promise<PanelData> {
    // add 模式：系统应用候选（含已添加/未添加状态）
    if (input.subcommand === 'add') {
      const keyword = input.args.join(' ').trim();
      if (isTauri()) {
        try {
          const apps = await ctx.call<SystemAppItem[]>('search_system', {
            keyword: keyword || null,
            limit: null,
          });
          return {
            items: apps.map(toCandidateItem),
            emptyText: '未找到匹配的系统应用，可直接输入 /app add "名称" "可执行路径"',
          };
        } catch (err) {
          console.warn('搜索系统应用失败:', err);
        }
      }

      // 浏览器预览回退：展示候选与状态徽标的渲染样式
      return {
        items: [
          { id: 's1', title: 'Visual Studio Code', description: '/usr/share/code/code', icon: '🚀', badge: '✅ 已添加', metadata: { isAppAdd: true, name: 'Visual Studio Code', path: 'code', added: true } },
          { id: 's2', title: '终端', description: 'gnome-terminal', icon: '🚀', badge: '➕ 未添加', metadata: { isAppAdd: true, name: '终端', path: 'gnome-terminal', added: false } },
          { id: 's3', title: 'ls', description: '/bin/ls', icon: '⚙️', badge: '➕ 未添加', metadata: { isAppAdd: true, name: 'ls', path: '/bin/ls', added: false } },
        ],
        emptyText: '未找到匹配的系统应用',
      };
    }

    // 列表模式：已保存的应用快捷方式
    const keyword = input.queryText.trim();
    if (isTauri()) {
      try {
        const apps = await ctx.call<AppItemBackend[]>('list', {
          keyword: keyword || null,
        });

        const items: PanelItem[] = apps.map((app) => ({
          id: app.id,
          title: app.name,
          description: app.description,
          icon: app.icon || '🚀',
          badge: app.badge || '应用',
          actions: APP_ACTIONS,
          metadata: { path: app.path },
        }));

        return {
          items,
          emptyText: '未检索到应用，可输入 /app add 名称 从系统应用中添加',
        };
      } catch (err) {
        console.warn('读取应用列表失败:', err);
      }
    }

    // 浏览器预览回退数据（按当前运行平台展示示例）
    const isMac = /Mac|darwin/i.test(navigator.userAgent);
    const isLinux = /Linux/i.test(navigator.userAgent) && !isMac;
    const previewApps = isMac
      ? [
          { id: '1', title: 'Visual Studio Code', description: '应用: /Applications/Visual Studio Code.app', icon: '💻', badge: '应用', metadata: { path: '/Applications/Visual Studio Code.app' } },
          { id: '2', title: 'Google Chrome', description: '应用: /Applications/Google Chrome.app', icon: '🌐', badge: '应用', metadata: { path: '/Applications/Google Chrome.app' } },
          { id: '3', title: 'Terminal', description: '应用: /System/Applications/Utilities/Terminal.app', icon: '⚡', badge: '应用', metadata: { path: '/System/Applications/Utilities/Terminal.app' } },
        ]
      : isLinux
        ? [
            { id: '1', title: 'Visual Studio Code', description: '可执行程序: code', icon: '💻', badge: '应用', metadata: { path: 'code' } },
            { id: '2', title: 'Google Chrome', description: '可执行程序: google-chrome', icon: '🌐', badge: '应用', metadata: { path: 'google-chrome' } },
            { id: '3', title: '终端', description: '可执行程序: x-terminal-emulator', icon: '⚡', badge: '应用', metadata: { path: 'x-terminal-emulator' } },
          ]
        : [
            { id: '1', title: 'Visual Studio Code', description: '可执行程序: code.exe', icon: '💻', badge: '应用', metadata: { path: 'code.exe' } },
            { id: '2', title: 'Google Chrome', description: '可执行程序: chrome.exe', icon: '🌐', badge: '应用', metadata: { path: 'chrome.exe' } },
            { id: '3', title: 'Windows Terminal', description: '可执行程序: wt.exe', icon: '⚡', badge: '应用', metadata: { path: 'wt.exe' } },
          ];
    return {
      items: previewApps,
      emptyText: '未检索到应用',
    };
  },

  /** 面板项选中：候选添加（保持启动器可见）或启动应用（关窗）——原 App.tsx 特判迁入此处 */
  async onSelect(item: PanelItem, actionId?: string) {
    // 系统应用候选：添加为快捷方式（不隐藏启动器，便于连续添加）
    if (item.metadata?.isAppAdd) {
      const { name, path, added } = item.metadata as { name: string; path: string; added?: boolean };
      if (added) {
        return { toast: `"${name}" 已在应用列表中` };
      }
      if (isTauri()) {
        try {
          await ctx.call('add', { name, path });
          return { toast: `已添加: ${name}`, refresh: true };
        } catch (err: any) {
          return { toast: `添加失败: ${err?.message || err}` };
        }
      }
      return { toast: `[预览] 添加应用: ${name} → ${path}` };
    }

    // 应用快捷方式启动 / 次级动作
    const path = item.metadata?.path;
    if (!path) return;
    return await launchApp(item, actionId);
  },
};

// ─────────────────── SearchProviders（裸文本搜索扩展点）───────────────────

/** 后端应用行 → 面板项（本地检索与空状态推荐共用） */
function toPanelItem(a: AppItemBackend): PanelItem {
  return {
    id: `app-${a.id}`,
    title: a.name,
    description: a.description,
    icon: a.icon || '🚀',
    badge: a.badge || '启动应用',
    actions: APP_ACTIONS,
    metadata: { path: a.path },
  };
}

/** 启动应用（两条 provider 路径共用，避免行为漂移） */
async function launchApp(item: PanelItem, actionId?: string) {
  const path = item.metadata?.path;
  if (!path || !isTauri()) return { close: true } as const;
  if (actionId === 'copy-path') {
    return { copy: path, toast: '路径已复制' };
  }
  if (actionId === 'reveal') {
    try {
      await ctx.call('reveal', { path });
      return { close: true, toast: '已在文件夹中定位' };
    } catch (err: any) {
      return { toast: `打开文件夹失败: ${err?.message || err}` };
    }
  }
  try {
    await ctx.call('launch', { path });
    return { close: true, toast: `已启动: ${item.title}` };
  } catch (err: any) {
    return { toast: `启动失败: ${err?.message || err}` };
  }
}

/** 本地应用快捷方式检索 */
export const appsLocalProvider: SearchProvider = {
  id: 'apps.local',
  priority: 10,

  async search(raw: string): Promise<PanelItem[]> {
    if (!isTauri()) return [];
    try {
      const apps = await ctx.call<AppItemBackend[]>('list', { keyword: raw });
      return apps.map(toPanelItem);
    } catch {
      return [];
    }
  },

  onSelect: launchApp,
};

/**
 * 空状态推荐：不需要关键词就能给出的「常用应用」入口。
 *
 * 声明 `searchOnEmpty` 后壳层会在输入框为空时调用；数据源是后端的
 * launch_count / last_used_at 排序，用户用得越多越靠前。
 */
export const appsSuggestProvider: SearchProvider = {
  id: 'apps.suggest',
  priority: 0,
  searchOnEmpty: true,

  async search(): Promise<PanelItem[]> {
    if (!isTauri()) return [];
    try {
      const apps = await ctx.call<AppItemBackend[]>('suggest', { limit: 6 });
      return apps.map((a) => ({ ...toPanelItem(a), group: '常用应用' }));
    } catch {
      return [];
    }
  },

  onSelect: launchApp,
};

/** 系统命令直接运行兜底 */
export const appsCliProvider: SearchProvider = {
  id: 'apps.cli',
  priority: 20,

  async search(raw: string): Promise<PanelItem[]> {
    return [
      {
        id: `cli-${raw}`,
        title: `运行系统命令: "${raw}"`,
        description: `调用系统环境执行 "${raw}" 命令或程序`,
        icon: '⚡',
        badge: '系统运行',
        metadata: { command: raw },
      },
    ];
  },

  async onSelect(item: PanelItem) {
    const command = item.metadata?.command as string | undefined;
    if (!command || !isTauri()) return { close: true };
    try {
      await ctx.call('launch', { path: command });
      return { close: true, toast: `已执行: ${command}` };
    } catch {
      // 启动失败由用户改选 web 搜索项，不在 cli 项上打开浏览器
      return { toast: `执行失败: ${command}` };
    }
  },
};

/** 网络搜索兜底 */
export const appsWebProvider: SearchProvider = {
  id: 'apps.web',
  priority: 90,

  async search(raw: string): Promise<PanelItem[]> {
    return [
      {
        id: 'web-search',
        title: `在浏览器中搜索 "${raw}"`,
        description: '调用默认搜索引擎检索互联网',
        icon: '🌐',
        badge: '网络搜索',
        metadata: { query: raw },
      },
    ];
  },

  async onSelect(item: PanelItem) {
    const q = item.metadata?.query || '';
    if (q) {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
      window.open(url, '_blank');
    }
    return { close: true, clearInput: true };
  },
};
