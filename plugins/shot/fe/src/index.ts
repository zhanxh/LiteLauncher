/**
 * @ll/plugin-shot —— /shot 屏幕截图（纯前端插件，backend.kind = "none"）
 *
 * 插件本身不含任何平台代码：截图、多屏定位、窗口避让、区域裁剪、PNG 落盘、
 * 图片入剪贴板全在宿主侧（`svc.screen.*`，manifest 声明 `screen` 权限）。
 * 插件只做四件事：
 *   1. 把"哪块屏 × 延时几秒 × 整屏还是框选"表达成可选条目；
 *   2. 开全屏透明遮罩层做区域框选（view: select）；
 *   3. 把结果交给剪贴板（图片本体）/ 系统查看器（打开、打开文件夹）；
 *   4. 用全局热键把"免开启动器直接区域框选"接上（`svc.shortcut.*`）。
 */
import {
  getPluginContext,
  pluginRegistry,
  registerView,
  type AfterSelect,
  type CommandPlugin,
  type MonitorInfo,
  type PanelData,
  type PanelItem,
  type ParsedInput,
  type PluginHotkey,
} from '@ll/sdk';
import { ShotSelect } from './select';
import { ShotAnnotate } from './annotate-view';

const PLUGIN_ID = 'shot';
const ctx = getPluginContext(PLUGIN_ID);

/** 区域框选视图（manifest 的 views[].id 必须一致） */
const VIEW_SELECT = 'select';
/** 标注视图（区域框选后画箭头/马赛克/文字） */
const VIEW_ANNOTATE = 'annotate';

/** 全局热键 id：具体 accel 由 manifest 声明、宿主注册（用户可在设置里改） */
const HOTKEY_ID = 'capture';

/** 实际注册成功的全局热键（供 `/hotkey` 速查表；注册失败则不收录） */
const hotkeys: PluginHotkey[] = [];

/** 上一次截图（跨会话记住路径，便于"打开所在文件夹"） */
let lastShot: { path: string; width: number; height: number } | null = null;
let lastShotLoaded = false;

/** 显示器列表缓存：query() 逐键触发，不能每次都去枚举显示器 */
let monitors: MonitorInfo[] = [];
let monitorsAt = 0;
const MONITOR_TTL_MS = 30_000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 取所在目录（Windows 与 POSIX 分隔符都认） */
function dirOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

/**
 * 解析 `/shot [显示器序号] [-d秒数]`。
 *
 * 刻意简单：位置数字（第一个）当显示器序号，`-d<n>` / `d<n>` 当延时秒数。
 * 宿主侧对 delayMs 有 10 秒硬上限，这里先收敛，避免用户以为设了 30 秒。
 * 注意 token 由调用方拼好（分词器会把首个 token 收进 subcommand，不能只看 args）。
 */
export function parseArgs(tokens: string[]): { monitor?: number; delayMs: number } {
  let monitor: number | undefined;
  let delayMs = 0;
  for (const raw of tokens) {
    const arg = (raw ?? '').trim().toLowerCase();
    if (!arg) continue;
    const delay = /^(?:-d|delay)(\d+)$/.exec(arg);
    if (delay) {
      delayMs = Math.min(Number(delay[1]), 10) * 1000;
      continue;
    }
    if (/^\d+$/.test(arg)) {
      monitor = Number(arg);
    }
  }
  return { monitor, delayMs };
}

/** 分词器把首个 token 放进 subcommand，这里还原成完整 token 序列 */
function tokensOf(input: ParsedInput): string[] {
  return [input.subcommand ?? '', ...(input.args ?? [])];
}

async function ensureMonitors(): Promise<MonitorInfo[]> {
  if (monitors.length > 0 && Date.now() - monitorsAt < MONITOR_TTL_MS) {
    return monitors;
  }
  try {
    monitors = await ctx.screen.list();
    monitorsAt = Date.now();
  } catch (err) {
    // 无 GUI 会话 / 权限缺失：降级为"一块未知屏幕"，主项仍可用（宿主会自行解析 -1）
    ctx.log.warn(`枚举显示器失败：${messageOf(err)}`);
    monitors = [];
  }
  return monitors;
}

async function ensureLastShot(): Promise<void> {
  if (lastShotLoaded) return;
  lastShotLoaded = true;
  try {
    lastShot = await ctx.settings.getJson<{ path: string; width: number; height: number } | null>(
      'lastShot',
      null,
    );
  } catch {
    lastShot = null;
  }
}

/** 显示器序号 → 人类可读名字（-1 表示光标所在那块） */
function monitorLabel(list: MonitorInfo[], index: number): string {
  if (index === -1 || list.length === 0) {
    return list.length > 0 ? '光标所在屏幕' : '全屏';
  }
  const found = list.find((m) => m.index === index);
  if (!found) return `显示器 ${index}`;
  return `显示器 ${index}（${found.width}×${found.height}${found.primary ? ' 主屏' : ''}）`;
}

