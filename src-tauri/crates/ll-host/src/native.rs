//! native 动态库插件后端（M1，方案见 docs/plugin-native-dylib-design.md）
//!
//! 参照 DeaDBeeF 的加载模型（`src/plugins.c` 的 load_plugin / plug_init_plugin）：
//! - 扫描阶段由 `llp.rs::register_external_plugins` 统一驱动（manifest 已解析、
//!   同 id 去重与内置冲突检查已完成），本模块只负责**加载单个动态库**；
//! - `ll_plugin_load(&LlHostApi) -> *const LlPluginInfo`，ABI 门控规则与 deadbeef 相同：
//!   major 必须相等、插件要求的 minor 不得高于宿主，否则拒载并记 WARNING；
//! - 加载成功后包成 [`NativeBackend`] 注册进同一张 registry——
//!   对 `plugin_call` / 设置启停 / `/help` 而言与 builtin/LLP 无任何差别。
//!
//! ## 生命周期决策（规避 Rust dylib 的 dlclose 坑）
//! 加载成功的库句柄**刻意泄漏到进程退出**：停用插件只调用 vtable.shutdown，不 dlclose——
//! Rust dylib 的 TLS 析构/静态初始化在 dlclose 后是已知崩溃源（deadbeef 无此问题，
//! 因为 C 插件没有运行时析构）。加载失败的路径会 drop 掉 Library（正常 dlclose）：
//! 此时插件代码从未运行过、无线程无 TLS，卸载是安全的。
//!
//! ## 信任模型
//! native 插件与宿主同进程同权限——插件 UB = 主程序崩溃。要隔离请用 `llp` 形态。

use crate::services::{dispatch_svc, LogFn};
use libloading::Library;
use ll_plugin_abi::{
    abi_compatible_with_host, LlBuf, LlChunkSink, LlHostApi, LlPluginInfo, LlPluginVTable, LlStatus,
    LL_ABI_MAJOR, LL_ABI_MINOR, LL_ERR, LL_OK, LL_PANIC, LL_UNSUPPORTED_METHOD,
};
use ll_plugin_api::{PluginBackend, PluginContext, PluginError, PluginManifest};
use serde_json::{json, Value as JsonValue};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

// ─────────────────────────────────────────────────────────────────────────────
// HostBridge：LlHostApi 的宿主侧实现（每个插件一份，泄漏为 'static）
// ─────────────────────────────────────────────────────────────────────────────

/// 宿主桥状态：`LlHostApi.ctx` 指向它，桥接函数从这里取回上下文。
pub struct HostBridge {
    pub plugin_id: String,
    /// svc 分发需要的插件上下文（权限已按 manifest 门控）；init 之前就绪
    pub ctx: Mutex<Option<PluginContext>>,
    pub log: LogFn,
}

impl HostBridge {
    fn say(&self, message: &str) {
        (self.log)(&self.plugin_id, message);
    }

    /// 启用时注入上下文（init 回调里调用）
    fn set_ctx(&self, ctx: PluginContext) {
        if let Ok(mut guard) = self.ctx.lock() {
            *guard = Some(ctx);
        }
    }

    /// 停用时撤掉上下文：禁用后插件遗留线程不能再触达 svc.*
    fn clear_ctx(&self) {
        if let Ok(mut guard) = self.ctx.lock() {
            *guard = None;
        }
    }

    fn with_ctx<R>(&self, f: impl FnOnce(&PluginContext) -> R) -> Option<R> {
        let guard = self.ctx.lock().ok()?;
        let ctx = guard.as_ref()?;
        Some(f(ctx))
    }

    /// 宿主侧分配（`LlHostApi.alloc` 的实现）：1 字节对齐裸分配，len 由 LlBuf 携带
    fn alloc_buf(&self, len: usize) -> LlBuf {
        if len == 0 {
            return LlBuf::EMPTY;
        }
        match std::alloc::Layout::from_size_align(len, 1) {
            Ok(layout) => {
                let ptr = unsafe { std::alloc::alloc(layout) };
                if ptr.is_null() {
                    LlBuf::EMPTY
                } else {
                    LlBuf { ptr, len }
                }
            }
            Err(_) => LlBuf::EMPTY,
        }
    }

