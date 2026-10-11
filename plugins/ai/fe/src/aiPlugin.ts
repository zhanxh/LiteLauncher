import { CommandPlugin, ParsedInput, getPluginContext } from '@ll/sdk';

const ctx = getPluginContext('ai');

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** /ai 指令：任意输入进入 Action 模式，回车打开对话窗口（prompt 作为初始提问） */
export const aiPlugin: CommandPlugin = {
  id: 'ai',
  trigger: '/ai',
  name: 'AI 对话',
  description: 'AI 对话助手：/ai 提示词 打开对话窗口（OpenAI 兼容接口，流式输出；首次使用需配置 API Key）',
  icon: '🤖',

  isAction(_input: ParsedInput): boolean {
    return true;
  },

  getPreview(input: ParsedInput) {
    const prompt = input.args.join(' ').trim();
    return {
      title: 'AI 对话',
      detail: prompt || '打开对话窗口',
      badge: '即时动作',
      hint: '按 Enter 打开对话窗口',
    };
  },

  async execute(input: ParsedInput) {
    if (!isTauri()) return { success: true, message: '[预览模式] 打开 AI 对话' };
    try {
      await ctx.call('open_chat', { prompt: input.args.join(' ').trim() });
      return { success: true, message: 'AI 对话已打开' };
    } catch (err: any) {
      return { success: false, message: `打开失败: ${err?.message || err}` };
    }
  },
};
