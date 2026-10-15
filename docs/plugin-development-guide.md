# LiteLauncher 插件开发指南（LPS-1）

> 适用版本：M5 架构（插件独立编译）｜配套设计文档：[plugin-architecture-design.md](./plugin-architecture-design.md)
> 三个可参考的完整实现：`plugins/todo`（最全：后台调度/弹窗/设置）、`plugins/apps`（受控进程/搜索提供者）、`plugins/notes`（文件系统/编辑器窗口）。

---

## 1. 总览

一个插件 = **一个目录三层结构**，前后端各自独立编译：

```
plugins/<id>/
├─ manifest.json          # 声明式单一源：触发词、权限、窗口视图、设置项
├─ be/                    # 后端：独立 Rust crate（名字 ll-plugin-<id>）
│  ├─ Cargo.toml
│  └─ src/lib.rs          # 实现 ll_plugin_api::PluginBackend
└─ fe/                    # 前端：独立 TS 包（名字 @ll/plugin-<id>）
   ├─ package.json        # 带 "llplugin": true 标记
   └─ src/index.ts        # export function setup(): void
```

数据隔离是**物理级**的：每个插件拥有独立 SQLite 文件（`plugins/<id>/<id>.db`，位于系统数据目录下），插件拿不到别的插件的数据，也拿不到数据库文件路径。

**当前形态的边界**（诚实声明）：
- 插件后端与宿主**编译期内置**——新增插件需要重新构建主程序；外部进程插件（独立分发安装）是二期 LLP 目标；
- 所有持久化必须经后端 crate（`ctx.db`）。纯前端插件（`backend: none` + 宿主内置 `svc:*` 方法）是规划中的简化形态，暂未实现——无持久化需求的纯 UI 插件可以只写 fe，但**不建议**，因为 fe-only 无法声明 manifest 权限，且未来接入 `svc:*` 时要返工。

---

## 2. 快速开始：10 步接入清单

以创建 `plugins/bookmark` 为例（改动面用 ⭐ 标注的都是宿主侧文件，这正是"壳层零改动"的少数例外——注册点收敛在两处声明文件里）：

```bash
# 1. 建目录
mkdir -p plugins/bookmark/be/src plugins/bookmark/fe/src

# 2. manifest.json（见 §3）
# 3. be/Cargo.toml + be/src/lib.rs（见 §4）
# 4. fe/package.json + fe/src/*（见 §5）

# 5. 接线（宿主侧，共三处声明）
#    a. 根 Cargo.toml → [workspace].members 加 "plugins/bookmark/be"
#    b. src-tauri/Cargo.toml → [dependencies] 加 ll-plugin-bookmark = { path = "../plugins/bookmark/be" }
#    c. src-tauri/src/lib.rs → host.register(Arc::new(BookmarkPlugin::new()));

# 6. 前端生成注册（扫描 plugins/*/fe，产出 src/plugins.generated.ts）
npm run gen

# 7. 若插件开独立窗口：src-tauri/capabilities/default.json 的 windows 加 "bookmark-*"

# 8. 验证
cargo build -p ll-plugin-bookmark      # 插件独立编译
cargo test --workspace                 # 全部单测
npm run build && ./build.sh            # 全量构建

# 9. 启动应用，设置面板 → 插件：应看到 bookmark 已启用
# 10. 命令行输入 /bookmark（触发词）验证指令链路
```

就这么多——壳层 `App.tsx`、解析器、宿主 `ll-host`、其他插件**一行都不用动**。

---

## 3. manifest.json 规范

`manifest()` 在后端经 `include_str!` 解析此文件，宿主据此构造门控上下文（未声明的权限 → 对应服务句柄为 `None`，插件**没有能力路径**）：

```jsonc
{
  "id": "bookmark",                    // 必须与目录名一致（数据目录/db/窗口标签/设置前缀全用 id 命名）
  "name": "书签收藏",
  "version": "0.1.0",
  "api_version": "^1",                 // 兼容的 LPS 大版本
  "trigger": "/bookmark",              // 指令触发前缀
  "permissions": ["db", "windows", "notifications", "settings", "process", "fs"],
  "views": [                           // 可打开的独立窗口（声明式，建窗逻辑在宿主）
    {
      "id": "manager",                 // 窗口标签 = "<id>-manager"；URL = index.html?view=manager&<params>
      "title": "书签管理",
      "width": 580.0, "height": 680.0,
      "min_width": 480.0, "min_height": 520.0,   // 可省，但**必须成对**：宿主只在两者同时声明时才下发下限
      "resizable": true, "decorated": true,
      "max_height": 720.0,              // 可省，仅 auto_height 用：内容增长的硬上限
      "auto_height": false,             // true: 高度由内容决定（弹出式基窗，见 §5.6），强制 resizable:false
      "always_on_top": false, "skip_taskbar": false,
      "focusable": true,
      "position": "center",            // center | bottom-right | top-right（贴边角落自动定位，适合挂件/弹窗类）
      "stacked": false,                // true: 多实例向上堆叠（配合 unique_by）
      "unique_by": null,               // 传参数名则按参数值生成每实例唯一标签
      "on_existing": "focus",          // focus: 聚焦已有窗口 | replace: 关旧开新（提醒弹窗用）
      "title_param": null              // 传参数名则窗口标题 = "<title> - <参数值>"
    }
  ],
  "settings": [                        // 设置项（设置中心"插件管理"区可见）
    { "key": "max_items", "label": "最大保留条数", "kind": "number", "min": 10, "max": 1000, "default": 100 }
  ]
}
```

**权限 → 服务句柄对照**：

| 权限 | 注入的句柄 | 能力 |
|---|---|---|
| `db` | `ctx.db` | 本插件专属 SQLite（migrate/execute/query/事务语义见 §4.2） |
| `windows` | `ctx.windows` | 按 manifest views 建窗 |
| `notifications` | `ctx.notify` | 系统通知 |
| `process` | `ctx.process` | 受控启动外部程序（宿主执行注入校验与平台策略） |
| `settings` | `ctx.settings` | KV 设置（宿主强制加 `<id>.` 前缀，无法越权读写他插件） |
| `fs` | （预留） | 声明式目录作用域，M5 阶段仅供占位 |

