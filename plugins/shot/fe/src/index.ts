/**
 * @ll/plugin-shot —— /shot 屏幕截图（纯前端插件，backend.kind = "none"）
 *
 * 插件本身不含任何平台代码：截图、多屏定位、窗口避让、PNG 落盘全在宿主侧
 * （`svc.screen.*`，manifest 声明 `screen` 权限）。插件只做三件事：
 *   1. 把"哪块屏 × 延时几秒"表达成可选条目；
 *   2. 把结果路径送进剪贴板 / 交给系统查看器；
 *   3. 用全局热键把"免开启动器直接截图"接上（`svc.shortcut.*`）。
 */
import {
  getPluginContext,
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type MonitorInfo,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';

const PLUGIN_ID = 'shot';
const ctx = getPluginContext(PLUGIN_ID);

/** 全局热键：不打开启动器，直接把光标所在屏幕存盘（manifest 需声明同值 shortcut: 权限） */
const HOTKEY = 'alt+shift+s';

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

/** 截图：隐藏壳层 → 捕获 → 记住最近一次 → 刷新面板 */
async function capture(target: number, delayMs: number): Promise<AfterSelect> {
  try {
    const shot = await ctx.screen.capture({ monitor: target, hideWindows: true, delayMs });
    lastShot = { path: shot.path, width: shot.width, height: shot.height };
    lastShotLoaded = true;
    await ctx.settings.setJson('lastShot', lastShot);
    // 路径进剪贴板：截图最常见的下一步就是粘贴到聊天窗口/文档里
    await ctx.clipboard.write(shot.path);
    return { refresh: true, toast: `已截图 ${shot.width}×${shot.height}，路径已复制` };
  } catch (err) {
    return { toast: `截图失败：${messageOf(err)}` };
  }
}

export const shotPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/shot',
  name: '屏幕截图',
  description:
    '屏幕截图：/shot 截取光标所在屏幕、/shot 2 指定显示器、/shot -d3 延时 3 秒；路径自动进剪贴板。',
  icon: '📸',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    await ensureLastShot();
    const list = await ensureMonitors();
    const { monitor, delayMs } = parseArgs(tokensOf(input));
    // 不指定显示器 = 光标所在那块（多屏用户的本能预期）
    const target = monitor ?? -1;
    const items: PanelItem[] = [];

    items.push({
      id: `${PLUGIN_ID}:now`,
      title: delayMs > 0 ? `${delayMs / 1000} 秒后截取${monitorLabel(list, target)}` : `截取${monitorLabel(list, target)}`,
      description: '先隐藏 LiteLauncher 再截取；完成后面板自动刷新',
      icon: '📸',
      badge: delayMs > 0 ? `延时 ${delayMs / 1000}s` : '截图',
      metadata: { action: 'capture', monitor: target, delayMs },
    });

    // 每块屏一条：把"指定显示器"变成可点选项，不必记序号
    for (const m of list) {
      items.push({
        id: `${PLUGIN_ID}:mon${m.index}`,
        title: `截取显示器 ${m.index} · ${m.width}×${m.height}`,
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
        title: `${seconds} 秒后截取${monitorLabel(list, target)}`,
        description: '留出收起菜单、摆放窗口的时间',
        icon: '⏱️',
        badge: `${seconds}s`,
        metadata: { action: 'capture', monitor: target, delayMs: seconds * 1000 },
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
        title: '复制最近截图路径',
        description: lastShot.path,
        icon: '📋',
        badge: '复制',
        metadata: { action: 'copy', path: lastShot.path },
      });
    } else {
      items.push({
        id: `${PLUGIN_ID}:where`,
        title: '截图的存放位置',
        description: '首次截图后落在这里：数据目录/LiteLauncher/plugins/shot/screenshots/',
        icon: '📂',
        badge: '说明',
        metadata: { action: 'none' },
      });
    }

    items.push({
      id: `${PLUGIN_ID}:hotkey`,
      title: `全局热键 ${HOTKEY}`,
      description: '任意界面按下即截图，无需打开启动器（结果以系统通知反馈）',
      icon: '⌨️',
      badge: '热键',
      metadata: { action: 'none' },
    });

    return { items, emptyText: '无可用截图选项' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const meta = item.metadata ?? {};
    const action = String(meta.action ?? '');

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

    return {};
  },
};

/**
 * 全局热键通道：注册 + 订阅。
 *
 * `ctx.shortcuts.on` 默认只在主窗口生效（每个窗口加载都会跑一遍 setup，
 * 不区分的话打开任意视图窗口后热键会被执行两次）。
 */
async function setupHotkey(): Promise<void> {
  try {
    await ctx.shortcuts.register(HOTKEY);
  } catch (err) {
    ctx.log.warn(`全局热键 ${HOTKEY} 注册失败（可能被占用）：${messageOf(err)}`);
    return;
  }

  await ctx.shortcuts.on(HOTKEY, () => {
    void (async () => {
      try {
        const shot = await ctx.screen.capture({ monitor: -1, hideWindows: true, delayMs: 0 });
        lastShot = { path: shot.path, width: shot.width, height: shot.height };
        lastShotLoaded = true;
        await ctx.settings.setJson('lastShot', lastShot);
        await ctx.clipboard.write(shot.path);
        // 启动器不可见，只能靠系统通知把结果交回用户
        await ctx.notify.send('截图已保存', `${shot.width}×${shot.height} · 路径已复制到剪贴板`);
      } catch (err) {
        await ctx.notify.send('截图失败', messageOf(err)).catch(() => undefined);
      }
    })();
  });
}

export function setup(): void {
  pluginRegistry.register(shotPlugin);
  void setupHotkey();
}
