/**
 * 轻量 Markdown 解析预览（遵循 KISS 原则，支持常用排版）。
 *
 * 原实现内联在 NoteEditor 里；管理面板（目录树 + 编辑预览）复用同一渲染，
 * 抽到此共享模块。标题写入顺序锚点 id（md-anchor-N），大纲目录按同一序号
 * 生成（extractToc），点击目录项即可滚动预览定位（图5 的「目录」面板）。
 */

export interface TocEntry {
  /** 与渲染出的标题元素 id 一致（md-anchor-N） */
  anchor: string;
  /** 标题级别 1-6 */
  level: number;
  /** 标题文本（未渲染的原始行内容） */
  text: string;
}

export function renderMarkdownPreview(markdown: string): string {
  let html = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 解析标题：单趟扫描，按 # 数量定级别并写入顺序锚点
  let anchorSeq = 0;
  html = html.replace(/^(#{1,6}) (.*)$/gm, (_m, hashes: string, text: string) => {
    anchorSeq += 1;
    return `<h${hashes.length} id="md-anchor-${anchorSeq}">${text}</h${hashes.length}>`;
  });

  // 解析粗体与斜体
  html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');

  // 解析行内代码
  html = html.replace(/`([^`]+)`/gim, '<code>$1</code>');

  // 解析引用
  html = html.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

  // 解析无序列表
  html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');

  // 换行替换
  html = html.replace(/\n\n/gim, '<p></p>');
  html = html.replace(/\n/gim, '<br/>');

  return html;
}

/** 从 Markdown 源码提取标题大纲（与渲染锚点同序号，逐行自上而下） */
export function extractToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
  let seq = 0;
  for (const line of markdown.split('\n')) {
    const m = /^(#{1,6}) (.*)$/.exec(line.trimEnd());
    if (m) {
      seq += 1;
      entries.push({ anchor: `md-anchor-${seq}`, level: m[1].length, text: m[2].trim() });
    }
  }
  return entries;
}
