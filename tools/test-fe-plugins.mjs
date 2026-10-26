// 纯前端插件（backend.kind = "none"）测试：不启动 Tauri，直接在 Node 里跑插件逻辑。
//
// 做法：用仓库自带的 typescript 把 plugins/<id>/fe/src/index.ts 转译成 CommonJS，
// 再用桩模块顶替壳层依赖（@ll/sdk / @tauri-apps/api/core），随后调用 setup()
// 取出插件对象，逐个断言 query()/onSelect() 的真实计算结果。
//
// 覆盖：
//   1) 结构合法性（items/id/title）+ 代表性输入的**计算结果**（防回归，不是只验形状）；
//   2) 网络类插件（C 组）的「显式触发」范式——query 不发请求，onSelect(查询项)
//      触发 `svc.http.send`（此处由 fixture 桩应答）后应返回 refresh=true，
//      刷新后的面板内容会被断言（含 dict 的 404 分支）。
//
// 用法：npm run plugin:test:fe
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = process.cwd();
const pluginsDir = path.join(root, 'plugins');

// ── HTTP fixture（模拟宿主 `svc.http.send` 的应答，按域名路由）─────────────────
const WEATHER_FIXTURE = {
  current_condition: [
    {
      temp_C: '20',
      FeelsLikeC: '14',
      humidity: '14',
      windspeedKmph: '18',
      winddir16Point: 'NNW',
      visibility: '10',
      pressure: '1023',
      uvIndex: '4',
      weatherDesc: [{ value: 'Sunny' }],
      observation_time: '04:43 AM',
    },
  ],
  nearest_area: [
    { areaName: [{ value: 'Beijing' }], region: [{ value: 'Beijing' }], country: [{ value: 'China' }] },
  ],
  weather: [
    {
      date: '2026-10-13',
      maxtempC: '21',
      mintempC: '17',
      astronomy: [{ sunrise: '06:22 AM', sunset: '05:39 PM' }],
    },
  ],
};

const FX_FIXTURE = {
  result: 'success',
  base_code: 'USD',
  time_last_update_utc: 'Mon, 12 Oct 2026 23:57:31 +0000',
  time_eol_unix: 0,
  rates: {
    USD: 1,
    CNY: 6.70582,
    EUR: 0.895156,
    JPY: 158.544079,
    GBP: 0.756615,
    HKD: 7.847659,
    KRW: 1333.744079,
    CAD: 1.427373,
    AUD: 1.436501,
    CHF: 0.834009,
    SGD: 1.280778,
  },
};

const IP_FIXTURE = {
  ip: '8.8.8.8',
  success: true,
  type: 'IPv4',
  continent: 'North America',
  country: 'United States',
  country_code: 'US',
  region: 'California',
  city: 'San Jose',
  latitude: 37.3393939,
  longitude: -121.8949553,
  postal: '95025',
  calling_code: '1',
  capital: 'Washington D.C.',
  connection: { asn: 15169, org: 'Google LLC', isp: 'Google LLC', domain: 'google.com' },
  timezone: { id: 'America/Los_Angeles', abbr: 'PDT', is_dst: true, offset: -25200, utc: '-07:00' },
  flag: { emoji: '🇺🇸' },
};

const DICT_FIXTURE = [
  {
    word: 'hello',
    phonetics: [
      { audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3' },
      { text: '/həˈləʊ/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/hello-uk.mp3' },
    ],
    meanings: [
      {
        partOfSpeech: 'noun',
        definitions: [{ definition: '"Hello!" or an equivalent greeting.', synonyms: ['greeting'] }],
        synonyms: ['greeting', 'salutation'],
      },
      {
        partOfSpeech: 'verb',
        definitions: [{ definition: 'To greet with "hello".', example: 'She helloed the guests.' }],
      },
    ],
  },
];

const TR_FIXTURE = {
  responseData: { translatedText: '你好世界', match: 1 },
  quotaFinished: false,
  responseStatus: 200,
  matches: [
    { translation: '你好世界', quality: '74' },
    { translation: '你好，世界', quality: '70' },
    { translation: '你好世界', quality: '65' },
  ],
};

/** 域名 → fixture（函数形式可按 url 分支，用于模拟 404） */
const HTTP_FIXTURES = {
  'wttr.in': WEATHER_FIXTURE,
  'open.er-api.com': FX_FIXTURE,
  'ipwho.is': IP_FIXTURE,
  'api.dictionaryapi.dev': (url) =>
    url.includes('/nonexistent')
      ? { status: 404, body: JSON.stringify({ title: 'No Definitions Found', message: 'Sorry pal' }) }
      : { status: 200, body: JSON.stringify(DICT_FIXTURE) },
  'api.mymemory.translated.net': TR_FIXTURE,
};

const httpCalls = [];

function respondHttp(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  const fixture = HTTP_FIXTURES[host];
  if (!fixture) {
    return { status: 404, body: JSON.stringify({ message: `no fixture for ${host}` }) };
  }
  return typeof fixture === 'function' ? fixture(url) : { status: 200, body: JSON.stringify(fixture) };
}

// ── 屏幕 / 热键 fixture（模拟宿主 `svc.screen.*` 的应答）──────────────────────
// 两块屏，主屏在原点、副屏挂在右侧；取色固定返回 #FF8800（与 /color 用例同色）。
const MONITORS_FIXTURE = [
  { index: 0, name: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 },
  { index: 1, name: '\\\\.\\DISPLAY2', primary: false, x: 1920, y: 0, width: 2560, height: 1440, scaleFactor: 1.25 },
];

const CURSOR_FIXTURE = { x: 960, y: 540 };

const PIXEL_FIXTURE = {
  sample: { x: CURSOR_FIXTURE.x, y: CURSOR_FIXTURE.y, r: 255, g: 136, b: 0, hex: '#FF8800' },
  // 放大镜：radius 7 → 15×15；中心格即采样点
  grid: (() => {
    const radius = 7;
    const cols = radius * 2 + 1;
    return {
      x: CURSOR_FIXTURE.x,
      y: CURSOR_FIXTURE.y,
      radius,
      cols,
      rows: cols,
      cells: Array.from({ length: cols * cols }, (_, i) =>
        i === Math.floor((cols * cols) / 2) ? '#FF8800' : '#101010',
      ),
      center: Math.floor((cols * cols) / 2),
    };
  })(),
};

// 路径刻意用 Windows 反斜杠形式：顺带覆盖插件里 dirOf() 的反斜杠分支
const CAPTURE_FIXTURE = {
  path: 'C:\\Users\\tester\\AppData\\Local\\LiteLauncher\\plugins\\shot\\screenshots\\shot-1760000000000.png',
  width: 1920,
  height: 1080,
  monitor: 0,
  bytes: 204800,
};

// ── 剪贴板历史桩（P1 /clip）────────────────────────────────────────────────────
// 内存实现；行为对齐宿主侧的隐私策略：疑似凭据不落盘 + 条数上限。
const clipStore = {
  /** 当前系统剪贴板内容（ingest 时被读走） */
  text: '',
  entries: [],
  seq: 0,
  watching: true,
  maxEntries: 200,
  maxBytes: 64 * 1024,
  retentionDays: 7,
};

function resetClipStore() {
  clipStore.text = '';
  clipStore.entries = [];
  clipStore.seq = 0;
  clipStore.watching = true;
}

/** 与 Rust 侧 looks_like_secret 同口径的测试端实现（用于验"疑似凭据不入库"） */
function looksLikeSecret(text) {
  const t = String(text || '').trim();
  if (t.length < 8 || t.length > 512) return false;
  if (t.startsWith('-----BEGIN') && t.includes('PRIVATE KEY')) return true;
  const lower = t.toLowerCase();
  for (const key of ['password', 'passwd', 'secret', 'api_key', 'apikey', 'token', 'pwd']) {
    if (lower.includes(`${key}=`) || lower.includes(`${key}:`)) return true;
  }
  return t.split((c) => !/[a-zA-Z0-9]/.test(c)).some((seg) => seg.length >= 24);
}

// ── 壳层依赖桩 ────────────────────────────────────────────────────────────────
const registered = [];
const svcCalls = [];
/** 插件私有 KV 的内存实现（真实宿主按 pluginId 前缀隔离；每个插件用例前清空） */
const settingsStore = new Map();

const sdkStub = {
  __esModule: true,
  pluginRegistry: {
    register(plugin) {
      registered.push(plugin);
    },
    getById(id) {
      return registered.find((p) => p.id === id);
    },
    // /hotkey 速查表要遍历全部插件收集自报热键，缺这个方法会直接抛错
    getAll() {
      return registered.slice();
    },
  },
  getPluginContext(pluginId) {
    const call = async (method, params) => {
      svcCalls.push({ pluginId, method, params });
      // 剪贴板历史按方法分派，让插件侧的策略展示与开关切换能被真实断言
      if (method === 'svc.clipboard.history.ingest') {
        if (!looksLikeSecret(clipStore.text) && clipStore.text && clipStore.text !== clipStore.entries[0]?.text) {
          clipStore.entries.unshift({ id: ++clipStore.seq, text: clipStore.text, ts: Date.now() });
          clipStore.entries.length = Math.min(clipStore.entries.length, clipStore.maxEntries);
        }
        return null;
      }
      if (method === 'svc.clipboard.history.recent') {
        return clipStore.entries.slice(0, Number(params?.limit ?? 50));
      }
      if (method === 'svc.clipboard.history.search') {
        const kw = String(params?.keyword ?? '').toLowerCase();
        return clipStore.entries.filter((e) => e.text.toLowerCase().includes(kw)).slice(0, Number(params?.limit ?? 50));
      }
      if (method === 'svc.clipboard.history.recall') {
        const hit = clipStore.entries.find((e) => e.id === params?.id);
        if (!hit) throw new Error(`未找到该条目: ${params?.id}`);
        clipStore.text = hit.text;
        return null;
      }
      if (method === 'svc.clipboard.history.clear') {
        clipStore.entries = [];
        return null;
      }
      if (method === 'svc.clipboard.history.watching') {
        if (params?.on === undefined) return clipStore.watching;
        clipStore.watching = Boolean(params.on);
        return null;
      }
      if (method === 'svc.clipboard.history.policy') {
        return {
          max_entries: clipStore.maxEntries,
          max_bytes: clipStore.maxBytes,
          retention_days: clipStore.retentionDays,
          excluded_apps: ['1password', 'bitwarden'],
          detect_secrets: true,
        };
      }
      return null;
    };
    const svc = (method, params = {}) => call(`svc.${method}`, params);
    return {
      call,
      settings: {
        get: async (key) => (settingsStore.has(key) ? settingsStore.get(key) : null),
        set: async (key, value) => {
          settingsStore.set(key, value);
        },
        getJson: async (key, fallback) => {
          const raw = settingsStore.get(key);
          if (raw == null) return fallback;
          try {
            return JSON.parse(raw);
          } catch {
            return fallback;
          }
        },
        setJson: async (key, value) => {
          settingsStore.set(key, JSON.stringify(value));
        },
      },
      clipboard: {
        write: async (text) => {
          svcCalls.push({ pluginId, method: 'svc.clipboard.write', params: { text } });
        },
        read: async () => (settingsStore.get('__clipboard') ?? null),
      },
      // 与真实 SDK 的 ctx.http 同构：都落到 svc.http.send，只是这里用 fixture 应答
      http: {
        send: async (req) => {
          httpCalls.push(req.url);
          return respondHttp(req.url);
        },
        get: async (url) => {
          httpCalls.push(url);
          return respondHttp(url);
        },
        json: async (url) => {
          httpCalls.push(url);
          const res = respondHttp(url);
          if (res.status < 200 || res.status >= 300) {
            throw new Error(`HTTP ${res.status}：${res.body.slice(0, 160)}`);
          }
          return JSON.parse(res.body);
        },
      },
      // 屏幕捕获（D 组）：与宿主 svc.screen.* 同构，返回结构一致（总带 sample）
      screen: {
        list: async () => {
          svcCalls.push({ pluginId, method: 'svc.screen.list', params: {} });
          return MONITORS_FIXTURE;
        },
        cursor: async () => {
          svcCalls.push({ pluginId, method: 'svc.screen.cursor', params: {} });
          return { ...CURSOR_FIXTURE };
        },
        pixel: async (opts = {}) => {
          svcCalls.push({ pluginId, method: 'svc.screen.pixel', params: opts });
          const at = {
            x: typeof opts.x === 'number' ? opts.x : CURSOR_FIXTURE.x,
            y: typeof opts.y === 'number' ? opts.y : CURSOR_FIXTURE.y,
          };
          const sample = { ...PIXEL_FIXTURE.sample, ...at };
          return opts.radius ? { sample, grid: PIXEL_FIXTURE.grid } : { sample };
        },
        capture: async (opts = {}) => {
          svcCalls.push({ pluginId, method: 'svc.screen.capture', params: opts });
          // 区域框选：直接以区域尺寸为准，并按宿主约定回传 region
          if (opts.region && opts.region.width > 0 && opts.region.height > 0) {
            return {
              ...CAPTURE_FIXTURE,
              width: opts.region.width,
              height: opts.region.height,
              region: opts.region,
              clipboardImage: Boolean(opts.toClipboard),
            };
          }
          const monitor = typeof opts.monitor === 'number' ? opts.monitor : 0;
          const target = MONITORS_FIXTURE[monitor] ?? MONITORS_FIXTURE[0];
          return {
            ...CAPTURE_FIXTURE,
            monitor,
            width: target.width,
            height: target.height,
            clipboardImage: Boolean(opts.toClipboard),
          };
        },
      },
      shortcuts: {
        register: async (accel) => {
          svcCalls.push({ pluginId, method: 'svc.shortcut.register', params: { accel } });
        },
        unregister: async (accel) => {
          svcCalls.push({ pluginId, method: 'svc.shortcut.unregister', params: { accel } });
        },
        list: async () => [],
        catalog: async () => [],
        on: async () => () => {},
        onHotkey: async (hotkeyId) => {
          svcCalls.push({ pluginId, method: 'svc.shortcut.onHotkey', params: { hotkeyId } });
          return () => {};
        },
      },
      windows: {
        open: async (view, params = {}) => {
          svcCalls.push({ pluginId, method: 'svc.window.open', params: { view, params } });
        },
        setContentSize: async (size) => {
          svcCalls.push({ pluginId, method: 'svc.window.setContentSize', params: size });
          // 宿主返回的是**实际生效**尺寸，桩里原样回声
          return { width: size.width ?? 0, height: size.height ?? 0, clamped: false };
        },
      },
      // 剪贴板历史（P1 /clip）：内存实现，行为对齐宿主（隐私策略强制 + 上限 + 过期）
      clipboardHistory: {
        ingest: async () => {
          svcCalls.push({ pluginId, method: 'svc.clipboard.history.ingest', params: {} });
          // 宿主侧的"疑似凭据不落盘"过滤，这里也照做，保证用例能验到
          if (looksLikeSecret(clipStore.text)) return;
          if (clipStore.text && clipStore.text !== clipStore.entries[0]?.text) {
            clipStore.entries.unshift({
              id: ++clipStore.seq,
              text: clipStore.text,
              ts: Date.now(),
            });
            clipStore.entries.length = Math.min(clipStore.entries.length, clipStore.maxEntries);
          }
        },
        recent: async (limit = 50) => {
          svcCalls.push({ pluginId, method: 'svc.clipboard.history.recent', params: { limit } });
          return clipStore.entries.slice(0, limit);
        },
        search: async (keyword, limit = 50) => {
          svcCalls.push({ pluginId, method: 'svc.clipboard.history.search', params: { keyword, limit } });
          const kw = String(keyword ?? '').toLowerCase();
          return clipStore.entries.filter((e) => e.text.toLowerCase().includes(kw)).slice(0, limit);
        },
        recall: async (id) => {
          svcCalls.push({ pluginId, method: 'svc.clipboard.history.recall', params: { id } });
          const hit = clipStore.entries.find((e) => e.id === id);
          if (!hit) throw new Error(`未找到该条目: ${id}`);
          clipStore.text = hit.text;
        },
        remove: async (id) => {
          svcCalls.push({ pluginId, method: 'svc.clipboard.history.remove', params: { id } });
          clipStore.entries = clipStore.entries.filter((e) => e.id !== id);
        },
        clear: async () => {
          svcCalls.push({ pluginId, method: 'svc.clipboard.history.clear', params: {} });
          clipStore.entries = [];
        },
        watching: async (on) => {
          svcCalls.push({ pluginId, method: 'svc.clipboard.history.watching', params: { on } });
          if (on === undefined) return clipStore.watching;
          clipStore.watching = Boolean(on);
          return undefined;
        },
        policy: async () => {
          svcCalls.push({ pluginId, method: 'svc.clipboard.history.policy', params: {} });
          return {
            maxEntries: clipStore.maxEntries,
            maxBytes: clipStore.maxBytes,
            retentionDays: clipStore.retentionDays,
            excludedApps: ['1password', 'bitwarden'],
            detectSecrets: true,
          };
        },
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      notify: { send: async () => {} },
      events: { emit: async () => {} },
    };
  },
  isHostAvailable: () => false,
  // 视图组件不参与 Node 端测试（JSX 需 solid 编译期），桩成空实现
  registerView() {},
  searchRegistry: { add() {}, getById() {} },
  normalizeAccel: (raw) =>
    raw
      .split('+')
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 0)
      .join('+'),
  isViewWindow: () => false,
};

/**
 * 直连 `invoke` 的调用记录（只收 `plugin_call`）。
 * popup.ts 这类"SDK 内部自己打 IPC"的行为，光看 svcCalls 看不到——
 * svcCalls 来自 sdkStub，而 popup.ts 走的是真实 lps.ts。
 */
const invokeCalls = [];
const tauriStub = {
  __esModule: true,
  invoke: async (cmd, args) => {
    if (cmd === 'plugin_call') {
      invokeCalls.push(args);
      // setContentSize 的契约是"回实际生效尺寸"，桩照做，让上报链路能被验到
      if (args?.method === 'svc.window.setContentSize') {
        const p = args.params ?? {};
        return { width: p.width ?? 0, height: p.height ?? 0, clamped: false };
      }
    }
    return null;
  },
};
const tauriEventStub = { __esModule: true, listen: async () => () => {} };
const tauriWindowStub = {
  __esModule: true,
  getCurrentWindow: () => ({
    outerPosition: async () => ({ x: 0, y: 0 }),
    outerSize: async () => ({ width: 320, height: 350 }),
    close: async () => {},
  }),
};
const solidStub = {
  __esModule: true,
  createSignal: (v) => [() => v, () => {}],
  onMount: () => {},
  onCleanup: () => {},
  For: () => null,
  Show: () => null,
};

/** 已加载模块缓存（每个插件用例前清空，避免跨插件串味） */
const moduleCache = new Map();

/** 解析插件包内的模块引用；相对路径递归转译，视图组件（.tsx）桩成空模块 */
function resolveModule(spec, fromFile) {
  if (spec === '@ll/sdk') return sdkStub;
  // @ll/ui 只被视图组件（.tsx）使用，而 .tsx 在 Node 端一律桩成空模块；
  // 这条分支是为了让"插件允许依赖 @ll/ui"这个约定在解析器里也成立
  if (spec === '@ll/ui') return { __esModule: true, PopupFrame: () => null };
  if (spec === '@tauri-apps/api/core') return tauriStub;
  if (spec === '@tauri-apps/api/event') return tauriEventStub;
  if (spec === '@tauri-apps/api/window') return tauriWindowStub;
  if (spec === 'solid-js') return solidStub;
  if (spec.endsWith('.css')) return {};

  if (spec.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [`${base}.ts`, `${base}.tsx`, base];
    const target = candidates.find((f) => existsSync(f));
    if (!target) throw new Error(`找不到相对模块 ${spec}（来自 ${fromFile}）`);
    // .tsx 是 solid JSX，需要 solid 编译期才能执行；Node 端只验命令插件逻辑，
    // 所以视图组件返回空模块（registerView 在桩里本就是空实现）
    if (target.endsWith('.tsx')) return {};
    if (moduleCache.has(target)) return moduleCache.get(target);
    const loaded = loadPluginModule(target);
    moduleCache.set(target, loaded);
    return loaded;
  }

  throw new Error(`插件不应依赖壳层之外的模块，却 import 了: ${spec}`);
}

/** 把 TS 源转译并执行，得到一个 CommonJS 模块对象 */
function loadPluginModule(file) {
  const source = readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      isolatedModules: true,
    },
  }).outputText;

  const module = { exports: {} };
  const localRequire = (spec) => resolveModule(spec, file);
  // eslint-disable-next-line no-new-func
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', output);
  run(module.exports, localRequire, module, file, path.dirname(file));
  return module.exports;
}

