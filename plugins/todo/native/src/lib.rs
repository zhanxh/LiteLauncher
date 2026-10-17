//! todo —— LiteLauncher native 动态库薄壳（M5：builtin 全量剥离）
//!
//! 业务逻辑**零改动**复用 `ll_plugin_todo::TodoPlugin`：本壳只做两件事——
//! 1. `ll_plugin_load`：校验宿主 ABI → 用 ll-native-shell 把 `LlHostApi` 适配成
//!    `PluginContext`（按 manifest.permissions 镜像宿主门控）→ 回吐描述符；
//! 2. `vtable.call`：首次调用前完成 `init`（Once 语义），之后逐次转发。
//!
//! 构建：本目录执行 `build.cmd`，产物复制到 `plugins/todo/todo.dll`，
//! 重启主程序由扫描器加载（manifest.kind = native）。

use ll_native_shell::NativeRunner;
use ll_plugin_abi::{
    host_satisfies, LlBuf, LlHostApi, LlPluginInfo, LlPluginVTable, LlStatus, LlStr,
    LL_ABI_MAJOR, LL_ABI_MINOR, LL_ERR, LL_OK, LL_PANIC,
};
use ll_plugin_api::{PluginBackend, PluginManifest};
use ll_plugin_todo::TodoPlugin;
use serde_json::Value;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

/// 插件自持状态：runner（含 shell 与懒初始化）
struct State {
    runner: NativeRunner,
}

static BACKEND: std::sync::OnceLock<Arc<TodoPlugin>> = std::sync::OnceLock::new();

fn backend<R>(f: impl FnOnce(&TodoPlugin) -> R) -> R {
    let plugin = BACKEND.get().expect("backend 应在 load 阶段初始化");
    f(plugin)
}

unsafe extern "C" fn plugin_call(
    plugin_ctx: *mut core::ffi::c_void,
    method: LlBuf,
    params: LlBuf,
    out: *mut LlBuf,
) -> LlStatus { unsafe {
    // 状态指针在整段调用期间有效：shutdown 不释放它（见 plugin_shutdown 注释）
    let state = &*(plugin_ctx as *const State);
    let api = state.runner.shell().api();
    // panic 铁律：**整段**业务（含解析、初始化、业务转发）包进 catch_unwind
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let method = method.as_str_unchecked().to_string();
        let params: Value = if params.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(params.as_bytes()).unwrap_or(Value::Null)
        };
        let method = method.as_str();
        // 首次调用前完成 init（db 迁移等），失败记忆化
        if let Err(e) = state.runner.ensure_init() {
            return (LL_ERR, serde_json::json!({ "error": e.to_string() }));
        }
        match backend(|plugin| plugin.call(method, params)) {
            Ok(value) => (LL_OK, value),
            Err(e) => (LL_ERR, serde_json::json!({ "error": e.to_string() })),
        }
    }));
    match outcome {
        Ok((status, value)) => {
            if write_out(api, out, &value) {
                status
            } else {
                LL_ERR
            }
        }
        Err(_) => {
            write_out(api, out, &serde_json::json!({ "error": "插件内部 panic（已被边界拦截）" }));
            LL_PANIC
        }
    }
}}

/// 停用回调：**只停活动、不释放状态**（宿主可能不停库地重新启用）。
unsafe extern "C" fn plugin_shutdown(_plugin_ctx: *mut core::ffi::c_void) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        backend(|plugin| plugin.shutdown());
    }));
}

/// 把 JSON 写进 out（宿主分配器；插件只分配，宿主读走后归还）
fn write_out(api: &'static LlHostApi, out: *mut LlBuf, value: &Value) -> bool {
    let bytes = value.to_string().into_bytes();
    let buf = unsafe { (api.alloc)(api.ctx, bytes.len()) };
    if buf.is_empty() {
        return false;
    }
    unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), buf.ptr, bytes.len()) };
    unsafe { *out = buf };
    true
}

/// 唯一入口符号。返回空指针 = 主动拒载（宿主 ABI 低于本插件编译依据）
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ll_plugin_load(api: *const LlHostApi) -> *const LlPluginInfo { unsafe {
    let Ok(info) = catch_unwind(AssertUnwindSafe(|| load_inner(api))) else {
        return std::ptr::null_mut();
    };
    info
}}

unsafe fn load_inner(api: *const LlHostApi) -> *const LlPluginInfo { unsafe {
    let api_ref: &'static LlHostApi = &*api;
    if !host_satisfies(api_ref.abi_major, api_ref.abi_minor) {
        return std::ptr::null_mut();
    }

    // 描述符与宿主侧 manifest.json 同源（宿主会校验两边 id 一致）
    let manifest: PluginManifest =
        serde_json::from_str(include_str!("../../manifest.json")).expect("manifest 解析失败");
    let plugin_id = manifest.id.clone();

    let instance = Arc::new(TodoPlugin::new());
    let _ = BACKEND.set(Arc::clone(&instance));

    let runner = NativeRunner::new(api, &plugin_id, manifest, move |ctx| instance.init(ctx.clone()));
    let state = Box::into_raw(Box::new(State { runner }));

    let info = Box::into_raw(Box::new(LlPluginInfo {
        abi_major: LL_ABI_MAJOR,
        abi_minor: LL_ABI_MINOR,
        id: LlStr::new("todo"),
        name: LlStr::new("日程管理"),
        version: LlStr::new("0.1.0"),
        plugin_ctx: state as *mut core::ffi::c_void,
        vtable: LlPluginVTable { call: plugin_call, shutdown: plugin_shutdown },
    }));
    info
}}
