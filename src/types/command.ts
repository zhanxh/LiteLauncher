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
 * Query 模式下面板渲染项
 */
export interface PanelItem {
  id: string;
  title: string;
  description?: string;
  category?: string;
  icon?: string;
  badge?: string;
  metadata?: Record<string, any>;
}

/**
 * 面板数据容器
 */
export interface PanelData {
  items: PanelItem[];
  emptyText?: string;
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
   * 判断当前解析输入是否属于即时执行的 Action
   */
  isAction(input: ParsedInput): boolean;

  /**
   * Action 模式下是否同时渲染 query() 的候选列表
   * （如 /app add 需要在预览胶囊下方展示系统应用候选供点选）
   */
  showItemsInActionMode?: boolean;

  /**
   * 获取即时执行的实时语义预览胶囊（若返回 null 则不显示胶囊）
   */
  getPreview?(input: ParsedInput): ActionPreviewCapsule | null;

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
   */
  onSelect?(item: PanelItem): Promise<void>;
}
