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
pub mod python;
pub mod services;

use ll_plugin_api::{PluginBackend, PluginContext, PluginManifest};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
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
            PluginEntry { backend, enabled: true },
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

            // 插件专属数据库（声明 db 权限才注入；独立文件，物理隔离）
            let plugin_conn = registry.as_ref().and_then(|r| r.cached(&id).ok());
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

    PluginContext {
        db: if granted("db") {
            plugin_conn.map(|conn| Arc::new(services::CoreDbApi(conn)) as Arc<dyn ll_plugin_api::DbApi>)
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
                    }) as Arc<dyn ll_plugin_api::ClipboardApi>),
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
                    allowed,
                })),
                _ => None,
            }
        },
        // 剪贴板历史（P1 `/clip`）：独立权限 `clipboard:history`，与 clipboard:read 分开。
        // 未声明则完全不注入——这类能力会长期留存用户复制过的一切，风险高于"读一次"。
        clipboard_history: match (granted("clipboard:history"), app, &clip_conn) {
            (true, Some(app), Some(conn)) => {
                if let Err(e) = services::ensure_clip_schema(conn) {
                    log(&manifest.id, &format!("clipboard history schema 初始化失败: {}", e));
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
        settings: Arc::new(services::HostSettingsApi {
            db: Arc::clone(&core_db),
            plugin_id: manifest.id.clone(),
        }),
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
/// settings/secret 一律按 `pluginId.` 前缀隔离，clipboard/log/notify/events 不触达用户数据。
/// 反向地，db / process / net 一律不授予，避免"无 manifest 即无门控"的漏洞。
fn shell_safe_manifest(plugin_id: &str) -> PluginManifest {
    PluginManifest {
        id: plugin_id.to_string(),
        name: plugin_id.to_string(),
        version: "0.0.0".to_string(),
        api_version: "^1".to_string(),
        trigger: String::new(),
        description: String::new(),
        permissions: [
            "settings",
            "clipboard:write",
            "clipboard:read",
            "notifications",
            "events",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        views: Vec::new(),
        settings: Vec::new(),
        backend: Default::default(),
        command: None,
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

        // 仅在声明 db 权限时才触碰插件库文件（避免为无 db 权限的插件凭空建库）
        let plugin_conn = if manifest.permissions.iter().any(|p| p == "db") {
            self.db_registry
                .read()
                .unwrap()
                .as_ref()
                .and_then(|r| r.cached(plugin_id).ok())
        } else {
            None
        };

        let app = self.app.read().unwrap().clone();
        let log: LogFn = Arc::new(|_, _| {});
        Ok(build_context_from_parts(
            app.as_ref(),
            &manifest,
            plugin_conn,
            core_db,
            log,
        ))
    }
}
