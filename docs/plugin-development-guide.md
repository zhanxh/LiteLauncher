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
      "min_width": 480.0, "min_height": 520.0,   // 可省
      "resizable": true, "decorated": true,
      "always_on_top": false, "skip_taskbar": false,
      "focusable": true,
      "position": "center",            // center | bottom-right（右下角自动定位，适合弹窗类）
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

---

## 6. 约束与规则（为什么这样设计）

| 规则 | 理由 |
|---|---|
| be 只依赖 `ll-plugin-api`，禁 ll-host/tauri/彼此 | 独立编译、可整体替换为二期外部进程插件；依赖方向唯一 |
| fe 只依赖 `@ll/sdk` + solid-js | 壳层演进不破坏插件；SDK 是唯一契约面 |
| 插件 id = 目录名 = db 文件名 = 设置前缀 = 窗口标签前缀 | 命名空间严格一致，杜绝配置漂移（apps 插件曾因 `app`/`apps` 不一致踩坑） |
| 拿不到 `AppHandle`/裸连接/文件路径 | 权限门控在句柄构造时完成；ATTACH、任意路径、他插件数据在宿主侧被拒 |
| SQL 只能 DML，DDL 走 `migrate` | 语句白名单 + 可审计的 schema 变更 |
| 前端注册用生成文件 `plugins.generated.ts` | 壳层对插件零感知，插件可独立增删 |
| 窗口标签 `<id>-<view>[-<hash>]`，capabilities 需加 `<id>-*` | webview 权限按窗口标签匹配，漏加 = 插件窗口里 invoke 全被拒 |
| 密钥/敏感值不进 env、不落插件库 | 走 SecretStore（三期），设置中心提供核心托管的录入页 |

---

## 7. 测试、调试与门禁

- **单测**：纯函数放 be crate 里（`cargo test -p ll-plugin-todo`）；前端契约测试可用 fake ctx（浏览器模式自带回退数据，`npx tsc --noEmit` 全量类型检查）。
- **独立编译验证**：`cargo build -p ll-plugin-<id>` 必须通过——这保证插件没偷依赖宿主。
- **运行时排查**：`release/lifecycle.log`（`[plugin:<id>]` 前缀 = 插件日志；`init FAILED` = init 抛错）；窗口内 F12 打开 DevTools（devtools feature 已启用）。
- **依赖门禁**（手工 grep，后续进 CI）：
  ```bash
  grep -E 'll-host|tauri|ll-plugin-(todo|apps|notes)' plugins/*/be/Cargo.toml   # 期望无输出
  grep -rn "from '[^@]'" plugins/*/fe/src --include='*.ts*' | grep -v relative   # fe 只许 @ll/sdk + solid
  ```

---

## 8. 路线图：未来的插件形态

- **纯前端插件**（`backend: { kind: "none" }`）：宿主内置 `svc:*` 方法（settings/index/clipboard/dialog/log），fe 包无 be crate——书签、剪贴板历史这类插件收敛为"单文件 TS + manifest"。接口已预留，暂未实现。
- **LLP/1 外部进程插件**（二期）：`~/.litelauncher/plugins/<id>/` 安装任意语言实现的 sidecar，宿主经 JSON-RPC 分发；**前端 fe 代码与本文档完全同构**（`ctx.call` 不感知后端形态），届时只需换 manifest 的 backend 声明。
- **跨插件事件总线 / 插件全局热键 / AI（SecretStore + HTTP 白名单代理）**：见设计文档 §4.5 服务目录与 §6。
