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

/** 宿主 plugin_list 返回的插件信息（ll-host commands.rs） */
interface PluginInfo {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  trigger: string;
  enabled: boolean;
  permissions: string[];
}

/** 宿主 python_env 返回的当前 Python 环境状态 */
interface PyEnv {
  configured: string | null;
  path: string | null;
  version: string | null;
  source: string;
  available: boolean;
  error: string | null;
}

/** 自动检测到的解释器候选 */
interface PyCandidate {
  path: string;
  version: string | null;
  source: string;
  valid: boolean;
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
  const [plugins, setPlugins] = createSignal<PluginInfo[]>([]);

  // ── Python 环境（sysinfo 等外部插件的 sidecar 运行时）──
  const [pyEnv, setPyEnv] = createSignal<PyEnv | null>(null);
  const [pyInput, setPyInput] = createSignal('');
  const [pyCandidates, setPyCandidates] = createSignal<PyCandidate[]>([]);
  const [pyBusy, setPyBusy] = createSignal(false);
  const [pyMsg, setPyMsg] = createSignal<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const loadPyEnv = async () => {
    if (!isTauri()) return;
    try {
      const env = await invoke<PyEnv>('get_python_env');
      setPyEnv(env);
      setPyInput(env.configured ?? '');
    } catch (err) {
      console.warn('读取 Python 环境失败:', err);
    }
  };

  const applyPyPath = async (path: string) => {
    if (!isTauri()) {
      setPyMsg({ kind: 'err', text: '浏览器预览模式不支持配置，请启动应用后操作' });
      return;
    }
    setPyBusy(true);
    setPyMsg(null);
    try {
      const env = await invoke<PyEnv>('set_python_path', { path });
      setPyEnv(env);
      setPyInput(env.configured ?? '');
      if (path.trim()) {
        setPyMsg({ kind: 'ok', text: `已应用：${env.version ?? '解释器'}（${env.path}）` });
      } else {
        setPyMsg({
          kind: env.available ? 'ok' : 'err',
          text: env.available ? `已清除配置，回落到自动探测：${env.path}` : '已清除配置，但自动探测未找到解释器',
        });
      }
    } catch (err) {
      setPyMsg({ kind: 'err', text: String(err) });
    } finally {
      setPyBusy(false);
    }
  };

  const detectPy = async () => {
    if (!isTauri()) return;
    setPyBusy(true);
    setPyMsg(null);
    try {
      const list = await invoke<PyCandidate[]>('detect_python_path');
      setPyCandidates(list);
      const usable = list.filter((c) => c.valid);
      setPyMsg({
        kind: usable.length ? 'ok' : 'err',
        text: usable.length ? `检测到 ${usable.length} 个可用解释器，点击即可应用` : '未检测到可用的 Python 解释器，请手动填写路径',
      });
    } catch (err) {
      setPyMsg({ kind: 'err', text: String(err) });
    } finally {
      setPyBusy(false);
    }
  };

  const pickPyFile = async () => {
    if (!isTauri()) return;
    setPyBusy(true);
    setPyMsg(null);
    try {
      const picked = await invoke<string | null>('pick_python_file');
      if (picked) {
        setPyInput(picked);
        await applyPyPath(picked);
      }
    } catch (err) {
      setPyMsg({ kind: 'err', text: String(err) });
    } finally {
      setPyBusy(false);
    }
  };

  const refreshPlugins = () => {
    if (isTauri()) {
      invoke<PluginInfo[]>('plugin_list')
        .then(setPlugins)
        .catch((err) => console.warn('读取插件列表失败:', err));
    }
  };

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
      void loadPyEnv();
    }
    refreshPlugins();
  });

  const togglePlugin = async (p: PluginInfo) => {
    try {
      await invoke('plugin_set_enabled', { pluginId: p.id, enabled: !p.enabled });
      refreshPlugins();
    } catch (err) {
      console.warn('切换插件状态失败:', err);
    }
  };

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
        <h2>Python 环境</h2>

        <div class="py-status">
          <span class="py-badge" classList={{ ok: !!pyEnv()?.available, bad: !pyEnv()?.available }}>
            {pyEnv() ? (pyEnv()!.available ? '可用' : '不可用') : '检测中'}
          </span>
          <div class="py-status-main">
            <div class="py-path mono">{pyEnv()?.path ?? '（未找到解释器）'}</div>
            <div class="py-meta">
              {pyEnv()?.version ?? '—'} · 来源 {pyEnv()?.source ?? '—'}
            </div>
          </div>
        </div>

        <Show when={pyEnv()?.error}>
          {(e) => <p class="py-error">{e()}</p>}
        </Show>

        <div class="py-row">
          <input
            class="py-input mono"
            spellcheck={false}
            placeholder="例如 D:\tools\Miniconda3\python.exe（留空则自动探测）"
            value={pyInput()}
            onInput={(e) => setPyInput(e.currentTarget.value)}
          />
        </div>

        <div class="py-actions">
          <button class="ll-btn" disabled={pyBusy()} onClick={() => void applyPyPath(pyInput())}>
            保存并应用
          </button>
          <button class="ll-btn ghost" disabled={pyBusy()} onClick={() => void detectPy()}>
            自动检测
          </button>
          <button class="ll-btn ghost" disabled={pyBusy()} onClick={() => void pickPyFile()}>
            浏览…
          </button>
          <button class="ll-btn ghost" disabled={pyBusy()} onClick={() => void applyPyPath('')}>
            清除
          </button>
        </div>

        <Show when={pyMsg()}>
          {(m) => <p class="py-msg" classList={{ ok: m().kind === 'ok', err: m().kind === 'err' }}>{m().text}</p>}
        </Show>

        <Show when={pyCandidates().length > 0}>
          <div class="py-candidates">
            {pyCandidates().map((c) => (
              <button class="py-candidate" onClick={() => void applyPyPath(c.path)}>
                <span class="py-cand-icon">{c.valid ? '🐍' : '⚠️'}</span>
                <span class="py-cand-main">
                  <span class="py-cand-path mono">{c.path}</span>
                  <span class="py-cand-meta">
                    {c.version ?? '不可用'} · {c.source}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Show>

        <p class="settings-hint">
          sysinfo 等外部插件以 Python 作为运行时。保存后立刻生效——已在运行的插件进程会被重启并按新解释器
          重建，无需退出应用。也可设置环境变量 <span class="mono">LLP_PYTHON</span> 作为便携部署的替代方案。
        </p>
      </section>

      <section class="settings-card">
        <h2>插件</h2>
        <Show
          when={plugins().length > 0}
          fallback={<p class="settings-hint">（浏览器预览模式，启动应用后显示插件列表）</p>}
        >
          <div class="plugin-list">
            {plugins().map((p) => (
              <div class="plugin-row">
                <div class="plugin-meta">
                  <span class="plugin-name">
                    {p.name} <span class="plugin-trigger mono">{p.trigger}</span>
                  </span>
                  <span class="plugin-desc">
                    v{p.version} · LPS {p.apiVersion} · 权限 {p.permissions.join('/') || '无'}
                  </span>
                </div>
                <button
                  class="ll-btn ghost plugin-toggle"
                  classList={{ 'is-on': p.enabled }}
                  onClick={() => void togglePlugin(p)}
                >
                  {p.enabled ? '已启用' : '已禁用'}
                </button>
              </div>
            ))}
          </div>
        </Show>
        <p class="settings-hint">禁用的插件保留全部本地数据，可随时重新启用。</p>
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
