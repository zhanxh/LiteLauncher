/**
 * 分类日历（个人日程的"文件夹"）：颜色与可见性都在这层收口，
 * 月/周/日三视图共用同一份勾选状态，切换视图不用重新拉列表。
 */

export interface CalendarMeta {
  id: string;
  name: string;
  color: string;
  sort: number;
}

/** 分类被删除后日程的 calendar_id 归 NULL，前端渲染成"未分类"而不是丢掉 */
export const UNCLASSIFIED = '';

export const UNCLASSIFIED_LABEL = '未分类';

/** 兜底色：拿不到分类信息时不让色块变成 transparent */
export const FALLBACK_COLOR = '#8a8f98';

export function colorOf(calendars: CalendarMeta[], calendarId: string | null): string {
  if (!calendarId) return FALLBACK_COLOR;
  return calendars.find((c) => c.id === calendarId)?.color ?? FALLBACK_COLOR;
}

export function nameOf(calendars: CalendarMeta[], calendarId: string | null): string {
  if (!calendarId) return UNCLASSIFIED_LABEL;
  return calendars.find((c) => c.id === calendarId)?.name ?? UNCLASSIFIED_LABEL;
}

/**
 * hex → 带透明度的 rgba 底色。
 * 分类色是用户选的，不能假设它自带透明度；月历格子上要的是"浅底 + 实色左条"。
 */
export function soften(hex: string, alpha: number): string {
  const body = hex.trim().replace(/^#/, '');
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body.padEnd(6, '0').slice(0, 6);
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(138,143,152,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** 勾选集合的不可变增删（Set 直接改不会触发 Solid 更新） */
export function toggleId(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
