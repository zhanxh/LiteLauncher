//! echo —— LiteLauncher native 动态库插件示例（M1 + M2 资产窗口）
//!
//! 与宿主的全部交互只有三个点（见 docs/guides/native-plugin-guide.md）：
//! 1. 导出 `ll_plugin_load`：校验宿主 ABI → 保存宿主 API 指针 → 回吐描述符；
//! 2. 实现 `vtable.call`：search/execute/select（通用命令面板契约）+ `panel` 打开自带前端；
//! 3. 实现 `vtable.shutdown`：停止活动（**不释放状态**——宿主可能重新启用）。
//!
//! 三条铁律的样板：
//! - 每个跨边界入口都 `catch_unwind`（宿主 panic=abort，跨边界 unwind = 杀主程序）；
//!   注意是**整段**包，不只包参数解析——业务段同样可能 panic；
//! - 返回给宿主的 out 缓冲只用 `api.alloc` 分配；
//! - method/params 只在调用期内有效，不保存不释放。
//!
//! 构建：在本目录执行 `build.cmd`（Windows）/ `cargo build --release`，
//! 产物复制到 `plugins/echo/echo.dll`，重启主程序即被扫描加载。

use ll_plugin_abi::{
    host_satisfies, LlBuf, LlHostApi, LlPluginInfo, LlPluginVTable, LlStatus, LlStr,
    LL_ABI_MAJOR, LL_ABI_MINOR, LL_ERR, LL_OK, LL_PANIC, LL_UNSUPPORTED_METHOD,
};
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};

/// 插件自持状态：保存宿主 API 指针（call 里写 out 必须用宿主分配器）
struct State {
    api: &'static LlHostApi,
}

// ── 业务逻辑（返回 (状态码, 响应 JSON)；FFI 外壳见文件底部） ────────────────

fn dispatch(state: &State, method: &str, params: &Value) -> (LlStatus, Value) {
    // /echo panel：经宿主 svc.window.open 打开自带前端面板（M2 资产窗口闭环）
    if method == "execute"
        && params.get("subcommand").and_then(|v| v.as_str()) == Some("panel")
    {
        let (status, _resp) = call_host(
            state,
            "svc.window.open",
            &json!({ "view": "panel", "params": {} }).to_string(),
        );
        return if status == LL_OK {
            (
                LL_OK,
                json!({ "success": true, "message": "已打开 Echo 面板（ll-plugin:// 资产窗口）" }),
            )
        } else {
            // 业务结果（打不开窗）走 LL_OK + success:false，与通用面板语义一致
            (
                LL_OK,
                json!({
                    "success": false,
                    "message": "打开面板失败（宿主无 windows 权限或视图未声明）",
                }),
            )
        };
    }

    // ping_host：演示 call_host 的优雅降级（smoke 环境无 svc 通道也不致命）
    if method == "ping_host" {
        let (status, _resp) = call_host(
            state,
            "svc.log.write",
            &json!({ "level": "info", "message": "echo 插件 ping_host" }).to_string(),
        );
        return if status == LL_OK {
            (
                LL_OK,
                json!({
                    "success": true,
                    "message": "已通过 call_host_service 写入宿主日志（svc.log.write）",
                }),
            )
        } else {
            (
                LL_OK,
                json!({
                    "success": false,
                    "message": "call_host_service 失败（smoke 环境没有 svc 通道属正常）",
                }),
            )
        };
    }

    let p_str = |key: &str| params.get(key).and_then(|v| v.as_str()).map(String::from);
    let p_strings = |key: &str| {
        params
            .get(key)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };

    match method {
        // 通用命令面板的检索：返回 PanelItem 列表（与 LLP 插件同契约）
        "search" => {
            let keyword = p_str("keyword").unwrap_or_default().trim().to_string();
            if keyword.is_empty() {
                (
                    LL_OK,
                    json!({
                        "items": [],
                        "emptyText": "输入任意关键词，这个 native 插件会原样回显给你",
                    }),
                )
            } else {
                (
                    LL_OK,
                    json!({
                        "items": [{
                            "id": "echo-item",
                            "title": format!("回显「{keyword}」"),
                            "description": "来自 plugins/echo/echo.dll 的进程内动态库插件",
                            "icon": "🔁",
                            "badge": "native",
                            "metadata": { "text": keyword },
                        }],
                        "emptyText": "无结果",
                    }),
                )
            }
        }
        // 通用命令面板的即时执行：/echo say 文本
        "execute" => {
            let raw = p_str("raw").unwrap_or_default();
            let sub = p_str("subcommand").unwrap_or_default();
            let args = p_strings("args").join(" ");
            let message = if sub == "say" {
                if args.is_empty() {
                    "要说点什么：/echo say 你好".to_string()
                } else {
                    format!("🔊 {args}")
                }
            } else if raw.is_empty() {
                "echo: （空输入）".to_string()
            } else {
                format!("echo: {raw}")
            };
            (LL_OK, json!({ "success": true, "message": message }))
        }
        // 通用命令面板的选中：回填复制（AfterSelect.copy）
        "select" => {
            let text = params
                .pointer("/metadata/text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if text.is_empty() {
                (LL_OK, json!({ "toast": "（该条目没有可复制文本）" }))
            } else {
                (LL_OK, json!({ "toast": "已复制回显文本", "copy": text }))
            }
        }
        _ => (
            LL_UNSUPPORTED_METHOD,
            json!({ "error": format!("未知方法: {method}") }),
        ),
    }
}

