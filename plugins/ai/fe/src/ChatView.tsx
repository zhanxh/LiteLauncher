import { Component, For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { getPluginContext } from '@ll/sdk';
import { Select as KSelect, Content as KSelectContent, Item as KSelectItem, Trigger as KSelectTrigger, Value as KSelectValue } from '@kobalte/core/select';
import './chat.css';

const ctx = getPluginContext('ai');

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

interface PluginEventPayload {
  pluginId: string;
  event: 'delta' | 'done' | 'error';
  payload: { id: string; delta?: string; message?: string; aborted?: boolean };
}

/** AI 对话窗口（/ai 打开）：密钥设置、流式渲染、中断 */
export const ChatView: Component = () => {
  const [messages, setMessages] = createSignal<Msg[]>([]);
  const [hasKey, setHasKey] = createSignal<boolean | null>(null);
  const [keyInput, setKeyInput] = createSignal('');
  const [config, setConfig] = createSignal<{
    model: string;
    baseUrl: string;
    models?: string[];
  } | null>(null);
  const [customModel, setCustomModel] = createSignal(false);
  const [showConfig, setShowConfig] = createSignal(false);
  const [streaming, setStreaming] = createSignal(false);
  const [error, setError] = createSignal('');
  const [input, setInput] = createSignal('');
  let listRef: HTMLDivElement | undefined;

  const scrollBottom = () => {
    requestAnimationFrame(() => listRef?.scrollTo({ top: listRef.scrollHeight }));
  };

  onMount(async () => {
    if (!isTauri()) {
      setHasKey(false);
      setMessages([
        { role: 'assistant', content: '浏览器预览模式：AI 对话需要 Tauri 桌面环境。' },
      ]);
      return;
    }

    setHasKey(
      await ctx.call<boolean>('has_api_key').catch(() => false),
    );
    const cfg = await ctx
      .call<{ model: string; baseUrl: string }>('get_config')
      .catch(() => null);
    if (cfg) setConfig(cfg);

    // 流式事件：宿主以 plugin-event 广播，按 pluginId 过滤
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<PluginEventPayload>('plugin-event', (e) => {
      const p = e.payload;
      if (p.pluginId !== 'ai') return;
      if (p.event === 'delta' && p.payload.delta) {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.role === 'assistant') {
            copy[copy.length - 1] = { ...last, content: last.content + p.payload.delta };
          }
          return copy;
        });
        scrollBottom();
      } else if (p.event === 'done') {
        setStreaming(false);
      } else if (p.event === 'error') {
        setStreaming(false);
        setError(p.payload.message ?? '请求失败');
      }
    });
    onCleanup(unlisten);

    const prompt = new URLSearchParams(window.location.search).get('prompt');
    if (prompt) void send(prompt);
  });

  const saveKey = async () => {
    const key = keyInput().trim();
    if (!key) return;
    try {
      await ctx.call('set_api_key', { key });
      setKeyInput('');
      setHasKey(true);
    } catch (err: any) {
      setError(`保存失败: ${err?.message || err}`);
    }
  };

  const saveConfig = async () => {
    const cfg = config();
    if (!cfg) return;
    try {
      await ctx.call('set_config', { model: cfg.model, baseUrl: cfg.baseUrl });
      setShowConfig(false);
    } catch (err: any) {
      setError(`保存失败: ${err?.message || err}`);
    }
  };

  const send = async (preset?: string) => {
    const content = (preset ?? input()).trim();
    if (!content || streaming()) return;
    if (!preset) setInput('');
    setError('');

    const history = messages().map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: '' }]);
    setStreaming(true);
    scrollBottom();

    try {
      await ctx.call('chat', { prompt: content, history });
    } catch (err: any) {
      setStreaming(false);
      setError(String(err?.message || err));
      setMessages((prev) => prev.slice(0, -1)); // 移除空 assistant 占位
    }
  };

  const abort = async () => {
    try {
      await ctx.call('abort');
    } catch {
      /* 忽略 */
    }
  };

  const closeWindow = async () => {
    if (isTauri()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    }
  };

  return (
    <div class="ai-chat">
      <header class="ai-header">
        <h1>AI 对话</h1>
        <div class="ai-header-actions">
          <button class="ai-btn ghost" onClick={() => { setShowConfig((v) => !v); setCustomModel(false); }}>⚙️ 配置</button>
          <button class="ai-btn ghost" onClick={() => void closeWindow()}>✕</button>
        </div>
      </header>

      <Show when={showConfig()}>
        <section class="ai-config">
          <label>
            模型
            <Show
              when={!customModel()}
              fallback={
                <input
                  value={config()?.model ?? ''}
                  onInput={(e) =>
                    setConfig((c) => ({ model: e.currentTarget.value, baseUrl: c?.baseUrl ?? '', models: c?.models }))
                  }
                  placeholder="输入模型 ID"
                />
              }
            >
              <KSelect
                class="ai-model-select"
                options={config()?.models ?? []}
                optionValue={(m: string) => m}
                optionTextValue={(m: string) => m}
                value={config()?.model}
                onChange={(m) => m && setConfig((c) => ({ model: m, baseUrl: c?.baseUrl ?? '', models: c?.models }))}
                itemComponent={(p) => (
                  <KSelectItem item={p.item} class="select-item">
                    {p.item.rawValue}
                  </KSelectItem>
                )}
                placement="bottom-start"
                gutter={6}
              >
                <KSelectTrigger class="ai-btn ghost select-btn" aria-label="选择模型">
                  <KSelectValue>
                    {(state: any) => state.selectedOption() ?? config()?.model ?? '选择模型'}
                  </KSelectValue>
                </KSelectTrigger>
                <KSelectContent class="select-pop" />
              </KSelect>
            </Show>
            <Show when={!customModel()}>
              <button type="button" class="ai-btn ghost ai-model-custom" onClick={() => setCustomModel(true)}>
                自定义模型 ID…
              </button>
            </Show>
          </label>
          <label>
            接口地址（OpenAI 兼容）
            <input
              value={config()?.baseUrl ?? ''}
              onInput={(e) => setConfig((c) => ({ baseUrl: e.currentTarget.value, model: c?.model ?? '' }))}
              placeholder="https://api.deepseek.com"
            />
          </label>
          <button class="ai-btn" onClick={() => void saveConfig()}>保存配置</button>
        </section>
      </Show>

      <Show
        when={hasKey() !== false}
        fallback={
          <section class="ai-keycard">
            <h2>配置 API Key</h2>
            <p>密钥由宿主 SecretStore 托管（不写入插件数据），保存后立即可用。</p>
            <input
              type="password"
              placeholder="sk-..."
              value={keyInput()}
              onInput={(e) => setKeyInput(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
            />
            <button class="ai-btn" onClick={() => void saveKey()}>保存密钥</button>
            <p class="ai-hint">接口默认 DeepSeek（deepseek-chat）；可在「配置」中切换任意 OpenAI 兼容端点（仅允许 manifest 白名单域名）。</p>
          </section>
        }
      >
        <div class="ai-messages" ref={listRef}>
          <For each={messages()}>
            {(m) => (
              <div class={`ai-msg ${m.role}`}>
                <div class="ai-bubble">{m.content || (streaming() ? '…' : '')}</div>
              </div>
            )}
          </For>
        </div>

        <Show when={error()}>
          <div class="ai-error">{error()}</div>
        </Show>

        <footer class="ai-input">
          <textarea
            rows={2}
            placeholder="输入提示词，Enter 发送（Shift+Enter 换行）"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Show when={!streaming()} fallback={<button class="ai-btn danger" onClick={() => void abort()}>中断</button>}>
            <button class="ai-btn" onClick={() => void send()}>发送</button>
          </Show>
        </footer>
      </Show>
    </div>
  );
};

export default ChatView;
