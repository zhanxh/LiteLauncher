# 方案设计：框架文件读写能力（svc.fs.*）与 /hash 文件哈希

- 创建时间：2026-11-10
- 状态：✅ 已完成（2026-11-10）
- 关联计划：`docs/plans/20261110_095401_fs-capability-hash-file.md`（本地留痕）

## 背景与目标

`/hash` 目前只对**输入字符串**做哈希（WP-15 迁到 WebView 的纯前端实现）。用户需要
"输入文件路径 → 直接得到文件内容的哈希"。插件前端没有文件 IO 途径：

- WebView2 拒绝页面 `fetch('file:///…')`（跨源，`lps.ts` 的 `screen.readPng` 注释已记载）；
- 宿主 `svc.*` 保留名空间目前没有通用文件读写（只有 `screen.readPng/savePng` 这类**限定目录**的特例）。

目标：按用户拍板的方向，把**文件读写**做成与 `svc.db.*`（SQLite 读写）、`svc.window.*`
（UI 创建）同级的框架能力；`/hash` 申请 `fs:read` 后即可对任意文件算哈希。

## 方案

### 1. 契约（ll-plugin-api）

新 trait `FsApi` + 结果结构体（camelCase 序列化），`PluginContext` 增
`pub fs: Option<Arc<dyn FsApi>>`：

| 方法 | 权限 | 语义 |
| :--- | :--- | :--- |
| `stat(path)` | fs:read | 存在性/类型/大小/_mtime；不存在返回 `exists:false`（不报错） |
| `read_text(path, max_bytes)` | fs:read | UTF-8 宽容解码；超上限截断并标记 `truncated` |
| `read_base64(path, max_bytes)` | fs:read | 小文件二进制读（base64 过 IPC） |
| `write_text(path, content, append, mkdirs)` | fs:write | 覆盖/追加；可选自动建父目录 |
| `write_base64(path, b64, append, mkdirs)` | fs:write | 小文件二进制写 |
| `list(path)` | fs:read | 目录列举（上限 10000 条 + `truncated`，按名排序） |
| `mkdir(path, recursive)` | fs:write | 幂等（已存在且是目录 → Ok） |
| `remove(path, recursive)` | fs:write | 默认非递归；`recursive` 才 `remove_dir_all` |
| `digest(path, algos)` | fs:read | **单遍流式**多算法摘要：md5/sha1/sha256/sha512/crc32 |

`max_bytes` 传 0 取默认；文本默认 2 MiB / 硬顶 16 MiB，二进制默认 2 MiB / 硬顶 8 MiB
（防一次性把大文件搬进 JSON IPC）。`digest` 无上限——它只流过内存 256 KiB 缓冲。

### 2. 权限模型

新权限名 `fs:read` / `fs:write`（沿用 `clipboard:read/write` 的冒号风格），逐项声明、
无通配。装配点两处，均按"至少声明一个才注入句柄，内部再按方法细分"：

- `ll-host::build_context_from_parts`：`HostFsApi { can_read, can_write }`（纯 std::fs，不需要 AppHandle）；
- `ll-native-shell::build_context`：`ForwardFs`（native 插件经 svc JSON 通道转发，门控镜像宿主）。

`shell_safe_manifest`（manifest 读不到的兜底）**不**授予 fs——与 db/process/net 同列，
避免"无 manifest 即无门控"。

### 3. 宿主实现（ll-host services.rs）

- `HostFsApi` 双开关模型（同 `HostClipboardApi`）：每个方法先 `ensure_read/ensure_write`；
- 读类上限用 `file.take(max + 1)` 探测截断，不先信 metadata.size；
- `digest`：算法名归一化（小写、去 `-`/`_`，`sha-256` → `sha256`），枚举分发
  `FileHasher { Md5, Sha1, Sha256, Sha512, Crc32 }`，256 KiB 缓冲单遍喂全部 hasher；
  未知算法返回 `bad_params` 并列出支持项；
- CRC32 手写 IEEE 表（const fn 折叠），标准向量 `"123456789" → cbf43926`、`"hello" → 3610a686`
  锁正确性；md5/sha1 用 RustCrypto `md-5`/`sha1` 0.10（与已有 `sha2` 0.10 同族，无新传递依赖）；
- 错误一律 `PluginError`（`internal` 带路径与 OS 错误），panic=abort 下不 unwrap 外部输入。

### 4. SDK（plugins/sdk）

