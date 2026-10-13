//! ll-host 门控服务实现：DbApi / WindowApi / NotifyApi / SettingsApi / LogApi
//!
//! 这些实现是宿主侧的"系统调用层"：插件只看到 ll-plugin-api 的 trait，
//! 窗口创建、SQL 白名单、设置前缀隔离等约束全部在此强制。

use ll_plugin_api::{
    CaptureRequest, CaptureResult, ClipboardApi, DbApi, EventApi, ExistingPolicy, HttpApi,
    HttpRequest, LogApi, MonitorInfo, NotifyApi, PixelGrid, PixelSample, PluginContext, PluginError,
    PluginErrorCode, PluginManifest, ProcessApi, ScreenApi, SecretApi, SettingsApi, ShortcutApi,
    ViewSpec, WindowApi, WindowPosition,
};
use rusqlite::types::Value as SqlValue;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

pub type LogFn = Arc<dyn Fn(&str, &str) + Send + Sync>;

// ─────────────────────────────────────────────────────────────────────────────
// DbApi —— 核心 SQLite（M1 共库，M3 拆独立文件）
// ─────────────────────────────────────────────────────────────────────────────

pub struct CoreDbApi(pub Arc<Mutex<rusqlite::Connection>>);

/// 语句头白名单：execute 仅 DML，query 仅 SELECT/WITH（禁 ATTACH/DDL 散写，§4.3.1 句柄层）
fn check_sql_head(sql: &str, allowed: &[&str]) -> Result<(), PluginError> {
    let head = sql
        .trim_start()
        .split(|c: char| c.is_whitespace() || c == '(')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if allowed.contains(&head.as_str()) {
        Ok(())
    } else {
        Err(PluginError::db(format!("SQL 语句类型不允许: {}", head)))
    }
}

fn json_to_sql(v: &JsonValue) -> Result<SqlValue, PluginError> {
    Ok(match v {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                return Err(PluginError::bad_params("数字参数超出可表示范围"));
            }
        }
        JsonValue::String(s) => SqlValue::Text(s.clone()),
        _ => return Err(PluginError::bad_params("SQL 参数仅支持标量值")),
    })
}

fn sql_to_json(v: SqlValue) -> JsonValue {
    match v {
        SqlValue::Null => JsonValue::Null,
        SqlValue::Integer(i) => JsonValue::from(i),
        SqlValue::Real(f) => JsonValue::from(f),
        SqlValue::Text(s) => JsonValue::from(s),
        SqlValue::Blob(b) => JsonValue::from(String::from_utf8_lossy(&b).to_string()),
    }
}

impl DbApi for CoreDbApi {
    fn migrate(&self, statements: &[&str]) -> Result<(), PluginError> {
        let conn = self.0.lock().map_err(|_| PluginError::db("数据库锁不可用"))?;
        for stmt in statements {
            conn.execute_batch(stmt)
                .map_err(|e| PluginError::db(format!("migrate 失败: {}", e)))?;
        }
        Ok(())
    }

    fn execute(&self, sql: &str, params: &[JsonValue]) -> Result<u64, PluginError> {
        check_sql_head(sql, &["insert", "update", "delete", "replace"])?;
        let conn = self.0.lock().map_err(|_| PluginError::db("数据库锁不可用"))?;
        let vals: Vec<SqlValue> = params
            .iter()
            .map(json_to_sql)
            .collect::<Result<Vec<_>, PluginError>>()?;
        let affected = conn
            .execute(sql, rusqlite::params_from_iter(vals))
            .map_err(|e| PluginError::db(format!("执行失败: {}", e)))?;
        Ok(affected as u64)
    }

    fn query(&self, sql: &str, params: &[JsonValue]) -> Result<Vec<JsonValue>, PluginError> {
        check_sql_head(sql, &["select", "with"])?;
        let conn = self.0.lock().map_err(|_| PluginError::db("数据库锁不可用"))?;
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| PluginError::db(format!("prepare 失败: {}", e)))?;
        let names: Vec<String> = stmt
            .column_names()
            .iter()
            .map(|s| s.to_string())
            .collect();
        let vals: Vec<SqlValue> = params
            .iter()
            .map(json_to_sql)
            .collect::<Result<Vec<_>, PluginError>>()?;

        let rows = stmt
            .query_map(rusqlite::params_from_iter(vals), |row| {
                let mut obj = JsonMap::new();
                for (idx, name) in names.iter().enumerate() {
                    let v: SqlValue = row.get(idx)?;
                    obj.insert(name.clone(), sql_to_json(v));
                }
                Ok(JsonValue::Object(obj))
            })
            .map_err(|e| PluginError::db(format!("查询失败: {}", e)))?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| PluginError::db(format!("读取行失败: {}", e)))?);
        }
        Ok(out)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SettingsApi —— 强制 `${pluginId}.` 前缀隔离（§4.3.1 命名层）
// ─────────────────────────────────────────────────────────────────────────────

pub struct HostSettingsApi {
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub plugin_id: String,
}

