/**
 * 展示层的纯逻辑（可单测）
 *
 * 抽成 .ts 的原因：项目约定——测试脚手架对 `.ts` 递归转译，`.tsx` 只能返回空模块。
 * 这里放"怎么把一条历史变成一行面板项"的判断逻辑，最容易出问题的
 * 多行折叠与时间描述放这里，就能被断言覆盖。
 */

/** 单行预览的最大字符数（超出会挤掉整行可读性） */
export const PREVIEW_MAX = 90;

/** 多行文本压成单行预览：换行/回车/制表统一成 ⏎ 与空格 */
export function toSingleLine(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '⏎')
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** 截断到 PREVIEW_MAX 字符，带省略号 */
export function preview(text: string, max = PREVIEW_MAX): string {
  const flat = toSingleLine(text);
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/** 相对时间描述（比绝对时间戳更好读，且不依赖时区） */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return `${Math.floor(day / 30)} 个月前`;
}

/** 条目体积提示：让用户知道这条内容有多大，避免盲选一段超长文本 */
export function sizeHint(text: string): string {
  const len = text.length;
  if (len <= 64) return '短';
  if (len <= 512) return `${len} 字符`;
  return `${len} 字符（较长）`;
}

/** 是否是多行内容（多行在面板里折叠成单行预览，标注出来更好预期） */
export function isMultiline(text: string): boolean {
  return /\r\n?|\n/.test(text);
}
