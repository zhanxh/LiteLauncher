# native 插件开发指南（DLL/SO 动态库，M1–M5 落地版）

> native 是 LiteLauncher 的第四种插件形态：后端编译为**独立动态库**（`.dll`/`.so`），
> 宿主启动时扫描 `plugins/` 目录 dlopen 加载，**不改主程序、不重编译**即可安装。
> 性能与内置（builtin）等同、分发与外部脚本（llp）同等。\r\n> **M5 起 LiteLauncher 自身也不再有内置插件**：`/todo` `/app` `/ai` `/note` 全部是 native，\r\n> 主程序里剩下的只有宿主核心服务——你写的插件和官方插件走的是同一条加载路径。
> 设计依据与取舍：[plugin-native-dylib-design.md](../design/plugin-native-dylib-design.md)。

---

## 1. 四种形态速查

| | builtin | **native（本指南）** | llp | none |
|---|---|---|---|---|
| 后端载体 | 编译进主程序 | **动态库（进程内）** | Python/可执行 sidecar | 无 |
| 安装 | 重编主程序 | **拷目录 + 重启** | 拷目录 + 重启 | 拷 manifest |
| 超时/隔离 | 无限制 | 无限制 | 5s 超时 + 进程隔离 | — |
| 自定义窗口 | ✅ | ✅（`frontend:"assets"`） | 仅通用面板 | 仅通用面板 |

---

## 2. 十分钟上手

```bash
# 1. 生成骨架
npm run plugin:create -- my-tools --name "我的工具"

# 2. 在 plugins/my-tools/native/src/lib.rs 的 dispatch() 里补业务（脚手架已标 TODO）

# 3. 构建动态库（产物自动复制到 plugins/my-tools/my_tools.dll）
cd plugins/my-tools/native && build.cmd

# 4. 重启 LiteLauncher —— 开发期仓库 plugins/ 目录会被直接扫描
#    输入 /my-tools 验证；或 plugin:install 部署到便携/用户目录
```

离线自测（不启动主程序，插件作者的冒烟器）：

```bash
cargo run --release --manifest-path tools/native-smoke/Cargo.toml -- \
  plugins/my-tools/my_tools.dll search '{"keyword":"hi"}'
```

---

## 3. 目录与 manifest

```
plugins/my-tools/
  manifest.json          ← kind=native，entry=动态库文件名
  my_tools.dll           ← 构建产物（entry 指向它）
  native/                ← 独立 cargo 工程（源码，宿主不部署）
    Cargo.toml           ← [workspace] 脱离宿主；panic="unwind"；crate-type=["cdylib"]
    .cargo/config.toml   ← +crt-static；target-dir 钉回本目录
    src/lib.rs           ← ABI 入口 + 业务
    build.cmd            ← cargo build --release + 复制 dll + 打印 sha256
  fe/                    ← 自带前端（可选，见 §6）
```

manifest 关键字段：

```jsonc
{
  "backend": {
    "kind": "native",
    "entry": ["my_tools.dll"],              // 相对插件目录
    "integrity": "sha256:<64 位十六进制>"    // M4：声明后加载时强制校验，不匹配拒载
  },
  "views": [
    {
      "id": "panel",
      "frontend": "assets",                 // M2：自带前端，ll-plugin:// 协议加载 fe/
      "...": "其余字段与内置视图相同"
    }
  ]
}
```

`integrity` 由 `build.cmd` 末尾自动打印 sha256，发布前填入。
**未声明时能加载但记提醒日志**；声明后不匹配即拒载（供应链防线）。

---

## 4. ABI 三条铁律（违反 = 杀死用户主程序）

1. **入口必须 `catch_unwind`**：宿主是 `panic = "abort"`，任何跨边界的 unwind 都会
   终结整个进程。骨架的 FFI 外壳已经包好，别拆。
2. **返回给宿主的 out 缓冲只用 `api.alloc` 分配**，宿主读走后用 `api.free` 归还；
   宿主传进来的 method/params **只在调用期间有效**，不保存、不释放。
3. **vtable 函数必须线程安全**（宿主可能从任意线程调用），内部状态自行加锁。

**停用语义**：`shutdown` 只停活动（线程/定时器），**不释放自持状态**——宿主可能在不停库的
前提下重新启用（设置面板 disable → enable）；释放会造成重新启用后的 use-after-free。
宿主侧另有停用门：shutdown 到下一次 init 之间调用一律被拒。

