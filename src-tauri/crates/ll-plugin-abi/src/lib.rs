//! ll-plugin-abi —— LiteLauncher 原生动态库插件的稳定 C-ABI（M1）
//!
//! 参照 DeaDBeeF 的插件模型（`include/deadbeef/deadbeef.h` + `src/plugins.c`）：
//! - 插件编译为独立 cdylib（`.dll` / `.so` / `.dylib`），导出唯一入口符号 `ll_plugin_load`；
//! - 宿主扫描 plugins 目录，dlopen 后按「major 必须相等、插件要求的 minor 不高于宿主」门控加载；
//! - 插件拿到 [`LlHostApi`]（宿主能力 vtable），返回 [`LlPluginInfo`]（描述符 + 业务 vtable）。
//!
//! ## 与 deadbeef 的关键差异
//! - **宿主能力通道只留一个函数**：`LlHostApi::call_host_service` = 宿主 `svc.*` JSON 分发器。
//!   deadbeef 的 `DB_functions_t` 是数百个函数指针的巨型 vtable（C 生态无奈）；
//!   本项目已有统一的 svc 管线，ABI 层不重复生长——新增能力 = 新增 svc 方法 + [`LL_ABI_MINOR`]+1。
//! - **manifest.json 仍是描述来源**：ABI 描述符只镜像 id/name/version 供加载期一致性校验。
//!
//! ## 内存铁律（跨边界最容易翻车的地方）
//! - 宿主 → 插件 的 [`LlBuf`]（method/params）：**只在本次调用期间有效**，插件不得保存或释放；
//! - 插件 → 宿主 的 [`LlBuf`]（out 结果）：**必须**用 `api.alloc` 分配，宿主读取后用 `api.free` 归还；
//! - 两侧 allocator 各管各的，任何一侧都不得释放对方分配的内存。
//!
//! ## panic 铁律
//! 插件侧每个 `extern "C"` 入口必须 `catch_unwind`（native 插件以独立 cargo 工程构建、
//! `panic = "unwind"`；宿主本体是 panic=abort，任何跨边界的 unwind 都等于杀掉用户的主程序）。
//! 完整样板见 `plugins/echo/native`（M1 示例插件）。
//!
//! ## 版本策略
//! - 追加能力 = [`LL_ABI_MINOR`] + 1（vtable 只在尾部追加，插件用状态码做降级）；
//! - 破坏性变更 = [`LL_ABI_MAJOR`] + 1，同时更换插件安装子目录（plugins/v1 → plugins/v2）。

#![no_std]

use core::ffi::c_void;

/// ABI 版本：破坏性变更 +major，追加式演进 +minor
///
/// - 1.0：首版（M1）—— ll_plugin_load / vtable.call / svc.* 总通道
/// - 1.1：`LlHostApi.http_stream` 尾部追加（同进程流式 HTTP，供 /ai 的 SSE 聊天）
pub const LL_ABI_MAJOR: u32 = 1;
pub const LL_ABI_MINOR: u32 = 1;

/// 跨边界调用状态码（vtable 各 fn 的返回值）
pub type LlStatus = i32;

/// 成功：out = 结果 JSON
pub const LL_OK: LlStatus = 0;
/// 业务错误：out = `{"error": "..."}`
pub const LL_ERR: LlStatus = 1;
/// 未知方法：out = `{"error": "..."}`
pub const LL_UNSUPPORTED_METHOD: LlStatus = 2;
/// 插件内部 panic（已被插件侧 catch_unwind 拦截）：out = `{"error": "..."}`
pub const LL_PANIC: LlStatus = 3;

/// 静态 UTF-8 字符串（描述符用；指向插件内的静态数据，进程存活期有效）
#[repr(C)]
#[derive(Clone, Copy)]
pub struct LlStr {
    pub ptr: *const u8,
    pub len: usize,
}

impl LlStr {
    /// 从 `&'static str` 构造（const，供静态/泄漏的描述符使用）
    pub const fn new(s: &'static str) -> Self {
        Self { ptr: s.as_ptr(), len: s.len() }
    }
    /// # Safety
    /// ptr 必须指向 len 字节的有效 UTF-8，且存活期覆盖使用期
    pub unsafe fn as_str<'a>(self) -> &'a str { unsafe {
        let bytes = core::slice::from_raw_parts(self.ptr, self.len);
        core::str::from_utf8(bytes).unwrap_or("")
    }}
    /// # Safety
    /// 同 [`LlStr::as_str`]，但不做 UTF-8 校验
    pub unsafe fn as_str_unchecked<'a>(self) -> &'a str { unsafe {
        let bytes = core::slice::from_raw_parts(self.ptr, self.len);
        core::str::from_utf8_unchecked(bytes)
    }}
}

