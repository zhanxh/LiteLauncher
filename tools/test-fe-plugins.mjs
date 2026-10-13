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
  },
  getPluginContext(pluginId) {
    const call = async (method, params) => {
      svcCalls.push({ pluginId, method, params });
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
          const monitor = typeof opts.monitor === 'number' ? opts.monitor : 0;
          const target = MONITORS_FIXTURE[monitor] ?? MONITORS_FIXTURE[0];
          return { ...CAPTURE_FIXTURE, monitor, width: target.width, height: target.height };
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
        on: async () => () => {},
      },
      windows: {
        open: async (view, params = {}) => {
          svcCalls.push({ pluginId, method: 'svc.window.open', params: { view, params } });
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

const tauriStub = { __esModule: true, invoke: async () => null };
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
//   drive: true → 走「query → onSelect(查询项) → 再 query」的网络插件范式，expect 断言刷新后的面板
//   expectFirst  → 断言首次 query（未联网）的面板
//   after        → 额外的异步断言（如 dict 打开发音）
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

  // ── C 组：网络插件（显式触发 + 缓存 + refresh 范式）────────────────────────
  weather: [
    {
      tokens: ['Beijing'],
      drive: true,
      expectFirst: (items) => {
        assert(items[0].badge === '查询', 'weather 首次输入不应联网，应给「查询」项');
        assert(items[0].metadata?.fetch === 'Beijing', 'weather 查询项应携带缓存键');
      },
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
      },
    },
  ],
  fx: [
    {
      tokens: ['100', 'usd', 'cny'],
      drive: true,
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
      drive: true,
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
      drive: true,
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
      drive: true,
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
      drive: true,
      expect: (items) => {
        assert(items[0].badge === '未找到', `dict 404 应提示「未找到」，实得 ${items[0].badge}`);
        assert(items[0].title.includes('nonexistent'), 'dict 404 应回显查询词');
      },
    },
  ],
  tr: [
    {
      tokens: ['hello', 'world'],
      drive: true,
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
      drive: true,
      expectFirst: (items) => {
        assert(
          items[0].description?.includes('中文 → 英语'),
          `tr「/tr zh hello」应判为中文→英语，实得 ${items[0].description}`,
        );
      },
      expect: () => {},
    },
  ],

  // ── D 组：屏幕能力（截图 / 取色 + 全局热键）───────────────────────────────
  shot: [
    {
      tokens: [],
      expect: (items) => {
        const now = items[0];
        assert(now.metadata?.action === 'capture', 'shot 首项应为截图动作');
        assert(
          now.metadata?.monitor === -1,
          `shot 默认应截光标所在屏幕（-1），实得 ${now.metadata?.monitor}`,
        );
        assert(
          items.filter((i) => i.metadata?.action === 'capture').length >= 4,
          'shot 应给出主项 + 每块屏 + 延时档位',
        );
        assert(
          items.some((i) => i.badge === '副屏' && i.title.includes('2560×1440')),
          'shot 应列出副屏尺寸（来自 svc.screen.list）',
        );
        assert(
          items.some((i) => i.badge === '热键' && i.title.includes('alt+shift+s')),
          'shot 应提示全局热键',
        );
      },
      after: async (plugin, items) => {
        const before = svcCalls.length;
        const after = await plugin.onSelect(items.find((i) => i.metadata?.action === 'capture'));
        assert(after?.refresh === true, `shot onSelect 应返回 refresh=true，实得 ${JSON.stringify(after)}`);
        const call = svcCalls.slice(before).find((c) => c.method === 'svc.screen.capture');
        assert(call, 'shot 应调用 svc.screen.capture');
        assert(call.params?.hideWindows === true, 'shot 截图前应隐藏 LiteLauncher 窗口');
        assert(
          svcCalls.some((c) => c.method === 'svc.clipboard.write' && String(c.params?.text).endsWith('.png')),
          'shot 应把截图路径写入剪贴板',
        );

        // 刷新后应出现「最近截图」的三个操作项
        const fresh = await plugin.query(toParsed([]));
        const badges = fresh.items.map((i) => i.badge);
        assert(
          ['打开', '文件夹', '复制'].every((b) => badges.includes(b)),
          `shot 刷新后应出现 打开/文件夹/复制，实得 ${JSON.stringify(badges)}`,
        );
        const folder = fresh.items.find((i) => i.badge === '文件夹');
        assert(
          folder?.description?.endsWith('screenshots'),
          `shot「打开文件夹」应指向 screenshots 目录，实得 ${folder?.description}`,
        );
        // 复制项走壳层通用 copy 契约
        const copyAfter = await plugin.onSelect(fresh.items.find((i) => i.badge === '复制'));
        assert(String(copyAfter?.copy).endsWith('.png'), 'shot 复制项应回传文件路径');

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
        assert(items[0].title.includes('显示器 2'), `shot 2 标题应含显示器序号，实得 ${items[0].title}`);
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
      let data = await plugin.query(toParsed(testCase.tokens));
      if (!validatePanel(data.items, `query(${label})`, failures)) continue;
      if (typeof testCase.expectFirst === 'function') testCase.expectFirst(data.items);

      let lastItems = data.items;

      if (testCase.drive) {
        // 网络插件范式：首查不应联网；onSelect(查询项) 触发抓取并声明 refresh；再查应得结果
        const before = httpCalls.length;
        const fetchItem = data.items.find((i) => typeof i.metadata?.fetch === 'string');
        if (!fetchItem) {
          failures.push(`query(${label}) 未产出可抓取的 fetch 项（drive 用例）`);
          continue;
        }
        const after = await plugin.onSelect(fetchItem);
        if (after?.refresh !== true) {
          failures.push(`onSelect(查询项) 应返回 refresh=true，实得 ${JSON.stringify(after)}`);
          continue;
        }
        if (httpCalls.length === before) {
          failures.push(`onSelect(查询项) 未发起 svc.http.send 请求`);
        }
        data = await plugin.query(toParsed(testCase.tokens));
        if (!validatePanel(data.items, `刷新后 query(${label})`, failures)) continue;
        if (data.items.some((i) => typeof i.metadata?.fetch === 'string')) {
          failures.push(`刷新后 query(${label}) 仍在给「查询」项——缓存未生效`);
        }
        lastItems = data.items;
      }

      if (typeof testCase.expect === 'function') testCase.expect(lastItems);

      // onSelect 复制契约：任一可复制项回传 copy
      const copyable = lastItems.find((i) => typeof i.metadata?.value === 'string' && i.metadata.value);
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
    console.log('  ! 未有插件注册全局热键');
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
