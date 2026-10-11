# LiteLauncher 插件化架构设计方案

> 版本：v1.0（2026-10-11）
> 目标：将「应用启动 /app、待办 /todo、Markdown 笔记 /note」从核心剥离为独立插件，建立统一插件接入标准（LPS），使新增功能（含未来的 AI 插件）只需"添加一个插件包"，零核心改动。

---

## 1. 现状盘点

### 1.1 已有的好底子

前端已经存在一个事实上的插件层，这是本次设计的起点而非从零开始：

| 已有资产 | 位置 | 状态 |
|---|---|---|
| `CommandPlugin` 接口契约 | `src/types/command.ts` | ✅ 已定义 isAction/getPreview/execute/query/onSelect |
| 插件注册表 | `src/core/registry.ts` | ✅ register/get/matchCandidates |
| 指令解析路由器 | `src/core/parser.ts` | ✅ 基于 registry 分发，本身不依赖具体插件 |
| 5 个"插件" | `src/plugins/*.ts` | ⚠️ 静态 import，与壳层互相渗透 |
| 分词/模糊匹配/计算器 | `src/core/{tokenizer,fuzzy}.ts`、parser 内 | ✅ 通用能力 |

### 1.2 耦合点清单（必须逐一拆除）

**壳层 App.tsx（580 行）中的硬编码：**

| 位置 | 问题 |
|---|---|
| `App.tsx:44-71` | `?view=editor/reminder/todoapp/settings` 的 if-else 路由，直接 import NoteEditor/ReminderToast/TodoManager/SettingsPanel —— 插件私有 UI 被编译进壳层 |
| `App.tsx:289-341` | 裸文本搜索兜底（本地应用检索 + CLI 运行 + 网页搜索）写死在壳层，本质是 apps 插件的业务 |
| `App.tsx:417-455` | `handleSelectItem` 按 `metadata.isAppLaunch/isAppAdd/isCliLaunch/isWebSearch` 特判 —— apps 插件的选中语义泄漏进壳层 |
| `App.tsx:494-507` | 按**插件 id 字符串**（`'notes'`、`'app'`）决定选完后是否关闭窗口 —— 最典型的反向依赖 |
| `src/plugins/index.ts` | 手工静态注册，新增插件必须改核心文件 |

**后端 src-tauri 中的耦合：**

| 位置 | 问题 |
|---|---|
| `lib.rs:188-217` | 24 个 IPC 命令全部静态列入 `generate_handler!`，新增插件必须改内核 |
| `db.rs` | 6 张业务表（todos/app_shortcuts/note_index+fts/command_history/app_settings）混在单库单文件，业务表结构归核心所有 |
| `reminder.rs:2-4` | 调度器直接 `use crate::todo::next_occurrence` 与 `crate::notes::urlencoding_simple` —— 提醒系统是 todo 的业务逻辑，却横向依赖 notes |
| `todo.rs/notes.rs` | 各自直接 `WebviewWindowBuilder` 建窗口，窗口管理散落在业务模块 |
| `app_launcher.rs/system_apps.rs` | 应用扫描/启动是 apps 插件业务，却在内核 crate 里 |

**结论**：要剥离的不是"把文件挪个位置"，而是三类依赖——**UI 路由依赖、IPC 静态注册依赖、数据/服务所有权依赖**。

---

## 2. 设计目标与原则

1. **零核心改动扩容**：新增一个插件 = 新增一个目录 + 一行注册（脚手架自动生成），不改壳层与内核任何文件。
2. **单一接入标准（LPS）**：内置 Rust 插件与未来的外部进程插件走**同一套**接口契约，前端完全无感知插件形态。
3. **核心最小化**：核心只保留"启动器本体"——搜索框、结果面板、热键、托盘、主题、插件宿主、通用服务。`/app` `/todo` `/note` 全部外移。`/help`（指令发现）与 `/settings`（设置中心）属于壳层自有能力，保留在核心。
4. **渐进式迁移**：每个阶段结束时应用保持可构建、可运行、功能不回退；老用户数据一次性自动迁移。
5. **安全前置**：权限在 manifest 中声明、宿主门控注入服务，为二期外部插件与 AI（网络/密钥）预留边界。

---

## 3. 总体架构

```
┌───────────────────────────────────────────────────────────────┐
│  前端壳层 (core/shell)                                         │
│  SearchBar · ResultPanel · PreviewCapsule · Toast              │
│  解析器/注册表 · 视图路由表 · 设置中心 · 插件管理页              │
└──────────────┬────────────────────────────────────────────────┘
               │  统一插件契约 LPS（前端侧）CommandPlugin 2.0
               │  统一通道: plugin_call() / plugin_event
┌──────────────┴────────────────────────────────────────────────┐
│  插件宿主 ll-host                                              │
│  插件注册表 · 分发器 · 权限门控 · (二期)LLP 外部进程适配器      │
├───────────────────────────────────────────────────────────────┤
│  内核 ll-kernel                │ 通用服务 ll-services           │
│  窗口/托盘/热键/生命周期         │ Db · Window · Notification      │
│                                │ Scheduler · Settings · History  │
│                                │ SecretStore · (fs/net 门控)     │
└──────────────┬─────────────────┴────────────────┬──────────────┘
               │ trait PluginBackend（后端侧）      │
   ┌───────────┴──────────┐   ┌──────────────┐   ┌─┴─────────┐
   │ plugins/todo          │   │ plugins/notes │   │ plugins/apps│
   │ (含 reminder 逻辑+弹窗)│   │ (FTS+编辑器窗) │   │ (扫描+启动)  │
   └──────────────────────┘   └──────────────┘   └───────────┘
```