`ctx.log`（生命周期日志）与 `ctx` 上未列出的能力**无需权限**，始终可用。

---

## 4. 后端开发（be crate）

### 4.1 Cargo.toml 与依赖规则

```toml
[package]
name = "ll-plugin-bookmark"          # 命名约定：ll-plugin-<id>
version = "0.1.0"
edition = "2024"

[dependencies]
ll-plugin-api = { path = "../../../src-tauri/crates/ll-plugin-api" }
serde_json = "1"
# 允许的通用库：serde / chrono / uuid / dirs
# 禁止：ll-host、tauri、其他插件 crate —— 这是独立编译与可替换性的根基
```

依赖规则由门禁 grep 检查（见 §7）。**插件拿不到 `AppHandle`、裸数据库连接、文件路径**——一切能力走 `PluginContext`。

### 4.2 核心 trait 契约

```rust
use ll_plugin_api::{
    PluginBackend, PluginContext, PluginError, PluginManifest,
    DbApi, WindowApi, NotifyApi, ProcessApi, SettingsApi, LogApi, CoreEvent,
};
use serde_json::{json, Value as JsonValue};
use std::sync::{Arc, Mutex};

pub struct BookmarkPlugin {
    ctx: Mutex<Option<PluginContext>>,   // init 时注入
}

impl PluginBackend for BookmarkPlugin {
    /// manifest 单一来源（照抄即可，换掉路径中的插件名）
    fn manifest(&self) -> PluginManifest {
        static MANIFEST: std::sync::OnceLock<PluginManifest> = std::sync::OnceLock::new();
        MANIFEST
            .get_or_init(|| {
                serde_json::from_str(include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../manifest.json"
                )))
                .expect("manifest.json 解析失败")
            })
            .clone()
    }

    /// 启动/重新启用时调用：建表、自检、启动内部线程
    fn init(&self, ctx: PluginContext) -> Result<(), PluginError> {
        if let Some(db) = &ctx.db {
            db.migrate(&["
                CREATE TABLE IF NOT EXISTS bookmarks (
                    id      TEXT PRIMARY KEY,
                    title   TEXT NOT NULL,
                    url     TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )
            "])?;
        }
        *self.ctx.lock().unwrap() = Some(ctx);
        Ok(())
    }

    /// 统一方法分发入口 —— 前端 ctx.call(method, params) 到达这里
    fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, PluginError> {
        match method {
            "list"   => self.list(&params),
            "add"    => self.add(&params),
            _        => Err(PluginError::unknown_method(method)),
        }
    }

    fn shutdown(&self) {}   // 禁用/退出时：停内部线程、释放资源
}
```

### 4.3 数据通道（DbApi）——JSON 进出

参数与返回都是 `serde_json::Value`（**参数键用 snake_case**，与前端约定一致），SQL 白名单在宿主侧强制：

```rust
fn add(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
    let title = params.get("title").and_then(|v| v.as_str())
        .ok_or_else(|| PluginError::bad_params("缺少参数 title"))?;

    self.with_ctx(|ctx| {
        let db = ctx.db.as_ref().ok_or_else(|| PluginError::permission_denied("db"))?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp();

        db.execute(                                   // 仅放行 INSERT/UPDATE/DELETE/REPLACE
            "INSERT INTO bookmarks (id, title, url, created_at) VALUES (?1, ?2, ?3, ?4)",
            &[json!(id), json!(title), json!(url), json!(now)],
        )?;

        Ok(json!({ "id": id, "title": title }))       // 返回值原样传回前端
    })
}

fn list(&self, _params: &JsonValue) -> Result<JsonValue, PluginError> {
    self.with_ctx(|ctx| {
        let db = ctx.db.as_ref().unwrap();
        let rows = db.query(                          // 仅放行 SELECT/WITH
            "SELECT id, title, url, created_at FROM bookmarks ORDER BY created_at DESC",
            &[],
        )?;   // 每行 = { "列名": 值, ... } 的 JSON 对象数组
        Ok(JsonValue::Array(rows))
    })
}
```

宿主强制约束：`migrate` 才能执行 DDL；`ATTACH/DETACH` 被拒绝（逃不出自己的库）；参数仅支持标量。

### 4.4 打开窗口 / 通知 / 受控启动 / 设置 / 日志

```rust
// 窗口：view_id 必须在 manifest.views 中声明；params 透传为页面查询串
ctx.windows.as_ref().ok_or_else(|| PluginError::permission_denied("windows"))?
    .open("manager", &[("id".into(), id.clone())])?;

// 系统通知
ctx.notify.as_ref().unwrap().send("书签收藏", "已保存书签")?;

// 启动外部程序：宿主做注入校验 + 平台策略（Windows cmd start / Unix xdg-open 或直接 spawn）
ctx.process.as_ref().unwrap().launch("https://example.com")?;

// 设置 KV：宿主自动加 "<id>." 前缀，get 不到返回 None
let max = ctx.settings.get("max_items").and_then(|v| v.parse::<u64>().ok()).unwrap_or(100);
ctx.settings.set("max_items", "200")?;

// 日志 → release/lifecycle.log（带 [plugin:<id>] 前缀）
ctx.log.log("info", "书签已同步");
```

### 4.5 后台线程模式（参考 todo 插件的提醒调度器）

需要周期任务时，**在 `init()` 里启动线程**，只持有 `PluginContext` 快照与共享开关，**不持有 self**：

```rust
fn init(&self, ctx: PluginContext) -> Result<(), PluginError> {
    // ... 建表 ...
    let thread_ctx = ctx.clone();
    let enabled = Arc::clone(&self.enabled);            // AtomicBool，shutdown() 时置 false
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        if !enabled.load(std::sync::atomic::Ordering::Relaxed) { continue; }
        // 用 thread_ctx 做扫描/推送；窗口创建等已由宿主派发回主线程，任意线程可调用
    });
    Ok(())
}
```

### 4.6 错误处理

统一用 `PluginError`，会原样传到前端（`ctx.call` 的 Promise reject）：

`unknown_method` / `bad_params` / `disabled` / `permission_denied` / `db` / `window` / `notify` / `internal`。

---

## 5. 前端开发（fe 包）

### 5.1 package.json 与目录

