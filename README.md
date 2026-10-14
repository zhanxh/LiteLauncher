# ⚡ LiteLauncher (v3.0)

> **基于 Tauri 2 + SolidJS + SQLite (FTS5) 的下一代生产力启动器（Launcher）**
> **核心理念：** Command-First, Window-as-Context, Plugin-Driven

---

## 📖 架构概览

搜索框作为启动器的唯一交互入口，所有功能均降级为"插件/指令"，窗口从"固定面板"变为"按需弹出的上下文容器"。

```mermaid
flowchart TD
    A["全局快捷键 (Alt+Space / Alt+X)"] --> B["主搜索框 (居中/置顶/无边框)"]
    B --> C{"DSL 指令分词与解析器"}
    C -->|"Action 命令 (如 /todo new)"| D["实时语义胶囊 + 回车直接执行"]
    C -->|"Query 命令 (如 /note)"| E["展开结果面板"]
    C -->|"数学算式 (如 12 * 85)"| F["即时计算胶囊 + 回车复制"]
    C -->|"普通文本"| G["本地应用 / 系统命令 / 网络搜索"]
    E -->|"回车选择笔记"| H["弹出独立 Markdown 编辑窗口 (Ctrl+S 保存)"]
    E -->|"回车选择应用"| I["外部启动程序并自动隐藏启动器"]
    D --> J["SQLite 数据库持久化"]
    H --> K["磁盘原生 .md 文件"]
```

**进程模型**：单实例常驻（系统托盘），关闭窗口仅隐藏、退出走托盘菜单"退出"。主窗口按内容高度动态伸缩（70px 搜索条 ↔ 最多 640px 面板），失焦自动隐藏（带 1.5s 启动保护期）。

---

## ⌨️ 快捷键速查

| 快捷键 | 作用范围 | 功能说明 |
| :--- | :--- | :--- |
| **`Alt + Space`** | 全局 | 唤起 / 隐藏 LiteLauncher 主搜索框 |
| **`Alt + X`** | 全局 | 备选热键（系统 Alt+Space 被占用时的容错方案） |
| **`Enter` (回车)** | 主搜索框 | 执行即时命令 / 补全候选指令 / 选择当前高亮项 |
| **`Esc`** | 主搜索框 | 若有文本优先清空；文本为空时隐藏主窗口 |
| **`Esc`** | 笔记编辑器 | 关闭编辑器窗口 |
| **`↑ / ↓`** | 结果面板 | 在列表项之间快速切换选择高亮 |
| **`Ctrl + S`** | 独立编辑器 | 立即保存当前 Markdown 文件并增量更新 SQLite 索引 |
| **`F12`** | 任意窗口 | 打开 / 关闭 DevTools（开发调试用） |

---

## 🚀 指令系统

### 1. 应用启动 (`/app`)
- **Query 模式**：输入 `/app` 或 `/app [关键字]` 过滤系统应用，敲击回车直接唤起程序并自动隐藏启动器。
- **Action 模式**：输入 `/app add "应用名称" "可执行路径"`，实时预览胶囊，回车持久化保存至捷径库。
- **拼音简写**：支持直接输入 `jsq`（计算器）、`jsb`（记事本）智能推荐。

### 2. 待办日程 (`/todo`)
- **Action 即时添加**：
  - `/todo new "下午技术周会" 14:30` → 今天 14:30 提醒（该时刻已过则顺延至明天）。
  - `/todo new "项目评审" 2026-10-11 14:30` → 指定日期+时间的精确提醒。
  - `/todo new "周报撰写" 2026-10-12` → 指定日期，当天 09:00 提醒。
  - 提醒时间在保存时校验并规范化，过去的时间会给出明确错误提示。
  - 到点双通道提醒：**桌面右下角弹窗**（应用自绘，无边框置顶、不抢焦点，点击关闭或超时自动消失）+ **系统级通知**（进入通知中心留存历史），主窗口隐藏时依然有效。
  - 实时解析出内容与提醒标签，敲击回车直接写入 SQLite，Toast 提示并清空输入框。