`PluginFs` 接口 + `ctx.fs` 封装，camelCase 直传（Rust 侧结构体 `rename_all = "camelCase"`，
不做 screen 那样的 snake→camel 映射层）。`stat` 宿主可能回 `null`（理论不可达）时 SDK 兜底
`exists:false`。

### 5. /hash 文件模式（plugins/hash）

- manifest：`permissions: ["fs:read"]`，版本 0.2.0 → 0.3.0，描述与 hint 补文件路径用法；
- `query()`：文本非空且**像路径**（含 `\` / `/` 且非 `scheme://` URL）时先 `ctx.fs.stat`：
  - 存在且是文件 → 文件面板：digest 条目（复制契约 `metadata.value` 不变）+ 末尾
    `kind:'info'` 文件信息条目（大小、修改时间）；
  - 指定算法时仅当算法属于文件算法集（md5/sha1/sha256/sha512/crc32）才走文件模式——
    `base64/url/html` 是文本操作，保持旧行为；
  - 不存在 / 是目录 / stat 抛错（无宿主、无权限）→ 原文本模式，附带「路径不存在，按文本处理」
    提示条目（info，键盘导航跳过）；
- 纯文本输入（不含路径分隔符）**零额外 IPC**，行为与 0.2.x 完全一致。

### 6. 取舍记录

- **为什么哈希在宿主而不是前端读文件**：GB 级文件 base64 后过 IPC + JS `atob` 解码，
  内存峰值 4–6 倍文件大小、耗时长；宿主流式读取只有 256 KiB 缓冲，顺带免去 IPC 序列化。
- **为什么 digest 支持多算法单遍**：`/hash <文件>` 默认给 5 种算法，逐算法各读一遍文件是
  5 次 IO；一次顺序读喂全部 hasher，成本 = 1 次读 + 5 份计算。
- **为什么不沙箱路径**：插件是用户显式安装的受信代码（native 插件甚至能 launch 任意进程）；
  沙箱带来的白名单管理成本与误伤（用户就是要 hash 任意位置的文件）不成比例，改用
  **逐权限声明 + manifest 审查**（`fs:read` 只读不写，`fs:write` 才可破坏）。
- **为什么 stat 不报错而读报错**：stat 是"探测"语义（前端逐键调用做分支），读是"使用"语义
  （失败必须让用户看见原因）。

## 影响面

- `ll-plugin-api`（契约 +1 trait +7 结构体 +1 字段）、`ll-host`（实现 + 9 分发臂 + 依赖 +2）、
  `ll-native-shell`（ForwardFs）、`plugins/sdk`（ctx.fs）、`plugins/hash`（manifest + query）、
  `tools/test-fe-plugins.mjs`（fs 桩 + 用例）、插件开发指南、CHANGELOG；
- 兼容性：纯增量——旧插件不声明 `fs:*` 拿到 None 句柄，行为不变；`/hash` 文本模式输出不变；
  `api_version` 仍 `^1`（svc 方法集扩展，未动既有字段/形状）；
- 回滚：revert 单提交即可。

## 验证

- Rust：`cargo test -p ll-host`（CRC32 向量、digest 单遍一致性、读写 round-trip、截断、
  权限拒绝）、`cargo check --workspace`、`cargo test --workspace`；
- 前端：`npx tsc --noEmit`、`npm run plugin:test:fe`（fs 桩：文件全量/指定算法/路径不存在
  三组断言，含「文件模式不出现文本编码条目」）；
- 人工：`npm run tauri dev` 后 `/hash <真实文件路径>` 核对 md5 与 `certutil -hashfile` 一致
  （Windows 自带工具交叉验证）。

## 结果记录

- 按方案落地，无设计偏差；一处语义修正：`read_text` 截断时 UTF-8 宽容解码会把
  截断处的半字符扩成 U+FFFD（3 字节），content 字节长度可能略大于 max_bytes——
  契约注释、SDK、指南与单测均按「去尾部替换符后是原内容前缀」表述；
- 验证：`cargo test --workspace` 全绿（ll-host 28，含 CRC32 标准向量、digest 单遍
  多算法已知向量、读写 round-trip、截断、权限拆分、mkdir/remove 幂等）；
  `npm run check`（cargo check + tsc）通过；`npm run plugin:test:fe` 22/22
  （hash 文件全量/指定算法/路径不存在三组新用例）；
- 遗留：真实启动冒烟（`npm run tauri dev` 后 `/hash <真实文件>` 与
  `certutil -hashfile` 交叉核对）待下次开发会话人工确认；
- 提交：见 git log（feat(hash): 文件哈希 + svc.fs.* 框架能力）。