```jsonc
// plugins/bookmark/fe/package.json
{
  "name": "@ll/plugin-bookmark",       // 命名约定：@ll/plugin-<id>
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "llplugin": true                     // ⭐ gen 脚本的扫描标记，必须保留
}
```

**依赖规则**：fe 包只允许 import `@ll/sdk` 与 `solid-js`（+自己的相对文件）。CSS 随包自带（如 `./manager.css`），vite 别名自动解析包名。

### 5.2 指令插件（CommandPlugin）

```ts
// src/bookmarkPlugin.ts
import { CommandPlugin, ParsedInput, PanelData, PanelItem } from '@ll/sdk';
import { getPluginContext } from '@ll/sdk';

// 插件上下文：call 走宿主统一通道 plugin_call（按 pluginId 分发到你的后端）
const ctx = getPluginContext('bookmark');

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const bookmarkPlugin: CommandPlugin = {
  id: 'bookmark',
  trigger: '/bookmark',
  name: '书签收藏',
  description: '/bookmark 列表检索；/bookmark add "标题" URL',
  icon: '🔖',

  // 输入 "/bookmark ..." 且此函数返回 true 时进入 Action 模式（回车立即执行 execute）
  isAction(input: ParsedInput): boolean {
    return input.subcommand === 'add';
  },

  // Action 模式的实时语义预览胶囊（输入过程中给用户反馈）
  getPreview(input: ParsedInput) {
    if (input.subcommand !== 'add') return null;
    return {
      title: '添加书签',
      detail: `标题: "${input.args[0] ?? ''}" | URL: ${input.args[1] ?? ''}`,
      badge: '即时动作',
      hint: '按 Enter 保存',
    };
  },

  // 插件专属语法钩子：核心解析器只做通用分词，命名参数在这里提取
  // （参考 todo 插件：时间/重复规则解析即通过此钩子从内核迁入）
  enrichParsed(tokens: string[], _input: ParsedInput) {
    return { args: tokens };   // 需要命名参数时返回 { args, namedArgs: { key: value } }
  },

  // Action 执行（回车触发）。返回 message 会以 Toast 呈现
  async execute(input: ParsedInput) {
    if (!isTauri()) return { success: true, message: '[预览模式] 已添加' };
    try {
      await ctx.call('add', { title: input.args[0], url: input.args[1] });
      return { success: true, message: '书签已保存' };
    } catch (err: any) {
      return { success: false, message: `保存失败: ${err?.message || err}` };
    }
  },

  // 查询模式（非 Action 的 "/bookmark xxx"）：面板列表
  async query(input: ParsedInput): Promise<PanelData> {
    if (!isTauri()) return { items: [], emptyText: '（浏览器预览模式）' };
    const rows = await ctx.call<Array<Record<string, unknown>>>('list', {
      keyword: input.queryText.trim() || null,
    });
    return {
      items: rows.map((r) => ({
        id: r.id as string,
        title: r.title as string,
        description: r.url as string,
        icon: '🔖',
        badge: '书签',
        metadata: { url: r.url },          // onSelect 需要的数据放这里
      })),
      emptyText: '暂无书签，/bookmark add "标题" URL 添加',
    };
  },

  // 面板项选中：行为通过返回 AfterSelect 声明，壳层不认识任何具体插件
  async onSelect(item: PanelItem) {
    if (isTauri()) {
      await ctx.call('open_url', { url: item.metadata?.url });   // 或 launch/notify 等
    }
    return { close: true };    // AfterSelect，见 §5.4
  },
};
```

### 5.3 裸文本搜索（SearchProvider）——可选

不输斜杠、直接打字时，壳层聚合所有 provider（按 priority 升序并行执行、50ms 防抖、陈旧结果取消）。参考 apps 插件的三个 provider：

```ts
import { SearchProvider } from '@ll/sdk';

export const bookmarkSearchProvider: SearchProvider = {
  id: 'bookmark.search',      // 约定 <id>.search
  priority: 30,               // apps.local=10 / apps.cli=20 / apps.web=90 之间取位

  async search(raw: string) {
    if (!isTauri()) return [];
    const rows = await ctx.call<...>('search', { keyword: raw }).catch(() => []);
    return rows.map((r) => ({
      id: `bookmark-${r.id}`,
      title: r.title,
      description: r.url,
      icon: '🔖',
      metadata: { url: r.url },
    }));
  },

  async onSelect(item: PanelItem) { /* 同上 */ },
};
```

### 5.4 AfterSelect —— 声明壳层后续行为

```ts
{
  close?: boolean;        // 隐藏主窗口（打开独立窗口/启动应用后）
  clearInput?: boolean;   // 清空输入框（缺省跟随 close）
  toast?: string;         // Toast 提示文案
  refresh?: boolean;      // 重新执行本插件 query 刷新面板（如切换完成状态）
}
```

### 5.5 独立窗口视图（可选）

后端 `ctx.windows.open("manager", params)` 打开的窗口由壳层按 `?view=manager&...` 渲染——你的 fe 包导出对应组件并注册：

```tsx
// src/views.tsx
import { Component } from 'solid-js';
import { BookmarkManager } from './BookmarkManager';

export const ManagerView: Component = () => {
  // 窗口 URL 参数由组件自行解析（后端 open 时透传，已 percent-encode）
  const params = new URLSearchParams(window.location.search);
  return <BookmarkManager initialId={params.get('id') ?? ''} />;
};
```

```ts
// src/index.ts —— 包入口：setup 由生成的注册表调用
import { pluginRegistry, searchRegistry, registerView } from '@ll/sdk';
import { bookmarkPlugin, bookmarkSearchProvider } from './bookmarkPlugin';
import { ManagerView } from './views';

export function setup(): void {
  pluginRegistry.register(bookmarkPlugin);
  searchRegistry.register(bookmarkSearchProvider);
  registerView('manager', ManagerView);
}
```

### 5.6 弹出式基窗（`auto_height` + `PopupFrame`）

「放一张卡片在桌面上」是插件最常要的形状：详情窗、提醒卡、小工具面板。
自己拼这套形状，每个插件都要重复写三件最容易错的事：无边框后怎么拖、
高度怎么跟着内容、内容超长怎么滚。宿主把它收成了基窗能力，插件只剩两步。

**第一步：manifest 声明**