- **间隔重复提醒**：
  - `/todo new "喝水" 15:00 every:30min` → 每 30 分钟提醒一次。
  - 支持 `every:Nmin / Nh / Nd / Nw / Nmo`（分钟/小时/天/周/月，月度按日历推进，月末自动安全进位）。
  - 关键词：`daily`（每天）、`weekly`（每周）、`mon`..`sun`（每周指定星期）。
  - 触发后自动重排到下一次时间；已完成的待办不再触发。
- **Query 列表管理**：
  - 输入 `/todo` 展开待办列表（未完成置顶），回车一键切换已完成/待办状态。
  - 已完成的待办不再触发提醒。
- **管理面板 (`/todo app`)**：
  - 打开独立待办管理窗口：未完成/已完成分区展示，支持编辑内容与提醒时间、一键切换完成状态、删除、快速添加。
  - 设置面板可配置弹窗提醒显示时长（5-300 秒），并提供"测试弹窗"即时预览。

### 5. 应用设置 (`/setting`)
- **皮肤切换**：亮色 / 暗色主题一键切换，立即生效并同步到所有窗口（启动器、笔记编辑器、待办面板、提醒弹窗、设置面板），选择持久化保存。
- **版本信息**：应用版本、运行平台与架构、数据目录位置。
- 窗口可通过 `✕ 关闭` 按钮或窗口右上角关闭按钮关闭（应用保留托盘常驻）。

### 3. Markdown 笔记 (`/note`)
- **文件原生优先**：
  - 默认管理目录：`%USERPROFILE%\Documents\LiteNotes`。
  - 启动时自动增量比对文件 `mtime`，提取标题与纯文本摘要写入 SQLite FTS5 全文索引库。
  - 数据库不存储正文，正文始终为磁盘原生文件。
- **双窗口协作**：
  - 输入 `/note [关键字]` 极速全文检索与摘要高亮。
  - 敲击回车弹出独立 Markdown 编辑器窗口（双栏编辑实时预览、`Ctrl+S` 原生保存、`Esc` 关闭）。
  - 编辑器窗口按文件路径去重：同一篇笔记重复打开只会聚焦既有窗口。

### 4. 辅助指令与计算
- **帮助指南**：`/help` 查看所有已注册指令与语法。
- **实时计算器**：输入任意算术表达式（如 `12 * 85 + 3.14`），实时展现计算结果，回车一键复制。
- **无斜杠直达**：输入 `todo`、`note`、`app` 自动智能映射到对应指令。
- **模糊容错**：输入 `/not`、`/notes` 等前缀会推荐 `/note` 候选，回车一键补全。

---

## 🧩 插件体系

LiteLauncher 遵循**"一切皆插件"**：功能不硬编码进壳层，一律以插件形态接入。按落地形态分三类，三者共用同一注册表、同一 IPC 通道（`plugin_call`）与同一份能力集合，**壳层对它们零特判**。

| 形态 | `backend.kind` | 代码位置 | 运行时依赖 | 重编译主程序 | 典型场景 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 编译期插件 | `builtin`（默认） | `plugins/<id>/{be,fe}` | 无 | 需要 | 需自定义窗口 / 高频核心：`todo` `apps` `notes` `ai` |
| 外部插件（LLP/1） | `llp` | `plugins/<id>/{manifest.json, 脚本}` | 任意语言运行时（Python 等） | 不需要，拷目录即装 | 依赖系统命令 / 平台探测：`sysinfo` |
| **纯前端插件** | `none` | `plugins/<id>/{manifest.json, fe/}` | **无** | 不需要 | 纯计算 / 文本 / 换算类小工具 |

### ✨ 纯前端插件（`backend.kind = "none"`）

没有 Rust crate、也没有 sidecar——**全部逻辑就是一个 TS 文件**（`fe/src/index.ts` + `fe/package.json`），随前端包编译进应用。插件的能力来自**宿主保留方法名空间 `svc.*`**，由宿主直接应答（不是插件自己的后端）：

