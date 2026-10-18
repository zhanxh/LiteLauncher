/**
 * 把底层错误翻译成用户能行动的一句话。
 *
 * 壳层不理解插件语义，但能识别几类高频失败：缺 Python、网络超时、权限不足。
 * 原始信息不丢——调用方同时 console.error，面板只显示可行动的建议。
 */
export function toUserMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const lower = raw.toLowerCase();

  if (/llp_python|python|解释器|interpreter/.test(lower)) {
    return '该插件需要 Python 3：打开「设置 → Python 环境」配置解释器后重试';
  }
  if (/timeout|timed out|network|fetch failed|dns|proxy|连接|网络/.test(lower)) {
    return '网络超时或不可用，检查代理/网络后重试';
  }
  if (/permission|权限|denied|未声明权限/.test(lower)) {
    const perm = /(?:权限[:：]?\s*|permission denied:\s*)([a-z][a-z0-9:_-]*)/i.exec(raw)?.[1];
    return perm ? `插件缺少权限：${perm}` : '插件权限不足，请检查 manifest 权限声明';
  }
  if (/not found|不存在|unknown method|未知方法|不可用/.test(lower)) {
    return '插件暂不可用（可能未安装或被禁用），重启后再试';
  }
  return '操作失败，请稍后重试；详情已写入日志';
}

/** 原始错误，仅用于日志/控制台，不要直接展示给用户 */
export function rawError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err ?? '');
}