```jsonc
{
  "id": "detail",
  "width": 440.0, "height": 420.0,     // height 只是首帧尺寸，量到内容后立刻被替换
  "min_width": 440.0, "min_height": 160.0,   // 成对声明，宿主才下发下限
  "max_height": 720.0,                 // 内容再长也到此为止，多出来的走内部滚动
  "auto_height": true,
  "resizable": false,                  // 声明"不让用户拖框"；Linux 上宿主会替 auto_height 窗口翻成 true（见下面第 4 条）
  "decorated": false,                  // 基窗的前提：没有系统标题栏就没有"外壳"
  "position": "center",                // center / bottom-right / top-right 都支持
  "unique_by": "event", "on_existing": "focus"
}
```

**第二步：前端把 widget 放进 `PopupFrame`**

```tsx
import { PopupFrame } from '@ll/ui';

<PopupFrame
  pluginId="myplug"
  title="日程详情"
  actions={<button onClick={() => setEditing(true)}>编辑</button>}
  onClose={() => void getCurrentWindow().destroy()}
>
  <MyWidget />
</PopupFrame>
```

`PopupFrame` 做三件事：给 `<body>` 打 `ll-popup-mode`（`@ll/ui` 的 popup.css 全靠它作用域）、
把头部标成 `data-tauri-drag-region="deep"`、用 `ResizeObserver` 把内容自然高度报给宿主
（`ctx.windows.setContentSize`）。不需要壳给的头（比如悬停才展开的挂件）直接调
`mountPopup({ pluginId, content, drag })` 自己排骨架即可。

**宿主的硬保证（插件不必也无法绕过）**

- 高度只在 `[min_height, max_height]` 里动，越界一律夹取，返回值 `clamped` 告诉你被夹了；
- 改高度时**钉住当前矩形的那条边**：center / top-* 钉顶边（往下长，标题行不跳），
  bottom-* 钉底边（往上长），角落窗改宽时钉右边缘。算法在 `ll-plugin-api` 的
  `popup_rect_after_size`，物理↔逻辑像素换算全在宿主，插件不碰 `scaleFactor()`；
- 逐帧改尺寸（悬停伸缩）**不会让钉住的边漂移**：`set_size`/`set_position` 到 WM 生效有延迟，
  下一帧若拿"读回来的矩形"当基准就会逐帧累积误差（真机量到过 ±12px）。宿主因此记住
  自己上一次请求过的矩形，在途期间以它为准，尺寸一落地就立刻回到实时读数（用户拖走的窗口不会被拽回）；
- `svc.window.setContentSize` **只能由视图窗口自身调用**（调用方标签由 Tauri 注入，
  插件伪造不了），且只有本插件视图声明过的标签才被接受；
- 建窗时先隐藏，量到第一帧高度才露脸（消掉"空白大窗闪一下"），并有 1.2s 兜底 show
  —— 前端崩了也不能留下一个"点了没反应"的隐形窗；
- `stacked` 的堆叠偏移累加**已存在窗口的实际内容高度**（由宿主自己记账），不是声明高度：
  auto_height 窗口建出来是隐藏的，GTK 对未映射窗口问 `outer_size()` 返回 0，
  照它算每张卡只偏移那条 8px 间隙，第二张直接压在第一张上面。

**两条平台/样式例外，踩过才知道**

- **Linux/GTK 会直接忽略 `resizable(false)` 窗口的应用侧 `set_size`**，而 Tauri 照样返回
  `Ok(())`。于是 auto_height 在 Linux 必须保持"可 resize"这个属性，症状才是"前端在报高度、
  窗口永远停在声明值，卡片下面一条没画过的空白"。用户真拖了边框，由 `mountPopup` 的
  `resize` 监听把窗口拉回内容高度 —— 代价从"缩不动"换成"拖完弹回"，后者可接受。
- **`index.html` 的 `html, body, #root { color / background-color !important }` 是 ID 权重
  (1,0,0)**，比 `body.ll-popup-mode`(0,1,1) 高：底色与字色必须重写在 `body.ll-popup-mode > #root`
  上，只写 body 会被 `#root` 挡回去。真机症状是"没自己声明 color 的标题浅到看不见"，
  而窗口多出来的部分是一片 `index.html` 的白。

**代价，必须讲明白**

1. 自适应高度 = 放弃用户拖边框改大小。长内容走内部滚动 + 可见滚动条
   （popup.css 已把 `index.html` 全局藏滚动条的 `!important` 覆盖回来）。
   「用户拖过就暂停跟随内容」是更完整的解，但要做 resize 回环与恢复入口，目前不提供。
2. 形态是**实心窗口 + 系统圆角**，不是 CSS 透明圆角。pomo 在 Windows 上验过：
   赌 WebView2 透明会露一圈白底。所以底色取 `--surface-raised`，圆角交给 DWM / 合成器。
3. 新视图漏登记 `capabilities/default.json` 的 `<id>-*` ⇒ **死窗**：窗口建得出来、
   所有 invoke 被权限层拒掉，症状是"点了没反应"。`npm run plugin:test:fe` 里
   「弹出式基窗」那一组会按声明的标签（含 `unique_by` 后缀形式）逐条比对白名单。
4. Wayland：`set_position` 归 compositor，角落锚定可能静默失效（缩放仍应工作）。
   与 `attachDesktop` 一样按"如实降级"看待，不要当成 bug。
5. 测量目标是内容的**自然高度**，不是窗口高度——否则"窗口矮 → 量出来矮 → 窗口更矮"
   会自激。因此内容根节点不能带 `height: 100vh`（`min-height: 100vh` 同样禁止）。
   滚动因此发生在 `<body>` 这一层，`PopupFrame` 的标题行是 `position: sticky`：
   滚到任何一行都还看得见"这是哪条日程"，拖拽区也始终在手边。


---

## 6. 约束与规则（为什么这样设计）