| 方法 | 权限（manifest `permissions`） |
| :--- | :--- |
| `svc.settings.get` / `set` | —（宿主强制 `${pluginId}.` 前缀隔离） |
| `svc.clipboard.write` / `read` | `clipboard:write` / `clipboard:read` |
| `svc.db.migrate` / `execute` / `query` | `db`（migrate 仅 DDL，execute 仅 DML，query 仅 SELECT） |
| `svc.http.send` | `net:<host>` 域名白名单 |
| `svc.notify.send` | `notifications` |
| `svc.events.emit` | —（前端按 pluginId 过滤） |
| `svc.process.launch` | `process` |
| `svc.log.write` | — |
| `svc.screen.list` / `cursor` / `pixel` / `capture` | `screen`（截图与取色） |
| `svc.shortcut.register` / `unregister` / `list` | `shortcut:<accel>`（逐条声明、**无通配**） |
| `svc.window.open` | `windows`（只能打开 manifest `views` 里声明过的视图） |

前端 SDK 把这些封装成同名属性，写起来就是普通方法调用：

```ts
const ctx = getPluginContext('myplug');
await ctx.clipboard.write('复制这段');        // → svc.clipboard.write
await ctx.settings.setJson('items', [...]);  // → svc.settings.set（自动 JSON 序列化）
const data = await ctx.http.json<T>(url);    // → svc.http.send（需 manifest 声明 net:<host>）

const shot = await ctx.screen.capture({ monitor: -1, hideWindows: true, delayMs: 3000 });
const { sample } = await ctx.screen.pixel({ radius: 7 });  // 取光标处颜色 + 放大镜方格
await ctx.windows.open('panel', { id: '1' });             // 打开本插件声明的视图窗口

await ctx.shortcuts.register('alt+p');                    // manifest 需声明 shortcut:alt+p
await ctx.shortcuts.on('alt+p', () => { /* 任意界面按下都会到这里 */ });
```

### 已实现插件

**纯前端 · 纯计算工具（`kind: none`，零依赖、零重编译）· 8 个**

| 指令 | 名称 | 说明 |
| :--- | :--- | :--- |
| `/text` | 文本处理 | 大小写、反转、snake/kebab/camel/pascal/title、去空白 + 字符/词/字节统计 |
| `/json` | JSON 工具 | 美化 / 压缩 / 转义 / 结构摘要，解析失败给出错误信息 |
| `/rand` | 随机生成 | uuid / str / num / coin / dice / pick |
| `/ts` | 时间戳转换 | 时间戳 ↔ 日期，自动识别秒/毫秒/微秒/纳秒，含相对时间 |
| `/unit` | 单位换算 | 长度/质量/面积/数据/速度/时间/温度 + `hex/bin/oct/dec` 进制转换 |
| `/color` | 颜色转换 | HEX / RGB(A) / HSL(A) / HSV / 互补色 / Alpha |
| `/regex` | 正则测试 | 常用正则速查；表达式校验；样本文本匹配与分组 |
| `/qr` | 二维码 | 生成二维码并在浏览器打开（联网取图；演示 `svc.process.launch`） |

**纯前端 · 网络类（`kind: none` + `net:<host>` 白名单，免密公共 API）· 5 个**

| 指令 | 名称 | 说明 |
| :--- | :--- | :--- |
| `/weather` | 天气查询 | `/weather 北京` 实况 + 今日预报，英文天气词自动映射为中文（数据源 wttr.in） |
| `/fx` | 汇率换算 | `/fx 100 usd cny` 精确换算、`/fx usd cny` 看汇率、`/fx usd` 列主要货币（数据源 open.er-api.com） |
| `/ip` | IP 查询 | `/ip` 本机公网 IP 与归属地，`/ip 8.8.8.8` 查指定 IP 的运营商/ASN/时区（数据源 ipwho.is） |
| `/dict` | 英文词典 | `/dict hello` 音标、词性、释义、例句，回车打开发音（数据源 dictionaryapi.dev） |
| `/tr` | 翻译 | `/tr hello world` 自动中英互译，`/tr en ja hello` 指定语言对（数据源 MyMemory，有每日额度） |

> **网络插件范式（重要）**：壳层对 `query()` 是**逐键调用且无防抖**的，所以网络类插件**绝不在 `query` 里发请求**——输入时只渲染一个「查询」项，真正的抓取发生在**用户回车**时（`onSelect`），结果按输入缓存（TTL 5–30 分钟），抓取完成后返回 `refresh` 让面板就地刷新。这样既不会边打字边打 API，也不引入防抖竞态。

