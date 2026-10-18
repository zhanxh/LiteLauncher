/**
 * @ll/plugin-cron —— /cron 表达式解析（纯前端，WP-15）
 *
 * 输出与旧 Python 版一致：含义行 + 5 个未来触发时间；不做调度。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';
import { evaluateCron, type CronRun } from './cron';

const PLUGIN_ID = 'cron';

function fullText(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  if (sub) return [sub, ...(input.args ?? [])].join(' ').trim();
  return (input.queryText ?? '').trim();
}

function hintItems(): PanelItem[] {
  return [
    {
      id: `${PLUGIN_ID}:hint`,
      title: '输入 5 段 cron 表达式',
      description: '分 时 日 月 周，如 0 9 * * 1-5',
      badge: '用法',
      icon: '⏰',
    },
    { id: `${PLUGIN_ID}:ex1`, title: '0 9 * * 1-5', description: '工作日 09:00', badge: '示例', icon: '⏰' },
    { id: `${PLUGIN_ID}:ex2`, title: '*/15 * * * *', description: '每 15 分钟', badge: '示例', icon: '⏰' },
    { id: `${PLUGIN_ID}:ex3`, title: '0 0 1 * *', description: '每月 1 日 00:00', badge: '示例', icon: '⏰' },
  ];
}

function runItem(run: CronRun, index: number): PanelItem {
  return {
    id: `${PLUGIN_ID}:n${index}`,
    title: run.text,
    description: run.weekday,
    badge: `+${index + 1}`,
    icon: '🕒',
    metadata: { value: run.seconds, label: '触发时间' },
  };
}

export const cronPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/cron',
  name: 'Cron 解析',
  description:
    'Cron 表达式解析：/cron 0 9 * * 1-5 输出人类可读描述与未来 5 次触发时间；支持 */n、a-b、列表与 @daily 等宏。纯前端，无需 Python。',
  icon: '⏰',
  argsHint: '5 段表达式',
  examples: ['/cron 0 9 * * 1-5', '/cron */15 * * * *', '/cron @daily'],

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const text = fullText(input);
    if (!text) {
      return { items: hintItems(), emptyText: '输入 cron 表达式' };
    }

    const result = evaluateCron(text);
    if (!result.ok) {
      return {
        items: [
          {
            id: `${PLUGIN_ID}:err`,
            title: result.title,
            description: result.detail,
            badge: '错误',
            icon: '❌',
            kind: 'info',
            metadata: result.expr ? { value: result.expr, label: 'cron 表达式' } : {},
          },
        ],
        emptyText: '格式错误',
      };
    }

    const items: PanelItem[] = [
      {
        id: `${PLUGIN_ID}:desc`,
        title: result.desc.slice(0, 76),
        description: `表达式：${result.expr}`,
        badge: '含义',
        icon: '⏰',
        metadata: { value: result.expr, label: 'cron 表达式' },
      },
      {
        id: `${PLUGIN_ID}:next`,
        title: '未来 5 次触发',
        description: '按本地时区计算',
        badge: '计划',
        icon: '📅',
        kind: 'info',
      },
      ...result.runs.map(runItem),
    ];
    return { items, emptyText: '无结果' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制 ${item.metadata?.label ?? '结果'}` };
  },
};

export function setup(): void {
  pluginRegistry.register(cronPlugin);
}