分层规则：

- **ll-plugin-api**（trait/类型定义 crate，零实现）：是唯一的"标准"，前端 TS 契约与之对应。任何依赖方向只能指向它。
- **插件只能通过 PluginContext 句柄使用服务**，拿不到 `AppHandle`/裸 `Connection`——权限门控在句柄构造时完成。
- **插件之间禁止互相 import**。跨插件需求（如"AI 总结我的待办"）通过二期的跨插件调用 API（host 中转）解决，一期不做。

---

## 4. 统一插件接入标准（LPS-1）

这是本方案的核心交付物。一份插件 = **manifest + 前端包 + 后端 crate（可选）**。

### 4.1 插件清单 manifest.json

```jsonc
{
  "id": "todo",                      // 唯一 id，小写，db/目录/事件命名空间
  "name": "待办事项",
  "version": "0.1.0",
  "apiVersion": "^1.0",              // LPS 大版本兼容范围
  "trigger": "/todo",
  "permissions": ["db", "notifications", "windows", "settings"],
  // "backend": { "kind": "builtin" }              一期：编译期内置 crate
  // "backend": { "kind": "process", "protocol": "LLP/1", "entry": "sidecar" }  二期
  "views": [
    { "id": "manager", "title": "待办管理", "size": [760, 560] },
    { "id": "popup", "title": "待办提醒", "size": [360, 148], "decorated": false, "alwaysOnTop": true }
  ],
  "settings": [
    { "key": "popup_auto_close_secs", "type": "number", "label": "提醒弹窗时长（秒）",
      "min": 5, "max": 300, "default": 12 }
  ]
}
```

权限在 §4.5 服务目录中逐服务定义，形如 `db`、`notifications`、`windows`、`settings`、`process`、`opener`、`fs:dir:<scope>`、`env:<NAME>`（逐名白名单，无通配）、`clipboard:read/write`、`net:<host>`（域名白名单）、`secret:read:<key>`、`shortcut:<accel>` 等；未声明的服务句柄为 `None`，插件不存在对应能力路径。

### 4.2 前端契约 CommandPlugin 2.0

```ts
// core/shell/src/lps/types.ts —— 对所有插件发布的唯一 SDK 入口
export interface PluginContext {
  /** 经宿主分发调用本插件后端（或 LLP 转发外部进程） */
  call<T = unknown>(method: string, params?: object): Promise<T>;
  /** 订阅本插件后端推送的事件（如 AI 流式 delta、待办到期） */
  on(event: string, cb: (payload: unknown) => void): () => void;
  windows: { open(viewId: string, params?: Record<string, string | number>): Promise<void> };
  settings: {
    get<T>(key: string, fallback: T): Promise<T>;   // 自动以 `${pluginId}.` 为前缀隔离
    set(key: string, value: unknown): Promise<void>;
  };
  toast(msg: string, type?: 'info' | 'error'): void;
  /** 服务目录（§4.5）的前端可达子集：经 plugin_call 由宿主内置 svc:* 方法或本插件后端应答（§4.6） */
  env: { get(name: string): Promise<string | null> };            // 白名单内（§4.3.2）
  config: { get<T>(key: string, fallback: T): Promise<T>; set(key: string, v: unknown): Promise<void> };
  clipboard: { write(text: string): Promise<void>; read(): Promise<string | null> };
  index: { put(item: IndexEntry): Promise<void>; remove(id: string): Promise<void>; clear(): Promise<void> };
  dialog: { pickDir(title?: string): Promise<string | null>; pickFile(...): Promise<string | null> };
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  meta: { platform: 'linux' | 'win32' | 'darwin'; apiVersion: string; pluginVersion: string };
}

export interface CommandPlugin {
  id: string; trigger: string; name: string; description: string; icon: string;
  isAction(input: ParsedInput): boolean;
  showItemsInActionMode?: boolean;
  getPreview?(input: ParsedInput, ctx: PluginContext): ActionPreviewCapsule | null;
  execute?(input: ParsedInput, ctx: PluginContext): Promise<ActionResult>;
  query?(input: ParsedInput, ctx: PluginContext): Promise<PanelData>;
  onSelect?(item: PanelItem, ctx: PluginContext): Promise<AfterSelect | void>;

  /** 输入增强钩子：把 todo 专属的时间/重复规则解析从 core/tokenizer 迁入插件 */
  enrichParsed?(tokens: string[], input: ParsedInput): Partial<ParsedInput>;
}

/** 选后行为契约 —— 取代 App.tsx 里按插件 id 硬编码关闭窗口 */
export interface AfterSelect { close?: boolean; clearInput?: boolean; toast?: string; refresh?: boolean; }
export interface ActionResult { success: boolean; message: string; close?: boolean; }

/** 裸文本（无斜杠）搜索扩展点 —— 取代壳层写死的应用/CLI/网页兜底 */
export interface SearchProvider {
  id: string;              // 如 'apps.local'、'apps.cli'、'apps.web'
  priority: number;        // 越小越靠前；核心历史推荐固定 priority=0
  search(raw: string, ctx: PluginContext): Promise<PanelItem[]>;
}

/** 插件入口（每个插件包导出的工厂） */
export function definePlugin(manifest: PluginManifest, setup: (reg: PluginRegistration) => void): void;
// setup 内注册: command(CommandPlugin) / searchProvider(SearchProvider) /
//              view(id, Component) / settingsSection(Component)
```

