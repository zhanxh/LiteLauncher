# LiteLauncher 项目长期约定

## 核心原则
- **一切皆插件**：功能不得硬编码进壳层/宿主，一律以插件形态接入。用户对"内置"措辞敏感——不要把它当作"把逻辑写进壳层"的选项。
- 术语坑：仓库文档里的**"编译期内置插件"**专指 `plugins/*/be`（随主程序编译、`lib.rs` 注册的 Rust 插件）。与用户口语的"内置"（=硬编码进宿主）是两回事。对外沟通统一说「编译期插件（Rust）vs 外部插件（LLP）vs 纯前端插件」。

## 插件形态（三者共通：同一注册表 + 同一 plugin_call + 同一份 svc.*）
| 形态 | backend.kind | 位置 | 依赖 | 重编译 |
|---|---|---|---|---|
| 编译期 | `builtin`（默认） | `plugins/<id>/{be,fe}` | 无 | 需要 |
| 外部 LLP/1 | `llp` | `plugins/<id>/{manifest.json, 脚本}` | 任意语言运行时 | 不需要，拷目录即装 |
| 纯前端 | `none` | `plugins/<id>/{manifest.json, fe/}` | 无 | 不需要 |

- LLP 的 `backend.entry` 可指向任意可执行文件（含 `node`、绝对路径）→ 外部插件也能用 Rust 独立二进制；"用 Rust" ≠ "编译进主程序"。
- 外部插件前端零代码：`src/core/externalPlugins.ts` 按 manifest `command` 声明自动生成通用 `CommandPlugin`；参数自动映射 execute→`{raw,subcommand,args,namedArgs}`、search→`{keyword,subcommand,args}`、select→`{id,metadata}`。
- 纯前端插件不适用自定义窗口；`/hash`（WebCrypto 无 MD5）、`/cron`、`/cidr` 这类算法密集/依赖运行时标准库的**留在 LLP 更划算**。

## 插件交互契约
- 面板项复制：插件的 `onSelect` 返回 `AfterSelect.copy`（壳层通用能力，壳层不理解插件语义）。落点是**宿主原生剪贴板命令 `clipboard_write`**，不用 `navigator.clipboard`（窗口隐藏时会被拒）。
- 面板项结构：`{id,title,description,badge,icon,metadata:{value}}`；`metadata.value` = 要复制的文本（约定俗成）。
- 纯前端插件逻辑只允许 import `@ll/sdk`（+ solid-js）。
- **网络类插件范式（必须遵守）**：壳层 `query()` 是**逐键调用且无防抖**的，**绝不能在 query 里发请求**。统一做法：query 命中缓存才渲染，否则只渲染一条「查询」项（`metadata.fetch`=缓存键）→ `onSelect(查询项)` 抓取 + 写缓存 + 返回 `{refresh:true}` → 壳层重跑 query 命中缓存刷新面板 → `onSelect(结果项)` 回 `{copy}`。缓存 TTL 5–30 分钟。参考 `plugins/{weather,fx,ip,dict,tr}`。
- HTTP 一律走 SDK 的 `ctx.http`（`svc.http.send` 的语法糖）：`send()→{status,body}` / `get()` / `json<T>()`；需按状态码分支时用 `send`。manifest 必须声明 `net:<host>`（逐域名精确匹配）。

## 宿主 svc.* 分发器（唯一入口）
`src-tauri/crates/ll-host/src/services.rs::dispatch_svc` —— LLP sidecar 的反向请求与前端 `ctx.call('svc.*')` **共用**。`commands.rs::plugin_call` 把 `svc.*` 当宿主保留方法名空间优先拦截。
方法集：`db.migrate|execute|query`、`clipboard.write|read`、`http.send`、`notify.send`、`process.launch`、`events.emit`、`settings.get|set`、`log.write`、`screen.list|cursor|pixel|capture`、`shortcut.register|unregister|list`、`window.open`。
权限门控：已注册插件按 `manifest.permissions`；未注册插件退回 `shell_safe_manifest`（仅 settings/clipboard:*/notifications/events）。**用到 db/process/net/screen/windows/shortcut 就必须把 manifest 部署到宿主可见目录**。

