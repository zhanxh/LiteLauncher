//! ll-host —— LiteLauncher 插件宿主
//!
//! 职责：
//! 1. 注册表：登记内置插件（Arc<dyn PluginBackend>），持有启用状态
//! 2. 门控：依据 manifest 声明的权限构造 PluginContext（未声明 → 句柄 None）
//! 3. 数据隔离：每插件独立 SQLite 文件（plugins/<id>/<id>.db），连接缓存共享
//! 4. 统一 IPC 通道（commands 模块）：plugin_call / plugin_list / plugin_set_enabled

pub mod commands;
pub mod desktop;
pub mod llp;
pub mod native;
pub mod python;
pub mod services;

use ll_plugin_api::{PluginBackend, PluginContext, PluginManifest};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::AppHandle;

pub use services::LogFn;

pub struct PluginEntry {
    pub backend: Arc<dyn PluginBackend>,
    pub enabled: bool,
}

/// 插件数据库注册表：`<root>/<plugin_id>/<plugin_id>.db`，连接按 id 缓存复用
pub struct PluginDbRegistry {
    root: PathBuf,
    cache: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
}

impl PluginDbRegistry {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn root(&self) -> &PathBuf {
        &self.root
    }

    /// 取插件连接（缓存命中复用；未命中则打开并缓存）
    pub fn cached(&self, plugin_id: &str) -> Result<Arc<Mutex<Connection>>, String> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "插件数据库缓存锁不可用".to_string())?;
        if let Some(conn) = cache.get(plugin_id) {
            return Ok(Arc::clone(conn));
        }
        let dir = self.root.join(plugin_id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件数据目录失败: {}", e))?;
        let conn = Connection::open(dir.join(format!("{}.db", plugin_id)))
            .map_err(|e| format!("打开插件数据库失败({}): {}", plugin_id, e))?;
        // 独立文件下的合理并发与持久性配置
        let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
        let conn = Arc::new(Mutex::new(conn));
        cache.insert(plugin_id.to_string(), Arc::clone(&conn));
        Ok(conn)
    }
}

/// 宿主状态（Tauri managed state）
#[derive(Default)]
pub struct HostState {
    pub(crate) plugins: RwLock<HashMap<String, PluginEntry>>,
    pub(crate) db_registry: RwLock<Option<Arc<PluginDbRegistry>>>,
    pub(crate) core_db: RwLock<Option<Arc<Mutex<Connection>>>>,
    pub(crate) app: RwLock<Option<AppHandle>>,
    /// 运行期 svc 调用的日志通道（setup 时由主程序注入；注入前为 None → 静默）。
    /// 之前 svc_context 用空 logger，运行期 svc 的诊断日志（如 attachDesktop）
    /// 全部被吞，排障时完全瞎眼——2026-10-26 时钟排障的教训。
    pub(crate) runtime_log: RwLock<Option<LogFn>>,
    /// 剪贴板监听是否允许继续（插件禁用/暂停时置 false；线程本身不销毁）
    clip_watch_enabled: Arc<AtomicBool>,
    /// 监听线程是否已启动，避免重复 spawn
    clip_watch_started: AtomicBool,
}

impl HostState {
    pub fn set_db_registry(&self, registry: Arc<PluginDbRegistry>) {
        *self.db_registry.write().unwrap() = Some(registry);
    }

    pub fn set_core_db(&self, db: Arc<Mutex<Connection>>) {
        *self.core_db.write().unwrap() = Some(db);
    }

    pub fn set_app(&self, app: AppHandle) {
        *self.app.write().unwrap() = Some(app);
    }

    /// 注入运行期 svc 日志通道（setup 阶段调用；见 runtime_log 字段说明）
    pub fn set_runtime_log(&self, log: LogFn) {
        *self.runtime_log.write().unwrap() = Some(log);
    }

    /// 启动期热键注册所需：每个插件的启用状态与可用热键声明
    pub fn hotkey_specs(&self) -> Vec<(String, bool, Vec<ll_plugin_api::HotkeySpec>)> {
        let Ok(plugins) = self.plugins.read() else {
            return Vec::new();
        };
        plugins
            .values()
            .map(|entry| {
                let manifest = entry.backend.manifest();
                let hotkeys = manifest.valid_hotkeys();
                (manifest.id, entry.enabled, hotkeys)
            })
            .collect()
    }