版本门控（deadbeef 同规则）：宿主拒载 `abi_vmajor != 宿主` 或 `abi_vminor > 宿主` 的插件；
插件在 `ll_plugin_load` 里用 `host_satisfies()` 自检，不满足返回空指针。
宿主加能力 = `LL_ABI_MINOR + 1`（vtable 只追加）；破坏性变更 = major+1 并换安装子目录。

---

## 5. 宿主能力：`call_host_service`（svc.\* 一张表）

所有宿主能力经一个函数：`call_host_service("svc.<name>", params_json) -> 结果 JSON`。
权限由 manifest.permissions 门控（与内置/LLP 完全同口径）。常用方法：

| 方法 | 权限 | 说明 |
|---|---|---|
| `svc.settings.get/set` | — | 插件私有 KV（自动 `${pluginId}.` 前缀） |
| `svc.db.migrate/execute/query` | db | 插件独立 SQLite（无 ATTACH，参数化 SQL） |
| `svc.window.open` | windows | 打开 manifest.views 声明的视图（params 为标量对象） |
| `svc.window.attachDesktop/desktopSupported` | windows | 桌面挂件层 |
| `svc.clipboard.write/read` | clipboard:write/read | 原生剪贴板 |
| `svc.notify.send` | notifications | 系统通知 |
| `svc.process.launch/reveal` | process | 打开程序/URL；资源管理器定位 |
| `svc.log.write` | — | 结构化日志（进宿主生命周期日志） |
| `svc.events.emit` | events | 前端事件广播 |
| `svc.http.send` | net:<host> | 宿主代理 HTTP（逐域名白名单） |\r\n| `svc.secret.get/set/delete` | secrets | 插件私密存储（`secret.<pluginId>.<key>`，与 settings 各自命名空间） |\r\n\r\n真实流式（SSE）不走 svc，而是 ABI 1.1 的 `LlHostApi.http_stream`：宿主 ureq 每读到一块\r\n（1 KiB）就回调插件的 C 函数——同进程直调，零 JSON 往返。`ll-native-shell` 的 `ForwardHttp`\r\n已经把它接成 `HttpApi::send_stream`，所以内置时代写的 `ctx.http.send_stream(...)` 代码零改动可用。

两种迁移样本：**后端本来就是 Rust** 的照 `plugins/notes/native` 做薄壳；**逻辑在 sidecar 里** 的照 `plugins/pomo`——把 Python 状态机重写成 `be/` crate（8 个单测对齐原行为），前后端协议（settings 键 / `cmd` 动词）保持不变，挂件前端零改动。
要复用 builtin 后端逻辑？参考 `plugins/notes/native`：用 `ll-native-shell` crate 把
`LlHostApi` 反向适配成 `PluginContext`，原 crate 零改动跑进动态库（notes 就是这么迁的）。

> `ll-native-shell` 已适配 db / windows / process / clipboard / notify / settings / events / **secrets** / **http（含流式）**。
> 仍未适配的是 screen / shortcuts / clipboard_history：声明 `screen` 等权限的 native 插件
> 在这层会得到能力缺失错误（直接走 `call_host_service("svc.http.send", …)` 则不受此限）。

---

## 6. 自带前端（`frontend: "assets"`）

manifest.views 声明 `"frontend": "assets"` 的视图，宿主建窗时：

1. 导航到 `ll-plugin://localhost/<pluginId>/index.html?view=<id>&<params>`——
   页面文件来自 `<插件目录>/fe/`（纯静态，无构建要求，任意 Web 技术皆可）；
2. 注入 `window.__llBridge`：

```js
__llBridge.call(method, params)        // ≡ 前端 SDK 的 ctx.call（业务方法 + svc.* 同通道）
__llBridge.settings.get/set(key)       // 语法糖
__llBridge.notify(title, body)
__llBridge.log(level, message)
__llBridge.pluginId                    // 本插件 id
```

3. 桥与 `plugin_call` 应用命令走**同一条 IPC 管线**，权限按 manifest 门控——
   页面没有第二条信任路径。窗口能力见 `src-tauri/capabilities/native-plugin-assets.json`（通配覆盖）。

参考实现：`plugins/echo/fe/index.html`（无框窗拖拽、调用展示、自关闭）。

---

## 7. 调试与常见坑

- **日志**：宿主生命周期日志带 `[plugin:<id>]` 前缀；加载失败（dll 缺失/符号缺失/ABI 不符/
  完整性不匹配/manifest id 不一致）都会记 WARN 并跳过，不会阻塞其他插件。
