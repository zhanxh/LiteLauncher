/**
 * /time 世界时钟（WP-15：Python zoneinfo → Intl.DateTimeFormat）
 *
 * 时区数据由 WebView 的 Intl 提供；拿不到某个 IANA 时区时退回固定偏移，
 * 与旧 Python 版一样标注"夏令时可能不准"，不静默给错时间。
 *
 * 本文件同时是面板与桌面时钟视图（clock.tsx）的共享数据层：
 * 时区换算（zoneParts/zoneOffsetMinutes）、UTC 偏移文案（utcOffsetLabel）、
 * 本机时区名（localZoneName）都从这里出，保证两处口径一致。
 */

export interface City {
  name: string;
  iana: string;
  fallback: number;
}

export const CITIES: City[] = [
  { name: '北京', iana: 'Asia/Shanghai', fallback: 8 },
  { name: '东京', iana: 'Asia/Tokyo', fallback: 9 },
  { name: '首尔', iana: 'Asia/Seoul', fallback: 9 },
  { name: '新加坡', iana: 'Asia/Singapore', fallback: 8 },
  { name: '迪拜', iana: 'Asia/Dubai', fallback: 4 },
  { name: '伦敦', iana: 'Europe/London', fallback: 0 },
  { name: '巴黎', iana: 'Europe/Paris', fallback: 1 },
  { name: '柏林', iana: 'Europe/Berlin', fallback: 1 },
  { name: '莫斯科', iana: 'Europe/Moscow', fallback: 3 },
  { name: '纽约', iana: 'America/New_York', fallback: -5 },
  { name: '洛杉矶', iana: 'America/Los_Angeles', fallback: -8 },
  { name: '圣保罗', iana: 'America/Sao_Paulo', fallback: -3 },
  { name: '开罗', iana: 'Africa/Cairo', fallback: 2 },
  { name: '悉尼', iana: 'Australia/Sydney', fallback: 10 },
];

const pad = (n: number) => String(n).padStart(2, '0');

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zoneParts(date: Date, iana: string): ZoneParts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: iana,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const values: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    // 某些 ICU 版本把午夜格式化成 24
    hour: values.hour === 24 ? 0 : values.hour,
    minute: values.minute,
    second: values.second,
  };
}

/** 指定 IANA 时区相对 UTC 的偏移分钟数（含夏令时） */
export function zoneOffsetMinutes(date: Date, iana: string): number {
  const p = zoneParts(date, iana);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** "UTC+10" / "UTC+10:30" / "UTC-5" 形式的偏移文案（桌面时钟用） */
export function utcOffsetLabel(diffMinutes: number): string {
  const sign = diffMinutes < 0 ? '−' : '+';
  const abs = Math.abs(diffMinutes);
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return mins === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${pad(mins)}`;
}

function offsetLabel(diffMinutes: number): string {
  const hours = diffMinutes / 60;
  if (Math.abs(hours) < 0.01) return '与本地同时';
  const sign = hours > 0 ? '+' : '−';
  const abs = Math.abs(hours);
  const text = abs === Math.floor(abs) ? `${sign}${abs}` : `${sign}${abs.toFixed(1)}`;
  return `本地 ${text} 小时`;
}

function fixedZoneParts(date: Date, fallbackHours: number): ZoneParts {
  const d = new Date(date.getTime() + fallbackHours * 3600_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

export interface CityTime {
  name: string;
  /** IANA 时区名（弹桌面时钟的 tz 参数） */
  iana: string;
  /** Intl 不认识 iana 时退回的固定偏移小时数（弹窗的 fb 参数） */
  fallbackHours: number;
  time: string;
  date: string;
  offset: string;
  value: string;
  fallback: boolean;
}

function cityTime(now: Date, city: City): CityTime {
  let parts: ZoneParts;
  let real = true;
  let offset = 0;
  try {
    parts = zoneParts(now, city.iana);
    offset = zoneOffsetMinutes(now, city.iana);
    // Intl 可能接受但返回错误的时区；用偏移是否接近 fallback 没法判断，只能信任
  } catch {
    real = false;
    parts = fixedZoneParts(now, city.fallback);
    offset = city.fallback * 60;
  }
  const date = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  // 面板实时刷新（PanelData.live）下带秒才有"活着"的感觉
  const time = `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  return {
    name: city.name,
    iana: city.iana,
    fallbackHours: city.fallback,
    time,
    date,
    offset: offsetLabel(offset - -now.getTimezoneOffset()),
    value: `${city.name} ${date} ${pad(parts.hour)}:${pad(parts.minute)}`,
    fallback: !real,
  };
}

export interface TimeSnapshot {
  localTime: string;
  localDate: string;
  cities: CityTime[];
}

/** 本机 IANA 时区名；拿不到（老 WebView）时退回按偏移伪造的 Etc/GMT 名 */
export function localZoneName(now: Date = new Date()): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fakeLocalZone(now);
  } catch {
    return fakeLocalZone(now);
  }
}

function fakeLocalZone(now: Date): string {
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `Etc/GMT${sign}${Math.floor(abs / 60) || 0}`;
}

export function worldTime(keyword: string, now: Date = new Date()): TimeSnapshot {
  const localTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now);
  const localDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${weekday}`;
  const key = keyword.trim().toLowerCase();
  const cities = CITIES.filter(
    (city) => !key || city.name.toLowerCase().includes(key) || city.iana.toLowerCase().includes(key),
  ).map((city) => cityTime(now, city));
  return { localTime, localDate, cities };
}

export function matchCities(keyword: string): City[] {
  const key = keyword.trim().toLowerCase();
  return CITIES.filter(
    (city) => !key || city.name.toLowerCase().includes(key) || city.iana.toLowerCase().includes(key),
  );
}