    /// 启动后台剪贴板监听（仅 Windows；插件 `clip` 存在且启用时）
    ///
    /// 监听线程独立于 `svc_context`：即使插件前端没打开，复制内容也会入库；
    /// 暂停开关实时读库，不需要重启线程。
    pub fn start_clipboard_watcher(&self, app: AppHandle, log: LogFn) {
        let enabled = self
            .plugins
            .read()
            .map(|map| map.get("clip").is_some_and(|entry| entry.enabled))
            .unwrap_or(false);
        // 禁用状态下不常驻线程；重新启用时由 plugin_set_enabled 再调一次
        if !enabled {
            return;
        }
        if self.clip_watch_started.swap(true, Ordering::SeqCst) {
            self.clip_watch_enabled.store(true, Ordering::Relaxed);
            return;
        }
        let Some(registry) = self.db_registry.read().ok().and_then(|r| r.clone()) else {
            self.clip_watch_started.store(false, Ordering::SeqCst);
            return;
        };
        let Ok(conn) = registry.cached("clip") else {
            self.clip_watch_started.store(false, Ordering::SeqCst);
            return;
        };
        self.clip_watch_enabled.store(true, Ordering::Relaxed);
        services::start_clipboard_watcher(
            app,
            conn,
            log,
            Arc::clone(&self.clip_watch_enabled),
        );
    }

    /// 插件启用/禁用时同步监听开关：禁用插件立即停止采集，不必重启线程
    pub fn set_clipboard_watcher_enabled(&self, enabled: bool) {
        self.clip_watch_enabled.store(enabled, Ordering::Relaxed);
    }

    /// 关闭全部外部进程插件（kind=llp）的 sidecar 子进程
    ///
    /// 场景：用户在设置面板改了 Python 解释器路径。LLP 是懒启动的，这里只杀进程，
    /// 标记 dead，下次调用会自动按新解释器重建——不需要重启应用，也不触碰内置插件
    /// （内置插件的 shutdown 会停线程，不能随便调）。
    /// 返回被关闭的插件数量。
    pub fn shutdown_llp_plugins(&self) -> usize {
        let ids: Vec<String> = {
            let map = match self.plugins.read() {
                Ok(m) => m,
                Err(_) => return 0,
            };
            map.values()
                .filter(|e| e.backend.manifest().backend.kind == "llp")
                .map(|e| e.backend.manifest().id)
                .collect()
        };
        for id in &ids {
            if let Some(entry) = self.plugins.read().unwrap().get(id) {
                entry.backend.shutdown();
            }
        }
        ids.len()
    }

    /// 登记插件（默认启用；实际启用状态在 init_all 时依持久化设置校正）
    pub fn register(&self, backend: Arc<dyn PluginBackend>) {
        let m = backend.manifest();
        self.plugins.write().unwrap().insert(
            m.id.clone(),
            PluginEntry {
                backend,
                enabled: true,
            },
        );
    }

    /// 逐插件读取持久化启用状态并构造门控上下文完成 init（串行，插件量小）
    pub fn init_all(&self, log: LogFn) {
        let core_db = match self.core_db.read().unwrap().clone() {
            Some(db) => db,
            None => {
                (log)("host", "init_all: 未设置核心数据库连接，插件全部跳过");
                return;
            }
        };
        let registry = self.db_registry.read().unwrap().clone();

        let ids: Vec<String> = {
            let map = self.plugins.read().unwrap();
            map.keys().cloned().collect()
        };

        for id in ids {
            let (manifest, backend) = {
                let map = self.plugins.read().unwrap();
                let entry = match map.get(&id) {
                    Some(e) => e,
                    None => continue,
                };
                (entry.backend.manifest(), Arc::clone(&entry.backend))
            };

            // 持久化禁用状态：plugin.<id>.enabled != "false" 视为启用
            let enabled = read_enabled_flag(&core_db, &id);
            if !enabled {
                if let Some(entry) = self.plugins.write().unwrap().get_mut(&id) {
                    entry.enabled = false;
                }
                backend.shutdown();
                (log)(&id, "init skipped（持久化禁用）");
                continue;
            }

            // 插件专属数据库：db 权限，或剪贴板历史（历史表也落在这份连接里）。
            // 其余插件不凭空建库，避免 plugins/<id>/ 下出现一堆空 DB。
            let plugin_conn = if manifest_needs_plugin_db(&manifest) {
                registry.as_ref().and_then(|r| r.cached(&id).ok())
            } else {
                None
            };
            let ctx = build_context_from_parts(
                self.app.read().unwrap().as_ref(),
                &manifest,
                plugin_conn,
                Arc::clone(&core_db),
                Arc::clone(&log),
            );
            match backend.init(ctx) {
                Ok(()) => (log)(&id, "init ok"),
                Err(e) => {
                    (log)(&id, &format!("init FAILED: {}", e));
                    if let Some(entry) = self.plugins.write().unwrap().get_mut(&id) {
                        entry.enabled = false;
                    }
                }
            }
        }
    }
}

