import { Component, createSignal, For, onMount, onCleanup, Show } from 'solid-js';
import { getPluginContext } from '@ll/sdk';
import { PopupFrame } from '@ll/ui';
import { repeatLabel } from './todoPlugin';
import { DateTimeField } from './calendar/DateTimeField';
import { RepeatPicker } from './RepeatPicker';
import './todoapp.css';

// 待办管理面板经统一插件通道访问 todo 插件后端
const ctx = getPluginContext('todo');

interface TodoItem {
  id: string;
  content: string;
  remind_at: string | null;
  repeat_rule: string | null;
  completed: boolean;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 待办管理面板（/todo app 打开的独立窗口）
 * 未完成/已完成分区展示；支持编辑、完成切换、删除、快速添加；
 * 设置区可试弹一张提醒预览卡（卡片常驻，不自动消失）
 */
export const TodoManager: Component = () => {
  const [todos, setTodos] = createSignal<TodoItem[]>([]);
  const [statusText, setStatusText] = createSignal('');
  const [editingId, setEditingId] = createSignal<string | null>(null);

  // 编辑表单
  const [editContent, setEditContent] = createSignal('');
  const [editRemind, setEditRemind] = createSignal('');
  const [editRepeat, setEditRepeat] = createSignal('');

  // 快速添加表单
  const [newContent, setNewContent] = createSignal('');
  const [newRemind, setNewRemind] = createSignal('');
  const [newRepeat, setNewRepeat] = createSignal('');

  // 设置
  const [showSettings, setShowSettings] = createSignal(false);

  const flash = (msg: string) => {
    setStatusText(msg);
    setTimeout(() => setStatusText(''), 2600);
  };

  const refresh = async () => {
    if (!isTauri()) return;
    try {
      const list = await ctx.call<TodoItem[]>('list', { keyword: null });
      setTodos(list);
    } catch (err) {
      flash(`加载待办失败: ${err}`);
    }
  };

  onMount(() => {
    // 限定作用域：仅本面板窗口重置 body 高度/背景（css 规则随主 bundle 全局加载）
    document.body.classList.add('todoapp-mode');
    void refresh();
  });

  onCleanup(() => document.body.classList.remove('todoapp-mode'));

  const unfinished = () => todos().filter((t) => !t.completed);
  const finished = () => todos().filter((t) => t.completed);

  const toggleTodo = async (item: TodoItem) => {
    try {
      await ctx.call('toggle', { id: item.id });
      await refresh();
    } catch (err) {
      flash(`切换状态失败: ${err}`);
    }
  };

  const deleteTodo = async (item: TodoItem) => {
    try {
      await ctx.call('delete', { id: item.id });
      flash('已删除');
      await refresh();
    } catch (err) {
      flash(`删除失败: ${err}`);
    }
  };

  const startEdit = (item: TodoItem) => {
    setEditingId(item.id);
    setEditContent(item.content);
    setEditRemind(item.remind_at || '');
    setEditRepeat(item.repeat_rule || '');
  };

  const saveEdit = async () => {
    const id = editingId();
    if (!id) return;
    if (editRepeat() && !editRemind()) {
      flash('启用重复需先选择提醒时间');
      return;
    }
    try {
      await ctx.call('update', {
        id,
        content: editContent(),
        remind_at: editRemind(),
        repeat_rule: editRepeat().trim() || null,
      });
      setEditingId(null);
      flash('已保存修改');
      await refresh();
    } catch (err: any) {
      flash(`保存失败: ${err?.message || err}`);
    }
  };

  const quickAdd = async () => {
    if (!newContent().trim()) {
      flash('待办内容不能为空');
      return;
    }
    if (newRepeat() && !newRemind()) {
      flash('启用重复需先选择提醒时间');
      return;
    }
    try {
      await ctx.call('create', {
        content: newContent(),
        remind_at: newRemind(),
        repeat_rule: newRepeat().trim() || null,
        raw_input: '',
      });
      setNewContent('');
      setNewRemind('');
      setNewRepeat('');
      flash('已添加待办');
      await refresh();
    } catch (err: any) {
      flash(`添加失败: ${err?.message || err}`);
    }
  };

  const testPopup = async () => {
    try {
      await ctx.call('test_popup');
      flash('测试弹窗已弹出（屏幕右下角）');
    } catch (err) {
      flash(`测试失败: ${err}`);
    }
  };

  const closeWindow = async () => {
    if (isTauri()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    }
  };

  const renderItem = (item: TodoItem) => (
    <Show
      when={editingId() === item.id}
      fallback={
        <div class={`todo-row ${item.completed ? 'done' : ''}`}>
          <button
            class="todo-check"
            title={item.completed ? '标记为未完成' : '标记为已完成'}
            onClick={() => void toggleTodo(item)}
          >
            {item.completed ? '☑️' : '🔘'}
          </button>
          <div class="todo-main">
            <div class="todo-content">{item.content}</div>
            <div class="todo-meta">
              <Show when={item.remind_at}>
                <span>⏰ {item.remind_at}</span>
              </Show>
              <Show when={item.repeat_rule}>
                <span>🔁 {repeatLabel(item.repeat_rule)}</span>
              </Show>
              <Show when={!item.remind_at && !item.repeat_rule}>
                <span>无提醒</span>
              </Show>
            </div>
          </div>
          <div class="todo-actions">
            <button class="btn ghost" onClick={() => startEdit(item)}>编辑</button>
            <button class="btn danger ghost" onClick={() => void deleteTodo(item)}>删除</button>
          </div>
        </div>
      }
    >
      <div class="todo-row editing">
        <div class="todo-edit-grid">
          <input
            class="ti"
            value={editContent()}
            placeholder="待办内容"
            onInput={(e) => setEditContent(e.currentTarget.value)}
          />
          <DateTimeField
            value={editRemind()}
            datePlaceholder="提醒日期"
            timePlaceholder="提醒时间"
            allowClear
            onChange={setEditRemind}
          />
          <RepeatPicker value={editRepeat()} onChange={setEditRepeat} />
          <div class="todo-edit-actions">
            <button class="btn primary" onClick={() => void saveEdit()}>保存</button>
            <button class="btn ghost" onClick={() => setEditingId(null)}>取消</button>
          </div>
        </div>
      </div>
    </Show>
  );

  return (
    // 定尺寸窗：内容撑满窗口不上报高度；标题栏拖拽/关闭由基窗提供
    <PopupFrame
      fill
      title="待办管理"
      actions={
        <button
          type="button"
          class="btn ghost"
          classList={{ active: showSettings() }}
          onClick={() => setShowSettings(!showSettings())}
        >
          ⚙ 设置
        </button>
      }
      onClose={() => void closeWindow()}
    >
      <div class="todoapp">
        <Show when={showSettings()}>
          <section class="todoapp-settings">
            <div class="setting-row">
              <label for="popup-test">提醒弹窗</label>
              <div class="setting-controls">
                <button id="popup-test" class="btn ghost small" onClick={() => void testPopup()}>
                  测试弹窗
                </button>
              </div>
            </div>
            <p class="setting-hint">到点提醒时右下角弹出卡片，常驻不自动消失，点「我知道了」或 ✕ 才关。</p>
          </section>
        </Show>

        <section class="todoapp-add">
          <input
            class="ti"
            placeholder='新待办内容，如：团队周会'
            value={newContent()}
            onInput={(e) => setNewContent(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && void quickAdd()}
          />
          <DateTimeField
            value={newRemind()}
            datePlaceholder="日期（可空）"
            timePlaceholder="时间"
            allowClear
            onChange={setNewRemind}
          />
          <RepeatPicker value={newRepeat()} onChange={setNewRepeat} />
          <div class="todo-edit-actions">
            <button class="btn primary" onClick={() => void quickAdd()}>添加</button>
          </div>
        </section>

        <main class="todoapp-list">
          <h2 class="section-title">未完成 <span class="count">{unfinished().length}</span></h2>
          <Show
            when={unfinished().length > 0}
            fallback={<p class="empty">没有未完成的待办，输入上方表单快速添加</p>}
          >
            <For each={unfinished()}>{(item) => renderItem(item)}</For>
          </Show>

          <h2 class="section-title">
            已完成 <span class="count">{finished().length}</span>
          </h2>
          <Show
            when={finished().length > 0}
            fallback={<p class="empty">暂无已完成的待办</p>}
          >
            <For each={finished()}>{(item) => renderItem(item)}</For>
          </Show>
        </main>

        <Show when={statusText()}>
          <div class="todoapp-toast">{statusText()}</div>
        </Show>
      </div>
    </PopupFrame>
  );
};
