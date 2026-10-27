/**
 * LiteLauncher 指令系统核心类型定义
 */

/**
 * 分词解析后的用户输入结构
 */
export interface ParsedInput {
  /** 原始未处理的完整输入文本 */
  raw: string;
  /** 指令触发前缀，如 "/todo", "/note", "/app", 或空字符串 */
  trigger: string;
  /** 二级子指令，如 "new", "list", "add" */
  subcommand?: string;
  /** 参数列表（自动保留引号内的完整字符串） */
  args: string[];
  /**
   * 与 `args` 一一对应：该项是否来自引号包裹。
   * 语法解析器用它保护"引号内的标题不被当成时间/关键词"。
   */
  quotedArgs?: boolean[];
  /** 识别出的命名参数或时间属性等键值对 */
  namedArgs: Record<string, string>;
  /** 是否匹配为 Action 即时执行命令 */
  isAction: boolean;
  /** 查询过滤关键词（剔除 trigger 和 subcommand 后的搜索文本） */
  queryText: string;
}

/**
 * Action 即时执行语义预览胶囊
 * 用于在输入过程中实时给用户提供参数解析反馈
 */
export interface ActionPreviewCapsule {
  /** 胶囊标题，如 "新建待办" */
  title: string;
  /** 详情描述，如 "事项: 团队例会 | 提醒: 14:30" */
  detail: string;
  /** 徽标类别，如 "即时动作" */
  badge: string;
  /** 操作提示文本，如 "按 Enter 回车立即创建" */
  hint: string;
}

/**
 * onSelect 之后的壳层行为契约（LPS-1 §4.2）
 * 取代壳层按插件 id 硬编码判断"选完后是否关窗/清空/刷新"
 */
export interface AfterSelect {
  /** 关闭并隐藏启动器主窗口（如打开编辑器窗口、启动应用后） */
  close?: boolean;
  /** 清空输入框（默认随 close 执行） */
  clearInput?: boolean;
  /** 壳层 Toast 提示文案 */
  toast?: string;
  /** 重新执行本插件 query 刷新面板（如切换待办完成状态后） */
  refresh?: boolean;
  /**
   * 复制文本到系统剪贴板（壳层执行 navigator.clipboard.writeText）。
   * 壳层只认这个通用能力，不理解任何具体插件——工具类插件的"选中即复制"由此实现。
   */
  copy?: string;
}

/**
 * 结果项的次级动作（壳层按 accel 绑定按键并在 footer 提示）
 *
 * 插件只声明"能做什么"，按键映射与幂等提示由壳层统一处理；
 * 老插件不声明 actions 时行为完全不变（只有主动作）。
 */
export interface PanelAction {
  id: string;
  label: string;
  accel?: 'ctrl+enter' | 'shift+enter' | 'alt+enter';
}

/**
 * Query 模式下面板渲染项
 */
export interface PanelItem {
  id: string;
  title: string;
  description?: string;
  category?: string;
  icon?: string;
  /**
   * 请求把本行的**图片**图标放大到该 CSS px 边长（如二维码的输入即预览）。
   * 缺省 = 28px 旧行为，不声明的老条目渲染完全不变；emoji 文本图标忽略本字段。
   *
   * 为什么边长由壳层夹取（[28, 224]）而不是插件说了算：结果面板跑在 680px 宽的
   * 启动器窗口里，尺寸上限一旦交给插件，个别插件就能把主窗口撑破。
   */
  iconSize?: number;
  badge?: string;
  /**
   * 分组标题：连续同组条目共享一个小标题（空状态用「常用应用 / 最近使用 / 推荐指令」）。
   * 只影响展示与高度，不改变键盘顺序。
   */
  group?: string;
  /** 次级动作；无声明时只有主动作 */
  actions?: PanelAction[];
  /**
   * `action`（默认，可执行）| `info`（说明项，键盘导航跳过）。
   * 说明项从可导航序列里剔除，避免"按了回车没反应"的死条目。
   */
  kind?: 'action' | 'info';
  metadata?: Record<string, any>;
}

/**
 * 面板数据容器
 */
export interface PanelData {
  items: PanelItem[];
  emptyText?: string;
  /** 查询失败时的用户可读原因；壳层会渲染错误态与「重试」，优先于空态 */
  error?: string;
  /**
   * 实时刷新间隔（毫秒）：声明后面板停留期间壳层每隔该时长重跑一次 query()。
   *
   * 给“数据天然会过期”的插件用，如世界时钟（时间每秒都在变）。约定：
   * - 最小 500ms（壳层夹取，再小的值会被抬高），常用 1000；
   * - 壳层重跑时保留用户当前选中的条目（按 id 匹配），不会每秒跳回第一行；
   * - 窗口隐藏/输入变化/面板切换时自动停止，重新聚焦且面板还在时立即补一次；
   * - 纯静态数据插件**不要声明**（无谓的 CPU 与重渲染）。
   */
  live?: number;
}

/**
 * 裸文本（无斜杠）搜索扩展点（LPS-1 §4.2）
 * 取代壳层写死的"应用/CLI/网页"兜底；壳层只聚合，不理解任何具体搜索业务
 */