/// 可变字节缓冲（跨边界传 JSON；由分配方负责释放）
#[repr(C)]
#[derive(Clone, Copy)]
pub struct LlBuf {
    pub ptr: *mut u8,
    pub len: usize,
}

impl LlBuf {
    /// 空缓冲。out 参数的初始值约定：调用前 *out 必须为 EMPTY，
    /// 非空 = 调用方违反契约（被调方可直接覆盖）。
    pub const EMPTY: LlBuf = LlBuf { ptr: core::ptr::null_mut(), len: 0 };

    pub const fn is_empty(self) -> bool {
        self.ptr.is_null() || self.len == 0
    }

    /// # Safety
    /// ptr 必须指向 len 字节可读内存
    pub unsafe fn as_bytes<'a>(self) -> &'a [u8] { unsafe {
        core::slice::from_raw_parts(self.ptr, self.len)
    }}

    /// # Safety
    /// ptr 必须指向 len 字节的有效 UTF-8（JSON 约定成立时成立）
    pub unsafe fn as_str_unchecked<'a>(self) -> &'a str { unsafe {
        let bytes = core::slice::from_raw_parts(self.ptr, self.len);
        core::str::from_utf8_unchecked(bytes)
    }}
}

/// 宿主能力包（deadbeef `DB_functions_t` 的最小化对应物）。
///
/// 只保留 4 个函数：能力扩展全部走 [`LlHostApi::call_host_service`]（= 宿主 `svc.*`
/// JSON 分发器，权限按插件 manifest 声明门控），vtable 不随功能膨胀。
#[repr(C)]
pub struct LlHostApi {
    /// 宿主 ABI 版本。插件在 `ll_plugin_load` 里应校验：
    /// major 相等且 minor ≥ 自己编译所依据的 minor，否则返回空指针主动拒载。
    pub abi_major: u32,
    pub abi_minor: u32,
    /// 宿主桥状态指针（对插件不透明；调用下列各 fn 时原样回传）
    pub ctx: *mut c_void,
    /// 宿主侧分配器：插件返回给宿主的每个 [`LlBuf`] **必须**由此分配
    pub alloc: unsafe extern "C" fn(ctx: *mut c_void, len: usize) -> LlBuf,
    /// 宿主侧释放器：与 `alloc` 配对（宿主读走 out 后调用）
    pub free: unsafe extern "C" fn(ctx: *mut c_void, buf: LlBuf),
    /// 宿主服务总入口（`svc.*` 命名空间）。
    ///
    /// - 成功 → [`LL_OK`]，宿主把结果 JSON 写入 `*out`（宿主 alloc 分配，下次调用前有效，只读）；
    /// - 失败 → [`LL_ERR`]，`*out` = `{"error": "..."}`；
    /// - method 不以 `svc.` 开头或无权限 → 同样 [`LL_ERR`]。
    pub call_host_service: unsafe extern "C" fn(
        ctx: *mut c_void,
        method: LlBuf,
        params: LlBuf,
        out: *mut LlBuf,
    ) -> LlStatus,
    /// 结构化日志（level ∈ "debug"/"info"/"warn"/"error"）
    pub log: unsafe extern "C" fn(ctx: *mut c_void, level: LlBuf, message: LlBuf),
    /// 流式 HTTP（ABI 1.1 尾部追加）：同进程下逐块回灌插件闭包——sidecar 形态做不到、
    /// 也不需要引入分块 JSON 协议。
    ///
    /// - `request` = JSON `{method,url,headers:[[k,v],…],body}`（`net:<host>` 白名单在宿主侧校验）；
    /// - 宿主每读到一块就调 `sink(sink_ctx, chunk)`，**sink 返回非 0 即中止读取**；
    /// - 结束：`*out` = `{"status": n}`；出错 = `{"error": "…"}`（均宿主 alloc）。
    ///
    /// 用前先校验 `abi_minor >= 1`（老宿主没有这个字段）。
    pub http_stream: unsafe extern "C" fn(
        ctx: *mut c_void,
        request: LlBuf,
        sink_ctx: *mut c_void,
        sink: LlChunkSink,
        out: *mut LlBuf,
    ) -> LlStatus,
}

/// 流式回调：宿主每读到一块数据就调一次；返回 0 = 继续，非 0 = 中止读取
pub type LlChunkSink = unsafe extern "C" fn(sink_ctx: *mut c_void, chunk: LlBuf) -> i32;