关键决策说明：

- **`onSelect` 返回 `AfterSelect`**：`App.tsx:494-507` 的 `plugin.id === 'notes'` 判断被 `{ close: true }` 取代，壳层不再知道任何插件名字。
- **`enrichParsed` 钩子**：现 `parser.ts:184` 调用的 `extractTimeAndRule` 是 todo 专属语法，迁入 todoPlugin；parser 回归"通用分词 + 触发词路由"，命名参数机制由各插件自行增强。
- **`SearchProvider`**：裸文本搜索从"壳层功能"降级为"扩展点聚合"。核心仅保留历史推荐（priority 0）与计算器（先于插件路由的常驻能力）。apps 插件贡献 `apps.local / apps.cli / apps.web` 三个 provider，由此彻底从 App.tsx 拿掉 `isAppLaunch/isAppAdd/isCliLaunch/isWebSearch` 特判——选中行为回到各自插件 `onSelect`。

### 4.3 后端契约 PluginBackend + 统一 IPC

**取消逐命令静态注册。** 内核只保留窗口管理等少量核心命令 + 3 个通用通道：

```rust
// ll-host 暴露的全部插件相关 IPC
#[tauri::command] async fn plugin_call(state: State<'_, HostState>, plugin_id: String, method: String, params: JsonValue) -> Result<JsonValue, String>;
#[tauri::command] fn plugin_list(state: State<'_, HostState>) -> Vec<PluginInfo>;          // manifest + 启用状态
#[tauri::command] fn plugin_set_enabled(app: AppHandle, state: State<'_, HostState>, plugin_id: String, enabled: bool) -> Result<(), String>;
// 事件下行: emit("plugin_event", { pluginId, event, payload })
// 事件上行: listen 由服务主动推，插件不直发核心事件
```

```rust
// ll-plugin-api —— 每个内置插件 crate 实现此 trait
#[async_trait]
pub trait PluginBackend: Send + Sync {
    fn id(&self) -> &'static str;
    async fn init(&self, ctx: PluginContext) -> Result<(), PluginError>;
    async fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, PluginError>;
    async fn on_core_event(&self, ev: &CoreEvent) {}     // theme_changed / scheduler_tick / settings_changed
    async fn shutdown(&self) {}
}

// 门控后的服务句柄（按 manifest 权限决定 Some/None；不满足权限的服务根本不存在）
// 完整服务目录与各句柄规范见 §4.5
pub struct PluginContext {
    pub db: Option<DbHandle>,            // 独立库 plugins/<id>/<id>.db，建表/迁移由插件自理（§4.3.1）
    pub windows: Option<WindowHandle>,   // open(plugin_id, view, params) —— 唯一合法开窗途径
    pub notify: Option<NotifyHandle>,
    pub scheduler: Option<SchedulerHandle>, // register_tick(secs) / register_at(timestamp)
    pub settings: SettingsHandle,        // 核心 KV，key 自动加 `${pluginId}.` 前缀
    pub history: HistoryHandle,          // 记录本插件指令使用（只写）
    pub env: Option<EnvHandle>,          // 白名单环境变量（§4.3.2）
    pub config: Option<ConfigHandle>,    // 插件 TOML 配置文件（§4.3.3）
    pub resources: ResourcesHandle,      // 插件包内只读资源（无需权限）
    pub paths: PathsHandle,              // 标准目录解析（documents/downloads/appdata/...）
    pub meta: MetaHandle,                // platform / api_version / plugin_version
    pub log: LogHandle,                  // 结构化日志 → plugins/<id>/log（容量轮转）
    pub fs: Option<FsHandle>,            // 声明式目录作用域 + dialog 运行时授权
    pub dialog: DialogHandle,            // 文件/目录选择器（选择即授权）
    pub process: Option<ProcessHandle>,  // spawn/kill/stdout 事件流（apps 插件）
    pub opener: Option<OpenerHandle>,    // URL/文件/所在目录 → 系统默认程序
    pub clipboard: Option<ClipboardHandle>, // write / read（read 单独授权）
    pub index: Option<IndexHandle>,      // 共享 FTS：条目注入全局裸文本搜索
    pub http: Option<HttpHandle>,        // 宿主代理 HTTP，域名白名单
    pub secrets: Option<SecretHandle>,   // SecretStore（keyring），密钥不落插件库
    pub bus: Option<BusHandle>,          // 跨插件 pub/sub（topic 命名空间，二期）
    pub shortcuts: Option<ShortcutHandle>, // 插件注册全局热键，宿主仲裁冲突（二期）
}
```