| 规则 | 理由 |
|---|---|
| be 只依赖 `ll-plugin-api`，禁 ll-host/tauri/彼此 | 独立编译、可整体替换为二期外部进程插件；依赖方向唯一 |
| fe 只依赖 `@ll/sdk` / `@ll/ui` + solid-js | 壳层演进不破坏插件；SDK 是唯一行为契约面，`@ll/ui` 只出令牌与基窗骨架（依赖方向恒为 ui→sdk，不让 sdk 反向依赖组件） |
| 插件 id = 目录名 = db 文件名 = 设置前缀 = 窗口标签前缀 | 命名空间严格一致，杜绝配置漂移（apps 插件曾因 `app`/`apps` 不一致踩坑） |
| 拿不到 `AppHandle`/裸连接/文件路径 | 权限门控在句柄构造时完成；ATTACH、任意路径、他插件数据在宿主侧被拒 |
| SQL 只能 DML，DDL 走 `migrate` | 语句白名单 + 可审计的 schema 变更 |
| 前端注册用生成文件 `plugins.generated.ts` | 壳层对插件零感知，插件可独立增删 |
| 窗口标签 `<id>-<view>[-<unique值>]`，capabilities 需加 `<id>-*` | webview 权限按窗口标签匹配，漏加 = 插件窗口里 invoke 全被拒。**新增视图（尤其是基窗类弹窗）时最容易犯**：症状是"点了没反应"，`npm run plugin:test:fe` 的「弹出式基窗」一组按声明标签逐条比对白名单 |
| 密钥/敏感值不进 env、不落插件库 | 走 SecretStore（三期），设置中心提供核心托管的录入页 |

---

## 7. 测试、调试与门禁

- **单测**：纯函数放 be crate 里（`cargo test -p ll-plugin-todo`）；前端契约测试可用 fake ctx（浏览器模式自带回退数据，`npx tsc --noEmit` 全量类型检查）。
- **宿主几何单测**：`cargo test -p ll-plugin-api`——弹窗的夹取区间、四角锚定、标签匹配（`window_label` ↔ `label_matches_view`）都在这层，**只有真机才看得出错的那类计算就在这里被断言掉**（物理/逻辑像素换算由宿主独享，插件侧无从复现）。
- **插件级测试（改完插件必跑）**：
  ```bash
  npm run plugin:test      # LLP（Python）插件：走一遍 initialize/search/execute 协议
  npm run plugin:test:fe   # 纯前端插件：Node 内直跑逻辑，断言真实计算结果
  ```
  其中「弹出式基窗」一组守的是跨文件的三类事故：manifest 的 `auto_height` 声明是否自洽
  （必须 `decorated:false` + `resizable:false`，min 宽高必须成对，`height ≤ max_height`）、
  声明出的窗口标签能否被 `capabilities/default.json` 的 glob 匹配（漏登记 = 死窗）、
  `popup.css` 的选择器是否全部收在 `body.ll-popup-mode` 作用域内，以及 `mountPopup` 的
  取样/死区/拖拽挂起行为（用假 DOM 跑，不依赖浏览器）。
- **独立编译验证**：`cargo build -p ll-plugin-<id>` 必须通过——这保证插件没偷依赖宿主。
- **运行时排查**：`release/lifecycle.log`（`[plugin:<id>]` 前缀 = 插件日志；`init FAILED` = init 抛错）；窗口内 F12 打开 DevTools（devtools feature 已启用）。
- **依赖门禁**（手工 grep，后续进 CI）：
  ```bash
  grep -E 'll-host|tauri|ll-plugin-(todo|apps|notes)' plugins/*/be/Cargo.toml   # 期望无输出
  grep -rn "from '[^@]'" plugins/*/fe/src --include='*.ts*' | grep -v relative   # fe 只许 @ll/sdk + @ll/ui + solid
  ```
  相对路径（`./foo`）合法，`@ll/*` 与 `solid-js` 之外的一律视为越界。`@ll/ui` 只提供 token 化的样式与 `PopupFrame`
  这类无状态组件，不掺插件逻辑——依赖方向恒为 ui→sdk，反过来会让 sdk 拖进 solid。

---

## 8. 插件形态总览

四种形态，共用同一注册表、同一 `plugin_call` 通道、同一份 `svc.*` 能力。**壳层对它们零特判**——`ctx.call()` 只认方法名，不感知后端形态。

| 形态 | `backend.kind` | 代码位置 | 运行时依赖 | 需要重编译主程序 | 指南 |
|---|---|---|---|---|---|
| 编译期插件 | `builtin`（默认） | `plugins/<id>/{be,fe}` | 无 | ✅ 需要 | §2–§5 |
| 外部插件（LLP/1） | `llp` | `plugins/<id>/{manifest.json, 脚本}` | 任意语言运行时 | ❌ 拷目录即装 | §9 |
| **纯前端插件** | `none` | `plugins/<id>/{manifest.json, fe/}` | **无** | ❌ | **§11** |
| 编译期 + 前端零代码 | `llp` 但 fe 省略 | 同 LLP | 任意语言运行时 | ❌ | §9（宿主按 `command` 生成通用指令插件） |

- **跨插件事件总线 / 插件全局热键 / AI（SecretStore + HTTP 白名单代理）**：见设计文档 §4.5 服务目录与 §6；HTTP/事件/密钥的既有实现见 §10。

---

## 9. 外部插件（LLP/1，M6）：独立部署 + 动态加载

内置插件随宿主编译发布；**外部插件是独立分发的可执行 sidecar**，拷入目录即安装，宿主启动时动态加载，无需重编主程序。

### 9.1 形态与安装

```
plugins/sysinfo/                 # 仓库内开发
├─ manifest.json                 # backend.kind = "llp" + entry 启动命令 + command 命令声明
└─ sysinfo.py                    # 任意语言的 sidecar（Python/Bash/Go/Rust…）

两级安装位置（同名插件：用户安装目录优先，覆盖随附版本）：
├─ <主程序目录>/plugins/sysinfo/                    # 便携部署：随程序分发（绿色版）
│   npm run plugin:install -- sysinfo --portable
└─ ~/.local/share/LiteLauncher/extplugins/sysinfo/  # 用户安装：不随程序走
    npm run plugin:install -- sysinfo              # 卸载 = 删除该目录
```

```jsonc
// manifest.json 新增字段
{
  "description": "系统信息查询……",
  "backend": { "kind": "llp", "entry": ["python3", "sysinfo.py"] },  // 工作目录 = 插件目录
  "command": { "icon": "🖥️", "action_subcommands": ["open"], "hint": "……" }
}
```

