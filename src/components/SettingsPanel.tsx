import { Component, For, createSignal, onMount, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { getPluginContext } from '@ll/sdk';
import { checkForUpdate, installPendingUpdate } from '../core/updater';
import { PopupFrame } from '@ll/ui';
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

/** 主热键状态：accel 是配置值，active 是实际生效值（冲突时可能是回退键） */
interface MainHotkeyState {
  accel: string;
  active: string;
  ok: boolean;
  fallback: boolean;
}

/** 宿主 `plugin_hotkeys` 返回的一行 manifest 热键 */
interface PluginHotkeyRow {
  pluginId: string;
  pluginName: string;
  hotkeyId: string;
  label: string;
  description: string;
  default: string;
  accel: string;
  scope: string;
  editable: boolean;
  enabled: boolean;
  overridden: boolean;
  registered: boolean;
  status: 'ok' | 'conflict' | 'disabled' | 'idle' | 'unset' | string;
  conflictWith?: string | null;
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
 * 外壳是通用基窗（PopupFrame 三段式，fill 定尺寸窗）：标题栏拖拽/关闭、
 * 右侧内容区滚动、状态栏放产品签名。内容按分类分左侧竖排 tab
 * （通用 / 外观 / 快捷键 / Python 环境 / 插件 / 关于），横版窗口（宽 > 高）。
 */
type SettingsTab = 'general' | 'appearance' | 'hotkeys' | 'python' | 'plugins' | 'about';

const TABS: { id: SettingsTab; icon: string; label: string }[] = [
  { id: 'general', icon: '⚙️', label: '通用' },
  { id: 'appearance', icon: '🎨', label: '外观' },
  { id: 'hotkeys', icon: '⌨️', label: '快捷键' },
  { id: 'python', icon: '🐍', label: 'Python 环境' },
  { id: 'plugins', icon: '🧩', label: '插件' },
  { id: 'about', icon: '💡', label: '关于' },
];

/** 展示用加速键：alt+shift+s → Alt + Shift + S */
function prettyAccel(accel: string): string {
  if (!accel) return '未设置';
  return accel
    .split('+')
    .map((part) => {
      if (part === 'ctrl') return 'Ctrl';
      if (part === 'alt') return 'Alt';
      if (part === 'shift') return 'Shift';
      if (part === 'meta') return 'Win';
      if (part === 'space') return 'Space';
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(' + ');
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

/** 键盘事件 → 规范 accel；不合法（无修饰键/纯修饰键）返回 null */
function accelFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('meta');
  if (mods.length === 0) return null;

  const key = e.key.toLowerCase();
  const isSingle = key.length === 1 && /[a-z0-9]/.test(key);
  const isFunction = /^f([1-9]|1[0-9]|2[0-4])$/.test(key);
  const isSpace = key === ' ';
  if (!isSingle && !isFunction && !isSpace) return null;
  return [...mods, isSpace ? 'space' : key].join('+');
}

export const SettingsPanel: Component = () => {
  const [tab, setTab] = createSignal<SettingsTab>('general');
  const [theme, setThemeSignal] = createSignal<Theme>('dark');
  const [info, setInfo] = createSignal<AppInfo | null>(null);
  const [plugins, setPlugins] = createSignal<PluginInfo[]>([]);

  // ── 通用 / 热键 ──
  const [mainHotkey, setMainHotkey] = createSignal<MainHotkeyState | null>(null);
  const [pluginHotkeys, setPluginHotkeys] = createSignal<PluginHotkeyRow[]>([]);
  const [autostart, setAutostart] = createSignal(false);
  const [recording, setRecording] = createSignal<string | null>(null);
  const [hotkeyBusy, setHotkeyBusy] = createSignal(false);
  const [hotkeyMsg, setHotkeyMsg] = createSignal<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [appsBusy, setAppsBusy] = createSignal(false);
  const [updateState, setUpdateState] = createSignal<{
    kind: 'idle' | 'checking' | 'latest' | 'available' | 'installing' | 'error';
    text: string;
    version?: string;
    body?: string;
  }>({ kind: 'idle', text: '尚未检查更新' });

  const checkUpdates = async () => {
    setUpdateState({ kind: 'checking', text: '正在检查更新…' });
    const result = await checkForUpdate();
    if (result.error) {
      setUpdateState({ kind: 'error', text: result.error });
    } else if (result.available && result.info) {
      setUpdateState({
        kind: 'available',
        text: `发现新版本 ${result.info.version}（当前 ${result.info.currentVersion}）`,
        version: result.info.version,
        body: result.info.body,
      });
    } else {
      setUpdateState({ kind: 'latest', text: '已是最新版本' });
    }
  };

  const installUpdate = async () => {
    setUpdateState((prev) => ({ ...prev, kind: 'installing', text: '准备安装…' }));
    try {
      await installPendingUpdate((text) => {
        setUpdateState((prev) => ({ ...prev, kind: 'installing', text }));
      });
    } catch (err) {
      setUpdateState({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const loadHotkeys = async () => {
    if (!isTauri()) return;
    try {
      const [main, list] = await Promise.all([
        invoke<MainHotkeyState>('get_main_hotkey'),
        invoke<PluginHotkeyRow[]>('plugin_hotkeys'),
      ]);
      setMainHotkey(main);
      setPluginHotkeys(list ?? []);
    } catch (err) {
      console.warn('读取热键配置失败:', err);
    }
  };

  const loadAutostart = async () => {
    if (!isTauri()) return;
    try {
      const state = await invoke<{ enabled: boolean }>('get_autostart');
      setAutostart(Boolean(state?.enabled));
    } catch (err) {
      console.warn('读取开机自启状态失败:', err);
    }
  };

  const toggleAutostart = async () => {
    if (!isTauri()) return;
    try {
      const next = !autostart();
      const state = await invoke<{ enabled: boolean }>('set_autostart', { enabled: next });
      setAutostart(Boolean(state?.enabled));
      setHotkeyMsg({ kind: 'ok', text: state?.enabled ? '已开启开机自启' : '已关闭开机自启' });
    } catch (err) {
      setHotkeyMsg({ kind: 'err', text: String(err) });
    }
  };

  /** 重新扫描应用目录（设置窗是壳层可信窗口，允许代表插件调用） */
  const rescanApps = async () => {
    if (!isTauri()) return;
    setAppsBusy(true);
    try {
      const res = await getPluginContext('apps').call<{ added?: number; total?: number; skipped?: boolean }>(
        'rescan',
        {},
      );
      if (res?.skipped) {
        setHotkeyMsg({ kind: 'err', text: '扫描正在进行中，请稍后再试' });
      } else {
        setHotkeyMsg({
          kind: 'ok',
          text: `扫描完成：新增 ${res?.added ?? 0} 个，共 ${res?.total ?? 0} 个应用`,
        });
      }
    } catch (err) {
      setHotkeyMsg({ kind: 'err', text: `扫描失败: ${err}` });
    } finally {
      setAppsBusy(false);
    }
  };

  const saveHotkey = async (target: string, accel: string) => {
    setHotkeyBusy(true);
    try {
      if (target === 'main') {
        await invoke('set_main_hotkey', { accel });
      } else {
        const [pluginId, hotkeyId] = target.split(':');
        await invoke('set_plugin_hotkey', { pluginId, hotkeyId, accel });
      }
      setHotkeyMsg({ kind: 'ok', text: `已更新为 ${prettyAccel(accel)}` });
      await loadHotkeys();
    } catch (err: any) {
      setHotkeyMsg({ kind: 'err', text: typeof err === 'string' ? err : String(err?.message || err) });
    } finally {
      setHotkeyBusy(false);
      setRecording(null);
    }
  };

  const onHotkeyKeyDown = (e: KeyboardEvent, target: string) => {
    if (recording() !== target) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(null);
      return;
    }
    const accel = accelFromEvent(e);
    if (!accel) {
      if (!MODIFIER_KEYS.has(e.key)) {
        setHotkeyMsg({ kind: 'err', text: '至少按住 Ctrl / Alt / Shift / Win 之一' });
      }
      return;
    }
    void saveHotkey(target, accel);
  };

  const resetPluginHotkey = async (row: PluginHotkeyRow) => {
    try {
      await invoke('reset_plugin_hotkey', { pluginId: row.pluginId, hotkeyId: row.hotkeyId });
      setHotkeyMsg({ kind: 'ok', text: `已恢复默认：${prettyAccel(row.default)}` });
      await loadHotkeys();
    } catch (err) {
      setHotkeyMsg({ kind: 'err', text: String(err) });
    }
  };

  const togglePluginHotkey = async (row: PluginHotkeyRow) => {
    try {
      await invoke('set_plugin_hotkey_enabled', {
        pluginId: row.pluginId,
        hotkeyId: row.hotkeyId,
        enabled: !row.enabled,
      });
      await loadHotkeys();
    } catch (err) {
      setHotkeyMsg({ kind: 'err', text: String(err) });
    }
  };

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
      void loadHotkeys();
      void loadAutostart();
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

  /** 重新观看首启引导（不重置已收录的应用与设置） */
  const openWelcome = async () => {
    if (!isTauri()) return;
    try {
      await invoke('open_welcome_window', { apps: null });
    } catch (err) {
      console.warn('打开欢迎引导失败:', err);
    }
  };

  const themeOptions: Array<{ value: Theme; icon: string; label: string; desc: string }> = [
    { value: 'light', icon: '☀️', label: '亮色', desc: '浅色界面，适合明亮环境' },
    { value: 'dark', icon: '🌙', label: '暗色', desc: '深色界面，默认主题' },
  ];

  return (
    <PopupFrame
      fill
      title="设置"
      onClose={() => void closeWindow()}
      footer={<span class="settings-footer">LiteLauncher — 以搜索框为唯一交互入口的生产力启动器</span>}
    >
      {/* ll-popup-fill-fixed：内容根钉成窗口高，左导航固定、只有右栏内容滚 */}
      <div class="settings-app ll-popup-fill-fixed">
        <nav class="settings-nav">
          <For each={TABS}>
            {(t) => (
              <button
                type="button"
                class="settings-nav-item"
                classList={{ active: tab() === t.id }}
                onClick={() => setTab(t.id)}
              >
                <span class="settings-nav-icon">{t.icon}</span>
                <span>{t.label}</span>
              </button>
            )}
          </For>
        </nav>

        <div class="settings-content">
          <Show when={tab() === 'general'}>
            <section class="settings-card">
              <h2>通用</h2>
              <div class="setting-row">
                <div class="setting-meta">
                  <div class="setting-title">开机自启</div>
                  <div class="setting-desc">登录系统后自动在托盘常驻，不弹主窗口</div>
                </div>
                <button class="ll-btn ghost" onClick={() => void toggleAutostart()}>
                  {autostart() ? '已开启' : '已关闭'}
                </button>
              </div>
              <div class="setting-row">
                <div class="setting-meta">
                  <div class="setting-title">应用目录</div>
                  <div class="setting-desc">重新扫描开始菜单与桌面，手动添加的条目不受影响</div>
                </div>
                <button class="ll-btn ghost" disabled={appsBusy()} onClick={() => void rescanApps()}>
                  {appsBusy() ? '扫描中…' : '重新扫描'}
                </button>
              </div>
              <div class="setting-row">
                <div class="setting-meta">
                  <div class="setting-title">欢迎引导</div>
                  <div class="setting-desc">回顾热键、应用目录与示例指令</div>
                </div>
                <button class="ll-btn ghost" onClick={() => void openWelcome()}>
                  重新观看
                </button>
              </div>
              <Show when={hotkeyMsg()}>
                {(m) => <p class={`settings-msg ${m().kind}`}>{m().text}</p>}
              </Show>
            </section>
          </Show>
          <Show when={tab() === 'hotkeys'}>
            <section class="settings-card">
              <h2>快捷键</h2>
              <div class="hotkey-row">
                <div class="hotkey-meta">
                  <div class="hotkey-title">唤起启动器</div>
                  <div class="hotkey-desc">
                    {mainHotkey()?.fallback
                      ? `配置的 ${prettyAccel(mainHotkey()!.accel)} 被占用，实际生效 ${prettyAccel(mainHotkey()!.active)}`
                      : '全局生效，冲突时可改成其他组合'}
                  </div>
                </div>
                <input
                  class="hotkey-input"
                  readOnly
                  disabled={hotkeyBusy()}
                  value={
                    recording() === 'main'
                      ? '按下组合键…'
                      : prettyAccel(mainHotkey()?.active || mainHotkey()?.accel || 'alt+space')
                  }
                  onClick={() => setRecording('main')}
                  onFocus={() => setRecording('main')}
                  onBlur={() => {
                    if (recording() === 'main') setRecording(null);
                  }}
                  onKeyDown={(e) => onHotkeyKeyDown(e, 'main')}
                />
              </div>

              <h3 class="hotkey-section-title">插件热键</h3>
              <Show
                when={pluginHotkeys().length > 0}
                fallback={<p class="settings-hint">还没有插件声明全局热键。</p>}
              >
                <For each={pluginHotkeys()}>
                  {(row) => {
                    const target = `${row.pluginId}:${row.hotkeyId}`;
                    return (
                      <div
                        class="hotkey-row"
                        classList={{ conflict: row.status === 'conflict', muted: !row.enabled }}
                      >
                        <div class="hotkey-meta">
                          <div class="hotkey-title">
                            {row.label} <span class="hotkey-plugin">{row.pluginName}</span>
                          </div>
                          <div class="hotkey-desc">
                            {row.status === 'conflict'
                              ? `冲突：被 ${row.conflictWith || '其他程序'} 占用`
                              : row.status === 'disabled'
                                ? '已停用'
                                : row.status === 'unset'
                                  ? '未设置按键'
                                  : row.status === 'idle'
                                    ? '未注册（重启后重试）'
                                    : `默认 ${prettyAccel(row.default)}`}
                          </div>
                        </div>
                        <input
                          class="hotkey-input"
                          readOnly
                          disabled={!row.editable || hotkeyBusy()}
                          value={
                            recording() === target
                              ? '按下组合键…'
                              : prettyAccel(row.accel || row.default)
                          }
                          onClick={() => row.editable && setRecording(target)}
                          onFocus={() => row.editable && setRecording(target)}
                          onBlur={() => {
                            if (recording() === target) setRecording(null);
                          }}
                          onKeyDown={(e) => onHotkeyKeyDown(e, target)}
                        />
                        <button
                          class="ll-btn ghost"
                          disabled={!row.editable}
                          onClick={() => void resetPluginHotkey(row)}
                        >
                          恢复默认
                        </button>
                        <button
                          class="ll-btn ghost"
                          onClick={() => void togglePluginHotkey(row)}
                        >
                          {row.enabled ? '停用' : '启用'}
                        </button>
                      </div>
                    );
                  }}
                </For>
              </Show>
              <Show when={hotkeyMsg()}>
                {(m) => <p class={`settings-msg ${m().kind}`}>{m().text}</p>}
              </Show>
              <p class="settings-hint">
                点击按键框后按下新组合键；至少包含 Ctrl / Alt / Shift / Win 之一，Esc 取消。
              </p>
            </section>
          </Show>
          <Show when={tab() === 'appearance'}>
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
          </Show>
          <Show when={tab() === 'python'}>
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
          </Show>
          <Show when={tab() === 'plugins'}>
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
          </Show>
          <Show when={tab() === 'about'}>
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
            <div class="setting-row">
              <div class="setting-meta">
                <div class="setting-title">软件更新</div>
                <div class="setting-desc">{updateState().text}</div>
              </div>
              <button
                class="ll-btn ghost"
                disabled={updateState().kind === 'checking' || updateState().kind === 'installing'}
                onClick={() => void checkUpdates()}
              >
                {updateState().kind === 'checking' ? '检查中…' : '检查更新'}
              </button>
              <Show when={updateState().kind === 'available'}>
                <button class="ll-btn ghost" onClick={() => void installUpdate()}>
                  下载并安装
                </button>
              </Show>
            </div>
            <Show when={updateState().body}>
              <p class="settings-hint">更新内容：{updateState().body}</p>
            </Show>
            <Show when={updateState().kind === 'error'}>
              <p class="settings-msg err">{updateState().text}</p>
            </Show>
            <div class="settings-actions">
              <button class="ll-btn ghost" onClick={() => void openWelcome()}>
                重新观看欢迎引导
              </button>
            </div>
          </section>
          </Show>
</div>
      </div>
    </PopupFrame>
  );
};
