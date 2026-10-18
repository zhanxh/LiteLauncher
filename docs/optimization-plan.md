# LiteLauncher 优化方案设计（P0 / P1 / P2）

> 状态：设计稿 v1，待评审  
> 依据：`docs/plugin-ux-review.md`、产品评审结论（2026-10-18）、源码核对与 release 包实机基线  
> 范围：0.2.0 / 0.3.0 / 0.4.0 三个版本，共 18 个工作包（含补充的 WP-04b）  
> 原则：**只做加法，不推翻现有架构；不改插件 ABI；不做账号与云**
>
> 实施状态（2026-10-18）：WP-00 完成；WP-01 数据层 / 后端 / 前端接入完成；
> WP-02 图标协议与缓存完成；WP-03 空状态与欢迎引导完成；
> WP-04 热键/自启/单实例与 WP-04b 插件热键 manifest 化完成；
> WP-05 结果项动作层完成；WP-06 截图热键直达区域框选完成；WP-07 剪贴板后台监听完成；WP-08 查询加载/超时/错误态完成；WP-09 自然语言时间完成；WP-10 日志/截图治理完成（内存按 WebView2 基线报告，不设虚假目标）；WP-11 分发/自动更新、WP-12 发布流水线、WP-13 文档、WP-14 API Key 加密完成（发布前需配置更新源 owner、签名私钥与公钥）；WP-15 第一批 5 个纯计算插件去 Python 完成；WP-16 商业化决策文档完成。
> （`ll-plugin-api` 23 个、`ll-migrate` 3 个、`ll-icons` 6 个、`apps` 11 个单测通过；`cargo check`、`tsc`、前端插件测试 17/17 通过）。

---

## 0. 一页纸结论

**先做三件事，其余按版本推进：**

1. **让"启动软件"开箱即用**：自动索引已安装应用 + 拼音/首字母检索 + 真实图标（WP-01/02）。
2. **让第一次打开不是空框**：首启引导 + 空状态三块内容（WP-03）。
3. **让常驻工具具备常驻能力**：热键可改（含插件热键 manifest 化）、开机自启、单实例（WP-04/04b）。

这三件事决定它能不能从"极客玩具"变成"日常入口"。截图热键、动作层、剪贴板历史、加载态属于第二优先级；安装包/更新/CI 是产品化的必要条件，但不改变单机体验。

**总工期（单人，熟悉代码库）**：P0 ≈ 17 人日，P1 ≈ 10 人日，P2 ≈ 16 人日，合计约 11–13 周（含缓冲与两轮 beta 反馈）。若业余开发，按 1.5–2 倍时间估算。

**明确不做**：贴图/长截图/OCR、插件市场、云同步、账号体系、macOS 适配、整体 UI 重做。理由见 §11。

---

## 1. 基线与约束

### 1.1 实机基线（release 包，Windows，空闲 8s 采样）

| 指标 | 实测 | 备注 |
|---|---|---|
| 冷启动到窗口出现 | 339 ms | 单次采样，不含首次建库 |
| 空闲进程数 | 7（1 主 + 6 WebView2） | WebView2 多进程为框架固有 |
| 空闲私有内存 | ≈ 247 MB | 工作集 ≈ 440 MB（含共享） |
| 安装体积 | exe 14.6 MB + WebView2 + 插件目录 | 前端产物 418 KB |
| 日志 | `lifecycle.log` 1.4 MB，无轮转 | 每次 IPC 追加写 |

**结论**：启动速度是优势；内存主要是 WebView2 基线，优化空间有限，不应作为 0.2 的主战场。日志 I/O 与窗口数量是少数可控项。

### 1.2 已核对的实现事实（决定方案边界）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 应用列表仅来自 `app_shortcuts`，不索引已安装应用 | `plugins/apps/be/src/lib.rs` `list()` |
| F2 | 应用图标固定 `🚀`，描述为完整路径 | 同上 `list()` / `add()` |
| F3 | 拼音映射硬编码 20 个汉字，应用检索不过模糊匹配 | `src/core/fuzzy.ts`；`list()` 走 SQL `LIKE` |
| F4 | 空输入只显示最近 5 条指令历史，否则 70px 空框 | `src/App.tsx` 空状态分支 |
| F5 | 设置仅 4 个 tab，无热键/自启/单实例 | `src/components/SettingsPanel.tsx` |
| F6 | 主热键写死 `alt+space` + `alt+x`，直接调用全局热键插件 | `src-tauri/src/lib.rs` setup |
| F7 | 无单实例插件；二次启动会产生第二个托盘图标 | `src-tauri/Cargo.toml` 依赖清单 |
| F8 | 截图热键只整屏，区域框选需进启动器 | `plugins/shot/fe/src/index.ts` `setupHotkey()` |
| F9 | `/clip` 仅在打开时抓一次当前剪贴板 | `plugins/clip/fe/src/index.ts` `loadEntries()` |
| F10 | 面板项只有 Enter 一种动作，无动作提示 | `src/App.tsx`、`src/components/SearchBar.tsx` |
| F11 | `PanelItem.icon` 是字符串，渲染为文本 emoji | `plugins/sdk/src/command.ts`、`ResultPanel.tsx` |
| F12 | 插件数据库 schema 由宿主 `migration.rs` 保证 | `migration.rs` `CREATE TABLE app_shortcuts` |
| F13 | 自定义协议已有先例：`ll-plugin://`（wry 在 Windows 重写为 `http://ll-plugin.localhost`） | `src-tauri/src/ll_plugin_assets.rs` |
| F14 | 全局热键已有中央注册表与冲突仲裁 | `ll-host/src/services.rs` `shortcut_registry()` |
| F15 | 能力白名单按窗口 label 精确列出 | `src-tauri/capabilities/default.json` |
| F16 | native 插件的 manifest 由宿主扫描阶段从**磁盘**解析后传入加载器，dll 内嵌 manifest 只做 id 一致性校验 | `ll-host/src/native.rs` `load_native_plugin(manifest, ...)` |
| F17 | 热键事件 payload 目前只有 `{pluginId, accel}`，注册表值是 `String`（accent → pluginId） | `ll-host/src/services.rs` `shortcut_registry()` |

### 1.3 设计约束

1. **插件 ABI 不变**：所有扩展字段可选、类型只增不改；已编译的 native dll / LLP 插件无需重编。
2. **本地优先不变**：新增能力默认离线；任何联网仍走 manifest `net:` 白名单。
3. **壳层零业务**：新增业务尽量放插件或搜索提供者，壳层只做聚合与通用交互。
4. **可回滚**：数据库变更先备份、用 `PRAGMA user_version` 分步；功能用设置项开关，不做不可逆迁移。
5. **单人可维护**：不引入需要长期运维的服务端组件；CI 只做构建与测试。

---

## 2. 目标与验收指标

| 指标 | 现状 | 0.4.0 目标 | 测量方式 |
|---|---|---|---|
| 首次启动到成功打开一个已装应用 | 需读文档 + 手动 `/app add` | **≤ 60 秒，零文档** | 5 名新用户任务测试 |
| 中文输入命中率 | `wx` 无结果 | `wx`→微信、`vsc`→VS Code 命中 | 固定 20 条用例 |
| 空状态可发现性 | 0 条内容 | ≥ 8 个可执行入口 | 代码断言 + 目测 |
| 热键冲突自助解决 | 只能换 `Alt+X` | 可在设置内改键并提示占用方 | 手工用例 |
| 插件热键可配置 | 硬编码在插件代码里 | manifest 声明 + 设置改键，改键后插件无感 | 手工用例 + 单测 |
| 剪贴板可找回 | 仅当前一条 | 10 分钟前复制的内容可检索 | 手工用例 |
| 空闲私有内存 | ≈ 247 MB | ≤ 220 MB（达不到则记录为基线，不阻塞） | `/sysinfo` + 进程采样 |
| 安装 | 手动拷 exe + plugins | 双击安装、自动装 WebView2 | 干净虚拟机 |
| 升级 | 手动替换 | 应用内检查更新并保留数据 | 0.2→0.3 覆盖升级 |
| 回归 | 手动跑脚本 | PR 必须过 CI | GitHub Actions |

> 指标只做本地统计（`app_settings` 计数器 + 用户主动导出的诊断包），**不做任何后台上报**。

---

## 3. 总体方案

### 3.1 版本路线