### 9.2 Python 运行时（sysinfo 等 Python sidecar）

Python 版 sidecar 依赖机器上有一个 Python 3 解释器。宿主按以下优先级解析，**命中即停**：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 用户在「设置 → Python 环境」配置的路径 | 持久化在核心库 `app_settings`（键 `python.path`），进程启动时载入 |
| 2 | 环境变量 `LLP_PYTHON` | 全路径或 PATH 内裸名，适合便携部署/批量分发 |
| 3 | PATH 中的 `python3` / `python` / `py` | 跳过 Microsoft Store 的 0 字节占位 stub |
| 4 | Windows 注册表 PEP 514 | `HKCU/HKLM\Software\Python\...\InstallPath`，python.org/conda/uv 均登记 |
| 5 | 常见安装位置 | `%LOCALAPPDATA%\Programs\Python`、`C:\Python3xx`、用户目录 conda、Homebrew、`/usr/bin`… |
| 6 | 各盘符根目录的 conda/Python 目录 | 覆盖 `D:\tools\Miniconda3` 这类自定义位置（含其 `envs\*`） |

设置面板提供**自动检测**（列出全部候选与版本）、**浏览…**（系统文件选择框）与手动填写；保存前会先执行一次版本探测，
路径不可用直接报错不落库。保存成功后宿主会杀掉已运行的 sidecar —— LLP 是懒启动的，下次调用自动按新解释器重建，
**无需重启应用**。sysinfo 的「sidecar 运行时」条目会显示实际生效的解释器路径，可用于确认。

`backend.entry` 写成绝对路径（含 `/` 或 `\`）或非 Python 裸名（如 `node`）时按字面交给系统解析，不参与上述探测。

### 9.3 运行时行为

- **懒启动**：注册/启用不 spawn，首次 `ctx.call` 才拉起进程；崩溃后下次调用自动重启
- **前端同构**：宿主据 `command` 声明生成通用 CommandPlugin，fe 侧无需任何代码——`/sysinfo` 输入、候选、Toast 与内置插件体验一致
- **加载流程**：宿主扫描两级目录（用户安装 extplugins 优先，其次主程序旁 plugins/，同名取前者并记日志）→ manifest 解析 + 门控上下文构造（同一套权限模型）→ 注册进同一注册表；前端 `plugin_list` 驱动生成命令。便携目录随程序一起拷贝分发，程序升级不影响两侧插件
- **安全**：sidecar 没有任何宿主句柄，能力全部经 `svc.*` 反向请求由宿主代理，未在 manifest 声明的权限直接拒绝

### 9.4 sidecar 协议（LLP/1：stdio JSON Lines，每行一条 JSON-RPC 2.0）

| 宿主 → 插件 | 说明 |
|---|---|
| `initialize` | 握手，须回 `{"protocol":"LLP/1"}`（3s 超时） |
| `call` `{method, params}` | 分发到你的方法表（5s 超时）：标准方法 `search` / `execute` / `select` |
| `shutdown` | 通知，收到后退出 |

| 插件 → 宿主（反向请求） | 说明 |
|---|---|
| `svc.db.migrate` | `{statements[]}` —— 建表/迁移，仅 DDL（须声明 `db` 权限） |
| `svc.db.execute` / `svc.db.query` | `{sql, params[]}` —— 本插件专属库（须声明 `db` 权限） |
| `svc.clipboard.write` / `read` | `{text}` / 无参 —— 宿主原生剪贴板（须声明 `clipboard:write` / `clipboard:read`） |
| `svc.http.send` | `{method, url, headers, body}` → `{status, body}`（须声明 `net:<host>`） |
| `svc.notify.send` | `{title, body}` 系统通知 |
| `svc.process.launch` | `{target}` 受控启动（须声明 `process` 权限） |
| `svc.events.emit` | `{event, payload}` 前端事件广播（前端按 pluginId 过滤） |
| `svc.settings.get/set`、`svc.log.write` | 设置 KV（自动前缀隔离）、日志 |

> 这些方法与前端 `ctx.call('svc.*')` 走的是**同一个分发器**（`services.rs::dispatch_svc`），并非只对 LLP 开放。

参考实现：`plugins/sysinfo/sysinfo.py`（Python 标准库，~150 行，含完整握手/分发/svc 调用）。

**MVP 边界**（后续迭代）：插件自定义 UI（iframe 沙箱 + postMessage 桥）、安装时权限确认弹窗、插件市场签名分发、流式事件通道。

---

## 10. M7 服务：密钥库 / 事件通道 / HTTP 代理（AI 类插件能力）

M7 为 `PluginContext` 新增三个门控句柄（完整示例见 `plugins/ai/`）：

| 句柄 | 权限 | 语义 |
|---|---|---|
| `ctx.secrets` | `secrets` | 核心托管密钥库，`secret.<id>.<key>` 命名空间——只能读写自己的；密钥不进插件库、他插件无法表达该前缀。MVP 存核心库保留键空间，OS keyring 为升级路径 |
| `ctx.events` | 无（自动命名空间） | 向前端窗口推送事件：宿主以 Tauri `plugin-event` 广播 `{pluginId, event, payload}`，前端 `listen('plugin-event')` 按 id 过滤——流式增量、进度推送的标准通道 |
| `ctx.http` | `net:<host>` 逐域名 | 宿主代理 HTTP（ureq）：`send`（非流式）与 `send_stream`（SSE 流式，回调返回 false 中止）。未声明域名直接拒绝，请求可审计 |

AI 插件（`plugins/ai/`）是三者的组合范例：`/ai` 打开对话窗口 → 前端经 `ctx.call('chat')` 触发 → 后端从 secrets 取密钥、http 流式请求 OpenAI 兼容端点、SSE 解析后 events 推 delta → 前端增量渲染；中断走回调返回 false。

**注意**：`net:` 白名单是逐域名精确匹配（含子域名需逐一声明）；接口地址可在对话窗口配置（默认 `https://api.openai.com`，换端点需同步在 manifest 增加对应 `net:` 权限）。

---

## 11. 纯前端插件（`backend.kind = "none"`）：无 crate、无 sidecar

**适用**：纯计算 / 文本处理 / 格式转换 / 换算类。**不适用**：需要自定义窗口、长任务、或运行时不提供的标准库能力（如 WebCrypto 没有 MD5）。

