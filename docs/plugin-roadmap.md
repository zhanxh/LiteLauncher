# LiteLauncher 常用插件规划（Plugin Roadmap）

>配套：[plugin-architecture-design.md](./plugin-architecture-design.md)（架构）、[plugin-development-guide.md](./plugin-development-guide.md)（开发指南）
> 目标：盘点"还有哪些常用插件值得做"，并按**当前宿主能力**区分"现在就能落地"与"要先扩宿主能力"。

---

## ⚠️ 状态说明（先读这里）

本文档 §0 / §1 / §6.2 / §7 写于 **2026-10-13 之前**，是当时的原始盘点。其中多处"❌ 缺"
已被后续实现推翻，**直接照着看会得出"做不了"的错误结论**。最新状态如下：

| 文档里写的（已过时） | 实际现状（2026-10-13 更新） |
|---|---|
| `ctx.clipboard` 缺 | ✅ 已实现（`clipboard:read/write`，`svc.clipboard.write/read`）；另有独立的 `clipboard:history` 权限供 `/clip` |
| `ctx.shortcuts` 缺 | ✅ 已实现（`shortcut:<accel>` 逐条白名单，宿主做冲突仲裁） |
| 屏幕捕获 `ctx.screen` 缺 | ✅ 已实现（`list/capture/pixel/cursor/savePng`） |
| "纯前端插件尚未实现" | ✅ 已实现（`backend.kind = "none"`，前端经 `svc.*` 调宿主；已有 21 个） |
| `ctx.fs` / `ctx.dialog` 缺 | ❌ **仍然缺**，但 `/find` 已绕开它：走 Everything SDK（见下） |
| `ctx.index` 缺 | ❌仍然缺 |
| `ctx.scheduler` 变通 | ❌ 仍然缺（现靠插件自实现） |

已落地的能力包分四组（A 纯计算 / B 系统信息 / C 网络 / D 屏幕与全局热键），
交互与市场对标另见 [plugin-ux-review.md](./plugin-ux-review.md)。

**`/find`（文件搜索）已落地，走 Everything 官方 SDK，不需要自己读 MFT**——
实测 `Everything64.dll`（91KB）经 sidecar 的 ctypes 调用，查询 10~25ms、免管理员、免 NTFS 限制。
判断依据：Everything 已经把 NTFS MFT + USN Journal 那套做好了，接它的成本远低于自研；
自己遍历做出来的东西打不过 Windows 搜索自身。
详见下方状态说明与 `plugins/find/`。

---

## 0. 结论先行

> ⚠️ 以下三条为**原始判断，已被推翻**。截图与取色器当时"做不了"，如今均已落地（见上方状态说明）。

1. **~~`截图` → 做不了~~** →✅ **已落地**：`/shot`（区域框选 / 整屏 / 延时 / 标注）+ `Alt+Shift+S` 免开启动器整屏截图。
2. **~~`取色器` → 卡宿主能力~~** → ✅ **已落地**：`/pick`（放大镜取色台，HEX/RGB/HSL）+ `Alt+P` 免开启动器取色。
3. **~~`hash64 md5 加密` → 现在就能做~~** → ✅ **已落地**：`/hash`（LLP 侧实现，因 WebCrypto 无 MD5）。
4. 剪贴板历史（Ditto 的核心能力）→ ✅ **已落地**：`/clip`，**隐私优先设计**（按需入库不后台监听、疑似凭据不落盘、条数/字节/过期三重上限）。

---

## 1. 宿主能力基线（决定插件能做什么）

> ⚠️ 现状列已于 2026-10-13 更新，见上方状态表；保留原表以便对照当时的规划。

| 能力句柄 | 权限 | 现状 | 备注 |
|---|---|---|---|
| `ctx.db` | `db` | ✅ 已实现 | 插件专属 SQLite |
| `ctx.windows` | `windows` | ✅ 已实现 | 独立窗口视图 + toast/预览胶囊 |
| `ctx.notify` | `notifications` | ✅ 已实现 | 系统通知 |
| `ctx.process` | `process` | ✅ 已实现 | 受控启动外部程序 |
| `ctx.settings` | `settings` | ✅ 已实现 | KV 设置（自动前缀隔离） |
| `ctx.secrets` | `secrets` | ✅ 已实现 | 密钥库（API Key） |
| `ctx.http` | `net:<host>` | ✅ 已实现 | 宿主代理 HTTP（含 SSE 流式） |
| `ctx.events` | 自动 | ✅ 已实现 | 后端 → 前端推送（流式/进度） |
| `ctx.log` | 无 | ✅ 已实现 | 生命周期日志 |
| `ctx.clipboard` | `clipboard:read/write` | ✅ **已补** | 原"缺"。`clipboard:history` 为独立权限 |
| `ctx.shortcuts` | `shortcut:<accel>` | ✅ **已补** | 原"缺"。逐条静态声明，宿主先到先得仲裁 |
| `ctx.screen` | `screen` | ✅ **已补** | 原"缺"。`list/capture/pixel/cursor/savePng`，坐标一律桌面全局物理像素 |
| `ctx.fs` / `ctx.dialog` | `fs:dir:<scope>` | ❌ **缺** | 文件搜索、保存截图到文件、选目录 |
| `ctx.index` | 无 | ❌ **缺** | 轻插件零后端接入裸文本全局搜索 |
| `ctx.scheduler` | `scheduler` | ⚠️变通 | 现靠插件内 `std::thread` 自实现（todo 即此模式） |

> 说明：**"纯前端插件"（`backend: none` + 宿主内置 `svc:*`）已实现**，`/shot` `/pick` `/clip` `/hotkey` 等21 个插件走的就是这条路。

---

