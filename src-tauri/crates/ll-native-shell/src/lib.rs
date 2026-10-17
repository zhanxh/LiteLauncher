//! ll-native-shell —— native 插件的宿主上下文适配器（M2 试点基建）
//!
//! 目标：让为 builtin 形态写的插件后端（依赖 `ll_plugin_api::PluginContext` 的类型化句柄）
//! **零改动**跑进 native 动态库。做法是把 `LlHostApi::call_host_service`（宿主 `svc.*`
//! JSON 通道）反向适配成 `PluginContext` 的各 trait 句柄：
//!
//! ```text
//! builtin:   NotesPlugin ──> DbApi/WindowApi/...（宿主注入的类型化句柄）
//! native:    NotesPlugin ──> ForwardDb/ForwardWindow/...（本 crate）──> call_host_service ──> 宿主 svc.* 分发器
//! ```
//!
//! 两跳 JSON 序列化的开销对笔记类调用频率完全无感（μs 级），换来的是
//! 插件逻辑与宿主演进解耦、可独立分发。
//!
//! ## 权限对齐
//! `build_context` 按 manifest.permissions 决定哪些句柄注入 Some/None——
//! 与宿主 `build_context_from_parts` 的门控口径一致，native 化不放大能力面。
//!
//! ## 初始化时序
//! 宿主对 native 插件只调 `vtable.call`，没有独立的 init 钩子；需要 init(ctx)
//! 的后端用 [`NativeRunner`]（Once 语义：首次 call 前完成 init，失败记忆化）。

use ll_plugin_abi::{LlBuf, LlHostApi, LlStatus, LL_OK};
use ll_plugin_api::{
    ClipboardApi, DbApi, DesktopAttachResult, EventApi, HttpApi, HttpRequest, LogApi, NotifyApi,
    PluginContext, PluginError, PluginManifest, ProcessApi, SecretApi, SettingsApi, WindowApi,
};
use serde_json::{json, Value as JsonValue};
use std::ffi::c_void;
use std::sync::Arc;

/// 持有宿主 API 的服务调用器：所有转发句柄共用
pub struct Shell {
    api: &'static LlHostApi,
}

impl Shell {
    /// 宿主在 `ll_plugin_load` 阶段传入的 API 指针（宿主已泄漏为 'static）
    ///
    /// # Safety
    /// api 必须指向宿主泄漏的有效 LlHostApi（生命周期 = 进程）
    pub unsafe fn new(api: *const LlHostApi, plugin_id: &str) -> Self {
        // 显式定型 'static：宿主侧泄漏的桥与库句柄同寿命
        let api: &'static LlHostApi = unsafe { &*api };
        let _ = plugin_id; // 保留参数形状：日志等场景未来可能需要 id
        Self { api }
    }

    /// 底层宿主 API 指针（写 out 缓冲时用它的 alloc/free）
    pub fn api(&self) -> &'static LlHostApi {
        self.api
    }

    /// 调宿主 svc.* 分发器：成功 → JSON；失败 → PluginError（错误文本来自 {"error"}）
    pub fn call(&self, method: &str, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let m = method.as_bytes();
        let p = params.to_string().into_bytes();
        let m_buf = LlBuf { ptr: m.as_ptr() as *mut u8, len: m.len() };
        let p_buf = LlBuf { ptr: p.as_ptr() as *mut u8, len: p.len() };
        let mut out = LlBuf::EMPTY;
        let status: LlStatus =
            unsafe { (self.api.call_host_service)(self.api.ctx, m_buf, p_buf, &mut out) };
        let out_value: JsonValue = if out.is_empty() {
            JsonValue::Null
        } else {
            let bytes = unsafe { out.as_bytes() }.to_vec();
            unsafe { (self.api.free)(self.api.ctx, out) };
            serde_json::from_slice(&bytes).unwrap_or(json!({ "error": "宿主返回非 JSON" }))
        };
        match status {
            LL_OK => Ok(out_value),
            _ => Err(PluginError::internal(
                out_value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("宿主服务调用失败")
                    .to_string(),
            )),
        }
    }

    /// 按 manifest 权限镜像宿主门控，构造出 builtin 后端所需的 PluginContext。
    /// settings/log/events 宿主不门控，恒注入；db/windows/process/clipboard/notify
    /// 只在 manifest 声明了对应权限时注入。
    pub fn build_context(self: &Arc<Self>, manifest: &PluginManifest) -> PluginContext {
        let granted = |p: &str| manifest.permissions.iter().any(|x| x == p);
        PluginContext {
            db: granted("db").then(|| Arc::new(ForwardDb { shell: Arc::clone(self) }) as Arc<dyn DbApi>),
            windows: granted("windows")
                .then(|| Arc::new(ForwardWindow { shell: Arc::clone(self) }) as Arc<dyn WindowApi>),
            notify: granted("notifications")
                .then(|| Arc::new(ForwardNotify { shell: Arc::clone(self) }) as Arc<dyn NotifyApi>),
            process: granted("process")
                .then(|| Arc::new(ForwardProcess { shell: Arc::clone(self) }) as Arc<dyn ProcessApi>),
            secrets: granted("secrets")
                .then(|| Arc::new(ForwardSecrets { shell: Arc::clone(self) }) as Arc<dyn SecretApi>),
            // http 的准入凭证 = manifest 的 net:<host> 白名单（宿主侧逐域名校验）
            http: manifest
                .permissions
                .iter()
                .any(|p| p.starts_with("net:"))
                .then(|| Arc::new(ForwardHttp { shell: Arc::clone(self) }) as Arc<dyn HttpApi>),
            clipboard: (granted("clipboard:write") || granted("clipboard:read"))
                .then(|| Arc::new(ForwardClipboard { shell: Arc::clone(self) }) as Arc<dyn ClipboardApi>),
            screen: None,
            shortcuts: None,
            clipboard_history: None,
            events: Arc::new(ForwardEvents { shell: Arc::clone(self) }),
            settings: Arc::new(ForwardSettings { shell: Arc::clone(self) }),
            log: Arc::new(ForwardLog { shell: Arc::clone(self) }),
        }
    }
}