/** 复刻宿主分词：首个 token 为 subcommand，其余为 args */
function toParsed(tokens) {
  const raw = tokens.join(' ');
  const [first, ...rest] = tokens;
  const subcommand = first && !first.startsWith('-') ? first : undefined;
  const args = subcommand ? rest : tokens;
  return {
    raw,
    trigger: '',
    subcommand,
    args,
    namedArgs: {},
    isAction: false,
    queryText: raw,
  };
}

// 每个插件的用例：输入 token 数组 + 对产出条目的断言
//   expect      → 断言 query 返回的面板
//   expectFirst → 断言首次 query 后面板里某个"中间态"（如加载中/用法提示）
//   before      → 预置桩状态（如剪贴板历史），必须早于首个 query
//   after       → 额外的异步断言（如 dict 打开发音）
//
// 注：网络插件已改为「输入即出结果」（query 直接联网 + queryDebounceMs 防抖），
// 所以这里**不再有** drive 两段式机制——query 一次就该给出真实解析结果。
const CASES = {
  text: [
    {
      tokens: ['Hello World'],
      expect: (items) => {
        const upper = items.find((i) => i.badge === 'upper');
        assert(upper?.metadata?.value === 'HELLO WORLD', 'text 大写结果应为 HELLO WORLD');
        const snake = items.find((i) => i.badge === 'snake');
        assert(snake?.metadata?.value === 'hello_world', 'text snake 应为 hello_world');
        const camel = items.find((i) => i.badge === 'camel');
        assert(camel?.metadata?.value === 'helloWorld', 'text camel 应为 helloWorld');
      },
    },
    {
      tokens: ['snake', 'HelloWorld'],
      expect: (items) => {
        assert(items.length === 2, 'text 指定子命令应只出现 1 条结果 + 1 条统计');
        assert(items[0].metadata?.value === 'hello_world', 'text snake HelloWorld 应为 hello_world');
      },
    },
  ],
  json: [
    {
      tokens: ['{"a":1,"b":[2,3]}'],
      expect: (items) => {
        const pretty = items.find((i) => i.badge === 'pretty');
        assert(pretty?.metadata?.value?.includes('"a": 1'), 'json 美化应含 "a": 1');
        const minify = items.find((i) => i.badge === 'minify');
        assert(minify?.metadata?.value === '{"a":1,"b":[2,3]}', 'json 压缩应还原为原样单行');
      },
    },
    {
      tokens: ['{bad json'],
      expect: (items) => {
        assert(items[0].badge === '错误', 'json 非法输入应给出错误条目');
      },
    },
  ],
  rand: [
    {
      tokens: [],
      expect: (items) => {
        const uuid = items.find((i) => i.badge === 'uuid');
        assert(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid?.metadata?.value ?? ''),
          `rand 默认应产出合法 UUID v4，实得 ${uuid?.metadata?.value}`,
        );
      },
    },
    {
      tokens: ['num', '1', '100'],
      expect: (items) => {
        const n = Number.parseInt(items[0].metadata?.value ?? '', 10);
        assert(Number.isInteger(n) && n >= 1 && n <= 100, `rand num 应落在 1–100，实得 ${n}`);
      },
    },
    {
      tokens: ['pick', '甲', '乙', '丙'],
      expect: (items) => {
        assert(['甲', '乙', '丙'].includes(items[0].metadata?.value), 'rand pick 应取自候选项');
      },
    },
  ],
  ts: [
    {
      tokens: ['1700000000'],
      expect: (items) => {
        const utc = items.find((i) => i.badge === 'UTC');
        assert(utc?.title === '2023-11-14 22:13:20', `ts UTC 换算错误，实得 ${utc?.title}`);
        const seconds = items.find((i) => i.badge === '秒');
        assert(seconds?.metadata?.value === '1700000000', 'ts 秒时间戳应等于输入');
      },
    },
    {
      tokens: ['1700000000000'],
      expect: (items) => {
        const seconds = items.find((i) => i.badge === '秒');
        assert(seconds?.metadata?.value === '1700000000', 'ts 毫秒输入应折算出同样的秒时间戳');
      },
    },
  ],
  unit: [
    {
      tokens: ['100', 'km', 'mi'],
      expect: (items) => {
        assert(items[0].metadata?.value?.startsWith('62.137'), `100 km → mi 实得 ${items[0].metadata?.value}`);
      },
    },
    {
      tokens: ['100', 'km'],
      expect: (items) => {
        assert(items.length >= 8, 'unit 同族换算应列出多项');
        const m = items.find((i) => i.badge === '长度' && i.title.endsWith(' m'));
        assert(m?.metadata?.value === '100000', `100 km → m 实得 ${m?.metadata?.value}`);
      },
    },
    {
      tokens: ['36.5', 'c', 'f'],
      expect: (items) => {
        assert(items[0].metadata?.value === '97.7', `36.5°C → °F 实得 ${items[0].metadata?.value}`);
      },
    },
    {
      tokens: ['hex', '255'],
      expect: (items) => {
        assert(items[0].metadata?.value === '0xff', `hex 255 实得 ${items[0].metadata?.value}`);
        assert(items.find((i) => i.badge === 'bytes')?.title === 'FF', 'unit 字节序列应为 FF');
      },
    },
  ],
  color: [
    {
      tokens: ['#ff8800'],
      expect: (items) => {
        assert(items[0].metadata?.value === '#FF8800', `color HEX 实得 ${items[0].metadata?.value}`);
        assert(items.find((i) => i.badge === 'RGB')?.metadata?.value === 'rgb(255, 136, 0)', 'color RGB 格式错误');
        assert(items.find((i) => i.badge === 'HSL')?.metadata?.value === 'hsl(32, 100%, 50%)', 'color HSL 换算错误');
        assert(items.find((i) => i.badge === '互补')?.metadata?.value === '#0077FF', 'color 互补色应为 #0077FF');
      },
    },
    {
      tokens: ['255,136,0'],
      expect: (items) => {
        assert(items[0].metadata?.value === '#FF8800', 'color 裸三元组应等价于 HEX');
      },
    },
  ],
  regex: [
    {
      tokens: ['\\d+', 'abc123def456'],
      expect: (items) => {
        const values = items.map((i) => i.metadata?.value);
        assert(values.includes('123') && values.includes('456'), `regex 匹配应为 123/456，实得 ${JSON.stringify(values)}`);
      },
    },
    {
      tokens: ['(\\d{3})-(\\d{4})', 'call 010-1234 now'],
      expect: (items) => {
        assert(items[0].metadata?.value === '010-1234', 'regex 整体匹配错误');
        assert(items[0].description?.includes('010 | 1234'), `regex 分组应被展示，实得 ${items[0].description}`);
      },
    },
    {
      tokens: ['[bad'],
      expect: (items) => {
        assert(items[0].badge === '错误', 'regex 非法表达式应给出错误条目');
      },
    },
    {
      tokens: [],
      expect: (items) => {
        assert(items.length > 3 && items[0].badge === '用法', 'regex 速查应列出用法与速查项');
      },
    },
  ],
  qr: [
    {
      tokens: ['https://example.com'],
      expect: (items) => {
        assert(items[0].metadata?.url?.startsWith('https://api.qrserver.com/'), 'qr 应产出图片链接');
        assert(
          items.some((i) => i.badge === '内容' && i.metadata?.value === 'https://example.com'),
          'qr 应保留原文条目',
        );
      },
    },
    {
      tokens: [],
      expect: (items) => {
        assert(items[0].badge === '用法', 'qr 空输入应给用法提示');
      },
    },
  ],

  // ── C 组：网络插件（输入即出结果 + 缓存）────────────────────────────────
  // 壳层加 queryDebounceMs 后，两段式（query 给「查询」项 → 回车才联网）范式已被淘汰：
  // query 一次就该直接返回真实解析结果。这些用例因此直接断言解析结果本身。
  weather: [
    {
      tokens: ['Beijing'],
      queryDebounceMs: 300,
      expect: (items) => {
        const summary = items.find((i) => i.badge === '摘要');
        assert(summary?.metadata?.value?.includes('晴'), `weather 应把 Sunny 译为晴，实得 ${summary?.title}`);
        assert(summary?.metadata?.value?.includes('20°C'), 'weather 摘要应含 20°C');
        assert(summary?.title.startsWith('Beijing · China'), `weather 位置拼接错误，实得 ${summary?.title}`);
        assert(
          items.find((i) => i.badge === '风')?.title === '西北偏北风 18 km/h',
          `weather 风向应译为「西北偏北风」，实得 ${items.find((i) => i.badge === '风')?.title}`,
        );
        assert(items.find((i) => i.badge === '湿度')?.metadata?.value === '14%', 'weather 湿度错误');
        assert(items.find((i) => i.badge === '今日')?.metadata?.value === '17~21°C', 'weather 今日温度区间错误');
        assert(items.find((i) => i.badge === '日出日落')?.metadata?.value === '日出 06:22 AM 日落 05:39 PM', 'weather 日出日落错误');
        // 新范式下不应再出现「点一下才查」的中间项
        assert(!items.some((i) => i.metadata?.fetch), 'weather 成功后不应再有 fetch 中间项');
      },
    },
    {
      // 空输入：只给用法提示，绝不联网（否则每次开面板都白打一次 API）
      tokens: [],
      expect: (items) => {
        assert(items[0].badge === '用法', `weather 空输入应给用法提示，实得 ${items[0].badge}`);
      },
    },
  ],
  fx: [
    {
      tokens: ['100', 'usd', 'cny'],
      queryDebounceMs: 300,
      expect: (items) => {
        const conv = items.find((i) => i.badge === '换算');
        assert(conv?.metadata?.value === '100 USD = 670.582 CNY', `fx 换算错误，实得 ${conv?.metadata?.value}`);
        assert(items.find((i) => i.badge === '汇率')?.metadata?.value === '6.7058', 'fx 汇率错误');
        assert(items.find((i) => i.badge === '反向')?.metadata?.value === '0.149124', 'fx 反向汇率错误');
        assert(items.find((i) => i.badge === '结果')?.metadata?.value === '670.582', 'fx 结果应为纯数字');
      },
    },
    {
      tokens: ['usd'],
      queryDebounceMs: 300,
      expect: (items) => {
        assert(items.find((i) => i.badge === '基准')?.title === '1 USD 美元', 'fx 基准展示错误');
        assert(items.some((i) => i.badge === 'CNY'), 'fx 列表模式应含 CNY');
        assert(items.some((i) => i.badge === 'JPY'), 'fx 列表模式应含 JPY');
        assert(!items.some((i) => i.badge === 'USD'), 'fx 列表模式不应重复列出基准货币');
      },
    },
  ],
  ip: [
    {
      tokens: ['8.8.8.8'],
      queryDebounceMs: 300,
      expect: (items) => {
        assert(items.find((i) => i.badge === 'IP')?.title === '8.8.8.8', 'ip 应显示查询的 IP');
        assert(
          items.find((i) => i.badge === '归属地')?.metadata?.value === 'San Jose, California, United States',
          `ip 归属地错误，实得 ${items.find((i) => i.badge === '归属地')?.metadata?.value}`,
        );
        assert(items.find((i) => i.badge === 'ASN')?.title === 'AS15169', 'ip ASN 错误');
        assert(items.find((i) => i.badge === '运营商')?.title === 'Google LLC', 'ip 运营商错误');
        assert(items.find((i) => i.badge === '时区')?.title === 'America/Los_Angeles UTC-07:00', 'ip 时区错误');
        assert(items.find((i) => i.badge === '坐标')?.metadata?.value === '37.3393939, -121.8949553', 'ip 坐标错误');
      },
    },
  ],
  dict: [
    {
      tokens: ['hello'],
      queryDebounceMs: 300,
      expect: (items) => {
        assert(items.find((i) => i.badge === '单词')?.title === 'hello', 'dict 单词错误');
        assert(items.find((i) => i.badge === '音标')?.metadata?.value === '/həˈləʊ/', 'dict 音标错误');
        assert(
          items.find((i) => i.badge === '名词')?.metadata?.value?.includes('equivalent greeting'),
          'dict 名词释义错误',
        );
        assert(items.find((i) => i.badge === '动词')?.description?.includes('例：'), 'dict 动词应带例句说明');
        assert(items.find((i) => i.badge === '同义词')?.metadata?.value?.includes('salutation'), 'dict 同义词缺失');
        assert(items.find((i) => i.badge === '例句')?.title === 'She helloed the guests.', 'dict 例句错误');
        assert(items.find((i) => i.badge === '发音')?.metadata?.url?.endsWith('.mp3'), 'dict 应给出可播放的发音链接');
      },
      after: async (plugin, items) => {
        const audio = items.find((i) => i.badge === '发音');
        const after = await plugin.onSelect(audio);
        assert(after?.toast?.includes('浏览器'), `dict 打开发音应提示浏览器，实得 ${JSON.stringify(after)}`);
        assert(
          svcCalls.some((c) => c.method === 'svc.process.launch' && String(c.params?.target).endsWith('.mp3')),
          'dict 打开发音应调用 svc.process.launch',
        );
      },
    },
    {
      tokens: ['nonexistent'],
      queryDebounceMs: 300,
      expect: (items) => {
        assert(items[0].badge === '未找到', `dict 404 应提示「未找到」，实得 ${items[0].badge}`);
        assert(items[0].title.includes('nonexistent'), 'dict 404 应回显查询词');
      },
    },
  ],
  tr: [
    {
      tokens: ['hello', 'world'],
      queryDebounceMs: 300,
      expect: (items) => {
        assert(items.find((i) => i.badge === '译文')?.metadata?.value === '你好世界', 'tr 译文错误');
        assert(
          items.find((i) => i.badge === '语言')?.title === '英语 → 中文',
          `tr 语言对应为「英语 → 中文」，实得 ${items.find((i) => i.badge === '语言')?.title}`,
        );
        assert(items.find((i) => i.badge === '原文')?.metadata?.value === 'hello world', 'tr 原文错误');
        assert(items.some((i) => i.badge === '备选1'), 'tr 应给出备选译法');
        assert(
          !items.some((i) => i.badge === '备选2' && i.metadata?.value === '你好世界'),
          'tr 备选译法应去重（不应与主译文重复）',
        );
        assert(items.find((i) => i.badge === '匹配度')?.title === '匹配度 100%', 'tr 匹配度错误');
      },
    },
    {
      tokens: ['zh', 'hello'],
      queryDebounceMs: 300,
      expect: (items) => {
        assert(
          items[0].description?.includes('中文 → 英语'),
          `tr「/tr zh hello」应判为中文→英语，实得 ${items[0].description}`,
        );
      },
    },
  ],

  // ── D 组：屏幕能力（截图 / 取色 + 全局热键）───────────────────────────────
  shot: [
    {
      tokens: [],
      expect: (items) => {
        // 区域框选是桌面截图工具的主路径，必须排第一
        const first = items[0];
        assert(first.metadata?.action === 'region', `shot 首项应为区域框选，实得 ${first.metadata?.action}`);
        assert(
          first.metadata?.monitor === -1,
          `shot 默认应基于光标所在屏幕（-1），实得 ${first.metadata?.monitor}`,
        );
        // 整屏项降为第二项，仍保留（"截整个屏"是真实需求，只是不再是默认）
        assert(
          items[1]?.metadata?.action === 'capture',
          `shot 第二项应为整屏截图，实得 ${items[1]?.metadata?.action}`,
        );
        assert(
          items.filter((i) => i.metadata?.action === 'capture').length >= 3,
          'shot 应给出整屏主项 + 每块屏',
        );
        assert(
          items.filter((i) => i.metadata?.action === 'region').length >= 3,
          'shot 应给出框选主项 + 3s/5s 延时框选档位',
        );
        assert(
          items.some((i) => i.badge === '副屏' && i.title.includes('2560×1440')),
          'shot 应列出副屏尺寸（来自 svc.screen.list）',
        );
        // 说明类条目不该再混进可执行列表（G-3：它们曾造成"按回车无反应"的死条目）
        assert(
          !items.some((i) => i.metadata?.action === 'none'),
          'shot 面板不应混入不可执行的说明条目',
        );
      },
      after: async (plugin, items) => {
        // 区域框选：开全屏透明遮罩层 + 关主窗口
        const openBefore = svcCalls.length;
        const regionAfter = await plugin.onSelect(items[0]);
        assert(
          svcCalls.slice(openBefore).some((c) => c.method === 'svc.window.open' && c.params?.view === 'select'),
          'shot 框选应开 select 视图（manifest views 声明的 id）',
        );
        assert(
          regionAfter?.close === true,
          `shot 框选后应关掉主窗口（否则遮罩底图会拍到启动器），实得 ${JSON.stringify(regionAfter)}`,
        );

        // 整屏截图：图片本体进剪贴板
        const before = svcCalls.length;
        const after = await plugin.onSelect(items.find((i) => i.metadata?.action === 'capture'));
        assert(after?.refresh === true, `shot onSelect 应返回 refresh=true，实得 ${JSON.stringify(after)}`);
        const call = svcCalls.slice(before).find((c) => c.method === 'svc.screen.capture');
        assert(call, 'shot 应调用 svc.screen.capture');
        assert(call.params?.hideWindows === true, 'shot 截图前应隐藏 LiteLauncher 窗口');
        assert(
          call.params?.toClipboard === true,
          'shot 应要求图片本体进剪贴板（截图工具的默认交付物）',
        );

        // 刷新后应出现「最近截图」的三个操作项
        const fresh = await plugin.query(toParsed([]));
        const badges = fresh.items.map((i) => i.badge);
        assert(
          ['打开', '文件夹', '路径'].every((b) => badges.includes(b)),
          `shot 刷新后应出现 打开/文件夹/路径，实得 ${JSON.stringify(badges)}`,
        );
        const folder = fresh.items.find((i) => i.badge === '文件夹');
        assert(
          folder?.description?.endsWith('screenshots'),
          `shot「打开文件夹」应指向 screenshots 目录，实得 ${folder?.description}`,
        );
        // 复制项走壳层通用 copy 契约（此处是**路径**，图片走剪贴板本体）
        const copyAfter = await plugin.onSelect(fresh.items.find((i) => i.badge === '路径'));
        assert(String(copyAfter?.copy).endsWith('.png'), 'shot 路径项应回传文件路径');

        // 打开项走 svc.process.launch
        const launchBefore = svcCalls.length;
        await plugin.onSelect(fresh.items.find((i) => i.badge === '打开'));
        assert(
          svcCalls.slice(launchBefore).some(
            (c) => c.method === 'svc.process.launch' && String(c.params?.target).endsWith('.png'),
          ),
          'shot「打开」应经 svc.process.launch 交给系统查看器',
        );
      },
    },
    {
      tokens: ['2'],
      expect: (items) => {
        assert(
          items[0].metadata?.monitor === 2,
          `shot 2 应指定显示器 2，实得 ${items[0].metadata?.monitor}`,
        );
        assert(
          items[0].title.includes('区域') || items[0].title.includes('框选'),
          `shot 2 首项应是框选动作，实得 ${items[0].title}`,
        );
        // 副屏整屏项应带上显示器序号
        assert(
          items.some((i) => i.title.includes('显示器 2')),
          'shot 2 应给出显示器 2 的整屏项',
        );
      },
    },
    {
      tokens: ['-d3'],
      expect: (items) => {
        assert(
          items[0].metadata?.delayMs === 3000,
          `shot -d3 应解析为 3000ms，实得 ${items[0].metadata?.delayMs}`,
        );
        assert(items[0].title.includes('3 秒后'), `shot -d3 标题应体现延时，实得 ${items[0].title}`);
      },
    },
  ],
  clip: [
    {
      tokens: [],
      expect: (items) => {
        // 隐私策略与开关必须在最前面：用户第一眼就该看到、随手能关
        assert(
          items[0].metadata?.action === 'toggle-watch',
          `clip 首项应为监听开关，实得 ${items[0].metadata?.action}`,
        );
        assert(
          items[1].metadata?.action === 'clear',
          `clip 第二项应为清空，实得 ${items[1].metadata?.action}`,
        );
        assert(
          items[0].description?.includes('本机'),
          `clip 隐私说明应强调数据只存本机，实得 ${items[0].description}`,
        );
        assert(
          items[0].description?.includes('疑似凭据不记录'),
          `clip 隐私说明应体现"疑似凭据不记录"，实得 ${items[0].description}`,
        );
        // 无历史时给明确空态提示，而不是空白面板
        assert(
          items.some((i) => i.badge === '空'),
          'clip 无历史时应给出空态提示项',
        );
      },
      after: async (plugin, items) => {
        // 1) 普通过程：打开面板时把当前剪贴板入库，然后能看到它
        clipStore.text = 'npm run check 通过 ✅';
        const after = await plugin.query(toParsed([]));
        assert(
          after.items.some((i) => i.metadata?.value === 'npm run check 通过 ✅'),
          `clip 应把当前剪贴板入库并展示，实得 ${JSON.stringify(after.items.map((i) => i.title))}`,
        );
        const entry = after.items.find((i) => i.metadata?.action === 'recall');
        assert(entry, 'clip 应给出可回填条目');

        // 2) 回填：走宿主 recall 并回传 copy 契约，然后关窗（用户要能直接粘）
        const recallAfter = await plugin.onSelect(entry);
        assert(String(recallAfter?.copy).includes('npm run check'), 'clip 回填项应回传 copy');
        assert(recallAfter?.close === true, 'clip 回填后应关窗，让用户直接粘贴');
        assert(
          svcCalls.some((c) => c.method === 'svc.clipboard.history.recall' && c.params?.id === entry.metadata.id),
          'clip 回填应调 svc.clipboard.history.recall',
        );

        // 3) 隐私过滤：疑似凭据不得入库
        clipStore.text = 'password=SuperSecret123456';
        await plugin.query(toParsed([]));
        assert(
          !clipStore.entries.some((e) => e.text.includes('SuperSecret')),
          'clip 疑似凭据内容不应入库（隐私策略必须生效）',
        );

        // 4) 监听开关：能暂停（处理凭据时用户需要这个动作）
        const toggled = await plugin.onSelect(after.items.find((i) => i.metadata?.action === 'toggle-watch'));
        assert(toggled?.refresh === true, 'clip 切换监听应刷新面板');
        assert(clipStore.watching === false, 'clip 切换监听应真的关掉开关');
        const paused = await plugin.query(toParsed([]));
        assert(
          paused.items[0].badge === '已暂停',
          `clip 暂停后首项应标出"已暂停"，实得 ${paused.items[0].badge}`,
        );
        // 恢复开启，避免影响后续用例
        await plugin.onSelect(paused.items.find((i) => i.metadata?.action === 'toggle-watch'));

        // 5) 清空
        const cleared = await plugin.onSelect((await plugin.query(toParsed([]))).items.find((i) => i.metadata?.action === 'clear'));
        assert(cleared?.refresh === true, 'clip 清空应刷新面板');
        assert(clipStore.entries.length === 0, 'clip 清空后历史应为空');
        void items;
      },
    },
    {
      tokens: ['kubectl'],
      // 预置必须在首个 query 之前，否则 expect 看到的是空态。
      // 直接写 entries 而不是靠 ingest 灌：harness 每个用例前会 reset 桩，
      // 靠前一个用例留下的数据会因执行顺序而 flaky。
      before: async () => {
        clipStore.entries = [
          { id: 1, text: 'git push origin master', ts: Date.now() },
          { id: 2, text: 'kubectl rollout restart api', ts: Date.now() },
        ];
        clipStore.seq = 2;
        clipStore.text = 'kubectl rollout restart api';
      },
      expect: (items) => {
        assert(
          items.some((i) => i.badge === '搜索' && i.title.includes('kubectl')),
          'clip 带关键词时应给出搜索上下文项',
        );
        assert(
          items.some((i) => i.title.includes('rollout restart')),
          `clip 搜索应命中 kubectl 那条，实得 ${JSON.stringify(items.map((i) => i.title))}`,
        );
        assert(
          !items.some((i) => i.title.includes('git push')),
          'clip 搜索不应带出无关条目',
        );
      },
    },
  ],
  pick: [
    {
      tokens: [],
      expect: (items) => {
        assert(items[0].metadata?.action === 'pick', 'pick 首项应为取色动作');
        assert(
          items[0].metadata?.format === 'hex',
          `pick 默认取色格式应为 hex，实得 ${items[0].metadata?.format}`,
        );
        assert(items.some((i) => i.metadata?.action === 'panel'), 'pick 应提供打开取色台的入口');
        assert(
          items.some((i) => i.badge === '热键' && i.title.includes('alt+p')),
          'pick 应提示 alt+p 热键',
        );
        assert(items.some((i) => i.badge === '提示'), 'pick 无历史时应给出引导');
      },
      after: async (plugin) => {
        const before = svcCalls.length;
        const first = (await plugin.query(toParsed([]))).items[0];
        const after = await plugin.onSelect(first);
        assert(after?.refresh === true, `pick onSelect 应返回 refresh=true，实得 ${JSON.stringify(after)}`);
        assert(
          svcCalls.slice(before).some((c) => c.method === 'svc.screen.pixel'),
          'pick 取色应调用 svc.screen.pixel',
        );
        assert(
          svcCalls.some((c) => c.method === 'svc.clipboard.write' && c.params?.text === '#FF8800'),
          'pick 应把 HEX 写入剪贴板',
        );

        // 取色后历史进 KV，刷新面板即出现可复制项
        const fresh = await plugin.query(toParsed([]));
        const hexItem = fresh.items.find((i) => i.badge === 'HEX');
        assert(
          hexItem?.metadata?.value === '#FF8800',
          `pick 历史应记录 HEX，实得 ${JSON.stringify(hexItem?.metadata)}`,
        );
        assert(hexItem.description?.includes('最近一次取色'), 'pick 应标注最近一次取色');
        assert((await plugin.onSelect(hexItem))?.copy === '#FF8800', 'pick 历史项应回传 copy');

        // 格式切换：把最近颜色按 RGB / HSL 复制
        const rgbItem = fresh.items.find(
          (i) => i.metadata?.action === 'format' && i.metadata?.format === 'rgb',
        );
        assert(rgbItem, 'pick 应提供格式切换项');
        assert(
          rgbItem.description?.includes('rgb(255, 136, 0)'),
          `pick RGB 换算错误，实得 ${rgbItem.description}`,
        );
        const hslItem = fresh.items.find(
          (i) => i.metadata?.action === 'format' && i.metadata?.format === 'hsl',
        );
        assert(
          hslItem.description?.includes('hsl(32, 100%, 50%)'),
          `pick HSL 换算错误，实得 ${hslItem.description}`,
        );
        const rgbAfter = await plugin.onSelect(rgbItem);
        assert(
          rgbAfter?.toast?.includes('rgb(255, 136, 0)'),
          `pick RGB 复制提示错误，实得 ${rgbAfter?.toast}`,
        );

        // 打开取色台：走 svc.window.open 并关闭启动器
        const panelAfter = await plugin.onSelect(fresh.items.find((i) => i.metadata?.action === 'panel'));
        assert(panelAfter?.close === true, 'pick 打开取色台后应关闭启动器');
        assert(
          svcCalls.some((c) => c.method === 'svc.window.open' && c.params?.view === 'panel'),
          'pick 应调用 svc.window.open(view=panel)',
        );

        // 清空历史
        const clearItem = (await plugin.query(toParsed([]))).items.find(
          (i) => i.metadata?.action === 'clear',
        );
        assert((await plugin.onSelect(clearItem))?.refresh === true, 'pick 清空历史应刷新面板');
        const afterClear = await plugin.query(toParsed([]));
        assert(!afterClear.items.some((i) => i.badge === 'HEX'), 'pick 清空后不应再出现历史项');
      },
    },
    {
      tokens: ['rgb'],
      expect: (items) => {
        assert(
          items[0].metadata?.format === 'rgb',
          `pick rgb 应把取色格式切到 rgb，实得 ${items[0].metadata?.format}`,
        );
      },
    },
    {
      tokens: ['hsl'],
      expect: (items) => {
        assert(items[0].metadata?.format === 'hsl', 'pick hsl 应把取色格式切到 hsl');
      },
    },
  ],