## 2. 插件候选清单

### A 组 · 零宿主改动，纯计算/文本类（**立即可做，工作量 S**）

这一组是"启动器工具感"的来源，建议**一口气多做几个**，每个都是几十到百来行。

| 插件 | 触发词 | 能力依赖 | 说明 |
|---|---|---|---|
| 哈希与编码 | `/hash` | 无 | MD5 / SHA1 / SHA256 / Base64 / URL 编解码 / HTML 实体。（**你提到的那个**） |
| 文本处理 | `/text` | 无 | 大小写、命名风格（snake/camel/kebab/常量）、去重行、排序行、字数统计 |
| JSON 工具 | `/json` | 无 | 美化 / 压缩 / 校验 / 转义，面板实时预览 |
| 随机生成 | `/rand` | 无 | UUID v4、随机字符串、随机数、抛硬币/掷骰子 |
| 时间戳转换 | `/ts` | 无 | 时间戳 ↔ 日期、两个日期相差多久、当前时区 |
| 单位换算 | `/unit` | 无 | 长度/重量/面积/温度/存储/数据量；进制换算（2/8/10/16） |
| 颜色转换 | `/color` | 无 | HEX / RGB / HSL 互转（**纯转换部分现在就能做**；屏幕取色见 C 组） |
| 正则测试 | `/regex` | 无 | 输入正则+样本，高亮匹配组，附常用正则速查 |
| Cron 解析 | `/cron` | 无 | `0 9 * * 1-5` → 人类可读 + 下次触发时间 |
| 二维码 | `/qr` | 无（生成可离线） | 生成二维码（PNG/SVG）；解析需 `net:` 或本地库 |
| CIDR/网段 | `/cidr` | 无 | `192.168.1.0/24` → 掩码/可用地址段/广播地址 |

### B 组 · 需要 `db` / `settings` / `notify`（**立即可做，工作量 M**）

| 插件 | 触发词 | 能力依赖 | 说明 |
|---|---|---|---|
| 书签 / 快捷链接 | `/bookmark` | db, process | 常用 URL + 搜索模板，选中直接开浏览器 |
| 文本片段（Snippet） | `/snip` | db, clipboard* | 保存常用文本（邮箱签名/云盘链接），选中即复制 |
| 密码生成器 | `/pwd` | db/无, clipboard* | 生成强密码，可选存 `secrets`；强度可视化 |
| 快速记账 | `/cost` | db | `/cost new 午餐 25`，日/月汇总 |
| 番茄钟 / 倒计时 | `/pomo` | notify, thread | 借鉴 todo 的 `std::thread` 后台模式 |
| 世界时钟 | `/time` | 无 | 多城市当前时间一览 |
| 备忘速记 | `/memo` | db | 全局速记，配合 `index`（未实现）可进全局搜索 |
| 常用命令速查 | `/cheat` | db | 个人命令/快捷键小抄，可搜索 |

> `*` clipboard 未实现：短期可用前端复制或退化为"回填输入框"；补齐 clipboard 后统一升级。

### C 组 · 需要 `net:<host>`（**立即可做，依赖外部服务，工作量 M**）

| 插件 | 触发词 | 说明 |
|---|---|---|
| 天气 | `/weather` | 需选一个免费免密 API 并声明 `net:` 域名 |
| 汇率 / 行情 | `/fx` | 汇率、加密货币价格；可复用 ai 的配置模式 |
| 翻译 | `/tr` | 可走独立 API，或复用 `/ai` 的 secrets+http 通道 |
| 词典 / 单词 | `/dict` | 英汉查询、音标、例句 |
| 快递查询 | `/express` | 单号 → 物流轨迹 |
| 公共 IP / DNS | `/ip` | 查公网 IP、DNS 解析、Whois |
| 短链 | `/short` | 长链接转短链 |

### D 组 · 需要**先扩宿主能力**（桌面级，工作量 L）——**含你提的截图与取色器**

> **状态**：截图与取色器所需的宿主能力（`ctx.screen` + `ctx.shortcuts` + `svc.window.open`）**已全部落地**，
> `/shot` 与 `/pick` 已实现并通过测试 —— 详见 **§11 D 组落地记录**。
> 同组其余插件（剪贴板历史 / 文件搜索 / 热键速记）仍待 `fs`、`index`、后台剪贴板监听等能力。

| 插件 | 触发词 | 缺失的宿主能力 | 说明 |
|---|---|---|---|
| **截图** | `/shot` | ✅ 屏幕捕获 + 全局热键（已落地）；`fs`/`dialog` 仍未做 | 全屏/指定屏/延时截图已实现；**区域框选**待全屏透明遮罩 |
| **取色器** | `/pick` | ✅ 屏幕像素采样 + 全局热键（已落地） | 热键即时取色 + 浮动取色台（放大镜/历史/HEX·RGB·HSL）已实现 |
| 剪贴板历史 | `/clip` | clipboard:read + 后台监听 + db | 记录复制历史，搜索回填；隐私需谨慎（密码类要排除） |
| 文件快速搜索 | `/find` | ✅ 已落地（LLP + Everything SDK） | 原生语法 `ext:`/`size:`/`dm:`，毫秒级 |
| 全局热键速记 | `/hotkey` | ✅ shortcuts（已落地） | 任意窗口一键唤起速记弹窗 —— 现在只差一个插件 |
| 系统信息 | `/sysinfo` | 无（LLP 已有示例） | 已存在，可作为 LLP 插件模板 |

---

## 3. 你提到的三项 · 专项评估

### 3.1 哈希与编码 `/hash` —— ✅ 现在就能做（建议第一批）