// 安全依据：LlHostApi 的桥接函数（宿主侧）全部只读桥状态 + serde 序列化，
// HostBridge 本身 Send+Sync（String + Mutex<Option<PluginContext>> + Arc<LogFn>）；
// ABI 契约也要求宿主能力可从任意线程调用。
unsafe impl Send for Shell {}
unsafe impl Sync for Shell {}

// ── 转发句柄实现（每个 trait 一个薄壳，参数 ↔ svc JSON 形状见 ll-host/services.rs）──

macro_rules! shell_call {
    ($self:expr, $method:expr, {$($k:literal : $v:expr),* $(,)?}) => {
        $self.shell.call($method, &serde_json::json!({ $($k: $v,)* }))
    };
}

struct ForwardDb {
    shell: Arc<Shell>,
}

impl DbApi for ForwardDb {
    fn migrate(&self, statements: &[&str]) -> Result<(), PluginError> {
        shell_call!(self, "svc.db.migrate", { "statements": statements })?;
        Ok(())
    }
    fn execute(&self, sql: &str, params: &[JsonValue]) -> Result<u64, PluginError> {
        let affected = shell_call!(self, "svc.db.execute", { "sql": sql, "params": params })?;
        Ok(affected.as_u64().unwrap_or(0))
    }
    fn query(&self, sql: &str, params: &[JsonValue]) -> Result<Vec<JsonValue>, PluginError> {
        let rows = shell_call!(self, "svc.db.query", { "sql": sql, "params": params })?;
        Ok(rows.as_array().cloned().unwrap_or_default())
    }
}

struct ForwardWindow {
    shell: Arc<Shell>,
}

impl WindowApi for ForwardWindow {
    fn open(&self, view_id: &str, params: &[(String, String)]) -> Result<(), PluginError> {
        // svc.window.open 的 params 是 JSON 对象（标量值）——WindowApi 契约里是 (k,v) 对
        let mut map = serde_json::Map::new();
        for (k, v) in params {
            map.insert(k.clone(), json!(v));
        }
        shell_call!(self, "svc.window.open", { "view": view_id, "params": map })?;
        Ok(())
    }
    fn set_content_size(
        &self,
        _caller_label: &str,
        _width: Option<f64>,
        _height: Option<f64>,
    ) -> Result<ll_plugin_api::AppliedSize, PluginError> {
        // 宿主 svc 通道的 setContentSize 绑定“发起调用的窗口身份”（caller）,
        // 反向适配层没有窗口身份，如实拒绝（auto_height 视图暂不适用 native 形态）
        Err(PluginError::internal(
            "native 形态暂不支持 set_content_size（svc 通道无窗口身份，视图请用固定尺寸）",
        ))
    }
    fn attach_desktop(&self, label: &str) -> Result<DesktopAttachResult, PluginError> {
        let r = shell_call!(self, "svc.window.attachDesktop", { "label": label })?;
        serde_json::from_value(r)
            .map_err(|e| PluginError::internal(format!("svc.window.attachDesktop 返回形状不符: {e}")))
    }
    fn desktop_supported(&self) -> bool {
        matches!(
            shell_call!(self, "svc.window.desktopSupported", {}),
            Ok(v) if v.get("supported").and_then(|x| x.as_bool()).unwrap_or(false)
        )
    }
}

