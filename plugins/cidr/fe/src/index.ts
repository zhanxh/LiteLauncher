/**
 * @ll/plugin-cidr —— /cidr 网段计算（纯前端，WP-15）
 *
 * 字段与旧 Python 版一致：网络/前缀/广播/掩码/反掩码/可用范围/主机数/
 * 首末地址/总数/属性，以及可选的子网拆分。
 */
import {
  pluginRegistry,
  type AfterSelect,
  type CommandPlugin,
  type PanelData,
  type PanelItem,
  type ParsedInput,
} from '@ll/sdk';
import { analyzeCidr } from './cidr';

const PLUGIN_ID = 'cidr';

function fullText(input: ParsedInput): string {
  const sub = (input.subcommand ?? '').trim();
  if (sub) return [sub, ...(input.args ?? [])].join(' ').trim();
  return (input.queryText ?? '').trim();
}

function makeItem(
  id: string,
  title: string,
  description: string,
  badge: string,
  icon: string,
  value?: string,
  label?: string,
): PanelItem {
  return {
    id: `${PLUGIN_ID}:${id}`,
    title,
    description,
    badge,
    icon,
    metadata: value === undefined ? {} : { value, label },
  };
}

export const cidrPlugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/cidr',
  name: 'CIDR / 网段计算',
  description:
    '网段计算：/cidr 192.168.1.0/24 输出网络地址、广播地址、掩码、可用主机范围与数量；/cidr 10.0.0.0/24 4 拆分子网。支持 IPv6。纯前端，无需 Python。',
  icon: '🌐',
  argsHint: 'IP/网段 [拆分数]',
  examples: ['/cidr 192.168.1.0/24', '/cidr 10.0.0.0/24 4', '/cidr 2001:db8::/32'],

  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    const text = fullText(input);
    if (!text) {
      return {
        items: [
          makeItem(
            'hint',
            '输入 IP 或网段',
            '例：/cidr 192.168.1.0/24、/cidr 10.0.0.0/24 4、/cidr 2001:db8::/32',
            '用法',
            '🌐',
          ),
        ],
        emptyText: '输入 IP 或网段',
      };
    }

    const result = analyzeCidr(text);
    if (!result.ok) {
      return {
        items: [makeItem('err', '无法识别的 IP/网段', result.error, '错误', '❌')],
        emptyText: '无法识别',
      };
    }

    const d = result.data;
    const items: PanelItem[] = [
      makeItem('network', d.network, '网络地址', '网络', '🌐', d.network, '网络地址'),
      makeItem('prefix', `/${d.prefix}`, `前缀长度（IPv${d.version}）`, '前缀', '📏', `/${d.prefix}`, '前缀长度'),
    ];

    if (d.version === 4) {
      items.push(
        makeItem('broadcast', d.broadcast!, '广播地址', '广播', '📢', d.broadcast!, '广播地址'),
        makeItem('mask', d.netmask!, '子网掩码', '掩码', '🧱', d.netmask!, '子网掩码'),
        makeItem('wildcard', d.hostmask!, '反掩码（wildcard）', '反掩码', '🧱', d.hostmask!, '反掩码'),
        makeItem('range', d.range!, '可用主机范围', '范围', '🔢', d.range!.replace(' – ', ' - '), '可用主机范围'),
        makeItem('hosts', d.hosts!, '可用主机数', '主机数', '#️⃣', d.hosts!, '可用主机数'),
      );
    } else {
      items.push(
        makeItem('first', d.first, '首个地址', '首地址', '🔢', d.first, '首个地址'),
        makeItem('last', d.last, '末个地址', '末地址', '🔢', d.last, '末个地址'),
      );
    }

    items.push(
      makeItem('total', d.total, '地址总数', '总数', '#️⃣', d.total, '地址总数'),
      makeItem('scope', d.scope, `IPv${d.version}`, '属性', '🏷️'),
    );

    if (d.hadHostBits) {
      items.splice(1, 0, makeItem('note', d.network, '输入含主机位，已按网段归一化', '提示', 'ℹ️'));
    }

    if (d.split) {
      items.push(
        makeItem(
          'split',
          `拆分为 ${d.split.count} 个子网`,
          `新前缀 /${d.split.prefix}`,
          '拆分',
          '✂️',
        ),
      );
      d.split.subnets.slice(0, 20).forEach((subnet, index) => {
        items.push(
          makeItem(
            `s${index}`,
            subnet,
            `第 ${index + 1} 个`,
            `#${index + 1}`,
            '🌐',
            subnet,
            `子网 ${index + 1}`,
          ),
        );
      });
    }

    return { items, emptyText: '无结果' };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '该项无内容可复制' };
    return { copy: value, toast: `已复制 ${item.metadata?.label ?? '结果'}` };
  },
};

export function setup(): void {
  pluginRegistry.register(cidrPlugin);
}