    /// 宿主侧释放（`LlHostApi.free` 的实现）：与 alloc_buf 配对
    fn free_buf(&self, buf: LlBuf) {
        if buf.is_empty() {
            return;
        }
        if let Ok(layout) = std::alloc::Layout::from_size_align(buf.len, 1) {
            unsafe { std::alloc::dealloc(buf.ptr, layout) };
        }
    }

    /// 把一个 JSON 值写进 out（用宿主分配器）；返回是否写入成功
    fn write_out(&self, out: *mut LlBuf, value: &JsonValue) -> bool {
        let bytes = value.to_string().into_bytes();
        let buf = self.alloc_buf(bytes.len());
        if buf.is_empty() {
            return false;
        }
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), buf.ptr, bytes.len()) };
        unsafe { *out = buf };
        true
    }
}

// ── LlHostApi 的四个桥接函数（宿主侧实现，panic=abort 档下不做 catch_unwind：
//    宿主代码只做序列化/分发，保持不 panic 的纪律即可）──

unsafe extern "C" fn bridge_alloc(ctx: *mut c_void, len: usize) -> LlBuf { unsafe {
    let bridge = &*(ctx as *const HostBridge);
    bridge.alloc_buf(len)
}}

unsafe extern "C" fn bridge_free(ctx: *mut c_void, buf: LlBuf) { unsafe {
    let bridge = &*(ctx as *const HostBridge);
    bridge.free_buf(buf)
}}

unsafe extern "C" fn bridge_call_service(
    ctx: *mut c_void,
    method: LlBuf,
    params: LlBuf,
    out: *mut LlBuf,
) -> LlStatus { unsafe {
    let bridge = &*(ctx as *const HostBridge);
    // 插件传进来的字节并非可信 UTF-8：用 lossy 降级而非 unchecked（宿主是信任锚点，不得 UB）
    let method = String::from_utf8_lossy(method.as_bytes()).into_owned();
    let params: JsonValue = if params.is_empty() {
        JsonValue::Null
    } else {
        serde_json::from_slice(params.as_bytes()).unwrap_or(JsonValue::Null)
    };

    // native 插件只能触达宿主保留命名空间 svc.*（与 LLP sidecar 的反向请求同口径）；
    // 自己的业务方法走反方向：前端 plugin_call → NativeBackend::call → 插件 vtable。
    let result = if !method.starts_with("svc.") {
        Err(PluginError::bad_params(
            "native 插件只能调用 svc.* 宿主服务（业务方法由宿主反向调用插件）",
        ))
    } else {
        match bridge.with_ctx(|c| dispatch_svc(c, &method, &params, None)) {
            Some(r) => r,
            None => Err(PluginError::internal("宿主上下文未就绪（插件已停用？）")),
        }
    };

    match result {
        Ok(v) => {
            if bridge.write_out(out, &v) {
                LL_OK
            } else {
                LL_ERR
            }
        }
        Err(e) => {
            bridge.write_out(out, &json!({ "error": e.to_string() }));
            LL_ERR
        }
    }
}}

