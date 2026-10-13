/**
 * LPS-1 插件前端 SDK：PluginContext 最小实现（M1）+ 宿主保留能力封装（M5）
 *
 * 前端不再直接 invoke 各插件的业务命令，统一经宿主的 plugin_call 通道
 * 按 pluginId 分发。
 *
 * `svc.*` 是**宿主保留方法名空间**（设计文档 §4.6）：由宿主直接应答，
 * 不进入插件后端分发表——纯前端插件（无 crate / 无 sidecar）因此也能读写
 * 设置、剪贴板、发起 HTTP、写日志、发通知。下面这些同名属性只是它的语法糖：
 *
 *   ctx.settings.get('theme')  ≡  ctx.call('svc.settings.get', { key: 'theme' })
 *
 * 带后端插件的 `ctx.call('svc.*')` 与 `ctx.call('业务方法')` 可混用，
 * 前者始终由宿主应答，后者才落到插件自己的后端。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** 设置 KV（宿主强制 `${pluginId}.` 前缀隔离，插件无法越权读写别人的键） */
export interface PluginSettings {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** 读 JSON 值：键不存在或解析失败时返回 fallback（插件持久化列表的常用姿势） */
  getJson<T>(key: string, fallback: T): Promise<T>;
  setJson(key: string, value: unknown): Promise<void>;
}

/** 宿主原生剪贴板（写/读分别授权，manifest 需声明 clipboard:write / clipboard:read） */
export interface PluginClipboard {
  write(text: string): Promise<void>;
  read(): Promise<string | null>;
}

/** 结构化日志（透传到宿主生命周期日志，便于用户在日志里排查插件问题） */
export interface PluginLog {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** 系统通知 */
export interface PluginNotify {
  send(title: string, body?: string): Promise<void>;
}

/** 事件广播：前端按 pluginId 过滤（`plugin-event` 事件载荷含 pluginId/event/payload） */
export interface PluginEvents {
  emit(event: string, payload?: unknown): Promise<void>;
}

/** HTTP 响应（宿主代理返回状态码 + 全文，便于插件区分 2xx / 404 / 5xx） */
export interface HttpResponse {
  status: number;
  body: string;
}

/** HTTP 请求描述（对应 `svc.http.send`；`net:<host>` 白名单在宿主侧门控） */
export interface HttpRequestInit {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * 宿主代理的 HTTP（`svc.http.send` 的语法糖）。
 *
 * 请求由宿主发出，不受 webview 的 CORS 限制；但仅当 manifest 声明了
 * 目标域名（`net:<host>`，逐域名精确匹配）时才被放行，否则抛权限错误。
 */
export interface PluginHttp {
  /** 原始请求：返回状态码与响应全文（需要看 4xx 响应体时用它） */
  send(req: HttpRequestInit): Promise<HttpResponse>;
  /** GET 简写 */
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
  /** GET 并解析 JSON；非 2xx 或解析失败时抛带状态码与片段的可读错误 */
  json<T>(url: string, headers?: Record<string, string>): Promise<T>;
}

/** 显示器描述（物理像素；`x`/`y` 可为负——副屏挂在主屏左侧时） */
export interface MonitorInfo {
  index: number;
  name: string;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

/** 截屏参数 */
export interface CaptureOptions {
  /** 显示器序号（0 起）；`-1` = 光标所在的那块；缺省 = 主显示器 */
  monitor?: number;
  /** 目标文件绝对路径；缺省由宿主落在本插件数据目录的 `screenshots/` 下 */
  path?: string;
  /** 先隐藏所有 LiteLauncher 窗口再截（否则启动器自己会被拍进画面） */
  hideWindows?: boolean;
  /** 隐藏后、截取前的等待毫秒数（宿主上限 10s），用于让用户收起菜单 */
  delayMs?: number;
}

/** 截屏结果 */
export interface CaptureResult {
  path: string;
  width: number;
  height: number;
  monitor: number;
  bytes: number;
}

/** 单像素采样；`hex` 为规范大写 `#RRGGBB` */
export interface PixelSample {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  hex: string;
}

/** 放大镜取样：以光标为中心的一片像素方格（前端用 CSS 网格放大成硬边像素） */
export interface PixelGrid {
  x: number;
  y: number;
  radius: number;
  cols: number;
  rows: number;
  /** 行优先的 `#RRGGBB` 数组，长度 = cols * rows */
  cells: string[];
  /** 中心像素在 cells 中的下标（贴边裁剪后仍指向真正的采样点） */
  center: number;
}

/** `ctx.screen.pixel()` 的返回：总是含单点采样，带 radius 时另附方格 */
export interface PixelResult {
  sample: PixelSample;
  grid?: PixelGrid;
}

/**
 * 屏幕捕获（`screen` 权限）：截图与取色。
 *
 * 坐标一律是**桌面全局物理像素**（与 `getCurrentWindow().outerPosition()` 同一坐标系）。
 */
export interface PluginScreen {
  /** 列出全部显示器（顺序与 `capture` 的 `monitor` 参数一致） */
  list(): Promise<MonitorInfo[]>;
  /** 当前鼠标位置（全局物理坐标） */
  cursor(): Promise<{ x: number; y: number }>;
  /** 取色：`x`/`y` 缺省时取当前光标位置；带 `radius` 另返回放大镜方格 */
  pixel(opts?: { x?: number; y?: number; radius?: number }): Promise<PixelResult>;
  /** 截图并落盘，返回路径与尺寸 */
  capture(opts?: CaptureOptions): Promise<CaptureResult>;
}

/** 全局热键（`shortcut:<accel>` 权限，逐条声明、无通配） */
export interface PluginShortcuts {
  /** 注册（幂等）；未声明或已被其他插件占用会抛错 */
  register(accel: string): Promise<void>;
  unregister(accel: string): Promise<void>;
  /** 本插件当前已注册的加速键（规范小写形式） */
  list(): Promise<string[]>;
  /**
   * 监听本插件的全局热键触发，返回取消订阅函数。
   *
   * `scope` 决定在哪个窗口上下文里响应：`main`（默认）只在启动器主窗口生效，
   * `any` 在任意窗口（含 `?view=` 视图窗口）都生效。
   * **默认必须是 main**：所有插件的 setup 会在每个窗口各跑一遍，
   * 若不区分，打开任意视图窗口后热键就会被执行两次。
   */
  on(
    accel: string,
    handler: () => void,
    opts?: { scope?: 'main' | 'any' },
  ): Promise<() => void>;
}

/** 窗口（`windows` 权限）：只能打开 manifest.views 里声明过的视图 */
export interface PluginWindows {
  /** `params` 会透传为页面查询串（视图内用 `URLSearchParams` 读取） */
  open(view: string, params?: Record<string, string | number | boolean>): Promise<void>;
}

export interface PluginContext {
  /** 调用本插件后端方法，或宿主保留的 `svc.*` 方法 */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;

