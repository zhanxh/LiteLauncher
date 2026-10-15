/**
 * 左侧分类栏：日历勾选（决定网格上出现哪些条目）+ 分类的增删改色。
 *
 * 只做个人分组，没有共享/订阅语义——所以删分类时日程不跟着删，只降级为"未分类"，
 * 与后端 delete_calendar 的行为一一对应。
 */
import { Component, For, Show, createSignal } from 'solid-js';
import { CalendarMeta, UNCLASSIFIED, UNCLASSIFIED_LABEL } from './calendars';

/** 预设色板：让用户选而不是给颜色输入框，省掉一串合法性校验也保证网格上不会出现低对比色 */
const PALETTE = ['#4c8dff', '#2fb47c', '#f5a623', '#e05c5c', '#a05ce0', '#00b8d4', '#d94fa0', '#8a8f98'];

interface Props {
  calendars: CalendarMeta[];
  /** 被勾选（显示）的分类 id 集合；UNCLASSIFIED 代表 calendar_id 为空的旧数据 */
  visible: Set<string>;
  onToggle: (id: string) => void;
  onCreate: (name: string, color: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string, color: string) => void;
  hasUnclassified: boolean;
}

export const CalSidebar: Component<Props> = (props) => {
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal('');
  const [color, setColor] = createSignal(PALETTE[0]);
  const [editId, setEditId] = createSignal('');

  const submitCreate = () => {
    const n = name().trim();
    if (!n) return;
    props.onCreate(n, color());
    setName('');
    setColor(PALETTE[0]);
    setAdding(false);
  };

  const submitRename = (id: string) => {
    const row = props.calendars.find((c) => c.id === id);
    const n = name().trim();
    if (row && n) props.onRename(id, n, color());
    setEditId('');
    setName('');
  };

  return (
    <aside class="cal-side">
      <div class="cal-side-block">
        <For each={props.calendars}>
          {(c) => (
            <div class="cal-side-row">
              <Show
                when={editId() !== c.id}
                fallback={
                  <div class="cal-edit">
                    <input
                      class="ti small"
                      value={name()}
                      ref={(el) => queueMicrotask(() => el.focus())}
                      onInput={(e) => setName(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename(c.id);
                        if (e.key === 'Escape') setEditId('');
                      }}
                    />
                    <div class="cal-swatches">
                      <For each={PALETTE}>
                        {(p) => (
                          <button
                            type="button"
                            class="cal-swatch"
                            classList={{ sel: p === color() }}
                            style={{ background: p }}
                            onClick={() => setColor(p)}
                          />
                        )}
                      </For>
                    </div>
                    <div class="cal-edit-actions">
                      <button type="button" class="btn primary small" onClick={() => submitRename(c.id)}>
                        确定
                      </button>
                      <button type="button" class="btn ghost small" onClick={() => setEditId('')}>
                        取消
                      </button>
                    </div>
                  </div>
                }
              >
                <label class="cal-side-label" title={c.name}>
                  <input
                    type="checkbox"
                    checked={props.visible.has(c.id)}
                    onChange={() => props.onToggle(c.id)}
                  />
                  <span class="cal-dot" style={{ background: c.color }} />
                  <span class="cal-side-name">{c.name}</span>
                </label>
                <span class="cal-side-ops">
                  <button
                    type="button"
                    class="cal-mini"
                    title="重命名 / 改颜色"
                    onClick={() => {
                      setEditId(c.id);
                      setName(c.name);
                      setColor(c.color);
                    }}
                  >
                    ✎
                  </button>
                  <Show when={c.id !== 'default'}>
                    <button
                      type="button"
                      class="cal-mini cal-mini--danger"
                      title="删除分类（其中的日程会变为未分类，不会一起删掉）"
                      onClick={() => props.onDelete(c.id)}
                    >
                      ✕
                    </button>
                  </Show>
                </span>
              </Show>
            </div>
          )}
        </For>

        <Show when={props.hasUnclassified}>
          <div class="cal-side-row">
            <label class="cal-side-label">
              <input
                type="checkbox"
                checked={props.visible.has(UNCLASSIFIED)}
                onChange={() => props.onToggle(UNCLASSIFIED)}
              />
              <span class="cal-dot cal-dot--none" />
              <span class="cal-side-name">{UNCLASSIFIED_LABEL}</span>
            </label>
          </div>
        </Show>

        <Show
          when={adding()}
          fallback={
            <button type="button" class="cal-add-cal" onClick={() => setAdding(true)}>
              ＋ 新建日历
            </button>
          }
        >
          <div class="cal-edit">
            <input
              class="ti small"
              placeholder="日历名称"
              value={name()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate();
                if (e.key === 'Escape') setAdding(false);
              }}
            />
            <div class="cal-swatches">
              <For each={PALETTE}>
                {(p) => (
                  <button
                    type="button"
                    class="cal-swatch"
                    classList={{ sel: p === color() }}
                    style={{ background: p }}
                    onClick={() => setColor(p)}
                  />
                )}
              </For>
            </div>
            <div class="cal-edit-actions">
              <button type="button" class="btn primary small" onClick={submitCreate}>
                创建
              </button>
              <button type="button" class="btn ghost small" onClick={() => setAdding(false)}>
                取消
              </button>
            </div>
          </div>
        </Show>
      </div>
    </aside>
  );
};
