# 插件动态加载方案：DLL/SO 原生插件（参照 DeaDBeeF）

> 目标：把插件后端与主程序**完全剥离**——插件编译为独立动态库（Windows `.dll` / Linux `.so` / macOS `.dylib`），
> 主程序启动后**扫描 `plugins/` 目录按需 dlopen**，不改主程序即可安装/卸载/升级插件。
> 参考项目：DeaDBeeF（`D:\codes\deadbeef-master`），其 C ABI 插件体系是桌面软件动态插件的事实范本。

---

## 1. 现状盘点与缺口

当前 LiteLauncher 插件后端有三种形态（`manifest.backend.kind`）：

| kind | 现状 | 剥离程度 |
|---|---|---|
| `builtin`（todo/apps/notes/ai） | Rust crate 编进主程序，`src-tauri/src/lib.rs:184-187` 注册 | ❌ 完全耦合，改一行重编主程序 |
| `llp`（bookmark/pomo/…） | Python 等脚本 sidecar，stdio JSON-RPC | ✅ 后端剥离，但冷启动慢、串行会话 + 5s 超时 |
| `none`（纯前端） | 无后端 | ✅ 但只适合纯计算 |

**缺口**：没有「编译为原生动态库、进程内动态加载」的形态——即 deadbeef 那条路。
它兼具 builtin 的性能/能力（进程内、无超时、可开窗口）与 llp 的分发方式（拷目录即装、零重编译）。

前端侧的既有事实：所有插件前端（含 pomo 的挂件）都经 `src/plugins.generated.ts` **静态编译进主 bundle**；
LLP 插件的标准形态是零前端（`src/core/externalPlugins.ts` 按 manifest 生成通用命令面板）。
**本方案必须同时解决前端动态化，否则只剥离了一半。**

---

## 2. DeaDBeeF 机制拆解（值得抄的和要改的）

读的是 `include/deadbeef/deadbeef.h`、`src/plugins.c`、`plugins/shellexec/shellexec.c`：

### 2.1 插件描述符：`DB_plugin_t` 头结构（抄）

每个插件导出一个描述符结构，各插件类型（输入/DSP/VFS/GUI…）的结构体都把 `DB_plugin_t plugin` 放在**第一个成员**：

```c
struct DB_plugin_s {
    int32_t type;                 // 插件类型
    int16_t api_vmajor, api_vminor;   // 插件要求的宿主 API 版本
    int16_t version_major, version_minor; // 插件自身版本
    const char *id, *name, *descr, *website, *copyright;
    int (*start)(void);  int (*stop)(void);      // 生命周期
    int (*connect)(void); int (*disconnect)(void); // 插件间连线
    int (*command)(int cmd, ...);
};
```

→ 对应我们的 `manifest.json`（id/name/permissions/views）。**保留 manifest.json 作为描述符**，
把它也嵌入 ABI 描述符（字符串指针），宿主扫描时**先用 ABI 描述符、再读 manifest 文件补全**，两者以 id 校验一致。

### 2.2 入口约定：按文件名命名的加载符号（抄，微调）

deadbeef：`shellexec.so` 必须导出 `shellexec_load(DB_functions_t *api)`，返回 `DB_plugin_t*`；
宿主 `dlsym` 按文件名拼符号名（`plugins.c:920-936`），失败即 `dlclose` 跳过。

→ 我们统一用**单一固定符号** `ll_plugin_load`（见 §4），比按文件名拼更简单；
同名插件多副本去重靠描述符 `id` + 版本比较（deadbeef 也是这么做的：同 id 只留版本高的，`plugins.c:760-768`）。

### 2.3 版本门控（抄，原样保留规则）

`plug_init_plugin`（`plugins.c:777-789`）的规则值得原样照搬：

```
拒绝加载当且仅当：plugin.api_vmajor != host.major  ||  plugin.api_vminor > host.minor
```