- **本质**：无副作用纯函数，不需要任何宿主句柄，be crate 里用 `md-5` / `sha1` / `sha2` / `base64` 即可；前端负责输入解析与结果面板。
- **关于 "hash64"**：字面看可能指 **Base64**（编码，非加密）或把"哈希 + Base64"混说。建议**一并支持**：`/hash md5|sha1|sha256` + `/hash b64e|b64d|urlenc|urldec`，覆盖两种理解，成本极低。
- **体验设计**：无需子命令——直接 `/hash 待处理文本`，面板**同时列出所有算法结果**，回车复制选中项（依赖 clipboard 未实现时先回填输入框）。
- **工作量**：约半天。可作为"插件脚手架"打通后的第一个样板插件。

### 3.2 截图 `/shot` —— ⚠️ 不是插件问题，是宿主能力缺口

- **缺什么**：LPS-1 里**没有任何屏幕捕获句柄**。截屏需要宿主新增一个服务（如 `ctx.screen`），底层通常是 `xcap` / `screenshots` crate（跨平台截屏）+ 一个全屏遮罩选区窗口 + 图片编码（`image` crate）。
- **还缺**：**全局热键**（`Alt+Shift+A` 之类）。否则用户要先唤起启动器再敲 `/shot`，此时焦点已在启动器上，"截其他窗口"的动机会被破坏。
- **此外**：保存/复制需要 `clipboard:write` 与 `fs`/`dialog`（选保存路径）——这三项全都未实现。
- **结论**：截图是一个 **"宿主能力包 + 插件"** 的组合工程，不是单写一个插件目录能搞定的。建议作为独立里程碑。
- ✅ **已落地（§11）**：`ctx.screen`（xcap + image）+ `ctx.shortcuts`（全局热键）已补齐，`/shot` 支持全屏 / 指定显示器 / 3s·5s 延时，截图前自动隐藏启动器，路径进剪贴板，可交系统查看器打开。**区域框选**未做（需全屏透明遮罩，`ViewSpec` 缺声明位）。

### 3.3 取色器 `/pick` —— ⚠️ 同上，且更依赖全局热键

- **缺什么**：需要宿主提供"**读取屏幕任意坐标像素颜色**"的能力（通常与截屏同一底层：先抓屏缓冲，再采样）。UI 上还要一个跟随鼠标的放大镜 + 十字光标。
- **硬约束**：**没有全局热键就做不成**——取色的对象是"屏幕上的其他窗口"，用户不可能先打开启动器再取色。
- **结论**：与截图**捆绑在同一宿主能力里程碑**里做，共享屏幕捕获层，边际成本低。
- ✅ **已落地（§11）**：`svc.screen.pixel`（含放大镜方格）+ `ctx.shortcuts`（`alt+p`）已补齐。实现为"热键即时取色 + 右下角浮动取色台（放大镜、鼠标移入冻结、HEX/RGB/HSL、历史色板）"；**全屏遮罩式取色**未做（同缺 `ViewSpec` 的 fullscreen/transparent 声明位）。

---

## 4. 需要先补的宿主能力（Capability Backlog）

按"解锁的插件数量 / 成本"排序，建议优先级如下：

| 优先级 | 能力 | 解锁的插件 | 成本 | 备注 |
|---|---|---|---|---|
| ✅ P0 | `ctx.clipboard`（write/read 分开授权） | 哈希复制、片段、密码、**剪贴板历史**、截图 | 低 | 已落地（§9.2） |
| ✅ P0 | `svc:*` 纯前端插件形态 | 上面 A 组一大批变成"单文件 TS + manifest" | 中 | 已落地（§9.4） |
| ✅ P1 | `ctx.shortcuts`（全局热键 + 冲突仲裁） | 截图、取色器、速记 | 中 | 已落地（§11.1） |
| ✅ P1 | 屏幕捕获服务（`ctx.screen`） | **截图、取色器** | 高 | 已落地（§11.1）；选区窗口因缺 fullscreen/transparent 声明位未做 |
| P2 | `ctx.fs` + `ctx.dialog` | 文件搜索、截图另存为 | 中 | 声明式作用域 + 选择即授权 |
| P2 | `ctx.index`（共享 FTS） | 书签/片段/备忘进全局搜索 | 中 | 让轻插件零成本参与裸文本搜索 |
| P3 | `ctx.scheduler` 正式化 | 番茄钟、定时类 | 低 | 现可用 `std::thread` 变通 |

---

## 5. 建议实施批次

**批次 1（现在就能上，1–2 周）——"工具箱季"**
`/hash`、`/text`、`/json`、`/rand`、`/ts`、`/unit`、`/color`、`/cidr`
配一个 `create-plugin` 脚手架，批量产出，把设置面板与 `/help` 迅速填满。
> 目的：用低成本插件验证"新增插件 = 建目录 + 改两处声明"的流程是否真的顺滑。

**批次 2（能力包 A，1 周）——`clipboard` + `svc:*`**
补齐剪贴板句柄与纯前端插件形态，顺手把批次 1 的复制体验全部升级；上线 `/bookmark`、`/snip`、`/pwd`。

**批次 3（能力包 B，1–2 周）——全局热键 + 屏幕捕获**
一次补齐 hotkey 与 screen capture，随后上 **`/shot`（截图）**、**`/pick`（取色器）**、**`/clip`（剪贴板历史）** 三件桌面级插件。

**批次 4（按需）——网络类与文件类**
`/weather`、`/fx`、`/tr`、`/dict`（依赖 `net:`）—— 均已落地；`/find`（走 Everything SDK，不依赖 `fs`）也已落地。

---

## 6. 插件实现形态选型：编译期插件（Rust）vs 外部插件（LLP）

