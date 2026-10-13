/**
 * @ll/plugin-pick —— /pick 取色器（纯前端插件，backend.kind = "none"）
 *
 * 两条取色路径：
 *   1. **全局热键 alt+p**：任意界面按下 → 取光标处像素 → HEX 进剪贴板 + 系统通知。
 *      这是最常用的姿势（取色时用户正停在别的窗口上）。
 *   2. **浮动取色台**（`?view=panel` 视图窗口）：放大镜跟随鼠标，鼠标移入面板冻结，
 *      点按钮复制；面板内也能用 alt+p 确认。
 *
 * 面板与主窗口是两个 JS 上下文（各自跑一遍 setup），热键由 KV 里的
 * `panelOpen` 标记协调：面板开着时主窗口处理器让位。
 */
import {
  getPluginContext,
  pluginRegistry,
  registerView,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
  type PluginHotkey,
} from '@ll/sdk';
import { PickPanel } from './panel';
import { formatColor, hexToRgb, type ColorFormat } from './color';
import { clearHistory, isPanelOpen, loadHistory, pushHistory } from './history';

const PLUGIN_ID = 'pick';
const VIEW_ID = 'panel';
/** 与 manifest 的 `shortcut:alt+p` 声明、panel.tsx 保持一致 */
const HOTKEY = 'alt+p';

const ctx = getPluginContext(PLUGIN_ID);

/**
 * 实际注册成功的全局热键（`/hotkey` 速查表的数据源）。
 * 用可变数组而不是字面量：注册在 setup() 之后才异步完成，
 * 插件对象早已交给注册表，只能靠共享引用把结果送回去。
 */
const hotkeys: PluginHotkey[] = [];

const FORMATS: { id: ColorFormat; label: string }[] = [
  { id: 'hex', label: 'HEX' },
  { id: 'rgb', label: 'RGB' },
  { id: 'hsl', label: 'HSL' },
];

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 取色 → 记历史 → 通知；返回 HEX（失败抛错） */
async function pickAtCursor(format: ColorFormat = 'hex'): Promise<string> {
  const res = await ctx.screen.pixel();
  const text = formatColor(res.sample, format);
  await ctx.clipboard.write(text);
  await pushHistory(res.sample.hex);
  return text;
}

