/**
 * 番茄钟插件（前端侧）
 *
 * 本插件的"业务"在 LLP sidecar（`pomo.py`）里——计时状态必须常驻进程内，
 * 否则宿主重启就丢。前端只负责两件事：
 *   1. 注册桌面挂件视图（`?view=widget`）
 *   2. 在启动时把挂件拉起来（见 `ensureWidget`）
 *
 * 为什么"开始计时时自动显示"能做到：sidecar 执行 start 后会调
 * `svc.window.open('widget')`，而该窗口的前端正是这个包注册的视图。
 * 即"开窗"由 sidecar 触发、"渲染"由本包负责，两边通过 settings KV 共享状态。
 */
import { registerView, getPluginContext } from '@ll/sdk';
import { PomoWidget } from './widget';

const VIEW_ID = 'widget';
const ctx = getPluginContext('pomo');

/**
 * 确保挂件窗口已打开（幂等）。
 *
 * sidecar 已在 start 时调过 open，这里再兜一层是为了覆盖两种漏掉的情况：
 *   - 挂件窗口被用户手动关掉后又 `/pomo start`（open 会走 on_existing=focus，
 *     但已关闭的窗口需要重建）
 *   - 宿主重启后恢复计时，挂件窗口并不会自动回来
 */
export async function ensureWidget(params: Record<string, string | number | boolean> = {}) {
  try {
    await ctx.windows.open(VIEW_ID, params);
  } catch {
    // 开窗失败不应影响插件其余功能：用户仍可在面板里看到剩余时间
  }
}

/**
 * 尝试把挂件挂到桌面壁纸层。
 *
 * ⚠️ 必须如实处理 `onWallpaper === false`：Wayland 下这永远失败，
 * 窗口会降级为置顶浮窗。此时**不要**告诉用户"已贴到桌面"——
 * 那会让用户以为挂件进了壁纸层、被图标遮挡，实际却一直浮在最上层挡视野。
 */
export async function pinWidgetToDesktop(label = `pomo-${VIEW_ID}`) {
  try {
    const supported = await ctx.windows.desktopSupported();
    if (!supported) {
      return {
        pinned: false,
        reason: '当前桌面会话（Wayland）不允许应用指定窗口层级，已保持置顶浮窗',
      } as const;
    }
    const res = await ctx.windows.attachDesktop(label);
    if (res.onWallpaper) {
      return { pinned: true, reason: '已贴到桌面壁纸层' } as const;
    }
    const why =
      res.status.status === 'unsupported' || res.status.status === 'failed'
        ? res.status.reason
        : '未知原因';
    return { pinned: false, reason: `未能贴到壁纸层（${why}），已保持置顶浮窗` } as const;
  } catch (e) {
    return { pinned: false, reason: `挂载失败：${e}` } as const;
  }
}

export function setup() {
  registerView(VIEW_ID, PomoWidget);
}