- major 不同 = ABI 破坏性变更，拒绝；
- 插件要求的 minor **不高于**宿主 = 兼容（宿主只会多不会少）；
- 插件填 `0.0` = 关闭版本检查，宿主打 WARNING（「please don't distribute it!」）——调试用。

追加新宿主能力时**只增 minor、vtable 只在尾部追加槽位**（deadbeef 用 `#if (DDB_API_LEVEL >= N)`
在头文件里做版本分层，插件调用新槽位前先看 `api->vmajor/vminor`）。

### 2.4 目录扫描（抄）

`plug_load_all`（`plugins.c:1115-1236`）：多目录按序扫描——系统插件目录 → XDG 用户目录 →
架构专属用户目录 → 额外路径；每个候选文件 `dlopen(RTLD_NOW)` + `dlsym`；文件名 `lib` 前缀跳过（那是依赖库不是插件）。

→ 我们：`exe旁/plugins/<id>/`（便携）→ `%LOCALAPPDATA%/LiteLauncher/plugins/<id>/`（用户安装）→ 开发期仓库 `plugins/`。
插件目录布局：`<id>/manifest.json + <id>.dll|.so + assets…`。**规则：目录名即插件 id，单目录单插件**——比 deadbeef 的散文件好管理（依赖、前端资产、图标都有地方放）。

### 2.5 UI 抽象：GUI 只是一个服务（抄思想）

deadbeef 核心不绑 GUI：同一时刻只有一个 GUI 插件存活，向其他插件提供 `run_dialog(ddb_dialog_t*)`——
插件用**声明式布局字符串 + set_param/get_param 回调**描述对话框（`deadbeef.h:2323-2334`），
由当前 GUI 插件渲染。插件自身想画窗口，则自己链 GTK/Cocoa 直接调工具箱。

→ 这条给了我们前端方案的定调：**UI 是宿主提供的另一种能力，而不是编译进宿主的东西**（见 §6）。

### 2.6 信任模型（要如实声明）

native 插件与宿主同进程同权限，插件崩溃 = 主程序崩溃。deadbeef 不做沙箱，我们也一样——
**这是接受 memcpy 级信任换取性能与能力的交易**；要隔离请用 `llp`（进程隔离）或未来的 `wasm` 形态。

---

## 3. 形态全景：四种 kind 并存

```jsonc
// manifest.json —— backend 段演进
"backend": {
  "kind": "native",          // builtin | native | llp | none
  "entry": "notes.dll",      // native：动态库文件名（相对插件目录）
  "abi": "1"                 // 要求的 ll-plugin ABI major
}
```

| | builtin | **native（新）** | llp | none |
|---|---|---|---|---|
| 后端载体 | 主程序内 | **DLL/SO** | 脚本/可执行 sidecar | 无 |
| 调用开销 | μs 进程内 | μs 进程内（FFI） | ms + 冷启动 | — |
| 超时/并发 | 无限制 | 无限制 | 串行 + 5s | — |
| 自定义窗口 | ✅ | ✅（§6） | 仅通用面板 | 仅通用面板 |
| 崩溃隔离 | 无 | 无 | ✅ | — |
| 安装方式 | 重编主程序 | **拷目录 + 重启** | 拷目录 + 重启 | 拷 manifest |
| 适用 | ~~官方核心件~~（M5 起归零） | **官方件 + 高性能第三方** | 脚本党/需隔离 | 小工具 |

**M5（2026-10）现状**：`todo`/`apps`/`ai`/`notes` 四个原 builtin 已全部迁为 native，`src-tauri` 不再链接任何插件 crate；主程序只保留宿主核心服务（窗口/DB 注册表/svc 分发器）。builtin 形态仍保留代码路径，但仓库内已无使用者。 `Arc<dyn PluginBackend>` 注册进**同一个** host registry，
`plugin_call`、设置面板启停、`/help`、权限门控全部复用——宿主只多一个 loader，不改任何分发逻辑。