/** 截图：隐藏壳层 → 捕获 → 记住最近一次 → 刷新面板
 *
 * `toClipboard: true` 让**图片本体**进剪贴板——这是桌面截图工具的默认交付物
 * （用户要的是"看到就粘"，而不是"拿到一个路径再去文件夹里找图"）。
 * 同时仍落盘，供"打开/打开文件夹"兜底。
 */
async function openRegion(
  monitor = -1,
  delayMs = 0,
  annotate = false,
): Promise<AfterSelect> {
  try {
    await ctx.windows.open(VIEW_SELECT, {
      monitor: String(monitor),
      delayMs: String(delayMs),
      ...(annotate ? { annotate: '1' } : {}),
    });
    // 遮罩层接管后续流程，主窗口必须关掉，否则遮罩层底图里会拍到启动器自己
    return { close: true };
  } catch (err) {
    return { toast: `无法打开框选层：${messageOf(err)}` };
  }
}

async function capture(target: number, delayMs: number): Promise<AfterSelect> {
  try {
    const shot = await ctx.screen.capture({ monitor: target, hideWindows: true, delayMs, toClipboard: true });
    lastShot = { path: shot.path, width: shot.width, height: shot.height };
    lastShotLoaded = true;
    await ctx.settings.setJson('lastShot', lastShot);
    // 图片没进剪贴板时（权限缺失/无 GUI 会话）退而求其次给路径
    if (!shot.clipboardImage) {
      await ctx.clipboard.write(shot.path).catch(() => undefined);
    }
    return {
      refresh: true,
      toast: shot.clipboardImage
        ? `已截图 ${shot.width}×${shot.height}，图片已复制，可直接粘贴`
        : `已截图 ${shot.width}×${shot.height}，路径已复制`,
    };
  } catch (err) {
    return { toast: `截图失败：${messageOf(err)}` };
  }
}

export const shotPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/shot',
  name: '屏幕截图',
  description:
    '屏幕截图：回车区域框选（推荐）；也可指定显示器整屏截图、延时截图。图片本体自动进剪贴板可直接粘贴。',
  icon: '📸',
  argsHint: '[屏序号] [-d秒]',
  examples: ['/shot', '/shot 2', '/shot -d3', '/hotkey 查全部全局热键'],
  hotkeys,

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    await ensureLastShot();
    const list = await ensureMonitors();
    const { monitor, delayMs } = parseArgs(tokensOf(input));
    // 不指定显示器 = 光标所在那块（多屏用户的本能预期）
    const target = monitor ?? -1;
    const items: PanelItem[] = [];

    // 区域框选放在首位：桌面截图工具的主路径是"框一块"，整屏只是兜底。
    // 延时档位对框选同样有意义（先把菜单收起来/切到目标窗口再框）。
    items.push({
      id: `${PLUGIN_ID}:region`,
      title: delayMs > 0 ? `${delayMs / 1000} 秒后框选区域截图` : '框选区域截图',
      description: '拖拽选择范围，回车确认，Esc 取消；图片直接进剪贴板',
      icon: '✂️',
      badge: delayMs > 0 ? `延时 ${delayMs / 1000}s` : '推荐',
      metadata: { action: 'region', monitor: target, delayMs },
    });

    items.push({
      id: `${PLUGIN_ID}:now`,
      title: delayMs > 0 ? `${delayMs / 1000} 秒后截取${monitorLabel(list, target)}` : `截取${monitorLabel(list, target)}整屏`,
      description: '整屏存图，图片同样直接进剪贴板',
      icon: '📸',
      badge: '整屏',
      metadata: { action: 'capture', monitor: target, delayMs },
    });

    // 标注入口：框选后进标注层画箭头/马赛克/文字，确认后才出图。
    // 紧跟在框选项之后——两者是同一条路径的两种收尾方式。
    items.push({
      id: `${PLUGIN_ID}:annotate`,
      title: delayMs > 0 ? `${delayMs / 1000} 秒后框选并标注` : '框选区域并标注',
      description: '框选后进入标注层：箭头 / 矩形 / 文字 / 马赛克 / 步骤号，完成后图片进剪贴板',
      icon: '✏️',
      badge: '标注',
      metadata: { action: 'region', monitor: target, delayMs, annotate: true },
    });

    // 每块屏一条：把"指定显示器"变成可点选项，不必记序号
    for (const m of list) {
      items.push({
        id: `${PLUGIN_ID}:mon${m.index}`,
        title: `截取显示器 ${m.index} · ${m.width}×${m.height} 整屏`,
        description: `${m.name || '显示器'}${m.primary ? ' · 主屏' : ''} · 缩放 ${Math.round(m.scaleFactor * 100)}%`,
        icon: '🖥️',
        badge: m.primary ? '主屏' : '副屏',
        metadata: { action: 'capture', monitor: m.index, delayMs: 0 },
      });
    }

    // 延时档位：常用来先收起菜单 / 切到目标窗口
    for (const seconds of [3, 5]) {
      items.push({
        id: `${PLUGIN_ID}:delay${seconds}`,
        title: `${seconds} 秒后框选区域截图`,
        description: '留出收起菜单、摆放窗口的时间',
        icon: '⏱️',
        badge: `${seconds}s`,
        metadata: { action: 'region', monitor: target, delayMs: seconds * 1000 },
      });
    }

    if (lastShot) {
      items.push({
        id: `${PLUGIN_ID}:open`,
        title: '用系统查看器打开最近截图',
        description: `${lastShot.width}×${lastShot.height} · ${lastShot.path}`,
        icon: '🖼️',
        badge: '打开',
        metadata: { action: 'open', path: lastShot.path },
      });
      items.push({
        id: `${PLUGIN_ID}:folder`,
        title: '打开截图所在文件夹',
        description: dirOf(lastShot.path),
        icon: '📂',
        badge: '文件夹',
        metadata: { action: 'folder', path: lastShot.path },
      });
      items.push({
        id: `${PLUGIN_ID}:copy`,
        title: '复制最近截图的路径',
        description: lastShot.path,
        icon: '📋',
        badge: '路径',
        metadata: { action: 'copy', path: lastShot.path },
      });
    }

    try {
      const stats = await ctx.call<{ count: number; bytes: number }>('svc.screen.stats', {});
      const mb = (stats.bytes / 1024 / 1024).toFixed(1);
      items.push({
        id: `${PLUGIN_ID}:storage`,
        title: `已保存 ${stats.count} 张截图`,
        description: `占用 ${mb} MB · 最多 500 张 / 30 天，超出自动清理`,
        icon: '💾',
        badge: '存储',
        kind: 'info',
      });
    } catch {
      // 统计失败不影响截图主流程
    }

    return { items, emptyText: '无可用截图选项' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const meta = item.metadata ?? {};
    const action = String(meta.action ?? '');

    // 区域框选：关掉主窗口 → 开全屏透明遮罩层 → 用户拖拽 → 遮罩层自行截图并关闭
    if (action === 'region') {
      const monitor = typeof meta.monitor === 'number' ? meta.monitor : -1;
      const delayMs = typeof meta.delayMs === 'number' ? meta.delayMs : 0;
      // 标注模式只是给遮罩层多传一个标志，由它决定截图后是收尾还是转标注层
      return openRegion(monitor, delayMs, meta.annotate === true);
    }

    if (action === 'capture') {
      const monitor = typeof meta.monitor === 'number' ? meta.monitor : -1;
      const delayMs = typeof meta.delayMs === 'number' ? meta.delayMs : 0;
      return await capture(monitor, delayMs);
    }

    if (action === 'open' || action === 'folder') {
      const path = String(meta.path ?? '');
      if (!path) return { toast: '没有可打开的截图' };
      const target = action === 'open' ? path : dirOf(path);
      try {
        await ctx.call('svc.process.launch', { target });
        return { close: true };
      } catch (err) {
        return { toast: `打开失败：${messageOf(err)}` };
      }
    }

    if (action === 'copy') {
      const path = String(meta.path ?? '');
      return path ? { copy: path, toast: '路径已复制' } : { toast: '没有可复制的路径' };
    }

    return { toast: '该项仅用于说明' };
  },
};

