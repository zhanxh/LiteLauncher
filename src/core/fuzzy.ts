/**
 * LiteLauncher 轻量模糊匹配与拼音简写工具
 */

// 常用汉字拼音首字母映射表（常见词汇首字母快速索引）
const PINYIN_INITIALS_MAP: Record<string, string> = {
  '计': 'j', '算': 's', '器': 'q',
  '记': 'j', '事': 's', '本': 'b',
  '代': 'd', '码': 'm', '编': 'b', '辑': 'j',
  '终': 'z', '端': 'd', '命': 'm', '令': 'l', '行': 'h',
  '谷': 'g', '歌': 'g', '浏': 'l', '览': 'l',
  '待': 'd', '办': 'b', '项': 'x',
  '笔': 'b', '文': 'w', '档': 'd',
  '帮': 'b', '助': 'z', '指': 'z', '南': 'n',
  '应': 'y', '用': 'y', '启': 'q', '动': 'd',
};

/**
 * 获取中文字符串的拼音首字母缩写
 * 例如: "计算器" -> "jsq"
 */
export function getPinyinInitials(text: string): string {
  let initials = '';
  for (const char of text) {
    if (PINYIN_INITIALS_MAP[char]) {
      initials += PINYIN_INITIALS_MAP[char];
    } else if (/[a-zA-Z0-9]/.test(char)) {
      initials += char.toLowerCase();
    }
  }
  return initials;
}

/**
 * 模糊匹配计算相关性得分
 * 返回得分 > 0 表示匹配，数字越大相关度越高
 */
export function fuzzyScore(target: string, query: string): number {
  const t = target.toLowerCase();
  const q = query.toLowerCase().trim();

  if (!q) return 1;
  // 1. 完全一致
  if (t === q) return 100;
  // 2. 前缀完全匹配
  if (t.startsWith(q)) return 80;
  // 3. 包含子串
  if (t.includes(q)) return 60;

  // 4. 拼音首字母匹配
  const pinyin = getPinyinInitials(target);
  if (pinyin && pinyin.includes(q)) return 50;

  // 5. 字符间歇匹配
  let score = 0;
  let tIdx = 0;
  for (let qIdx = 0; qIdx < q.length; qIdx++) {
    const char = q[qIdx];
    const foundIdx = t.indexOf(char, tIdx);
    if (foundIdx === -1) return 0;
    tIdx = foundIdx + 1;
    score += 10;
  }

  return score;
}