| 版本 | 主题 | 工作包 | 出口标准 |
|---|---|---|---|
| **0.2.0** | 能当日常启动器 | WP-00～06 + WP-04b | 新用户 60 秒内打开微信；图标/拼音/引导/改键可用 |
| **0.3.0** | 常用工具可信 | WP-07～10 | 剪贴板可找回；查询有加载/超时；日历能说人话 |
| **0.4.0** | 可分发、可维护 | WP-11～16 | 安装包 + 自动更新 + CI + 文档一致 |

### 3.2 依赖关系

```
WP-00 工程基线 ──┬─> WP-12 发布流水线
                 └─> 所有后续 PR 的 CI 门禁

WP-01 应用目录 ──┬─> WP-02 图标（依赖 catalog 的 path）
                 └─> WP-03 空状态（依赖 suggest 接口）

WP-04 设置中心 ──┬─> WP-11 安装（自启项/卸载清理）
                 ├─> WP-04b 插件热键 manifest 化（共享热键中央注册表）
                 └─> 与 WP-06 可并行（同属热键面，但无代码依赖）

WP-05 动作层 ────> WP-08 错误/加载（footer 承载状态）
WP-07 剪贴板 ────> WP-13 文档（隐私说明同步）
WP-09 自然语言 ──> 独立，可并行
WP-14 密钥加密 ──> 独立，建议随 0.4 一起
WP-15 去 Python ─> 依赖 WP-12 的测试矩阵
```

### 3.3 变更面总览

| 层 | 文件/模块 | 变更 |
|---|---|---|
| 壳层 | `src/App.tsx`、`SearchBar.tsx`、`ResultPanel.tsx` | 空状态、动作层、加载态、footer |
| SDK | `plugins/sdk/src/command.ts`、`lps.ts` | `PanelItem.actions/kind/group`、`searchOnEmpty`、`ctx.shortcuts.bind` |
| 宿主 | `src-tauri/src/lib.rs`、`settings.rs`、`migration.rs` | 图标协议、热键命令、引导窗口、schema v2 |
| 宿主 | `ll-host/src/services.rs`、`ll-plugin-api/src/lib.rs` | 剪贴板监听、快捷键中央注册表、manifest `hotkeys`、图标缓存 |
| 插件 | `plugins/apps/**`、`plugins/clip/**`、`plugins/shot/**`、`plugins/todo/fe/src/dsl.ts` | 目录/图标/监听/热键/自然语言 |
| 工程 | `.github/workflows/`、`LICENSE`、`CHANGELOG.md`、`tools/` | CI、版本同步、发布 |
| 配置 | `tauri.conf.json`、`capabilities/default.json` | 安装器、更新器、新窗口 label |

---

## 4. P0 工作包（0.2.0）

### WP-00 工程基线（1.5 人日）

**问题**：没有 LICENSE 文件、版本号三处不一致（`package.json` / `tauri.conf.json` / README 的 v3.0）、没有 CI。任何后续改动都没有自动门禁。

**方案**

1. 新增 `LICENSE`（MIT，版权人 + 年份）。
2. 版本单一真相源：`package.json.version` → `tools/sync-version.mjs` 同步写入 `src-tauri/tauri.conf.json` 与 README 徽章；CI 校验三处一致。
3. `.github/workflows/ci.yml`：
   - Windows + Ubuntu 双矩阵；
   - `npm ci` → `npm run gen` → `npx tsc --noEmit`；
   - `cargo test --workspace`；
   - `cargo test` 逐个 `plugins/*/be`；
   - `npm run plugin:test:fe`、`npm run plugin:test`（LLP 仅在 Windows 且 Python 可用时跑）；
   - `npm run build`（PR 不打包，tag 才打包）。
4. `CHANGELOG.md`（Keep a Changelog 格式），0.2.0 起每条用户可感知变更必须有一行。

**改动**：`LICENSE`、`CHANGELOG.md`、`tools/sync-version.mjs`、`.github/workflows/ci.yml`、`package.json`。

**验收**：PR 红灯能拦住 `tsc`/单测失败；`npm run version:check` 在版本不一致时退出码非 0。

**风险**：Ubuntu 跑 Tauri 编译需要 GTK/WebKit 依赖，首版可只跑 `cargo test` + 前端构建，Tauri 打包留在 Windows job。

---

### WP-01 应用目录与中文检索（3 人日）

**问题**（F1/F3）：`list()` 只查用户手加的快捷方式，排序是 `created_at ASC`；中文只能全名 `LIKE`，`wx`/`vsc` 都搜不到。这是"启动器"最核心的失败。

**目标行为**

- 首次启动自动收录开始菜单 + 桌面（当前用户/公共）的应用，无需 `/app add`；
- 输入 `wx` 首条是微信，`vsc` 首条是 VS Code，`weixin` 也能命中；
- 常启动的应用自动排在前面；
- 手动添加的条目永远优先于自动收录，且不会被扫描覆盖。

**数据模型（apps.db，schema v2）**

```sql
ALTER TABLE app_shortcuts ADD COLUMN source      TEXT    NOT NULL DEFAULT 'manual'; -- manual|system
ALTER TABLE app_shortcuts ADD COLUMN pinyin      TEXT    NOT NULL DEFAULT '';       -- 全拼，无空格：weixin
ALTER TABLE app_shortcuts ADD COLUMN initials    TEXT    NOT NULL DEFAULT '';       -- 首字母：wx / vsc
ALTER TABLE app_shortcuts ADD COLUMN launch_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_shortcuts ADD COLUMN last_used_at INTEGER;
ALTER TABLE app_shortcuts ADD COLUMN hidden      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_shortcuts ADD COLUMN last_seen_at INTEGER;                          -- 扫描水位：只隐藏不删除
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_path ON app_shortcuts(path);
CREATE INDEX IF NOT EXISTS ix_app_rank ON app_shortcuts(source, launch_count DESC, last_used_at DESC);
```

> 实现补充：`last_seen_at` 比"`path NOT IN (...)` 清理"更稳——应用数超过 SQLite 变量上限（999）时不会失效，且扫描中断不会误删。

迁移实现：文件定位/备份/日志留在宿主 `migration.rs` 的 `ensure_apps_schema_v2`；**列级逻辑抽到 `src-tauri/crates/ll-migrate`**（只依赖 rusqlite），这样迁移单测不链接 Tauri/WebView2，能在本机跑（宿主测试二进制受 `STATUS_ENTRYPOINT_NOT_FOUND` 限制，见 ux-review RK-07）。执行前把 `apps.db` 复制为 `apps.db.bak-v1-<ts>`；结束后写 `PRAGMA user_version = 2`。先按 path 去重再建唯一索引（保留最早一行，v1 时代全部是 manual）。

**拼音生成**

- `plugins/apps/be` 增加 `pinyin = "0.10"`（通用文本库，需在根 `Cargo.toml` 的依赖规则注释里显式放行）。
- 写入/扫描时计算：中文取 `to_pinyin` 的 `plain()` 拼接；ASCII 名称保留小写；`initials` 对 CJK 取拼音首字母、对英文按单词首字母（`Visual Studio Code` → `vsc`）。
- 不在前端引拼音库，避免 bundle 膨胀与首屏开销。

**扫描与排序**

- 扫描源：开始菜单（已有 `scan_start_menu`）+ 桌面 + `%PUBLIC%\Desktop`。UWP/Store 应用不在 v1 范围（需要 `shell:AppsFolder` COM 枚举），在文档中标注。
- 触发：`apps` 插件 `init()` 后后台线程执行，条件为 `user_version<2` 或距上次扫描 > 24h；`list()` 不等待扫描，先返回已有数据。
- Upsert：`INSERT ... ON CONFLICT(path) DO UPDATE SET name/pinyin/initials, hidden=0 WHERE source='system'`，绝不改 `manual` 行。
- 清理：扫描前建临时表装本次结果，扫描后把 `source='system'` 且不在临时表里的行置 `hidden=1`（不物理删除，防止 U 盘/网络盘临时不可用导致误删）。
- 排序 SQL：

```sql
ORDER BY
  CASE
    WHEN ?1 = '' THEN 0
    WHEN lower(name) = ?1 THEN 0
    WHEN lower(name) LIKE ?1 || '%' THEN 1
    WHEN initials LIKE ?1 || '%' THEN 2
    WHEN pinyin LIKE ?1 || '%' THEN 3
    ELSE 4
  END,
  (source = 'manual') DESC,
  launch_count DESC,
  COALESCE(last_used_at, 0) DESC,
  name COLLATE NOCASE ASC
```