**纯前端 · 桌面能力（`kind: none` + `screen` / `shortcut:<accel>`）· 2 个**

截图与取色都不需要任何平台代码——抓屏、多屏定位、窗口避让、PNG 落盘全在宿主（D 组能力包，见 `docs/plugin-roadmap.md` §11）。

| 指令 | 名称 | 说明 |
| :--- | :--- | :--- |
| `/shot` | 屏幕截图 | 回车截取光标所在屏幕（截前自动隐藏 LiteLauncher）、`/shot 2` 指定显示器、`/shot -d3` 延时 3 秒；完成后路径进剪贴板，面板出现「用系统查看器打开 / 打开所在文件夹 / 复制路径」。**全局热键 `alt+shift+s`** 免开启动器直接截图，结果以系统通知反馈 |
| `/pick` | 取色器 | **全局热键 `alt+p`** 取光标处像素 → HEX 进剪贴板 + 通知；`/pick` 另有「取光标处颜色」「打开浮动取色台」「最近取色（HEX/RGB/HSL 可切换复制）」「清空历史」。取色台是声明式视图窗口：放大镜实时跟随鼠标，**鼠标移入面板即冻结**（否则会采到面板自己的颜色），点按钮复制 |

> **全局热键协议**：manifest 以 `shortcut:<accel>` 逐条声明（无通配），宿主登记并**仲裁冲突**（同一加速键先到先得），触发时广播 `plugin-shortcut` 事件，插件用 `ctx.shortcuts.on(accel, cb)` 接收——插件拿不到原始按键流。`on()` 默认只在**主窗口**生效（每次窗口加载都会跑一遍全部插件的 `setup`，不区分就会重复触发）；取色台这类需要在视图窗口内响应热键的场景显式传 `{ scope: 'any' }`。

**外部插件（LLP/1，Python sidecar）· 12 个**

*算法密集或依赖 Python 标准库的仍走 LLP*：

| 指令 | 名称 | 说明 |
| :--- | :--- | :--- |
| `/hash` | 哈希与编码 | md5/sha1/sha256/sha512/base64/url/html/crc32；`/hash md5 文本` 或 `/hash 文本` |
| `/cron` | Cron 解析 | 5 段表达式 → 人类可读描述 + 未来 5 次触发时间 |
| `/cidr` | 网段计算 | 网络/广播/掩码/可用范围/主机数，支持 IPv6 与子网拆分 |
| `/bookmark` | 书签收藏 | `add "标题" URL` / `del 序号`；回车在浏览器打开 |
| `/snip` | 文本片段 | 常用短语存取，回车即复制 |
| `/pwd` | 密码生成器 | `/pwd 24`、`easy`、`nosym`；含 PIN 与记忆短语 |
| `/cost` | 快速记账 | `add 25 午餐`；今日/本月合计与分类汇总 |
| `/memo` | 备忘速记 | 速记与检索 |
| `/cheat` | 命令速查 | 内置 git/docker/k8s 等常用命令，可增删 |
| `/time` | 世界时钟 | 主要城市时间与时差 |
| `/pomo` | 番茄钟 | `/pomo start 25 写代码`，专注↔短休按 **5:1** 交替；到点发系统通知并自动接下一段，`/pomo auto off` 改为每段结束等人工点挂件的 ▶；`/pomo pin` 可贴到壁纸层 |
| `/sysinfo` | 系统信息 | 平台/CPU/内存/磁盘探测 |

> 所有"回车复制"依赖壳层的通用 `AfterSelect.copy` 能力（工具类插件的标准交互），落点为**宿主原生剪贴板**（`clipboard_write`），而非 webview 的 `navigator.clipboard`——后者在窗口即将隐藏时会被浏览器策略拒绝。

### 安装与卸载

```bash
# 安装全部外部插件到用户目录（~/.local/share/LiteLauncher/extplugins/）
npm run plugin:install

# 只装一个 / 装成便携版（随 release/ 一起分发）
npm run plugin:install -- hash
npm run plugin:install -- --all --portable

# 卸载：删除对应插件目录即可
```