前端插件从 `invoke('create_todo', …)` 改为 `ctx.call('create', …)`；宿主按 `plugin_id` 查表分发到内置 trait 对象，或（二期）转发 LLP 子进程。**对前端完全同构**——这就是"统一接入标准"的技术支点，也是 AI 等外部能力未来不需要改内核的原因。

`generate_handler!` 的代价：失去编译期命令名检查，由契约测试兜底（见 §9）。

#### 4.3.1 持久化接口与数据隔离（DbHandle 规范）

**持久化由框架提供**：宿主在插件 `init()` 时按 manifest 权限创建连接并注入句柄，插件自始至终拿不到裸 `Connection`，也拿不到文件路径。

```rust
// ll-plugin-api
pub struct DbHandle { /* Mutex<Connection>（绑定本插件库文件）+ plugin_id；路径不出 API */ }

impl DbHandle {
    /// 建表/迁移：仅接受 DDL（CREATE/ALTER/PRAGMA user_version），宿主记录 schema 版本；
    /// 幂等由插件自理（IF NOT EXISTS / user_version 比对），框架不管理各插件表结构
    pub fn migrate(&self, sqls: &[&str]) -> Result<(), PluginError>;
    /// 参数化写：只放行 DML（INSERT/UPDATE/DELETE），语句头检查拒绝 ATTACH/DETACH/DDL 散写
    pub fn execute(&self, sql: &str, params: &[JsonValue]) -> Result<u64, PluginError>;
    /// 参数化读：返回 JSON 行数组
    pub fn query(&self, sql: &str, params: &[JsonValue]) -> Result<Vec<JsonValue>, PluginError>;
    /// 事务闭包（回调内只拿到 Txn 受限句柄）
    pub fn transaction<T>(&self, f: impl FnOnce(&Txn) -> Result<T, PluginError>) -> Result<T, PluginError>;
}
```

**数据隔离 = 五层叠加：**

| 层 | 机制 | 防住什么 |
|---|---|---|
| 物理层 | 每插件独立库文件 `plugins/<id>/<id>.db`，宿主按 id 建连接 | 跨库读写在 SQLite 层面不存在（单连接只见单库） |
| 句柄层 | 受限 API：禁 ATTACH/DETACH（防挂载他库）、DDL 必须走 `migrate`、路径不可见 | 拿到句柄也逃不出自己的库 |
| 权限层 | manifest 未声明 `"db"` → `ctx.db = None` | 未授权插件零持久化能力 |
| 命名层 | 轻量 KV 走共享 `app_settings` 时，`SettingsHandle` 强制 `${pluginId}.` 前缀 | 键冲突与越权读写其他插件配置 |
| 形态层 | 前端永远无 SQL（只 `ctx.call()` 自己后端）；LLP 外部插件的 `svc.db` 请求由宿主盖章 plugin_id 代执行 | 前端攻击面、外部进程伪造身份 |

**生命周期**：`init()` 打开连接并执行 migrate；禁用 → `shutdown()` 关连接、文件保留（重新启用数据不丢）；卸载 → 删除插件目录即清数据；备份/迁移 = 拷贝目录。

**取舍说明**：选"每插件一个库文件"而非"单库加表前缀"——免跨插件锁竞争、禁用/卸载/备份的爆炸半径收敛到单文件、§5.5 迁移器逻辑最简。代价是失去跨插件 join，这是有意为之：跨插件数据访问必须经宿主中转 API（二期），不允许插件直接摸对方数据。

#### 4.3.2 环境变量接口（EnvHandle）

**默认拒绝 + 逐名白名单**。环境变量常含密钥（`OPENAI_API_KEY` 等），禁止读取任意 env；manifest 必须逐个声明变量名，不支持 `env:*` 通配：

```jsonc
"permissions": ["env:PATH", "env:HOME", "env:HTTP_PROXY"]
```

```rust
pub struct EnvHandle { /* 宿主对进程 env 的启动时快照，按白名单过滤 */ }
impl EnvHandle {
    pub fn get(&self, name: &str) -> Option<String>;   // 白名单外 → E_PERM
    pub fn expand(&self, tpl: &str) -> Option<String>; // "${HOME}/notes" 展开，仅白名单变量
}
```

设计决策：

- **快照制**：init 时快照一次，句柄只服务快照——避免运行中变异、行为可测试。
- **密钥不走 env**：规范上密钥一律 SecretStore（§4.5）。若插件坚持声明敏感名（如 `env:OPENAI_API_KEY`），安装确认弹窗将逐名明示"该插件将读取环境变量 X"，授予权在用户。
- **同进程约束说明（诚实边界）**：内置 Rust 插件技术上可 `std::env::get_var` 绕过——权限模型对它是设计契约 + code review 把关；对二期 LLP 外部插件是硬约束（其一切请求经宿主代理，自身拿不到进程 env）。
- 配套 `MetaHandle`（platform/api_version/plugin_version）与 `PathsHandle`（标准目录）免权限提供，取代前端 navigator.userAgent 嗅探平台等脏手段。

#### 4.3.3 配置文件与资源接口（ConfigHandle / ResourcesHandle）

三种"配置"职责分离，**不做自动合并，各是各的真相源**：