### 11.1 目录结构（两个文件 + 一个包声明）

```
plugins/myplug/
├─ manifest.json                 # backend.kind = "none"（+ 权限声明）
└─ fe/
   ├─ package.json               # { "name": "@ll/plugin-myplug", "llplugin": true, "main": "src/index.ts" }
   └─ src/index.ts               # 全部逻辑在这里，唯一允许 import 的壳层依赖是 @ll/sdk
```

完整可抄的例子：`plugins/unit/fe/src/index.ts`（多条目面板 + 复制）、`plugins/qr/fe/src/index.ts`（调用 `svc.*`）。

### 11.2 manifest

```jsonc
{
  "id": "myplug",
  "name": "我的工具",
  "version": "0.1.0",
  "api_version": "^1",
  "trigger": "/myplug",
  "description": "……（/help 与候选展示用）",
  "permissions": [],                       // 按需：db / clipboard:write / net:<host> / process / notifications …
  "backend": { "kind": "none" },            // ✅ 与 builtin/llp 的唯一区别
  "command": { "icon": "🧰", "action_subcommands": [], "hint": "……" }
}
```

`command` 声明仅用于图标/提示等元数据；纯前端插件**自己注册 CommandPlugin**，不走宿主生成的通用指令插件。

### 11.3 插件代码模板

```ts
import {
  pluginRegistry,
  type AfterSelect, type CommandPlugin, type PanelData, type PanelItem, type ParsedInput,
} from '@ll/sdk';

const PLUGIN_ID = 'myplug';

const plugin: CommandPlugin = {
  id: PLUGIN_ID,
  trigger: '/myplug',
  name: '我的工具',
  description: '……',
  icon: '🧰',
  isAction: () => false,

  async query(input: ParsedInput): Promise<PanelData> {
    // input.subcommand = 首个 token；input.args = 其余；input.queryText = 剔除子命令后的关键词
    const text = [input.subcommand ?? '', ...input.args].join(' ').trim();
    if (!text) return { items: [{ id: 'hint', title: '输入内容', badge: '用法' }], emptyText: '输入内容' };
    return {
      items: [{
        id: `${PLUGIN_ID}:r0`,
        title: '结果预览',
        description: '回车复制',
        badge: '结果',
        icon: '🧰',
        metadata: { value: text.toUpperCase() },   // metadata.value = 要复制的文本
      }],
    };
  },

  async onSelect(item: PanelItem): Promise<AfterSelect> {
    const value = item.metadata?.value;
    if (typeof value !== 'string' || !value) return { toast: '无内容可复制' };
    return { copy: value, toast: '已复制' };
  },
};

export function setup(): void {
  pluginRegistry.register(plugin);
}
```

`AfterSelect` 的其余字段：`close`（关窗）、`clearInput`、`refresh`（重跑 query 刷新面板）、`toast`。

### 11.4 能用的能力：`svc.*`

宿主保留方法名空间，**由宿主直接应答**，不进入插件后端分发表（所以纯前端插件也能用）。SDK 已封装成同名属性：

| SDK 属性 | 等价 `svc.*` | 权限 |
|---|---|---|
| `ctx.settings.get/set/getJson/setJson` | `svc.settings.get` / `set` | —（宿主强制 `${pluginId}.` 前缀隔离） |
| `ctx.clipboard.write/read` | `svc.clipboard.write` / `read` | `clipboard:write` / `clipboard:read` |
| `ctx.http.send/get/json` | `svc.http.send` | `net:<host>` |
| `ctx.notify.send` | `svc.notify.send` | `notifications` |
| `ctx.events.emit` | `svc.events.emit` | — |
| `ctx.log.debug/info/warn/error` | `svc.log.write` | — |
| `ctx.screen.list/cursor/pixel/capture` | `svc.screen.list` / `cursor` / `pixel` / `capture` | `screen` |
| `ctx.shortcuts.register/unregister/list/on` | `svc.shortcut.register` / `unregister` / `list` | `shortcut:<accel>`（逐条、无通配） |
| `ctx.windows.open(view, params?)` | `svc.window.open` | `windows` |
| `ctx.windows.setContentSize({width?, height?})` | `svc.window.setContentSize` | `windows`（且只能改自己所在视图，改高需该视图 `auto_height`） |
| `ctx.call('svc.db.migrate' / 'svc.db.execute' / 'svc.db.query')` | 同左 | `db` |
| `ctx.call('svc.process.launch', { target })` | 同左 | `process` |

```ts
import { getPluginContext } from '@ll/sdk';
const ctx = getPluginContext('myplug');
await ctx.clipboard.write('复制这段');         // svc.clipboard.write
await ctx.settings.setJson('items', [1, 2]);   // svc.settings.set（自动 JSON 序列化）
const data = await ctx.http.json<MyResp>(url); // svc.http.send（非 2xx / 非 JSON 会抛可读错误）
```

> `isHostAvailable()` 可判断是否在宿主中（浏览器 `vite dev` 预览时为 false），据此降级。

#### 桌面能力插件：截图与取色（`screen` / `shortcut:<accel>`）

这两项是"插件形态 + 宿主能力包"的组合，参考实现见 `plugins/shot` 与 `plugins/pick`。

**`ctx.screen`——坐标一律是桌面全局物理像素**（与 `getCurrentWindow().outerPosition()` 同一坐标系）：

```ts
await ctx.screen.list();                                  // [{index,name,primary,x,y,width,height,scaleFactor}]
await ctx.screen.cursor();                                // {x,y}
await ctx.screen.pixel({ radius: 7 });                    // {sample:{x,y,r,g,b,hex}, grid:{cols,rows,cells,center}}
await ctx.screen.capture({ monitor: -1, hideWindows: true, delayMs: 3000 });
```

- `capture` 的 `monitor`：`-1` = 光标所在那块屏、`0..n` = 序号、缺省 = 主显示器；
- `hideWindows: true` 会**先隐藏全部 LiteLauncher 窗口再截图**（否则截出来的图里有启动器自己），截完自动复原并回焦；`delayMs` 宿主侧硬上限 **10 秒**；
- `pixel` 不传坐标 = 取**当前光标处**；传 `radius` 时额外返回一片 `#RRGGBB` 方格（不是图片，前端用 CSS 网格铺出来即是硬边像素放大镜）。取色台靠**一次调用同时拿到位置、颜色与放大镜**在 7Hz 下轮询；
- 缺省落盘位置：`<数据目录>/LiteLauncher/plugins/<id>/screenshots/`，插件可用 `path` 覆盖。