---

## 4. ABI 规范（新 crate：`src-tauri/crates/ll-plugin-abi`）

唯一跨边界的依赖。**不含 serde/tauri**，`#![no_std]` 友好（只留 `core` + 裸指针），
宿主与插件各自在自己的实现侧用 serde_json 组装/解析 JSON。

### 4.1 版本与入口

```rust
// ll-plugin-abi/src/lib.rs（要点）
pub const LL_ABI_MAJOR: u32 = 1;   // 破坏性变更才 +1，同时换插件子目录 plugins/v1→v2
pub const LL_ABI_MINOR: u32 = 0;   // 追加 vtable 槽位时 +1

#[repr(C)]
pub struct LlBuf { pub ptr: *mut u8, pub len: usize }  // UTF-8 JSON 或字节串

#[repr(C)]
pub struct LlPluginInfo {
    pub abi_major: u32,          // 插件要求的 ABI major（必须 == LL_ABI_MAJOR）
    pub abi_minor: u32,          // 插件要求的 ABI minor（必须 <= 宿主）
    pub id:  LlStr, pub name: LlStr, pub version: LlStr,   // manifest 镜像，用于一致性校验
    pub vtable: LlPluginVTable,
}

#[repr(C)]
pub struct LlPluginVTable {
    pub ctx: *mut c_void,                                  // 插件自持状态
    pub call:     unsafe extern "C" fn(ctx,*mut c_void, method: LlBuf, params: LlBuf, out: *mut LlBuf) -> LlStatus,
    pub shutdown: unsafe extern "C" fn(ctx: *mut c_void),
    // 生命周期：宿主加载后先 call(manifest校验) → init(ctx 由宿主注入)
}

// 唯一导出符号（插件侧 #![no_mangle] pub extern "C"）
// 宿主把 LlHostApi（含版本 + 能力 vtable + 注入句柄）递进来，插件回吐描述符
unsafe extern "C" fn ll_plugin_load(api: *const LlHostApi) -> *const LlPluginInfo;
```

### 4.2 `LlHostApi`：宿主能力 vtable（deadbeef `DB_functions_t` 的对应物）

不复刻一个巨型 vtable——**宿主服务已经全部存在于 `ll-plugin-api` 的 trait 对象里**
（`DbApi/WindowApi/ProcessApi/ClipboardApi/HttpApi/ScreenApi/...`，权限门控在宿主注入处已完成）。
宿主把这些 trait 对象包成 C vtable 递给插件，或更务实：

> **推荐折中**：`LlHostApi` 只放**稳定的窄接口**（v0：log / settings get·set / db query·execute·migrate /
> call_host_service(method,params)->json 一个总入口）。
> `call_host_service` 就是宿主 `svc.*` 分发器直接暴露——插件要 clipboard/process/screen/windows，
> 全部走它，**权限照 manifest 门控，vtable 永不膨胀**。新增能力 = 新增 svc 方法 + minor+1，
> 插件用 `abi.version` 或探测返回错误码做降级。deadbeef 的巨型 vtable 是 C 生态的无奈；
> 我们已有 JSON RPC 通道，没必要在 ABI 层再长一遍。

### 4.3 内存与 panic 边界（native 插件最容易翻车的两处）

- **跨边界内存**：宿主提供 `ll_host_alloc(LlBuf)/ll_host_free(LlBuf)`；插件返回给宿主的每个 `LlBuf`
  必须用 `ll_host_alloc` 分配；宿主传给插件的 `LlBuf` 由宿主在调用返回后自行释放。
  两边 allocator 各管各的，绝不交叉 free。
- **panic**：workspace 主程序是 `panic = "abort"`（Cargo.toml），**native 插件必须以独立 cargo 工程构建**
  （不进 workspace members，自带 `[profile.release] panic = "unwind"` + `crate-type = ["cdylib"]`），
  并在**插件侧**的每个 `extern "C"` 入口用 `catch_unwind` 包住，panic 转为 `LlStatus::Panicked` + 错误 JSON。
  宿主侧调用前也有 `AssertUnwindSafe` 防线（宿主 abort 档下它兜不住插件 abort，但兜得住错误码传播）。