- 新增 IPC：`import_system`（全量导入，返回 `{added, updated, total, ms}`）、`suggest`（空状态用，返回使用频次前 6）、`rescan`、`record_launch`（`onSelect` 成功后 `launch_count+1`）。
- `list()` 的 `description` 改为 `开始菜单 · 腾讯\微信` 这类来源短路径，完整路径放 `metadata.path`，由动作层提供"复制路径"。

**改动**：`plugins/apps/be/src/{lib.rs,system.rs,Cargo.toml}`、`plugins/apps/fe/src/appPlugin.ts`、`src-tauri/src/migration.rs`。

**验收**

- 清空 `apps.db` 后启动，3 秒内 `suggest` 返回 ≥ 30 个应用；
- 20 条中文/英文/缩写用例命中正确（`wx`、`weixin`、`vsc`、`code`、`qq`、`chrome`…）；
- 启动一次后 `launch_count=1`，再次查询排序上升；
- 手工添加的条目在重扫后仍在，且排在自动条目前；
- 迁移后旧数据零丢失（对比行数与抽样 path）。

**风险**：开始菜单里存在大量卸载残留 `.lnk`；用"隐藏不删除 + 启动过的不隐藏"缓解。`pinyin` crate 的多音字（"重庆"）按默认读音处理，可接受。

---

### WP-02 真实应用图标（2.5 人日）

**问题**（F2/F11）：所有应用都是 `🚀`，描述是一整条 `C:\...\xx.exe`，观感与 uTools/PowerToys Run 差一档。

**方案对比**

| 方案 | 做法 | 成本 | 风险 |
|---|---|---|---|
| A. base64 随列表返回 | apps 插件抽图标 → data URI | 低 | 每次按键 IPC 传几十 KB；插件要引 Win32 依赖，违反插件依赖规则 |
| **B. `ll-icon://` 协议（推荐）** | 插件只返回 `ll-icon://localhost/<urlencoded path>`，宿主负责抽图 + 缓存 | 中 | 新增协议面，需做路径白名单 |
| C. 前端从 exe 读 | WebView 无文件权限 | — | 不可行 |

**方案 B 设计**

- 注册 `ll-icon` 协议（与 `ll-plugin://` 同机制，Windows 上 wry 会重写为 `http://ll-icon.localhost/...`）。
- URL 形如 `ll-icon://localhost/<percent-encoded absolute path>`；handler 校验：
  - 必须是绝对路径、扩展名 ∈ `{exe, lnk, url, ico}`、文件存在；
  - 单张输出 ≤ 64 KB，只回 `image/png`，不回任何文件内容；
  - 失败返回 404，前端回退 emoji（不破版）。
- 缓存：内存 LRU 256 + 磁盘 `%LOCALAPPDATA%\LiteLauncher\icons\<fnv1a64(path+mtime)>.png`，命中直接读盘。
- 抽取（Windows）：`SHGetFileInfoW(SHGFI_ICON|SHGFI_LARGEICON)` → `GetIconInfo` → `GetDIBits` 取 32bpp BGRA → `image` 缩放到 32×32 → PNG 编码；`DestroyIcon/DeleteObject` 防泄漏。全透明图标补 alpha=255。
- 预热点：`import_system` 完成后后台预热前 30 个图标，避免首屏逐个冷抽。
- Linux：v1 返回 404（回退 emoji），后续接 `gio`/icon theme。
- 依赖：`ll-host` 增加 `image`、`windows-sys`（仅 `cfg(windows)`）。

**前端**：`ResultPanel` 的 `.item-icon` 支持三种形态——`ll-icon://`/`data:`/`http(s)` 渲染 `<img>`，其余按文本；`<img>` 加 `onError` 回退到 emoji，避免死图。

**改动**：`src-tauri/src/lib.rs`（协议注册）、新增 `ll-host/src/icons.rs`、`ResultPanel.tsx`、`launcher.css`、`plugins/apps/be`（返回 icon URL）。

**验收**

- 20 个应用图标全部渲染，无白块/拉伸；
- 缓存命中后整屏图标加载 < 50 ms；冷启动首次 < 300 ms（后台预热后不可感知）；
- 删除/移动 exe 后不崩溃、回退 emoji；
- 抽图失败不阻塞列表返回。

**风险**：`SHGetFileInfoW` 对网络盘/损坏 `.lnk` 可能慢（>50 ms）；加 100 ms 超时与失败缓存，超时回退 emoji。

---

### WP-03 首启引导与空状态（2 人日）

**问题**（F4）：新用户打开是一个 70px 空框；唯一提示是占位符"键入 /"。产品最好的教育位被浪费。

**目标行为**

- 首次启动弹一个 3 步引导窗，可跳过、可重看；
- 空状态展示三块：常用应用（WP-01）、最近指令（已有）、推荐指令；
- 引导完成后主窗口立即可用，不阻塞。

**引导窗（`?view=welcome`）**

| 步骤 | 内容 | 交互 |
|---|---|---|
| 1. 热键 | 显示当前 `Alt+Space`；可按下新组合键录制；冲突时提示占用方并允许重录 | 「用这个」/「稍后再说」 |
| 2. 导入应用 | 展示扫描结果 `已收录 N 个应用`（后台调用 `apps.import_system`） | 「完成」/「跳过」 |
| 3. 试一下 | 三个可点击示例：`wx` 打开微信、`/shot` 截图、`/cal today` 看日程 | 点击后填入主窗口并关闭引导 |

- 窗口 720×520，无边框，复用 `PopupFrame`；
- 触发：主窗口 `onMount` 检查 `onboarding.version`，未完成则延迟 600 ms 调 `open_welcome_window`；
- 持久化：`onboarding.version=1`、`onboarding.done=1`；
- 入口：设置 → 关于 → 「重新观看引导」。

**空状态（改造 `App.tsx` 空输入分支）**

- SDK 增加 `SearchProvider.searchOnEmpty?: boolean`；空输入时壳层对声明了该字段的 provider 调 `search('')`。
- `apps` 增加 `apps.suggest` provider（priority 0）：返回 `suggest(6)`，带 `group: '常用应用'`。
- 壳层内置一个静态 `builtin.suggest` provider：返回 6 条推荐指令（`/app`、`/find`、`/shot`、`/clip`、`/note`、`/cal today`），`group: '推荐指令'`。
- `ResultPanel` 支持 `item.group`：分组变化时渲染 11px 小标题；分组只影响展示，不影响键盘顺序。
- 历史仍保留 `group: '最近使用'`，最多 3 条，避免挤占。

**改动**：新增 `plugins/welcome/**`（或壳层 `src/components/WelcomePanel.tsx` + `?view=welcome` 路由）、`src/App.tsx`、`ResultPanel.tsx`、`plugins/sdk/src/command.ts`、`plugins/apps/fe/src/appPlugin.ts`、`src-tauri/src/settings.rs`（`open_welcome_window`）。

**验收**

- 全新用户：60 秒内完成三步并成功打开一个应用；
- 跳过引导不阻塞主窗口，设置里可重看；
- 空状态在无历史时仍显示 ≥ 8 个可执行入口；
- 引导只弹一次（重启不重复）。

**风险**：欢迎窗需要调用 `apps` 后端，但 `plugin_call` 的调用者校验只放行 `main` 与 `<pluginId>-*` 窗口。方案：引导的"导入"由**主窗口**发起（调用者 `main`，合法），欢迎窗只负责展示与交互（通过事件/设置读结果），不放宽权限模型。

---

### WP-04 设置中心与常驻能力（2.5 人日）

**问题**（F5/F6/F7）：热键写死、无开机自启、无单实例；设置只有外观/Python/插件/关于。

**目标行为**

- 设置新增「通用」「快捷键」两个 tab；热键可改、冲突有提示、改完立即生效并持久化；
- 开机自启可开关；
- 二次启动只唤起已有窗口，不再出现第二个托盘图标；
- 「数据」tab 显示数据目录、导出诊断包、重置引导。

**技术方案**

