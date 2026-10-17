/**
 * 「搜索文件」弹窗（管理面板工具条 🔍 打开，布局对照图3）
 *
 * - 搜索框占位「搜索 (切换历史)」，↑/↓ 在历史关键词间切换（历史存插件设置，上限 20 条）
 * - Aa 区分大小写 / ab 全字匹配 / .* 正则模式 三个开关
 * - 包含文件 / 排除文件：glob 模式（例如 Work 目录下所有 .md 可写 Work 加双星加斜杠加星.md），由后端 search_files 解析
 * - 结果按文件分组列出命中行（行号 + 高亮文本），点击行打开文件并定位到该行
 */
import { Component, For, Show, createSignal, onMount } from 'solid-js';
import { getPluginContext } from '@ll/sdk';

const ctx = getPluginContext('notes');

interface SearchDialogProps {
  onClose: () => void;
  /** 打开文件并跳到指定行（1 起） */
  onOpenFile: (path: string, line: number) => void;
}

interface SearchLine {
  line: number;
  text: string;
}

interface SearchFileGroup {
  path: string;
  rel: string;
  name: string;
  matches: SearchLine[];
}

interface SearchResponse {
  files: SearchFileGroup[];
  total: number;
  truncated: boolean;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const SearchDialog: Component<SearchDialogProps> = (props) => {
  const [query, setQuery] = createSignal('');
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [wholeWord, setWholeWord] = createSignal(false);
  const [isRegex, setIsRegex] = createSignal(false);
  const [include, setInclude] = createSignal('');
  const [exclude, setExclude] = createSignal('');
  const [groups, setGroups] = createSignal<SearchFileGroup[]>([]);
  const [total, setTotal] = createSignal(0);
  const [truncated, setTruncated] = createSignal(false);
  const [searching, setSearching] = createSignal(false);
  const [searched, setSearched] = createSignal(false);
  const [error, setError] = createSignal('');
  const [history, setHistory] = createSignal<string[]>([]);
  const [histIdx, setHistIdx] = createSignal(-1);

  let inputRef: HTMLInputElement | undefined;

  onMount(async () => {
    setHistory(await ctx.settings.getJson<string[]>('search_history', []));
    inputRef?.focus();
  });

  const rememberHistory = (q: string) => {
    setHistory((prev) => {
      const next = [q, ...prev.filter((h) => h !== q)].slice(0, 20);
      void ctx.settings.setJson('search_history', next);
      return next;
    });
    setHistIdx(-1);
  };

  const runSearch = async () => {
    const q = query().trim();
    if (!q) {
      setGroups([]);
      setSearched(false);
      setError('');
      return;
    }
    if (!isTauri()) {
      setError('浏览器预览模式不支持搜索，请在应用内使用');
      return;
    }
    setSearching(true);
    setError('');
    setSearched(true);
    try {
      const res = await ctx.call<SearchResponse>('search_files', {
        query: q,
        case_sensitive: caseSensitive(),
        whole_word: wholeWord(),
        is_regex: isRegex(),
        include: include().trim(),
        exclude: exclude().trim(),
      });
      setGroups(res.files ?? []);
      setTotal(res.total ?? 0);
      setTruncated(Boolean(res.truncated));
      rememberHistory(q);
    } catch (err: any) {
      setError(String(err?.message || err));
      setGroups([]);
      setTotal(0);
    } finally {
      setSearching(false);
    }
  };

  const onQueryKeyDown = (e: KeyboardEvent, input: HTMLInputElement) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void runSearch();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
      return;
    }
    // ↑/↓ 在历史关键词间切换（与占位提示「切换历史」对应）
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const hist = history();
      if (hist.length === 0) return;
      e.preventDefault();
      let idx = histIdx();
      idx = e.key === 'ArrowUp' ? idx + 1 : idx - 1;
      if (idx >= hist.length) idx = hist.length - 1;
      if (idx < -1) idx = -1;
      setHistIdx(idx);
      const next = idx === -1 ? '' : hist[idx];
      setQuery(next);
      input.value = next;
    }
  };

  /** 由当前开关构造前端高亮正则（失败返回 null，退化为纯文本转义） */
  const buildMatcher = (): RegExp | null => {
    const q = query().trim();
    try {
      if (isRegex()) return new RegExp(q, caseSensitive() ? 'g' : 'gi');
      const core = wholeWord() ? `\\b${escapeRegExp(q)}\\b` : escapeRegExp(q);
      return new RegExp(core, caseSensitive() ? 'g' : 'gi');
    } catch {
      return null;
    }
  };

  const highlight = (text: string): string => {
    if (!query().trim()) return escapeHtml(text);
    const re = buildMatcher();
    if (!re) return escapeHtml(text);
    let out = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      out += escapeHtml(text.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    return out + escapeHtml(text.slice(last));
  };

  return (
    <div class="nmodal-mask nsearch-mask" onClick={props.onClose}>
      <div class="nmodal nsearch" onClick={(e) => e.stopPropagation()}>
        <div class="nsearch-head">
          <span>🔍</span>
          <span class="nsearch-title">搜索文件</span>
          <button type="button" class="nmodal-close" onClick={props.onClose} title="关闭">
            ×
          </button>
        </div>

        <div class="nsearch-inputrow">
          <input
            ref={inputRef}
            class="nsearch-input"
            type="text"
            placeholder="搜索 (切换历史)"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => onQueryKeyDown(e, e.currentTarget)}
            spellcheck={false}
          />
          <div class="nsearch-opts">
            <button
              type="button"
              classList={{ opt: true, active: caseSensitive() }}
              title="区分大小写"
              onClick={() => setCaseSensitive(!caseSensitive())}
            >
              Aa
            </button>
            <button
              type="button"
              classList={{ opt: true, active: wholeWord() }}
              title="全字匹配"
              onClick={() => setWholeWord(!wholeWord())}
            >
              ab
            </button>
            <button
              type="button"
              classList={{ opt: true, active: isRegex() }}
              title="正则表达式"
              onClick={() => setIsRegex(!isRegex())}
            >
              .*
            </button>
          </div>
        </div>

        <label class="nsearch-field">
          <span>包含文件</span>
          <input
            class="ninput"
            value={include()}
            onInput={(e) => setInclude(e.currentTarget.value)}
            placeholder="glob 模式，如 Work 目录下所有 .md（逗号分隔多个）"
            spellcheck={false}
          />
        </label>
        <label class="nsearch-field">
          <span>排除文件</span>
          <input
            class="ninput"
            value={exclude()}
            onInput={(e) => setExclude(e.currentTarget.value)}
            placeholder="glob 模式，如 Draft 开头的目录（可留空）"
            spellcheck={false}
          />
        </label>

        <div class="nsearch-results">
          <Show when={error()}>
            <div class="nsearch-error">{error()}</div>
          </Show>
          <Show when={searching()}>
            <div class="nsearch-hint">搜索中…</div>
          </Show>
          <Show when={!searching() && !error() && groups().length === 0}>
            <div class="nsearch-hint">
              {searched()
                ? '没有匹配的文件'
                : '输入关键词回车搜索全文；↑/↓ 切换历史，包含/排除支持 glob 模式'}
            </div>
          </Show>
          <For each={groups()}>
            {(g) => (
              <div class="nsearch-file">
                <button
                  type="button"
                  class="nsearch-file-head"
                  title={g.rel}
                  onClick={() => g.matches[0] && props.onOpenFile(g.path, g.matches[0].line)}
                >
                  <span class="nsearch-file-name">📄 {g.name}</span>
                  <span class="nsearch-file-rel">{g.rel}</span>
                  <span class="nsearch-file-count">{g.matches.length}</span>
                </button>
                <For each={g.matches}>
                  {(m) => (
                    <button
                      type="button"
                      class="nsearch-line"
                      title={`第 ${m.line} 行`}
                      onClick={() => props.onOpenFile(g.path, m.line)}
                    >
                      <span class="nsearch-line-no">{m.line}</span>
                      <span class="nsearch-line-text" innerHTML={highlight(m.text)} />
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
          <Show when={truncated()}>
            <div class="nsearch-hint">命中较多，仅显示前一部分——可缩小关键词或用包含/排除收窄</div>
          </Show>
          <Show when={total() > 0}>
            <div class="nsearch-hint">共 {total()} 处命中 · {groups().length} 个文件</div>
          </Show>
        </div>
      </div>
    </div>
  );
};