- **Windows CRT**：插件构建模板统一 `+crt-static`，避免目标机缺 VC Redist 与 CRT 跨边界堆混淆。
- **dlclose 慎用**：Rust dylib 的 TLS 析构/静态初始化在 dlclose 后是著名的崩溃源。默认策略：
  **禁用插件 = call(shutdown) 后句柄保留到进程退出**（`--enable/disable` 幂等）；dlclose 仅在
  `LL_NATIVE_DLCLOSE=1` 实验开关下启用。

### 4.4 加载器流程（ll-host 新增 `native.rs`）

```
启动 → 扫描插件目录（便携 → 用户 → 开发期）逐目录：
  1. 读 manifest.json（无则跳过）；backend.kind == "native" 才继续
  2. libloading::Library::new(目录/entry)   ← 对应 deadbeef dlopen(RTLD_NOW)
  3. symbol("ll_plugin_load") 不存在 → 记日志、卸载、跳过   ← dlsym
  4. ll_plugin_load(&HOST_API) → LlPluginInfo
  5. ABI 门控：major 不等或 minor 超宿主 → WARNING「plugin wants ABI v2.1 (got 1.3), will not be loaded」
  6. manifest.id == info.id 校验；同 id 已加载更高版本 → 跳过本副本（deadbeef 去重规则）
  7. 权限门控按 manifest.permissions 构建 LlHostApi 视图（复用现有 granted() 管线）
  8. 包成 NativePluginBackend 注册进 registry —— 之后一切与 builtin 无异
```

失败面全部**跳过 + 日志**，绝不因单个坏插件阻塞启动（deadbeef 同款行为）。

---

## 5. 目录与分发

```
release/
  LiteLauncher.exe                 ← 宿主（含 builtin 四件 + native loader）
  plugins/
    notes/                         ← native 插件示例（试点）
      manifest.json                ← kind=native, entry=notes.dll, abi=1
      notes.dll / libnotes.so
      assets/…                     ← 图标等静态资源（可选）
    some-third-party/
      manifest.json
      some.dll
      fe/                          ← 自带前端（§6.2，可选）
```

- 安装 = 解压到 `plugins/<id>/`（或 `plugin:install`），重启生效；设置面板里可启停。
- 升级 = 覆盖目录；同 id 版本比较保证多副本时取高版本。
- `build.cmd` 的 `deploy-portable-plugins.mjs` 扩展：native 插件从 `plugins/<id>` 收集（be 编译产物 + manifest）。

---

## 6. 前端方案（三步走，借鉴「GUI 只是一个服务」）

### 6.1 M1：零前端起步（= deadbeef 的 `ddb_dialog_t` 思路）

native 插件**不写前端**即可发布：`src/core/externalPlugins.ts` 已按 manifest `command` 声明
自动生成通用 CommandPlugin（搜索列表 + 回车/复制）；manifest `settings` 段自动渲染通用设置面板。
UI 是宿主的数据驱动服务——这是 deadbeef 对话框抽象的等价物，够覆盖大量工具型插件。

### 6.2 M2：插件自带前端资产（核心增量）

第三方插件若要自己的管理面板（像 notes 那样的树 + 编辑器）：

```
some-third-party/
  fe/index.html  fe/app.js  …     ← 任意 Web 技术（纯 JS / Vue / 编译后的 Solid 均可）
```

- 宿主注册 Tauri 自定义协议 `ll-plugin://<id>/...`，根目录映射到 `plugins/<id>/fe/`；
  `windows.open(view)` 打开的窗口直接加载 `ll-plugin://some-third-party/index.html?view=xxx&...`。