1. **热键**
   - 新增 `hotkey.main` 设置项（默认 `alt+space`），启动时读取并注册；失败回退 `alt+x`；再失败则托盘 tooltip + 设置页红字提示。
   - 复用 `ll-host` 的 `shortcut_registry()`：把主热键以 owner=`core` 注册，与插件热键共用同一冲突仲裁；对现有 `HostShortcutApi` 暴露 `register_core/unregister_core`。
   - 新命令：`get_main_hotkey`、`set_main_hotkey(accel)`（先注册新键成功再退旧键，失败回滚并返回占用方）、`test_hotkey(accel)`。
   - 设置页录制控件：捕获 `keydown`，要求至少一个修饰键；显示规范形式（`ctrl+alt+l`）。
   - 插件热键不在此处单独实现，统一走 WP-04b（manifest 声明 + 设置改键）。

2. **开机自启**
   - 引入 `tauri-plugin-autostart = "2"`，Windows 写 HKCU Run；
   - 命令：`get_autostart` / `set_autostart`；
   - 卸载清理放到 WP-11 的 NSIS 钩子（否则会留死项）。

3. **单实例**
   - 引入 `tauri-plugin-single-instance = "2"`，**必须第一个注册**；
   - 回调里 `show_main_window`；
   - 开发期用 `LL_ALLOW_MULTI=1` 跳过，避免 `tauri dev` 热重启被拦。

4. **设置页结构**
   - `通用`：热键、开机自启、语言/主题入口、Python 环境（原 tab 合并进来）；
   - `快捷键`：主热键 + 插件热键（数据来自宿主 `plugin_hotkeys`，见 WP-04b；不再依赖插件自报）；
   - `插件`：保留，增加"重新扫描应用"按钮（调用 `apps.rescan`）；
   - `数据`：数据目录、导出诊断 zip（日志 + 版本 + 插件清单，用户主动选择保存位置）、重置引导；
   - `关于`：版本、平台、License、更新检查（WP-11）。

   > 设置窗 label 为 `app-settings`，当前不允许调用插件后端。方案：把 `main`、`app-settings`、`welcome` 定义为**壳层可信窗口**白名单，在 `plugin_call` 的调用者校验里放行（ADR-4）。这是必要的、范围最小的权限放宽。

**改动**：`src-tauri/src/lib.rs`、`settings.rs`、`Cargo.toml`、`capabilities/default.json`、`ll-host/src/services.rs`、`SettingsPanel.tsx`、`settings.css`。

**验收**

- 改成 `Ctrl+Alt+L` 后立即生效，重启保留；改成已被插件占用的键时提示"被 /pick 占用"并保持原键；
- 开机自启写入 HKCU Run，关闭后删除；
- 双击 exe 两次只有一个实例，第二个进程退出并唤起第一个；
- 设置窗能触发"重新扫描应用"并看到数量变化。

**风险**：`tauri-plugin-single-instance` 与 `tauri dev` 冲突（用环境变量规避）；热键改键后用户肌肉记忆断档，需在设置页给"恢复默认"。

---

### WP-04b 插件快捷键 manifest 化（3 人日）

**问题**（F17）：插件热键写死在插件代码里（`const HOTKEY = 'alt+p'`），manifest 只有 `permissions: ["shortcut:alt+p"]` 这一条白名单；用户想换键只能改代码，`/hotkey` 靠插件自报，设置页无法统一展示，改键后 `on(accel)` 的订阅还会失效。

**结论：可以配置到 manifest，但要区分"默认值"与"用户偏好"。**

- manifest 存**默认键 + 语义**（随插件分发，作者维护）；
- 用户改键存 **`app_settings`**（本机、可回滚、升级不丢）；
- **不要让用户改插件目录的 JSON**：升级会覆盖、`Program Files` 只读、无法审计与重置，而且 manifest 是权限声明的一部分，手改会让安全边界变模糊。

**已核对的加载链路**（F16）：native 插件的 manifest 同样是宿主扫描阶段从磁盘解析后传入 `load_native_plugin`，dll 内嵌 manifest 只用于 id 一致性校验。因此**改 `manifest.json` + 重启即生效，不需要重编 dll 或前端包**；LLP 与 `kind:none` 同理。

**manifest schema（新增 `hotkeys`，全部可选）**

```json
{
  "id": "pick",
  "permissions": ["screen", "clipboard:write", "notifications", "settings", "windows", "shortcut:alt+p"],
  "hotkeys": [
    {
      "id": "pick",
      "default": "alt+p",
      "label": "光标处取色",
      "description": "任意界面按下即取色，HEX 进剪贴板",
      "scope": "any",
      "editable": true,
      "enabled": true
    }
  ]
}
```

**校验规则（宿主扫描期执行，失败只跳过该条热键，不拒载插件）**

1. `id` 插件内唯一、`[a-z0-9-]{1,32}`、**发布后不可改**（设置键与事件路由都用它）；
2. `default` 归一化后**必须**出现在 `permissions` 的 `shortcut:<accel>` 里——默认键仍受最小权限约束；
3. `scope ∈ {main, any}`，默认 `main`（沿用"默认只在主窗口响应"的既有约定）；
4. `editable` 默认 `true`；`enabled` 默认 `true`（可发布"默认关闭、用户可自行开启"的热键）；
5. `default` 无法解析、或被系统保留（`alt+f4`/`win+l` 一类）→ 记警告并跳过。

**优先级与覆盖规则**

```
用户设置 hotkey.<pluginId>.<hotkeyId>  >  manifest.hotkeys[].default
```

- 用户覆盖只对 `editable: true` 生效；**不要求落在 permissions 白名单内**——这是用户显式授权，不是插件自行抢注。宿主仍做格式校验、系统保留键校验与冲突仲裁，并记录 `source=user`。
- 禁用：`hotkey.<pluginId>.<hotkeyId>.enabled=false` → 不注册（仍显示在设置里，可恢复）。
- 插件升级后 `hotkeyId` 消失 → 设置里显示"已失效"，允许清理，启动时忽略孤儿键。

**注册与事件路由（关键改动）**

- 新增 SDK：`ctx.shortcuts.bind(hotkeyId, handler)`：
  1. 宿主按上表解析 effective accel；
  2. 以 owner=`<pluginId>#<hotkeyId>` **幂等**注册，复用现有 `shortcut_registry()`；注册表值从 `String` 升级为 `{ pluginId, hotkeyId?, label }`（旧 owner 记 `<pluginId>`）；
  3. 事件 payload 增加 `hotkeyId`：`{ pluginId, hotkeyId, accel }`；
  4. 前端按 `hotkeyId` 过滤，**改键后不需要重新订阅**——这是 id 化相对 accel 化的核心收益。
- 旧 API `register(accel)` / `on(accel, cb)` 原样保留，作为兼容路径；`scope` 从 manifest 读取后，`bind` 不再需要传 opts，旧 `on` 的 `{scope}` 继续生效。
- 插件被禁用时注销其全部热键；重新启用后由 `bind` 重新注册。

**用户改键流程（设置 → 快捷键）**

1. 录制新组合键；
2. 宿主校验 → **先注册新键**（owner 不变）；失败则返回占用方 `{ pluginId, hotkeyId, label }`，**旧键保持可用**；
3. 成功 → 注销旧键 → 写 `app_settings` → 广播 `hotkey-changed`（设置页与 `/hotkey` 刷新）；
4. 列表展示：动作名、当前键、默认键、状态（正常/冲突/已停用/已失效）、「恢复默认」。

**管理接口**

- Tauri 命令：`plugin_hotkeys()`（全量，含 effective/default/overridden/status/conflictWith）、`set_plugin_hotkey`、`reset_plugin_hotkey`、`set_plugin_hotkey_enabled`；
- `plugin_list` 增加 `hotkeys` 声明（不含 effective，避免列表接口依赖 DB）；
- svc 能力：`svc.shortcut.catalog` 供 `/hotkey` 插件读取同一份数据（只读，无权限要求）；
- `CommandPlugin.hotkeys` 自报降级为兜底，宿主数据优先。

**插件迁移（0.2 只动两个）**

- `pick`：`hotkeys:[{ id:'pick', default:'alt+p', scope:'any' }]`，代码改 `bind('pick', ...)`；
- `shot`：`hotkeys:[{ id:'capture', default:'alt+shift+s', scope:'main' }]`，行为由 WP-06 改为区域框选，键不变；
- `clip`（可选）：声明 `id:'open'` 但 `default:''`，表示"不注册默认键、仅允许用户在设置里绑定"。

**为什么不让插件自己读 manifest 再 `register`**