| 通道 | 形态 | 谁写 | 适用 |
|---|---|---|---|
| `settings`（§4.3） | 核心 KV + 设置中心 GUI | 用户经 UI | 离散标量（开关、时长），manifest 可声明自动渲染 |
| `config`（本节） | `plugins/<id>/config.toml` | 用户手编 / 插件写回 | 结构化配置：嵌套、数组、**带注释**（高级用户） |
| `resources`（本节） | 插件包 `assets/` 只读 | 插件作者随包分发 | 种子数据、模板、i18n 文案、JSON Schema |

```rust
pub struct ConfigHandle { /* 绑定 plugins/<id>/config.toml；文件大小上限 256KB */ }
impl ConfigHandle {
    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T>;
    pub fn set(&self, key: &str, value: JsonValue) -> Result<(), PluginError>;
    // 写回经 toml_edit round-trip —— 保留用户手写注释；外部编辑由 fs watch 触发
    // core_event: ConfigChanged → 插件热重载
}

pub struct ResourcesHandle { /* 只读本插件包 assets/，路径净化，禁 ".." 穿越；无需权限 */ }
impl ResourcesHandle {
    pub fn read_text(&self, rel: &str) -> Result<String, PluginError>;
    pub fn read_bytes(&self, rel: &str) -> Result<Vec<u8>, PluginError>;
    pub fn list(&self, rel: &str) -> Result<Vec<String>, PluginError>;
}
```

选 TOML 的理由：用户手编配置需要注释；`toml_edit` 使插件写回时不毁用户注释。settings 与 config 的取舍指引：简单标量优先 settings（有 GUI、有类型声明）；结构化/高级配置走 config（无 UI，设置中心可提供只读"高级编辑器"入口）。

文件系统访问统一为 `FsHandle`：manifest 声明标准目录作用域（`"fs:dir:documents/LiteNotes"`，作用域枚举 documents/downloads/pictures/music/videos/desktop/home/appdata/plugindata），运行时经 `DialogHandle.pickDir()` 获得的用户选择同样落为持久化授权作用域。两条路最终都收敛为"带根的路径句柄"，插件无法表达作用域之外的路径。

### 4.4 生命周期与启用/禁用

```
宿主启动 → 扫描注册表(编译期清单 / 二期插件目录)
        → 读 app_settings 中 plugin.<id>.enabled（默认 true）
        → 对启用者构造门控 PluginContext → init()
        → 前端启动时 plugin_list() 拉取启用插件，按需懒加载视图组件
禁用    → plugin_set_enabled(false)：shutdown() + 前端注销 trigger/provider + 托盘提示
```

禁用状态持久化在核心库 `app_settings`，数据不删（插件库文件保留），可随时重新启用。

### 4.5 框架服务目录（Service Catalog）

插件的一切能力都来自下表句柄；宿主按 manifest 权限注入，未声明即 `None`。除标注二期外均在一期（M1–M5）落地。

| 服务 | 句柄 | 权限 | 阶段 | 能力与要点 |
|---|---|---|---|---|
| 插件库 | `ctx.db` | `db` | M1 | 独立 SQLite，隔离规范见 §4.3.1 |
| 设置 KV | `ctx.settings` | `settings` | M1 | `${pluginId}.` 前缀隔离；manifest 声明自动渲染进设置中心 |
| 窗口 | `ctx.windows` | `windows` | M1 | 唯一合法开窗途径：`open(viewId, params)`，manifest 声明视图元数据 |
| 通知 | `ctx.notify` | `notifications` | M1 | 系统通知（tauri-plugin-notification） |
| 调度 | `ctx.scheduler` | `scheduler` | M3 | `register_tick(secs)` / `register_at(ts)`，到期回调进插件 |
| 使用历史 | `ctx.history` | — | M1 | 记录本插件指令使用频次（只写，供空态推荐） |
| 环境变量 | `ctx.env` | `env:<NAME>` 逐名 | M4 | 白名单 + 启动快照（§4.3.2） |
| 配置文件 | `ctx.config` | — | M5 | TOML 热重载，注释保留（§4.3.3） |
| 包内资源 | `ctx.resources` | — | M5 | 插件包 assets/ 只读 |
| 标准路径 | `ctx.paths` / `ctx.meta` | — | M1 | 目录解析；平台/版本信息，取代 UA 嗅探 |
| 日志 | `ctx.log` | — | M1 | 每插件独立日志文件，容量轮转，插件管理页可查看 |
| 文件系统 | `ctx.fs` | `fs:dir:<scope>` | M3 | 声明式作用域 + dialog 运行时授权，带根路径句柄（§4.3.3） |
| 对话框 | `ctx.dialog` | — | M3 | 文件/目录选择（选择即授权）、确认框 |
| 进程 | `ctx.process` | `process` | M4 | spawn/kill、stdout/stderr 事件流、exit 回调（apps 启动执行体） |
| 打开器 | `ctx.opener` | `opener` | M4 | URL/文件/所在目录 → 系统默认程序；与 process 分离授权（风险更低） |
| 剪贴板 | `ctx.clipboard` | `clipboard:write` / `:read` | M5 | 粘贴即搜、复制结果；read 敏感单独授权 |
| 共享索引 | `ctx.index` | — | M5 | `put/remove/clear` 条目进核心 FTS（按插件命名空间），自动参与裸文本全局搜索，选中路由回该插件 onSelect —— 轻插件零后端接入搜索的主通道 |
| HTTP | `ctx.http` | `net:<host>` 白名单 | M7 | 宿主代理 fetch（流式支持），可审计可限流；LLP 插件无裸 socket |
| 密钥库 | `ctx.secrets` | `secret:read:<key>` | M7 | keyring/系统凭据库；设置中心提供核心托管的密钥录入页 |
| 事件总线 | `ctx.bus` | topic 约定 | M6 | 跨插件 pub/sub：`plugin.<id>.<topic>` + 核心标准主题（theme/app.launched/scheduler.tick）；发布方自愿，不破坏数据隔离 |
| 全局热键 | `ctx.shortcuts` | `shortcut:<accel>` | M6 | 插件注册全局热键（如 todo 快速捕获），宿主登记仲裁冲突 |