- **产物名**：cdylib 产物名跟 `[lib] name` 走（包名的 `-` 会变 `_`）；entry 必须与实际文件名一致。
- **dlclose 禁区**：宿主停用插件只调 `vtable.shutdown`，**不卸载动态库**（Rust dylib 的
  TLS/静态析构在 dlclose 后是已知崩溃源）；插件 shutdown 里做完自己的清理即可。
- **双 Rust runtime**：允许（每个 dylib 独立 tokio/全局态），但**禁止跨边界传任何 Rust 类型**。
- **不要依赖宿主内部**：`native` 工程只允许依赖 `ll-plugin-abi`（+通用库）；CI 依赖规则同 builtin。
- **Linux**：入口符号导出与 `lib` 前缀跳过规则与 deadbeef 一致；`.so` 的 entry 按平台各配。

---

## 8. 分发

- `npm run plugin:install -- <id>` → 用户目录 extplugins（同名优先）
- `build.cmd` 的 [1.5/5] 步骤自动构建全部 `plugins/*/native` 并复制 dll，
  `[4/5]` 部署到 `release/plugins/`（自动剥离 native/ 源码目录）。
- 插件目录 = 自包含发布物：`manifest.json + 动态库 + fe/ + assets/`。

> ⚠️ `plugins/<id>/bin/` 也要一起发：`/find` 的 `Everything64.dll` 就装在那里。
> `tools/deploy-portable-plugins.mjs` 对 native 只保留 `fe/ assets/ bin/` 三类目录（其余视为源码），
> 新增"自带二进制"类插件时记得同步这条白名单。

---

## 9. 迁移样本：`/find` 与 `/sysinfo`（LLP → native，M6）

这两个是"值得为 native 重写"的典型：一个在热路径上要直连系统 SDK，一个采集的是操作系统级数据。

| | `/find` | `/sysinfo` |
|---|---|---|
| 业务代码 | `plugins/find/be/src/{lib,term,query,format,everything,locate}.rs` | `plugins/sysinfo/be/src/{lib,model,win,procfs}.rs` |
| 薄壳 | `plugins/find/native/src/lib.rs`（同 `pomo`） | `plugins/sysinfo/native/src/lib.rs` |
| 前端 | **没有**——manifest 留 `command` 块即可，`externalPlugins.ts` 自动生成通用面板 | 同左 |
| 单测 | `cargo test --manifest-path plugins/find/be/Cargo.toml`（74） | `cargo test --manifest-path plugins/sysinfo/be/Cargo.toml`（16） |

三条经验：

1. **`command` 块是 native 插件免写前端的关键**。只要 manifest 声明了 `command`（含 `queryDebounceMs`），
   `/find` 的防抖、`action_subcommands` 的即时胶囊、`select` 的 copy/close 语义全部自动生效，
   与 LLP 版逐字一致——迁移可以只改后端。
2. **要读平台数据就别引第三方 crate**。两个插件各自手写了十几个 `extern "system"` 声明
   （`LoadLibraryW` + `GetProcAddress` / Toolhelp32 / `GlobalMemoryStatusEx` / `K32GetProcessMemoryInfo`），
   产物仍是零运行时依赖；`LoadLibraryW` 拿到的句柄刻意不 `FreeLibrary`（函数指针指进它的代码段）。
3. **多平台：让宿主选产物，而不是写死文件名**。manifest 的 `entry` 写全 `["find.dll", "libfind.so"]`，
   宿主按 `native_lib_suffix()`（`.dll` / `.so` / `.dylib`）挑一个；`backend.integrity` 由
   `tools/update-plugin-integrity.mjs` 在每次构建后回填为**本平台**产物的 hash（Windows 构 dll、Linux 构 so）。
   `pomo` / `todo` 这些只有 Windows 名的老 manifest 仍然能加载（后缀不命中时退回第一个存在的）。
4. **平台专属代码也尽量让它“能编译”**。`locate.rs`（plocate/fd/find）与 `procfs.rs`（读 `/proc`）
   只用 std，所以**在 Windows 上也参与编译与单测**——没有 Linux 机器时，这是唯一能保证
   “Linux 分支不是一段没人跑过的代码”的手段。真正 `#[cfg(windows)]` 的只有直接写 Win32 FFI 的
   `everything.rs` / `win.rs`；两端共用 `format` / `term` / `query` / `model`。