export const pickPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/pick',
  name: '取色器',
  description: '取色器：取光标处屏幕颜色，HEX/RGB/HSL 三种格式一键复制。',
  icon: '🎨',
  examples: ['Alt+P 免开启动器取色', '/pick 打开取色台', '取色台内：滚轮缩放 · 单击取色 · 回车复制 · Esc 取消'],
  hotkeys,

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const history = await loadHistory();
    const sub = (input.subcommand ?? '').toLowerCase();
    const wanted = FORMATS.find((f) => f.id === sub);
    const items: PanelItem[] = [];

    // 主项：立即取光标处颜色（面板开着时让面板先关，避免采到面板自己的像素）
    items.push({
      id: `${PLUGIN_ID}:now`,
      title: '取光标处的颜色',
      description: '采样当前鼠标位置并复制到剪贴板（不改动任何窗口）',
      icon: '🎯',
      badge: '取色',
      metadata: { action: 'pick', format: wanted?.id ?? 'hex' },
    });

    items.push({
      id: `${PLUGIN_ID}:panel`,
      title: '打开浮动取色台',
      description: '放大镜跟随鼠标，移入面板即冻结，点按钮复制',
      icon: '🔍',
      badge: '取色台',
      metadata: { action: 'panel' },
    });

    // 最近取色：按用户要求的格式复制
    const format = wanted?.id ?? 'hex';
    for (const [index, hex] of history.entries()) {
      const rgb = hexToRgb(hex);
      if (!rgb) continue;
      const value = formatColor(rgb, format);
      items.push({
        id: `${PLUGIN_ID}:h${index}`,
        title: `${format.toUpperCase()} ${value}`,
        description: index === 0 ? `${hex} · 最近一次取色` : hex,
        icon: '🎨',
        badge: format.toUpperCase(),
        metadata: { value },
      });
    }

    // 格式切换：换一种表示只改"复制什么"，不重新取色
    for (const f of FORMATS) {
      if (f.id === format) continue;
      items.push({
        id: `${PLUGIN_ID}:fmt-${f.id}`,
        title: `改按 ${f.label} 复制最近颜色`,
        description: history[0] ? `${history[0]} → ${formatColor(hexToRgb(history[0])!, f.id)}` : '尚无取色记录',
        icon: '🔤',
        badge: '格式',
        metadata: { action: 'format', format: f.id },
      });
    }

    if (history.length > 0) {
      items.push({
        id: `${PLUGIN_ID}:clear`,
        title: `清空取色历史（${history.length} 条）`,
        description: '只清本插件记录，不影响剪贴板',
        icon: '🗑️',
        badge: '清空',
        metadata: { action: 'clear' },
      });
    }

    items.push({
      id: `${PLUGIN_ID}:hotkey`,
      title: `全局热键 ${HOTKEY}`,
      description: '任意界面按下即取色：HEX 进剪贴板 + 系统通知（可在 manifest 的 shortcut: 权限里改）',
      icon: '⌨️',
      badge: '热键',
      metadata: { action: 'none' },
    });

    if (history.length === 0) {
      items.push({
        id: `${PLUGIN_ID}:empty`,
        title: '还没有取色记录',
        description: '用上面两项取一次色，这里就会出现最近记录',
        icon: '💡',
        badge: '提示',
      });
    }

    return { items, emptyText: '无可用取色项' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const meta = item.metadata ?? {};
    const action = String(meta.action ?? '');

    if (action === 'pick' || action === 'format') {
      const format = (meta.format as ColorFormat) ?? 'hex';
      try {
        const text = await pickAtCursor(format);
        return { refresh: true, toast: `已复制 ${text}` };
      } catch (err) {
        return { toast: `取色失败：${messageOf(err)}` };
      }
    }

    if (action === 'panel') {
      try {
        await ctx.windows.open(VIEW_ID);
        return { close: true };
      } catch (err) {
        return { toast: `打开取色台失败：${messageOf(err)}` };
      }
    }

    if (action === 'clear') {
      try {
        await clearHistory();
        return { refresh: true, toast: '取色历史已清空' };
      } catch (err) {
        return { toast: `清空失败：${messageOf(err)}` };
      }
    }

    // 历史项：metadata.value 即要复制的文本（壳层通用 copy）
    const value = meta.value;
    if (typeof value === 'string' && value) {
      return { copy: value, toast: `已复制 ${value}` };
    }

    return {};
  },
};

/**
 * 全局热键：注册 + 订阅。
 *
 * 面板开着时让位给面板（否则同一次按键会既复制又关窗，行为不可预期）。
 * `ctx.shortcuts.on` 默认只在主窗口生效——每个窗口加载都会跑一遍 setup，
 * 不区分的话打开视图窗口后热键会被执行两次。
 */
async function setupHotkey(): Promise<void> {
  try {
    await ctx.shortcuts.register(HOTKEY);
  } catch (err) {
    ctx.log.warn(`全局热键 ${HOTKEY} 注册失败（可能被其他程序或插件占用）：${messageOf(err)}`);
    return;
  }

  // 只在注册**成功后**才让速查表收录：否则 /hotkey 会教用户按一个不生效的键
  hotkeys.length = 0;
  hotkeys.push({ accel: HOTKEY, description: '取光标处颜色并复制 HEX' });

  await ctx.shortcuts.on(HOTKEY, () => {
    void (async () => {
      if (await isPanelOpen().catch(() => false)) return; // 交给取色台处理
      try {
        const text = await pickAtCursor('hex');
        await ctx.notify.send('已取色', `${text} · 已复制到剪贴板`);
      } catch (err) {
        await ctx.notify.send('取色失败', messageOf(err)).catch(() => undefined);
      }
    })();
  });
}

export function setup(): void {
  pluginRegistry.register(pickPlugin);
  registerView(VIEW_ID, PickPanel);
  void setupHotkey();
}
