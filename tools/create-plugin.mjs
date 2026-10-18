// 生成 native 动态库插件骨架（M3 脚手架）
//
// 用法：
//   npm run plugin:create -- <id> [--name "显示名"]
// 例：
//   npm run plugin:create -- my-tools --name "我的工具"
//
// 产物：plugins/<id>/ 下 manifest.json + native/（独立 cargo 工程）+ fe/（自带前端骨架）
// 下一步：在 native/src/lib.rs 补业务 → build.cmd → 重启主程序（或 plugin:install 部署）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const args = process.argv.slice(2).filter((a) => a !== "--");
const id = args[0];
const nameIdx = args.indexOf("--name");
const displayName = nameIdx >= 0 ? args[nameIdx + 1] : null;

if (!id) {
  console.error("用法: npm run plugin:create -- <id> [--name \"显示名\"]");
  process.exit(1);
}
if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
  console.error(`✗ 插件 id 非法: "${id}"（要求：小写字母开头，仅小写字母/数字/-/_）`);
  process.exit(1);
}
const dest = path.join(root, "plugins", id);
if (existsSync(dest)) {
  console.error(`✗ plugins/${id} 已存在`);
  process.exit(1);
}

// 动态库文件名 = 包名规则（- → _）；[lib] name 同步用下划线形式
const libName = id.replace(/-/g, "_");
const name = displayName || id;
const trigger = `/${id}`;

