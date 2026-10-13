/**
 * @ll/plugin-hotkey —— /hotkey 全局热键速查表（纯前端插件，backend.kind = "none"）
 *
 * 解决一个具体问题：全局热键是"看不见的功能"。用户不会想到 alt+shift+s 能截图，
 * 于是这个能力等于不存在；而宿主侧 `shortcut:<accel>` 是静态声明的，没有任何界面
 * 能列出"当前到底有哪些键生效"。本插件把各插件自报的 `hotkeys` 汇总成一张表。
 *
 * 为什么是插件而非壳层功能：热键数据源是各插件的自报字段（CommandPlugin.hotkeys），
 * 只有插件注册表里才有；壳层若要接管就得反向依赖每个插件，违反"一切皆插件"。
 */

/** 分组：按主修饰键归类，对齐 uTools / Quicker 的速查表习惯 */
export type HotkeyGroupId = 'ctrl' | 'alt' | 'shift' | 'win' | 'other';

export interface HotkeyEntry {
  /** 加速键规范形式，如 "alt+shift+s" */
  accel: string;
  /** 该键做什么 */
  description: string;
  /** 归属插件 id（用于点击时回填指令） */
  pluginId: string;
  /** 归属插件指令，如 "/shot" */
  trigger: string;
  /** 归属插件中文名 */
  pluginName: string;
  /** 归属插件图标 */
  icon: string;
}

export interface HotkeyGroup {
  id: HotkeyGroupId;
  title: string;
  entries: HotkeyEntry[];
}

const GROUP_META: Record<HotkeyGroupId, { title: string; rank: number }> = {
  ctrl: { title: 'Ctrl组合', rank: 0 },
  alt: { title: 'Alt 组合', rank: 1 },
  shift: { title: 'Shift 组合', rank: 2 },
  win: { title: 'Win 组合', rank: 3 },
  other: { title: '其他', rank: 4 },
};

/**
 * 判定某加速键归属哪个分组。
 *
 * 规则：一个组合键可能同时含 ctrl 和 alt（如 "ctrl+alt+shift+k"），此时归到
 * **最"强"的修饰键**（Ctrl > Alt > Shift > Win），避免同一条记录在多组里重复出现。
 * 只剩字母/功能键的（理论上不该出现，因为规范要求带修饰键）归"其他"。
 */
export function groupOf(accel: string): HotkeyGroupId {
  const parts = accel.toLowerCase().split('+').map((s) => s.trim());
  if (parts.includes('ctrl') || parts.includes('control')) return 'ctrl';
  if (parts.includes('alt') || parts.includes('option')) return 'alt';
  if (parts.includes('shift')) return 'shift';
  if (parts.includes('win') || parts.includes('super') || parts.includes('cmd')) return 'win';
  return 'other';
}

/** 拆分加速键为修饰键与主键，如 "alt+shift+s" → { mods: ['alt','shift'], key: 's' } */
export function splitAccel(accel: string): { mods: string[]; key: string } {
  const parts = accel.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const mods: string[] = [];
  let key = '';
  for (const part of parts) {
    if (['ctrl', 'control', 'alt', 'option', 'shift', 'win', 'super', 'cmd'].includes(part)) {
      mods.push(part);
    } else {
      key = part;
    }
  }
  return { mods, key };
}

/** 修饰键显示名（让速查表更易读） */
const MOD_LABEL: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  win: 'Win',
  super: 'Win',
  cmd: 'Win',
};

/** 把加速键渲染成"人类可读"形式，如 "ctrl+alt+k" → "Ctrl + Alt + K" */
export function prettyAccel(accel: string): string {
  const { mods, key } = splitAccel(accel);
  // 修饰键按固定顺序排（Ctrl→Alt→Shift→Win），不按用户输入顺序，避免同组合出现两种写法
  const ORDER = ['ctrl', 'control', 'alt', 'option', 'shift', 'win', 'super', 'cmd'];
  const sortedMods = [...mods].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const labels = sortedMods.map((m) => MOD_LABEL[m] ?? m);
  // 单字符主键大写，功能键（f1..f12）保持原样
  const keyLabel = key.length === 1 ? key.toUpperCase() : key;
  return [...labels, keyLabel].filter(Boolean).join(' + ');
}

/**
 * 把扁平的热键列表分组成速查表。
 * 组内按主键字母/数字排序（f1 < f2 < a），组间按 Ctrl→Alt→Shift→Win 排。
 */
export function groupHotkeys(entries: HotkeyEntry[]): HotkeyGroup[] {
  const buckets = new Map<HotkeyGroupId, HotkeyEntry[]>();
  for (const e of entries) {
    const id = groupOf(e.accel);
    const list = buckets.get(id);
    if (list) list.push(e);
    else buckets.set(id, [e]);
  }

  const groups: HotkeyGroup[] = [];
  for (const [id, list] of buckets) {
    list.sort((a, b) => {
      const ka = splitAccel(a.accel).key;
      const kb = splitAccel(b.accel).key;
      if (ka === kb) return a.accel.localeCompare(b.accel);
      return ka.localeCompare(kb);
    });
    groups.push({ id, title: GROUP_META[id].title, entries: list });
  }
  groups.sort((a, b) => GROUP_META[a.id].rank - GROUP_META[b.id].rank);
  return groups;
}