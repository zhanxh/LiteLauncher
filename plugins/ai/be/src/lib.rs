//! AI 插件（LPS-1 内置插件）：/ai 对话后端
//!
//! 能力链路（M7）：
//! - 密钥：SecretStore 托管（secret.ai.api_key），前端首次使用时录入，后端不可泄露到日志
//! - 网络：经宿主 HttpApi 代理（manifest 声明 net:api.openai.com 白名单），SSE 流式
//! - 推送：EventApi 以 `plugin-event` 广播 delta/done/error，前端按 id 过滤增量渲染
//! - 中断：前端 abort → AtomicBool → 宿主读循环回调返回 false 终止

use ll_plugin_api::{PluginBackend, PluginContext, PluginError, PluginManifest};
use serde_json::{json, Value as JsonValue};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const DEFAULT_MODEL: &str = "gpt-4o-mini";
const DEFAULT_BASE_URL: &str = "https://api.openai.com";
const COMPLETIONS_PATH: &str = "/v1/chat/completions";

pub struct AiPlugin {
    ctx: Mutex<Option<PluginContext>>,
    abort_flag: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
}

impl AiPlugin {
    pub fn new() -> Self {
        Self {
            ctx: Mutex::new(None),
            abort_flag: Arc::new(AtomicBool::new(false)),
            active: Arc::new(AtomicBool::new(false)),
        }
    }

    fn with_ctx<R>(
        &self,
        f: impl FnOnce(&PluginContext) -> Result<R, PluginError>,
    ) -> Result<R, PluginError> {
        let guard = self
            .ctx
            .lock()
            .map_err(|_| PluginError::internal("插件状态锁不可用"))?;
        let ctx = guard
            .as_ref()
            .ok_or_else(|| PluginError::internal("插件尚未初始化"))?;
        f(ctx)
    }

    fn need_secrets(ctx: &PluginContext) -> Result<Arc<dyn ll_plugin_api::SecretApi>, PluginError> {
        ctx.secrets
            .clone()
            .ok_or_else(|| PluginError::permission_denied("secrets"))
    }

    fn config_value(ctx: &PluginContext, key: &str, fallback: &str) -> String {
        let v = ctx.settings.get(key).unwrap_or_default();
        if v.trim().is_empty() {
            fallback.to_string()
        } else {
            v
        }
    }