## 屏幕 / 热键能力（D 组，重要约定）
- **坐标一律桌面全局物理像素**（与 `getCurrentWindow().outerPosition()` 同系）。但 `xcap::Monitor::capture_region` 要**显示器内相对坐标（u32）**——宿主内部先命中测试定位显示器再减原点，这层换算不能散到插件。
- **`capture({monitor})`**：`-1`=光标所在屏、`0..n`=序号、缺省=主显示器。`hideWindows:true` 会先隐藏全部 LiteLauncher 窗口（+160ms 合成器宽限）再截、截完复原回焦。`delayMs` 宿主硬上限 10s。
- ⚠️ **`capture({region})` 返回的图已经就是选区本身**（宿主已裁好），下游（如标注层）直接 1:1 铺开即可，**不要再传/再算裁剪偏移**——多一层坐标系只会引入错位。
- **`screen.savePng(pngBase64, {toClipboard})`**：通用能力，"前端 Canvas 合成 → 宿主落盘/上剪贴板"。传 base64 而非字节数组（JSON 里字节数组会膨胀到百万级数字）；宿主容忍 `data:image/png;base64,` 前缀。
- ⚠️ **写图片剪贴板必须走 `clipboard:write` 门控**：`HostScreenApi.clipboard` 字段只在声明了 `clipboard:write` 时注入，否则 `screen` 权限会绕过剪贴板权限。
- `pixel({x?,y?,radius?})`：坐标缺省=当前光标；带 `radius` 时回 `#RRGGBB` 方格数组（**不是图片**，前端 CSS 网格铺成硬边放大镜）。总返回 `{sample, grid?}`。
- **全局热键**：manifest 以 `shortcut:<accel>` **逐条声明、无通配**；宿主进程级 `accel→pluginId` 表先到先得仲裁（冲突回 `conflict`）；触发广播 `plugin-shortcut` 事件 `{pluginId, accel}`，插件只听事件、拿不到按键流。
- **`ctx.shortcuts.on(accel, cb, {scope})` 默认 `scope:'main'`**：每个窗口加载都会跑一遍全部插件 `setup()`，不区分上下文热键会被执行两次。视图窗口内也要响应时显式传 `{scope:'any'}`。
- **新增视图窗口必须登记 Tauri 能力**：`src-tauri/capabilities/default.json` 的 `windows` 是显式标签白名单（标签 = `<pluginId>-<viewId>`）。漏登记 → 该窗口零权限 → `plugin_call` 被拒、窗口变死窗。
- 多窗口共用插件状态（如"面板开着时主窗口热键让位"）走 `ctx.settings` KV 做标记，不要靠全局变量。
- ⚠️ **Tauri 逻辑像素 vs 物理像素**：`Monitor::size()/position()` 给**物理**像素，而 `WebviewWindowBuilder::inner_size/position` 收**逻辑**像素。HiDPI 下必须除 `scaleFactor`，否则全屏遮罩只盖住屏幕一角。
- **热键"谁拥有"的唯一来源是插件自报 `CommandPlugin.hotkeys`**（不是读 manifest——注册表里没有 manifest，且 `shortcut:` 是静态白名单无法运行时追加）。**只在 `register()` 成功后收录**，否则 `/hotkey` 速查表会教用户按一个不生效的键。`/hotkey` 插件消费此字段。

## 插件交互字段（CommandPlugin 可选字段）
| 字段 | 作用 | 注意 |
|---|---|---|
| `queryDebounceMs` | 壳层等到停止输入才调 `query()` | 建议 250–350ms；纯计算插件**不要声明**。壳层用序号校验丢弃陈旧响应，离开指令模式时作废待触发定时器 |
| `argsHint` | 参数骨架（如 `[屏序号] [-d秒]`） | 只拼在候选面板**描述尾部**，**不塞进输入框**（塞进去用户还得手动删） |
| `examples` | 真实示例，`/help` 逐条渲染且**可被搜索** | — |
| `hotkeys` | 全局热键自报，供 `/hotkey` 汇总 | 见上节 |

## 壳层约定
- **剪贴板只有一个写入口** `applyCopy`（组件级，非 `handleSelectItem` 闭包）：优先宿主 `clipboard_write`（窗口隐藏时 webview 的 `navigator.clipboard` 会被策略拒绝），仅浏览器预览环境退回 `navigator.clipboard`。
- 面板"还有更多"提示用**实测溢出项数**（比对 `.panel-item` 的 `offsetTop+offsetHeight` 与视口底），**不要**用 `总数 - 页大小`——条目高度随 badge/描述行数变化，写死页大小会算错。
- CSS 变量真相源是 `plugins/ui/src/tokens.css`（**只有这里**）。浅色主题曾缺 `--accent-hint-border`，已补；写新样式前先查这个文件，别臆造变量名（不存在的变量会静默回退成透明/继承色）。