明确**不提供**（防滥用）：任意路径文件读写（只给作用域句柄）、原始 socket、读取其他插件库/设置、直接操作托盘/主窗口生命周期、`env:*` 通配。

### 4.6 纯前端插件与宿主内置服务方法

`"backend": { "kind": "none" }` 的插件没有 Rust crate：其 `ctx.call()` 的保留方法 `svc:*`（`svc.settings.get`、`svc.index.put`、`svc.clipboard.write`、`svc.dialog.pickDir`、`svc.log.info` 等）由**宿主直接应答**，frontend SDK 将 settings/index/toast/dialog/clipboard/log 封装为同名属性。书签、剪贴板历史、单位换算这类插件由此成为"单文件 TS + manifest"的形态——脚手架默认生成此形态，这是"快速扩展"目标的最短路径。带后端插件同样可用 `svc:*`（走同一分发器），保证两种形态 API 完全一致。

---

## 5. 三个插件的剥离设计

### 5.1 目标目录结构（cargo workspace + npm workspaces）

```
LiteLauncher/
├─ Cargo.toml                     # [workspace] members = core/src-tauri, plugins/*/be
├─ package.json                   # workspaces: core/shell, plugins/*/fe
├─ core/
│  ├─ shell/                      # 前端壳层包 @ll/shell
│  │  └─ src/{components,core,lps,services,styles}/
│  └─ src-tauri/
│     ├─ src/main.rs              # 薄入口
│     ├─ crates/
│     │  ├─ ll-plugin-api/        # §4.3 的 trait（Rust 标准唯一源）
│     │  ├─ ll-services/          # db/window/notify/scheduler/settings/history/secret
│     │  ├─ ll-host/              # 注册表+分发+权限+（二期）LLP 适配
│     │  └─ ll-kernel/            # builder/托盘/热键/窗口事件
│     └─ tauri.conf.json
├─ plugins/
│  ├─ todo/    ├─ manifest.json ├─ fe/（todoPlugin + TodoManager + ReminderToast + 样式）└─ be/（todo.rs+reminder.rs 逻辑）
│  ├─ notes/   ├─ manifest.json ├─ fe/（notesPlugin + NoteEditor）└─ be/（notes.rs）
│  └─ apps/    ├─ manifest.json ├─ fe/（appPlugin + searchProviders）└─ be/（app_launcher.rs+system_apps.rs）
├─ tools/create-plugin/           # 脚手架：生成上述骨架
└─ docs/
```

前端注册中心：构建脚本扫描 `plugins/*/fe` 生成 `plugins.generated.ts`（import + definePlugin 调用），新增插件目录后重新构建即接入，壳层源码零改动。

### 5.2 apps 插件

- 迁入：`app_launcher.rs`、`system_apps.rs` → `plugins/apps/be`；`appPlugin.ts` → `plugins/apps/fe`。
- 权限：`db` + `shell` + `windows`（无独立窗口，可省）。
- 剥离 App.tsx 裸文本逻辑：三个 SearchProvider（local/cli/web），priority 10/20/90；`handleSelectItem` 的四个特判全部删除，选中行为由 provider 产出的 item 走 apps 插件注册的 `onSelect`（PanelItem.metadata 保留，但语义收敛进插件）。
- 预置应用表（db.rs:99-147 的平台差异数据）随插件库迁移，属插件自带种子数据。

### 5.3 todo 插件（剥离最深）

- 迁入：`todo.rs`（506 行，含单测）、`reminder.rs` 的扫描/弹窗逻辑 → `plugins/todo/be`；`todoPlugin.ts`、`TodoManager.tsx`、`ReminderToast.tsx`、`todoapp.css`、`reminder.css` → `plugins/todo/fe`。
- **调度去耦**：内核不再 spawn `reminder::spawn_reminder_scheduler`（lib.rs:174）。改为 todo 插件 `init()` 时 `ctx.scheduler.register_tick(20)`，在 `on_core_event(SchedulerTick)` 中扫描到期待办；到期后 `ctx.notify.send()` + `ctx.windows.open('popup', {id, content})`。`reminder.rs` 对 `notes::urlencoding_simple` 的依赖改为插件内私有函数。
- **语法解析去耦**：`extractTimeAndRule`（tokenizer.ts:60+）迁入插件 `enrichParsed`，core/tokenizer 保留通用分词。
- 弹窗时长设置 `popup_auto_close_secs` 从 reminder.rs 迁为 manifest `settings` 声明，渲染进设置中心的 todo 分区。

