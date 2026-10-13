/**
 * @ll/plugin-json —— /json JSON 工具（纯前端插件，backend.kind = "none"）
 *
 * 无 Rust crate、无 sidecar：解析与格式化都在本文件，只依赖 @ll/sdk。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';

const PLUGIN_ID = 'json';

/** 可显式指定的子命令；不在此列时，`subcommand` 视为待解析的 JSON 正文 */
const MODES = ['pretty', 'minify', 'escape', 'unescape', 'summary'] as const;
type Mode = (typeof MODES)[number];

const MODE_LABEL: Record<Mode, string> = {
  pretty: '美化（2 空格缩进）',
  minify: '压缩为单行',
  escape: '转义为字符串字面量',
  unescape: '反转义回 JSON',
  summary: '结构摘要',
};

function fullText(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  const args = input.args ?? [];
  if (sub && !(MODES as readonly string[]).includes(sub)) {
    return [sub, ...args].join(' ').trim();
  }
  if (sub) return args.join(' ').trim();
  return (input.queryText ?? '').trim();
}

function makeItem(id: string, title: string, description: string, badge: string, copy?: string): PanelItem {
  return {
    id: `${PLUGIN_ID}:${id}`,
    title,
    description,
    badge,
    icon: '🧾',
    metadata: copy === undefined ? {} : { value: copy },
  };
}

/** 递归求最大嵌套深度（标量记 0） */
function depth(v: unknown): number {
  if (Array.isArray(v)) return 1 + v.reduce<number>((m, x) => Math.max(m, depth(x)), 0);
  if (v && typeof v === 'object') {
    return 1 + Object.values(v as Record<string, unknown>).reduce<number>((m, x) => Math.max(m, depth(x)), 0);
  }
  return 0;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `数组 · ${v.length} 项 · 深度 ${depth(v)}`;
  switch (typeof v) {
    case 'object':
      return `对象 · ${Object.keys(v as object).length} 个键 · 深度 ${depth(v)}`;
    case 'string':
      return `字符串 · ${v.length} 字符`;
    default:
      return `${typeof v} · ${String(v)}`;
  }
}

export const jsonPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/json',
  name: 'JSON 工具',
  description: 'JSON 工具：/json {…} 解析并给出美化/压缩/转义结果与结构摘要；解析失败会指出错误位置。回车复制结果。',
  icon: '🧾',

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const sub = (input.subcommand ?? '').trim().toLowerCase();
    const mode = (MODES as readonly string[]).includes(sub) ? (sub as Mode) : undefined;
    const text = fullText(input);

    if (!text) {
      return {
        items: [
          makeItem(
            'hint',
            '粘贴要处理的 JSON',
            `例：/json {"a":1}；也可指定 ${MODES.join(' / ')}`,
            '用法',
          ),
        ],
        emptyText: '粘贴 JSON',
      };
    }

    const parsed = ((): { ok: true; value: unknown } | { ok: false; message: string } => {
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    })();
    if (!parsed.ok) {
      return {
        items: [makeItem('err', `解析失败：${parsed.message}`, '请检查引号、逗号与括号是否配对', '错误')],
        emptyText: '无法解析',
      };
    }
    const value = parsed.value;

    const produce: Record<Mode, () => string> = {
      pretty: () => JSON.stringify(value, null, 2),
      minify: () => JSON.stringify(value),
      escape: () => JSON.stringify(JSON.stringify(value)).slice(1, -1),
      unescape: () => {
        const inner = typeof value === 'string' ? value : JSON.stringify(value);
        return JSON.stringify(JSON.parse(inner));
      },
      summary: () => describe(value),
    };

    const modes: Mode[] = mode ? [mode] : ['pretty', 'minify', 'escape', 'summary'];
    const items: PanelItem[] = [];
    for (const m of modes) {
      let out: string;
      try {
        out = produce[m]();
      } catch {
        continue;
      }
      if (!out) continue;
      items.push(
        makeItem(m, out.replace(/\r?\n/g, ' ').slice(0, 76), MODE_LABEL[m], m, out),
      );
    }
    items.push(
      makeItem('stats', `${text.length} 字符 / ${describe(value)}`, '输入规模', '规模'),
    );
    return { items, emptyText: '无可输出结果' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制（${item.badge ?? '结果'}）` };
  },
};

export function setup(): void {
  pluginRegistry.register(jsonPlugin);
}