- **桥接**：窗口创建时注入 bootstrap 脚本 `window.llBridge`——与 `PluginContext` 同面 API
  （`call / settings / clipboard / events / notify / windows`），实现方式为 `postMessage → 宿主 svc.*`
  分发器，**权限按 manifest 门控**（与现有 plugin_call 同一条管线，没有第二条信任路径）。
- 窗口 capabilities：沿用 §11.6 的通配先例（`pick-*`），在 `capabilities/default.json` 加
  `native-*` 通配标签，避免每个第三方插件改宿主文件。
- 现有第一方 fe 包（notes 管理面板等）**不动**，继续静态编译走快速路径；两条轨道长期并存。

### 6.3 M3（可选）：声明式 UI schema

对简单面板提供 manifest 内嵌 layout（表单/列表/按钮）由宿主渲染——即把 `ddb_dialog_t` 完整移植。
优先级低：6.2 已覆盖复杂 UI，schema 只为「不想写 HTML 的插件」服务。

---

## 7. 试点迁移：notes 后端 native 化

选 notes 作 M2 试点（它正是「为什么内置」讨论的主角）：

- `plugins/notes/be` 逻辑整体保留（tree/rename/search/... 全部复用），
  新增薄壳 crate `plugins/notes/native`（独立 cargo 工程，不进 workspace）：
  `ll_plugin_load` + `call` → 直接转调现有 `NotesPlugin::call`（`ll-plugin-api` trait 换成 `LlHostApi`）。
- manifest 增 `backend.kind = "native"`；`fe/` 管理面板先继续静态编译（已是第一方），
  作为 6.2 机制成熟后的第二个试点（fe 资产化）。
- 迁移后验收：删掉 workspace 里的 `plugins/notes/be` 成员，`plugin:install` 装 dll 版，
  `/note` 全功能（含管理面板）不回归。

---

## 8. 工具链与文档

| 交付物 | 说明 |
|---|---|
| `ll-plugin-abi` crate | §4 的头文件等价物 + `LlHostApi` 实现（宿主侧适配器在 ll-host） |
| `create-plugin` 脚手架 | `npm run plugin:create <id> native` 生成目录模板（manifest + cargo 工程 + CI 构建脚本） |
| `ll-test-host` | 测试宿主：命令行加载指定 dll，跑 `call` 冒烟（对应 `npm run plugin:test`） |
| `plugin:install` 扩展 | 支持 native 目录拷贝 + 版本提示 |
| `plugin-development-guide.md` | 新增「native 插件开发」章：ABI 规则、构建模板、内存/panic 铁律、调试方法 |
| CI 门禁 | 依赖规则追加：native 插件工程**禁止**依赖 ll-host/tauri（只允许 ll-plugin-abi + 通用库） |

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| ABI 漂移导致老插件加载崩溃 | §2.3 版本门控原样照搬 + vtable 尾部追加纪律 + major 变更换目录（plugins/v2/） |
| 插件 panic/UB 拖死主程序 | 插件侧 catch_unwind 强制模板；文档明示信任模型；要隔离用 llp；远期可选 wasm kind |
| dlclose 崩溃（Rust TLS/静态析构） | 默认禁用后句柄保留到退出；dlclose 走实验开关 |
| 双 Rust runtime 共存 | 允许（各 dylib 独立 tokio/全局态），文档禁止跨边界传任何 Rust 类型 |
| 符号冲突（Linux so 全局符号） | 插件构建加 `-Bsymbolic`；宿主侧符号全部前缀化 `ll_host_*` |
| 第三方插件供应链 | 设置面板显示来源与 hash；可选签名白名单（M4） |
| 前端桥被滥用越权 | `llBridge` 与 plugin_call 同管线同权限门控，无第二条路径；窗口标签通配仅授最小 capability |

---

## 10. 里程碑