**前提：一切皆插件**——功能不得硬编码进壳层/宿主，必须经 `manifest.json` + 注册表接入。这是本项目的不变量，下面的选型只涉及**插件后端的落地形态**。

> **术语对齐（避免歧义）**
> 本仓库文档中的**"编译期内置插件"特指 `plugins/*/be` 这种随主程序一起编译、由 `src-tauri/src/lib.rs` 注册的 Rust 插件**（见开发指南 §1「插件后端与宿主编译期内置」）。它与**"外部插件（LLP sidecar，独立安装）"**相对。
> 二者**都是插件**、共用同一套 manifest 标准 / 权限门控 / 注册表 / 前端契约，**唯一区别是"后端是否编译进主程序"**。所以"做插件"与"选 Rust 还是 Python"是两个正交的问题。

### 6.1 两种形态的工作量与约束

| 维度 | 编译期插件（Rust be crate） | 外部插件（LLP sidecar） |
|---|---|---|
| 参考实现 | `plugins/{todo,apps,notes,ai}` | `plugins/sysinfo` |
| 新增文件 | manifest + `be/Cargo.toml` + `be/src/lib.rs` + `fe/package.json` + `fe/src/index.ts` + 业务 `.ts` ≈ **7+ 个** | `manifest.json` + sidecar 脚本 = **2 个** |
| 宿主接线 | 改 **3 处**：根 `Cargo.toml` members、`src-tauri/Cargo.toml` deps、`src-tauri/src/lib.rs` register | **零改动**，`npm run plugin:install -- <id>` 拷贝目录即装 |
| 是否重编译主程序 | **要**（Rust release 编译慢） | **不要**（拷目录 + 重启即生效） |
| 前端代码 | 必须写 `fe/` | **零**——`src/core/externalPlugins.ts` 按 manifest 的 `command` 声明自动生成通用 `CommandPlugin` |
| 参数如何到后端 | 前端 `ctx.call(method, params)` 自定义 | 自动映射：execute→`{raw, subcommand, args, namedArgs}`、search→`{keyword, subcommand, args}`、select→`{id, metadata}` |
| 后端语言 | **仅 Rust** | **任意语言**——`backend.entry` 指向可执行文件即可（文档明示支持 `node` 这类裸名、绝对路径） |
| 运行时依赖 | **无**（单 exe 自包含） | 取决于 entry：Python 脚本要目标机有 Python 3（宿主 6 级探测 + 设置面板可配 + `LLP_PYTHON`）；若是自带二进制的 sidecar 则无依赖 |
| 调用开销 | 进程内直接调用，μs 级 | 懒启动后进程常驻，往返 ms 级；**冷启动要 spawn 进程** |
| 并发/超时 | 无限制 | LLP/1 MVP **串行会话 + 5s 超时**，不适合长任务 |
| 自定义 UI 窗口 | 支持（manifest `views` + 独立窗口视图） | **不支持**（MVP 边界：外部插件自定义 UI 未实现） |
| 崩溃影响 | 与宿主同进程 | **隔离**——sidecar 崩溃只影响该插件 |
| 分发方式 | 整体替换 exe | 独立分发，用户安装目录可覆盖便携版本 |

> **关键澄清**：**LLP ≠ Python**。LLP/1 的 `backend.entry` 可以是任意可执行文件，所以"外部插件"也可以由 **Rust 编译出的独立二进制**承担（零运行时依赖）。反之，"用 Rust"也不等于"必须编译进主程序"——只是当前仓库里的 4 个 Rust 插件都是编译期形态。

### 6.2 判定规则

- **选编译期插件（Rust crate）**：要无缝、要自定义窗口 UI、要长任务/复杂状态、要极致调用性能。
- **选外部插件（LLP）**：要独立分发、要免重编译迭代、要支持第三方/用户自写、需要崩溃隔离。
- **后端语言**：外部插件用 **Python** 最快（标准库 + 零编译）；但对**绿色版/便携分发**而言，"要求用户装 Python" 是重隐式依赖，此时可改为 **Rust 编独立 sidecar 二进制**。
- **最佳长期解**：设计文档 §4.6 的 **`svc:*` 纯前端插件形态**——纯计算小工具收敛为"单文件 TS + manifest"，Rust 和 Python 都不用写，也无需重编译主程序。**但当前尚未实现。**

### 6.3 对本项目（`/hash` 这类纯计算工具）的建议

以"一切皆插件"为前提，`/hash` 有两条路，**取决于你更痛恨哪一个代价**：

| 方案 | 代价 | 收益 |
|---|---|---|
| **A. 编译期插件（Rust crate）** | 7+ 文件 + 3 处接线 + **每次改动重编译主程序** | 零依赖、单 exe、可自定义 UI、调用最快 |
| **B. 外部插件（LLP + Python）** | **依赖目标机有 Python 3** | 2 个文件、零前端代码、**不改主程序**、可独立分发 |

- **若插件必须是"可独立安装、不动主程序"** → 选 **B（LLP + Python）**，简单插件的默认答案。这是最贴合"插件化"目标的做法。
- **若必须零运行时依赖 / 要进绿色单 exe** → 选 **A**，或选 **B 但把 sidecar 写成 Rust 独立二进制**。
- **务实流程**：先用 **B 试水 UX**（2 个文件当天能跑），交互定型后再决定是否移植为 A。
- **真正的省事路径**：推动 `svc:*` 纯前端形态落地——届时 `/hash` 就是一个 TS 文件 + manifest，既不用 Rust 也不用 Python，更不用重编译。

### 6.4 一句话决策

> **"一切皆插件"是铁律；"Rust 还是 Python"只是插件后端的语言选择。**
> 外部插件默认 Python 最省事（代价：Python 依赖）；编译期插件只能 Rust（代价：重编译主程序）。