export interface SearchProvider {
  /** 唯一标识（如 apps.local / apps.cli / apps.web） */
  id: string;
  /** 排序优先级：越小越靠前（核心历史推荐固定为 0） */
  priority: number;
  /**
   * 空输入时是否参与聚合：
   * 声明后壳层在输入框为空时调用 `search('')`，用于「常用应用」这类
   * 无需关键词就能给出的入口；普通 provider 不声明，避免空状态被噪声塞满。
   */
  searchOnEmpty?: boolean;
  /** 检索结果（失败应自行吞错返回空数组，避免拖垮聚合） */
  search(raw: string): Promise<PanelItem[]>;
  /** 用户选中本 provider 产出的条目后的行为 */
  onSelect?(item: PanelItem, actionId?: string): Promise<AfterSelect | void>;
}

/**
 * 全局热键自报条目（`/hotkey` 速查表的一行）
 */
export interface PluginHotkey {
  /** 加速键规范形式，如 "alt+shift+s" */
  accel: string;
  /** 按下这个键会发生什么（速查表里最有价值的部分） */
  description: string;
}

/**
 * 指令插件接口契约
 */
export interface CommandPlugin {
  /** 插件唯一标识符 */
  id: string;
  /** 触发关键词，以斜杠开头，如 "/todo", "/note" */
  trigger: string;
  /** 插件中文名称 */
  name: string;
  /** 指令功能描述 */
  description: string;
  /** 插件图标（SVG 或 Emoji） */
  icon: string;

  /**
   * 别名注册：仍能**精确**敲出来，但不出现在补全候选、模糊推荐与 `/help` 清单里。
   *
   * 为什么需要：改名（`/todo` → `/cal`）时旧写法不能一刀切断，
   * 而注册表是按 trigger 建键的（`registry.ts`），一条指令要两个入口就得注册两次。
   * 不做标记的话，`/help` 和候选列表会出现两行同 id 的重复项。
   */
  hidden?: boolean;

  /**
   * 判断当前解析输入是否属于即时执行的 Action
   */
  isAction(input: ParsedInput): boolean;

  /**
   * Action 模式下是否同时渲染 query() 的候选列表
   * （如 /app add 需要在预览胶囊下方展示系统应用候选供点选）
   */
  showItemsInActionMode?: boolean;

  /**
   * query() 的防抖毫秒数（缺省 0 = 逐键立即调用）。
   *
   * 为什么需要它：壳层对指令插件的 `query()` 是**逐键调用且无防抖**的
   * （裸文本搜索那条路径才有 50ms），这对纯计算插件无害，但网络类插件
   * 会因此被迫走"先给一条『查询』项、回车才真发请求"的折中范式，
   * 代价是用户要按**两次回车**才拿到结果。
   *
   * 声明本字段后，壳层会等到用户停止输入该毫秒数才调 query()，
   * 于是网络插件可以回归"输入即出结果"。
   *
   * 建议值 250–350ms：低于 200 手速快时仍会连发，高于 500 会有明显迟滞。
   * 纯计算/本地查询插件**不要声明**（无谓地增加等待）。
   */
  queryDebounceMs?: number;

  /**
   * 参数提示：补全候选指令时展示的用法骨架（如 `[屏序号] [-d秒]`）。
   * 新用户往往不知道 `/shot -d3` 怎么写，这行提示能省掉一次试错。
   */
  argsHint?: string;

  /**
   * 真实用法示例（`/help` 面板按此渲染）。
   * 插件作者已经把语法写在 description 里了，结构化后能让新用户直接照抄。
   */
  examples?: string[];

  /**
   * 本插件占用的全局热键（自报，供 `/hotkey` 汇总成速查表）。
   *
   * 为什么是"自报"而不是读manifest：插件注册表里只有CommandPlugin，
   * 拿不到 manifest.permissions；而宿主侧 `shortcut:<accel>` 是**逐条静态声明**
   * 的（运行时无法动态追加，否则任何插件都能抢注任意组合键）。
   * 于是"谁能按哪些键"这件事由插件自己讲，`/hotkey` 只做汇总展示。
   *
   * 注意：这里填的是**已实际注册成功**的热键，注册失败（被占用）时不应上报，
   * 否则速查表会教用户按一个不生效的键。
   */
  hotkeys?: PluginHotkey[];

  /**
   * 获取即时执行的实时语义预览胶囊（若返回 null 则不显示胶囊）
   */
  getPreview?(input: ParsedInput): ActionPreviewCapsule | null;

  /**
   * 输入增强钩子：插件专属语法（如 todo 的时间/重复规则）在此解析为
   * namedArgs 并清洗参数列表；核心解析器只负责通用分词与触发词路由
   */
  enrichParsed?(tokens: string[], input: ParsedInput): Partial<ParsedInput>;

  /**
   * 执行即时动作（如 /todo new）
   */
  execute?(input: ParsedInput): Promise<{ success: boolean; message: string }>;

  /**
   * 查询模式：展开面板并返回匹配列表（如 /note xxx, /todo）
   */
  query?(input: ParsedInput): Promise<PanelData>;

  /**
   * 用户在面板中敲击回车或点击某项后的回调
   * 返回 AfterSelect 声明壳层后续行为（关窗/清空/提示/刷新）
   */
  onSelect?(item: PanelItem, actionId?: string): Promise<AfterSelect | void>;
}
