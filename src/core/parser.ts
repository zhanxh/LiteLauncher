import { ParsedInput, CommandPlugin } from '@ll/sdk';
import { tokenizeInputDetailed } from './tokenizer';
import { pluginRegistry } from '@ll/sdk';
import { fuzzyScore } from './fuzzy';

/**
 * 指令解析结果包装
 */
export interface ParseResult {
  parsed: ParsedInput;
  plugin?: CommandPlugin;
  candidatePlugins: CommandPlugin[];
  isMathExpression: boolean;
  mathResult?: string;
}

/**
 * 尝试评估是否为简单的数学表达式计算
 */
function tryEvaluateMath(text: string): string | undefined {
  const trimmed = text.trim();
  // 仅允许基本数学运算符与数字
  if (!/^[\d\s\+\-\*\/\(\)\.\%\^]+$/.test(trimmed)) {
    return undefined;
  }
  // 必须至少包含一个数字和一个运算符号
  if (!/[\d]/.test(trimmed) || !/[\+\-\*\/\%\^]/.test(trimmed)) {
    return undefined;
  }

  try {
    const sanitized = trimmed.replace(/\^/g, '**');
    const result = new Function(`return (${sanitized});`)();
    if (typeof result === 'number' && !Number.isNaN(result) && Number.isFinite(result)) {
      return Number.isInteger(result) ? result.toString() : result.toFixed(4).replace(/\.?0+$/, '');
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 指令解析核心路由器
 */
export function parseCommand(rawInput: string): ParseResult {
  const raw = rawInput.trim();
  const detailedTokens = tokenizeInputDetailed(rawInput);
  const tokens = detailedTokens.map((token) => token.text);

  // 1. 尝试数学表达式计算
  const mathResult = tryEvaluateMath(raw);
  if (mathResult !== undefined) {
    return {
      parsed: {
        raw,
        trigger: '',
        args: [],
        namedArgs: {},
        isAction: false,
        queryText: raw,
      },
      candidatePlugins: [],
      isMathExpression: true,
      mathResult,
    };
  }

  // 2. 空输入处理
  if (tokens.length === 0) {
    return {
      parsed: {
        raw: '',
        trigger: '',
        args: [],
        namedArgs: {},
        isAction: false,
        queryText: '',
      },
      candidatePlugins: pluginRegistry.getAll(),
      isMathExpression: false,
    };
  }

  const firstToken = tokens[0];
  const isTrigger = firstToken.startsWith('/');

  // 3. 非斜杠开头的输入：检测是否命中无斜杠别名（如直接输入 "todo" 或 "notes"）
  if (!isTrigger) {
    const directMatch = pluginRegistry.get('/' + firstToken);
    if (directMatch && tokens.length > 1) {
      // 类似 "todo new 开会" -> 自动规范化为 "/todo new 开会"
      return parseCommand('/' + rawInput);
    }

    // 模糊匹配候选指令（例如输入 "td" 推荐 /todo）
    const allPlugins = pluginRegistry.getAll();
    const scoredCandidates = allPlugins
      .map((p) => {
        const score = Math.max(
          fuzzyScore(p.id, firstToken),
          fuzzyScore(p.name, firstToken),
          fuzzyScore(p.trigger.replace('/', ''), firstToken)
        );
        return { plugin: p, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.plugin);

    if (scoredCandidates.length > 0) {
      return {
        parsed: {
          raw,
          trigger: '',
          args: tokens,
          namedArgs: {},
          isAction: false,
          queryText: raw,
        },
        candidatePlugins: scoredCandidates,
        isMathExpression: false,
      };
    }

    return {
      parsed: {
        raw,
        trigger: '',
        args: tokens,
        namedArgs: {},
        isAction: false,
        queryText: raw,
      },
      candidatePlugins: [],
      isMathExpression: false,
    };
  }

  // 4. 以斜杠开头的指令解析
  const matchedPlugin = pluginRegistry.get(firstToken);
  const remainingTokens = tokens.slice(1);

  // 若未完全输入（例如输入 "/t"），执行基于模糊匹配的候选推荐
  if (!matchedPlugin) {
    const cleanPrefix = firstToken.replace('/', '');
    const allPlugins = pluginRegistry.getAll();
    const candidates = allPlugins
      .map((p) => {
        const score = Math.max(
          fuzzyScore(p.trigger.replace('/', ''), cleanPrefix),
          fuzzyScore(p.name, cleanPrefix),
          fuzzyScore(p.id, cleanPrefix)
        );
        return { plugin: p, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.plugin);

    return {
      parsed: {
        raw,
        trigger: firstToken,
        args: remainingTokens,
        namedArgs: {},
        isAction: false,
        queryText: remainingTokens.join(' '),
      },
      candidatePlugins: candidates,
      isMathExpression: false,
    };
  }

  // 提取子命令与参数
  let subcommand: string | undefined;
  let paramTokens = [...remainingTokens];

  if (paramTokens.length > 0 && !paramTokens[0].startsWith('-')) {
    subcommand = paramTokens[0];
    paramTokens = paramTokens.slice(1);
  }

  const parsedInput: ParsedInput = {
    raw,
    trigger: matchedPlugin.trigger,
    subcommand,
    args: paramTokens,
    quotedArgs: detailedTokens
      .slice(tokens.length - paramTokens.length)
      .map((token) => token.quoted),
    namedArgs: {},
    isAction: false,
    queryText: remainingTokens.join(' '),
  };

  // 插件专属语法增强（如 todo 的时间/重复规则）；核心不做任何插件特有解析
  if (matchedPlugin.enrichParsed) {
    Object.assign(parsedInput, matchedPlugin.enrichParsed(paramTokens, parsedInput));
  }

  parsedInput.isAction = matchedPlugin.isAction(parsedInput);

  return {
    parsed: parsedInput,
    plugin: matchedPlugin,
    candidatePlugins: [],
    isMathExpression: false,
  };
}