- `kind:none` 的插件前端读不到 manifest（代码在应用包里，manifest 在插件目录）；
- 即读得到，用户覆盖值在 DB 里，插件无从得知；
- 改键后 accel 变了，`on(accel)` 必须重新订阅，容易漏；
- 结论：**解析、注册、路由必须由宿主做，插件只声明 id**。

**实现注意**

- `PluginManifest` 增加 `hotkeys: Vec<HotkeySpec>` 且 `#[serde(default)]`；`shell_safe_manifest` 等手工构造点要同步补字段；
- manifest 是 JSON、不跨 FFI，**不需要 ABI 版本升级**，也不需要重编 native dll；
- `capabilities/default.json` 不需要为新窗口加权限（不新增窗口）。

**验收**

- 改 manifest `default` + 重启 → 生效，无需重编 dll/前端包；
- 设置改键 → 立即生效、重启保留、插件无感（无需重新订阅）；
- 改成被占用键 → 提示占用方，旧键仍可用；
- 禁用 → 系统级注销；恢复 → 重新注册；
- 旧插件 `register/on` 全量回归通过；
- `plugin_list`、设置页、`/hotkey` 三处数据一致。

**风险**：owner 从 `String` 换成结构体会影响现有冲突提示与单测（需同步改）；`scope=any` 时多个视图窗口都会 `bind`，靠幂等去重；用户改成系统保留键会注册失败，必须回滚而不是留空。

**估时**：0.5（schema/校验/单测）+ 1（宿主注册/命令）+ 0.5（SDK/事件）+ 0.75（设置 UI）+ 0.25（两个插件迁移）= 3 人日。

---

### WP-05 结果项动作层（2 人日）

**问题**（F10）：只有 Enter 一种动作，没有"打开所在目录/复制路径/管理员运行"，用户不知道能做什么；说明项还会被 ↑↓ 选中，按回车无反应。

**SDK 变更（全部可选、向后兼容）**

```ts
export interface PanelAction {
  id: string;
  label: string;
  accel?: 'ctrl+enter' | 'shift+enter' | 'alt+enter';
}

export interface PanelItem {
  // ...现有字段
  /** 该项的次级动作；壳层按 accel 绑定按键并渲染 footer */
  actions?: PanelAction[];
  /** action=可执行（默认）；info=说明项，键盘导航跳过 */
  kind?: 'action' | 'info';
}

// onSelect 增加可选的第二参数；老插件签名不受影响
onSelect?(item: PanelItem, actionId?: string): Promise<AfterSelect | void>;
```

**壳层行为**

- `SearchBar` 的 Enter 处理带上 `ctrlKey/shiftKey/altKey`，`App` 按 `item.actions` 的 `accel` 匹配 `actionId`；无匹配则走主动作。
- 面板底部新增 `.panel-footer`（32px）：左侧 `↵ 打开 · Ctrl+↵ 打开所在文件夹 · Tab 更多`，右侧 `N 项`；无动作时只显示 `↵ 执行`。
- 窗口高度计算统一为 `SEARCH_H(70) + panel + FOOTER_H(32)`，顺手清掉散落的 `420/460/260` 魔法数字。
- `kind='info'`：渲染为低对比度、无 hover、`aria-disabled`，键盘导航用"可选索引数组"跳过。
- `Tab`：打开动作浮层（列出该条 actions），↑↓ 选择、Enter 执行、Esc 关闭。若 0.2 排期紧，可先只做 footer + Ctrl+Enter，Tab 顺延到 0.3。

**外部/native 插件如何拿到 actionId**

通用前端插件适配层（`src/core/externalPlugins.ts`）的 `onSelect` 增加可选参数，并把它放进 `select` 调用的 params（`{ id, metadata, actionId }`）。这是**新增可选字段**，旧的 sidecar/native 后端按 serde 默认忽略未知字段，不需要重编、不改 ABI 版本。

**插件接入**

- `apps`：`Ctrl+Enter` 打开所在文件夹（`explorer /select,<path>`），`Shift+Enter` 以管理员运行（Windows `runas`，失败给出 UAC 取消提示）。
- `find`：`Ctrl+Enter` 打开所在文件夹，`Shift+Enter` 复制路径。
- `clip`：`Ctrl+Enter` 仅复制不关窗（便于连续取用）。
- 所有"说明项"（`/clip` 策略行、`/shot` 提示行）标 `kind:'info'`。

**改动**：`plugins/sdk/src/command.ts`、`src/App.tsx`、`SearchBar.tsx`、`ResultPanel.tsx`、`launcher.css`、`plugins/{apps,find,clip}` 前端。

**验收**

- footer 随选中项变化正确显示；`Ctrl+Enter` 命中预期动作；
- 说明项无法被 ↑↓ 选中，回车不会落在它上面；
- 无 `actions` 的老插件行为完全不变（回归 35 个插件）。

**风险**：`Ctrl+Enter` 在部分输入法下被占用；用 `keydown` 的 `isComposing` 判断规避。

---

### WP-06 截图热键直达区域框选（0.5 人日）

**问题**（F8）：`Alt+Shift+S` 直接整屏截图，而市场肌肉记忆是"按热键 → 框选"。

**方案**

- `setupHotkey()` 的回调从 `capture(-1,0)` 改为 `ctx.windows.open('select', { monitor:'-1', delayMs:'0' })`；
- 整屏保留在 `/shot` 面板（第二项）；
- 通知文案改为"已进入框选"由遮罩层自己反馈，热键路径不再发"截图已保存"通知（避免误报）；
- 遮罩层现有 Esc 取消、跨屏拼接、标注链路全部复用，不改。

**改动**：`plugins/shot/fe/src/index.ts`（约 10 行）、`manifest.json` 描述与 `examples`。

**验收**：热键按下 300 ms 内出现框选遮罩；Esc 无副作用；框选后图片进剪贴板；`/shot` 整屏仍可用。

---

## 5. P1 工作包（0.3.0）

### WP-07 剪贴板历史：从"快照"到"历史"（4 人日）

**问题**（F9）：只在打开 `/clip` 时抓当前剪贴板，用户复制 A 再复制 B 后 A 永久丢失。名称与能力不符，会被判定为假功能。

**方案对比**

| 方案 | 延迟 | 成本 | 兼容 |
|---|---|---|---|
| A. 轮询 + 序列号（推荐） | 0.8–1.5 s | 低 | 三平台可用 |
| B. Win32 剪贴板监听窗口 | 即时 | 中高（消息循环/WndProc） | Windows only |
| C. 保持现状 + 改名"剪贴板快照" | — | 极低 | 诚实但弱 |

**推荐 A**，理由：实现小、可跨平台、不需要消息泵；0.8 s 延迟对该场景足够。若后续要即时性再升级 B。

**宿主实现**

- 新增 `ll-host/src/clipwatch.rs`，随 `init_all` 之后启动一个后台线程：
  - 每 800 ms 读一次 `GetClipboardSequenceNumber()`（Windows，极廉价）；序列号未变直接跳过；
  - 变化时用 `arboard` 读文本，失败/非文本跳过；
  - 去重：与上一条相同则只更新 `ts`；24h 内相同文本不重复插入；
  - 过滤：沿用现有 `is_suspected_secret`（私钥头、`password=`、24+ 位高熵串）；
  - 上限：200 条 / 单条 64 KB / 7 天，复用现有清理逻辑。
- **来源应用**：Windows 取 `GetForegroundWindow` → 进程 exe 名，存 `source_app`；命中排除名单（KeePass/1Password/Bitwarden/LastPass 等，可配置）则**不入库**。这是隐私底线，不做就不上线。
- Schema：`ensure_clip_schema` 幂等 `ALTER TABLE clip_history ADD COLUMN source_app TEXT`。
- 默认值：`clip.watch` 默认 **开**，但首次打开 `/clip` 时在面板顶部显示一次"已开启本机剪贴板历史 · 可在设置关闭"提示；设置页提供开关与排除名单编辑。
- 退出时线程 join，避免写库竞态。

**插件侧**

- 删除"打开时才 ingest"的逻辑，改为纯读；
- 面板顶部策略行改为实时状态（`监听中 · 最多 200 条 · 7 天过期 · 密码管理器不入库`）；
- 增加 `Ctrl+Enter 仅复制`（WP-05）；
- 空态文案改为"复制任意文本后回来即可找回"。

**验收**

