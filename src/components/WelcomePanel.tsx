/**
 * 首启欢迎引导（壳层视图，`index.html?view=welcome`）
 *
 * 三步：认识热键 → 确认应用目录 → 试一条指令。
 * 窗口由宿主 `open_welcome_window` 创建；本组件只负责展示与交互。
 *
 * 为什么"导入数量"从查询参数拿而不是自己调插件：
 * `plugin_call` 的调用者校验只放行 `main` 与 `<pluginId>-*` 窗口。欢迎窗
 * label 是 `welcome`，没有插件权限；由主窗口取好数字再带进来，比为了一个
 * 只读计数放宽整个权限模型更划算。
 */
import { Component, For, Show, createSignal } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PopupFrame } from '@ll/ui';
import '../styles/welcome.css';

const STEPS = 3;

const TRY_ITEMS: Array<{ text: string; label: string; hint: string }> = [
  { text: '/app wx', label: '/app wx', hint: '打开微信' },
  { text: '/shot ', label: '/shot', hint: '区域截图' },
  { text: '/cal today ', label: '/cal today', hint: '今天的日程' },
];

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const WelcomePanel: Component = () => {
  const params = new URLSearchParams(window.location.search);
  // -1 = 没带数量（从设置里重看）→ 不谎称"正在收录"
  const rawApps = params.get('apps');
  const appsCount = rawApps === null ? -1 : Number(rawApps) || 0;
  const [step, setStep] = createSignal(0);

  /** 关闭引导；带 command 时同时把示例命令填进主窗口 */
  const finish = async (command?: string) => {
    if (!isTauri()) return;
    try {
      if (command) {
        // 先发事件、再显示主窗：主窗的监听器一直在，顺序不影响结果
        await emitTo('main', 'welcome-command', { text: command });
      }
      await invoke('set_setting', { key: 'onboarding.version', value: '1' });
      if (command) {
        await invoke('show_main_window');
      }
    } catch (err) {
      console.warn('欢迎引导收尾失败:', err);
    }
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.warn('关闭欢迎窗口失败:', err);
    }
  };

  return (
    <PopupFrame
      fill
      title="欢迎使用 LiteLauncher"
      onClose={() => void finish()}
      footer={
        <div class="welcome-foot">
          <span class="welcome-step">
            第 {step() + 1} / {STEPS} 步
          </span>
          <span class="welcome-spacer" />
          <Show when={step() > 0}>
            <button class="welcome-btn ghost" onClick={() => setStep(step() - 1)}>
              上一步
            </button>
          </Show>
          <Show
            when={step() < STEPS - 1}
            fallback={
              <button class="welcome-btn" onClick={() => void finish()}>
                开始使用
              </button>
            }
          >
            <button class="welcome-btn ghost" onClick={() => void finish()}>
              跳过
            </button>
            <button class="welcome-btn" onClick={() => setStep(step() + 1)}>
              下一步
            </button>
          </Show>
        </div>
      }
    >
      <div class="welcome-app">
        <Show when={step() === 0}>
          <div class="welcome-hero">
            <div class="welcome-logo">⚡</div>
            <h1>一个搜索框，装下整个桌面</h1>
            <p>应用、日程、笔记、截图和取色，都不用离开键盘。</p>
          </div>

          <div class="welcome-keys">
            <div class="welcome-keyrow">
              <kbd>Alt</kbd>
              <span class="welcome-plus">+</span>
              <kbd>Space</kbd>
              <span class="welcome-keydesc">随时唤起 / 收起</span>
            </div>
            <div class="welcome-keyrow">
              <kbd>↑</kbd>
              <kbd>↓</kbd>
              <span class="welcome-keydesc">在结果间移动</span>
            </div>
            <div class="welcome-keyrow">
              <kbd>Enter</kbd>
              <span class="welcome-keydesc">执行当前项</span>
              <kbd>Esc</kbd>
              <span class="welcome-keydesc">清空 / 收起</span>
            </div>
          </div>

          <p class="welcome-note">如果 Alt + Space 被其他软件占用，可以按 Alt + X 作为备用热键。</p>
        </Show>

        <Show when={step() === 1}>
          <div class="welcome-hero">
            <div class="welcome-logo">🗂️</div>
            <h1>
              {appsCount > 0
                ? `已收录 ${appsCount} 个应用`
                : appsCount === 0
                  ? '正在收录你的应用'
                  : '应用目录已经就绪'}
            </h1>
            <p>首次启动会自动扫描开始菜单与桌面，不需要再手动添加。</p>
          </div>

          <ul class="welcome-list">
            <li>
              输入 <b>/app wx</b> 就能找到微信，<b>/app vsc</b> 对应 Visual Studio Code
            </li>
            <li>
              输入 <b>/</b> 查看全部指令，例如 <b>/shot</b>、<b>/cal</b>、<b>/clip</b>
            </li>
            <li>手动添加的应用永远优先于自动收录，不会被扫描覆盖</li>
          </ul>

          <Show when={appsCount === 0}>
            <p class="welcome-note">目录仍在后台收录，稍等几秒再试即可。</p>
          </Show>
        </Show>

        <Show when={step() === 2}>
          <div class="welcome-hero">
            <div class="welcome-logo">⌨️</div>
            <h1>先试一条</h1>
            <p>点击后会把命令填进主搜索框，按 Enter 执行。</p>
          </div>

          <div class="welcome-chips">
            <For each={TRY_ITEMS}>
              {(item) => (
                <button class="welcome-chip" onClick={() => void finish(item.text)}>
                  <b>{item.label}</b>
                  <span>{item.hint}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </PopupFrame>
  );
};