  settings: PluginSettings;
  clipboard: PluginClipboard;
  http: PluginHttp;
  screen: PluginScreen;
  shortcuts: PluginShortcuts;
  windows: PluginWindows;
  log: PluginLog;
  notify: PluginNotify;
  events: PluginEvents;
}

/**
 * 是否运行在 Tauri 宿主中。
 * 浏览器里 `vite dev` 预览插件 UI 时无宿主，插件需据此降级，否则 invoke 会直接抛错。
 */
export function isHostAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 归一化加速键（与宿主 Rust 侧 `normalize_accel` 对齐：去空白、小写、`+` 分隔） */
export function normalizeAccel(raw: string): string {
  return raw
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
    .join('+');
}

/** 当前是否处于 `?view=` 视图窗口（主窗口没有该查询参数） */
export function isViewWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('view');
}

const contexts = new Map<string, PluginContext>();

export function getPluginContext(pluginId: string): PluginContext {
  const cached = contexts.get(pluginId);
  if (cached) {
    return cached;
  }

  const call = async <T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> => {
    return await invoke<T>('plugin_call', { pluginId, method, params });
  };

  const svc = <T = unknown>(method: string, params: Record<string, unknown> = {}) =>
    call<T>(`svc.${method}`, params);

  const ctx: PluginContext = {
    call,
    settings: {
      get: async (key) => (await svc<string | null>('settings.get', { key })) ?? null,
      set: async (key, value) => {
        await svc('settings.set', { key, value });
      },
      getJson: async <T>(key: string, fallback: T): Promise<T> => {
        const raw = await svc<string | null>('settings.get', { key });
        if (raw == null) return fallback;
        try {
          return JSON.parse(raw) as T;
        } catch {
          return fallback;
        }
      },
      setJson: async (key, value) => {
        await svc('settings.set', { key, value: JSON.stringify(value) });
      },
    },
    clipboard: {
      write: async (text) => {
        await svc('clipboard.write', { text });
      },
      read: async () => (await svc<string | null>('clipboard.read', {})) ?? null,
    },
    http: {
      send: async (req) => {
        const res = await svc<{ status?: number; body?: string }>('http.send', {
          method: req.method ?? 'GET',
          url: req.url,
          headers: req.headers ?? {},
          body: req.body,
        });
        return { status: res?.status ?? 0, body: res?.body ?? '' };
      },
      get: async (url, headers) => {
        const res = await svc<{ status?: number; body?: string }>('http.send', {
          method: 'GET',
          url,
          headers: headers ?? {},
        });
        return { status: res?.status ?? 0, body: res?.body ?? '' };
      },
      json: async <T>(url: string, headers?: Record<string, string>): Promise<T> => {
        const res = await svc<{ status?: number; body?: string }>('http.send', {
          method: 'GET',
          url,
          headers: headers ?? {},
        });
        const status = res?.status ?? 0;
        const body = res?.body ?? '';
        if (status < 200 || status >= 300) {
          const snippet = body.length > 160 ? `${body.slice(0, 160)}…` : body;
          throw new Error(`HTTP ${status}${snippet ? `：${snippet}` : ''}`);
        }
        try {
          return JSON.parse(body) as T;
        } catch {
          const snippet = body.length > 160 ? `${body.slice(0, 160)}…` : body;
          throw new Error(`响应不是合法 JSON${snippet ? `：${snippet}` : ''}`);
        }
      },
    },
    screen: {
      list: async () => (await svc<MonitorInfo[] | null>('screen.list', {})) ?? [],
      cursor: async () => {
        const p = await svc<{ x?: number; y?: number } | null>('screen.cursor', {});
        return { x: p?.x ?? 0, y: p?.y ?? 0 };
      },
      pixel: async (opts = {}) => {
        const params: Record<string, unknown> = {};
        // 只在两个坐标都给全时才透传，避免宿主"只认一个坐标"的不确定行为
        if (opts.x !== undefined && opts.y !== undefined) {
          params.x = opts.x;
          params.y = opts.y;
        }
        if (opts.radius) params.radius = opts.radius;
        const res = await svc<PixelResult | null>('screen.pixel', params);
        if (!res?.sample) throw new Error('取色失败：宿主未返回采样结果');
        return res;
      },
      capture: async (opts = {}) => {
        const params: Record<string, unknown> = {};
        if (opts.monitor !== undefined) params.monitor = opts.monitor;
        if (opts.path) params.path = opts.path;
        if (opts.hideWindows) params.hideWindows = true;
        if (opts.delayMs) params.delayMs = opts.delayMs;
        const res = await svc<CaptureResult | null>('screen.capture', params);
        if (!res?.path) throw new Error('截图失败：宿主未返回文件路径');
        return res;
      },
    },
    shortcuts: {
      register: async (accel) => {
        await svc('shortcut.register', { accel });
      },
      unregister: async (accel) => {
        await svc('shortcut.unregister', { accel });
      },
      list: async () => (await svc<string[] | null>('shortcut.list', {})) ?? [],
      on: async (accel, handler, opts = {}) => {
        // 默认只在主窗口响应：每个窗口加载都会跑一遍插件 setup，
        // 不加这层过滤，打开任意视图窗口后热键就会被执行两次
        if ((opts.scope ?? 'main') === 'main' && isViewWindow()) {
          return () => {};
        }
        if (!isHostAvailable()) {
          return () => {};
        }
        const want = normalizeAccel(accel);
        return await listen<{ pluginId?: string; accel?: string }>(
          'plugin-shortcut',
          (event) => {
            const payload = event.payload;
            if (!payload || payload.pluginId !== pluginId) return;
            if (normalizeAccel(payload.accel ?? '') !== want) return;
            try {
              handler();
            } catch (err) {
              console.error('[shortcuts] 热键处理失败:', err);
            }
          },
        );
      },
    },
    windows: {
      open: async (view, params = {}) => {
        await svc('window.open', { view, params });
      },
    },
    log: {
      debug: (m) => void svc('log.write', { level: 'debug', message: m }),
      info: (m) => void svc('log.write', { level: 'info', message: m }),
      warn: (m) => void svc('log.write', { level: 'warn', message: m }),
      error: (m) => void svc('log.write', { level: 'error', message: m }),
    },
    notify: {
      send: async (title, body = '') => {
        await svc('notify.send', { title, body });
      },
    },
    events: {
      emit: async (event, payload = null) => {
        await svc('events.emit', { event, payload });
      },
    },
  };

  contexts.set(pluginId, ctx);
  return ctx;
}