/**
 * 全局热键：订阅 manifest 声明的 `capture`。
 *
 * 注册由宿主启动时完成（默认 alt+shift+s，用户可在设置里改）；
 * 事件按 hotkeyId 路由，改键后不需要重新订阅。
 */
async function refreshHotkeyReport(): Promise<void> {
  try {
    const info = (await ctx.shortcuts.catalog()).find((h) => h.id === HOTKEY_ID);
    hotkeys.length = 0;
    if (info?.registered) {
      hotkeys.push({
        accel: info.accel,
        description: '免开启动器整屏截图，图片直接进剪贴板',
      });
    } else {
      ctx.log.warn(
        `热键 ${info?.accel ?? 'alt+shift+s'} 未注册（可能被占用），可在“设置 → 快捷键”修改`,
      );
    }
  } catch {
    // 目录读取失败不影响截图本身
  }
}

async function setupHotkey(): Promise<void> {
  await ctx.shortcuts.onHotkey(HOTKEY_ID, () => {
    void (async () => {
      // 热键直达区域框选：不再静默整屏存盘，用户按下后直接拖拽选范围。
      // 先把主窗口收起来（热键可能在启动器可见时按下），再开全屏遮罩层；
      // 启动器不可见时靠遮罩层自己截图，成功后由遮罩层处理剪贴板与通知。
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().hide();
      } catch {
        // 隐藏失败不阻断框选；遮罩层截图时还会再隐藏一次应用窗口
      }
      const res = await openRegion(-1, 0);
      if (res.toast) {
        await ctx.notify.send('截图失败', res.toast).catch(() => undefined);
      }
    })();
  });

  await refreshHotkeyReport();
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen('hotkey-changed', () => void refreshHotkeyReport()))
    .catch(() => undefined);
}

export function setup(): void {
  pluginRegistry.register(shotPlugin);
  registerView(VIEW_SELECT, ShotSelect);
  registerView(VIEW_ANNOTATE, ShotAnnotate);
  void setupHotkey();
}