unsafe extern "C" fn bridge_log(ctx: *mut c_void, level: LlBuf, message: LlBuf) { unsafe {
    let bridge = &*(ctx as *const HostBridge);
    let level = String::from_utf8_lossy(level.as_bytes());
    let message = String::from_utf8_lossy(message.as_bytes());
    bridge.say(&format!("[{level}] {message}"));
}}
/// 流式 HTTP（ABI 1.1）：把 `HttpApi::send_stream` 的逐块回调原样桥给插件。
///
/// 与 `svc.http.send` 的区别就在**这里是真正的流**：宿主 ureq 每读到一块就同步
/// 调插件侧的 sink（同进程函数调用，零序列化往返），插件闭包可据此实时推前端事件。
unsafe extern "C" fn bridge_http_stream(
    ctx: *mut c_void,
    request: LlBuf,
    sink_ctx: *mut c_void,
    sink: LlChunkSink,
    out: *mut LlBuf,
) -> LlStatus { unsafe {
    let bridge = &*(ctx as *const HostBridge);
    let req_json: JsonValue = if request.is_empty() {
        JsonValue::Null
    } else {
        serde_json::from_slice(request.as_bytes()).unwrap_or(JsonValue::Null)
    };
    let req = ll_plugin_api::HttpRequest {
        method: req_json
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .to_string(),
        url: req_json
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        headers: req_json
            .get("headers")
            .and_then(|v| v.as_array())
            .map(|pairs| {
                pairs
                    .iter()
                    .filter_map(|pair| {
                        let pair = pair.as_array()?;
                        Some((
                            pair.first()?.as_str()?.to_string(),
                            pair.get(1)?.as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        body: req_json
            .get("body")
            .and_then(|v| v.as_str())
            .map(String::from),
    };

    let result = bridge.with_ctx(|plugin_ctx| {
        let http = plugin_ctx
            .http
            .as_ref()
            .ok_or_else(|| PluginError::permission_denied("net:<host>（manifest 未声明域名白名单）"))?;
        http.send_stream(req, &mut |chunk: &str| {
            let bytes = chunk.as_bytes();
            if bytes.is_empty() {
                return true;
            }
            let buf = bridge.alloc_buf(bytes.len());
            if buf.is_empty() {
                return false; // 分配失败 → 中止读取，按错误返回
            }
            core::ptr::copy_nonoverlapping(bytes.as_ptr(), buf.ptr, bytes.len());
            let abort = sink(sink_ctx, buf) != 0;
            bridge.free_buf(buf);
            !abort
        })
    });

    match result {
        Some(Ok(status)) => {
            bridge.write_out(out, &json!({ "status": status }));
            LL_OK
        }
        Some(Err(e)) => {
            bridge.write_out(out, &json!({ "error": e.to_string() }));
            LL_ERR
        }
        None => {
            bridge
                .write_out(out, &json!({ "error": "宿主上下文未就绪（插件已停用？）" }));
            LL_ERR
        }
    }
}}

// ─────────────────────────────────────────────────────────────────────────────
// NativeBackend：注册进宿主 registry 的 PluginBackend 实现
// ─────────────────────────────────────────────────────────────────────────────

pub struct NativeBackend {
    manifest: PluginManifest,
    plugin_dir: PathBuf,
    /// 刻意泄漏：句柄保留到进程退出（见模块注释「生命周期决策」）
    _lib: &'static Library,
    plugin_ctx: *mut c_void,
    vtable: LlPluginVTable,
    bridge: &'static HostBridge,
    /// 停用门：shutdown 之后拒调（防「禁用→启用」链路上插件已释放状态的 use-after-free）
    stopped: std::sync::atomic::AtomicBool,
}

// 安全依据：插件 ABI 契约要求 call/shutdown 可从任意线程调用（内部自行加锁），
// 与 deadbeef 对插件线程模型的要求一致；本结构体本身持有的都是不可变引用。
unsafe impl Send for NativeBackend {}
unsafe impl Sync for NativeBackend {}

impl NativeBackend {
    pub fn plugin_dir(&self) -> &Path {
        &self.plugin_dir
    }
}

/// 加载单个 native 动态库插件（调用方已完成 manifest 解析与同 id 去重）。
/// 失败返回 None 并记录日志，绝不 panic、绝不阻塞扫描循环。
pub fn load_native_plugin(
    manifest: &PluginManifest,
    plugin_dir: &Path,
    ctx: PluginContext,
    log: &LogFn,
) -> Option<NativeBackend> {
    let plugin_id = manifest.id.clone();
    let say = |msg: &str| (log)(&plugin_id, msg);

    // 按**当前平台后缀**挑产物：同一目录可能同时带 dll 与 so（便携包/双平台 CI）
    let suffix = ll_plugin_api::native_lib_suffix();
    let picked = manifest
        .backend
        .pick_library(suffix, |e| plugin_dir.join(e).is_file());
    let Some(entry) = picked else {
        if manifest.backend.entry.is_empty() {
            say("backend.kind=native 但未声明 backend.entry（动态库文件名），已跳过");
        } else {
            say(&format!(
                "动态库不存在（本平台需要 {suffix}）: {}（请先构建插件，见 plugins/<id>/native 的构建脚本）",
                manifest.backend.entry.join(", ")
            ));
        }
        return None;
    };
    let lib_path = plugin_dir.join(entry);

    // M4 完整性校验：manifest 声明 integrity = "sha256:<hex>" 时强制比对，
    // 不匹配拒载（供应链防线）；未声明则记提醒日志（软策略，便携分发建议声明）
    match &manifest.backend.integrity {
        Some(expected) => {
            let actual = match sha256_file_hex(&lib_path) {
                Ok(h) => h,
                Err(e) => {
                    say(&format!("完整性校验无法执行（读取动态库失败）: {e}"));
                    return None;
                }
            };
            let expected_norm = expected.trim().to_ascii_lowercase();
            let actual_fmt = format!("sha256:{actual}");
            if expected_norm != actual_fmt {
                say(&format!(
                    "完整性校验失败: manifest 期望 {expected_norm}，动态库实际 sha256:{actual}，拒载",
                ));
                return None;
            }
            say(&format!("完整性校验通过: sha256:{actual}"));
        }
        None => say("提醒: manifest 未声明 backend.integrity（sha256:<hex>），动态库来源无法校验"),
    }

    let lib = match unsafe { Library::new(&lib_path) } {
        Ok(l) => l,
        Err(e) => {
            say(&format!("动态库加载失败（dlopen）: {e}"));
            return None;
        }
    };

    let result = unsafe {
        let load: libloading::Symbol<
            unsafe extern "C" fn(api: *const LlHostApi) -> *const LlPluginInfo,
        > = match lib.get(b"ll_plugin_load\0") {
            Ok(s) => s,
            Err(e) => {
                say(&format!("入口符号 ll_plugin_load 缺失（dlsym）: {e}"));
                return None; // lib drop → dlclose；插件代码未运行过，卸载安全
            }
        };

        // 桥与宿主 API 都泄漏为 'static：插件运行期始终有效（与库句柄同寿命）
        let bridge: &'static HostBridge = Box::leak(Box::new(HostBridge {
            plugin_id: plugin_id.clone(),
            ctx: Mutex::new(Some(ctx)),
            log: Arc::clone(log),
        }));
        let host_api: &'static LlHostApi = Box::leak(Box::new(LlHostApi {
            abi_major: LL_ABI_MAJOR,
            abi_minor: LL_ABI_MINOR,
            ctx: bridge as *const HostBridge as *mut c_void,
            alloc: bridge_alloc,
            free: bridge_free,
            call_host_service: bridge_call_service,
            log: bridge_log,
            http_stream: bridge_http_stream,
        }));

        let info_ptr = load(host_api);
        // 从这里起插件代码已经跑过（可能起线程/注册 TLS）：句柄一律泄漏到进程退出，
        // 后续任何失败路径都不 dlclose（Rust dylib 卸载后线程/TLS 回调是已知崩溃源）
        let lib: &'static Library = Box::leak(Box::new(lib));
        if info_ptr.is_null() {
            say("插件主动拒绝加载（ll_plugin_load 返回空，通常是宿主 ABI 低于插件要求）");
            return None;
        }
        let info: &LlPluginInfo = &*info_ptr;

        // deadbeef 同款门控：major 必须相等，插件要求的 minor 不得高于宿主
        if !abi_compatible_with_host(info.abi_major, info.abi_minor) {
            say(&format!(
                "WARNING: 插件要求 ABI v{}.{}（宿主 v{LL_ABI_MAJOR}.{LL_ABI_MINOR}），拒载",
                info.abi_major, info.abi_minor
            ));
            return None;
        }

        // M4 复核：dlopen 之后再看一次哈希（缩小 manifest→hash→dlopen 之间的替换窗口；
        // 对同时篡改 manifest 的攻击者无效——那是安装时签名/白名单要解决的问题）
        if let Some(expected) = &manifest.backend.integrity {
            if let Ok(actual2) = sha256_file_hex(&lib_path) {
                if !expected.trim().eq_ignore_ascii_case(&format!("sha256:{actual2}")) {
                    say("完整性复核失败（加载期间动态库被替换？），拒载");
                    return None;
                }
            }
        }

        let info_id = info.id.as_str().to_string();
        if info_id != manifest.id {
            say(&format!(
                "描述符 id（{info_id}）与 manifest.id（{}）不一致，拒载",
                manifest.id
            ));
            return None;
        }

        say(&format!(
            "已加载 native 插件: {} v{}（ABI v{}.{}，来源 {}）",
            info.name.as_str_unchecked(),
            info.version.as_str_unchecked(),
            info.abi_major,
            info.abi_minor,
            lib_path.display(),
        ));

        Some(NativeBackend {
            manifest: manifest.clone(),
            plugin_dir: plugin_dir.to_path_buf(),
            _lib: lib,
            plugin_ctx: info.plugin_ctx,
            vtable: info.vtable,
            bridge,
            stopped: std::sync::atomic::AtomicBool::new(false),
        })
    };
    result
}

