import { CommandPlugin, ParsedInput, ActionPreviewCapsule, PanelData, PanelItem } from '../types/command';
import { invoke } from '@tauri-apps/api/core';

interface AppItemBackend {
  id: string;
  name: string;
  path: string;
  icon: string;
  description: string;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 应用启动插件：/app
 */
export const appPlugin: CommandPlugin = {
  id: 'app',
  trigger: '/app',
  name: '应用启动器',
  description: '快速检索与启动应用；支持 /app add "名称" "路径"',
  icon: '🚀',

  isAction(input: ParsedInput): boolean {
    return input.subcommand === 'add';
  },

  getPreview(input: ParsedInput): ActionPreviewCapsule | null {
    if (input.subcommand !== 'add') return null;

    const name = input.args[0] || '（请输入应用名称）';
    const path = input.args[1] || '（请输入可执行路径）';

    return {
      title: '添加应用捷径',
      detail: `应用名: "${name}"  |  路径: "${path}"`,
      badge: '即时动作',
      hint: '按 Enter 回车保存快捷启动',
    };
  },

  async execute(input: ParsedInput): Promise<{ success: boolean; message: string }> {
    const name = input.args[0]?.trim();
    const path = input.args[1]?.trim();

    if (!name || !path) {
      return {
        success: false,
        message: '参数不完整，请使用：/app add "名称" "可执行路径"',
      };
    }

    if (isTauri()) {
      try {
        await invoke('add_custom_app', { name, path });
        return { success: true, message: `已保存应用快捷方式: ${name}` };
      } catch (err: any) {
        return { success: false, message: `保存失败: ${err?.message || err}` };
      }
    }

    return { success: true, message: `[预览模式] 已添加应用: ${name}` };
  },

  async query(input: ParsedInput): Promise<PanelData> {
    const keyword = input.queryText.trim();

    if (isTauri()) {
      try {
        const apps = await invoke<AppItemBackend[]>('list_applications', {
          keyword: keyword || null,
        });

        const items: PanelItem[] = apps.map((app) => ({
          id: app.id,
          title: app.name,
          description: app.description,
          icon: app.icon || '🚀',
          badge: '应用',
          metadata: { path: app.path },
        }));

        return {
          items,
          emptyText: '未检索到应用，可输入 /app add "名称" "路径" 手动添加',
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

  async onSelect(item: PanelItem): Promise<void> {
    const path = item.metadata?.path;
    if (!path) return;

    if (isTauri()) {
      try {
        await invoke('launch_application', { path });
      } catch (err) {
        console.error('启动应用程序失败:', err);
      }
    } else {
      console.log('[预览环境] 尝试启动程序:', path);
    }
  },
};
