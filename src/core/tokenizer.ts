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