- 关闭 `/clip` 后复制 A、再复制 B，打开 `/clip` 能看到 A 与 B；
- 在 KeePass 窗口复制密码，`/clip` 中不存在该条（用测试替身验证逻辑 + 手工验证）；
- 暂停开关生效，暂停期间不新增；恢复后从当前开始记录；
- 连续复制 300 条后仍 ≤ 200 条、7 天前条目被清理；
- 空闲 CPU 增量 < 0.1%（任务管理器 1 分钟采样）。

**风险**：轮询在 Linux/X11 上读剪贴板可能触发选区所有者交互，先只在 Windows 开启，Linux 保持"按需 ingest"并如实标注（设置页显示"当前平台仅快照模式"）。

---

### WP-08 查询加载态、超时与错误文案（1.5 人日）

**问题**：网络插件（300 ms 防抖 + 请求）与 Python 插件首次调用（解释器冷启动）期间面板全空，用户以为卡死；错误直接抛 `执行异常: ...`。

**方案**

- `App.tsx` 增加 `queryState: 'idle'|'loading'|'done'` 与 `queryStartedAt`；
  - 发起 `query` 时置 loading；结果返回置 done；
  - **超过 150 ms 才显示 loading**，避免纯计算插件闪烁；
  - 8 秒未返回：面板顶部加一行"仍在查询（网络或 Python 环境较慢）· Esc 取消"；15 秒：显示"重试"项。
- `ResultPanel` 在 `loading && items.length===0` 时渲染 3 行骨架（灰条），不显示"未检索到内容"。
- 新增 `src/core/errors.ts`：
  - `python|解释器|LLP_PYTHON` → "该插件需要 Python 3，点此打开设置";
  - `timeout|timed out|network` → "网络超时，检查代理或稍后重试";
  - `permission|权限` → "插件缺少权限：<perm>";
  - 其他 → "操作失败" + 折叠的原始信息 + "打开日志目录"。
- Toast 与 `emptyText` 统一走 `toUserMessage(err)`；保留原始信息在 `console.error` 与日志里。

**验收**

- 断网查 `/weather`：8 秒内出现"仍在查询"，15 秒出现重试；
- 卸载/改名 Python 后 `/hash md5 a`：提示可点击打开"设置 → Python 环境"；
- 纯计算插件（`/json`、`/text`）输入时无 loading 闪烁。

**风险**：`query` 没有取消机制，超时只是 UI 提示；真正的取消需要 AbortController 贯穿 IPC，成本高，暂不做（记录为技术债）。

---

### WP-09 日历自然语言时间（2 人日）

**问题**：`/cal new "需求评审" 10-15 14:00-15:30 --al 10,30` 只有作者记得住；普通用户的第一反应是"明天下午三点开会"。

**方案**：在 `plugins/todo/fe/src/dsl.ts` 增加 `parseNaturalTime(text, now)`，作为现有 DSL 的**兜底**（DSL 显式日期优先，绝不覆盖）。

**支持语法（v1 刻意收敛）**

| 类别 | 示例 |
|---|---|
| 相对日 | 今天、明天、后天、大后天 |
| 星期 | 周一…周日、星期一…日、下周一、下下周五 |
| 时段 | 上午、下午、中午、晚上 |
| 时刻 | 3点、三点、15:30、3点半、3点20、下午3点 |
| 时长 | 1小时、半小时、90分钟（可选，缺省用 `todo.default_duration_min`） |

**解析规则**

1. 只在输入**开头**匹配时间短语，最长匹配优先；剩余文本即标题；
2. 引号内文本永不参与解析（保护标题）；
3. 只有时刻没有日期 → 今天，已过则明天（沿用现有规则）；
4. 解析失败不报错，回退到"整串当标题 + 预览胶囊提示未识别时间"，让用户看到发生了什么；
5. 预览胶囊展示解析结果：`🗓 明天 15:00–16:00 · 标题：开会`，回车才写入。

**测试**：在 `tools/test-fe-plugins.mjs` 增加 ≥ 15 条用例（含"明天下午三点开会"、"周五 10点 项目复盘"、"下下周一 9点半 站会 30分钟"、含引号标题、非法输入）。

**改动**：`plugins/todo/fe/src/dsl.ts`、`todoPlugin.ts`（预览/execute 接入）、`/help` 示例、测试脚本。

**验收**：15 条用例全绿；现有 DSL 用例零回归；`/cal new "10-15 评审"` 这类带引号标题不被误解析。

**风险**：中文数字与"点"的歧义（"三点水"）；只匹配开头且要求后接时间/标题边界，减少误伤。

---

### WP-10 内存、日志与截图落盘治理（2 人日）

**问题**：空闲 247 MB；`lifecycle.log` 无轮转且每次 IPC 都写；截图落盘无上限无清理（`docs/plugin-ux-review.md` RK-01 仍未关闭）。

**方案**

1. **日志**
   - `log_lifecycle` 增加级别：默认 `info`（窗口事件/启动/迁移），`LL_LOG=debug` 才记录每次 `set_main_window_height` 与 IPC；`LL_LOG=off` 全关。
   - 轮转：启动时若 > 2 MB，重命名为 `lifecycle.log.1`（只保留 1 份）。
   - 高频路径改为先判断级别再格式化，避免无谓字符串分配。
2. **内存**
   - 先测量后优化：`/sysinfo` 已有主程序+子进程聚合，补一条"本窗口 WebView 进程数"。
   - 可控项：确认视图窗口 `close` 后 webview 进程回收（用任务管理器验证）；禁止在后台常驻隐藏的多余窗口。
   - 不追 WebView2 基线：若优化后仍 > 220 MB，在文档中写明"WebView2 基线，非泄漏"，不设虚假目标。
3. **截图落盘**
   - `svc.screen.capture` 落盘目录改为 `%LOCALAPPDATA%\LiteLauncher\screenshots`（若当前是插件目录）；
   - 保留策略：最多 500 张或 30 天，先到者清理；`/shot` 面板显示"已保存 N 张 / 占用 X MB"；
   - 清理在启动后延迟 10 秒执行，不阻塞首屏。

**验收**

- 空闲私有内存 ≤ 220 MB（达不到则输出基线报告并关闭该目标）；
- 日志文件稳定 ≤ 2 MB；`LL_LOG=off` 时运行 10 分钟零写入；
- 连续截图 600 次后目录 ≤ 500 张，最旧的被清理。

**风险**：清理误删用户手动放进目录的图片；只删命名匹配 `shot-YYYYMMDD-HHMMSS-*.png` 的文件。

---

## 6. P2 工作包（0.4.0）

### WP-11 分发与自动更新（4 人日）

**问题**：只有 `release/LiteLauncher.exe` + 手动拷 `plugins/`；无安装包、无签名、无更新通道。普通用户装不上，老用户升不动。

**方案**

1. **安装包**
   - `bundle.targets = ["nsis", "msi"]`；NSIS 中文安装向导；
   - `windows.webviewInstallMode = { type: "downloadBootstrapper" }`（缺 WebView2 自动装）；
   - 插件随包：`bundle.resources` 把 `release/plugins` 映射到 `$INSTDIR/plugins`，宿主已有的"exe 同级 plugins"扫描逻辑直接生效；
   - 卸载：保留 `%LOCALAPPDATA%\LiteLauncher` 用户数据；NSIS 钩子清理开机自启注册表项（WP-04）。
2. **签名**
   - 预留 `TAURI_SIGNING_PRIVATE_KEY` / `certificateThumbprint` 环境变量；无证书时如实说明 SmartScreen 会拦，并提供校验和；
   - 可选：申请 SignPath（开源项目免费）做 OSS 签名，作为发布流程的一步，不阻塞代码。
3. **自动更新**
   - `tauri-plugin-updater = "2"` + `tauri-plugin-process`（重启）；
   - `plugins.updater.endpoints` 指向 `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`（owner/repo 参数化，写入 `tools/release-config.mjs`）；
   - 启动后静默检查（每天一次，失败静默）；设置页「关于」提供手动检查；
   - 更新前备份 `apps.db`/`litelauncher.db`，更新失败可回退；
   - 通道：`stable` 单通道，暂不做 beta 通道。
4. **版本升级兼容**：0.2→0.3 的 schema 迁移必须幂等（WP-01/WP-07 已按此设计）。

**验收**：干净 Win10/11 虚拟机双击安装成功；无 WebView2 时自动安装；0.2 覆盖升级到 0.3 数据完整；应用内检查更新能下载并重启到新版本；卸载后用户数据仍在、自启项已清。