**`ctx.shortcuts`——全局热键（逐条声明，无通配）**：

```jsonc
// manifest
"permissions": ["shortcut:alt+p"]
```

```ts
await ctx.shortcuts.register('alt+p');        // 幂等；未声明 / 被占用 → 抛错
await ctx.shortcuts.on('alt+p', () => { /* 任意界面按下都会到这里 */ });
await ctx.shortcuts.on('alt+p', cb, { scope: 'any' }); // 视图窗口内也要响应时必须显式声明
```

- 宿主维护 `加速键 → 插件` 的注册表做**先到先得仲裁**，冲突返回 `conflict` 错误；触发时广播 `plugin-shortcut` 事件（载荷 `{pluginId, accel}`），**插件拿不到原始按键流**；
- `on()` 默认 `scope: 'main'`，**只在没有 `?view=` 的主窗口生效**——每个窗口加载都会把全部插件的 `setup()` 跑一遍，不区分上下文的话打开任意视图窗口后热键会被执行两次；
- 多个窗口共用一份插件状态时（如"面板开着时主窗口让位"），用 `ctx.settings` 做标记即可：取色台把 `panelOpen` 写进 KV，主窗口的热键处理器读到就让位。

**开视图窗口**：纯前端插件没有 `ctx.windows` 之外的途径，且 `view` 必须是 manifest `views` 里声明过的 id：

```ts
await ctx.windows.open('panel', { id: 'x' });   // → 窗口标签 pick-panel?view=panel&id=x
```

> ⚠️ **新增视图窗口必须同步登记 Tauri 能力**：`src-tauri/capabilities/default.json` 的 `windows` 是**显式标签白名单**（标签 = `<pluginId>-<viewId>`）。漏登记 → 该窗口权限为零 → `plugin_call` 被拒、窗口变死窗。例如取色台加的是 `pick-*`。

#### 网络类插件：**不要在 `query()` 里发请求**

壳层对 `query()` 是**逐键调用且无防抖**的，把请求写进 `query` 会变成“打一个字发一次 API”。统一范式：

```
query(input)     → 命中缓存则渲染结果；否则只渲染一条「查询」项（metadata.fetch = 缓存键）
onSelect(查询项)  → 真正抓取（ctx.http.json/send）→ 写缓存 → 返回 { refresh: true }
onSelect(结果项)  → 返回 { copy: metadata.value }
```

需要按状态码分支时用 `ctx.http.send`（返回 `{status, body}`），例如词典要区分「404 未收录」与「网络异常」。参考实现：`plugins/weather`、`plugins/fx`、`plugins/ip`、`plugins/dict`、`plugins/tr`。

### 11.5 权限门控怎么生效（重要）

宿主对 `svc.*` 构造门控上下文时按插件是否在注册表中分两种情况：

| 情况 | 门控依据 |
|---|---|
| manifest 能被宿主读到（部署在 plugins/ 里） | 严格按 `manifest.permissions` 门控 |
| manifest 读不到（只随前端包编译进来） | 退回 `shell_safe_manifest`：仅 `settings / clipboard:* / notifications / events`，**db / process / net 一律拒绝** |

因此**只要用到 `db` / `process` / `net:*`，就必须把 manifest 部署到宿主能看到的地方**：

```bash
npm run plugin:install -- myplug              # 用户目录
npm run plugin:install -- myplug --portable   # 便携目录（随 release/ 分发）
```

开发期不用手动装：宿主在 debug 构建下会**自动扫描仓库 `plugins/`**，manifest 与 fe 都能对上。

### 11.6 测试

```bash
npm run plugin:test:fe     # Node 内直跑插件逻辑（转译 TS + 桩化壳层依赖），断言真实计算结果
```

在 `tools/test-fe-plugins.mjs` 的 `CASES` 里加用例：给输入 token、断言产出条目（`badge` / `metadata.value` / `description`）。

网络类插件在用例里加 `drive: true`，测试会走「query → `onSelect(查询项)` → 再 query」的完整范式，并断言刷新后的解析结果；`svc.http.send` 由测试内的域名 fixture 桩应答（见 `HTTP_FIXTURES`），可用函数形式模拟 404 等分支。也可用 `expectFirst` 断言首次（未联网）的面板、`after` 追加异步断言（如“打开发音应调用 `svc.process.launch`”）。

屏幕类插件同理：`svc.screen.*` 由 `MONITORS_FIXTURE` / `PIXEL_FIXTURE` / `CAPTURE_FIXTURE` 桩应答，`svc.shortcut.*`、`svc.window.open`、`svc.clipboard.write` 都会记进 `svcCalls`，因此可以在 `after` 里断言「截图前 hideWindows 为 true」「路径确实进了剪贴板」「开的是哪个视图」这类行为。

测试支持**包内相对导入**（`./color`、`./history` 递归转译），但 `.tsx` 视图组件返回空模块——solid 的 JSX 需要编译期，Node 端只验命令插件逻辑。所以**把可测的纯逻辑抽到 `.ts` 里**（如 `plugins/pick/fe/src/color.ts` 的色彩换算），`.tsx` 只留渲染与轮询。

### 11.7 从 LLP 迁到纯前端

1. 把 sidecar 的逻辑改写成 `fe/src/index.ts` 的 `query`/`onSelect`（面板条目结构不变：`id`/`title`/`description`/`badge`/`icon`/`metadata.value`）；
2. `manifest.backend` 改成 `{"kind": "none"}`，删掉 `entry`；
3. 新增 `fe/package.json`（`"llplugin": true`），删除 sidecar 脚本；
4. `npm run gen && npx tsc --noEmit && npm run plugin:test:fe`。

**边界判断**：算法密集、依赖 Python 标准库（`hashlib`/`ipaddress`）、或依赖系统命令的实现，**留在 LLP 更省事**——例如 `/hash`（WebCrypto 无 MD5）、`/cidr`、`/cron`。
