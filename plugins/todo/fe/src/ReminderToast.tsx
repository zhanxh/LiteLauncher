import { Component, Show, onCleanup, onMount } from 'solid-js';
import { getPluginContext, isHostAvailable } from '@ll/sdk';
import { PopupFrame } from '@ll/ui';
import { detailParams, leadLabel, spanLabel, type ReminderPayload } from './remindfmt';
import './reminder.css';

const ctx = getPluginContext('todo');

/**
 * 日程提醒卡片（右下角常驻小窗）
 *
 * 常驻是刻意的：提醒不该在用户还没来得及看的时候自己消失。关窗只有
 * 「我知道了」和 ✕ 两个入口，都不写数据——同一次提醒不再重复弹，
 * 靠的是后端 alarm_fires 的幂等记录，而不是这张卡片的计时器。
 *
 * 文案在开窗那一刻算完就不再变（窗口没有定时刷新），所以措辞一律是
 * "几分钟后 / 现在开始"这种粗粒度说法，放久了也不会读成假的倒计时。
 *
 * 外壳是宿主的通用基窗（PopupFrame 三段式）：manifest 里 `auto_height: true`，
 * 高度由内容决定，堆叠偏移才按真实高度算；万一内容超过 max_height，
 * 滚动落在内容区，标题栏与按钮行始终在手边。拖拽在标题栏上。
 */
export const ReminderToast: Component<{ payload: ReminderPayload }> = (props) => {
  const p = props.payload;
  const lead = leadLabel(p, new Date());
  const span = spanLabel(p, new Date());

  let closed = false;
  const closeWindow = async () => {
    if (closed || !isHostAvailable()) return;
    closed = true;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      // destroy 而不是 close：close 走 onCloseRequested 的请求-确认链，
      // 卡片关闭没有任何要确认的场景，那条链有一环不 resolve 就是"点了没反应"
      await getCurrentWindow().destroy();
    } catch (err) {
      console.error('关闭提醒卡片失败:', err);
    }
  };

  const openDetail = async () => {
    if (!isHostAvailable() || !p.event) return;
    try {
      await ctx.windows.open('detail', detailParams(p));
    } catch (err) {
      console.error('打开日程详情失败:', err);
    }
  };

  onMount(() => {
    // 本文件随主 bundle 全局加载，body 类名必须锁在 .reminder-mode 里
    document.body.classList.add('reminder-mode');
    onCleanup(() => document.body.classList.remove('reminder-mode'));
  });

  return (
    <PopupFrame
      pluginId="todo"
      title="日程提醒"
      onClose={() => void closeWindow()}
      footer={
        <>
          <Show when={p.event}>
            <button type="button" class="rm-btn" onClick={() => void openDetail()}>
              查看详情
            </button>
          </Show>
          <button type="button" class="rm-btn rm-btn--primary" onClick={() => void closeWindow()}>
            我知道了
          </button>
        </>
      }
    >
      <div class="rm-body">
        <div class="rm-lead">{lead}</div>
        <div class="rm-title">{p.content || '（无标题）'}</div>
        <div class="rm-row">
          <span class="rm-ico">🕓</span>
          <span class="rm-span">{span}</span>
        </div>
        <Show when={p.cal}>
          <div class="rm-row">
            <span class="rm-dot" />
            <span class="rm-span">{p.cal}</span>
          </div>
        </Show>
      </div>
    </PopupFrame>
  );
};
