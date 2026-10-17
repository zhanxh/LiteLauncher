//! notes —— LiteLauncher native 动态库薄壳（M2 试点）
//!
//! 业务逻辑**零改动**复用 `ll_plugin_notes::NotesPlugin`（builtin 时代的同一份代码）：
//! 本壳只做两件事——
//! 1. `ll_plugin_load`：校验宿主 ABI → 用 ll-native-shell 把 `LlHostApi` 适配成
//!    `PluginContext`（按 manifest.permissions 镜像宿主门控）→ 回吐描述符；
//! 2. `vtable.call`：首次调用前完成 `NotesPlugin::init`（Once 语义），之后逐次转发。
//!
//! db/窗口/进程/剪贴板句柄经 svc.* 反向通道两跳 JSON 到宿主——笔记类调用频率下
//! 开销无感，换来插件与宿主演进解耦、可独立分发（方案 §6.2 / §7）。
//!
//! 构建：本目录执行 `build.cmd`，产物复制到 `plugins/notes/notes.dll`，
//! 重启主程序由扫描器加载（manifest.kind = native）。

use ll_native_shell::NativeRunner;
use ll_plugin_abi::{
    host_satisfies, LlBuf, LlHostApi, LlPluginInfo, LlPluginVTable, LlStatus, LlStr,
    LL_ABI_MAJOR, LL_ABI_MINOR, LL_ERR, LL_OK, LL_PANIC,
};
use ll_plugin_api::{PluginBackend, PluginManifest};
use ll_plugin_notes::NotesPlugin;
use serde_json::Value;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

/// 插件自持状态：runner（含 shell 与懒初始化）
struct State {
    runner: NativeRunner,
}

// NotesPlugin 实例：native 插件每进程一份，与宿主注册表 1:1
static BACKEND: std::sync::OnceLock<Arc<NotesPlugin>> = std::sync::OnceLock::new();

fn notes_backend<R>(f: impl FnOnce(&NotesPlugin) -> R) -> R {
    let backend = BACKEND.get().expect("backend 应在 load 阶段初始化");
    f(backend)
}

unsafe extern "C" fn notes_call(
    plugin_ctx: *mut core::ffi::c_void,
    method: LlBuf,
    params: LlBuf,
    out: *mut LlBuf,
) -> LlStatus { unsafe {
    // 状态指针在整段调用期间有效：shutdown 不释放它（见 notes_shutdown 注释）
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
        // 首次调用前完成 init（db 迁移 + 笔记目录播种），失败记忆化
        if let Err(e) = state.runner.ensure_init() {
            return (LL_ERR, serde_json::json!({ "error": e.to_string() }));
        }
        // 业务逐次转发——NotesPlugin::call 的签名与宿主契约完全同构
        match notes_backend(|backend| backend.call(method, params)) {
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
unsafe extern "C" fn notes_shutdown(_plugin_ctx: *mut core::ffi::c_void) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // NotesPlugin::shutdown 是默认空实现；显式调用保持契约完整
        notes_backend(|backend| backend.shutdown());
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
        serde_json::from_str(include_str!("../../manifest.json")).expect("notes manifest 解析失败");
    let plugin_id = manifest.id.clone();

    let backend = Arc::new(NotesPlugin::new());
    let _ = BACKEND.set(Arc::clone(&backend));

    let runner = NativeRunner::new(api, &plugin_id, manifest, move |ctx| backend.init(ctx.clone()));
    let state = Box::into_raw(Box::new(State { runner }));

    let info = Box::into_raw(Box::new(LlPluginInfo {
        abi_major: LL_ABI_MAJOR,
        abi_minor: LL_ABI_MINOR,
        id: LlStr::new("notes"),
        name: LlStr::new("Markdown 笔记"),
        version: LlStr::new("0.2.0"),
        plugin_ctx: state as *mut core::ffi::c_void,
        vtable: LlPluginVTable { call: notes_call, shutdown: notes_shutdown },
    }));
    info
}}
