import { CommandPlugin, ParsedInput, ActionPreviewCapsule, PanelData } from '../types/command';
import { invoke } from '@tauri-apps/api/core';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 应用设置指令插件：/setting
 */
export const settingPlugin: CommandPlugin = {
  id: 'setting',
  trigger: '/setting',
  name: '应用设置',
  description: '打开应用设置面板：亮色/暗色皮肤切换、版本信息',
  icon: '⚙️',

  isAction(_input: ParsedInput): boolean {
    return true;
  },

  getPreview(_input: ParsedInput): ActionPreviewCapsule | null {
    return {
      title: '打开应用设置',
      detail: '亮色 / 暗色皮肤切换 · 版本信息',
      badge: '即时动作',
      hint: '按 Enter 回车打开设置面板',
    };
  },

  async execute(): Promise<{ success: boolean; message: string }> {
    if (isTauri()) {
      try {
        await invoke('open_settings_window');
        return { success: true, message: '已打开设置面板' };
      } catch (err: any) {
        return { success: false, message: `打开设置面板失败: ${err?.message || err}` };
      }
    }
    return { success: true, message: '[预览模式] 打开应用设置面板' };
  },

  async query(_input: ParsedInput): Promise<PanelData> {
    return {
      items: [
        {
          id: 'open-settings',
          title: '打开应用设置',
          description: '亮色/暗色皮肤切换 · 版本信息',
          icon: '⚙️',
          badge: '设置',
        },
      ],
      emptyText: '输入 /setting 回车打开设置面板',
    };
  },

  async onSelect(): Promise<void> {
    if (isTauri()) {
      try {
        await invoke('open_settings_window');
      } catch (err) {
        console.error('打开设置面板失败:', err);
      }
    }
  },
};
