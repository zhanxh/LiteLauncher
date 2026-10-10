import { invoke } from '@tauri-apps/api/core';

export type Theme = 'light' | 'dark';

const THEME_KEY = 'theme';
export const THEME_CHANGED_EVENT = 'theme-changed';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function parseTheme(v: unknown): Theme | null {
  return v === 'light' || v === 'dark' ? v : null;
}

/** 当前生效主题（由 documentElement 上的 data-theme 决定，缺省暗色） */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** 窗口加载时调用：从设置读取主题并应用 */
export async function initTheme(): Promise<Theme> {
  let theme: Theme = 'dark';
  if (isTauri()) {
    try {
      const v = await invoke<string | null>('get_setting', { key: THEME_KEY });
      theme = parseTheme(v) ?? 'dark';
    } catch (err) {
      console.warn('读取主题设置失败，使用默认暗色:', err);
    }
  }
  applyTheme(theme);
  return theme;
}

/** 切换主题：立即应用 + 持久化 + 广播给其他窗口 */
export async function setTheme(theme: Theme): Promise<void> {
  applyTheme(theme);
  if (isTauri()) {
    try {
      await invoke('set_setting', { key: THEME_KEY, value: theme });
    } catch (err) {
      console.error('保存主题设置失败:', err);
    }
    try {
      const { emit } = await import('@tauri-apps/api/event');
      await emit(THEME_CHANGED_EVENT, theme);
    } catch (err) {
      console.warn('广播主题变更失败:', err);
    }
  }
}

/** 监听其他窗口发起的主题切换（每个窗口加载时注册一次） */
export async function listenThemeChange(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<Theme>(THEME_CHANGED_EVENT, (event) => {
      const theme = parseTheme(event.payload);
      if (theme) applyTheme(theme);
    });
  } catch (err) {
    console.warn('监听主题变更失败:', err);
  }
}