struct ForwardNotify {
    shell: Arc<Shell>,
}

impl NotifyApi for ForwardNotify {
    fn send(&self, title: &str, body: &str) -> Result<(), PluginError> {
        shell_call!(self, "svc.notify.send", { "title": title, "body": body })?;
        Ok(())
    }
}

struct ForwardProcess {
    shell: Arc<Shell>,
}

impl ProcessApi for ForwardProcess {
    fn launch(&self, target: &str) -> Result<(), PluginError> {
        shell_call!(self, "svc.process.launch", { "target": target })?;
        Ok(())
    }
    fn reveal(&self, path: &str) -> Result<(), PluginError> {
        shell_call!(self, "svc.process.reveal", { "target": path })?;
        Ok(())
    }
}

struct ForwardClipboard {
    shell: Arc<Shell>,
}

impl ClipboardApi for ForwardClipboard {
    fn write(&self, text: &str) -> Result<(), PluginError> {
        shell_call!(self, "svc.clipboard.write", { "text": text })?;
        Ok(())
    }
    fn read(&self) -> Result<Option<String>, PluginError> {
        let v = shell_call!(self, "svc.clipboard.read", {})?;
        Ok(v.as_str().map(String::from))
    }
    fn write_image(&self, _rgba: &[u8], _width: u32, _height: u32) -> Result<(), PluginError> {
        // 宿主 svc 通道没有图片剪贴板路由（图片本体走 svc.screen.savePng）
        Err(PluginError::internal(
            "native 形态暂不支持 write_image（svc 通道无图片剪贴板路由）",
        ))
    }
}

struct ForwardSettings {
    shell: Arc<Shell>,
}

impl SettingsApi for ForwardSettings {
    fn get(&self, key: &str) -> Option<String> {
        shell_call!(self, "svc.settings.get", { "key": key })
            .ok()
            .and_then(|v| v.as_str().map(String::from))
    }
    fn set(&self, key: &str, value: &str) -> Result<(), PluginError> {
        shell_call!(self, "svc.settings.set", { "key": key, "value": value })?;
        Ok(())
    }
}

struct ForwardLog {
    shell: Arc<Shell>,
}

impl LogApi for ForwardLog {
    fn log(&self, level: &str, msg: &str) {
        // 日志失败静默：日志通道本身不能成为业务失败源
        let _ = shell_call!(self, "svc.log.write", { "level": level, "message": msg });
    }
}

struct ForwardEvents {
    shell: Arc<Shell>,
}

impl EventApi for ForwardEvents {
    fn emit(&self, event: &str, payload: JsonValue) -> Result<(), PluginError> {
        shell_call!(self, "svc.events.emit", { "event": event, "payload": payload })?;
        Ok(())
    }
}
struct ForwardSecrets {
    shell: Arc<Shell>,
}

impl SecretApi for ForwardSecrets {
    fn get(&self, key: &str) -> Option<String> {
        shell_call!(self, "svc.secret.get", { "key": key })
            .ok()
            .and_then(|v| v.as_str().map(String::from))
    }
    fn set(&self, key: &str, value: &str) -> Result<(), PluginError> {
        shell_call!(self, "svc.secret.set", { "key": key, "value": value })?;
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), PluginError> {
        shell_call!(self, "svc.secret.delete", { "key": key })?;
        Ok(())
    }
}

struct ForwardHttp {
    shell: Arc<Shell>,
}

/// 把 `HttpRequest` 摊成宿主 svc 的 JSON 形状（headers 用 [[k,v],…]，serde 可直接读）
fn http_params(req: &HttpRequest) -> JsonValue {
    let headers: Vec<[String; 2]> = req
        .headers
        .iter()
        .map(|(k, v)| [k.clone(), v.clone()])
        .collect();
    let mut params = json!({
        "method": req.method,
        "url": req.url,
        "headers": headers,
    });
    if let Some(body) = req.body.as_ref() {
        params["body"] = json!(body);
    }
    params
}