---

## 7. 一句话总结

- **能马上做的**：全部"纯计算/文本/换算"类（含你要的 **哈希 md5**）＋ 带 db 的个人工具 ＋ 声明 `net:` 的网络类。
- **要先动宿主的**：**截图、取色器**（+ 剪贴板历史），它们的瓶颈是 `clipboard` / `shortcuts` / 屏幕捕获三个未实现的句柄，尤其是**全局热键**——没有它，桌面级插件无从谈起。
- **性价比最高的一步**：先落 `ctx.clipboard` 与 `svc:*` 纯前端形态，一次性解锁一大片轻插件。
- **形态选择**：要独立分发 → 外部插件（LLP，Python 最快）；要零依赖/自定义 UI → 编译期插件（Rust crate）；长期等 `svc:*` 纯前端收口。

---

## 8. 落地记录：A / B 组（已实现）

已按"一切皆插件"原则，将 A、B 两组共 **19 个插件**实现为**外部插件（LLP/1 + Python sidecar）**——每个仅 `manifest.json` + 单文件脚本，自包含（仅标准库），**零宿主改动**。

- A 组（11）：`hash` `text` `json` `rand` `ts` `unit` `color` `regex` `cron` `cidr` `qr`
- B 组（8）：`bookmark` `snip` `pwd` `cost` `memo` `cheat` `time` `pomo`

配套：`npm run plugin:test`（LLP 冒烟测试）、`npm run plugin:install`（支持 `--all`）、壳层新增通用 `AfterSelect.copy`（工具类插件的"选中即复制"）。

### 8.1 实测得到的关键约束（比文档更严）

宿主 `handle_svc` 的 `svc.*` 白名单**仅 7 个方法**：

| 方法 | 权限 | 说明 |
|---|---|---|
| `svc.db.execute` | `db` | **仅放行 DML**（insert/update/delete/replace） |
| `svc.db.query` | `db` | 仅 select/with |
| `svc.notify.send` | `notifications` | 系统通知 |
| `svc.process.launch` | `process` | 启动程序 / 打开 URL |
| `svc.settings.get` / `set` | —（不门控） | KV |
| `svc.log.write` | — | 日志 |

由此产生的三条硬约束：

1. **外部插件无法建表**：`svc.db.execute` 拒绝 DDL，且**没有 `svc.db.migrate`** → 因此 B 组的持久化改用 `svc.settings` 存 JSON 列表（插件私有命名空间）。
2. **外部插件无法发 HTTP**：没有 `svc.http` → 网络类（C 组）目前只能借道浏览器（如 `/qr` 生成链接后用 `svc.process.launch` 打开）。
3. **会话串行 + 5s 超时**：不适合长任务；异步推送（`/pomo` 到点通知）采用"后台线程只写不读 + 主循环丢弃非 call 行"的方式实现。

### 8.2 能力补齐（✅ 已全部落地，详见 §9）

| 优先级 | 能力 | 解锁 | 状态 |
|---|---|---|---|
| P0 | `svc.db.migrate` | 外部插件得以建表（B 组可迁回 SQLite） | ✅ 已落地 |
| P0 | `svc.clipboard.write` / `read` | 复制改为宿主原生，摆脱对 webview 剪贴板的依赖 | ✅ 已落地 |
| P1 | `svc.http.send`（`net:` 白名单） | 解锁 C 组全部网络插件 | ✅ 已落地 |
| P1 | `svc:*` 纯前端插件形态 | A 组收敛为"单文件 TS + manifest"，免 Python 依赖 | ✅ 已落地（A 组 8/11 已收敛） |
| P2 | fs / dialog 句柄 | 文件类插件（D 组） | ⬜ 未做 |

---

## 9. 能力补齐落地记录（本轮实现）

四项补齐全部完成，且**统一收敛到同一份 `svc.*` 分发器**（`ll-host/src/services.rs::dispatch_svc`），宿主侧两条路径共用：

```
LLP sidecar ──stdio 反向请求──┐
                              ├──> dispatch_svc(ctx, method, params) ──> 门控服务实现
前端 ctx.call('svc.*') ──────┘        （按 manifest.permissions 决定的 ctx 句柄）
```

这样"带后端插件"与"纯前端插件"看到的能力**逐方法一致**，插件形态与能力集合彻底解耦。

### 9.1 `svc.db.migrate`

```jsonc
// 请求
{"method": "svc.db.migrate", "params": {"statements": ["CREATE TABLE IF NOT EXISTS t (...)"]}}
// 响应：null（失败抛 PluginError::db）
```

底层直接调 `DbApi::migrate`（`execute_batch`），**只对插件自己的库**生效（`plugin_conn` 指向 `plugins/<id>/<id>.db`），故放行 DDL 无越权风险。幂等仍由插件自理（`IF NOT EXISTS` / `user_version`）。

### 9.2 `svc.clipboard.write` / `read`

- 新增 `ll_plugin_api::ClipboardApi` trait + `PluginContext.clipboard` 句柄；
- 宿主实现 `HostClipboardApi`，走 **`tauri-plugin-clipboard-manager`（底层 arboard）**，不用 webview 的 `navigator.clipboard`；
- **写/读分别授权**：`clipboard:write` / `clipboard:read`（读会暴露密码、验证码，风险不同级）；
- 壳层的"选中即复制"同步切到宿主原生命令 `clipboard_write`（`AfterSelect.copy` 的落点）。

> 为什么必须原生：`navigator.clipboard.writeText` 要求页面处于聚焦状态，而"选中即复制"通常**紧接着就隐藏窗口**，异步竞态下极易被策略拒绝。