**风险**：更新签名私钥丢失 = 无法再发版；私钥只存 CI Secrets 并离线备份。GitHub 不可达地区更新失败要有"手动下载"入口。

---

### WP-12 发布流水线与变更记录（2 人日）

**方案**

- `.github/workflows/release.yml`：tag `v*` 触发 → 构建 Windows 安装包 + updater 产物 → 生成 `latest.json` → 创建 GitHub Release（`tauri-apps/tauri-action`）；
- `CHANGELOG.md` 由 PR 模板强制（用户可感知变更必须写一行）；
- Release notes 自动取 CHANGELOG 对应段落；
- 构建产物附 SHA-256 校验和。

**验收**：打 tag 后 20 分钟内产出可下载安装包 + `latest.json`；Release 页面含变更说明与校验和。

---

### WP-13 文档重构与单一真相源（2 人日）

**问题**：README 391 行，开发架构与用户指南混在一起；`docs/plugin-ux-review.md` 里"已完成/未实现"并存；README 的"拼音简写""单实例"与实现不符。

**方案**

- `README.md` 重写为用户向：这是什么、60 秒上手、快捷键表、常见问题、如何反馈（≤ 150 行）；
- `docs/architecture.md`：现有架构、插件体系、构建说明（搬走原 README 的开发内容）；
- `docs/user-guide.md`：每个指令一页，含真实示例（从 `examples`/`argsHint` 生成，避免手写漂移）；
- `docs/plugin-ux-review.md` 顶部加横幅："2026-10-13 的历史快照，状态以 CHANGELOG 与代码为准"；
- 所有文档加"最后核对日期 + 对应版本"；
- CI 增加一条脚本：校验 README 快捷键表与 `setup()` 注册的热键一致（防再次漂移）。

**验收**：新用户只读 README 能完成安装与第一次使用；文档中不再出现与代码矛盾的"已实现"声明；`/help` 内容与 user-guide 同源。

---

### WP-14 API Key 加密（1.5 人日）

**问题**：`HostSecretApi` 把 AI 插件密钥明文写进 `app_settings`，键名还叫 `secret.*`。

**方案**

- Windows：`CryptProtectData`（DPAPI，当前用户作用域）+ 固定 entropy（app id + 键名），存 `dpapi:v1:<base64>`；
- 读取时识别前缀：`dpapi:v1:` → 解密；无前缀 → 视为旧明文，读成功后**就地重写**为密文（惰性迁移）；
- Linux：v1 保持明文但在设置页标注"当前平台未加密"；后续接 `keyring`（Secret Service）；
- 解密失败（换机器/换用户）：返回空并提示"密钥无法解密，请重新填写"，不崩溃。

**验收**：SQLite 里 `strings` 搜不到明文 key；旧 key 首次读取后自动变密文；换 Windows 用户后提示重填而非报错。

---

### WP-15 去 Python 化（第一批，5 人日）

**问题**：10 个插件依赖 Python 3（`hash/cron/cidr/cost/bookmark/snip/pwd/memo/cheat/time`），干净 Windows 上这些指令全部不可用；设置页还要教用户配解释器。

**方案**：先把**纯计算、无状态**的 5 个迁为 `kind: none` 前端插件：

| 插件 | 迁移要点 |
|---|---|
| `/hash` | `crypto.subtle` 支持 sha1/256/512；md5 需内置小型 JS 实现；base64/url/html 编解码用平台 API |
| `/cron` | 5 段解析 + 未来 5 次触发，纯算法 |
| `/cidr` | IPv4/IPv6 网段计算，纯算法（已有 Rust 单测可作对照用例） |
| `/time` | `Intl.DateTimeFormat` + 时区表 |
| `/pwd` | `crypto.getRandomValues` + 字符集策略 |

- 保留 `bookmark/snip/memo/cost/cheat`（有状态/需持久化）为 LLP，文档标注"需要 Python"；
- 迁移时保持输出格式与现有 `PanelItem` 一致，测试用例从原 Python 测试平移；
- 设置页 Python tab 降级为"高级 → 外部插件运行时"，不再出现在默认路径。

**验收**：全新无 Python 机器上 5 个指令全部可用且结果与旧实现逐条一致（用固定输入对照）；Python tab 默认收起；`/help` 标注每个插件是否需要 Python。

**风险**：md5 手写实现的正确性；用 RFC 1321 测试向量 + 与旧实现对比双重校验。

---

### WP-16 商业化决策（1 人日，只出文档）

**结论先行**：**不做广告、不做功能阉割式会员**。可选路径按优先级：

| 路径 | 可行性 | 说明 |
|---|---|---|
| 捐赠（GitHub Sponsors / 爱发电） | 高 | 不改产品，先建立可持续的最小收入 |
| 付费云同步（日程/笔记/设置） | 中 | 需账号与服务端，成本高；与"本地优先"叙事有张力，必须可选 |
| 团队日历/共享 | 中 | 面向小团队，可独立收费 |
| 插件市场分成 | 低（近期） | 需审核、签名、结算体系，0.4 前不做 |
| 广告 | **不做** | 与工具类产品信任模型冲突 |

**交付**：`docs/monetization.md`，含定价假设、成本模型、对开源协议的影响、退出策略。代码层不做任何预埋。

---

## 7. 关键技术决策（ADR）

| # | 决策 | 选项 | 结论 | 理由 |
|---|---|---|---|---|
| ADR-1 | 图标传输 | base64 / `ll-icon://` / 前端读文件 | **`ll-icon://` + 缓存** | 不增加 IPC 体积；插件不引 Win32 依赖；协议已有先例 |
| ADR-2 | 应用目录 | 单表加 `source` / 双表 | **单表加列** | 查询与排序简单；迁移成本低；手动/自动用 `source` 区分 |
| ADR-3 | 剪贴板 | 轮询 / Win32 监听 / 改名 | **轮询（Windows 序列号）+ 暂不改名** | 成本低、跨平台；0.8s 延迟可接受；监听留作后续 |
| ADR-4 | 受信窗口 | 只信 `main` / 白名单 | **`main`+`app-settings`+`welcome`** | 三者都是壳层自有窗口；插件窗口仍严格绑定 `<id>-*` |
| ADR-5 | 单实例与热键 | 自研 / 官方插件 | **官方插件 + 复用中央注册表** | 不重复造轮子；冲突仲裁已有实现 |
| ADR-6 | 更新 | 自建 / GitHub Releases | **GitHub Releases + tauri updater** | 零服务端成本；签名密钥可控 |
| ADR-7 | 自然语言时间 | 壳层通用解析 / 插件内解析 | **插件内（todo）** | 只有日历需要；不污染核心解析器 |
| ADR-8 | 插件热键配置 | 全部写 manifest / manifest 默认 + DB 覆盖 | **manifest 存默认与语义，`app_settings` 存用户覆盖** | 升级不覆盖用户偏好；manifest 保持可分发、可审计；改键走设置而非手改 JSON |

---

## 8. 测试与质量

### 8.1 自动化

| 层 | 手段 | 覆盖 |
|---|---|---|
| Rust 宿主/插件 | `cargo test` + `cargo test -p ll-migrate` / `-p ll-icons` | 目录排序、schema 迁移、热键仲裁、manifest 热键校验/覆盖优先级、图标 URI/缓存键/真实抽取、剪贴板过滤；两个新 crate 不依赖 tauri，本机可跑 |
| 前端插件 | `npm run plugin:test:fe` | 拼音生成、自然语言时间、CIDR/hash 迁移对照 |
| 壳层 | 新增 `vitest`（可选，0.3 起） | `friendlyError`、动作匹配、空状态合并 |
| 构建 | CI | `tsc --noEmit` + `npm run build` |
| 安装 | 手工 VM 清单 | WebView2、覆盖升级、卸载清理 |

### 8.2 手工回归清单（每版必跑）

1. 冷启动 → 空状态 → `wx` → 回车打开微信；
2. 改主热键 → 重启 → 新热键生效；
3. 改插件热键（`Alt+P` → `Ctrl+Alt+P`）→ 立即生效、重启保留、插件无感；
4. 二次启动只唤起一个窗口；
5. `/shot` 热键 → 框选 → 粘贴到聊天窗口；
6. `/clip` 找回 10 分钟前的内容；密码管理器内容不入库；
7. `/cal new 明天下午三点开会` → 写入正确；
8. 断网 `/weather` → 8s 提示、15s 重试；
9. 关闭所有视图窗 → 内存回落；
10. 安装包覆盖升级 → 数据完整；
11. 卸载 → 用户数据保留、自启项清除。