fn read_enabled_flag(db: &Arc<Mutex<Connection>>, plugin_id: &str) -> bool {
    let conn = match db.lock() {
        Ok(c) => c,
        Err(_) => return true,
    };
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        rusqlite::params![format!("plugin.{}.enabled", plugin_id)],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .map(|v| v != "false")
    .unwrap_or(true)
}

/// 插件的运行期上下文是否需要打开插件库文件
///
/// `clipboard:history` 的历史表也落在这份连接里；只认 `db` 会让 `/clip`
/// 在 `svc_context` 里拿到 None 句柄，被误报成“manifest 未声明权限”。
fn manifest_needs_plugin_db(manifest: &PluginManifest) -> bool {
    manifest
        .permissions
        .iter()
        .any(|p| p == "db" || p == "clipboard:history")
}

pub(crate) fn build_context_from_parts(
    app: Option<&AppHandle>,
    manifest: &PluginManifest,
    plugin_conn: Option<Arc<Mutex<Connection>>>,
    core_db: Arc<Mutex<Connection>>,
    log: LogFn,
) -> PluginContext {
    let granted = |perm: &str| manifest.permissions.iter().any(|p| p == perm);
    let net_hosts: Vec<String> = manifest
        .permissions
        .iter()
        .filter_map(|p| p.strip_prefix("net:").map(String::from))
        .collect();

    // db 字段会 take 掉 plugin_conn；剪贴板历史也需要同一份连接，故先克隆一个 Arc
    let clip_conn = plugin_conn.clone();

    // 热键目录与设置句柄共享：effective accel 要读用户覆盖，catalog 要回给 /hotkey
    let hotkey_specs = manifest.valid_hotkeys();
    let settings_api: Arc<dyn ll_plugin_api::SettingsApi> = Arc::new(services::HostSettingsApi {
        db: Arc::clone(&core_db),
        plugin_id: manifest.id.clone(),
    });

    PluginContext {
        db: if granted("db") {
            plugin_conn
                .map(|conn| Arc::new(services::CoreDbApi(conn)) as Arc<dyn ll_plugin_api::DbApi>)
        } else {
            None
        },
        windows: match (granted("windows"), app) {
            (true, Some(app)) => Some(Arc::new(services::HostWindowApi {
                app: app.clone(),
                manifest: manifest.clone(),
                log: Arc::clone(&log),
            })),
            _ => None,
        },
        notify: match (granted("notifications"), app) {
            (true, Some(app)) => Some(Arc::new(services::HostNotifyApi { app: app.clone() })),
            _ => None,
        },
        process: if granted("process") {
            Some(Arc::new(services::HostProcessApi))
        } else {
            None
        },
        secrets: if granted("secrets") {
            Some(Arc::new(services::HostSecretApi {
                db: Arc::clone(&core_db),
                plugin_id: manifest.id.clone(),
            }))
        } else {
            None
        },
        http: if !net_hosts.is_empty() {
            Some(Arc::new(services::HostHttpApi {
                allowed_hosts: net_hosts,
            }))
        } else {
            None
        },
        // 剪贴板：写/读分别授权；两者都未声明时不注入句柄
        clipboard: match app {
            Some(app) if granted("clipboard:write") || granted("clipboard:read") => {
                Some(Arc::new(services::HostClipboardApi {
                    app: app.clone(),
                    can_write: granted("clipboard:write"),
                    can_read: granted("clipboard:read"),
                }))
            }
            _ => None,
        },
        // 屏幕捕获（D 组）：截图与取色都要宿主窗口上下文（读全局光标位置）。
        // clipboard 句柄按需带上——截图的"图片本体入剪贴板"要走它，
        // 这样 `clipboard:write` 的门控不会被 `screen` 权限绕过。
        screen: match (granted("screen"), app) {
            (true, Some(app)) => {
                let clipboard = match granted("clipboard:write") {
                    true => Some(Arc::new(services::HostClipboardApi {
                        app: app.clone(),
                        can_write: true,
                        can_read: granted("clipboard:read"),
                    })
                        as Arc<dyn ll_plugin_api::ClipboardApi>),
                    false => None,
                };
                Some(Arc::new(services::HostScreenApi {
                    app: Some(app.clone()),
                    plugin_id: manifest.id.clone(),
                    clipboard,
                }))
            }
            _ => None,
        },
        // 全局热键（D 组）：manifest 逐条声明 `shortcut:<accel>`，无通配
        shortcuts: {
            let allowed: Vec<String> = manifest
                .permissions
                .iter()
                .filter_map(|p| p.strip_prefix("shortcut:"))
                .map(services::normalize_accel)
                .filter(|accel| !accel.is_empty())
                .collect();
            match (allowed.is_empty(), app) {
                (false, Some(app)) => Some(Arc::new(services::HostShortcutApi {
                    app: Some(app.clone()),
                    plugin_id: manifest.id.clone(),
                    plugin_name: manifest.name.clone(),
                    allowed,
                    hotkeys: hotkey_specs,
                    settings: Arc::clone(&settings_api),
                })),
                _ => None,
            }
        },
        // 剪贴板历史（P1 `/clip`）：独立权限 `clipboard:history`，与 clipboard:read 分开。
        // 未声明则完全不注入——这类能力会长期留存用户复制过的一切，风险高于"读一次"。
        clipboard_history: match (granted("clipboard:history"), app, &clip_conn) {
            (true, Some(app), Some(conn)) => {
                if let Err(e) = services::ensure_clip_schema(conn) {
                    log(
                        &manifest.id,
                        &format!("clipboard history schema 初始化失败: {}", e),
                    );
                    None
                } else {
                    Some(Arc::new(services::HostClipboardHistoryApi {
                        app: app.clone(),
                        conn: Arc::clone(conn),
                        policy: ll_plugin_api::default_clipboard_policy(),
                        log: Arc::clone(&log),
                    }))
                }
            }
            _ => None,
        },
        events: Arc::new(services::HostEventApi {
            app: app.cloned(),
            plugin_id: manifest.id.clone(),
        }),
        settings: settings_api,
        log: Arc::new(services::FnLog {
            f: log,
            plugin_id: manifest.id.clone(),
        }),
    }
}