impl HttpApi for ForwardHttp {
    fn send(&self, req: HttpRequest) -> Result<String, PluginError> {
        let out = self.shell.call("svc.http.send", &http_params(&req))?;
        out.get("body")
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| PluginError::internal("svc.http.send 未返回 body"))
    }

    /// 同进程流式：直接走 `LlHostApi.http_stream`，宿主每读到一块就调 [`chunk_sink`]，
    /// 再由它转回调用方的 `FnMut` 闭包——中间只有一次字节拷贝，没有 JSON 往返。
    fn send_stream(
        &self,
        req: HttpRequest,
        on_chunk: &mut dyn FnMut(&str) -> bool,
    ) -> Result<u16, PluginError> {
        let api = self.shell.api();
        if api.abi_minor < 1 {
            return Err(PluginError::internal(
                "宿主 ABI 低于 1.1，不支持流式 HTTP（请升级 LiteLauncher）",
            ));
        }
        let req_json = http_params(&req).to_string().into_bytes();
        let req_buf = LlBuf {
            ptr: req_json.as_ptr() as *mut u8,
            len: req_json.len(),
        };
        let mut sink = ChunkSink { cb: on_chunk };
        let mut out = LlBuf::EMPTY;
        let status = unsafe {
            (api.http_stream)(
                api.ctx,
                req_buf,
                &mut sink as *mut ChunkSink<'_> as *mut c_void,
                chunk_sink,
                &mut out,
            )
        };
        let out_value: JsonValue = if out.is_empty() {
            JsonValue::Null
        } else {
            let bytes = unsafe { out.as_bytes() }.to_vec();
            unsafe { (api.free)(api.ctx, out) };
            serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null)
        };
        if status != LL_OK {
            return Err(PluginError::internal(
                out_value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("宿主流式 HTTP 调用失败")
                    .to_string(),
            ));
        }
        out_value
            .get("status")
            .and_then(|v| v.as_u64())
            .map(|v| v as u16)
            .ok_or_else(|| PluginError::internal("宿主流式 HTTP 未返回 status"))
    }
}

/// sink 的栈上载体：`sink_ctx` 只指向本次调用期间存活的这个结构
struct ChunkSink<'a> {
    cb: &'a mut dyn FnMut(&str) -> bool,
}

unsafe extern "C" fn chunk_sink(ctx: *mut c_void, chunk: LlBuf) -> i32 {
    unsafe {
        let sink = &mut *(ctx as *mut ChunkSink<'_>);
        // 宿主读到的字节按 lossy 降级（与桥接层同口径，UTF-8 边界由宿主保证）
        let text = String::from_utf8_lossy(chunk.as_bytes());
        if (sink.cb)(&text) {
            0
        } else {
            1
        }
    }
}

// ── NativeRunner：把「宿主只调 call」的 native 世界与「需要 init(ctx)」的
//    builtin 后端契约接起来 ─────────────────────────────────────────────────

use std::sync::OnceLock;

/// 驱动一个 `PluginBackend`：加载后注入 shell，首次 call 前完成 init（Once 语义）。
/// `init` 失败会记忆化，后续每次 call 返回同一错误。
pub struct NativeRunner {
    shell: Arc<Shell>,
    manifest: PluginManifest,
    init_state: OnceLock<Result<(), String>>,
    init_fn: Box<dyn Fn(&PluginContext) -> Result<(), PluginError> + Send + Sync>,
}

impl NativeRunner {
    pub fn new(
        api: *const LlHostApi,
        plugin_id: &str,
        manifest: PluginManifest,
        init_fn: impl Fn(&PluginContext) -> Result<(), PluginError> + Send + Sync + 'static,
    ) -> Self {
        // Safety: 契约同 Shell::new —— api 由宿主泄漏，进程存活期有效
        let shell = unsafe { Shell::new(api, plugin_id) };
        Self { shell: Arc::new(shell), manifest, init_state: OnceLock::new(), init_fn: Box::new(init_fn) }
    }

    pub fn shell(&self) -> &Shell {
        &self.shell
    }

    /// Arc 形式：构造 PluginContext 时转发句柄需要 'static
    pub fn shell_arc(&self) -> Arc<Shell> {
        Arc::clone(&self.shell)
    }

    /// 幂等 init：成功后不再重复；失败记忆化并复述错误
    pub fn ensure_init(&self) -> Result<(), PluginError> {
        // get_or_init 保证并发首调也只跑一次 init_fn（OnceLock 语义；输家拿赢家的结果）
        let cached = self.init_state.get_or_init(|| {
            let ctx = self.shell.build_context(&self.manifest);
            match (self.init_fn)(&ctx) {
                Ok(()) => Ok(()),
                // 存裸 message：调用方会再包一层 PluginError，避免 "Internal: Internal:" 双前缀
                Err(e) => Err(e.message),
            }
        });
        cached.clone().map_err(PluginError::internal)
    }
}