### 5.4 notes 插件

- 迁入：`notes.rs`（FTS 索引/读写/编辑器窗口）→ `plugins/notes/be`；`notesPlugin.ts`、`NoteEditor.tsx` → `plugins/notes/fe`。
- 权限：`db` + `fs:scoped(LiteNotes 目录)` + `windows`。
- 编辑器窗口改走 `ctx.windows.open('editor', {path, title})`；`urlencoding_simple` 留在插件内私有。
- 首次运行的欢迎笔记种子逻辑随插件迁移。

### 5.5 数据迁移（一次性、幂等）

启动时迁移器检测旧 `litelauncher.db`：

```
todos, note_index, note_fts          → plugins/todo/todo.db、plugins/notes/notes.db
app_shortcuts                        → plugins/apps/apps.db
command_history, app_settings        → 保留核心 core.db（settings 中插件键重写加前缀）
旧库重命名 litelauncher.db.bak-YYYYMMDD，写迁移日志；已迁移则跳过
```

### 5.6 剥离后的核心（不变量）

壳层 App.tsx 只剩：焦点/高度/键盘状态机、解析器驱动、视图路由表分发、计算器、历史推荐、Toast。后端 lib.rs 只剩：托盘/热键/主窗口事件 + `generate_handler![...9 个核心与通用通道命令]`。两者都不再出现 `todo/notes/app` 字样——这是验收标准，可用 grep 落成 CI 检查。

---

## 6. AI 插件预留（三期，接口现在定死）

AI 不需要内核改动，这正是本架构的验收场景。设计两个挂点：

1. **命令插件**：`/ai <prompt>`，Action 模式 + 流式结果视图（新 view `chat`）。后端 provider 经 `ctx` 发 `plugin_event({event:'delta', payload})`，前端 `ctx.on('delta')` 增量渲染。
2. **SuggestProvider（新增可选扩展点，二期随 LLP 定义）**：在任意指令输入时提供智能候选增强，宿主以低优先级只读方式调用，失败静默。

安全边界：

- manifest：`"permissions": ["net:api.openai.com", "secret:read:ai.openai.key"]`（net 为域名白名单粒度）。
- API Key 存核心 SecretStore（keyring crate / 系统凭据库），插件只能经 `ctx.secrets.get` 取脱敏句柄发起请求，**密钥永不落插件库、不进插件进程可读的明文配置**；设置中心提供核心托管的密钥录入页。
- 网络访问由宿主代理执行（LLP 形态下插件进程无直连网络能力），便于审计与限流。

---

## 7. 二期：外部进程插件（LLP/1 协议，概要）

- 形态：`~/.litelauncher/plugins/<id>/`（manifest + 前端 dist + 可执行 sidecar，任意语言实现）。
- 协议：stdin/stdout 上的 JSON-RPC 2.0。宿主→插件：`init/manifest/call/core_event/shutdown`；插件→宿主（反向请求）：`svc.db/exec`、`svc.window.open`、`svc.notify`、`svc.secret.get`——**外部插件没有 Tauri 句柄，一切能力经宿主代理并受权限约束**。
- UI：插件前端以 sandbox iframe 承载，经 `postMessage` 桥（ll-bridge）与宿主通信，样式令牌（主题色/字号）由宿主注入；复杂视图仍建议声明式 JSON 表单优先。
- 安装即声明权限清单 → 用户确认弹窗（对标浏览器扩展）。签名与分发（本地目录 / 未来 registry）另立文档。

一期不做 LLP，但 §4 的统一通道已保证：内置插件换成 LLP 形态时，前端代码零改动。

---

## 8. 实施路线图（每步可独立验收、全程保持绿色构建）

| 阶段 | 内容 | 验收标准 | 预估 |
|---|---|---|---|
| M1 通道落地 | ll-plugin-api / ll-host / plugin_call 三命令上线；todo.rs 原地实现 trait（暂不挪目录）；lib.rs 去掉 todo 相关静态命令 | `/todo` 全功能经新通道工作，CI grep lib.rs 无 todo 命令 | 2 天 |
| M2 契约净化 | 前端 PluginContext；onSelect 返回 AfterSelect；enrichParsed 迁移时间解析；App.tsx 删插件 id 特判 | App.tsx 与 plugins/ 互不出现对方专有名词（grep 检查） | 2 天 |
| M3 数据与调度 | db 拆分 + 迁移器；SchedulerService；reminder 归 todo；WindowService 统一开窗 | 旧库自动迁移后提醒/待办/笔记/应用数据完好；popup/editor/todoapp 窗口经服务开启 | 3 天 |
| M4 三插件剥净 | apps/notes 同步剥离；SearchProvider 替换裸文本兜底；视图路由表替换 ?view= if-else | §5.6 不变量成立 | 2 天 |
| M5 工程化归位 | cargo/npm workspace 拆包；plugins.generated.ts；/plugins 管理页（列表/开关/权限展示）；create-plugin 脚手架 | 用脚手架 10 分钟产出可运行空插件并出现在 /help | 3 天 |
| M6 LLP 宿主（二期） | 外部进程协议、iframe 桥、安装确认 | 官方示例外部插件（如 weather）跑通全链路 | 5–8 天 |
| M7 AI 插件（三期） | SecretStore、net 代理、/ai 流式、（可选）SuggestProvider | /ai 对话可用，密钥不出核心 | 3–5 天 |