/// 插件业务 vtable（宿主在加载完成后调用；插件状态经 `plugin_ctx` 回传）
#[repr(C)]
#[derive(Clone, Copy)]
pub struct LlPluginVTable {
    /// 业务调用——与 builtin/LLP 后端的
    /// `call(method, params) -> Result<JsonValue, PluginError>` 同构：
    /// - 成功 → [`LL_OK`]，`*out` = 结果 JSON（用 api.alloc 分配）；
    /// - 业务错误 → [`LL_ERR`]，`*out` = `{"error": "..."}`；
    /// - 未知方法 → [`LL_UNSUPPORTED_METHOD`]；
    /// - panic 拦截后 → [`LL_PANIC`]。
    ///
    /// method/params 只在本次调用期间有效；不得保存、不得释放。
    pub call: unsafe extern "C" fn(
        plugin_ctx: *mut c_void,
        method: LlBuf,
        params: LlBuf,
        out: *mut LlBuf,
    ) -> LlStatus,
    /// 停用/宿主退出前调用。宿主默认**不 dlclose**（句柄保留到进程退出，规避 Rust dylib TLS/静态析构的 dlclose 坑）。
    ///
    /// **契约：只停活动，不释放状态**。宿主可能在不停库的前提下重新启用插件（设置面板
    /// disable → enable），此时会再次调 `call`；若在 shutdown 里 drop 掉自持状态，
    /// 重新启用后的首次调用就是 use-after-free。自持状态留给进程回收即可。
    /// 宿主侧另有停用门：shutdown 之后到下一次 init 之前，`call` 一律被拒。
    pub shutdown: unsafe extern "C" fn(plugin_ctx: *mut c_void),
}

/// 插件描述符（`ll_plugin_load` 的返回值）。
///
/// 指针与其中静态字符串必须进程存活期有效——宿主运行期会复述 id/版本信息。
#[repr(C)]
pub struct LlPluginInfo {
    /// 插件要求的 ABI 版本（宿主门控：major 必须相等，minor 不得高于宿主）
    pub abi_major: u32,
    pub abi_minor: u32,
    /// manifest.json 的镜像（宿主与文件 manifest 做 id 一致性校验）
    pub id: LlStr,
    pub name: LlStr,
    pub version: LlStr,
    /// 插件自持状态（插件自定义；vtable 各 fn 收回）
    pub plugin_ctx: *mut c_void,
    pub vtable: LlPluginVTable,
}

/// 宿主侧门控（deadbeef `plug_init_plugin` 同规则）：
/// 插件要求的 major 必须与宿主相等，且 minor **不得高于**宿主——
/// 插件可以要求比宿主旧的 minor（宿主只会多不会少），反之拒载。
pub const fn abi_compatible_with_host(plugin_major: u32, plugin_minor: u32) -> bool {
    plugin_major == LL_ABI_MAJOR && plugin_minor <= LL_ABI_MINOR
}

/// 插件侧门控（`ll_plugin_load` 开头自检）：
/// 宿主的 major 必须与自己编译依据的相等，且 minor **不低于**自己的要求。
pub const fn host_satisfies(host_major: u32, host_minor: u32) -> bool {
    host_major == LL_ABI_MAJOR && host_minor >= LL_ABI_MINOR
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_side_gate() {
        // 同 major 且插件要求不高于宿主 → 兼容
        assert!(abi_compatible_with_host(1, 0));
        assert!(abi_compatible_with_host(1, LL_ABI_MINOR));
        // major 不同 / 要求比宿主新 → 拒载
        assert!(!abi_compatible_with_host(2, 0));
        assert!(!abi_compatible_with_host(1, LL_ABI_MINOR + 1));
    }

    #[test]
    fn plugin_side_gate() {
        // 要求端是编译进本插件的 LL_ABI_* 常量，函数只接收宿主版本：
        // 宿主 major 相同且 minor ≥ 编译期要求 → 兼容；major 不同 → 拒载
        assert!(host_satisfies(LL_ABI_MAJOR, LL_ABI_MINOR));
        assert!(host_satisfies(LL_ABI_MAJOR, LL_ABI_MINOR + 5), "宿主更新 → 兼容");
        assert!(!host_satisfies(LL_ABI_MAJOR + 1, 0), "宿主 major 更新 → 拒载");
    }

    #[test]
    fn str_roundtrip() {
        let s = LlStr::new("echo 示例");
        let back = unsafe { s.as_str() };
        assert_eq!(back, "echo 示例");
        assert_eq!(s.len, "echo 示例".len());
    }

    #[test]
    fn buf_empty_contract() {
        assert!(LlBuf::EMPTY.is_empty());
        let mut data = [1u8, 2, 3];
        let b = LlBuf { ptr: data.as_mut_ptr(), len: 3 };
        assert!(!b.is_empty());
        assert_eq!(unsafe { b.as_bytes() }, &[1, 2, 3]);
    }
}