// ── P2 /hotkey 全局热键速查（数据源是各插件自报的 hotkeys）────────────────
  // 注意：下面每个 before 都自行push 桩插件，且**不能清理** registered
  //（被测插件自己就在里面）。因此各用例用不同的桩插件名，避免跨用例累积——
  // 否则搜"截图"会命中上一个用例残留的同名桩。
  hotkey: [
    {
      tokens: [],
      // 速查表的数据来自插件注册表，而每个用例前 registered 会被清空，
      // 所以这里要自己造出"别的插件"，模拟真实的跨插件汇总场景。
      before: () => {
        registered.push(
          {
            id: 'shot-hk', trigger: '/shot-hk', name: '屏幕截图', icon: '📸', description: '',
            hotkeys: [{ accel: 'alt+shift+s', description: '免开启动器整屏截图' }],
          },
          {
            id: 'pick-hk', trigger: '/pick-hk', name: '取色器', icon: '🎨', description: '',
            hotkeys: [{ accel: 'alt+p', description: '取光标处颜色并复制 HEX' }],
          },
          {
            id: 'text-hk', trigger: '/text-hk', name: '文本转换', icon: '📝', description: '',
            // 无热键的插件不该凭空出现在速查表里
          },
        );
      },
      expect: (items) => {
        const accels = items.filter((i) => i.metadata?.value).map((i) => i.title);
        assert(accels.includes('Alt + Shift + S'), `速查表应含截图热键，实得 ${JSON.stringify(accels)}`);
        assert(accels.includes('Alt + P'), `速查表应含取色热键，实得 ${JSON.stringify(accels)}`);
        assert(accels.length === 2, `只应收录 2 个热键，实得 ${accels.length}：${JSON.stringify(accels)}`);
        // 无搜索时保留分组标题（速查表的价值是一眼看全）
        assert(items.some((i) => i.badge === '分组'), '速查表应保留分组标题');
        assert(items.some((i) => i.badge === '屏幕截图'), '热键项应标出归属插件');
      },
    },
    {
      tokens: ['截图'],
      expect: (items) => {
        // 搜"截图"只该命中截图热键，且搜索态不打分组（用户要的是找到那一个）
        const accels = items.filter((i) => i.metadata?.value).map((i) => i.title);
        assert(accels.length === 1 && accels[0] === 'Alt + Shift + S',
          `搜索应只命中截图热键，实得 ${JSON.stringify(accels)}`);
        assert(!items.some((i) => i.badge === '分组'), '搜索态不应显示分组标题');
      },
    },
    {
      tokens: ['不存在的键'],
      // 不可执行项（分组标题/空态/无匹配）必须给反馈，不能是按了没反应的死条目
      expect: (items) => {
        assert(items[0].badge === '无匹配', `无命中应明确提示，实得 ${items[0].badge}`);
      },
      after: async (plugin, items) => {
        const after = await plugin.onSelect(items[0]);
        assert(after?.toast, `不可执行项应给明确反馈，实得 ${JSON.stringify(after)}`);
      },
    },
    {
      tokens: [],
      // isolate：跑这个用例前把桩插件从注册表清空，只留被测插件自己。
      // /hotkey 自身不声明 hotkeys，于是等价于"全局一个热键都没有"的真实场景。
      isolate: true,
      expect: (items) => {
        assert(items[0].badge === '空', `无热键时应明确说明而不是空白，实得 ${items[0].badge}`);
      },
    },
  ],
  hash: [
    {
      tokens: ['md5', 'hello'],
      expect: (items) => {
        const md5 = items.find((i) => i.badge === 'MD5');
        assert(md5?.metadata?.value === '5d41402abc4b2a76b9719d911017c592', `md5 结果错: ${md5?.metadata?.value}`);
      },
    },
    {
      tokens: ['hello'],
      expect: (items) => {
        assert(items.some((i) => i.badge === 'SHA256'), '全量模式应包含 SHA256');
        assert(items.some((i) => i.badge === 'CRC32'), '全量模式应包含 CRC32');
        assert(items.some((i) => i.badge === '长度'), '应包含输入长度');
      },
    },
    {
      tokens: ['base64d', '5L2g5aW9'],
      expect: (items) => {
        assert(items.find((i) => i.badge === 'BASE64D')?.metadata?.value === '你好', 'base64 解码应还原中文');
      },
    },
    {
      tokens: ['url', 'a b'],
      expect: (items) => {
        assert(items.find((i) => i.badge === 'URL')?.metadata?.value === 'a%20b', 'URL 编码应把空格编成 %20');
      },
    },
    {
      tokens: ['html', '<a>'],
      expect: (items) => {
        assert(items.find((i) => i.badge === 'HTML')?.metadata?.value === '&lt;a&gt;', 'HTML 转义错');
      },
    },
    {
      tokens: ['crc32', 'hello'],
      expect: (items) => {
        assert(items.find((i) => i.badge === 'CRC32')?.metadata?.value === '3610a686', 'CRC32 结果错');
      },
    },
  ],
  cron: [
    {
      tokens: ['0', '9', '*', '*', '1-5'],
      expect: (items) => {
        const desc = items.find((i) => i.badge === '含义');
        assert(desc?.description?.includes('表达式：0 9 * * 1-5'), `描述缺表达式: ${desc?.description}`);
        assert(desc?.title?.includes('周一–周五'), `描述缺工作日: ${desc?.title}`);
        assert(items.filter((i) => i.metadata?.label === '触发时间').length === 5, '应给出 5 次触发');
      },
    },
    {
      tokens: ['*/15', '*', '*', '*', '*'],
      expect: (items) => {
        assert(items.filter((i) => i.metadata?.label === '触发时间').length === 5, '*/15 应给出 5 次触发');
        assert(items.find((i) => i.badge === '含义')?.title?.includes('每 15 分钟'), '步长描述错');
      },
    },
    {
      tokens: ['bad'],
      expect: (items) => {
        assert(items[0].badge === '错误', '非法表达式应显式报错');
      },
    },
  ],
  cidr: [
    {
      tokens: ['192.168.1.0/24'],
      expect: (items) => {
        assert(items.find((i) => i.badge === '网络')?.metadata?.value === '192.168.1.0', '网络地址错');
        assert(items.find((i) => i.badge === '广播')?.metadata?.value === '192.168.1.255', '广播地址错');
        assert(items.find((i) => i.badge === '主机数')?.metadata?.value === '254', '可用主机数错');
      },
    },
    {
      tokens: ['10.0.0.0/24', '4'],
      expect: (items) => {
        assert(items.find((i) => i.badge === '拆分')?.description === '新前缀 /26', '拆分前缀错');
        assert(items.filter((i) => /^#\d+$/.test(i.badge ?? '')).length === 4, '应拆出 4 个子网');
      },
    },
    {
      tokens: ['2001:db8::/32'],
      expect: (items) => {
        assert(items.find((i) => i.badge === '网络')?.metadata?.value === '2001:db8::', 'IPv6 网络地址错');
        assert(items.find((i) => i.badge === '末地址')?.metadata?.value === '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', 'IPv6 末地址错');
      },
    },
    {
      tokens: ['bad'],
      expect: (items) => assert(items[0].badge === '错误', '非法 IP 应报错'),
    },
  ],
  time: [
    {
      tokens: [],
      // /time 的主动作已改为弹桌面时钟，不再适用“选中即复制”的通用契约
      copyOnSelectOptOut: true,
      expect: (items, data) => {
        assert(items[0].badge === '本地', '首个应是本地时间');
        assert(
          items.filter((i) => i.metadata?.value && i.badge !== '本地').length === 14,
          '应列出 14 个城市（本地行也可复制，不计入）',
        );
        assert(/^\d{2}:\d{2}:\d{2}$/.test(items[0].title), `本地时间应带秒: ${items[0].title}`);
        assert(data.live === 1000, '面板应声明 live=1000（秒级实时刷新）');
      },
    },
    {
      tokens: ['纽约'],
      // /time 的主动作已改为弹桌面时钟，不再适用"选中即复制"的通用契约
      copyOnSelectOptOut: true,
      expect: (items) => {
        const city = items.find((i) => i.metadata?.label === '纽约');
        assert(city && /^\d{2}:\d{2}:\d{2}$/.test(city.title), `纽约时间格式错: ${city?.title}`);
        assert(city.metadata.value.startsWith('纽约 '), '复制值应以城市名开头');
        assert(
          city.metadata.tz === 'America/New_York' && city.metadata.fb === -5,
          `弹窗参数应带 tz 与固定偏移: ${JSON.stringify(city.metadata)}`,
        );
      },
      after: async (plugin) => {
        // 回车弹桌面时钟：走 svc.window.open，参数必须带城市与 IANA 时区
        const before = svcCalls.length;
        const data = await plugin.query(toParsed(['纽约']));
        await plugin.onSelect(data.items.find((i) => i.metadata?.label === '纽约'));
        const open = svcCalls.slice(before).find((c) => c.method === 'svc.window.open');
        assert(open, '回车应调用 svc.window.open 弹桌面时钟');
        assert(
          open.params.view === 'clock' &&
            open.params.params.city === '纽约' &&
            open.params.params.tz === 'America/New_York' &&
            open.params.params.fallback === -5,
          `弹窗参数错: ${JSON.stringify(open?.params)}`,
        );
        // Ctrl+Enter（actionId=copy）仍是复制路径
        const copied = await plugin.onSelect(
          data.items.find((i) => i.metadata?.label === '纽约'),
          'copy',
        );
        assert(
          typeof copied.copy === 'string' && copied.copy.startsWith('纽约 '),
          'copy 动作应回传复制值',
        );
      },
    },
    {
      tokens: ['不存在的城市'],
      expect: (items, data) => {
        assert(items[0].badge === '提示', '未知城市应给出提示');
        assert(data.live === undefined, '错误提示是静态的，不应声明 live');
      },
    },
  ],
  pwd: [
    {
      tokens: ['24'],
      expect: (items) => {
        assert(items.length === 6, `应生成 6 项，实得 ${items.length}`);
        assert(items[0].title.length === 24, '主密码长度应跟随参数');
        assert(items.find((i) => i.badge === 'PIN' && i.title.length === 6), '缺 6 位 PIN');
        assert(items.find((i) => i.badge === '短语')?.title.split('-').length === 3, '短语应为 3 词');
      },
    },
    {
      tokens: ['16', 'easy'],
      expect: (items) => {
        assert(/^[a-z]{16}$/.test(items[0].title), 'easy 模式应是小写字母');
      },
    },
    {
      tokens: ['20', 'nosym'],
      expect: (items) => {
        assert(!/[!@#$%^&*()\-_=+[\]{}<>?,.:;]/.test(items[0].title), 'nosym 不应含符号');
      },
    },
  ],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listFrontendPlugins() {
  const out = [];
  for (const dirent of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const id = dirent.name;
    const manifestPath = path.join(pluginsDir, id, 'manifest.json');
    const entry = path.join(pluginsDir, id, 'fe', 'src', 'index.ts');
    if (!existsSync(manifestPath) || !existsSync(entry)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.backend?.kind !== 'none') continue;
    out.push({ id, manifest, entry });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 校验面板结构：items 为数组、非空或带 emptyText、每项有 id/title */
function validatePanel(items, label, failures) {
  if (!Array.isArray(items)) {
    failures.push(`${label} 未返回 items 数组`);
    return false;
  }
  if (items.length === 0) {
    failures.push(`${label} 空 items（未校验 emptyText，请显式给提示项）`);
    return false;
  }
  for (const item of items) {
    if (!item.id || !item.title) {
      failures.push(`${label} 条目缺 id/title：${JSON.stringify(item).slice(0, 100)}`);
      return false;
    }
  }
  return true;
}

async function testPlugin({ id, entry }) {
  const failures = [];
  const cases = CASES[id] ?? [];

  // 每个插件用例前清空桩状态：模块缓存 / 注册表 / 插件私有 KV
  registered.length = 0;
  moduleCache.clear();
  settingsStore.clear();
  resetClipStore();
  let mod;
  try {
    mod = loadPluginModule(entry);
  } catch (err) {
    return { id, failures: [`加载失败: ${err.message}`] };
  }

  if (typeof mod.setup !== 'function') {
    return { id, failures: ['未导出 setup()'] };
  }
  try {
    mod.setup();
  } catch (err) {
    return { id, failures: [`setup() 抛错: ${err.message}`] };
  }

  const plugin = registered.find((p) => p.id === id);
  if (!plugin) {
    return { id, failures: [`setup() 未注册 id=${id} 的插件（已注册：${registered.map((p) => p.id).join(', ')}）`] };
  }
  if (typeof plugin.query !== 'function') return { id, failures: ['未实现 query()'] };

  for (const testCase of cases) {
    const label = testCase.tokens.length > 0 ? testCase.tokens.join(' ') : '(空输入)';
    try {
      // before 钩子：预置桩状态（如剪贴板内容/历史），必须早于首个 query，
      // 否则 expect 看到的还是空态。用例想自证"先造数据再看结果"时用它。
      if (typeof testCase.before === 'function') await testCase.before(plugin);

      // isolate：清掉 before 灌进来的桩插件，只留被测插件自己。
      // 有些空态分支（如"全局一个热键都没有"）必须先造数据、再造空数据才能覆盖到。
      if (testCase.isolate === true) registered.splice(0, registered.length, plugin);

      // 防抖回归护栏：网络插件一旦去掉 queryDebounceMs，壳层会退回逐键调用 query()
      // → 每敲一个字母打一次接口。这类 bug 肉眼看不见，所以在这里钉死。
      if (typeof testCase.queryDebounceMs === 'number') {
        const actual = plugin.queryDebounceMs;
        if (typeof actual !== 'number' || actual < 200 || actual > 600) {
          failures.push(
            `${id} 声明了联网用例，却未设置合理的 queryDebounceMs（实得 ${JSON.stringify(actual)}，期望 200–600）`,
          );
          continue;
        }
      }

      const data = await plugin.query(toParsed(testCase.tokens));
      if (!validatePanel(data.items, `query(${label})`, failures)) continue;
      if (typeof testCase.expectFirst === 'function') testCase.expectFirst(data.items);

      // expect 第二参拿到完整 PanelData：需要断言 live/emptyText 等容器级声明时用
      if (typeof testCase.expect === 'function') testCase.expect(data.items, data);
      const lastItems = data.items;

      // onSelect 复制契约：任一可复制项回传 copy。
      // copyOnSelectOptOut：主动作不是复制的插件（如 /time 弹桌面时钟）显式豁免
      const copyable =
        !testCase.copyOnSelectOptOut &&
        lastItems.find((i) => typeof i.metadata?.value === 'string' && i.metadata.value);
      if (copyable && typeof plugin.onSelect === 'function') {
        const after = await plugin.onSelect(copyable);
        if (after?.copy !== copyable.metadata.value) {
          failures.push(`onSelect 未回传 copy（期望 ${copyable.metadata.value}，实得 ${after?.copy}）`);
        }
      }

      if (typeof testCase.after === 'function') await testCase.after(plugin, lastItems);
    } catch (err) {
      failures.push(`query(${label}): ${err.message}`);
    }
  }

  return { id, failures };
}

/**
 * 纯函数模块测试：`.tsx` 在本脚手架里只能返回空模块（solid JSX 需编译期），
 * 所以插件里**可测的纯逻辑必须抽到 .ts**。这里覆盖最容易出错的几何换算——
 * 区域框选的坐标系一旦算错，截出来的是"另一块地方"，且很难一眼看出。
 */
function testGeometryModule() {
  const failures = [];
  const file = path.join(pluginsDir, 'shot', 'fe', 'src', 'geometry.ts');
  if (!existsSync(file)) return ['shot/fe/src/geometry.ts 不存在'];

  let g;
  try {
    moduleCache.clear();
    g = loadPluginModule(file);
  } catch (err) {
    return [`加载失败: ${err.message}`];
  }

  try {
    // 1) 反向拖拽（右下→左上）必须归一化成正宽高，否则 u32 转换会溢出成天文数字
    const r1 = g.normalizeDrag({ startX: 800, startY: 600, curX: 200, curY: 100 });
    assert(r1.x === 200 && r1.y === 100, `反向拖拽起点应为 min，实得 ${JSON.stringify(r1)}`);
    assert(r1.width === 600 && r1.height === 500, `反向拖拽宽高应为 abs 差，实得 ${JSON.stringify(r1)}`);

    // 2) 正向拖拽
    const r2 = g.normalizeDrag({ startX: 100, startY: 100, curX: 400, curY: 250 });
    assert(r2.x === 100 && r2.y === 100 && r2.width === 300 && r2.height === 150,
      `正向拖拽应保持原值，实得 ${JSON.stringify(r2)}`);

    // 3) 误触阈值：单击（宽高 0）应判为 tiny
    assert(g.isTinyDrag({ x: 0, y: 0, width: 0, height: 0 }) === true, '零面积应判为误触');
    assert(g.isTinyDrag({ x: 0, y: 0, width: 2, height: 40 }) === true, '宽度过小应判为误触');
    assert(g.isTinyDrag({ x: 0, y: 0, width: 100, height: 100 }) === false, '正常选区不应判为误触');

    // 4) 100% 缩放：CSS 坐标 == 物理坐标
    const g1 = g.cssToGlobal({ x: 10, y: 20, width: 300, height: 200 }, 1, { x: 0, y: 0 });
    assert(g1.x === 10 && g1.y === 20 && g1.width === 300 && g1.height === 200,
      `scale=1 时应原样透传，实得 ${JSON.stringify(g1)}`);

    // 5) HiDPI 150%：CSS → 物理要乘 scale
    const g2 = g.cssToGlobal({ x: 10, y: 20, width: 300, height: 200 }, 1.5, { x: 0, y: 0 });
    assert(g2.x === 15 && g2.y === 30, `150% 下原点应乘 1.5，实得 ${JSON.stringify(g2)}`);
    assert(g2.width === 450 && g2.height === 300, `150% 下宽高应乘 1.5，实得 ${JSON.stringify(g2)}`);

    // 6) 副屏在主屏右侧：必须加上屏原点，否则整体偏移一个屏幕宽
    const g3 = g.cssToGlobal({ x: 0, y: 0, width: 100, height: 100 }, 1, { x: 1920, y: 0 });
    assert(g3.x === 1920 && g3.y === 0, `应叠加显示器原点，实得 ${JSON.stringify(g3)}`);

    // 7) 副屏在主屏左侧（负坐标）：仍应正确叠加
    const g4 = g.cssToGlobal({ x: 10, y: 10, width: 50, height: 50 }, 1, { x: -1280, y: 0 });
    assert(g4.x === -1270 && g4.y === 10, `负原点屏应正确叠加，实得 ${JSON.stringify(g4)}`);

    // 8) 零/负宽高必须被夹到 1，避免宿主 u32 转换溢出
    const g5 = g.cssToGlobal({ x: 0, y: 0, width: 0, height: 0 }, 1, { x: 0, y: 0 });
    assert(g5.width >= 1 && g5.height >= 1, `零宽高应夹到至少 1，实得 ${JSON.stringify(g5)}`);

    // 9) 尺寸描述按物理像素呈现（用户看到的是真实像素数）
    assert(g.describeSize({ x: 0, y: 0, width: 200, height: 100 }, 1.5) === '300 × 150',
      `描述应按物理像素，实得 ${g.describeSize({ x: 0, y: 0, width: 200, height: 100 }, 1.5)}`);
  } catch (err) {
    failures.push(err.message);
  }
  return failures;
}

/**
 * 纯函数模块测试：`/pomo` 桌面挂件的倒计时推导与进度环。
 *
 * 这块是挂件最容易出错的地方，而且错得**很显眼**（用户盯着桌面看）：
 *   - 剩余 59.6 秒若用 floor 会显示 00:59，凭空少一秒 → 必须 ceil
 *   - 进度是"已过比例"，写成"剩余比例"会让环在开始时是满的
 *   - 到点后不能退回"未计时"，否则挂件会闪回 25:00 而不是停在 00:00
 *   - 时钟取整：59.999 秒要显示 01:00
 */
function testPomoTimerModule() {
  const failures = [];
  const file = path.join(pluginsDir, 'pomo', 'fe', 'src', 'timer.ts');
  if (!existsSync(file)) return ['pomo/fe/src/timer.ts 不存在'];

  let T;
  try {
    moduleCache.clear();
    T = loadPluginModule(file);
  } catch (err) {
    return [`加载失败: ${err.message}`];
  }

  try {
    // 1) 倒计时取整用 ceil：59.6s 应显示 01:00（还有一分钟），不是 00:59
    assert(T.formatCountdown(59_600) === '01:00',
      `59.6s 应显示 01:00（ceil），实得 ${T.formatCountdown(59_600)}`);
    assert(T.formatCountdown(59_000) === '00:59',
      `59s 应显示 00:59，实得 ${T.formatCountdown(59_000)}`);
    assert(T.formatCountdown(60_000) === '01:00', '60s 应显示 01:00');
    assert(T.formatCountdown(0) === '00:00', '0 应显示 00:00');
    assert(T.formatCountdown(-5000) === '00:00',
      `负数应夹到 00:00 而非显示负值，实得 ${T.formatCountdown(-5000)}`);
    assert(T.formatCountdown(NaN) === '00:00', 'NaN 应兜成 00:00');
    assert(T.formatCountdown(25 * 60_000) === '25:00', '25 分钟应为 25:00');

    // 2) HH:MM 补零
    const hhmm = T.formatClock(new Date(2026, 0, 1, 9, 5).getTime());
    assert(hhmm === '09:05', `9:05 应补零为 09:05，实得 ${hhmm}`);

    // 3) 进度是"已过比例"：刚开始应接近 0，快结束应接近 1
    const now = 1_700_000_000_000;

    // 3a) 回归：sidecar 用 Python time.time() 写的是**秒级**时间戳，
    // 而 deriveView 要拿它和 Date.now()（毫秒）比。若不归一，
    // remainingMs 恒为巨大负数 → 永远显示 00:00 且进度走满，且零报错。
    const secNow = 1_700_000_000;
    assert(T.normalizeTargetMs(String(secNow + 25 * 60)) === (secNow + 25 * 60) * 1000,
      '秒级 target 应被换算成毫秒');
    assert(T.normalizeTargetMs(String(now)) === now,
      '已是毫秒的 target 应原样保留（不能重复 ×1000）');
    assert(T.normalizeTargetMs('') === 0 && T.normalizeTargetMs(null) === 0,
      '空值应归零而不是变成 NaN');
    assert(T.normalizeTargetMs('abc') === 0, '非数字应归零');
    assert(T.normalizeTargetMs('0') === 0 && T.normalizeTargetMs('-5') === 0,
      '0 与负数应归零');
    // 端到端：归一后喂给 deriveView，必须得到正常的 25:00 而非 00:00
    const normalized = T.deriveView(
      { target: T.normalizeTargetMs(String(secNow + 25 * 60)), label: '写代码', minutes: 25 },
      secNow * 1000,
    );
    assert(normalized.text === '25:00',
      `归一后应显示 25:00 而非 00:00（秒/毫秒混用的回归），实得 ${normalized.text}`);
    assert(normalized.running === true, '归一后应处于计时中');
    assert(normalized.progress < 0.01, `归一后进度应接近 0，实得 ${normalized.progress}`);

    const started = T.deriveView({ target: now + 25 * 60_000, label: '写代码', minutes: 25 }, now);
    assert(started.running === true, '未到点应running=true');
    assert(started.text === '25:00', `刚开始应显示 25:00，实得 ${started.text}`);
    assert(started.progress < 0.01,
      `刚开始进度应接近 0（已过比例，不是剩余比例），实得 ${started.progress}`);
    assert(started.label === '写代码', '标签应透传');

    // 4) 跑了一半：进度约 0.5
    const half = T.deriveView({ target: now + 25 * 60_000, label: '', minutes: 25 }, now + 12.5 * 60_000);
    assert(Math.abs(half.progress - 0.5) < 0.01,
      `过半时进度应约 0.5，实得 ${half.progress}`);
    assert(half.label === '专注', '空标签应回落为「专注」');

    // 4b) 回归：暂停态展示。sidecar 暂停时 target=0、剩余秒数在 paused_remain。
    // 若挂件直接把该快照喂给 deriveView 会得到 IDLE_VIEW（"准备开始"），
    // 冻结时间与恢复入口全部丢失——真机反馈"暂停后无法恢复"的根源。
    const paused = T.derivePaused(4 * 60 + 54, 'nihc', 25);
    assert(paused.text === '04:54', `暂停态应显示冻结的 04:54，实得 ${paused.text}`);
    assert(paused.running === false, '暂停态 running 应为 false（显示继续按钮而非暂停）');
    assert(paused.label.includes('已暂停'), `暂停态标签应带「已暂停」，实得 ${paused.label}`);
    assert(paused.label.includes('nihc'), '暂停态标签应保留任务名');
    assert(Math.abs(paused.progress - (1 - (4 * 60 + 54) / (25 * 60))) < 0.01,
      '暂停态进度应按已过比例冻结，实得 ${paused.progress}');
    assert(paused.endAt === '', '暂停态不应显示结束时刻');
    assert(T.derivePaused(0, 'x', 25).text === '00:00', '剩余 0 应显示 00:00');
    assert(T.derivePaused(-5, 'x', 25).text === '00:00', '负剩余应夹到 00:00');

    // 5) 快结束：进度应接近 1 但不越界
    const almost = T.deriveView({ target: now + 25 * 60_000, label: 'x', minutes: 25 }, now + 24.9 * 60_000);
    assert(almost.progress > 0.99 && almost.progress <= 1,
      `临近结束进度应接近 1 且不越界，实得 ${almost.progress}`);

    // 6) 到点：running=false、文本 00:00、进度走满 1
    //    关键是**不能**退回IDLE_VIEW（否则挂件会闪回 25:00）
    const done = T.deriveView({ target: now - 1, label: '写代码', minutes: 25 }, now);
    assert(done.running === false, '到点后 running 应为 false');
    assert(done.text === '00:00', `到点应显示 00:00，实得 ${done.text}`);
    assert(done.progress === 1, `到点进度应为 1，实得 ${done.progress}`);
    assert(done.label === '写代码', '到点后仍应保留标签（UI 据此显示"时间到"）');

    // 7) 未计时（target=0）：走IDLE_VIEW 兜底
    const idle = T.deriveView({ target: 0, label: '', minutes: 0 }, now);
    assert(idle.running === false, '未计时 running 应为 false');
    assert(idle.progress === 0, '未计时进度应为 0');
    assert(idle.text === T.IDLE_VIEW.text, '未计时应显示 IDLE_VIEW 的默认文本');

    // 8) 进度越界防御：目标时间早于现在很多（时钟回拨）也不得产生负进度
    const skewed = T.deriveView({ target: now - 3_600_000, label: 'x', minutes: 25 }, now);
    assert(skewed.progress >= 0 && skewed.progress <= 1,
      `进度必须夹在 0~1，实得 ${skewed.progress}`);

    // 9) 进度环 dasharray：满进度应等于整圈，且两个数都在
    const full = T.arcDasharray(1, 26).split(' ').map(Number);
    const circ = 2 * Math.PI * 26;
    assert(Math.abs(full[0] - circ) < 0.01, `满进度弧长应等于周长 ${circ.toFixed(2)}，实得 ${full[0]}`);
    assert(Math.abs(full[1] - circ) < 0.01, `第二段应也是周长（留空隙），实得 ${full[1]}`);

    const zero = T.arcDasharray(0, 26).split(' ').map(Number);
    assert(zero[0] === 0, `零进度弧长应为 0，实得 ${zero[0]}`);

    // 10) 越界进度要被夹住（浮点误差 / 上游脏数据都不该让环消失）
    const over = T.arcDasharray(1.8, 26).split(' ').map(Number);
    assert(Math.abs(over[0] - circ) < 0.01, `超过 1 的进度应夹到满圈，实得 ${over[0]}`);
    const under = T.arcDasharray(-0.5, 26).split(' ').map(Number);
    assert(under[0] === 0, `负进度应夹到 0，实得 ${under[0]}`);

    // 11) 专注 : 短休 = 5 : 1。必须与 sidecar 的 break_minutes_of 同结果，
    // 否则面板写着「接 5 分钟短休」、挂件环按别的分母画。
    assert(T.BREAK_RATIO === 5, `比例应为 5，实得 ${T.BREAK_RATIO}`);
    assert(T.breakMinutesOf(5) === 1, `5 分钟专注的短休应为 1 分钟（最少 1 分钟）`);
    assert(T.breakMinutesOf(25) === 5, `25 → 5，实得 ${T.breakMinutesOf(25)}`);
    assert(T.breakMinutesOf(30) === 6, `30 → 6，实得 ${T.breakMinutesOf(30)}`);
    assert(T.breakMinutesOf(7) === 1, `7 → round(1.4)=1，实得 ${T.breakMinutesOf(7)}`);
    assert(T.breakMinutesOf(1) === 1, '1 分钟专注也得给 1 分钟短休（0 会让进度环分母为 0）');
    assert(T.breakMinutesOf(0) === T.breakMinutesOf(25), '非法输入应回落到默认 25 的短休');
    assert(T.breakMinutesOf(NaN) === 5 && T.breakMinutesOf(-3) === 5,
      'NaN/负数应回落到默认，不得算出 0 或负短休');
    // 与 native 后端同源规则的**跨语言一致性**：两边各写一遍就容易各错一遍。
    // pomo 已从 Python sidecar 迁为 native 动态库，比对对象随之改为 Rust 源码。
    const rsSrc = readFileSync(path.join(pluginsDir, 'pomo', 'be', 'src', 'lib.rs'), 'utf8');
    const rsRatio = rsSrc.match(/const BREAK_RATIO:\s*i64\s*=\s*(\d+)/);
    assert(rsRatio && Number(rsRatio[1]) === T.BREAK_RATIO,
      `pomo/be 的 BREAK_RATIO 必须与 timer.ts 一致，实得 ${rsRatio && rsRatio[1]}`);

    // 12) 段名
    assert(T.phaseName('break') === '短休', 'break 应显示「短休」');
    assert(T.phaseName('focus') === '专注', 'focus 应显示「专注」');
    assert(T.phaseName(undefined) === '专注', '未知段别应回落到「专注」而不是显示英文');

    // 13) hold 态：一段跑完等人工点下一段。**不能**等同未计时——
    // 未计时显示「25:00 准备开始」，正是用户反馈"倒计时结束后窗口显示 25:00"的错处。
    const hold = T.deriveHold(2, 25);
    assert(hold.running === false, 'hold 态不在计时');
    assert(hold.text === '待开始', `hold 态环心应显示「待开始」，实得 ${hold.text}`);
    assert(hold.progress === 1, 'hold 态进度环应走满（这段确实跑完了）');
    assert(hold.label === '已完成 2 轮', `hold 标签应说明完成轮数，实得 ${hold.label}`);
    assert(T.deriveHold(-1, 25).label === '已完成 0 轮', '负轮数应夹到 0');

    // 14) sidecar 单键快照解析：挂件每秒读一次，脏数据不能让它整帧崩掉
    assert(T.parseSidecarState(null) === null, '缺 snap 键应返回 null 以触发散装键回退');
    assert(T.parseSidecarState('') === null, '空串应返回 null');
    assert(T.parseSidecarState('{坏 JSON') === null, '损坏的 JSON 应返回 null 而不是抛异常');
    assert(T.parseSidecarState('[1,2]') === null, '数组不是合法状态快照');
    const secTarget = 1_700_000_900; // Python time.time() 的秒级时间戳
    const parsed = T.parseSidecarState(JSON.stringify({
      target: secTarget, label: '写代码', minutes: 25, paused_remain: 0,
      phase: 'focus', next_phase: 'break', rounds: 3, auto: true, hold: false,
    }));
    assert(parsed !== null, '合法快照应解析成功');
    assert(parsed.targetMs === secTarget * 1000, 'snap 里的 target 也是秒级，必须同样换算成毫秒');
    assert(parsed.rounds === 3 && parsed.auto === true && parsed.hold === false,
      '分段字段应原样取出');
    assert(parsed.nextPhase === 'break', 'next_phase 决定「点 ▶ 开始短休」的文案');
    const loose = T.parseSidecarState(JSON.stringify({
      target: '1700000900', rounds: '3', auto: '0', hold: '1', next_phase: 'nope',
    }));
    assert(loose.targetMs === secTarget * 1000, '数字字符串应可用');
    assert(loose.auto === false && loose.hold === true, "'0'/'1' 字符串应正确判真伪");
    assert(loose.label === '' && loose.minutes === 0 && loose.rounds === 3,
      '缺失字段应回落空值而不是 undefined');
    assert(loose.nextPhase === 'focus', '未知段别应回落到「专注」而不是保留脏值');

    // 15) 散装键回退：升级前的旧状态没有 snap 键，auto 缺省必须为「开」
    // （用户要求"初始 add 后就是自动勾选"）
    const fb = T.stateFromParts({ target: String(secTarget), label: 'x', minutes: '25' });
    assert(fb.auto === true, 'auto 键缺失时应默认开启自动衔接');
    assert(fb.targetMs === secTarget * 1000, '回退路径同样要归一时钟');
    assert(T.stateFromParts({ auto: '0' }).auto === false, '显式关闭应被尊重');
    assert(T.stateFromParts({}).hold === false, '缺 hold 键应视为不在 hold');
    assert(T.stateFromParts({ nextPhase: 'break' }).nextPhase === 'break',
      '回退路径也应读出分段字段，否则按钮文案退回「开始专注」');
  } catch (err) {
    failures.push(err.message);
  }
  return failures;
}

/**
 * 纯函数模块测试：`/pomo` 挂件的悬停伸缩几何。
 *
 * 这块的坑都在"数字之间的关系"上，单测比真机点得快：
 *   - 收拢宽度装不下静态内容 → 标签被裁
 *   - 展开宽度装不下两个按钮 → 按钮被窗口切掉
 *   - 逐帧宽度不单调 / NaN 外溢 → 动画抖动、窗口尺寸被设成 NaN
 *   - manifest 的 width/min_width 与代码常量漂移 → set_size 被 min_inner_size 夹住，
 *     表现为"代码在动、窗口不动"（最难查的一种失效）
 *
 * 锚定（右边缘钉住）与物理↔逻辑像素换算已上收宿主的
 * svc.window.setContentSize，那部分在 ll-plugin-api 的 cargo 单测里验。
 */
function testPomoHoverModule() {
  const failures = [];
  const file = path.join(pluginsDir, 'pomo', 'fe', 'src', 'hover-size.ts');
  if (!existsSync(file)) return ['pomo/fe/src/hover-size.ts 不存在'];

  let H;
  try {
    moduleCache.clear();
    H = loadPluginModule(file);
  } catch (err) {
    return [`加载失败: ${err.message}`];
  }

  try {
    // 1) 悬停态与宽度对应，且展开一定更宽
    assert(H.widthFor(false) === H.COLLAPSED_W, '未悬停应为收拢宽度');
    assert(H.widthFor(true) === H.EXPANDED_W, '悬停应为展开宽度');
    assert(H.EXPANDED_W > H.COLLAPSED_W, '展开宽度必须大于收拢宽度');

    // 2) 收拢宽度要装得下静态内容：内边距28 + 环64 + 间距10 + 标签
    assert(H.COLLAPSED_W >= 28 + 64 + 10 + H.LABEL_W,
      `收拢宽度 ${H.COLLAPSED_W} 装不下环+标签，标签会被裁`);

    // 3) 展开多出的余量要够放**按钮上限**那么多按钮。
    //    MAX_BTNS 必须不小于挂件实际可能同时渲染的按钮数（↻ 自动衔接 +
    //    当前动作 + ✕ = 3），否则悬停时最后一个按钮会被窗口右边缘切掉。
    assert(H.MAX_BTNS >= 3,
      `MAX_BTNS=${H.MAX_BTNS}，但 hold/暂停态悬停会同时出现 ↻ + 动作 + ✕ 三个按钮`);
    assert(H.EXPANDED_W - H.COLLAPSED_W >= (H.LABEL_W_HOVER - H.LABEL_W)
        + H.MAX_BTNS * H.BTN + (H.MAX_BTNS - 1) * H.BTN_GAP + H.GAP,
      `展开增量 ${H.EXPANDED_W - H.COLLAPSED_W} 放不下 ${H.MAX_BTNS} 个按钮，按钮会被裁`);

    // 4) easing 端点与夹取
    assert(H.easeOutCubic(0) === 0, 'easeOutCubic(0) 应为 0');
    assert(H.easeOutCubic(1) === 1, 'easeOutCubic(1) 应为 1');
    assert(H.easeOutCubic(-3) === 0 && H.easeOutCubic(9) === 1, '越界进度应夹到 0~1');
    assert(H.easeOutCubic(NaN) === 0, 'NaN 应兜成 0，否则窗口尺寸会被设成 NaN');
    assert(H.easeOutCubic(0.5) > 0.5, 'ease-out 前半段应跑得比线性快');
    assert(H.easeOutCubic(0.25) < H.easeOutCubic(0.75), 'easing 必须单调递增');

    // 5) 逐帧宽度序列：端点正确、越界夹住、NaN 不外溢
    //    （锚定与物理↔逻辑换算已上收宿主 svc.window.setContentSize，见 cargo 单测）
    const seq = (from, to) => [0, 0.1, 0.35, 0.6, 0.9, 1].map((t) => H.lerp(from, to, H.easeOutCubic(t)));
    const widths = seq(H.COLLAPSED_W, H.EXPANDED_W);
    assert(Math.abs(widths[0] - H.COLLAPSED_W) < 1e-9, 't=0 应等于起始宽度');
    assert(Math.abs(widths[widths.length - 1] - H.EXPANDED_W) < 1e-9, 't=1 应等于目标宽度');
    assert(widths.every((w, i) => i === 0 || w >= widths[i - 1]), '逐帧宽度必须单调，否则动画来回抖');
    assert(
      Math.abs(H.lerp(H.COLLAPSED_W, H.EXPANDED_W, H.easeOutCubic(4)) - H.EXPANDED_W) < 1e-9,
      't>1 应夹到目标宽度',
    );
    assert(
      Number.isFinite(H.lerp(H.COLLAPSED_W, H.EXPANDED_W, H.easeOutCubic(NaN))),
      'NaN 进度必须落在有限宽度上，否则窗口尺寸被设成 NaN',
    );

    // 6) 尺寸来源单一：挂件不再自己算坐标（历史上它读 outerPosition/scaleFactor，
    //    HiDPI 与多屏下都是要人守的坑），也不再手写 startDragging
    const src = readFileSync(path.join(pluginsDir, 'pomo', 'fe', 'src', 'widget.tsx'), 'utf8');
    assert(!/scaleFactor\s*\(/.test(src), 'widget.tsx 不应再自己读 scaleFactor()：像素换算归宿主');
    assert(!/setPosition\s*\(/.test(src), 'widget.tsx 不应再自己摆窗口位置：锚定归宿主');
    assert(/windows\.setContentSize/.test(src), 'widget.tsx 应通过 ctx.windows.setContentSize 改宽度');
    assert(
      /data-tauri-drag-region="deep"/.test(src) && !/startDragging\s*\(/.test(src),
      '拖拽应交给 data-tauri-drag-region，而不是手写 startDragging()',
    );
    assert(!/frameAt|leftEdgeOf/.test(src), 'widget.tsx 不应再引用已上收宿主的帧几何函数');

    // 7) 与 manifest 对齐：窗口默认宽/最小宽 = 收拢宽度。
    //    min_width 若仍是展开宽度，set_size 会被夹住，动画看着在跑窗口却不动
    const manifest = JSON.parse(
      readFileSync(path.join(pluginsDir, 'pomo', 'manifest.json'), 'utf8'),
    );
    const view = manifest.views.find((v) => v.id === 'widget');
    assert(view, 'manifest 应有 widget 视图');
    assert(view.width === H.COLLAPSED_W,
      `视图默认宽应为收拢宽度 ${H.COLLAPSED_W}，实得 ${view.width}`);
    assert(view.min_width <= H.COLLAPSED_W,
      `min_width 若大于收拢宽度 ${H.COLLAPSED_W}，set_size 会被夹住（看着在动、窗口不动），实得 ${view.min_width}`);
    assert(view.height === H.WIDGET_H && view.min_height === H.WIDGET_H,
      `视图高度应为 ${H.WIDGET_H}`);
    assert(view.min_width <= H.EXPANDED_W, 'min_width 不得大于展开宽度');

    // 8) 标签宽度也要与 CSS 对齐：hover-size 是按"标签占多少"算总宽的，
    //    CSS 改了而常量没改，窗口就会比内容窄一截（按钮被切掉）或反之留大块空白
    const css = readFileSync(path.join(pluginsDir, 'pomo', 'fe', 'src', 'widget.css'), 'utf8');
    const labelW = css.match(/\.pw-label\s*\{[^}]*max-width:\s*(\d+)px/);
    assert(labelW && Number(labelW[1]) === H.LABEL_W,
      `CSS 的 .pw-label 宽度应为 ${H.LABEL_W}，实得 ${labelW && labelW[1]}`);
    const labelWHover = css.match(/\.pw-root\.pw-hovered\s+\.pw-label\s*\{[^}]*max-width:\s*(\d+)px/);
    assert(labelWHover && Number(labelWHover[1]) === H.LABEL_W_HOVER,
      `悬停态标签宽度应为 ${H.LABEL_W_HOVER}，实得 ${labelWHover && labelWHover[1]}`);
  } catch (err) {
    failures.push(err.message);
  }
  return failures;
}

/**
 * 弹出式基窗（宿主 `auto_height` + SDK `mountPopup` + @ll/ui popup.css）的回归。
 *
 * 这块的价值分两层：
 *
 * 1) **声明层**——manifest 少写一个字段，症状只出现在真机且很难归因：
 *    - 漏 `decorated:false` → 用户看到系统标题栏（正是这次问题的起因）
 *    - 漏 `resizable:false` → 手拉边框与 set_size 打架，窗口在两种高度间跳
 *    - `min_width`/`min_height` 只写一个 → 宿主的 `min_inner_size` 整条不生效，
 *      窗口可以被压到看不见（services.rs 只在两者同时声明时才下发下限）
 *    - 视图标签没登记进 `capabilities/default.json` → **死窗**：窗口建得出来、
 *      IPC 全部被权限层拒掉，表现为"点了没反应"。这条是本块价值最高的一断。
 * 2) **行为层**——mountPopup 的取样与挂起规则：漏了死区会每帧打 IPC，
 *    漏了拖拽挂起就是 pomo 当年那个"拖完弹回"（系统拖拽事务进行中改窗口几何，
 *    松手瞬间被拖拽基准覆盖）。
 */
function testPopupBaseWindow() {
  const failures = [];
  const POPUP_MIN_H_FLOOR = 96.0; // 与 ll-plugin-api 的 POPUP_MIN_H_FLOOR 保持一致

  // ── 1) 声明层 ────────────────────────────────────────────
  try {
    const autoViews = [];
    for (const dir of readdirSync(pluginsDir)) {
      const file = path.join(pluginsDir, dir, 'manifest.json');
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      for (const v of manifest.views ?? []) {
        if (v.auto_height) autoViews.push({ plugin: manifest.id, view: v });
      }
    }
    assert(autoViews.length >= 2, `应至少收编 detail 与 reminder 两个 auto_height 视图，实得 ${autoViews.length}`);

    for (const { plugin, view } of autoViews) {
      const who = `${plugin}/${view.id}`;
      assert(view.decorated === false, `${who}: auto_height 必须 decorated:false，否则还剩一条系统标题栏`);
      assert(view.resizable === false, `${who}: 内容驱动高度必须 resizable:false，否则用户拖框与 set_size 互相打架`);
      // 下限只在 min_width 与 min_height **同时**声明时才下发（services.rs 的 only-both 规则）
      assert(
        (view.min_width === undefined) === (view.min_height === undefined),
        `${who}: min_width / min_height 必须成对声明，只写一个等于没写`,
      );
      assert(typeof view.max_height === 'number', `${who}: 必须声明 max_height，否则长内容会把窗口撑到全屏`);
      assert(view.height <= view.max_height, `${who}: 首帧 height(${view.height}) 不应大于 max_height(${view.max_height})`);
      // GTK 会把子控件下限夹到 200×200，宿主对 auto_height 用 POPUP_MIN_H_FLOOR 兜底；
      // 声明值低于这个兜底就是自欺——窗口缩不到那里，代码却在往那里报
      assert(view.min_height >= POPUP_MIN_H_FLOOR,
        `${who}: min_height(${view.min_height}) 低于宿主兜底 ${POPUP_MIN_H_FLOOR}，缩不到声明值`);
      assert(view.min_height < view.max_height, `${who}: min_height 必须小于 max_height`);
    }

    // 死窗防护：宿主建窗标签是 `<plugin>-<view>`，带 unique_by 时是 `<plugin>-<view>-<值>`
    const caps = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8'));
    const matched = (label) =>
      caps.windows.some((g) => (g.endsWith('*') ? label.startsWith(g.slice(0, -1)) : g === label));
    for (const dir of readdirSync(pluginsDir)) {
      const file = path.join(pluginsDir, dir, 'manifest.json');
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      for (const v of manifest.views ?? []) {
        const exact = `${manifest.id}-${v.id}`;
        assert(matched(exact), `capabilities 未登记窗口 ${exact}，该视图会是个建得出来却收不到 IPC 的死窗`);
        if (v.unique_by) {
          const suffixed = `${exact}-abc1234`;
          assert(matched(suffixed), `capabilities 未登记带实例后缀的 ${suffixed}（unique_by 的窗口拿不到权限）`);
        }
      }
    }
  } catch (err) {
    failures.push(err.message);
  }

  // ── 样式作用域 ───────────────────────────────────────────
  try {
    const css = readFileSync(path.join(pluginsDir, 'ui', 'src', 'popup.css'), 'utf8');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...stripped.matchAll(/([^{}]+)\{/g)].flatMap((m) =>
      m[1].split(',').map((s) => s.trim()).filter(Boolean),
    );
    assert(selectors.length > 0, 'popup.css 没解析出任何规则');
    for (const sel of selectors) {
      assert(sel.startsWith('body.ll-popup-mode'),
        `popup.css 的选择器 "${sel}" 没挂在 body.ll-popup-mode 下，会漏进启动器主窗`);
    }
    // index.html 用 !important 钉死了 html/body/#root 的底色与 overflow，压不住就等于没写
    const bodyRule = stripped.match(/body\.ll-popup-mode\s*\{([^}]*)\}/);
    assert(bodyRule && /background-color:[^;]*!important/.test(bodyRule[1]),
      'popup.css 对 body 底色必须带 !important，否则浅色主题下是"亮卡片坐在深色底板上"');
    assert(bodyRule && /overflow:\s*hidden\s*!important/.test(bodyRule[1]),
      'popup.css 必须把 body 的 overflow 钉成 hidden !important：标准三段式里窗口本身不滚，滚动只发生在内容区');
    assert(/body\.ll-popup-mode\s*(?:>\s*)?#root\s*\{[^}]*height:\s*100%\s*!important/.test(stripped),
      '#root 必须钉成窗口高（100% !important），骨架才能铺满窗口、标题/状态栏才钉得住');
    assert(/scrollbar-width:\s*thin\s*!important/.test(stripped)
      && /-webkit-scrollbar[\s\S]*display:\s*block\s*!important/.test(stripped),
      '要恢复可见滚动条：全局把滚动条藏了，弹窗里藏起来等于告诉用户"下面没有内容"');
    // index.html 的 `html, body, #root { color:#f3f4f6 !important }` 是 ID 权重 (1,0,0)，
    // 只写在 body 上会被 #root 挡回去 —— 真机症状是"没自己声明 color 的标题浅到看不见"。
    const rootRule = stripped.match(/body\.ll-popup-mode\s*>\s*#root\s*\{([^}]*)\}/);
    assert(rootRule && /color:[^;]*!important/.test(rootRule[1]),
      '#root 的字色也必须重写，否则弹窗标题继承 index.html 的深色主题字色');
    // 三段式：头尾是 flex 固定段，内容区是唯一的滚动区。不要改回"body 滚动 + 标题
    // sticky"——index.html 给 #root 写死的 overflow:hidden 会让 sticky 找错滚动容器
    //（sticky 只认最近的 overflow≠visible 祖先，而 #root 永远不滚），
    // 症状就是"一滚标题也跟着滚走了"。
    const headRule = stripped.match(/body\.ll-popup-mode\s+\.ll-popup-head\s*\{([^}]*)\}/);
    assert(headRule && /flex:\s*none/.test(headRule[1]),
      '标题栏必须是 flex 固定段（flex:none），长内容时钉在窗口顶边');
    const bodyScrollRule = stripped.match(/body\.ll-popup-mode\s+\.ll-popup-body\s*\{([^}]*)\}/);
    assert(bodyScrollRule && /overflow-y:\s*auto/.test(bodyScrollRule[1]) && /min-height:\s*0/.test(bodyScrollRule[1]),
      '内容区必须是唯一的滚动区（overflow-y:auto + min-height:0），标题/状态栏不能跟着滚');
    assert(/body\.ll-popup-mode\s+\.ll-popup-foot\s*\{[^}]*flex:\s*none/.test(stripped),
      '状态栏必须是 flex 固定段（flex:none），长内容时钉在窗口底边');
    // fill 的自滚动形态：设置窗这类"内容根自己管滚动"的窗口靠它把 tab 导航钉住，
    // 丢了它长内容会把整个内容根撑高、外层滚动连导航一起滚走
    assert(/body\.ll-popup-mode\s+\.ll-popup-fill-fixed\s*\{[^}]*position:\s*absolute/.test(stripped)
      && /position:\s*relative/.test(stripped.match(/body\.ll-popup-mode\s+\.ll-popup-body-inner\s*\{([^}]*)\}/)?.[1] ?? ''),
      '.ll-popup-fill-fixed（absolute）+ .ll-popup-body-inner（relative）必须成对存在，fill 窗口的内容根才钉得住');

    // Linux/GTK 对 resizable(false) 的窗口直接忽略应用侧 set_size（Tauri 还返回 Ok），
    // auto_height 在 Linux 必须保持可 resize，否则窗口停在声明高度、卡片下面一条空白。
    const services = readFileSync(
      path.join(root, 'src-tauri', 'crates', 'll-host', 'src', 'services.rs'), 'utf8');
    assert(/let resizable = if spec\.auto_height \{\s*cfg!\(target_os = "linux"\)/.test(services),
      'services.rs 里 auto_height 窗口的 resizable 必须按 cfg!(target_os = "linux") 走，GTK 不吃非可缩放窗口的 set_size');

    // 旧的"卡片被拉成整窗"补丁必须消失，否则同一个窗口有两套互相打架的布局
    const calCss = readFileSync(path.join(pluginsDir, 'todo', 'fe', 'src', 'calendar', 'calendar.css'), 'utf8');
    assert(!/body\.detail-mode/.test(calCss), 'calendar.css 里不应再有 body.detail-mode 补丁');
    assert(/\.cal-modal--inline/.test(calCss), 'EventModal 的 inline 态需要 .cal-modal--inline 摘掉浮层外观');
    assert(!/cal-detail-root/.test(readFileSync(path.join(pluginsDir, 'todo', 'fe', 'src', 'calendar', 'EventDetail.tsx'), 'utf8')),
      'EventDetail 不应再自带浮层遮罩根节点，外壳已由 PopupFrame 提供');
  } catch (err) {
    failures.push(err.message);
  }

  // ── 2) 行为层：mountPopup 的取样 / 死区 / 拖拽挂起 ─────────
  try {
    moduleCache.clear();
    invokeCalls.length = 0;
    const observers = [];
    const rafs = [];
    const winListeners = {};
    const saved = {
      window: globalThis.window,
      document: globalThis.document,
      ResizeObserver: globalThis.ResizeObserver,
      requestAnimationFrame: globalThis.requestAnimationFrame,
    };

    const mkEl = () => ({
      attrs: {},
      handlers: {},
      height: 200,
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(t, fn) { (this.handlers[t] ??= []).push(fn); },
      removeEventListener(t, fn) { this.handlers[t] = (this.handlers[t] ?? []).filter((f) => f !== fn); },
      getBoundingClientRect() { return { height: this.height }; },
      fire(t) { (this.handlers[t] ?? []).forEach((fn) => fn({})); },
    });
    const classList = new Set();
    globalThis.document = { body: { classList: { add: (c) => classList.add(c), remove: (c) => classList.delete(c) } } };
    globalThis.window = {
      __TAURI_INTERNALS__: { invoke: async () => null },
      addEventListener: (t, fn) => { (winListeners[t] ??= []).push(fn); },
      removeEventListener: (t, fn) => { winListeners[t] = (winListeners[t] ?? []).filter((f) => f !== fn); },
    };
    globalThis.ResizeObserver = class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    };
    globalThis.requestAnimationFrame = (fn) => { rafs.push(fn); return rafs.length; };

    /** 排空一帧：mountPopup 的上报都排在 rAF 里 */
    const pump = () => { while (rafs.length) rafs.splice(0).forEach((fn) => fn()); };
    const reports = () => invokeCalls.filter((c) => c.method === 'svc.window.setContentSize');

    try {
      const P = loadPluginModule(path.join(pluginsDir, 'sdk', 'src', 'popup.ts'));
      const content = mkEl();
      const drag = mkEl();
      const popup = P.mountPopup({ pluginId: 'todo', content, drag });

      assert(classList.has(P.POPUP_BODY_CLASS), 'mountPopup 应给 body 打上基窗类名');
      assert(drag.attrs['data-tauri-drag-region'] === 'deep', '拖拽区应由 mountPopup 打上 deep 属性');
      pump();
      assert(reports().length === 1, `首帧应上报一次高度，实得 ${reports().length}`);
      assert(reports()[0].params.height === 200, `首帧应上报内容自然高度 200，实得 ${reports()[0].params.height}`);

      // 死区：同值与 1px 抖动都不值得打 IPC
      observers.forEach((o) => o.cb());
      pump();
      assert(reports().length === 1, '同高度重复触发不应再发 IPC');
      content.height = 201;
      observers.forEach((o) => o.cb());
      pump();
      assert(reports().length === 1, '小于死区（2px）的抖动应被吞掉');

      // 正常增长
      content.height = 240;
      observers.forEach((o) => o.cb());
      pump();
      assert(reports().length === 2 && reports()[1].params.height === 240,
        `跨过死区应上报一次 240，实得 ${JSON.stringify(reports().map((r) => r.params.height))}`);

      // 拖拽期间挂起：系统拖拽事务进行中改窗口几何，松手会被拖拽基准覆盖（pomo 的"弹回"）
      drag.fire('mousedown');
      content.height = 300;
      observers.forEach((o) => o.cb());
      pump();
      assert(reports().length === 2, '拖拽进行中不得上报尺寸');
      (winListeners.mouseup ?? []).forEach((fn) => fn({}));
      pump();
      assert(reports().length === 3 && reports()[2].params.height === 300,
        '松手后必须补上拖拽期间攒下的那次变化，否则窗口停在旧尺寸');

      popup.dispose();
      assert(!classList.has(P.POPUP_BODY_CLASS), 'dispose 应摘掉基窗类名');
      assert(observers.every((o) => o.disconnected), 'dispose 应断开 ResizeObserver');
      assert((winListeners.mouseup ?? []).length === 0, 'dispose 应摘掉 window 上的 mouseup');

      // 自定义测量（三段式骨架）：窗口高度 = 标题 + 内容 + 状态栏，没有单个元素量得出来
      const head = mkEl(); head.height = 40;
      const inner = mkEl(); inner.height = 260;
      const foot = mkEl(); foot.height = 46;
      const before = reports().length;
      const popup2 = P.mountPopup({
        pluginId: 'todo',
        content: inner,
        watch: [head, foot],
        measure: () => head.height + inner.height + foot.height,
      });
      pump();
      assert(reports().length === before + 1 && reports().at(-1).params.height === 346,
        `三段式应上报三段之和 346，实得 ${JSON.stringify(reports().slice(before).map((r) => r.params.height))}`);
      // 内容被窗口夹住时 inner 纹丝不动，头/尾的高度变化也要触发重新上报
      foot.height = 60;
      observers.forEach((o) => o.cb());
      pump();
      assert(reports().length === before + 2 && reports().at(-1).params.height === 360,
        'watch 元素的变化必须触发重新上报，否则状态栏换行后窗口高度停在旧值');
      popup2.dispose();
      assert(!classList.has(P.POPUP_BODY_CLASS), 'dispose 应摘掉基窗类名');

      // 不传 pluginId = 定尺寸窗口（日历/设置）只借骨架：body 类照打，但一次 IPC 都不发
      const lone = mkEl();
      const before2 = reports().length;
      const popup3 = P.mountPopup({ content: lone });
      pump();
      assert(classList.has(P.POPUP_BODY_CLASS), '无 pluginId 也应打上基窗类名（popup.css 全靠它作用域）');
      assert(reports().length === before2, '无 pluginId 不得上报尺寸：定尺寸窗报高会被宿主以"未声明 auto_height"拒掉');
      popup3.dispose();
      assert(!classList.has(P.POPUP_BODY_CLASS), 'dispose 应摘掉基窗类名');
    } finally {
      Object.assign(globalThis, {
        window: saved.window,
        document: saved.document,
        ResizeObserver: saved.ResizeObserver,
        requestAnimationFrame: saved.requestAnimationFrame,
      });
    }
  } catch (err) {
    failures.push(err.message);
  }
  return failures;
}

/**
 * 纯函数模块测试：`/hotkey` 速查表的分组与格式化。
 * 这块容易错的点：多修饰键组合（ctrl+alt+k）若归组不当会在多组里重复出现；
 * 修饰键顺序若按输入顺序渲染，同一个组合会出现两种写法。
 */
function testHotkeyModule() {
  const failures = [];
  const file = path.join(pluginsDir, 'hotkey', 'fe', 'src', 'hotkeys.ts');
  if (!existsSync(file)) return ['hotkey/fe/src/hotkeys.ts 不存在'];

  let h;
  try {
    moduleCache.clear();
    h = loadPluginModule(file);
  } catch (err) {
    return [`加载失败: ${err.message}`];
  }

  try {
    // 1) 基础归组
    assert(h.groupOf('ctrl+k') === 'ctrl', `ctrl 应归 Ctrl 组，实得 ${h.groupOf('ctrl+k')}`);
    assert(h.groupOf('alt+p') === 'alt', `alt 应归 Alt 组，实得 ${h.groupOf('alt+p')}`);
    assert(h.groupOf('shift+s') === 'shift', `shift 应归 Shift 组，实得 ${h.groupOf('shift+s')}`);
    assert(h.groupOf('win+l') === 'win', `win 应归 Win 组，实得 ${h.groupOf('win+l')}`);
    assert(h.groupOf('f5') === 'other', `无修饰键应归「其他」，实得 ${h.groupOf('f5')}`);

    // 2) 多修饰键：按"最强修饰键"归组，不可在多组重复
    assert(h.groupOf('ctrl+alt+shift+k') === 'ctrl',
      `多修饰键应归最强者 Ctrl，实得 ${h.groupOf('ctrl+alt+shift+k')}`);
    assert(h.groupOf('alt+shift+s') === 'alt',
      `alt+shift 应归 Alt，实得 ${h.groupOf('alt+shift+s')}`);

    // 3) 别名归一：control/option/super/cmd 与ctrl/alt/win 等价
    assert(h.groupOf('control+k') === 'ctrl', 'control 应等价于 ctrl');
    assert(h.groupOf('option+p') === 'alt', 'option 应等价于 alt');
    assert(h.groupOf('super+l') === 'win', 'super 应等价于 win');
    assert(h.groupOf('cmd+space') === 'win', 'cmd 应等价于 win');

    // 4) 可读化：单字符主键大写
    assert(h.prettyAccel('alt+p') === 'Alt + P', `alt+p 应渲染为「Alt + P」，实得 ${h.prettyAccel('alt+p')}`);
    assert(h.prettyAccel('alt+shift+s') === 'Alt + Shift + S',
      `alt+shift+s 应渲染为「Alt + Shift + S」，实得 ${h.prettyAccel('alt+shift+s')}`);

    // 5) 修饰键顺序归一：ctrl+alt 与 alt+ctrl 必须渲染成同一个串
    assert(h.prettyAccel('ctrl+alt+k') === h.prettyAccel('alt+ctrl+k'),
      `同组合不应因输入顺序不同而有两种写法：${h.prettyAccel('ctrl+alt+k')} vs ${h.prettyAccel('alt+ctrl+k')}`);
    assert(h.prettyAccel('ctrl+alt+k') === 'Ctrl + Alt + K',
      `应按 Ctrl→Alt 固定顺序，实得 ${h.prettyAccel('ctrl+alt+k')}`);

    // 6) 功能键保持小写原样（不被当成单字符大写）
    assert(h.prettyAccel('ctrl+f5') === 'Ctrl + f5', `功能键应保持原样，实得 ${h.prettyAccel('ctrl+f5')}`);

    // 7) 拆分：修饰键与主键分离
    const sp = h.splitAccel('alt+shift+s');
    assert(sp.key === 's' && sp.mods.length === 2, `拆分应得 mods=[alt,shift] key=s，实得 ${JSON.stringify(sp)}`);

    // 8) 分组排序：组间 Ctrl→Alt→Shift→Win→其他
    const mk = (accel, pluginId) => ({
      accel, pluginId, description: 'd', trigger: `/${pluginId}`, pluginName: pluginId, icon: 'x',
    });
    const groups = h.groupHotkeys([mk('win+l', 'w'), mk('alt+p', 'p'), mk('ctrl+k', 'c'), mk('f5', 'o')]);
    assert(groups.map((g) => g.id).join(',') === 'ctrl,alt,win,other',
      `组间应按 Ctrl→Alt→Win→其他 排序，实得 ${groups.map((g) => g.id).join(',')}`);

    // 9) 同一热键不得出现在两个组里（多修饰键归组唯一性）
    const total = groups.reduce((n, g) => n + g.entries.length, 0);
    assert(total === 4, `每条热键只应出现一次，实得 ${total} 条`);
  } catch (err) {
    failures.push(err.message);
  }
  return failures;
}

/**
 * 纯函数模块测试：截图标注的几何计算。
 * 这里最容易错的三处：反向拖拽的归一化、箭头头部的向量运算、
 * 步骤号必须按**阅读顺序**而非点击顺序编号。
 */
function testAnnotateModule() {
  const failures = [];
  const file = path.join(pluginsDir, 'shot', 'fe', 'src', 'annotate.ts');
  if (!existsSync(file)) return ['shot/fe/src/annotate.ts 不存在'];

  let a;
  try {
    moduleCache.clear();
    a = loadPluginModule(file);
  } catch (err) {
    return [`加载失败: ${err.message}`];
  }

  try {
    // 1) 反向拖拽归一化：canvas 的 strokeRect 遇负宽高会朝反方向画
    const b1 = a.normBox({ kind: 'rect', x1: 300, y1: 200, x2: 100, y2: 50 });
    assert(b1.x === 100 && b1.y === 50 && b1.w === 200 && b1.h === 150,
      `反向拖拽应归一化为左上+正宽高，实得 ${JSON.stringify(b1)}`);

    // 2) 正向拖拽不变
    const b2 = a.normBox({ kind: 'rect', x1: 100, y1: 50, x2: 300, y2: 200 });
    assert(b2.x === 100 && b2.y === 50 && b2.w === 200 && b2.h === 150,
      `正向拖拽应保持原值，实得 ${JSON.stringify(b2)}`);

    // 3) 过短拖拽判定
    assert(a.isTooShort({ kind: 'arrow', x1: 10, y1: 10, x2: 12, y2: 11 }) === true, '微小拖拽应判为过短');
    assert(a.isTooShort({ kind: 'arrow', x1: 10, y1: 10, x2: 60, y2: 10 }) === false, '正常拖拽不应判为过短');

    // 4) 箭头单位向量：向右拖(1,0)、向下拖(0,1)
    const v1 = a.arrowVector(0, 0, 10, 0);
    assert(Math.abs(v1.x - 1) < 1e-9 && Math.abs(v1.y) < 1e-9, `右向单位向量应为(1,0)，实得 ${JSON.stringify(v1)}`);
    const v2 = a.arrowVector(0, 0, 0, 10);
    assert(Math.abs(v2.x) < 1e-9 && Math.abs(v2.y - 1) < 1e-9, `下向单位向量应为(0,1)，实得 ${JSON.stringify(v2)}`);

    // 5) 零长度拖拽不能返回 NaN（canvas 收到 NaN 会静默不画，用户看不到任何东西）
    const v0 = a.arrowVector(5, 5, 5, 5);
    assert(Number.isFinite(v0.x) && Number.isFinite(v0.y), `零长度应给默认方向而非 NaN，实得 ${JSON.stringify(v0)}`);

    // 6) 箭头头部两翼：应落在终点附近、且分居两侧
    const [h1, h2] = a.arrowHead(0, 0, 100, 0, 12);
    assert(Number.isFinite(h1.x) && Number.isFinite(h2.x), '箭头头部坐标应为有限值');
    assert(h1.y !== h2.y, `箭头两翼应在两侧，实得 y=${h1.y} 与 ${h2.y}`);
    // 头部尖端回退，故x 应略小于终点 100
    assert(h1.x < 100 && h2.x < 100, `头部应从终点回退 size，实得 x=${h1.x},${h2.x}`);

    // 7) 马赛克分块：块数与覆盖范围
    const blocks = a.mosaicBlocks(0, 0, 100, 100, 10);
    assert(blocks.length === 100, `100×100 按 10px 分块应为 100 块，实得 ${blocks.length}`);
    const mb = a.normBox({ kind: 'mosaic', x1: 100, y1: 100, x2: 0, y2: 0 });
    assert(mb.x === 0 && mb.y === 0, '反向马赛克拖拽应归一化');

    // 8) 马赛克块数上限：拖整个 4K 屏也不能产出上十万块拖慢渲染。
    //    关键不只是"数量少"，更不能出现"边缘没打码的空白"——
    //    那是安全问题，所以块数可以放大到刚好上限，但绝不能超出。
    const huge = a.mosaicBlocks(0, 0, 3840, 2160, 8);
    assert(huge.length <= 4096, `块数应受上限保护（4096），实得 ${huge.length}`);
    // 覆盖完整：所有块的并集应铺满整个选区（首块贴左上、末块贴右下）
    assert(huge.length > 0, '4K 选区应产生块');
    const first = huge[0];
    const last = huge[huge.length - 1];
    assert(Math.abs(first.x) < 1e-6 && Math.abs(first.y) < 1e-6,
      `首块应贴住选区左上角，实得 (${first.x},${first.y})`);
    assert(last.x + last.size >= 3840 - 1 && last.y + last.size >= 2160 - 1,
      `末块应贴住选区右下角，不留未打码空白，实得末块 (${last.x},${last.y}) size=${last.size}`);

    // 9) 步骤号按阅读顺序（先y 再 x）而非点击顺序
    const steps = [
      { id: 'c', kind: 'step', x1: 300, y1: 100, x2: 300, y2: 100, text: undefined, color: '#fff', size: 0 },
      { id: 'a', kind: 'step', x1: 50, y1: 100, x2: 50, y2: 100, text: undefined, color: '#fff', size: 0 },
      { id: 'b', kind: 'step', x1: 50, y1: 50, x2: 50, y2: 50, text: undefined, color: '#fff', size: 0 },
    ];
    const nums = a.stepNumbers(steps);
    assert(nums.get('b') === 1, `最上方的应编号 1，实得 ${nums.get('b')}`);
    assert(nums.get('a') === 2, `同一行靠左的应编号 2，实得 ${nums.get('a')}`);
    assert(nums.get('c') === 3, `同一行靠右的应编号 3，实得 ${nums.get('c')}`);

    // 10) 非步骤标注不参与编号
    const mixed = [
      ...steps,
      { id: 'r', kind: 'rect', x1: 0, y1: 0, x2: 10, y2: 10, text: undefined, color: '#fff', size: 2 },
    ];
    assert(a.stepNumbers(mixed).size === 3, `只有步骤标注参与编号，实得 ${a.stepNumbers(mixed).size}`);

    // 11) 导出尺寸：HiDPI 下要乘缩放，且不小于 1
    assert(a.exportSize(200, 100, 1.5).width === 300, `150% 下宽应乘缩放，实得 ${a.exportSize(200, 100, 1.5).width}`);
    assert(a.exportSize(0, 0, 1).width === 1, '零宽应夹到至少 1');
  } catch (err) {
    failures.push(err.message);
  }
  return failures;
}

/** 纯函数模块：日程月视图的日期算术（跨天拆分与网格补齐是错位的高发区） */
function testCalendarDayMathModule() {
  const failures = [];
  const file = path.join(pluginsDir, 'todo', 'fe', 'src', 'calendar', 'daymath.ts');
  if (!existsSync(file)) return ['todo/fe/src/calendar/daymath.ts 不存在'];

  let m;
  try {
    moduleCache.clear();
    m = loadPluginModule(file);
  } catch (err) {
    return [`加载失败: ${err.message}`];
  }

  const inst = (start, end, allDay = false) => ({
    event_id: 'e',
    occ_key: start,
    content: 'c',
    start,
    end,
    all_day: allDay,
    is_virtual: false,
    completed: false,
    location: null,
    description: null,
    calendar_id: null,
    status: 'busy',
    repeat_rule: null,
    alarms: [],
  });

  try {
    // 1) 本地解析：按 UTC 解析补时串会让 00:30 掉到前一天
    const d = m.parseLocal('2026-10-14 00:30');
    assert(d && d.getFullYear() === 2026 && d.getMonth() === 9 && d.getDate() === 14, `本地解析错: ${d}`);
    assert(d.getHours() === 0 && d.getMinutes() === 30, `时分丢失: ${d && d.getHours()}`);
    assert(m.parseLocal('明天') === null, '非法输入应返回 null');

    // 2) 全天单天：后端给的 end 是次日 00:00（独占），不能算成两天
    const oneDay = m.dayKeysOf(inst('2026-10-14 00:00', '2026-10-15 00:00', true));
    assert(oneDay.join(',') === '2026-10-14', `全天单天应只占 1 格，实得 ${oneDay.join(',')}`);

    // 3) 跨天全天：10-14 ~ 10-16（含 16 号），end = 10-17 00:00
    const span = m.dayKeysOf(inst('2026-10-14 00:00', '2026-10-17 00:00', true));
    assert(span.join(',') === '2026-10-14,2026-10-15,2026-10-16', `跨天拆分错: ${span.join(',')}`);

    // 4) 定时事件零点收工（22:00–00:00）属于结束那一刻的**前一天**，与 Google/钉钉一致
    assert(
      m.dayKeysOf(inst('2026-10-14 22:00', '2026-10-15 00:00')).join(',') === '2026-10-14',
      '零点收工的事件不该占到次日格子里',
    );
    assert(
      m.dayKeysOf(inst('2026-10-14 22:00', '2026-10-15 02:00')).join(',') === '2026-10-14,2026-10-15',
      '真正跨过午夜的事件应占两天',
    );
    assert(
      m.dayKeysOf(inst('2026-10-14 09:00', '2026-10-14 18:00')).join(',') === '2026-10-14',
      '同日定时事件不该溢出到次日',
    );

    // 5) 分桶排序：全天置顶，其余按开始时间
    const buckets = m.bucketByDay([
      inst('2026-10-14 15:00', '2026-10-14 16:00'),
      inst('2026-10-14 00:00', '2026-10-15 00:00', true),
      inst('2026-10-14 09:00', '2026-10-14 10:00'),
    ]);
    const order = (buckets.get('2026-10-14') || []).map((i) => i.start).join(' ');
    assert(
      order === '2026-10-14 00:00 2026-10-14 09:00 2026-10-14 15:00',
      `格内排序错（全天应置顶）: ${order}`,
    );

    // 6) 月网格固定 6 行 = 42 格，且本月天数齐全（撑高跳动的根因就是行数浮动）
    const gm = path.join(pluginsDir, 'todo', 'fe', 'src', 'calendar', 'grid.ts');
    const g = loadPluginModule(gm);
    for (const [y, mo] of [[2026, 1], [2026, 9], [2027, 1]]) {
      const cells = g.monthCells(y, mo);
      assert(cells.length % 7 === 0 && cells.length >= 42, `${y}-${mo} 网格行数不固定: ${cells.length}`);
      const days = cells.filter((c) => !c.out).length;
      assert(days === g.daysInMonth(y, mo), `${y}-${mo} 本月天数 ${days} ≠ ${g.daysInMonth(y, mo)}`);
      assert(g.firstWeekday(y, mo) >= 0 && g.firstWeekday(y, mo) <= 6, `${y}-${mo} 起始weekday 越界`);
    }
    // 2026-02-01 是周日 → 周一开头要补 6 格，补的是邻月的真实日期（不是空格）
    assert(g.firstWeekday(2026, 1) === 6, `2026-02 应以 6 个邻月格起头，实得 ${g.firstWeekday(2026, 1)}`);
    {
      const cells = g.monthCells(2026, 1);
      assert(cells[0].key === '2026-01-26' && cells[0].out, `邻月首格应标出真实日期: ${JSON.stringify(cells[0])}`);
      assert(cells[6].key === '2026-02-01' && !cells[6].out, `本月首格判定错: ${JSON.stringify(cells[6])}`);
      assert(new Set(cells.map((c) => c.key)).size === cells.length, '格子里有重复日期');
    }

    // 7) 超长标题按码点截断，emoji 不能被切成半个
    const cut = m.ellipsis('🎉 发布会评审与复盘', 4);
    assert(cut.startsWith('🎉') && cut.endsWith('…'), `截断把 emoji 切坏了: ${cut}`);
  } catch (err) {
    failures.push(err.message);
  }

  // 8) 分类颜色：底色是用户选的 hex，透明度由 soften 生成，不能出现 transparent
  try {
    const cm = path.join(pluginsDir, 'todo', 'fe', 'src', 'calendar', 'calendars.ts');
    const c = loadPluginModule(cm);
    assert(c.soften('#4c8dff', 0.2) === 'rgba(76,141,255,0.2)', `6 位 hex 展开错: ${c.soften('#4c8dff', 0.2)}`);
    assert(c.soften('#abc', 0.5) === 'rgba(170,187,204,0.5)', `3 位缩写没按 CSS 规则展开: ${c.soften('#abc', 0.5)}`);
    assert(c.soften('url(evil)', 0.2).startsWith('rgba(138,143,152,'), '非法颜色应退回兜底灰');
    const cals = [{ id: 'x', name: '工作', color: '#2fb47c', sort: 0 }];
    assert(c.colorOf(cals, 'x') === '#2fb47c', '已选分类取自身颜色');
    assert(c.colorOf(cals, 'gone') === c.FALLBACK_COLOR, '分类被删后不该拿到 undefined 颜色');
    assert(c.colorOf(cals, null) === c.FALLBACK_COLOR, '未分类应有兜底色');
    assert(c.nameOf(cals, null) === c.UNCLASSIFIED_LABEL, 'NULL 分类要显示"未分类"');
    // Set 必须新建，原地 add/delete 不会触发 Solid 更新
    const s = new Set(['a']);
    const n = c.toggleId(s, 'a');
    assert(n !== s && n.size === 0 && s.size === 1, 'toggleId 应为不可变操作');
    assert(c.toggleId(s, 'b').size === 2, 'toggleId 未命中时应加入');
  } catch (err) {
    failures.push(err.message);
  }
  return failures;
}

/** 纯函数模块：钉钉式日期时间选择器（15 分钟档位 · 过期禁用 · 值组合） */
function testDateTimeFieldModule() {
  const failures = [];
  const file = path.join(pluginsDir, 'todo', 'fe', 'src', 'calendar', 'dtfield.ts');
  let m;
  try {
    m = loadPluginModule(file);
  } catch (err) {
    return [`${file} 加载失败: ${err.message}`];
  }

  const TODAY = '2026-10-15';
  const at = (h, mi) => new Date(2026, 9, 15, h, mi); // 与 TODAY 同一天
  const idx = (label) => m.TIME_SLOTS.find((s) => s.label === label)?.index ?? -1;

  try {
    // 1) 档位表：96 档、15 分钟一步、00:00 起 23:45 止（一天不多不少正好覆盖完）
    assert(m.TIME_SLOTS.length === 96, `档位应为 96 个，实得 ${m.TIME_SLOTS.length}`);
    assert(m.TIME_SLOTS[0].label === '00:00', `首档应为 00:00，实得 ${m.TIME_SLOTS[0].label}`);
    assert(m.TIME_SLOTS[95].label === '23:45', `末档应为 23:45，实得 ${m.TIME_SLOTS[95].label}`);
    assert(
      m.TIME_SLOTS.every((s, i) => s.index === i && /^\d{2}:\d{2}$/.test(s.label) && s.hh * 60 + s.mm === i * 15),
      '档位下标或标签不连续',
    );

    // 2) 过期只影响"今天"这一格；整点不宽限也不提前
    assert(m.isSlotDisabled(m.TIME_SLOTS[idx('14:00')], TODAY, at(14, 7)) === true, '14:07 时 14:00 应已过期');
    assert(m.isSlotDisabled(m.TIME_SLOTS[idx('14:15')], TODAY, at(14, 7)) === false, '14:15 应可选');
    assert(m.isSlotDisabled(m.TIME_SLOTS[idx('14:00')], TODAY, at(14, 0)) === false, '14:00 整点应仍可选');
    assert(m.isSlotDisabled(m.TIME_SLOTS[idx('00:00')], '2026-10-20', at(14, 7)) === false, '未来日期不该禁用任何档');
    assert(m.isSlotDisabled(m.TIME_SLOTS[idx('23:45')], '2026-10-01', at(14, 7)) === false, '过去的日期要能改，不该禁用');
    assert(m.isSlotDisabled(m.TIME_SLOTS[idx('00:00')], '', at(14, 7)) === false, '还没选日期时不该禁用');

    // 3) 打开列表滚到哪：从第一个可选档开始；已选值仍可选就以它为准
    assert(idx('14:15') === 57, `夹具本身错了：14:15 应为第 57 档，实得 ${idx('14:15')}`);
    assert(m.firstSelectableIndex(TODAY, at(14, 7)) === 57, `首个可选档错: ${m.firstSelectableIndex(TODAY, at(14, 7))}`);
    assert(m.firstSelectableIndex(TODAY, at(23, 50)) === 95, '一天过完应退回最后一档');
    assert(m.firstSelectableIndex('2026-10-20', at(14, 7)) === 0, '非今天应从 00:00 起');
    assert(m.scrollTargetIndex('18:00', TODAY, at(14, 7)) === idx('18:00'), '已选未来档应定位到已选');
    assert(m.scrollTargetIndex('09:00', TODAY, at(14, 7)) === 57, '已选过期档应退回首个可选');
    assert(m.scrollTargetIndex('', TODAY, at(14, 7)) === 57, '无值应落在首个可选');
    assert(m.scrollTargetIndex('09:00', '2026-10-20', at(14, 7)) === idx('09:00'), '未来日期不受时钟影响');

    // 4) 值组合：规范值恒为 "YYYY-MM-DD HH:MM"，两半各自可改
    assert(m.dateOf('2026-10-15 13:00') === '2026-10-15', 'dateOf 取错日期半');
    assert(m.timeOf('2026-10-15 13:00') === '13:00', 'timeOf 取错时间半');
    assert(m.dateOf('') === '' && m.timeOf('') === '', '空值两半都该是空');
    assert(m.pickDate('2026-10-15 13:00', '2026-11-02') === '2026-11-02 13:00', '换日期应保留时间半');
    assert(m.pickDate('', '2026-11-02') === '2026-11-02 09:00', '空值补默认时间');
    assert(m.pickDate('2026-10-15', '2026-11-02') === '2026-11-02 09:00', '只有日期时按无时间处理');
    assert(m.pickTime('2026-10-15 13:00', '2026-11-02', '12:00') === '2026-10-15 12:00', '换时间应保留日期半');
    assert(m.pickTime('', '2026-11-02', '12:00') === '2026-11-02 12:00', '日期空时落到 fallbackDate');
    // 后端按串比较，光有日期没有时间的值会排到当天所有日程之前
    assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(m.pickDate('', '2026-11-02')), '组合结果必须是完整时间串');

    // 5) 月历浮层：翻页跨年、标题去前导零
    assert(JSON.stringify(m.shiftMonth(2026, 11, 1)) === '{"year":2027,"month":0}', '12 月往后应进次年 1 月');
    assert(JSON.stringify(m.shiftMonth(2027, 0, -1)) === '{"year":2026,"month":11}', '1 月往前应退上年 12 月');
    assert(JSON.stringify(m.shiftMonth(2026, 9, -11)) === '{"year":2025,"month":10}', '跨年多月往前退错');
    assert(m.monthTitle('2026-10-15', '') === '2026年10月15日', `标题错: ${m.monthTitle('2026-10-15', '')}`);
    assert(m.monthTitle('', '2026-10-05') === '2026年10月5日', `无值应退回今天且去前导零: ${m.monthTitle('', '2026-10-05')}`);
    assert(
      JSON.stringify(m.monthOfDate('2026-10-15', '2027-01-01')) === '{"year":2026,"month":9}',
      '浮层应停在值所在月（month 为 0-11）',
    );
    assert(
      JSON.stringify(m.monthOfDate('', '2027-01-01')) === '{"year":2027,"month":0}',
      '无值应停在兜底日期所在月',
    );
  } catch (err) {
    failures.push(err.message);
  }
  return failures;
}

/** 纯函数模块：提醒卡片的文案（常驻卡片只算一次措辞 · 区间四形状 · 脏参降级） */
function testReminderFormatModule() {
  const failures = [];
  const file = path.join(pluginsDir, 'todo', 'fe', 'src', 'remindfmt.ts');
  let m;
  try {
    m = loadPluginModule(file);
  } catch (err) {
    return [`${file} 加载失败: ${err.message}`];
  }

  const NOW = new Date(2026, 9, 15, 15, 40); // 2026-10-15 周四
  const p = (over) => ({ id: '', event: '', content: '', minutes: 0, start: '', end: '', allDay: false, cal: '', ...over });

  try {
    // 1) URL 参数：齐参照收，脏参降级成空串而不是抛错
    const ok = m.parseReminder('?id=a1&event=e1&content=%E5%91%A8%E4%BC%9A&minutes=5&start=2026-10-15%2016%3A00&end=2026-10-15%2016%3A30&all_day=0&cal=%E5%B7%A5%E4%BD%9C');
    assert(ok.content === '周会' && ok.cal === '工作', `正文/日历名没解码: ${JSON.stringify(ok)}`);
    assert(ok.start === '2026-10-15 16:00' && ok.end === '2026-10-15 16:30', `区间解错: ${ok.start} ~ ${ok.end}`);
    assert(ok.minutes === 5 && ok.allDay === false && ok.event === 'e1', '标量参数解错');
    const bad = m.parseReminder('?minutes=abc&start=15/10&end=2026-13-99%2000:00&all_day=1');
    assert(bad.minutes === 0 && bad.start === '' && bad.end === '', `脏参没被降级: ${JSON.stringify(bad)}`);
    assert(bad.allDay === true, 'all_day=1 应认');

    // 2) 星期与短日期
    assert(m.weekdayOf('2026-10-15') === '周四', `2026-10-15 应是周四，实得${m.weekdayOf('2026-10-15')}`);
    assert(m.weekdayOf('2026-10-18') === '周日', '周日要落在"周日"');
    assert(m.weekdayOf('') === '周一', '脏日期要退回兜底而不是 undefined');
    assert(m.shortDate('2026-10-05') === '10/5', `前导零没去掉: ${m.shortDate('2026-10-05')}`);

    // 3) 强调行：全天没有时刻，拿 00:00 算会一路"已开始"
    assert(m.leadLabel(p({ allDay: true, start: '2026-10-15 00:00' }), NOW) === '今天', '全天应显示"今天"');
    assert(m.leadLabel(p({ start: '2026-10-15 15:45' }), NOW) === '5 分钟后', `5 分钟档错: ${m.leadLabel(p({ start: '2026-10-15 15:45' }), NOW)}`);
    assert(m.leadLabel(p({ start: '2026-10-15 17:40' }), NOW) === '2 小时后', '两小时以上换成小时');
    assert(m.leadLabel(p({ start: '2026-10-15 15:39' }), NOW) === '现在开始', '已过开始时间说"现在开始"');
    assert(m.leadLabel(p({ minutes: 10 }), NOW) === '提前 10 分钟', '无开始时间时退回提醒提前量');

    // 4) 区间行的四种形状
    assert(
      m.spanLabel(p({ start: '2026-10-15 16:00', end: '2026-10-15 16:30' }), NOW) === '10/15 周四 16:00 - 16:30',
      `同日形状错: ${m.spanLabel(p({ start: '2026-10-15 16:00', end: '2026-10-15 16:30' }), NOW)}`,
    );
    assert(
      m.spanLabel(p({ start: '2026-10-15 16:00', end: '2026-10-16 09:30' }), NOW) === '10/15 周四 16:00 - 10/16 周五 09:30',
      '跨日形状错',
    );
    assert(m.spanLabel(p({ start: '2026-10-15 16:00' }), NOW) === '10/15 周四 16:00 起', '缺结束应写"起"');
    assert(m.spanLabel(p({ start: '2026-10-15 00:00', allDay: true }), NOW) === '10/15 周四 全天', '全天形状错');
    assert(
      m.spanLabel(p({ start: '2026-10-15 00:00', end: '2026-10-17 00:00', allDay: true }), NOW) === '10/15 周四 - 10/17 周六 全天',
      '跨天全天形状错',
    );
    // 旧纯待办没有日期，不能显示成 NaN/NaN，得落在今天这一格
    assert(m.spanLabel(p({}), NOW) === '10/15 周四 00:00 起', `无日期应落在今天: ${m.spanLabel(p({}), NOW)}`);

    // 5) 「查看详情」只带定位需要的参数
    const dp = m.detailParams(p({ event: 'e1', start: '2026-10-15 16:00', end: '2026-10-15 16:30', content: '周会' }));
    assert(dp.event === 'e1' && dp.start && dp.end, `详情参数缺项: ${JSON.stringify(dp)}`);
    assert(dp.content === undefined && dp.all_day === undefined, '正文不该进 URL，all_day=0 也不用带');
    assert(m.detailParams(p({ event: 'e1', allDay: true })).all_day === '1', '全天要带得动');

    // 6) 只读详情里从规则/提醒串还原成人话（措辞必须和编辑器一致）
    assert(m.repeatLabel('') === '不重复', '空规则应说"不重复"');
    assert(m.repeatLabel('every:1day') === '每天', `单个周期不该写成"每 1 天": ${m.repeatLabel('every:1day')}`);
    assert(m.repeatLabel('every:2week') === '每 2 周', `多周期错: ${m.repeatLabel('every:2week')}`);
    assert(m.repeatLabel('every:1month') === '每个月', '月单位沿用编辑器的说法');
    assert(m.repeatLabel('weekly') === 'weekly', '历史手工串原样显示，别当空');
    assert(m.alarmLabel([]) === '无', '没提醒要说"无"');
    assert(m.alarmLabel([1440, 10, 0]) === '提前 1 天、提前 10 分钟、准时', `多档提醒拼接错: ${m.alarmLabel([1440, 10, 0])}`);
  } catch (err) {
    failures.push(err.message);
  }
  return failures;
}

/** 纯函数模块：周/日时间轴的区间切分、重叠分道与拖拽吸附 */
function testCalendarTimelineModule() {
  const failures = [];
  const dir = path.join(pluginsDir, 'todo', 'fe', 'src', 'calendar');
  let m;
  let drag;
  try {
    m = loadPluginModule(path.join(dir, 'layout.ts'));
    drag = loadPluginModule(path.join(dir, 'drag.ts'));
  } catch (err) {
    return [`加载失败: ${err.message}`];
  }

  const inst = (start, end, allDay = false) => ({
    event_id: 'e',
    occ_key: start,
    content: 'c',
    start,
    end,
    all_day: allDay,
    is_virtual: false,
    completed: false,
    location: null,
    description: null,
    calendar_id: null,
    status: 'busy',
    repeat_rule: null,
    alarms: [],
  });

  try {
    // 1) 定时事件在指定那天的区间：跨午夜要截到 0–1440，不能画到列外
    const cross = m.timelineSpan(inst('2026-10-14 22:00', '2026-10-15 02:00'), '2026-10-14');
    assert(cross && cross.startMin === 1320 && cross.endMin === 1440, `跨午夜截断错: ${JSON.stringify(cross)}`);
    const next = m.timelineSpan(inst('2026-10-14 22:00', '2026-10-15 02:00'), '2026-10-15');
    assert(next && next.startMin === 0 && next.endMin === 120, `次日区间错: ${JSON.stringify(next)}`);
    assert(m.timelineSpan(inst('2026-10-14 09:00', '2026-10-14 10:00'), '2026-10-15') === null, '不在当天的事件不该出现在列里');

    // 2) 全天事项走顶部全天带，不进时间轴
    assert(m.timelineSpan(inst('2026-10-14 00:00', '2026-10-15 00:00', true), '2026-10-14') === null, '全天事项不该占时间轴');

    // 3) 零点收工（22:00–00:00）在次日只剩 0 分钟，要撑成最小块才点得到
    const tiny = m.timelineSpan(inst('2026-10-13 22:00', '2026-10-14 00:00'), '2026-10-14');
    assert(tiny === null, '零点整结束的事件不该在次日留一格');
    const zero = m.timelineSpan(inst('2026-10-14 10:00', '2026-10-14 10:00'), '2026-10-14');
    assert(zero && zero.endMin - zero.startMin === m.MIN_BLOCK_MIN, `零时长事件应撑成最小块: ${JSON.stringify(zero)}`);

    // 4) 分道：两条重叠 → 各占一半；第三条只与第二条重叠 → 仍属同一簇
    const lanes = m.packLanes([
      { item: 'a', startMin: 540, endMin: 600 },
      { item: 'b', startMin: 570, endMin: 630 },
      { item: 'c', startMin: 600, endMin: 660 },
    ]);
    const byId = Object.fromEntries(lanes.map((p) => [p.item, p]));
    assert(byId.a.lane === 0 && byId.b.lane === 1, `重叠没分道: ${JSON.stringify([byId.a.lane, byId.b.lane])}`);
    assert(byId.a.lanes === 2 && byId.b.lanes === 2 && byId.c.lanes === 2, `同簇道数应一致: ${JSON.stringify([byId.a.lanes, byId.c.lanes])}`);
    assert(byId.c.lane === 0, 'c 与 a 首尾相接，应复用第 0 道');

    // 5) 不相交的两簇各自按自己的宽度铺满（否则下午的日程会被上午的挤成半宽）
    const two = m.packLanes([
      { item: 'x', startMin: 0, endMin: 90 },
      { item: 'y', startMin: 60, endMin: 120 },
      { item: 'z', startMin: 600, endMin: 660 },
    ]);
    const t = Object.fromEntries(two.map((p) => [p.item, p]));
    assert(t.x.lanes === 2 && t.z.lanes === 1, `簇宽算错: x=${t.x.lanes} z=${t.z.lanes}`);

    // 6) 拖拽吸附与钳位：拖出列外不能出现负分钟或 24:30
    assert(drag.snap(53) === 60 && drag.snap(52) === 45, `15 分钟吸附错: ${drag.snap(53)}/${drag.snap(52)}`);
    assert(drag.minAtOffset(-100) === 0, '向上拖出列外应贴 0');
    assert(drag.minAtOffset(999999) === 1440, '向下拖出列外应贴 1440');
    const norm = drag.normalizeDrag(1500, 100);
    assert(norm.startMin === 105 && norm.endMin === 1440, `反拖归一化错: ${JSON.stringify(norm)}`);
    const tail = drag.normalizeDrag(1435, 1440);
    assert(tail.startMin === 1425 && tail.endMin === 1440, `拖到列尾应留一格: ${JSON.stringify(tail)}`);

    // 7) 平移保持时长、贴边不截断；改时长不得拖到开始点之前
    const moved = drag.moveSpan({ startMin: 0, endMin: 90 }, -30);
    assert(moved.startMin === 0 && moved.endMin === 90, `越界平移应贴边: ${JSON.stringify(moved)}`);
    const moved2 = drag.moveSpan({ startMin: 600, endMin: 660 }, 45);
    assert(moved2.startMin === 645 && moved2.endMin === 705, `平移丢了时长: ${JSON.stringify(moved2)}`);
    const rs = drag.resizeSpan({ startMin: 600, endMin: 660 }, 500);
    assert(rs.endMin === 615 && rs.startMin === 600, `上拖过头应留最小块: ${JSON.stringify(rs)}`);

    // 8) 周边界：周日要归到本周一（周一开头），跨年 12-28 那周不能算错
    assert(m.weekStart('2026-10-18') === '2026-10-12', `周日应回到本周一: ${m.weekStart('2026-10-18')}`);
    assert(m.weekStart('2026-10-12') === '2026-10-12', '周一本身不该再往前');
    assert(m.shiftDays('2026-12-28', 7) === '2027-01-04', `跨年偏移错: ${m.shiftDays('2026-12-28', 7)}`);
    assert(m.shiftDays('2026-03-01', -1) === '2026-02-28', `闰年前后偏移错: ${m.shiftDays('2026-03-01', -1)}`);
  } catch (err) {
    failures.push(err.message);
  }
  return failures;
}

/**
 * 纯函数模块：/cal 指令语法（tools 侧唯一能覆盖这条链的地方）
 *
 * 这里钉的是"看起来对但落库错"的那几类：
 * `2026-10-15` 被区间语法啃掉、不给 --al 就不提醒（老用法回归）、
 * `M-D` 的跨年滚法、未知 flag 污染标题。
 */
function testCalDslModule() {
  const failures = [];
  const file = path.join(pluginsDir, 'todo', 'fe', 'src', 'dsl.ts');
  if (!existsSync(file)) return ['todo/fe/src/dsl.ts 不存在'];

  let d;
  try {
    moduleCache.clear();
    d = loadPluginModule(file);
  } catch (err) {
    return [`加载失败: ${err.message}`];
  }

  const today = new Date(2026, 9, 14); // 2026-10-14
  try {
    // 1) 完整写法：日期 + 区间 + 重复 + 双提醒
    const a = d.parseCalArgs(['评审', '10-15', '14:00-15:30', 'every:1week', '--al', '10,30'], today);
    assert(a.title === '评审', `标题应只剩裸词，实得 "${a.title}"`);
    assert(a.startAt === '2026-10-15 14:00', `开始时间错: ${a.startAt}`);
    assert(a.endAt === '2026-10-15 15:30', `结束时间错: ${a.endAt}`);
    assert(a.repeatRule === 'every:1week', `重复规则没归一: ${a.repeatRule}`);
    assert(a.alarms.join(',') === '30,10', `提醒应倒序去重: ${a.alarms.join(',')}`);
    assert(a.allDay === false, '带钟点不该判成全天');

    // 2) 绝对日期不能被区间语法啃成"10 月 15 日到 16 日"
    const b = d.parseCalArgs(['值班', '2026-10-15', '14:00'], today);
    assert(b.startAt === '2026-10-15 14:00', `绝对日期丢失: ${b.startAt}`);
    assert(b.title === '值班', `日期被当标题词: ${b.title}`);

    // 3) 老用法回归：只给时间也必须到点提醒（后端 create 的语义）
    const c = d.parseCalArgs(['喝水', '15:00'], today);
    assert(c.startAt === '15:00', `裸时间原样交后端解析: ${c.startAt}`);
    assert(c.alarms.join(',') === '0', `不给 --al 应默认 0 分钟提醒，实得 ${c.alarms.join(',')}`);
    // 显式关掉
    assert(d.parseCalArgs(['喝水', '15:00', '--al', 'none'], today).alarms.length === 0, '--al none 应清空提醒');

    // 4) 只给日期 = 全天，且不挂提醒（没有钟点可挂）
    const e = d.parseCalArgs(['出差', '10-20', '--where', '上海'], today);
    assert(e.allDay === true && e.startAt === '2026-10-20', `日期无钟点应为全天: ${JSON.stringify([e.allDay, e.startAt])}`);
    assert(e.endAt === '2026-10-20', `全天结束日应同天: ${e.endAt}`);
    assert(e.location === '上海', `--where 没吃到值: "${e.location}"`);
    assert(e.alarms.length === 0, '全天无钟点不该默认提醒');

    // 5) 分类 / 忙闲 / 关键词
    const f = d.parseCalArgs(['健身', '19:00', '--cal', '生活', '--free'], today);
    assert(f.calendarName === '生活' && f.status === 'free', `--cal/--free 解析错: ${JSON.stringify([f.calendarName, f.status])}`);

    // 6) 未知 flag 静默吞掉，不污染标题
    const g = d.parseCalArgs(['写', '文档', '--bogus', 'x'], today);
    assert(g.title === '写 文档 x', `未知 flag 漏进标题: "${g.title}"`);

    // 7) M-D 滚年：还没到过的留在今年，已经过去的按明年（1 月输入 12-25 是今年圣诞，不是去年）
    assert(d.resolveDate(12, 25, new Date(2026, 0, 5)) === '2026-12-25', '未来短日期不该滚年');
    assert(d.resolveDate(1, 5, new Date(2026, 11, 30)) === '2027-01-05', '过期短日期应滚到明年');
    assert(d.resolveDate(10, 15, today) === '2026-10-15', '未来的短日期留在今年');
    assert(d.resolveDate(10, 13, today) === '2026-10-13', '昨天允许补记，不该滚到明年');

    // 8) 非法时间留在标题里（`25:00` 不是钟点）
    assert(d.parseCalArgs(['看 25:00 的版本'], today).title === '看 25:00 的版本', '非法钟点不该被吃掉的场景应原样留词');
    const h = d.parseCalArgs(['发布', '25:00'], today);
    assert(h.startAt === '' && h.title === '发布 25:00', `非法钟点应回落标题: ${JSON.stringify([h.startAt, h.title])}`);

    // 9) 分类名匹配：精确 > 前缀 > 没中
    const rows = [{ id: 'c1', name: '工作' }, { id: 'c2', name: '工作效率' }, { id: 'd', name: '我的日程' }];
    assert(d.matchCalendarId('工作', rows) === 'c1', '同名应精确命中');
    assert(d.matchCalendarId('工作效', rows) === 'c2', '应支持前缀匹配');
    assert(d.matchCalendarId('', rows) === '', '空名不该匹配任何分类');
    assert(d.matchCalendarId('不存在', rows) === '', '没命中要返回空串交调用方兜默认');

    // 10) 胶囊文案含关键字段（用户据此确认落库前的理解）
    const cap = d.describeDraft(a);
    for (const want of ['10-15 14:00', '15:30', '-10min', '-30min', '每周']) {
      assert(cap.includes(want), `胶囊缺「${want}」：${cap}`);
    }
    assert(d.describeDraft({ ...a, allDay: true }).includes('全天'), '全天应显式标出');
    assert(d.repeatLabel('every:1year') === '每年' && d.repeatLabel('every:2hour') === '每 2 小时', '重复标签覆盖年/时步长');

    // 11) WP-09 自然语言时间：开头短语 → 时间，剩余文本 → 标题
    const now = new Date(2026, 9, 14, 10, 0); // 2026-10-14 周三 10:00
    const nat = (text) => d.parseNaturalTime(text, now);
    const natCase = (text, start, title, end = '') => {
      const r = nat(text);
      assert(r, `自然语言没解析出时间: ${text}`);
      assert(r.startAt === start, `「${text}」开始时间错: ${r.startAt}（期望 ${start}）`);
      assert(r.title === title, `「${text}」标题错: "${r.title}"（期望 "${title}"）`);
      assert((r.endAt || '') === end, `「${text}」结束时间错: ${r.endAt}（期望 ${end || '空'}）`);
    };

    natCase('明天下午三点开会', '2026-10-15 15:00', '开会');
    natCase('后天 10点 复盘', '2026-10-16 10:00', '复盘');
    natCase('周五 10点 项目复盘', '2026-10-16 10:00', '项目复盘');
    natCase('下周一 9点半 站会', '2026-10-19 09:30', '站会');
    natCase('下下周五 18点 团建', '2026-10-30 18:00', '团建');
    natCase('3点 开会', '2026-10-15 03:00', '开会'); // 今天 03:00 已过 → 明天
    natCase('9点一刻 站会', '2026-10-15 09:15', '站会');
    natCase('15:30 评审', '2026-10-14 15:30', '评审');
    natCase('晚上8点 跑步', '2026-10-14 20:00', '跑步');
    natCase('中午12点 午饭', '2026-10-14 12:00', '午饭');
    natCase('凌晨十二点 值班', '2026-10-15 00:00', '值班');
    natCase('明天下午三点开会 30分钟', '2026-10-15 15:00', '开会', '2026-10-15 15:30');
    natCase('下下周一 9点半 站会 半小时', '2026-10-26 09:30', '站会', '2026-10-26 10:00');

    const allDay = nat('今天 全天评审');
    assert(
      allDay && allDay.allDay && allDay.startAt === '2026-10-14' && allDay.endAt === '2026-10-14',
      `自然语言全天解析错: ${JSON.stringify(allDay)}`,
    );

    // 引号标题保护：首 token 被引号包裹时不做自然语言解析
    const quoted = d.parseCalArgs(['明天下午三点开会'], now, [true]);
    assert(quoted.startAt === '' && quoted.title === '明天下午三点开会', `引号标题被误解析: ${JSON.stringify(quoted)}`);

    // 时间在开头、标题在后且带引号：时间应解析，标题原样
    const mixed = d.parseCalArgs(['明天下午三点', '开会'], now, [false, true]);
    assert(
      mixed.startAt === '2026-10-15 15:00' && mixed.title === '开会',
      `混合输入解析错: ${JSON.stringify(mixed)}`,
    );

    // 显式 DSL 优先：已有 10-15 14:00 时不再走自然语言
    const explicit = d.parseCalArgs(['明天下午三点', '10-15', '14:00'], now);
    assert(
      explicit.startAt === '2026-10-15 14:00',
      `显式 DSL 被自然语言覆盖: ${explicit.startAt}`,
    );

    // 只有日期 + 时段但没有钟点 → 不猜，整串留作标题
    assert(nat('明天下午开会') === null, '缺少钟点的时段不该被猜测');
    // 只有时间没有标题 → 返回 null，避免生成空标题日程
    assert(nat('15:30') === null, '无标题的自然语言时间应回退');
    // 非法钟点 → 不猜
    assert(nat('25点 开会') === null, '25 点应判为非法并回退标题');
  } catch (err) {
    failures.push(err.message);
  }
  return failures;
}

async function main() {
  const plugins = listFrontendPlugins();
  console.log(`[plugin:test:fe] 发现 ${plugins.length} 个纯前端插件\n`);

  let failed = 0;
  for (const plugin of plugins) {
    const { id, failures } = await testPlugin(plugin);
    if (failures.length === 0) {
      console.log(`  ✓ ${id}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${id}`);
      for (const f of failures) console.log(`      - ${f}`);
    }
  }

  // 纯函数模块：区域框选的几何换算（坐标系错了截图就错位，且不易察觉）
  const geoFailures = testGeometryModule();
  if (geoFailures.length === 0) {
    console.log('\n  ✓ 纯函数：/shot 区域框选几何换算（缩放 × 屏原点叠加）');
  } else {
    failed += 1;
    console.log('\n  ✗ 纯函数：/shot geometry');
    for (const f of geoFailures) console.log(`      - ${f}`);
  }

  // 纯函数模块：/pomo 挂件的倒计时推导（ceil 取整 / 已过比例 / 到点终态）
  const pomoFailures = testPomoTimerModule();
  if (pomoFailures.length === 0) {
    console.log('\n  ✓ 纯函数：/pomo 挂件倒计时与进度环');
  } else {
    failed += 1;
    console.log('\n  ✗ 纯函数：/pomo timer');
    for (const f of pomoFailures) console.log(`      - ${f}`);
  }

  // 纯函数模块：/pomo 挂件的悬停伸缩（宽度是否装得下内容 · 右边缘是否钉住 · 与 manifest 对齐）
    const hoverFailures = testPomoHoverModule();
    if (hoverFailures.length === 0) {
      console.log('\n  ✓ 纯函数：/pomo 挂件悬停伸缩（宽度取值 · manifest 对齐 · 尺寸改由宿主落窗）');
    } else {
      failed += 1;
      console.log('\n  ✗ 纯函数：/pomo hover-size');
      for (const f of hoverFailures) console.log(`      - ${f}`);
    }

  // 弹出式基窗：manifest 声明齐全 · CSS 作用域不越界 · mountPopup 的取样与挂起规则
  const popupFailures = testPopupBaseWindow();
  if (popupFailures.length === 0) {
    console.log('\n  ✓ 弹出式基窗（auto_height 声明 · 死窗防护 · 样式作用域 · mountPopup 取样/死区/拖拽挂起）');
  } else {
    failed += 1;
    console.log('\n  ✗ 弹出式基窗');
    for (const f of popupFailures) console.log(`      - ${f}`);
  }

  // 纯函数模块：全局热键速查表的分组与格式化（多修饰键归组、修饰键顺序归一）
  const hotkeyFailures = testHotkeyModule();
  if (hotkeyFailures.length === 0) {
    console.log('\n  ✓ 纯函数：/hotkey 速查表分组与格式化（多修饰键归组唯一 · 修饰键顺序归一）');
  } else {
    failed += 1;
    console.log('\n  ✗ 纯函数：/hotkey hotkeys');
    for (const f of hotkeyFailures) console.log(`      - ${f}`);
  }

  // 纯函数模块：截图标注几何（反向拖拽归一化 · 箭头向量 · 步骤号阅读顺序）
  const annotateFailures = testAnnotateModule();
  if (annotateFailures.length === 0) {
    console.log('\n  ✓ 纯函数：/shot 标注几何（反向拖拽 · 箭头向量 · 步骤号按阅读顺序）');
  } else {
    failed += 1;
    console.log('\n  ✗ 纯函数：/shot annotate');
    for (const f of annotateFailures) console.log(`      - ${f}`);
  }

  // 纯函数模块：日程月视图的日期算术（跨天拆分 · 网格补齐）
  const calFailures = testCalendarDayMathModule();
  if (calFailures.length === 0) {
    console.log('\n  ✓ 纯函数：/cal 日期算术（本地解析 · 跨天拆分 · 全天独占尾 · 网格固定行）');
  } else {
    failed += 1;
    console.log('\n  ✗ 纯函数：/cal daymath');
    for (const f of calFailures) console.log(`      - ${f}`);
  }

  // 纯函数模块：周/日时间轴（区间切分 · 重叠分道 · 拖拽吸附）
  const tlFailures = testCalendarTimelineModule();
  if (tlFailures.length === 0) {
    console.log('\n  ✓ 纯函数：/cal 时间轴（跨午夜截断 · 重叠分道 · 15 分钟吸附 · 周边界）');
  } else {
    failed += 1;
    console.log('\n  ✗ 纯函数：/cal 时间轴');
    for (const f of tlFailures) console.log(`      - ${f}`);
  }

  // 纯函数模块：日期时间选择器（15 分钟档位 · 过期禁用 · 值组合）
  const dtfFailures = testDateTimeFieldModule();
  if (dtfFailures.length === 0) {
    console.log('\n  ✓ 纯函数：/cal 日期时间选择（96 档 15 分钟 · 过期只限今天 · 滚到首个可选 · 两半各自可改）');
  } else {
    failed += 1;
    console.log('\n  ✗ 纯函数：/cal 日期时间选择');
    for (const f of dtfFailures) console.log(`      - ${f}`);
  }

  // 纯函数模块：提醒卡片文案（常驻措辞 · 区间四形状 · 脏参降级）
  const rfFailures = testReminderFormatModule();
  if (rfFailures.length === 0) {
    console.log('\n  ✓ 纯函数：/cal 提醒卡片文案（今天/几分钟后 · 同日跨日全天 · URL 脏参降级）');
  } else {
    failed += 1;
    console.log('\n  ✗ 纯函数：/cal 提醒卡片文案');
    for (const f of rfFailures) console.log(`      - ${f}`);
  }

  // 纯函数模块：/cal 指令语法（日期与区间的先后 · 默认提醒 · flag 取值）
  const dslFailures = testCalDslModule();
  if (dslFailures.length === 0) {
    console.log('\n  ✓ 纯函数：/cal 语法（绝对日期不被区间吞噬 · 不给 --al 仍提醒 · 全天 · 分类匹配）');
  } else {
    failed += 1;
    console.log('\n  ✗ 纯函数：/cal dsl');
    for (const f of dslFailures) console.log(`      - ${f}`);
  }

  // svc 桥接抽查：qr 打开二维码走 process.launch；网络插件应覆盖全部声明的域名
  if (svcCalls.some((c) => c.method === 'svc.process.launch')) {
    console.log('\n  ✓ svc 桥接：/qr 与 /dict 已调用 svc.process.launch');
  }
  const hosts = Array.from(new Set(httpCalls.map((u) => {
    try {
      return new URL(u).hostname;
    } catch {
      return u;
    }
  })));
  for (const host of Object.keys(HTTP_FIXTURES)) {
    if (!hosts.includes(host)) console.log(`  ! 未覆盖的 HTTP 域名（fixture 未被用到）：${host}`);
  }
  console.log(`  ✓ svc.http.send 已覆盖 ${hosts.length} 个域名：${hosts.join(', ')}`);

  // D 组抽查：屏幕能力与热键注册是否真的走通了 svc 桥
  const screenMethods = Array.from(
    new Set(svcCalls.filter((c) => c.method.startsWith('svc.screen.')).map((c) => c.method)),
  ).sort();
  const shortcutCalls = svcCalls.filter((c) => c.method === 'svc.shortcut.register');
  if (screenMethods.length > 0) {
    console.log(`  ✓ svc.screen.* 已覆盖：${screenMethods.join(', ')}`);
  } else {
    console.log('  ! 未有插件用到 svc.screen.*（截图/取色用例可能未执行）');
  }
  if (shortcutCalls.length > 0) {
    const accels = Array.from(new Set(shortcutCalls.map((c) => c.params?.accel))).sort();
    console.log(`  ✓ svc.shortcut.register 已覆盖：${accels.join(', ')}`);
  } else {
    const bound = svcCalls.filter((c) => c.method === 'svc.shortcut.onHotkey');
    const ids = Array.from(new Set(bound.map((c) => c.params?.hotkeyId))).sort();
    console.log(
      ids.length > 0
        ? `  ✓ manifest 热键按 id 订阅：${ids.join(', ')}（注册由宿主统一完成）`
        : '  ! 未有插件订阅全局热键',
    );
  }
  // 视图注册：pick 的取色台必须经 svc.window.open 打开（key=none 插件唯一的开窗途径）
  if (svcCalls.some((c) => c.method === 'svc.window.open')) {
    const views = svcCalls.filter((c) => c.method === 'svc.window.open').map((c) => c.params?.view);
    console.log(`  ✓ svc.window.open 已覆盖：${Array.from(new Set(views)).join(', ')}`);
  }

  console.log(`\n[plugin:test:fe] ${plugins.length - failed}/${plugins.length} 通过`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
