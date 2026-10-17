//! native-smoke —— LiteLauncher native 插件冒烟测试器
//!
//! 模拟宿主的加载协议（与 ll-host/src/native.rs 同一套 ABI 契约）：
//! dlopen → dlsym("ll_plugin_load") → 注入 stub 宿主 API → 校验描述符 → 调 vtable.call。
//!
//! 用法：
//!   cargo run --release -- <path-to-dll> [method] [params-json]
//!
//! 示例（在仓库根目录）：
//!   cargo run --release --manifest-path tools/native-smoke/Cargo.toml -- plugins/echo/echo.dll search "{\"keyword\":\"你好\"}"
//!   cargo run --release --manifest-path tools/native-smoke/Cargo.toml -- plugins/echo/echo.dll execute "{\"raw\":\"/echo say hi\",\"subcommand\":\"say\",\"args\":[\"hi\"]}"
//!
//! 注意：stub 宿主没有 svc 通道，插件调用 call_host_service 会收到 LL_ERR——
//! 插件应当把这类失败当作可降级路径处理（echo 的 ping_host 就是这么写的）。

use libloading::Library;
use ll_plugin_abi::{
    abi_compatible_with_host, LlBuf, LlChunkSink, LlHostApi, LlPluginInfo, LlStatus, LL_ABI_MAJOR,
    LL_ABI_MINOR, LL_ERR, LL_OK,
};
use serde_json::{json, Value};
use std::ffi::c_void;

// ── stub 宿主 API：分配器是真的，svc 通道是假的 ─────────────────────────────

const STUB_NAME: &str = "native-smoke";

unsafe extern "C" fn stub_alloc(_ctx: *mut c_void, len: usize) -> LlBuf {
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

unsafe extern "C" fn stub_free(_ctx: *mut c_void, buf: LlBuf) {
    if buf.is_empty() {
        return;
    }
    if let Ok(layout) = std::alloc::Layout::from_size_align(buf.len, 1) {
        unsafe { std::alloc::dealloc(buf.ptr, layout) };
    }
}

unsafe extern "C" fn stub_call_service(
    _ctx: *mut c_void,
    method: LlBuf,
    _params: LlBuf,
    out: *mut LlBuf,
) -> ll_plugin_abi::LlStatus {
    let method = unsafe { method.as_str_unchecked() }.to_string();
    let err = json!({ "error": format!("{STUB_NAME} 没有 svc 通道（方法 {method} 不可用）") });
    let bytes = err.to_string().into_bytes();
    let buf = unsafe { stub_alloc(_ctx, bytes.len()) };
    if buf.is_empty() {
        return LL_ERR;
    }
    unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), buf.ptr, bytes.len()) };
    unsafe { *out = buf };
    LL_ERR
}

unsafe extern "C" fn stub_log(_ctx: *mut c_void, level: LlBuf, message: LlBuf) {
    unsafe {
        eprintln!("[插件日志/{}] {}", level.as_str_unchecked(), message.as_str_unchecked());
    }
}

/// 冒烟器不提供网络：流式 HTTP 一律回错误（只验证 ABI 形状）
unsafe extern "C" fn stub_http_stream(
    _ctx: *mut c_void,
    _request: LlBuf,
    _sink_ctx: *mut c_void,
    _sink: LlChunkSink,
    out: *mut LlBuf,
) -> LlStatus {
    let msg = b"{\"error\":\"smoke stub has no network\"}";
    unsafe {
        let ptr = std::alloc::alloc(std::alloc::Layout::from_size_align(msg.len(), 1).unwrap());
        std::ptr::copy_nonoverlapping(msg.as_ptr(), ptr, msg.len());
        *out = LlBuf { ptr, len: msg.len() };
    }
    LL_ERR
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("用法: native-smoke <dll路径> [method] [params-json]");
        std::process::exit(2);
    }
    let dll_path = &args[1];
    let method = args.get(2).map(String::as_str).unwrap_or("search");
    let params_raw = args.get(3).cloned().unwrap_or_else(|| r#"{"keyword":null}"#.into());

    unsafe {
        // ── dlopen（对应 ll-host/native.rs 的加载流程）──
        let lib = match Library::new(dll_path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("✗ dlopen 失败: {e}");
                std::process::exit(1);
            }
        };
        let load: libloading::Symbol<
            unsafe extern "C" fn(api: *const LlHostApi) -> *const LlPluginInfo,
        > = match lib.get(b"ll_plugin_load\0") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("✗ 入口符号 ll_plugin_load 缺失: {e}");
                std::process::exit(1);
            }
        };

        let host_api = LlHostApi {
            abi_major: LL_ABI_MAJOR,
            abi_minor: LL_ABI_MINOR,
            ctx: std::ptr::null_mut(),
            alloc: stub_alloc,
            free: stub_free,
            call_host_service: stub_call_service,
            log: stub_log,
            http_stream: stub_http_stream,
        };

        let info_ptr = load(&host_api);
        if info_ptr.is_null() {
            eprintln!("✗ 插件主动拒载（ll_plugin_load 返回空）");
            std::process::exit(1);
        }
        let info: &LlPluginInfo = &*info_ptr;
        if !abi_compatible_with_host(info.abi_major, info.abi_minor) {
            eprintln!(
                "✗ ABI 门控不通过: 插件要求 v{}.{}（宿主 v{LL_ABI_MAJOR}.{LL_ABI_MINOR}）",
                info.abi_major, info.abi_minor
            );
            std::process::exit(1);
        }
        println!(
            "✓ 已加载: {} v{}（id={}, ABI v{}.{}）",
            info.name.as_str_unchecked(),
            info.version.as_str_unchecked(),
            info.id.as_str_unchecked(),
            info.abi_major,
            info.abi_minor,
        );

        // ── 业务调用 ──
        let m = LlBuf { ptr: method.as_ptr() as *mut u8, len: method.len() };
        let p = params_raw.as_bytes();
        let p = LlBuf { ptr: p.as_ptr() as *mut u8, len: p.len() };
        let mut out = LlBuf::EMPTY;
        let status: ll_plugin_abi::LlStatus = (info.vtable.call)(info.plugin_ctx, m, p, &mut out);

        let out_value: Value = if out.is_empty() {
            Value::Null
        } else {
            let bytes = out.as_bytes().to_vec();
            stub_free(std::ptr::null_mut(), out);
            serde_json::from_slice(&bytes).unwrap_or(json!({ "raw": String::from_utf8_lossy(&bytes) }))
        };

        match status {
            LL_OK => println!("✓ call({method}) → {}", serde_json::to_string_pretty(&out_value).unwrap_or_default()),
            LL_ERR => println!(
                "• call({method}) → 业务错误: {}",
                out_value.get("error").and_then(|v| v.as_str()).unwrap_or("?")
            ),
            code => println!("• call({method}) → 状态码 {code}: {}", serde_json::to_string_pretty(&out_value).unwrap_or_default()),
        }

        // ── shutdown（宿主默认不 dlclose；这里进程退出自然卸载）──
        (info.vtable.shutdown)(info.plugin_ctx);
        println!("✓ shutdown 完成");
    }
}