/// 宿主服务调用（插件侧封装）
fn call_host(state: &State, method: &str, params: &str) -> (LlStatus, Option<Value>) {
    let m = LlBuf { ptr: method.as_ptr() as *mut u8, len: method.len() };
    let p = LlBuf { ptr: params.as_ptr() as *mut u8, len: params.len() };
    let mut out = LlBuf::EMPTY;
    let status = unsafe { (state.api.call_host_service)(state.api.ctx, m, p, &mut out) };
    let value = if out.is_empty() {
        None
    } else {
        let bytes = unsafe { out.as_bytes() };
        let parsed = serde_json::from_slice(bytes).ok();
        unsafe { (state.api.free)(state.api.ctx, out) };
        parsed
    };
    (status, value)
}

/// 把 JSON 写进 out（宿主分配器），返回是否成功
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

// ── FFI 外壳 ────────────────────────────────────────────────────────────────

unsafe extern "C" fn echo_call(
    plugin_ctx: *mut core::ffi::c_void,
    method: LlBuf,
    params: LlBuf,
    out: *mut LlBuf,
) -> LlStatus { unsafe {
    // 状态指针在整段调用期间有效：本插件 shutdown 不释放它（见 echo_shutdown 注释）
    let state = &*(plugin_ctx as *const State);
    // panic 铁律：**整段**业务包进 catch_unwind（宿主 panic=abort，漏出去 = 杀主程序）
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
}}

/// 停用回调：**只停活动、不释放状态**。
/// 宿主可能不停库地重新启用（设置面板 disable → enable），释放 State 会造成 use-after-free；
/// 库句柄本身由宿主保留到进程退出，所以状态留给进程回收即可。
unsafe extern "C" fn echo_shutdown(_plugin_ctx: *mut core::ffi::c_void) {
    // 本插件没有后台线程/定时器；若有，在此停止（不要 drop 状态）
}

/// 唯一入口符号：宿主 dlsym 后调用一次。
/// 返回空指针 = 主动拒载（通常是宿主 ABI 低于本插件编译依据）。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ll_plugin_load(api: *const LlHostApi) -> *const LlPluginInfo { unsafe {
    let Ok(info) = catch_unwind(AssertUnwindSafe(|| load_inner(api))) else {
        return std::ptr::null_mut();
    };
    info
}}

unsafe fn load_inner(api: *const LlHostApi) -> *const LlPluginInfo { unsafe {
    // 宿主侧已把 LlHostApi 泄漏为 'static（与库句柄同寿命），这里显式定型
    let api: &'static LlHostApi = &*api;
    if !host_satisfies(api.abi_major, api.abi_minor) {
        return std::ptr::null_mut();
    }
    let state = Box::into_raw(Box::new(State { api }));
    let info = Box::into_raw(Box::new(LlPluginInfo {
        abi_major: LL_ABI_MAJOR,
        abi_minor: LL_ABI_MINOR,
        id: LlStr::new("echo"),
        name: LlStr::new("Echo 示例"),
        version: LlStr::new("0.2.0"),
        plugin_ctx: state as *mut core::ffi::c_void,
        vtable: LlPluginVTable { call: echo_call, shutdown: echo_shutdown },
    }));
    info
}}