const files = {
  "manifest.json": JSON.stringify(
    {
      id,
      name,
      version: "0.1.0",
      api_version: "^1",
      trigger,
      description: `${name}（native 动态库插件骨架，由 plugin:create 生成）`,
      permissions: [],
      backend: {
        kind: "native",
        entry: [`${libName}.dll`],
        // 建议：发布前用 build.cmd 打印的 sha256 填进来（加载时强制校验）
        // "integrity": "sha256:<64 位十六进制>",
      },
      command: {
        icon: "🧩",
        action_subcommands: [],
        hint: "按 Enter 执行",
      },
      // 自带前端面板（M2）：取消注释并在 fe/ 里写页面，然后给 execute 加开窗逻辑
      // "views": [
      //   {
      //     "id": "panel",
      //     "title": "${name} 面板",
      //     "frontend": "assets",
      //     "width": 540.0,
      //     "height": 420.0,
      //     "min_width": 380.0,
      //     "min_height": 300.0,
      //     "resizable": true,
      //     "decorated": false,
      //     "focusable": true,
      //     "position": "center",
      //     "on_existing": "focus"
      //   }
      // ],
    },
    null,
    2,
  ) + "\n",

  "native/Cargo.toml": `# 脱离宿主 workspace：native 插件自管 profile（panic=unwind，宿主是 abort）——
# 这是硬性要求，任何插件 panic 都不能杀死主程序
[package]
name = "ll-plugin-${id}"
version = "0.1.0"
edition = "2024"
description = "${name}"

[workspace]

[lib]
name = "${libName}"
crate-type = ["cdylib"]

[dependencies]
# 唯一允许的宿主侧依赖：稳定 C-ABI（禁止依赖 ll-host / tauri / 其他插件）
ll-plugin-abi = { path = "../../../src-tauri/crates/ll-plugin-abi" }
serde_json = "1"

[profile.release]
panic = "unwind"
strip = true
`,

  "native/.cargo/config.toml": `# Windows MSVC：静态链接 CRT——目标机免装 VC Redist
[target.x86_64-pc-windows-msvc]
rustflags = ["-C", "target-feature=+crt-static"]

# 产物钉回本工程目录（仓库根 .cargo/config.toml 指向的 target-dir 不适用于独立插件）
[build]
target-dir = "target"
`,

  "native/src/lib.rs": `//! ${name} —— LiteLauncher native 动态库插件
//!
//! 与宿主的全部交互（详见 docs/guides/native-plugin-guide.md）：
//! 1. 导出 ll_plugin_load：校验宿主 ABI → 保存宿主 API → 回吐描述符；
//! 2. vtable.call：search/execute/select（通用命令面板契约）；
//!    需要宿主能力（db/窗口/剪贴板/...）时经 call_host_service("svc.*")；
//! 3. vtable.shutdown：停活动但不释放状态（宿主可能不停库地重新启用）。
//!
//! 三条铁律：入口**整段** catch_unwind；out 只用 api.alloc；params 只在调用期有效。

use ll_plugin_abi::{
    host_satisfies, LlBuf, LlHostApi, LlPluginInfo, LlPluginVTable, LlStatus, LlStr,
    LL_ABI_MAJOR, LL_ABI_MINOR, LL_ERR, LL_OK, LL_PANIC, LL_UNSUPPORTED_METHOD,
};
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};

struct State {
    api: &'static LlHostApi,
}

/// 业务逻辑：返回 (状态码, 响应 JSON)。TODO: 在这里实现你的插件。
fn dispatch(_state: &State, method: &str, params: &Value) -> (LlStatus, Value) {
    let keyword = params
        .get("keyword")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();

    match method {
        "search" => {
            let items = if keyword.is_empty() {
                vec![]
            } else {
                vec![json!({
                    "id": "item-1",
                    "title": format!("{keyword}"),
                    "description": "TODO: 在 dispatch() 里实现你的检索逻辑",
                    "icon": "🧩",
                    "metadata": { "text": keyword },
                })]
            };
            (LL_OK, json!({ "items": items, "emptyText": "TODO: 实现检索" }))
        }
        "execute" => {
            let raw = params.get("raw").and_then(|v| v.as_str()).unwrap_or_default();
            (LL_OK, json!({ "success": true, "message": format!("TODO: execute 收到: {raw}") }))
        }
        "select" => {
            let text = params.pointer("/metadata/text").and_then(|v| v.as_str()).unwrap_or_default();
            (LL_OK, json!({ "toast": "已复制", "copy": text }))
        }
        _ => (LL_UNSUPPORTED_METHOD, json!({ "error": format!("未知方法: {method}") })),
    }
}

fn write_out(state: &State, out: *mut LlBuf, value: &Value) -> bool {
    let bytes = value.to_string().into_bytes();
    let buf = unsafe { (state.api.alloc)(state.api.ctx, bytes.len()) };
    if buf.is_empty() {
        return false;
    }
    unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), buf.ptr, bytes.len()) };
    unsafe { *out = buf };
    true
}

unsafe extern "C" fn plugin_call(
    plugin_ctx: *mut core::ffi::c_void,
    method: LlBuf,
    params: LlBuf,
    out: *mut LlBuf,
) -> LlStatus {
    // 状态指针在整段调用期间有效：shutdown 不释放它（见 plugin_shutdown）
    let state = &*(plugin_ctx as *const State);
    // 铁律 1：整段业务包进 catch_unwind（宿主 panic=abort，漏出去 = 杀主程序）
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let method = method.as_str_unchecked().to_string();
        let params: Value = if params.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(params.as_bytes()).unwrap_or(Value::Null)
        };
        dispatch(state, &method, &params)
    }));
    match outcome {
        Ok((status, value)) => {
            if write_out(state, out, &value) {
                status
            } else {
                LL_ERR
            }
        }
        Err(_) => {
            write_out(state, out, &json!({ "error": "插件内部 panic（已被边界拦截）" }));
            LL_PANIC
        }
    }
}

/// 停用回调：只停活动、**不释放状态**（宿主可能重新启用；释放会造成 use-after-free）
unsafe extern "C" fn plugin_shutdown(_plugin_ctx: *mut core::ffi::c_void) {
    // 若有后台线程/定时器，在此停止；不要 drop State
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ll_plugin_load(api: *const LlHostApi) -> *const LlPluginInfo {
    let Ok(info) = catch_unwind(AssertUnwindSafe(|| {
        let api: &'static LlHostApi = &*api;
        if !host_satisfies(api.abi_major, api.abi_minor) {
            return std::ptr::null_mut();
        }
        let state = Box::into_raw(Box::new(State { api }));
        Box::into_raw(Box::new(LlPluginInfo {
            abi_major: LL_ABI_MAJOR,
            abi_minor: LL_ABI_MINOR,
            id: LlStr::new("${id}"),
            name: LlStr::new("${name}"),
            version: LlStr::new("0.1.0"),
            plugin_ctx: state as *mut core::ffi::c_void,
            vtable: LlPluginVTable { call: plugin_call, shutdown: plugin_shutdown },
        }))
    })) else {
        return std::ptr::null_mut();
    };
    info
}
`,
  "native/build.cmd": `@echo off
setlocal
cd /d "%~dp0"

REM Build ${id} native plugin. Output: ..\\${libName}.dll
REM ASCII-only + CRLF per repo .gitattributes (*.cmd)

cargo build --release
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] cargo build failed
    exit /b 1
)

if not exist "target\\release\\${libName}.dll" (
    echo [ERROR] target\\release\\${libName}.dll missing
    exit /b 1
)

copy /Y "target\\release\\${libName}.dll" "..\\${libName}.dll" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] copy failed
    exit /b 1
)

echo OK: ..\\${libName}.dll updated.
REM Publish tip: update manifest.json backend.integrity with the sha256 below
powershell -NoProfile -Command "(Get-FileHash '..\\${libName}.dll' -Algorithm SHA256).Hash.ToLower()" 
exit /b 0
`,

  "fe/index.html": `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${name}</title>
  <style>
    body { background: #16181d; color: #e7e9ee; font: 13px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; user-select: none; }
    header { display: flex; align-items: center; justify-content: space-between; height: 38px; padding: 0 12px; border-bottom: 1px solid #2c303a; color: #8b91a0; font-size: 12.5px; }
    main { padding: 14px; }
    pre { background: #1e2128; border: 1px solid #2c303a; border-radius: 8px; padding: 10px; min-height: 120px; user-select: text; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header data-tauri-drag-region><span>🧩 ${name}</span></header>
  <main>
    <p>自带前端骨架：在 manifest.views 里声明 frontend:"assets" 的视图后，
       宿主会以 ll-plugin:// 协议加载本目录，并注入 window.__llBridge。</p>
    <pre id="out">（llBridge: 未检测）</pre>
  </main>
  <script>
    var out = document.getElementById("out");
    if (window.__llBridge) {
      out.textContent = "✓ __llBridge 就绪（pluginId=" + window.__llBridge.pluginId + "）\\n试着调用 bridge.call(\\"search\\", { keyword: null })";
      window.__llBridge.call("search", { keyword: null }).then(show, function (e) { out.textContent = "✗ " + e; });
    } else {
      out.textContent = "✗ __llBridge 未注入";
    }
    function show(v) { out.textContent = JSON.stringify(v, null, 2); }
  </script>
</body>
</html>
`,

  "README.md": `# ${name}（native 插件）

由 \`npm run plugin:create -- ${id}\` 生成。

- \`native/\`：独立 cargo 工程（业务逻辑，编译为动态库）
- \`fe/\`：自带前端（可选，manifest.views 声明 \`frontend:"assets"\` 后生效）
- \`manifest.json\`：声明触发词、权限、入口动态库

开发循环：
1. 补 \`native/src/lib.rs\` 的 handle()
2. \`cd native && build.cmd\`
3. 重启 LiteLauncher（开发期仓库 plugins/ 目录会被直接扫描）

离线自测（不启动主程序）：
\`\`\`
cargo run --release --manifest-path tools/native-smoke/Cargo.toml -- plugins/${id}/${libName}.dll search "{\\"keyword\\":\\"hi\\"}"
\`\`\`

发布：填 manifest 的 \`backend.integrity\`（build.cmd 会打印 sha256），然后
\`npm run plugin:install -- ${id}\` 或 \`build.cmd\` 自动部署。
`,
};

for (const [rel, content] of Object.entries(files)) {
  const full = path.join(dest, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}
// build.cmd 强制 CRLF（cmd.exe 解析依赖，见仓库 .gitattributes）
const cmdPath = path.join(dest, "native", "build.cmd");
const cmdContent = readFileSync(cmdPath, "utf8").replace(/\r?\n/g, "\r\n");
writeFileSync(cmdPath, cmdContent, "utf8");

console.log(`✓ 已生成 plugins/${id}/（native 骨架 + fe 骨架）`);
console.log("  下一步：");
console.log(`  1. 编辑 plugins/${id}/native/src/lib.rs 的 handle()`);
console.log(`  2. cd plugins/${id}/native && build.cmd`);
console.log("  3. 重启 LiteLauncher，或在设置面板启用后重扫");
console.log(`  指南：docs/guides/native-plugin-guide.md`);
