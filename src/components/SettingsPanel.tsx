import { Component, createSignal, onMount, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { currentTheme, initTheme, listenThemeChange, setTheme, type Theme } from '../theme';
import '../styles/settings.css';

interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
  db_path: string;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const OS_LABELS: Record<string, string> = {
  linux: 'Linux',
  windows: 'Windows',
  macos: 'macOS',
};

/**
 * 应用设置面板（/setting 打开的独立窗口）
 * 外观：亮色/暗色皮肤切换（全窗口即时生效并持久化）；关于：版本信息
 */
export const SettingsPanel: Component = () => {
  const [theme, setThemeSignal] = createSignal<Theme>('dark');
  const [info, setInfo] = createSignal<AppInfo | null>(null);

  onMount(() => {
    void initTheme().then((t) => {
      setThemeSignal(t);
      return listenThemeChange().then(() => {
        // 其他窗口切换主题后同步本地选中态
        setThemeSignal(currentTheme());
      });
    });

    if (isTauri()) {
      invoke<AppInfo>('get_app_info')
        .then(setInfo)
        .catch((err) => console.warn('读取应用信息失败:', err));
    }
  });

  const pickTheme = (t: Theme) => {
    setThemeSignal(t);
    void setTheme(t);
  };

  const closeWindow = async () => {
    if (isTauri()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    }
  };

  const themeOptions: Array<{ value: Theme; icon: string; label: string; desc: string }> = [
    { value: 'light', icon: '☀️', label: '亮色', desc: '浅色界面，适合明亮环境' },
    { value: 'dark', icon: '🌙', label: '暗色', desc: '深色界面，默认主题' },
  ];

  return (
    <div class="settings-app">
      <header class="settings-header">
        <h1>设置</h1>
        <button class="ll-btn ghost" onClick={() => void closeWindow()}>✕ 关闭</button>
      </header>

      <section class="settings-card">
        <h2>外观</h2>
        <div class="theme-options">
          {themeOptions.map((opt) => (
            <button
              class="theme-option"
              classList={{ selected: theme() === opt.value }}
              onClick={() => pickTheme(opt.value)}
            >
              <span class="theme-icon">{opt.icon}</span>
              <span class="theme-label">{opt.label}</span>
              <span class="theme-desc">{opt.desc}</span>
              <Show when={theme() === opt.value}>
                <span class="theme-check">✓</span>
              </Show>
            </button>
          ))}
        </div>
        <p class="settings-hint">切换后立即生效并同步到所有窗口（启动器、笔记编辑、待办面板与提醒弹窗）。</p>
      </section>

      <section class="settings-card">
        <h2>关于</h2>
        <Show when={info()} fallback={<p class="settings-hint">（浏览器预览模式，启动应用后显示完整信息）</p>}>
          {(i) => (
            <div class="info-grid">
              <div class="info-row">
                <span class="info-key">应用</span>
                <span class="info-val">{i().name}</span>
              </div>
              <div class="info-row">
                <span class="info-key">版本</span>
                <span class="info-val version">{i().version}</span>
              </div>
              <div class="info-row">
                <span class="info-key">运行平台</span>
                <span class="info-val">
                  {OS_LABELS[i().os] ?? i().os} · {i().arch}
                </span>
              </div>
              <div class="info-row">
                <span class="info-key">数据目录</span>
                <span class="info-val mono" title={i().db_path}>{i().db_path}</span>
              </div>
            </div>
          )}
        </Show>
      </section>

      <p class="settings-footer">LiteLauncher — 以搜索框为唯一交互入口的生产力启动器</p>
    </div>
  );
};
