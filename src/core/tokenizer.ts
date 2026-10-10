/**
 * LiteLauncher 输入分词与语法分析工具
 */

/**
 * 将命令行字符串分词为 Token 数组，自动处理单/双引号及中文引号包裹的字符串
 * 
 * 示例：
 * 输入: `/todo new "中午吃饭" 11:30`
 * 输出: `["/todo", "new", "中午吃饭", "11:30"]`
 */
export function tokenizeInput(raw: string): string[] {
  const tokens: string[] = [];
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  let currentToken = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    // 检测引号开始与结束（兼容英文双引号、单引号与中文双引号）
    if ((char === '"' || char === "'" || char === '“' || char === '”') && !inQuote) {
      inQuote = true;
      quoteChar = char === '“' ? '”' : char;
      continue;
    }

    if (inQuote && char === quoteChar) {
      inQuote = false;
      quoteChar = '';
      continue;
    }

    // 在引号外遇到空格，则完成当前 Token 的收集
    if (!inQuote && /\s/.test(char)) {
      if (currentToken.length > 0) {
        tokens.push(currentToken);
        currentToken = '';
      }
      continue;
    }

    currentToken += char;
  }

  // 推入最后一个未结束的 Token
  if (currentToken.length > 0) {
    tokens.push(currentToken);
  }

  return tokens;
}

/**
 * 从分词参数中提取时间表达式
 * 支持三种格式：
 * - `HH:MM`（或带秒 `HH:MM:SS`）
 * - `YYYY-MM-DD`（当天默认 09:00）
 * - `YYYY-MM-DD HH:MM`（日期与时间可为相邻两个 Token，或引号包裹为一个 Token）
 * 以及重复规则关键词（daily、weekly、fri 等）
 */
export function extractTimeAndRule(args: string[]): {
  cleanArgs: string[];
  time?: string;
  repeatRule?: string;
} {
  const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
  const dateRegex = /^\d{4}-\d{1,2}-\d{1,2}$/;
  const dateTimeRegex = /^\d{4}-\d{1,2}-\d{1,2}[ T]([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
  const repeatKeywords = ['daily', 'weekly', 'fri', 'mon', 'tue', 'wed', 'thu', 'sat', 'sun'];

  let time: string | undefined;
  let repeatRule: string | undefined;
  const cleanArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const lower = arg.toLowerCase();

    if (dateTimeRegex.test(arg)) {
      // 单 Token 的完整日期时间（如引号包裹 "2026-10-11 14:30"）
      time = arg.replace('T', ' ');
    } else if (dateRegex.test(arg)) {
      // 日期 Token：若紧随其后是时间 Token，则合并为完整日期时间
      if (i + 1 < args.length && timeRegex.test(args[i + 1])) {
        time = `${arg} ${args[i + 1]}`;
        i++;
      } else {
        time = arg;
      }
    } else if (timeRegex.test(arg)) {
      time = arg;
    } else if (repeatKeywords.includes(lower)) {
      repeatRule = lower;
    } else {
      cleanArgs.push(arg);
    }
  }

  return { cleanArgs, time, repeatRule };
}