impl PluginBackend for NativeBackend {
    fn manifest(&self) -> PluginManifest {
        self.manifest.clone()
    }

    fn init(&self, ctx: PluginContext) -> Result<(), PluginError> {
        // 宿主每次启用都会调 init：把最新的门控上下文装回桥，并清除停用门。
        // （插件侧契约：shutdown 只停活动，不释放仍会被后续调用使用的状态——见 ABI 文档）
        self.bridge.set_ctx(ctx);
        self.stopped.store(false, std::sync::atomic::Ordering::Release);
        self.bridge.say("native 插件已注册（进程内动态库）");
        Ok(())
    }

    fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, PluginError> {
        if self.stopped.load(std::sync::atomic::Ordering::Acquire) {
            return Err(PluginError::internal(
                "插件已停用（在设置面板重新启用后可恢复）",
            ));
        }
        let mut method_bytes = method.as_bytes().to_vec();
        let mut params_bytes = params.to_string().into_bytes();
        let m = LlBuf { ptr: method_bytes.as_mut_ptr(), len: method_bytes.len() };
        let p = LlBuf { ptr: params_bytes.as_mut_ptr(), len: params_bytes.len() };
        let mut out = LlBuf::EMPTY;

        let status: LlStatus = unsafe { (self.vtable.call)(self.plugin_ctx, m, p, &mut out) };

        // 读 out（宿主分配，插件只读）后立刻归还
        let out_value: JsonValue = if out.is_empty() {
            JsonValue::Null
        } else {
            let bytes = unsafe { out.as_bytes() };
            serde_json::from_slice(bytes)
                .unwrap_or_else(|_| json!({ "error": "插件返回了非 JSON 结果" }))
        };
        if !out.is_empty() {
            self.bridge.free_buf(out);
        }

        match status {
            LL_OK => Ok(out_value),
            LL_UNSUPPORTED_METHOD => Err(PluginError::unknown_method(method)),
            LL_PANIC => Err(PluginError::internal(format!(
                "插件内部 panic: {}",
                error_text(&out_value, "未提供详情")
            ))),
            // LL_ERR 与未知状态码统一按业务错误处理
            _ => Err(PluginError::internal(error_text(&out_value, "插件返回错误"))),
        }
    }

    fn shutdown(&self) {
        // 先拒后续调用并撤掉 svc 上下文（遗留线程失去权限），再通知插件停止活动
        self.stopped.store(true, std::sync::atomic::Ordering::Release);
        unsafe { (self.vtable.shutdown)(self.plugin_ctx) };
        self.bridge.clear_ctx();
        self.bridge.say("native 插件已停用（库句柄保留到进程退出）");
    }
}

fn error_text(value: &JsonValue, fallback: &str) -> String {
    value
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or(fallback)
        .to_string()
}

/// 计算文件 sha256 并输出 64 位小写十六进制（M4 完整性校验）
fn sha256_file_hex(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes =
        std::fs::read(path).map_err(|e| format!("读取失败: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest {
        hex.push_str(&format!("{b:02x}"));
    }
    Ok(hex)
}