> - 纯前端插件（`kind: none`）的代码已编译进应用包，安装时**只部署 `manifest.json`**——宿主据此注册插件，权限门控与设置面板的启用/禁用都依赖它。开发期宿主会自动扫描仓库 `plugins/`，无需安装。
> - ⚠️ LLP 插件需要目标机器有对应运行时（Python 插件需 Python 3）。宿主按 **设置 → Python 环境** → `LLP_PYTHON` 环境变量 → `PATH` → 注册表 → 常见安装位置 的顺序自动探测，可在设置面板手动指定。

### 开发与测试

```bash
# LLP 插件冒烟测试：逐个走一遍 initialize/search/execute 协议
npm run plugin:test        # 可用 LLP_PYTHON 指定解释器

# 纯前端插件测试：Node 里直跑插件逻辑，断言真实计算结果（不启动 Tauri）
npm run plugin:test:fe
```

---

## 🛠️ 本地开发与构建

### 1. 环境准备
- **Node.js**：`v24+`
- **Rust**：`1.99+`（stable）
- **Windows 构建工具**：二选一
  - MSVC 工具链：Visual Studio 2022 C++ 构建工具（官方默认路径），或
  - GNU 工具链：`rustup default stable-x86_64-pc-windows-gnu` + 完整 MinGW binutils/gcc（无需管理员权限）

### 2. 启动开发模式
```powershell
# 启动 Tauri 开发调试服务器（前端 Vite + Rust 增量编译）
npm run tauri dev
```

### 3. 构建与发布

**日常构建**（改完代码验证效果，用 `Cargo.toml` 里的快速档）：
```powershell
# 前端打包 + Rust release 编译 + 拷贝到 release\LiteLauncher.exe
build.cmd

# 等价的显式命令
npm run build
npx tauri build --no-bundle
copy /Y src-tauri\target\release\LiteLauncher.exe release\LiteLauncher.exe
```

**正式发布**（对外分发的那个包，唯一需要 `ship` 的场合）：
```powershell
build.cmd ship
```
`ship` 只改变 Rust 侧的优化档（fat LTO + 单 codegen unit，经 `CARGO_PROFILE_RELEASE_*`
环境变量覆盖 `Cargo.toml`，不需要手改文件），前端构建与便携插件部署步骤完全一致；
产物同样拷到 `release\LiteLauncher.exe`，后续校验/分发流程不变。
它把这类包编到独立的 `src-tauri\target-ship\` 目录，所以发版之后日常那份增量
缓存不会被换档作废（代价：首次 ship 会在新目录重编一遍全部依赖，多占约 8~9G）。

> **判据一句话**：自己看效果 → `build.cmd`；要发给别人的那个 exe → `build.cmd ship`。
>
> **为什么日常档不是最优化档**（`Cargo.toml` 的 `[profile.release]`）：
> `lto = true` + `codegen-units = 1` 只影响最后两个编译单元（ll-host 与 tauri-app），
> 却占了整场构建的绝大部分时间——前者要在链接期把上游所有 rlib 的 LLVM IR
> 合并重优化（无法并行），后者取消了 crate 内的并行编译。日常改成
> `lto = "thin"` + `codegen-units = 4`，发版用 `build.cmd ship` 拿回全部优化。

> ⚠️ **注意**：请使用 `npx tauri build`（或 `build.cmd`）打包，不要直接用 `cargo build --release`。
> 后者不会启用 `custom-protocol` 特性，产出的 exe 会去连 `localhost:1420` dev server，导致窗口白屏或"localhost 拒绝连接"。

### 4. 排障日志
- `lifecycle.log`：生成在 exe 同目录，记录窗口事件、IPC 调用与前端 console 转发，排障首选。

---

## 📦 技术栈

| 层 | 技术 | 说明 |
| :--- | :--- | :--- |
| 桌面框架 | Tauri 2 | 无边框窗口、系统托盘、全局快捷键、多窗口 |
| 前端 | SolidJS + TypeScript + Vite | 响应式 UI，无虚拟 DOM |
| 后端 | Rust + rusqlite (bundled) | SQLite + FTS5 全文索引 |
| 存储 | 磁盘原生文件 + SQLite | 笔记正文永在磁盘，库只存索引 |

---

## 📄 License

MIT