### 9.3 `svc.http.send`

```jsonc
{"method": "svc.http.send",
 "params": {"method": "POST", "url": "https://api.x.com/v1/y",
            "headers": {"Authorization": "Bearer …"}, "body": "{\"q\":1}"}}
// 响应：{"status": 200, "body": "…"}
```

- 仍走 `HttpApi` + `net:<host>` 域名白名单（逐域名精确匹配），可审计可限流；
- `headers` 同时接受 `{"K":"V"}` 与 `[["K","V"]]` 两种写法（Python/JS 各自顺手的形式）；
- 实现上借道 `send_stream` 收集全文，**顺带拿到状态码**（`HttpApi::send` 只回响应体）。

### 9.4 `svc:*` 纯前端插件形态（`backend.kind = "none"`）

三处改动协同，缺一不可：

| 层 | 改动 |
|---|---|
| 宿主 | ① `plugin_call` 把 `svc.*` 当**保留方法名空间**优先拦截，不查插件后端分发表；② 新增 `SvcBackend`，`register_external_plugins` 接受 `kind == "none"`；③ `HostState::svc_context` 组装门控上下文 |
| SDK | `ctx.settings` / `ctx.clipboard` / `ctx.log` / `ctx.notify` / `ctx.events` 同名属性，是 `svc.*` 的语法糖 |
| 工具 | `install-plugin` / `deploy-portable-plugins` 支持 `kind=none`（**只部署 manifest**）；新增 `plugin:test:fe` |

**权限门控怎么保证不塌陷**（关键设计）：

- 已注册插件（其 manifest 在宿主的插件目录里）→ 按 `manifest.permissions` 正常门控；
- 未注册插件（随前端包编译进来、宿主扫不到 manifest）→ 退回 **`shell_safe_manifest`**：只放行 `settings / clipboard:write / clipboard:read / notifications / events`，**db / process / net 一律不授予**，因此不存在"无 manifest 即无门控"的漏洞。

> 这也是**权限门控与纯前端插件并存的关键取舍**：`/qr` 需要 `process` 权限打开浏览器，其收益**恰恰依赖 manifest 能被宿主读到**——所以本轮同时让宿主在**开发期自动扫描仓库 `plugins/`**（`#[cfg(debug_assertions)]`），生产期则由 `deploy-portable-plugins` 把 manifest 放进 `release/plugins/`。

### 9.5 A 组收敛结果

| | 形态 | 插件 |
|---|---|---|
| 已收敛为纯前端（8） | `none` + `fe/src/index.ts` | `text` `json` `rand` `ts` `unit` `color` `regex` `qr` |
| 仍为 LLP/Python（3） | `llp` + sidecar | `hash`（WebCrypto 无 MD5，且 `crypto.subtle` 依赖安全上下文）、`cron`、`cidr` |

三个保留项的共同点：**算法密集或依赖运行时不提供的标准库**。这也是纯前端形态的适用边界——纯计算、文本、换算类最划算；密码学/日期迭代/位运算密集的实现，留在 Python 反而更省事。

### 9.6 验证

- `cargo check --workspace` 通过；
- `tsc --noEmit` 通过（含 8 个新前端插件包）；
- `npm run plugin:test` → **12/12**（LLP：hash/cron/cidr + B 组 8 + sysinfo）；
- `npm run plugin:test:fe` → **8/8**（断言真实计算结果：`/unit hex 255 → 0xff`、`/ts 1700000000 → 2023-11-14 22:13:20 UTC`、`/color #ff8800 → hsl(32,100%,50%)`、`/regex (\d{3})-(\d{4})` 分组捕获等）；
- `node tools/deploy-portable-plugins.mjs` → 20 个外部插件（12 LLP + 8 纯前端 manifest）就位。

---

## 10. C 组落地记录（网络类插件，纯前端）

上一轮补齐 `svc.http.send` 后，C 组不再需要 Python——**5 个网络插件全部做成纯前端 TS**（`backend.kind = "none"` + `net:<host>` 白名单），**零宿主改动、零重编译、零运行时依赖**。

### 10.1 服务可用性实测（决定取舍）

| 候选 | 实测 | 处置 |
|---|---|---|
| wttr.in（天气） | ✅ 200 | 采用 → `/weather` |
| open.er-api.com（汇率） | ✅ 200（`time_eol_unix = 0`，无停服风险） | 采用 → `/fx` |
| ipwho.is（IP 归属） | ✅ 200 | 采用 → `/ip` |
| api.dictionaryapi.dev（英文词典） | ✅ 200 | 采用 → `/dict` |
| api.mymemory.translated.net（翻译） | ✅ 200 | 采用 → `/tr` |
| api.ipify.org / myip.com / ipapi.co | ❌ 000 / 403 | 弃用 |
| api.coingecko.com（加密行情） | ❌ 000 | **`/crypto` 暂缓** |
| translate.googleapis.com | ❌ 000 | 弃用（改用 MyMemory） |
| tinyurl / cloudflare-doh / dns.google | ❌ 000 | **`/short`、`/dns` 暂缓** |
| 快递 API（kuaidi100 等） | 需 API Key | **`/express` 暂缓** |

> "❌ 000" 多为连接被拒/超时，不代表服务本身不可用，只影响**本轮取舍**。网络可达性因环境而异。

### 10.2 关键设计：网络插件范式（避免逐键打 API）

壳层对 `query()` 是**逐键调用且无防抖**的（`App.tsx` §3.2 直接 `plugin.query(...)`）。因此网络插件**绝不能把请求放进 `query`**。统一范式：