顺序理由：M1/M2 先立标准再搬家（避免边搬边改契约）；M3 最深耦合（调度+数据）单独成步；apps 虽然最简单，但牵动 App.tsx 最多，放在壳层已被 M2 净化之后。

## 9. 测试与守护

- **契约测试**：ll-plugin-api 附带 mock PluginContext，对每个内置插件跑「manifest 声明的 method 全集调用」冒烟；前端 `@ll/test-harness` 提供 fake ctx（现各插件浏览器回退数据升级为 fixture）。
- **单元测试**：todo.rs 内 3 个 `next_occurrence` 单测随 crate 迁移；迁移器对合成旧库做金样本测试。
- **CI 守护**：grep 检查——lib.rs/App.tsx 中不得出现 `todo|notes|app_launcher|system_apps|NoteEditor|TodoManager` 等插件专名；插件 crate 之间不得互相依赖。
- **GUI 冒烟**：沿用现有构建+启动+生命周期日志的模式，每阶段跑一次 /todo /note /app 全操作过一遍。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| plugin_call 失去编译期命令检查 | 契约测试 + method 名集中常量（前后端共享命名表）|
| 单库拆多库后列表查询变慢 | 各插件数据本就无跨表 join；SQLite 独立文件反而减锁竞争；列表场景均有索引 |
| 迁移器在异常旧库上失败 | 迁移前整库文件备份 + 逐表 try/日志 + 失败保留旧库原路径并降级只读提示 |
| Tauri 事件通道被插件滥用刷屏 | 宿主侧限流（每插件事件速率上限）|
| 二期 LLP 进程崩溃拖累启动器 | 子进程崩溃只影响该插件（标记 disabled + 提示），宿主进程隔离 |
| Windows 路径/权限差异（现有 build.cmd 链路） | 迁移器与 db 路径全部走 dirs crate 现有约定，保持 cross-build 脚本不变 |

## 11. 非目标（本期明确不做）

- 插件市场/在线分发与签名体系（随二期另立设计）。
- 跨插件直接调用（"AI 总结待办"等场景二期经宿主中转 API 支持）。
- 主题系统插件化、多语言框架（与插件化正交，另行演进）。

## 12. 性能分析与预算

### 12.1 开销量化（编译期插件形态）

| 环节 | 变化 | 开销量级 | 判定 |
|---|---|---|---|
| IPC 分发 | 直连命令 → `plugin_call`（HashMap 查插件 + 方法分发 + dyn 调用） | ~1–10μs，对比 IPC 基线 0.1–1ms（<1%） | 无感 |
| 参数序列化 | 类型化参数 → `serde_json::Value` 直通 + 插件内 `from_value`（树节点搬运，非重解析） | 微秒级 | 无感 |
| 权限门控 | SQL 语句头检查、句柄注入 | 亚微秒，对比 SQL 执行 10μs+ | 无感 |
| 调度器 | 内核线程 → SchedulerService tick 回调 | 同为 20s 节拍，线程模型不变 | 无感 |

**反而变好的两处**：

1. **数据库全局锁消除**：现状 `DbState(Mutex<Connection>)` 是全应用唯一串行点（提醒线程扫 todos 与笔记搜索互相阻塞）；每插件独立连接后竞争消失。
2. **主包减重**：现状四个重型视图组件（NoteEditor/TodoManager/ReminderToast/SettingsPanel）静态打进主 chunk；改造后按插件懒加载，仅开窗时取（本地毫秒级），主窗口启动路径更轻。

### 12.2 强制设计规则（防性能回归）

- **R1 按键扇出预算**：SearchProvider 聚合层强制 50ms debounce + 陈旧结果取消（泛化现 App.tsx staleness check）+ provider 并行执行（Promise.allSettled）+ 每轮超时预算，超时 provider 本轮丢弃并降权。
- **R2 并行懒初始化**：插件 init 并行执行；DbHandle 懒打开（首次访问才建连接），启动路径增量压回噪声级。
- **R3 大负载通道**：单次调用负载 > 64KB 的场景（如笔记全文）走 `plugin_event` 流式或分块，避免 Value 双重搬运放大。
- **R4 外部插件不进关键路径**：核心三插件永久编译期内置；LLP 插件懒启动（首次调用才 spawn），流式走事件通道；冷启动/常驻内存成本（~50–300ms / 30–100MB）由该形态自担。
- **R5 基准护栏**：CI 加两组对照——`plugin_call` vs 直连命令微基准（ overhead < 5% ）；击键到面板渲染 p95 不劣于改造前（录制基准基线）。

### 12.3 二期 LLP 的真实代价（接受并隔离）

stdio JSON-RPC 每往返 ~0.1–1ms、进程冷启动 50–300ms、常驻内存 30–100MB（Node）。这是换取进程隔离与第三方生态的明确对价，通过 R4 隔离在关键路径之外；交互类操作（毫秒级）用户无感，AI 流式场景本就适合事件通道。