> **落地状态（M1–M5 已实施）**：M1 全部落地（ll-plugin-abi + native loader + echo 示例 + native-smoke）；
> M2 全部落地（`ll-plugin://` 协议 + llBridge + capabilities 通配 + echo fe 面板 + notes native 化试点，
> 经 ll-native-shell 适配器零改动复用 be 逻辑）；M3 全部落地（`plugin:create` 脚手架 +
> native-smoke 即 ll-test-host 雏形 + install/deploy 扩展 + [native-plugin-guide.md](./native-plugin-guide.md)）；
> M4 落地完整性 sha256 校验（声明即强制）；M5 把剩余 three builtin（todo/apps/ai）全部迁为 native，
> 并为 /ai 的 SSE 聊天把 ABI 升到 1.1（`LlHostApi.http_stream`：同进程逐块回调），
> 新增 `svc.secret.get/set/delete`；随后把唯一常驻型 sidecar（`/pomo`，Python 里 `while True` 计时线程）
> 重写为 native（`plugins/pomo/be` + 8 个单测对齐原行为，挂件协议不变）。wasm 沙箱与 out-of-process native 仍为远期项（见 §11）。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1**（ABI + loader） | ll-plugin-abi、native loader、hello-native 示例（echo 插件）、注册进 registry | `plugin:install` 装入 → `/echo` 指令可用；坏 ABI/坏 dll 均跳过并有日志 |
| **M2**（窗口 + 试点） | `ll-plugin://` 协议 + llBridge 注入 + `native-*` capability；notes 后端 native 化试点 | notes 以 native 后端运行全功能；第三方示例插件自带 fe 面板可开窗 |
| **M3**（工程化） | 脚手架、ll-test-host、plugin:install/deploy 扩展、开发指南成文 | 第三方开发者仅凭文档 + 脚手架可产出并安装一个 native 插件 |
| **M4**（完整性） | 加载前 sha256 强制校验 + 加载后复核 | 改一个字节即拒载并记 WARNING |
| **M5**（builtin 清零） | todo/apps/ai 浅壳迁移 + ABI 1.1 流式 http + svc.secret.* | 主程序零插件依赖；5 个 native 插件启动即装载；/ai 聊天仍逐 token 输出 |
| **M6**（远期，可选） | wasm 沙箱形态、签名白名单、out-of-process native | — |

---

## 11. 备选方案对比（为什么是 C-ABI 动态库）

| 方案 | 性能 | 隔离 | 语言开放 | 自定义 UI | 评价 |
|---|---|---|---|---|---|
| **C-ABI dylib（本方案）** | ★★★ 进程内 | ✗ | ★★ Rust/C/C++/Zig | ★★★（自带 Web 前端） | deadbeef 同款，能力上限最高 |
| LLP sidecar（现状） | ★★ 冷启动+5s 超时 | ★★★ 进程隔离 | ★★★ 任意脚本 | ✗（仅通用面板） | 保留，作隔离选项 |
| WASM（wasmtime/extism） | ★★ | ★★★ 沙箱 | ★★（需 wasm 工具链） | 同 dylib 走资产窗口 | M4 再评估，适合不可信分发 |
| 维持 builtin | ★★★ | ✗ | Rust only | ★★★ | 官方核心件继续用 |

结论：**builtin 保留给官方核心件；native 面向高性能第三方；llp 面向脚本与需隔离场景；none 面向纯前端**。
四种 kind 共用同一套 manifest/权限/registry/前端契约，「一切皆插件」的不变量不变。

---

## 12. 一句话总结

> 照抄 deadbeef 的三件套——**按 id 去重的目录扫描、major/minor 版本门控、宿主能力 vtable**——
> 但宿主能力通道走现成的 `svc.*` JSON 分发（不重造巨型 vtable），前端用「自带 Web 资产 + 权限化桥接」
> 替代 deadbeef 的 GUI 插件机制，native 插件以独立 cargo 工程构建（unwind + crt-static）规避 panic=abort 与 CRT 坑。