```
query(input)     → 命中缓存则渲染结果；否则只渲染一条「查询」项（metadata.fetch = 缓存键），不发请求
onSelect(查询项)  → 真正抓取（ctx.http.json / send）→ 写入缓存 → 返回 { refresh: true }
query(input)     → 壳层据 refresh 重跑本插件 query → 命中缓存 → 面板就地刷新
onSelect(结果项)  → 返回 { copy: metadata.value }（壳层通用复制）
```

- 缓存键 = 规范化查询（天气为城市；汇率为 `金额|基准|目标`；翻译为 `src|tgt|text`）；
- TTL：天气/汇率 5 分钟，IP 10 分钟，词典/翻译 30 分钟；
- 用 `svc.http.send` 而非只回 body 的封装，`/dict` 才得以区分「404 未收录」与「网络异常」。

### 10.3 SDK 补 `ctx.http`

`lps.ts` 新增 `PluginContext.http`，与既有 `settings/clipboard/log/notify/events` 同构：

| 方法 | 说明 |
|---|---|
| `http.send({method,url,headers,body})` | 原始请求，返回 `{status, body}`（需按状态码分支时用） |
| `http.get(url, headers?)` | GET 简写 |
| `http.json<T>(url, headers?)` | GET + 解析；非 2xx 或非法 JSON 抛带状态码与片段的可读错误 |

权限仍由宿主按 manifest 的 `net:<host>` 逐域名门控；**纯前端插件同样适用**（已注册即正常门控，未注册退回 `shell_safe_manifest`，不含 net）。

### 10.4 落地清单

| 指令 | 数据源 | `net:` 权限 | 备注 |
|---|---|---|---|
| `/weather` | wttr.in | `net:wttr.in` | 自建英文天气词 → 中文映射（服务端 `lang=zh` 实测未翻译） |
| `/fx` | open.er-api.com | `net:open.er-api.com` | 「金额/基准/目标」换算 + 「列出主要货币」两模式 |
| `/ip` | ipwho.is | `net:ipwho.is` | 归属地 / 运营商 / ASN / 时区 / 坐标 |
| `/dict` | dictionaryapi.dev | `net:api.dictionaryapi.dev` + `process` | 音标/词性/释义/例句；发音交浏览器播放 |
| `/tr` | MyMemory | `net:api.mymemory.translated.net` | 自动识别源语言（CJK→中，否则英）；超额度给出明确提示 |

### 10.5 验证

- `npm run plugin:test:fe` → **13/13**（新增 weather/fx/ip/dict/tr 的「查询→抓取→刷新」驱动式用例，断言真实解析结果：`Sunny → 晴`、`100 USD = 670.582 CNY`、`AS15169`、`/həˈləʊ/`、`你好世界`，以及 dict 的 404 分支）；
- `npm run plugin:test` → **12/12**（LLP 未受影响）；
- `tsc --noEmit` 通过；`deploy-portable-plugins` → **25 个**（12 LLP + 13 纯前端 manifest）。

### 10.6 仍未做

- `/short`、`/dns`、`/crypto`、`/express`：依赖服务在当前环境不可达或需 API Key；
- **P2 的 `fs` / `dialog` 句柄**：文件类插件的前置；
- **D 组桌面级**：见 §11 —— 已落地。

---

## 11. D 组落地记录（屏幕捕获 + 全局热键，本轮实现）

`/shot`（截图）与 `/pick`（取色器）此前卡在两项宿主能力上。本轮把能力补齐并直接交付了两个插件。

### 11.1 两项新宿主能力

| 能力 | 权限 | 句柄 | 实现 |
|---|---|---|---|
| 屏幕捕获 | `screen` | `ctx.screen` | `xcap` 0.9 跨平台枚举显示器/抓帧；`image`(png) 落盘；Tauri `AppHandle::cursor_position()` 读全局光标 |
| 全局热键 | `shortcut:<accel>` | `ctx.shortcuts` | `tauri-plugin-global-shortcut` + 宿主自建冲突仲裁表 |

`shortcut:<accel>` **逐条声明、无通配**（与设计文档 §4.5 对 `env:` 的口径一致）。要几个键就声明几条，例如 `/pick` 声明 `shortcut:alt+p`。

### 11.2 `svc.*` 新增方法

| 方法 | 参数 | 返回 |
|---|---|---|
| `svc.screen.list` | — | `[{index,name,primary,x,y,width,height,scaleFactor}]` |
| `svc.screen.cursor` | — | `{x,y}` |
| `svc.screen.pixel` | `{x?,y?,radius?}` | `{sample:{x,y,r,g,b,hex}, grid?}`；`x/y` 缺省=当前光标；`radius` 存在时另附放大镜方格 |
| `svc.screen.capture` | `{monitor?,path?,hideWindows?,delayMs?}` | `{path,width,height,monitor,bytes}` |
| `svc.shortcut.register` / `unregister` / `list` | `{accel}` | `null` / `null` / `["alt+p"]` |
| `svc.window.open` | `{view,params?}` | `null`（纯前端插件**唯一**的开窗途径） |

`monitor` 约定：`-1` = 光标所在那块屏，`0..n` = 序号，缺省 = 主显示器。多屏用户的"全屏"直觉就是 `-1`。

### 11.3 关键设计（比"能跑"更要紧的部分）

**① 坐标系**：对外一律**桌面全局物理像素**（与 `getCurrentWindow().outerPosition()` 同一坐标系，也与 `svc.screen.cursor` 一致）。但 `xcap::Monitor::capture_region` 要的是**显示器内相对坐标（u32）**，所以宿主内部先做 `hit_rect` 命中测试定位显示器，再减显示器原点——这层换算若散在插件里必然出错。