    fn set_api_key(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let key = params
            .get("key")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| PluginError::bad_params("缺少参数 key"))?;
        self.with_ctx(|ctx| {
            Self::need_secrets(ctx)?.set("api_key", &key)?;
            Ok(json!(null))
        })
    }

    fn has_api_key(&self) -> Result<JsonValue, PluginError> {
        self.with_ctx(|ctx| Ok(json!(Self::need_secrets(ctx)?.get("api_key").is_some())))
    }

    fn delete_api_key(&self) -> Result<JsonValue, PluginError> {
        self.with_ctx(|ctx| {
            Self::need_secrets(ctx)?.delete("api_key")?;
            Ok(json!(null))
        })
    }

    fn get_config(&self) -> Result<JsonValue, PluginError> {
        self.with_ctx(|ctx| {
            Ok(json!({
                "model": Self::config_value(ctx, "model", DEFAULT_MODEL),
                "baseUrl": Self::config_value(ctx, "base_url", DEFAULT_BASE_URL),
            }))
        })
    }

    fn set_config(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        self.with_ctx(|ctx| {
            if let Some(m) = params.get("model").and_then(|v| v.as_str()) {
                ctx.settings.set("model", m.trim())?;
            }
            if let Some(b) = params.get("baseUrl").and_then(|v| v.as_str()) {
                let b = b.trim().trim_end_matches('/');
                ctx.settings.set("base_url", b)?;
            }
            Ok(json!(null))
        })
    }

    fn open_chat(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        let prompt = params
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        self.with_ctx(|ctx| {
            let windows = ctx
                .windows
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("windows"))?;
            windows.open("chat", &[("prompt".to_string(), prompt)])?;
            Ok(json!(null))
        })
    }

    /// 启动流式对话：立即返回 promptId，增量经事件通道推送
    fn chat(&self, params: &JsonValue) -> Result<JsonValue, PluginError> {
        if self.active.load(Ordering::Relaxed) {
            return Err(PluginError::bad_params("已有对话进行中，请等待完成或中断"));
        }
        let prompt = params
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let history = params
            .get("history")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        self.with_ctx(|ctx| {
            let key = Self::need_secrets(ctx)?
                .get("api_key")
                .ok_or_else(|| PluginError::bad_params("未配置 API Key，请在对话窗口中设置"))?;
            let http = Arc::clone(
                ctx.http
                    .as_ref()
                    .ok_or_else(|| PluginError::permission_denied("net:api.openai.com"))?,
            );

            let base_url = Self::config_value(ctx, "base_url", DEFAULT_BASE_URL);
            let model = Self::config_value(ctx, "model", DEFAULT_MODEL);
            let mut messages = Vec::with_capacity(history.len() + 1);
            for item in &history {
                if let (Some(role), Some(content)) = (
                    item.get("role").and_then(|v| v.as_str()),
                    item.get("content").and_then(|v| v.as_str()),
                ) {
                    messages.push(json!({"role": role, "content": content}));
                }
            }
            messages.push(json!({"role": "user", "content": prompt}));

            let prompt_id = uuid::Uuid::new_v4().to_string();
            let request = ll_plugin_api::HttpRequest {
                method: "POST".into(),
                url: format!("{}{}", base_url, COMPLETIONS_PATH),
                headers: vec![
                    ("Authorization".into(), format!("Bearer {}", key)),
                    ("Content-Type".into(), "application/json".into()),
                    ("Accept".into(), "text/event-stream".into()),
                ],
                body: Some(
                    json!({
                        "model": model,
                        "messages": messages,
                        "stream": true,
                    })
                    .to_string(),
                ),
            };

            // 后台线程：宿主流式读循环 → SSE 解析 → 事件推送；abort 回调返回 false 中止
            let thread_ctx = ctx.clone();
            let abort = Arc::clone(&self.abort_flag);
            let pid = prompt_id.clone();
            abort.store(false, Ordering::Relaxed);
            self.active.store(true, Ordering::Relaxed);
let active_flag = Arc::clone(&self.active);

            std::thread::spawn(move || {
                let mut buf = String::new();
                let mut finished = false;
                let result = http.send_stream(request, &mut |chunk: &str| -> bool {
                    buf.push_str(chunk);
                    while let Some(pos) = buf.find('\n') {
                        let line: String = buf.drain(..=pos).collect();
                        let line = line.trim();
                        if let Some(data) = line.strip_prefix("data:") {
                            let data = data.trim();
                            if data == "[DONE]" {
                                finished = true;
                                return false;
                            }
                            if let Ok(v) = serde_json::from_str::<JsonValue>(data) {
                                if let Some(delta) =
                                    v["choices"][0]["delta"]["content"].as_str()
                                {
                                    if !delta.is_empty() {
                                        let _ = thread_ctx.events.emit(
                                            "delta",
                                            json!({"id": pid, "delta": delta}),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    !abort.load(Ordering::Relaxed)
                });
                match result {
                    Ok(_) if finished => {
                        let _ = thread_ctx.events.emit("done", json!({"id": pid}));
                    }
                    Ok(_) => {
                        // 读循环被 abort 中止
                        let _ = thread_ctx
                            .events
                            .emit("done", json!({"id": pid, "aborted": true}));
                    }
                    Err(e) => {
                        let _ = thread_ctx
                            .events
                            .emit("error", json!({"id": pid, "message": e.to_string()}));
                    }
                }
                active_flag.store(false, Ordering::Relaxed);
            });

            Ok(json!({"id": prompt_id}))
        })
    }

    fn abort(&self) -> Result<JsonValue, PluginError> {
        self.abort_flag.store(true, Ordering::Relaxed);
        Ok(json!(null))
    }
}

impl Default for AiPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginBackend for AiPlugin {
    fn manifest(&self) -> PluginManifest {
        static MANIFEST: std::sync::OnceLock<PluginManifest> = std::sync::OnceLock::new();
        MANIFEST
            .get_or_init(|| {
                serde_json::from_str(include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../manifest.json"
                )))
                .expect("plugins/ai/manifest.json 解析失败")
            })
            .clone()
    }

    fn init(&self, ctx: PluginContext) -> Result<(), PluginError> {
        *self
            .ctx
            .lock()
            .map_err(|_| PluginError::internal("插件状态锁不可用"))? = Some(ctx);
        Ok(())
    }

    fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, PluginError> {
        match method {
            "set_api_key" => self.set_api_key(&params),
            "has_api_key" => self.has_api_key(),
            "delete_api_key" => self.delete_api_key(),
            "get_config" => self.get_config(),
            "set_config" => self.set_config(&params),
            "open_chat" => self.open_chat(&params),
            "chat" => self.chat(&params),
            "abort" => self.abort(),
            _ => Err(PluginError::unknown_method(method)),
        }
    }

    fn shutdown(&self) {
        self.abort_flag.store(true, Ordering::Relaxed);
    }
}
