/**
 * LiteLauncher 输入分词与语法分析工具
 */

/**
 * 一个 token 及其是否来自引号包裹。
 *
 * `text` 仍是去掉引号的裸词（所有既有调用方拿到的语义不变），
 * `quoted` 只给需要"引号内不解析"的语法用（如 /cal 的自然语言时间）。
 */
export interface InputToken {
  text: string;
  quoted: boolean;
}

/**
 * 将命令行字符串分词为 Token 数组，自动处理单/双引号及中文引号包裹的字符串
 *
 * 示例：
 * 输入: `/todo new "中午吃饭" 11:30`
 * 输出: `[{text:"/todo"},{text:"new"},{text:"中午吃饭",quoted:true},{text:"11:30"}]`
 */
export function tokenizeInputDetailed(raw: string): InputToken[] {
  const tokens: InputToken[] = [];
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  let currentToken = '';
  let tokenQuoted = false;
  let inQuote = false;
  let quoteChar = '';

  const pushToken = () => {
    if (currentToken.length > 0) {
      tokens.push({ text: currentToken, quoted: tokenQuoted });
    }
    currentToken = '';
    tokenQuoted = false;
  };

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    // 检测引号开始与结束（兼容英文双引号、单引号与中文双引号）
    if ((char === '"' || char === "'" || char === '“' || char === '”') && !inQuote) {
      inQuote = true;
      tokenQuoted = true;
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
      pushToken();
      continue;
    }

    currentToken += char;
  }

  pushToken();
  return tokens;
}

/** 只取裸词的兼容入口（避免一次性改所有调用方） */
export function tokenizeInput(raw: string): string[] {
  return tokenizeInputDetailed(raw).map((token) => token.text);
}