/// 未注册插件的兜底 manifest：只放行"壳层级安全能力"。
///
/// 触发场景：随前端包一并编译进来的纯前端插件（kind=none）不在插件目录里，
/// 宿主扫描不到、却仍会被前端 `ctx.call('svc.*')` 命中。这些能力即便放开也无法越权——
/// settings/secret 一律按 `pluginId.` 前缀隔离；notify/events 不触达用户数据。
/// 反向地，db / process / net / **clipboard（读=用户隐私）** 一律不授予，
/// 避免"无 manifest 即无门控"的漏洞。
fn shell_safe_manifest(plugin_id: &str) -> PluginManifest {
    PluginManifest {
        id: plugin_id.to_string(),
        name: plugin_id.to_string(),
        version: "0.0.0".to_string(),
        api_version: "^1".to_string(),
        trigger: String::new(),
        description: String::new(),
        permissions: ["settings", "notifications", "events"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        views: Vec::new(),
        settings: Vec::new(),
        backend: Default::default(),
        command: None,
        hotkeys: Vec::new(),
    }
}

impl HostState {
    /// 构造用于应答 `svc.*` 的门控上下文（设计文档 §4.6）。
    ///
    /// - **已注册插件**：按其 manifest 权限门控，与 init() 时完全一致
    /// - **未注册插件**：退回 [`shell_safe_manifest`] 的安全权限集
    pub(crate) fn svc_context(&self, plugin_id: &str) -> Result<PluginContext, String> {
        let core_db = self
            .core_db
            .read()
            .map_err(|_| "数据库句柄锁不可用".to_string())?
            .clone()
            .ok_or("数据库未初始化")?;

        let manifest = {
            let map = self
                .plugins
                .read()
                .map_err(|_| "插件注册表锁不可用".to_string())?;
            map.get(plugin_id).map(|e| e.backend.manifest())
        }
        .unwrap_or_else(|| shell_safe_manifest(plugin_id));

        // 仅在需要插件库的权限（db / clipboard:history）下触碰库文件，
        // 避免为无 db 权限的插件凭空建库；否则剪贴板历史会拿到 None 句柄，
        // 被误报成“manifest 未声明权限: clipboard:history”。
        let plugin_conn = if manifest_needs_plugin_db(&manifest) {
            self.db_registry
                .read()
                .unwrap()
                .as_ref()
                .and_then(|r| r.cached(plugin_id).ok())
        } else {
            None
        };

        let app = self.app.read().unwrap().clone();
        let log = self
            .runtime_log
            .read()
            .unwrap()
            .clone()
            .unwrap_or_else(|| Arc::new(|_, _| {}));
        Ok(build_context_from_parts(
            app.as_ref(),
            &manifest,
            plugin_conn,
            core_db,
            log,
        ))
    }
}