### 8.3 发布门禁

- CI 全绿 + 手工清单通过 + CHANGELOG 有对应条目；
- 数据库迁移在"旧库副本"上演练通过；
- 回滚包（上一版本）可安装且能读新库（只增列，理论兼容；实测确认）。

---

## 9. 风险与回滚

| 风险 | 等级 | 缓解 | 回滚 |
|---|---|---|---|
| 图标协议成为路径探测面 | 中 | 仅 4 种扩展名、只回图标、限 64KB、失败 404 | 关闭协议 → 全量回退 emoji |
| 自动索引写入大量错误条目 | 中 | `source` 区分、隐藏不删除、可一键"清空自动收录" | 删除 `source='system'` 行 |
| 改键后与插件热键冲突 | 中 | 复用中央注册表、冲突返回占用方、失败回滚 | 恢复 `alt+space` |
| 插件 manifest 默认键与 `permissions` 不一致 | 低 | 加载期校验，只跳过该条并警告，不拒载插件 | 修正 manifest 后重启 |
| 热键 owner 从字符串改为结构体影响现有提示/单测 | 低 | 同步改提示文案与单测；保留旧格式解析 | 回退结构体改动 |
| 单实例插件影响开发调试 | 低 | `LL_ALLOW_MULTI=1` | 移除插件 |
| 剪贴板监听引发隐私质疑 | **高** | 默认可见开关、密码管理器排除、本地存储、可暂停、文档明示 | 关闭开关 → 回到按需快照 |
| 更新签名私钥丢失 | **高** | CI Secret + 离线备份 + 文档化轮换 | 手动分发安装包 |
| 自然语言误解析标题 | 中 | 只匹配开头、引号保护、预览胶囊确认 | 关闭该语法（设置项） |
| 迁移损坏 apps.db | **高** | 迁移前备份、幂等 ALTER、user_version | 用 `.bak-<ts>` 恢复 |
| CI 在 Linux 上编译失败 | 低 | 首版 Linux job 只跑 `cargo test` | 仅保留 Windows job |
| Windows GNU 工具链下宿主 debug 构建链接失败（`export ordinal too large`） | 中 | 本地冒烟用 release 构建；迁移逻辑已抽到 `ll-migrate` 可独立单测 | 临时把 crate-type 改为 rlib 仅用于冒烟，随后还原 |

---

## 10. 实施顺序与里程碑

### 第 1 周：地基 + 数据模型

- WP-00（LICENSE/版本/CI 骨架）
- WP-01 数据层：schema v2、迁移、扫描、拼音、排序（先不做 UI）

**交付**：`apps.db` 有全量应用；`/app` 能按 `wx` 搜到；CI 红灯可用。

### 第 2 周：图标 + 空状态

- WP-02 图标协议与缓存
- WP-03 欢迎窗 + 空状态三块

**交付**：0.2.0-alpha，5 名内部用户试用。

### 第 3–4 周：常驻能力 + 动作层

- WP-04 热键/自启/单实例/设置重构
- WP-04b 插件热键 manifest 化（依赖 WP-04 的中央注册表）
- WP-05 动作层 + footer
- WP-06 截图热键

**交付**：**0.2.0** 发布；开始收集 beta 反馈。

### 第 5–6 周：可信工具

- WP-07 剪贴板历史（先 Windows）
- WP-08 加载/超时/错误
- WP-09 自然语言时间

**交付**：**0.3.0** 发布。

### 第 7 周：治理

- WP-10 日志/内存/截图清理
- 根据 beta 反馈调整 P0 细节

### 第 8–10 周：可分发

- WP-11 安装包/签名/自动更新
- WP-12 发布流水线
- WP-13 文档重构

**交付**：**0.4.0** 发布（可公开下载）。

### 第 11 周起：减依赖与商业化

- WP-14 密钥加密
- WP-15 去 Python（第一批）
- WP-16 商业化文档

> 建议在 0.2.0 后插入一次"真实用户任务测试"（5 人，只看不说），再决定 0.3 的优先级。**不要等三个版本做完才找人用。**

---

## 11. 不做什么（范围控制）

| 不做 | 原因 |
|---|---|
| 贴图/长截图/OCR | 与 Snipaste/PixPin 正面竞争，投入大、非启动器核心；保持"截图够用" |
| 插件市场 | 需要审核、签名、分发、结算，0.4 前不具备条件 |
| 云同步/账号 | 与本地优先叙事冲突，且引入服务端成本 |
| 整体 UI 重做 | 现有视觉体系一致，问题在信息架构不在皮肤 |
| macOS 适配 | 多平台测试成本高；先把 Windows 做扎实 |
| 自研文件索引 | 已选 Everything SDK 路线，不再回头做 MFT |
| 广告/会员 | 与信任模型冲突，见 WP-16 |

---

## 12. 待确认（开工前需要拍板）

1. **目标平台**：0.2–0.4 是否只保证 Windows？（方案默认 Windows 优先，Linux 保留可编译与降级路径）
2. **更新通道**：GitHub Releases 是否可接受？仓库是否公开、owner/repo 是什么？
3. **剪贴板默认值**：默认开启（体验优先）还是默认关闭（隐私优先）？方案默认**开启 + 明确提示 + 可暂停**。
4. **Python 策略**：接受"先迁 5 个、保留 5 个"的过渡，还是一次性全部去 Python？
5. **发布节奏**：0.2.0 是否允许带"已知问题"先发 beta，还是必须等 P1 完成？
6. **插件热键的覆盖范围**：允许用户改成 manifest 未声明的任意键（推荐，用户优先），还是只允许在 `permissions` 声明的集合内选（安全优先）？

---

## 附录 A：新增/变更接口一览

| 类型 | 名称 | 说明 |
|---|---|---|
| 宿主命令 | `get_main_hotkey` / `set_main_hotkey` / `test_hotkey` | 主热键读写与试注册 |
| 宿主命令 | `plugin_hotkeys` / `set_plugin_hotkey` / `reset_plugin_hotkey` / `set_plugin_hotkey_enabled` | 插件热键列表、改键、恢复默认、启停 |
| manifest | `hotkeys[]`（`id/default/label/description/scope/editable/enabled`） | 插件热键声明（默认值，非用户偏好） |
| svc | `svc.shortcut.catalog` | `/hotkey` 读取宿主统一热键目录 |
| SDK | `ctx.shortcuts.bind(id, handler)` / `catalog()` | 按 hotkeyId 绑定，改键后无需重订阅 |
| 宿主命令 | `get_autostart` / `set_autostart` | 开机自启 |
| 宿主命令 | `open_welcome_window` / `reset_onboarding` | 引导 |
| 宿主命令 | `export_diagnostics` | 导出诊断 zip（用户选路径） |
| 协议 | `ll-icon://localhost/<path>` | 应用图标 |
| 插件方法（apps） | `import_system` / `rescan` / `suggest` / `record_launch` | 目录与排序 |
| 插件方法（clip） | `history.policy` 扩展 `source_app` / `excluded_apps` | 隐私策略 |
| SDK | `PanelItem.actions` / `PanelItem.kind` / `PanelItem.group` | 动作层与分组 |
| SDK | `SearchProvider.searchOnEmpty` | 空状态聚合 |
| SDK | `onSelect(item, actionId?)` | 次级动作（向后兼容） |
| 设置项 | `hotkey.main`、`autostart`、`onboarding.version`、`clip.watch`、`clip.excluded_apps`、`apps.catalog_version` | 持久化键 |

## 附录 B：数据库变更清单

| 库 | 变更 | 迁移方式 |
|---|---|---|
| `apps.db` | 7 个新列 + 2 个索引 | `PRAGMA user_version` 2；逐列 `ALTER`；迁移前备份；列级逻辑在 `ll-migrate` 可单测 |
| `clip.db` | `source_app` 列 | `ensure_clip_schema` 幂等 `ALTER` |
| `litelauncher.db` | 无结构变更（仅新设置键：`hotkey.main`、`hotkey.<pluginId>.<hotkeyId>`、`autostart`、`onboarding.version`、`clip.watch`） | 无需迁移 |
| 其他插件库 | 无 | — |