**② 截图避让启动器**：`hideWindows: true` 时宿主先隐藏**所有可见的 LiteLauncher 窗口**（主窗 + 视图窗），多等 160ms 让合成器把窗口从画面摘掉，截完复原并回焦。否则"截图工具截出自己"是必然的。`delayMs` 宿主侧硬上限 10 秒（防止插件把工作线程长期占住）。

**③ 放大镜不传图片**：`radius` 模式返回的是 `#RRGGBB` 数组而非 PNG/base64——省掉一次编码与 base64 往返（约 33% 膨胀），前端用 CSS 网格铺出来天然就是硬边像素放大效果。半径上限 32（65×65=4225 格），贴屏幕边缘时自动裁剪并回传 `cols/rows/center`，中心格永远指向真正的采样点。

**④ 热键不回调插件代码，而是广播事件**：宿主按 `shortcut:<accel>` 放行 → 登记到进程级 `accel → pluginId` 表（先到先得，冲突返回 `conflict`）→ 真正注册到系统 → 触发时 `emit("plugin-shortcut", {pluginId, accel})`。插件（尤其纯前端形态）注册的是"听事件"，拿不到原始按键流。**注册解析失败或挂系统失败都回滚登记**，否则这个键会被永久占住。

**⑤ 权限校验先于宿主句柄校验**：`register()` 里先查 `shortcut:<accel>` 白名单再看 `AppHandle` 是否就绪——manifest 配错在任何环境（含 headless）下都该报准，也让这条规则可被单测覆盖。

**⑥ 视图窗口必须在 capabilities 里登记**：Tauri 能力文件的 `windows` 是**显式窗口标签白名单**（标签 = `<pluginId>-<viewId>`）。新增 `pick-panel` 若不登记，该窗口权限为零 → `plugin_call` 直接被拒、面板变死窗。本轮已加 `pick-*`，并补 `core:window:allow-outer-position` / `allow-outer-size`。

**⑦ SDK `ctx.shortcuts.on` 的 `scope` 默认 `main`**：每个窗口加载都会把全部插件的 `setup()` 跑一遍，不区分上下文的话，打开任意视图窗口后热键会被**执行两次**（主窗一次、视图窗一次）。默认只在无 `?view=` 的主窗口生效，取色台这类需要自己响应热键的视图显式传 `{scope:'any'}`。

**⑧ 取色台的"冻结"**：面板持续采样鼠标所在像素并实时显示放大镜；光标一旦移进面板就停止采样（否则采到的是面板自己的颜色，用户反而没法"点一下复制"）。判定方式是 `outerPosition/outerSize` 与 `svc.screen.pixel` 回传的采样坐标比对——**一次宿主调用同时拿到位置、颜色与放大镜**，不额外多打一轮 `cursor`。

### 11.4 两个插件

| 指令 | 交互 | 权限 |
|---|---|---|
| `/shot` | 主项（光标所在屏）+ 每块屏一条 + 3s/5s 延时档位；截完复制路径、面板自动刷新出「打开 / 打开所在文件夹 / 复制路径」。全局热键 `alt+shift+s` 免开启动器直接截图，结果用系统通知反馈 | `screen` `clipboard:write` `notifications` `settings` `process` `shortcut:alt+shift+s` |
| `/pick` | 全局热键 `alt+p` 取光标处颜色 → HEX 进剪贴板 + 通知；`/pick` 另给「取光标处颜色」「打开浮动取色台」「最近取色（HEX/RGB/HSL 可切换复制）」「清空历史」 | `screen` `clipboard:write` `notifications` `settings` `windows` `shortcut:alt+p` |

取色历史存插件私有 KV（`pick.history`，上限 12、自动去重置顶），取色台窗口与主窗口是两个 JS 上下文，靠这份 KV 共享数据；面板开关状态也走 KV（`pick.panelOpen`），主窗口热键处理器据此让位，避免一次按键既复制又关窗。

### 11.5 验证

- `cargo check --workspace --all-targets` 通过（新增 `xcap` / `image` / `dirs` / `tauri-plugin-global-shortcut` 依赖）；
- `tsc --noEmit` 通过；
- `npm run plugin:test:fe` → **15/15**（新增 shot/pick 用例：断言"默认截光标所在屏 = -1"、副屏尺寸来自 `svc.screen.list`、`-d3 → 3000ms`、`hideWindows === true`、路径进剪贴板、`svc.window.open(view=panel)`、以及 `#FF8800 → rgb(255, 136, 0) / hsl(32, 100%, 50%)` 的换算与历史读写闭环）；
- `npm run plugin:test` → **12/12**（LLP 未受影响）；
- `deploy-portable-plugins` → **27 个**（12 LLP + 15 纯前端 manifest）。
- Rust 侧新增 `normalize_accel` / `hit_rect` / 热键白名单单测（⚠️ 见 §11.6）。

### 11.6 已知问题与仍未做

- ⚠️ **Rust 单测在本机跑不起来**：`cargo test -p ll-host` 的测试二进制在加载期报 `STATUS_ENTRYPOINT_NOT_FOUND`（0xc0000139），属 Windows 链接/加载环境问题，与业务逻辑无关；`cargo check --workspace --all-targets` 正常。项目既有的门禁是 `npm run check`（`cargo check` + `tsc`），未包含 `cargo test`。
- ❌ **全屏遮罩式取色**（PowerToys 那种整屏放大镜）：`ViewSpec` 目前没有 `fullscreen` / `transparent` 声明位，宿主也没有"窗口跟随光标"的能力，所以取色台做成固定右下角的悬浮面板。
- ❌ **区域框选截图**：需要全屏透明遮罩 + 拖拽选区，依赖同上。
- ❌ **`ctx.fs` / `ctx.dialog`**：文件选择类插件的前置，仍未做。


