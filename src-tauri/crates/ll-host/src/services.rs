//! ll-host 门控服务实现：DbApi / WindowApi / NotifyApi / SettingsApi / LogApi
//!
//! 这些实现是宿主侧的"系统调用层"：插件只看到 ll-plugin-api 的 trait，
//! 窗口创建、SQL 白名单、设置前缀隔离等约束全部在此强制。

use ll_plugin_api::{
    DbApi, EventApi, ExistingPolicy, HttpApi, HttpRequest, LogApi, NotifyApi, PluginError,
    PluginManifest, ProcessApi, SecretApi, SettingsApi, ViewSpec, WindowApi, WindowPosition,
};
use rusqlite::types::Value as SqlValue;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};
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