## 外部服务集成：`/find` 用 Everything SDK（已实测，勿再选型）
- **`/find` 走 Everything 官方 `Everything64.dll`（91KB，随 SDK 分发）**，不自己读 MFT/USN。实测 7~35ms，免管理员、免 NTFS 限制。
- 调用序列固定：`Reset → SetSearchW → SetMax → SetRequestFlags → QueryW(wait)`。**漏 Reset 会沿用上次搜索词**。
- ⚠️ **只能用 `GetResultFullPathNameW`**：`GetResultFileNameW` / `GetResultHighlightedFileNameW` 返回**垃圾内存**（走本地缓存、不支持 `(NULL,0)` 问长度），文件名从路径切、高亮名放弃。
- ⚠️ 请求标志位以 SDK `Everything.h` 为准：`FILE_NAME=1 / PATH=2 / SIZE=0x10 / DATE_MODIFIED=0x40 / ATTRIBUTES=0x100`。不设这组则 size/mtime 全0。
- ⚠️ mtime 是 **FILETIME（1601纪元）**不是 Unix；DLL 查找路径 `dirname(__file__)` 只退一层（退两层会跑到 `plugins/`）。
- ⚠️ **路径省略不能按字符硬切**（会砍掉半个目录名），按 `\` 分层保留头 2 + `...` + 尾 2。
- ⚠️ 排除项：Everything 的 HTTP/ETP 必须 GUI 手动勾选（改 ini 不生效）；裸 WM_COPYDATA 需自建 reply window。
- 落地为 **LLP 插件**（`plugins/find`），**宿主零新增能力**——sidecar 自己 `ctypes.LoadLibrary`。DLL 放 `plugins/find/bin/`，`plugin:install` 的 `cpSync recursive` 会带上。

## LLP 插件参数解析约定（踩过坑）
- 壳层 `queryText` = trigger 之后**所有 token 原样拼接**（含子命令）；`subcommand` = 第一个不以 `-` 开头的 token，会从 `args` 里挖走。故 **LLP 插件不能把 `args` 再拼回 keyword**（会重复）。
- 剥控制词（`desc`/`asc`/`limit`）不能简单删"词+后一个词"—— 字段名（size/dm/name）可能就是用户想搜的词。判定依据是**参数合法性**：未知字段时 `desc` 本身留在搜索词里。
- 外部插件（LLP）现已支持 `queryDebounceMs`：manifest `command.queryDebounceMs` → `ExternalCommandSpec.query_debounce_ms` → `plugin_list` → `externalPlugins.ts`。逐键打外部索引的插件必须声明。

## 测试约定
- 纯前端插件测试支持**包内相对导入**（`.ts` 递归转译；**`.tsx` 返回空模块**——solid JSX 需编译期）。故**可测的纯逻辑必须抽到 `.ts`**（如 `plugins/pick/fe/src/color.ts`），`.tsx` 只留渲染/轮询。
- 测试里 settings 桩是内存 KV，可验「写历史 → 刷新面板 → 复制」闭环；`svcCalls` 记录全部 `svc.*` 调用（含 clipboard.write / shortcut.register / window.open），可在 `after` 里断言行为。
- 用例钩子：`before`（预置桩状态，须早于首个 query）/ `after`（异步断言）/ `isolate`（跑用例前清空桩插件，只留被测插件——用来覆盖"全局一个都没有"的空态分支）。
- `registered` 是模块级数组且只 push 不去重，跨用例**会累积** —— 用例间要用不同桩插件 id 避免 flaky。
- **回归护栏**：用例声明 `queryDebounceMs` 时，harness 会断言插件真的设了 200–600ms —— 去掉它会退化成逐键打 API，肉眼看不见。
- ⚠️ 本机 `cargo test -p ll-host` 的测试二进制加载期报 `STATUS_ENTRYPOINT_NOT_FOUND`（0xc0000139，Windows 链接/加载环境问题）。项目门禁是 `npm run check`（`cargo check --workspace` + `tsc --noEmit`），不含 `cargo test`。

## 命令速查
```bash
npm run gen                 # 扫描 plugins/*/fe → 生成 src/plugins.generated.ts（改完 fe 必跑）
npm run plugin:install      # 安装外部插件（支持 -- <id>、--portable；kind=none 只部署 manifest）
npm run plugin:test         # LLP（Python）插件冒烟测试
npm run plugin:test:fe      # 纯前端插件测试（Node 内直跑逻辑，断言真实计算结果）
npx tsc --noEmit            # 前端全量类型检查
cargo check --workspace     # Rust 全量编译校验
```
- 改完插件**必跑**对应的 plugin:test 系列。
- 开发期宿主 debug 构建会自动扫描仓库 `plugins/`，无需 plugin:install。

## 版本控制
- 远端：`origin` = `git@gitcode.com:zhanxiaohai/LiteLauncher.git`，主分支 `master`。
- `.workbuddy/memory/` **已纳入版本控制**（随功能改动一起提交，保持记忆与代码同步）。
- 提交风格：按关注点拆分（能力层 / 插件 / 测试工具 / 文档），conventional commits（`feat|fix|test|docs|build|…`）。

## 环境（本机）
- Node（managed）：`C:/Users/zhanxh/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`
- Python（managed）：`C:/Users/zhanxh/.workbuddy/binaries/python/versions/3.13.12/python.exe`（跑 LLP 测试时用 `LLP_PYTHON=` 指定）
- cargo 用 rsproxy 镜像，可联网拉新依赖。