impl SettingsApi for HostSettingsApi {
    fn get(&self, key: &str) -> Option<String> {
        let conn = self.db.lock().ok()?;
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            rusqlite::params![format!("{}.{}", self.plugin_id, key)],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), PluginError> {
        let conn = self.db.lock().map_err(|_| PluginError::db("数据库锁不可用"))?;
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![format!("{}.{}", self.plugin_id, key), value],
        )
        .map_err(|e| PluginError::db(format!("写入设置失败: {}", e)))?;
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NotifyApi
// ─────────────────────────────────────────────────────────────────────────────

pub struct HostNotifyApi {
    pub app: AppHandle,
}

impl NotifyApi for HostNotifyApi {
    fn send(&self, title: &str, body: &str) -> Result<(), PluginError> {
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| PluginError::notify(format!("发送系统通知失败: {}", e)))?;
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WindowApi —— manifest 声明式建窗（唯一合法开窗途径）
// ─────────────────────────────────────────────────────────────────────────────

pub struct HostWindowApi {
    pub app: AppHandle,
    pub manifest: PluginManifest,
    pub log: LogFn,
}

/// 窗口标签的实例段净化：保留字母数字并截断 + 追加稳定哈希，避免不同参数净化后碰撞
fn sanitize_label(raw: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let kept: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(16)
        .collect();
    let mut hasher = DefaultHasher::new();
    raw.hash(&mut hasher);
    format!("{}-{:016x}", kept, hasher.finish())
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

impl WindowApi for HostWindowApi {
    /// 任意线程可调用：建窗动作派发到主线程执行（后台线程直接建窗会死锁/panic）
    fn open(&self, view_id: &str, params: &[(String, String)]) -> Result<(), PluginError> {
        let spec = self
            .manifest
            .views
            .iter()
            .find(|v| v.id == view_id)
            .ok_or_else(|| {
                PluginError::window(format!("manifest 未声明视图: {}", view_id))
            })?
            .clone();

        let app = self.app.clone();
        let plugin_id = self.manifest.id.clone();
        let log = Arc::clone(&self.log);
        let params: Vec<(String, String)> = params.to_vec();

        self.app
            .run_on_main_thread(move || {
                if let Err(e) = open_on_main(&app, &plugin_id, &spec, &params) {
                    (log)(&plugin_id, &format!("打开视图 {} 失败: {}", spec.id, e));
                }
            })
            .map_err(|e| PluginError::window(format!("派发主线程失败: {}", e)))
    }
}

/// 主线程上执行的实际建窗逻辑
fn open_on_main(
    app: &AppHandle,
    plugin_id: &str,
    spec: &ViewSpec,
    params: &[(String, String)],
) -> Result<(), String> {
    // 窗口标签：plugin-view[-uniquevalue]
    let unique_value = spec
        .unique_by
        .as_ref()
        .and_then(|k| params.iter().find(|(pk, _)| pk == k).map(|(_, v)| v.clone()));
    let label = match &unique_value {
        Some(v) => format!("{}-{}-{}", plugin_id, spec.id, sanitize_label(v)),
        None => format!("{}-{}", plugin_id, spec.id),
    };

    if let Some(existing) = app.get_webview_window(&label) {
        return match spec.on_existing {
            ExistingPolicy::Focus => {
                let _ = existing.show();
                let _ = existing.unminimize();
                let _ = existing.set_focus();
                Ok(())
            }
            ExistingPolicy::Replace => {
                let _ = existing.close();
                Ok(())
            }
        };
    }

    // URL：index.html?view=<viewId>&<params...>（与前端视图路由约定一致）
    let mut url = format!("index.html?view={}", spec.id);
    for (k, v) in params {
        url.push_str(&format!("&{}={}", k, percent_encode(v)));
    }

    // 堆叠偏移在构建前统计（不含本次窗口）
    let stack_offset = if spec.stacked {
        let prefix = format!("{}-{}", plugin_id, spec.id);
        app.webview_windows()
            .keys()
            .filter(|l| l.starts_with(&prefix))
            .count() as f64
            * (spec.height + 8.0)
    } else {
        0.0
    };

    // 动态标题：title_param 声明的参数存在时，标题变为 "<title> - <参数值>"
    let window_title = spec
        .title_param
        .as_ref()
        .and_then(|k| params.iter().find(|(pk, _)| pk == k).map(|(_, v)| v.clone()))
        .map(|v| format!("{} - {}", spec.title, v))
        .unwrap_or_else(|| spec.title.clone());

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(window_title.as_str())
        .inner_size(spec.width, spec.height)
        .resizable(spec.resizable)
        .decorations(spec.decorated)
        .always_on_top(spec.always_on_top)
        .skip_taskbar(spec.skip_taskbar)
        .focused(spec.focusable);
    if let (Some(mw), Some(mh)) = (spec.min_width, spec.min_height) {
        builder = builder.min_inner_size(mw, mh);
    }
    if matches!(spec.position, WindowPosition::BottomRight) {
        builder = builder.visible(false);
    }

    let window = builder
        .build()
        .map_err(|e| format!("创建窗口 {} 失败: {}", label, e))?;

    if matches!(spec.position, WindowPosition::BottomRight) {
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let mon_logical = monitor.size().to_logical::<f64>(monitor.scale_factor());
            let margin = 16.0;
            let _ = window.set_position(LogicalPosition::new(
                mon_logical.width - spec.width - margin,
                mon_logical.height - spec.height - margin - stack_offset,
            ));
        }
        let _ = window.show();
    }

    // 兜底定时关闭：前端异常未自关时防弹窗残留
    if let Some(param_key) = spec.fallback_close_param.as_ref() {
        if let Some(dur) = params
            .iter()
            .find(|(pk, _)| pk == param_key)
            .and_then(|(_, v)| v.parse::<u64>().ok())
        {
            let grace = spec.fallback_close_grace_secs.unwrap_or(8);
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(dur + grace));
                if let Some(w) = app2.get_webview_window(&label) {
                    let _ = w.close();
                }
            });
        }
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// ProcessApi —— 受控进程服务（宿主持有全部启动策略与安全校验）
// ─────────────────────────────────────────────────────────────────────────────

pub struct HostProcessApi;

impl ProcessApi for HostProcessApi {
    fn launch(&self, target: &str) -> Result<(), PluginError> {
        let clean = target.trim();
        if clean.is_empty() {
            return Err(PluginError::bad_params("启动路径不能为空"));
        }
        // 安全校验：禁止 Shell 注入元字符（管道/重定向/拼接/变量展开）
        let forbidden = ['&', '|', ';', '>', '<', '$', '`', '\n', '\r'];
        if clean.chars().any(|c| forbidden.contains(&c)) {
            return Err(PluginError::bad_params("启动路径包含不安全的特殊字符"));
        }
        spawn_app(clean).map_err(|e| PluginError::internal(format!("启动程序失败: {}", e)))?;
        Ok(())
    }
}

/// 是否应交给系统默认打开器打开（仅非 Windows 平台）
///
/// - URL、.desktop 桌面项、非可执行文档 → true（xdg-open / open）
/// - 可执行文件（含绝对路径）与裸命令 → false（直接 spawn，走 PATH）
///
/// 可执行文件绝不能交给 xdg-open：桌面环境对 application/x-executable
/// 通常没有默认打开方式，会静默失败（GNOME 实测）
#[cfg(not(target_os = "windows"))]
fn should_use_opener(clean_path: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;

    let is_url = ["http://", "https://", "file://"]
        .iter()
        .any(|prefix| clean_path.starts_with(prefix));

    let path = std::path::Path::new(clean_path);
    let is_exec_file = path.is_file()
        && path
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    let is_desktop_entry = path.extension().map_or(false, |ext| ext == "desktop");

    is_url || (path.exists() && (is_desktop_entry || !is_exec_file))
}

/// 以独立进程启动外部应用（各平台策略不同）
fn spawn_app(clean_path: &str) -> std::io::Result<std::process::Child> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Windows：cmd.exe /c start "" 以完全独立进程运行并支持环境变量关联；
        // CREATE_NO_WINDOW 隐藏 cmd 窗口
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .args(["/c", "start", "", clean_path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    }

    #[cfg(not(target_os = "windows"))]
    {
        // .desktop 桌面项必须用 gio launch / gtk-launch：xdg-open 会把它当普通文件
        // 交给默认程序"打开"（通常是编辑器），而不是执行其中的 Exec
        if std::path::Path::new(clean_path)
            .extension()
            .map_or(false, |ext| ext == "desktop")
        {
            return spawn_desktop_entry(clean_path);
        }

        if should_use_opener(clean_path) {
            #[cfg(target_os = "macos")]
            let opener = "open";
            #[cfg(not(target_os = "macos"))]
            let opener = "xdg-open";
            std::process::Command::new(opener).arg(clean_path).spawn()
        } else {
            std::process::Command::new(clean_path).spawn()
        }
    }
}

/// 启动 .desktop 桌面项：优先 `gio launch`（GLib ≥ 2.58），
/// 回退 `gtk-launch <桌面项ID>`（要求位于标准 applications 目录）
#[cfg(not(target_os = "windows"))]
fn spawn_desktop_entry(path: &str) -> std::io::Result<std::process::Child> {
    if let Ok(child) = std::process::Command::new("gio").args(["launch", path]).spawn() {
        return Ok(child);
    }

    if let Some(id) = std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
    {
        if let Ok(child) = std::process::Command::new("gtk-launch").arg(&id).spawn() {
            return Ok(child);
        }
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "未找到 gio 或 gtk-launch，无法启动桌面项（请安装 glib/gtk 工具）",
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// SecretApi —— 核心托管的密钥存储（secret.<pluginId>.<key> 命名空间，M7）
//
// MVP 存储：核心库 app_settings 的保留键空间（不进插件库、其他插件无法表达该
// 前缀）；OS keyring（keyring crate）为后续升级路径，接口已按其语义收敛。
// ─────────────────────────────────────────────────────────────────────────────

pub struct HostSecretApi {
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub plugin_id: String,
}

impl HostSecretApi {
    fn full_key(&self, key: &str) -> String {
        format!("secret.{}.{}", self.plugin_id, key)
    }
}

impl SecretApi for HostSecretApi {
    fn get(&self, key: &str) -> Option<String> {
        let conn = self.db.lock().ok()?;
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            rusqlite::params![self.full_key(key)],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), PluginError> {
        let conn = self.db.lock().map_err(|_| PluginError::db("数据库锁不可用"))?;
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![self.full_key(key), value],
        )
        .map_err(|e| PluginError::db(format!("写入密钥失败: {}", e)))?;
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), PluginError> {
        let conn = self.db.lock().map_err(|_| PluginError::db("数据库锁不可用"))?;
        conn.execute(
            "DELETE FROM app_settings WHERE key = ?1",
            rusqlite::params![self.full_key(key)],
        )
        .map_err(|e| PluginError::db(format!("删除密钥失败: {}", e)))?;
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// EventApi —— 插件 → 前端窗口事件（Tauri `plugin-event` 广播，载荷带 pluginId）
// ─────────────────────────────────────────────────────────────────────────────

pub struct HostEventApi {
    pub app: Option<AppHandle>,
    pub plugin_id: String,
}

impl EventApi for HostEventApi {
    fn emit(&self, event: &str, payload: JsonValue) -> Result<(), PluginError> {
        let app = self
            .app
            .as_ref()
            .ok_or_else(|| PluginError::internal("宿主事件通道未就绪"))?;
        use tauri::Emitter;
        app.emit(
            "plugin-event",
            json!({"pluginId": self.plugin_id, "event": event, "payload": payload}),
        )
        .map_err(|e| PluginError::internal(format!("事件广播失败: {}", e)))?;
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HttpApi —— 宿主代理 HTTP（ureq），net:<host> 域名白名单门控（M7）
// ─────────────────────────────────────────────────────────────────────────────

pub struct HostHttpApi {
    /// manifest 声明的 `net:<host>` 白名单（逐域名精确匹配）
    pub allowed_hosts: Vec<String>,
}

/// 提取 URL 的 host（不含端口/用户信息；非法 URL → None）
fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = authority.split(':').next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

fn net_allowed(allowed: &[String], host: &str) -> bool {
    allowed.iter().any(|h| h.eq_ignore_ascii_case(host))
}

fn check_net(api: &HostHttpApi, url: &str) -> Result<(), PluginError> {
    let host = url_host(url)
        .ok_or_else(|| PluginError::bad_params(format!("无法解析 URL: {}", url)))?;
    if net_allowed(&api.allowed_hosts, &host) {
        Ok(())
    } else {
        Err(PluginError::new(
            ll_plugin_api::PluginErrorCode::PermissionDenied,
            format!("net:{}（manifest 域名白名单）", host),
        ))
    }
}

fn build_ureq_request(
    agent: &ureq::Agent,
    req: &HttpRequest,
) -> Result<ureq::Request, PluginError> {
    let mut r = match req.method.to_ascii_uppercase().as_str() {
        "GET" => agent.get(&req.url),
        "POST" => agent.post(&req.url),
        "PUT" => agent.put(&req.url),
        "DELETE" => agent.delete(&req.url),
        other => return Err(PluginError::bad_params(format!("不支持的 HTTP 方法: {}", other))),
    };
    for (k, v) in &req.headers {
        r = r.set(k, v);
    }
    Ok(r)
}

/// 把 ureq 错误（含非 2xx 状态）转为带响应体的 PluginError
fn ureq_error_to_plugin(e: ureq::Error) -> PluginError {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            PluginError::internal(format!("HTTP {}: {}", code, body))
        }
        ureq::Error::Transport(t) => PluginError::internal(format!("网络错误: {}", t)),
    }
}

fn http_has_body(req: &HttpRequest) -> bool {
    matches!(req.method.to_ascii_uppercase().as_str(), "POST" | "PUT")
}

impl HttpApi for HostHttpApi {
    fn send(&self, req: HttpRequest) -> Result<String, PluginError> {
        check_net(self, &req.url)?;
        let agent = ureq::AgentBuilder::new().build();
        let r = build_ureq_request(&agent, &req)?;
        let resp = if http_has_body(&req) {
            r.send_string(req.body.as_deref().unwrap_or(""))
        } else {
            r.call()
        }
        .map_err(ureq_error_to_plugin)?;
        resp.into_string()
            .map_err(|e| PluginError::internal(format!("读取响应失败: {}", e)))
    }

    fn send_stream(
        &self,
        req: HttpRequest,
        on_chunk: &mut dyn FnMut(&str) -> bool,
    ) -> Result<u16, PluginError> {
        check_net(self, &req.url)?;
        let agent = ureq::AgentBuilder::new().build();
        let r = build_ureq_request(&agent, &req)?;
        let resp = if http_has_body(&req) {
            r.send_string(req.body.as_deref().unwrap_or(""))
        } else {
            r.call()
        }
        .map_err(ureq_error_to_plugin)?;
        let status = resp.status();

        let mut reader = resp.into_reader();
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    if !on_chunk(&chunk) {
                        break; // 插件侧中止
                    }
                }
                Err(e) => return Err(PluginError::internal(format!("流式读取失败: {}", e))),
            }
        }
        Ok(status)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ClipboardApi —— 宿主原生剪贴板（经由 tauri-plugin-clipboard-manager）
//
// 写/读分别授权：manifest 声明 `clipboard:write` / `clipboard:read` 才放行。
// 走宿主原生而非 webview 的 navigator.clipboard，原因有二：
//   1. 外部插件（LLP sidecar）根本没有 webview，无从调用；
//   2. 壳层窗口失焦时 webview 剪贴板会被浏览器策略拒绝。
// ─────────────────────────────────────────────────────────────────────────────

pub struct HostClipboardApi {
    pub app: AppHandle,
    pub can_write: bool,
    pub can_read: bool,
}

impl ClipboardApi for HostClipboardApi {
    fn write(&self, text: &str) -> Result<(), PluginError> {
        if !self.can_write {
            return Err(PluginError::permission_denied("clipboard:write"));
        }
        self.app
            .clipboard()
            .write_text(text.to_string())
            .map_err(|e| PluginError::internal(format!("写入剪贴板失败: {}", e)))
    }

    fn read(&self) -> Result<Option<String>, PluginError> {
        if !self.can_read {
            return Err(PluginError::permission_denied("clipboard:read"));
        }
        // 剪贴板为空 / 内容非文本时底层报错，语义上等价于"没有文本"，返回 None 由插件决定降级
        Ok(self.app.clipboard().read_text().ok())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ScreenApi —— 屏幕捕获（D 组）：xcap 跨平台截图 + 单点取色 + 放大镜取样
//
// 平台差异全部收在这里：xcap 负责枚举显示器与抓帧，image 负责 PNG 编码落盘，
// Tauri 负责读全局光标位置。插件侧只表达"要哪块屏幕 / 哪个点"。
// ─────────────────────────────────────────────────────────────────────────────

pub struct HostScreenApi {
    /// 读光标位置需要宿主句柄；无 GUI 会话时为 None（取色类调用会明确报错）
    pub app: Option<AppHandle>,
    pub plugin_id: String,
}

/// 显示器矩形表的命中测试（左闭右开），抽成纯函数便于单测
fn hit_rect(rects: &[(i32, i32, u32, u32)], x: i32, y: i32) -> Option<usize> {
    rects.iter().position(|&(rx, ry, rw, rh)| {
        let (rw, rh) = (rw as i32, rh as i32);
        x >= rx && x < rx + rw && y >= ry && y < ry + rh
    })
}

fn screen_err(e: impl std::fmt::Display) -> PluginError {
    PluginError::internal(format!("屏幕捕获失败: {}", e))
}

/// 枚举显示器并摊平成矩形表（顺序即序号）
fn monitor_rects(monitors: &[xcap::Monitor]) -> Vec<(i32, i32, u32, u32)> {
    monitors
        .iter()
        .map(|m| {
            (
                m.x().unwrap_or(0),
                m.y().unwrap_or(0),
                m.width().unwrap_or(0),
                m.height().unwrap_or(0),
            )
        })
        .collect()
}

/// 把 0..1 的 `#RRGGBB` 渲染集中到一处，保证各处大小写一致
fn hex_of(r: u8, g: u8, b: u8) -> String {
    format!("#{:02X}{:02X}{:02X}", r, g, b)
}

impl HostScreenApi {
    fn all_monitors() -> Result<Vec<xcap::Monitor>, PluginError> {
        let monitors = xcap::Monitor::all().map_err(screen_err)?;
        if monitors.is_empty() {
            return Err(PluginError::internal("未找到任何显示器"));
        }
        Ok(monitors)
    }

    /// 解析 `monitor` 参数：None=主显示器 / -1=光标所在 / n=第 n 个
    fn resolve_monitor(
        &self,
        monitors: &[xcap::Monitor],
        want: Option<i32>,
    ) -> Result<usize, PluginError> {
        let rects = monitor_rects(monitors);
        match want {
            None => Ok(monitors
                .iter()
                .position(|m| m.is_primary().unwrap_or(false))
                .unwrap_or(0)),
            Some(-1) => {
                let (x, y) = self.cursor_position()?;
                hit_rect(&rects, x, y).ok_or_else(|| {
                    PluginError::internal(format!("光标位置 ({}, {}) 不在任何显示器内", x, y))
                })
            }
            Some(n) if n >= 0 => {
                let idx = n as usize;
                if idx < monitors.len() {
                    Ok(idx)
                } else {
                    Err(PluginError::bad_params(format!(
                        "显示器序号越界: {}（共 {} 个）",
                        n,
                        monitors.len()
                    )))
                }
            }
            Some(other) => Err(PluginError::bad_params(format!(
                "非法的 monitor 值: {}（应为 0 起的序号或 -1）",
                other
            ))),
        }
    }

    /// 定位包含全局坐标 (x, y) 的显示器
    fn monitor_at(
        monitors: &[xcap::Monitor],
        x: i32,
        y: i32,
    ) -> Result<usize, PluginError> {
        hit_rect(&monitor_rects(monitors), x, y).ok_or_else(|| {
            PluginError::internal(format!("坐标 ({}, {}) 不在任何显示器内", x, y))
        })
    }

    /// 隐藏全部可见窗口，返回被隐藏的窗口以便复原
    fn hide_visible_windows(&self) -> Vec<WebviewWindow> {
        let Some(app) = self.app.as_ref() else {
            return Vec::new();
        };
        let mut hidden = Vec::new();
        for window in app.webview_windows().into_values() {
            if window.is_visible().unwrap_or(false) && window.hide().is_ok() {
                hidden.push(window);
            }
        }
        hidden
    }

    fn restore_windows(hidden: &[WebviewWindow]) {
        for window in hidden {
            let _ = window.show();
        }
    }

    fn grab(&self, req: &CaptureRequest) -> Result<CaptureResult, PluginError> {
        let monitors = Self::all_monitors()?;
        let index = self.resolve_monitor(&monitors, req.monitor)?;
        let image = monitors[index]
            .capture_image()
            .map_err(|e| PluginError::internal(format!("截图失败: {}", e)))?;

        if let Some(parent) = req.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| PluginError::internal(format!("创建截图目录失败: {}", e)))?;
        }
        image
            .save(&req.path)
            .map_err(|e| PluginError::internal(format!("保存截图失败: {}", e)))?;

        Ok(CaptureResult {
            path: req.path.to_string_lossy().to_string(),
            width: image.width(),
            height: image.height(),
            monitor: index,
            bytes: std::fs::metadata(&req.path).map(|m| m.len()).unwrap_or(0),
        })
    }
}

impl ScreenApi for HostScreenApi {
    fn list_monitors(&self) -> Result<Vec<MonitorInfo>, PluginError> {
        let monitors = Self::all_monitors()?;
        Ok(monitors
            .iter()
            .enumerate()
            .map(|(index, m)| MonitorInfo {
                index,
                name: m.name().unwrap_or_default(),
                primary: m.is_primary().unwrap_or(false),
                x: m.x().unwrap_or(0),
                y: m.y().unwrap_or(0),
                width: m.width().unwrap_or(0),
                height: m.height().unwrap_or(0),
                scale_factor: m.scale_factor().unwrap_or(1.0),
            })
            .collect())
    }

    fn capture(&self, req: &CaptureRequest) -> Result<CaptureResult, PluginError> {
        // 避让启动器自身：否则截出来的图里永远有 LiteLauncher 本体
        let hidden = if req.hide_windows {
            let hidden = self.hide_visible_windows();
            if !hidden.is_empty() {
                // 隐藏是异步生效的，给合成器一点时间把窗口从画面上摘掉
                std::thread::sleep(Duration::from_millis(160));
            }
            hidden
        } else {
            Vec::new()
        };

        if req.delay_ms > 0 {
            // 上限 10s：防止插件把宿主工作线程长期占住
            std::thread::sleep(Duration::from_millis(req.delay_ms.min(10_000) as u64));
        }

        let result = self.grab(req);
        Self::restore_windows(&hidden);
        result
    }

    fn pixel(&self, x: i32, y: i32) -> Result<PixelSample, PluginError> {
        let monitors = Self::all_monitors()?;
        let index = Self::monitor_at(&monitors, x, y)?;
        let monitor = &monitors[index];
        let (mx, my) = (monitor.x().unwrap_or(0), monitor.y().unwrap_or(0));
        // capture_region 的坐标是"显示器内相对坐标"（u32），故先减掉显示器原点；
        // 命中测试已保证 (x, y) 在该显示器矩形内，取 max(0) 只是兜底
        let image = monitor
            .capture_region((x - mx).max(0) as u32, (y - my).max(0) as u32, 1, 1)
            .map_err(|e| PluginError::internal(format!("取色失败: {}", e)))?;
        let [r, g, b, _a] = image.get_pixel(0, 0).0;
        Ok(PixelSample {
            x,
            y,
            r,
            g,
            b,
            hex: hex_of(r, g, b),
        })
    }

    fn pixel_grid(&self, x: i32, y: i32, radius: u32) -> Result<PixelGrid, PluginError> {
        let r = radius.clamp(1, 32) as i32;
        let monitors = Self::all_monitors()?;
        let index = Self::monitor_at(&monitors, x, y)?;
        let monitor = &monitors[index];
        let (mx, my) = (monitor.x().unwrap_or(0), monitor.y().unwrap_or(0));
        let (mw, mh) = (
            monitor.width().unwrap_or(0) as i32,
            monitor.height().unwrap_or(0) as i32,
        );

        // 请求矩形裁剪到该显示器内（光标贴边时不越界）
        let left = (x - r).max(mx);
        let top = (y - r).max(my);
        let right = (x + r + 1).min(mx + mw);
        let bottom = (y + r + 1).min(my + mh);
        let cols = (right - left).max(1) as u32;
        let rows = (bottom - top).max(1) as u32;

        let image = monitor
            .capture_region((left - mx).max(0) as u32, (top - my).max(0) as u32, cols, rows)
            .map_err(|e| PluginError::internal(format!("放大镜取样失败: {}", e)))?;

        let mut cells = Vec::with_capacity((cols * rows) as usize);
        for py in 0..rows {
            for px in 0..cols {
                let [r, g, b, _a] = image.get_pixel(px, py).0;
                cells.push(hex_of(r, g, b));
            }
        }
        let center = ((y - top) as u32) * cols + (x - left) as u32;

        Ok(PixelGrid {
            x,
            y,
            radius: r as u32,
            cols,
            rows,
            cells,
            center: center as usize,
        })
    }

    fn cursor_position(&self) -> Result<(i32, i32), PluginError> {
        let app = self
            .app
            .as_ref()
            .ok_or_else(|| PluginError::internal("宿主窗口上下文未就绪，无法读取光标位置"))?;
        let pos = app
            .cursor_position()
            .map_err(|e| PluginError::internal(format!("读取光标位置失败: {}", e)))?;
        Ok((pos.x.round() as i32, pos.y.round() as i32))
    }

    fn default_screenshot_dir(&self) -> std::path::PathBuf {
        let mut dir = dirs::data_local_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        dir.push("LiteLauncher");
        dir.push("plugins");
        dir.push(&self.plugin_id);
        dir.push("screenshots");
        dir
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ShortcutApi —— 全局热键（D 组）：登记 + 冲突仲裁 + 事件回传
//
// 一张进程级注册表（加速键 → 插件 id）做先到先得的仲裁；真正落到系统的那一步
// 交给 tauri-plugin-global-shortcut。触发时不回调插件代码，而是广播
// `plugin-shortcut` 事件——插件（尤其纯前端形态）注册的是"听事件"，不是"收按键流"。
// ─────────────────────────────────────────────────────────────────────────────

/// 全局热键注册表：加速键 → 持有它的插件 id
fn shortcut_registry() -> &'static Mutex<HashMap<String, String>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 归一化加速键：去空白、小写、统一 `+` 分隔（"Alt + P" → "alt+p"）
///
/// manifest 声明、插件调用与宿主仲裁三处都过这个函数，避免"声明了 alt+p
/// 却用 Alt+P 注册"这类大小写差异导致的白名单失配。
pub fn normalize_accel(raw: &str) -> String {
    raw.split('+')
        .map(|part| part.trim().to_ascii_lowercase())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("+")
}

pub struct HostShortcutApi {
    pub app: Option<AppHandle>,
    pub plugin_id: String,
    /// manifest 声明的加速键白名单（构造时已归一化）
    pub allowed: Vec<String>,
}

impl HostShortcutApi {
    fn require_allowed(&self, key: &str) -> Result<(), PluginError> {
        if self.allowed.iter().any(|a| a == key) {
            Ok(())
        } else {
            Err(PluginError::permission_denied(&format!(
                "shortcut:{}（manifest 未声明该加速键）",
                key
            )))
        }
    }
}

impl ShortcutApi for HostShortcutApi {
    fn register(&self, accel: &str) -> Result<(), PluginError> {
        let key = normalize_accel(accel);
        if key.is_empty() {
            return Err(PluginError::bad_params("加速键不能为空"));
        }
        // 白名单先于宿主句柄校验：manifest 配置错误在任何环境下都该报出来
        self.require_allowed(&key)?;
        let app = self
            .app
            .as_ref()
            .ok_or_else(|| PluginError::internal("宿主窗口上下文未就绪"))?;

        {
            let mut registry = shortcut_registry()
                .lock()
                .map_err(|_| PluginError::internal("全局热键注册表锁不可用"))?;
            match registry.get(&key) {
                // 幂等：本插件重复注册直接成功，不重复挂系统回调
                Some(owner) if owner == &self.plugin_id => return Ok(()),
                Some(owner) => {
                    return Err(PluginError::new(
                        PluginErrorCode::Conflict,
                        format!("全局热键 {} 已被插件 {} 占用", key, owner),
                    ))
                }
                None => {
                    registry.insert(key.clone(), self.plugin_id.clone());
                }
            }
        }

        let shortcut: Shortcut = match key.parse() {
            Ok(sc) => sc,
            Err(e) => {
                // 解析失败要回滚登记，否则这个键会被永久占住
                if let Ok(mut registry) = shortcut_registry().lock() {
                    registry.remove(&key);
                }
                return Err(PluginError::bad_params(format!(
                    "无法解析加速键 {}: {}",
                    accel, e
                )));
            }
        };

        let plugin_id = self.plugin_id.clone();
        let emit_key = key.clone();
        let handle = app.clone();
        let registered = app.global_shortcut().on_shortcut(
            shortcut,
            move |_app, _shortcut, event| {
                // 只认按下，避免"按下 + 抬起"触发两次
                if event.state == ShortcutState::Pressed {
                    use tauri::Emitter;
                    let _ = handle.emit(
                        "plugin-shortcut",
                        json!({ "pluginId": plugin_id, "accel": emit_key }),
                    );
                }
            },
        );

        if let Err(e) = registered {
            if let Ok(mut registry) = shortcut_registry().lock() {
                registry.remove(&key);
            }
            return Err(PluginError::new(
                PluginErrorCode::Conflict,
                format!("注册全局热键 {} 失败（可能被其它程序占用）: {}", key, e),
            ));
        }
        Ok(())
    }

    fn unregister(&self, accel: &str) -> Result<(), PluginError> {
        let key = normalize_accel(accel);
        // 未声明的键本来就不归本插件管（比如宿主自用的 alt+space），静默忽略
        if self.require_allowed(&key).is_err() {
            return Ok(());
        }
        let owned = {
            let mut registry = shortcut_registry()
                .lock()
                .map_err(|_| PluginError::internal("全局热键注册表锁不可用"))?;
            match registry.get(&key) {
                Some(owner) if owner == &self.plugin_id => {
                    registry.remove(&key);
                    true
                }
                _ => false,
            }
        };
        if owned {
            if let (Some(app), Ok(shortcut)) = (self.app.as_ref(), key.parse::<Shortcut>()) {
                let _ = app.global_shortcut().unregister(shortcut);
            }
        }
        Ok(())
    }

    fn list(&self) -> Vec<String> {
        let Ok(registry) = shortcut_registry().lock() else {
            return Vec::new();
        };
        let mut mine: Vec<String> = registry
            .iter()
            .filter(|(_, owner)| *owner == &self.plugin_id)
            .map(|(key, _)| key.clone())
            .collect();
        mine.sort();
        mine
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LogApi —— 透传到宿主日志管道（lifecycle.log）
// ─────────────────────────────────────────────────────────────────────────────

pub struct FnLog {
    pub f: LogFn,
    pub plugin_id: String,
}

impl LogApi for FnLog {
    fn log(&self, level: &str, msg: &str) {
        (self.f)(&self.plugin_id, &format!("[{}] {}", level, msg));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// svc.* 统一分发器 —— 宿主对插件开放的能力名空间（设计文档 §4.6）
//
// 同一份实现服务两条路径，保证"带后端插件"与"纯前端插件"看到的能力完全一致：
//   1. 外部插件（LLP）反向请求：sidecar 经 stdio 发 `svc.*` → llp.rs reader_loop
//   2. 前端调用：`ctx.call('svc.*')` → commands.rs plugin_call
//
// 一切能力仍按 manifest 权限门控（ctx 里为 None 的句柄即"未授权"）。
// ─────────────────────────────────────────────────────────────────────────────

/// 把 params.headers 归一化为 (name, value) 列表：支持 `{"K":"V"}` 与 `[["K","V"]]` 两种写法
fn parse_headers(params: &JsonValue) -> Vec<(String, String)> {
    match params.get("headers") {
        Some(JsonValue::Object(map)) => map
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
            .collect(),
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|pair| {
                let arr = pair.as_array()?;
                Some((
                    arr.first()?.as_str()?.to_string(),
                    arr.get(1)?.as_str()?.to_string(),
                ))
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// 结构体 → JSON。序列化失败只可能是内部类型问题，归到 Internal
fn to_json<T: serde::Serialize>(value: &T) -> Result<JsonValue, PluginError> {
    serde_json::to_value(value).map_err(|e| PluginError::internal(format!("序列化失败: {}", e)))
}

/// 截图默认文件名：`shot-<epoch毫秒>.png`（可排序、天然不重名）
fn default_shot_name() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("shot-{}.png", ms)
}

/// 分发一个 `svc.*` 调用。method 非法或对应权限未声明时返回结构化错误
pub fn dispatch_svc(
    ctx: &PluginContext,
    method: &str,
    params: &JsonValue,
) -> Result<JsonValue, PluginError> {
    let p_str = |key: &str| params.get(key).and_then(|v| v.as_str()).map(String::from);
    let p_arr = |key: &str| -> Vec<JsonValue> {
        params
            .get(key)
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };
    let p_strings = |key: &str| -> Vec<String> {
        p_arr(key)
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect()
    };
    let p_i32 = |key: &str| params.get(key).and_then(|v| v.as_i64()).map(|v| v as i32);
    let p_u32 = |key: &str| params.get(key).and_then(|v| v.as_u64()).map(|v| v as u32);
    let p_bool = |key: &str| params.get(key).and_then(|v| v.as_bool()).unwrap_or(false);

    match method {
        // ── 数据库 ──────────────────────────────────────────────────────────
        "svc.db.migrate" => {
            let db = ctx
                .db
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("db"))?;
            let statements = p_strings("statements");
            if statements.is_empty() {
                return Err(PluginError::bad_params("缺少 statements（DDL 语句数组）"));
            }
            let refs: Vec<&str> = statements.iter().map(|s| s.as_str()).collect();
            db.migrate(&refs)?;
            Ok(JsonValue::Null)
        }
        "svc.db.execute" => {
            let db = ctx
                .db
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("db"))?;
            let sql = p_str("sql").ok_or_else(|| PluginError::bad_params("缺少 sql"))?;
            let affected = db.execute(&sql, &p_arr("params"))?;
            Ok(json!(affected))
        }
        "svc.db.query" => {
            let db = ctx
                .db
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("db"))?;
            let sql = p_str("sql").ok_or_else(|| PluginError::bad_params("缺少 sql"))?;
            let rows = db.query(&sql, &p_arr("params"))?;
            Ok(JsonValue::Array(rows))
        }

        // ── 系统通知 ────────────────────────────────────────────────────────
        "svc.notify.send" => {
            let notify = ctx
                .notify
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("notifications"))?;
            let title = p_str("title").ok_or_else(|| PluginError::bad_params("缺少 title"))?;
            let body = p_str("body").unwrap_or_default();
            notify.send(&title, &body)?;
            Ok(JsonValue::Null)
        }

        // ── 受控进程启动 ────────────────────────────────────────────────────
        "svc.process.launch" => {
            let process = ctx
                .process
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("process"))?;
            let target = p_str("target").ok_or_else(|| PluginError::bad_params("缺少 target"))?;
            process.launch(&target)?;
            Ok(JsonValue::Null)
        }

        // ── 设置 KV（宿主强制 `${pluginId}.` 前缀隔离）──────────────────────
        "svc.settings.get" => {
            let key = p_str("key").ok_or_else(|| PluginError::bad_params("缺少 key"))?;
            Ok(match ctx.settings.get(&key) {
                Some(v) => json!(v),
                None => JsonValue::Null,
            })
        }
        "svc.settings.set" => {
            let key = p_str("key").ok_or_else(|| PluginError::bad_params("缺少 key"))?;
            let value = p_str("value").ok_or_else(|| PluginError::bad_params("缺少 value"))?;
            ctx.settings.set(&key, &value)?;
            Ok(JsonValue::Null)
        }

        // ── 日志 ────────────────────────────────────────────────────────────
        "svc.log.write" => {
            let level = p_str("level").unwrap_or_else(|| "info".into());
            let message = p_str("message").unwrap_or_default();
            ctx.log.log(&level, &message);
            Ok(JsonValue::Null)
        }

        // ── 剪贴板（原生，写/读分权）────────────────────────────────────────
        "svc.clipboard.write" => {
            let clip = ctx
                .clipboard
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("clipboard:write"))?;
            let text = p_str("text").ok_or_else(|| PluginError::bad_params("缺少 text"))?;
            clip.write(&text)?;
            Ok(JsonValue::Null)
        }
        "svc.clipboard.read" => {
            let clip = ctx
                .clipboard
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("clipboard:read"))?;
            Ok(match clip.read()? {
                Some(text) => json!(text),
                None => JsonValue::Null,
            })
        }

        // ── 事件广播（前端按 pluginId 过滤）─────────────────────────────────
        "svc.events.emit" => {
            let event = p_str("event").ok_or_else(|| PluginError::bad_params("缺少 event"))?;
            let payload = params.get("payload").cloned().unwrap_or(JsonValue::Null);
            ctx.events.emit(&event, payload)?;
            Ok(JsonValue::Null)
        }

        // ── HTTP（宿主代理，net:<host> 白名单门控）──────────────────────────
        "svc.http.send" => {
            let http = ctx.http.as_ref().ok_or_else(|| {
                PluginError::permission_denied("net:<host>（manifest 未声明域名白名单）")
            })?;
            let url = p_str("url").ok_or_else(|| PluginError::bad_params("缺少 url"))?;
            let req = HttpRequest {
                method: p_str("method").unwrap_or_else(|| "GET".into()),
                url,
                headers: parse_headers(params),
                body: p_str("body"),
            };
            // 借道 send_stream 收集全文：既能复用同一套请求构造与白名单校验，
            // 又能顺带拿到状态码（HttpApi::send 只回响应体）
            let mut body = String::new();
            let status = http.send_stream(req, &mut |chunk| {
                body.push_str(chunk);
                true
            })?;
            Ok(json!({ "status": status, "body": body }))
        }

        // ── 窗口（声明式建窗：视图必须在 manifest.views 里声明过）────────────
        "svc.window.open" => {
            let windows = ctx
                .windows
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("windows"))?;
            let view = p_str("view").ok_or_else(|| PluginError::bad_params("缺少 view"))?;
            // 参数透传为页面查询串；只接受标量，非字符串值按其 JSON 字面量传递
            let pairs: Vec<(String, String)> = params
                .get("params")
                .and_then(|v| v.as_object())
                .map(|map| {
                    map.iter()
                        .map(|(k, v)| {
                            let text = match v {
                                JsonValue::String(s) => s.clone(),
                                other => other.to_string(),
                            };
                            (k.clone(), text)
                        })
                        .collect()
                })
                .unwrap_or_default();
            windows.open(&view, &pairs)?;
            Ok(JsonValue::Null)
        }

        // ── 屏幕捕获（D 组，manifest 权限 screen）───────────────────────────
        "svc.screen.list" => {
            let screen = ctx
                .screen
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("screen"))?;
            to_json(&screen.list_monitors()?)
        }
        "svc.screen.cursor" => {
            let screen = ctx
                .screen
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("screen"))?;
            let (x, y) = screen.cursor_position()?;
            Ok(json!({ "x": x, "y": y }))
        }
        "svc.screen.pixel" => {
            let screen = ctx
                .screen
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("screen"))?;
            // x/y 缺省（或只给了一个）时统一回落到当前光标位置
            let point = match (p_i32("x"), p_i32("y")) {
                (Some(x), Some(y)) => (x, y),
                _ => screen.cursor_position()?,
            };
            let sample = screen.pixel(point.0, point.1)?;
            // 返回形状保持一致（总带 sample），插件侧不必按 radius 分叉解析
            match p_u32("radius") {
                // radius 缺省只回单点，省掉一次抓帧
                None | Some(0) => Ok(json!({ "sample": to_json(&sample)? })),
                Some(radius) => {
                    let grid = screen.pixel_grid(point.0, point.1, radius)?;
                    Ok(json!({ "sample": to_json(&sample)?, "grid": to_json(&grid)? }))
                }
            }
        }
        "svc.screen.capture" => {
            let screen = ctx
                .screen
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("screen"))?;
            let path = match p_str("path") {
                Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p),
                _ => screen.default_screenshot_dir().join(default_shot_name()),
            };
            let req = CaptureRequest {
                monitor: p_i32("monitor"),
                path,
                hide_windows: p_bool("hideWindows"),
                delay_ms: p_u32("delayMs").unwrap_or(0),
            };
            to_json(&screen.capture(&req)?)
        }

        // ── 全局热键（D 组，manifest 逐条声明 shortcut:<accel>）──────────────
        "svc.shortcut.register" => {
            let shortcuts = ctx
                .shortcuts
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("shortcut:<accel>"))?;
            let accel = p_str("accel").ok_or_else(|| PluginError::bad_params("缺少 accel"))?;
            shortcuts.register(&accel)?;
            Ok(JsonValue::Null)
        }
        "svc.shortcut.unregister" => {
            let shortcuts = ctx
                .shortcuts
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("shortcut:<accel>"))?;
            let accel = p_str("accel").ok_or_else(|| PluginError::bad_params("缺少 accel"))?;
            shortcuts.unregister(&accel)?;
            Ok(JsonValue::Null)
        }
        "svc.shortcut.list" => {
            let shortcuts = ctx
                .shortcuts
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("shortcut:<accel>"))?;
            Ok(json!(shortcuts.list()))
        }

        _ => Err(PluginError::unknown_method(method)),
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::should_use_opener;

    #[test]
    fn executables_spawn_directly() {
        // /bin/ls 在常规 Linux 上一定存在且可执行 → 直接 spawn
        if !std::path::Path::new("/bin/ls").exists() {
            return;
        }
        assert!(!should_use_opener("/bin/ls"));
        // 裸命令（不存在于磁盘）走 PATH spawn
        assert!(!should_use_opener("gnome-terminal"));
    }

    #[test]
    fn urls_use_opener() {
        assert!(should_use_opener("https://example.com"));
        assert!(should_use_opener("http://example.com"));
        assert!(should_use_opener("file:///tmp/a.txt"));
    }

    #[test]
    fn desktop_entries_use_opener() {
        let dir = std::env::temp_dir().join(format!("ll-host-opener-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("demo.desktop");
        std::fs::write(&file, "[Desktop Entry]\nType=Application\nName=d\nExec=d\n").unwrap();
        assert!(should_use_opener(file.to_str().unwrap()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod m7_service_tests {
    use super::{net_allowed, url_host, HostSecretApi};
    use ll_plugin_api::SecretApi;
    use std::sync::{Arc, Mutex};

    fn secret_api() -> HostSecretApi {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        HostSecretApi {
            db: Arc::new(Mutex::new(conn)),
            plugin_id: "ai".into(),
        }
    }

    #[test]
    fn secrets_namespaced_roundtrip() {
        let api = secret_api();
        assert!(api.get("api_key").is_none());
        api.set("api_key", "sk-test").unwrap();
        assert_eq!(api.get("api_key").as_deref(), Some("sk-test"));
        api.delete("api_key").unwrap();
        assert!(api.get("api_key").is_none());
    }

    #[test]
    fn secrets_isolated_between_plugins() {
        // 不同插件 id 的句柄看到的是不同命名空间（宿主强制前缀隔离）
        let ai = secret_api();
        let mut other = secret_api();
        other.plugin_id = "evil".into();
        ai.set("api_key", "sk-ai").unwrap();
        assert!(other.get("api_key").is_none());
    }

    #[test]
    fn url_host_extraction() {
        assert_eq!(url_host("https://api.openai.com/v1/chat/completions").as_deref(), Some("api.openai.com"));
        assert_eq!(url_host("http://API.Example.com:8080/x").as_deref(), Some("api.example.com"));
        assert_eq!(url_host("https://u:p@host.com/y").as_deref(), Some("host.com"));
        assert!(url_host("not a url").is_none());
    }

    #[test]
    fn net_gate_exact_host_match() {
        let allow = vec!["api.openai.com".to_string()];
        assert!(net_allowed(&allow, "api.openai.com"));
        assert!(net_allowed(&allow, "API.OpenAI.COM"));
        assert!(!net_allowed(&allow, "evil.example.com"));
        assert!(!net_allowed(&allow, "api.openai.com.evil.com"));
        assert!(!net_allowed(&[], "api.openai.com"));
    }
}

#[cfg(test)]
mod d_group_tests {
    use super::{hit_rect, normalize_accel, HostShortcutApi};
    use ll_plugin_api::{PluginErrorCode, ShortcutApi};

    #[test]
    fn accel_normalization_is_case_insensitive() {
        assert_eq!(normalize_accel("Alt + P"), "alt+p");
        assert_eq!(normalize_accel("ALT+SHIFT+S"), "alt+shift+s");
        assert_eq!(normalize_accel("  ctrl + alt + Delete "), "ctrl+alt+delete");
        // 空/纯分隔符都归一成空串，调用方据此报 BadParams
        assert_eq!(normalize_accel(""), "");
        assert_eq!(normalize_accel(" + + "), "");
    }

    #[test]
    fn monitor_hit_test_is_left_closed_right_open() {
        // 副屏挂在主屏左侧（x 为负），是真实的多屏布局
        let rects = [(-1920, 0, 1920, 1080), (0, 0, 1920, 1080)];
        assert_eq!(hit_rect(&rects, 100, 100), Some(1));
        assert_eq!(hit_rect(&rects, -100, 100), Some(0));
        assert_eq!(hit_rect(&rects, 0, 0), Some(1));
        // 右开区间：x = 1920 已落在两块屏之外
        assert_eq!(hit_rect(&rects, 1920, 100), None);
        assert_eq!(hit_rect(&rects, 100, 1080), None);
        assert_eq!(hit_rect(&[], 0, 0), None);
    }

    #[test]
    fn shortcut_registration_requires_manifest_declaration() {
        let api = HostShortcutApi {
            app: None,
            plugin_id: "shot".into(),
            allowed: vec!["alt+shift+s".into()],
        };
        // 未声明的加速键 → 权限错误（且先于宿主句柄校验，无 GUI 也能报准）
        let err = api.register("alt+p").unwrap_err();
        assert!(matches!(err.code, PluginErrorCode::PermissionDenied));
        // 声明过的键（大小写/空格不同也算）→ 已放行到"宿主未就绪"这一步
        let err = api.register(" ALT + SHIFT + S ").unwrap_err();
        assert!(matches!(err.code, PluginErrorCode::Internal));
        // 上述失败都不应污染注册表
        assert!(api.list().is_empty());
    }
}
