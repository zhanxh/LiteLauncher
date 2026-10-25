pub mod db;
pub mod history;
pub mod hotkeys;
pub mod ll_plugin_assets;
pub mod migration;
pub mod python_env;
pub mod settings;

use db::DbState;
use ll_host::{HostState, PluginDbRegistry};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, LogicalSize, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

fn lifecycle_log_path() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("lifecycle.log")))
        .unwrap_or_else(|| std::path::PathBuf::from("lifecycle.log"))
}

const LOG_ROTATE_BYTES: u64 = 2 * 1024 * 1024;

fn lifecycle_log_level() -> &'static str {
    static LEVEL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    LEVEL
        .get_or_init(|| {
            std::env::var("LL_LOG")
                .unwrap_or_else(|_| "info".to_string())
                .to_ascii_lowercase()
        })
        .as_str()
}

fn rotate_lifecycle_log_once() {
    static ROTATED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    ROTATED.get_or_init(|| {
        let path = lifecycle_log_path();
        let too_big = std::fs::metadata(&path)
            .map(|m| m.len() > LOG_ROTATE_BYTES)
            .unwrap_or(false);
        if too_big {
            let backup = path.with_extension("log.1");
            let _ = std::fs::remove_file(&backup);
            let _ = std::fs::rename(&path, &backup);
        }
    });
}

fn write_lifecycle_line(msg: &str) {
    rotate_lifecycle_log_once();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(lifecycle_log_path())
    {
        use std::io::Write;
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "[{}] {}", now, msg);
    }
}

/// info 级日志：启动、迁移、插件 init、热键注册等低频事件
pub fn log_lifecycle(msg: &str) {
    if lifecycle_log_level() == "off" {
        return;
    }
    write_lifecycle_line(msg);
}

/// debug 级日志：窗口尺寸/焦点/移动、每次 IPC 等高频事件
///
/// 默认 `LL_LOG=info` 不写；`LL_LOG=debug` 才打开，避免日志被逐键 IPC 淹没。
pub fn log_debug(msg: &str) {
    if lifecycle_log_level() != "debug" {
        return;
    }
    write_lifecycle_line(msg);
}

/// 动态调整启动器主窗口高度
///
/// 必须是 async 命令：同步命令在 Linux 上于 WebKitGTK 的 IPC 回调里执行，
/// 在那个上下文里直接 gtk_window_resize 会打断 GDK 的窗口更新 freeze/thaw
/// 记账——实测每次启动必触发
/// `gdk_window_thaw_toplevel_updates: assertion ... failed`，之后窗口可能
/// 整体停止重绘（进程存活、画面停在旧帧，表现为“卡死”）。async 命令跑在
/// worker 线程，run_on_main_thread 把 resize 投回主循环的独立迭代，彻底
/// 跳出 WebKit 回调上下文。
#[tauri::command]
async fn set_main_window_height(app: AppHandle, height: f64) -> Result<(), String> {
    log_debug(&format!("IPC: set_main_window_height height={}", height));
    let clamped_height = height.clamp(70.0, 640.0);
    LAST_REQUESTED_HEIGHT.store(clamped_height as u32, std::sync::atomic::Ordering::Relaxed);
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        if let Some(window) = app_for_main.get_webview_window("main") {
            #[cfg(target_os = "linux")]
            unlock_main_window_resizing(&window);
            if let Err(e) = window.set_size(LogicalSize::new(680.0, clamped_height)) {
                log_debug(&format!("IPC: set_main_window_height resize 失败: {}", e));
            }
        }
    })
    .map_err(|e| e.to_string())
}

/// 前端最近一次请求的逻辑高度（0 = 尚未请求过）。
/// Linux 上首次 resize 可能赶在 GTK 尺寸解锁生效之前被夹掉，靠 Resized
/// 事件里的补发收敛（见 RunEvent::WindowEvent 分支）。
static LAST_REQUESTED_HEIGHT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Linux：解锁主窗口的动态高度。
///
/// 主窗口以 `resizable: false` 创建（tauri.conf.json，Windows 上就该这样），
/// 但 GTK 对不可缩放窗口会在首次 configure 把 WM 尺寸提示锁死成
/// min=max=当前尺寸（实测 680×200），之后 gtk_window_resize 一律被 X 静默
/// 夹回，前端报多少高度都不生效——面板永远只有一条小窗那么高。运行时
/// `set_resizable(true)` 会被 GTK 首次 configure 的一次性回调竞态覆盖，
/// 所以这里在每次改高、每次窗口 Resized 事件时都重申：放开 resizable 并
/// 写入显式宽高约束（宽锁 680，高放开到前端本就夹取的 70..640）。
/// 无边框窗没有系统缩放把手，用户日常拖不到，宽度也不会漂。
#[cfg(target_os = "linux")]
fn unlock_main_window_resizing(window: &tauri::WebviewWindow) {
    let _ = window.set_resizable(true);
    let _ = window.set_size_constraints(WindowSizeConstraints {
        min_width: Some(tauri::LogicalUnit::new(680.0).into()),
        min_height: Some(tauri::LogicalUnit::new(70.0).into()),
        max_width: Some(tauri::LogicalUnit::new(680.0).into()),
        max_height: Some(tauri::LogicalUnit::new(640.0).into()),
    });
}

/// 接收前端控制台日志并写入生命周期文件
#[tauri::command]
fn record_fe_log(msg: String) {
    log_debug(&format!("FE: {}", msg));
}

/// 隐藏主窗口
#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<(), String> {
    log_debug("IPC: hide_main_window called");
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 将主窗口带到前台并抢占焦点
///
/// GTK/X11 兜底组合：重申 always-on-top（部分窗口管理器在 remap 后丢弃
/// keep-above）、unminimize、show，并在短暂延迟后二次 set_focus
/// （对抗 WM 的焦点抢占抑制与新映射窗口的焦点竞态）
fn present_main(window: &tauri::WebviewWindow) {
    let _ = window.set_always_on_top(true);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let w = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(60));
        let _ = w.set_focus();
    });
}

/// 显示并聚焦主窗口（每次打开默认屏幕居中）
#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    log_debug("IPC: show_main_window called");
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.center();
        present_main(&window);
    }
    Ok(())
}

/// 切换主窗口显隐状态
///
/// 语义：已显示**且已聚焦** → 隐藏；其余一律前置展示——
/// 窗口可见但焦点在别的应用时（输入草稿未清空等场景不会自动隐藏），
/// 快捷键应当把它带回前台，而不是误触隐藏
pub(crate) fn toggle_main_window(app: AppHandle) -> Result<(), String> {
    log_debug("IPC: toggle_main_window called");
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        let is_focused = window.is_focused().unwrap_or(false);
        log_debug(&format!(
            "IPC: toggle state visible={} focused={}",
            is_visible, is_focused
        ));
        if is_visible && is_focused {
            window.hide().map_err(|e| e.to_string())?;
        } else {
            if !is_visible {
                let _ = window.center();
            }
            present_main(&window);
        }
    }
    Ok(())
}

/// 壳层原生剪贴板写入（插件 AfterSelect.copy 的落点）
///
/// 不用 webview 的 navigator.clipboard：窗口失焦时浏览器会拒绝写入，
/// 而"选中即复制"通常紧接着就隐藏窗口，异步竞态下极易失败。
#[tauri::command]
fn clipboard_write(app: AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|e| format!("写入剪贴板失败: {}", e))
}

/// 壳层原生剪贴板读取（如后续的"粘贴即搜"）；内容非文本 → None
#[tauri::command]
fn clipboard_read(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    Ok(app.clipboard().read_text().ok())
}

/// `ll-icon://` 协议应答：解析路径 → 缓存命中/抽图 → PNG 字节
///
/// 失败一律回 404（不是 500）：图标是纯装饰资源，前端 `onError` 会回退 emoji，
/// 让一个抽不出来的快捷方式把整条结果列表变成错误页才是真正的故障。
fn serve_icon(cache: &ll_icons::IconCache, uri: &str) -> tauri::http::Response<Vec<u8>> {
    let body = ll_icons::path_from_uri(uri).and_then(|path| cache.png_for_path(&path));
    let (status, content_type, bytes) = match body {
        Some(png) => (200, "image/png", png),
        None => (404, "text/plain; charset=utf-8", b"icon not found".to_vec()),
    };
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Cache-Control", "public, max-age=86400")
        .body(bytes)
        .unwrap_or_else(|_| {
            tauri::http::Response::builder()
                .status(500)
                .body(Vec::new())
                .unwrap()
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // M2：资产根目录（extplugins → 便携 → 开发期仓库），协议闭包持有（与外部插件扫描同源）
    let ll_asset_roots = ll_plugin_assets::asset_roots();
    // 图标缓存目录在启动时确定；协议闭包持有一份，所有窗口共享
    let icon_cache = Arc::new(ll_icons::IconCache::new(db::icons_dir()));
    let mut builder = tauri::Builder::default();
    // 单实例必须最先注册：第二次启动只唤起已有窗口，不再起第二个托盘/热键注册
    if std::env::var("LL_ALLOW_MULTI").is_err() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = show_main_window(app.clone());
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        // 自动更新：检查/下载/安装由前端 updater 模块驱动；签名公钥在 tauri.conf.json
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新安装完成后重启应用
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        // 原生剪贴板：插件走 svc.clipboard.*，壳层走 clipboard_write/read
        .plugin(tauri_plugin_clipboard_manager::init())
        // 开机自启：由设置页开关驱动，Windows 写 HKCU Run
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        // M2：ll-plugin:// 自定义协议——插件自带前端（fe/ 静态资产）的承载通道，
        // 页面经建窗时注入的 window.__llBridge 调宿主（与 plugin_call 同一权限管线）
        .register_uri_scheme_protocol("ll-plugin", move |_ctx, request| {
            ll_plugin_assets::serve_plugin_asset(
                &ll_asset_roots,
                request.uri().to_string().as_str(),
            )
        })
        // 应用图标：`ll-icon://localhost/<percent-encoded path>`。
        // 抽图与缓存都在宿主完成，插件只回 URL——避免逐键 IPC 传 base64，
        // 也让插件不必引入任何 Win32 依赖。
        .register_uri_scheme_protocol("ll-icon", move |_ctx, request| {
            serve_icon(&icon_cache, &request.uri().to_string())
        })
        .setup(|app| {
            // 1. 初始化核心 SQLite 数据库（command_history + app_settings）
            let db_conn = match db::init_db() {
                Ok(conn) => Arc::new(Mutex::new(conn)),
                Err(e) => {
                    let _ =
                        std::fs::write("db_init_error.log", format!("DB INIT ERROR: {:?}\n", e));
                    std::process::exit(1);
                }
            };
            app.manage(DbState(Arc::clone(&db_conn)));

            // 1.2 载入用户配置的 Python 解释器（sysinfo 等 LLP 插件的 sidecar 运行时）
            ll_host::python::set_configured(python_env::read_configured(&db_conn));
            if let Some(p) = ll_host::python::configured() {
                log_lifecycle(&format!("Python 运行时（用户配置）: {}", p));
            }

            // 1.5 插件数据库注册表：每插件独立库文件（物理隔离）
            let db_registry = Arc::new(PluginDbRegistry::new(db::plugin_db_root()));
            app.manage(Arc::clone(&db_registry) as Arc<PluginDbRegistry>);

            // 1.6 旧版单库数据迁移（一次性、幂等、先备份）
            if let Ok(core) = db_conn.lock() {
                migration::run_legacy_migration(&core, &db_registry);
            }

            // 1.7 初始化插件宿主：M5 起**不注册任何内置插件**——todo/apps/ai/notes
            // 全部是 native 动态库（plugins/<id>/<id>.dll），由 1.8 的扫描器统一加载，
            // 与第三方插件同一条路径、同一张 registry、同一套 manifest 权限门控。
            app.manage(HostState::default());
            let host = app.state::<HostState>();
            host.set_db_registry(Arc::clone(&db_registry));
            host.set_core_db(Arc::clone(&db_conn));
            host.set_app(app.handle().clone());

            let plugin_log: ll_host::LogFn = Arc::new(|plugin_id, msg| {
                log_lifecycle(&format!("[plugin:{}] {}", plugin_id, msg));
            });

            // 1.8 扫描外部插件目录（LLP/1：拷入即安装，懒启动，与内置插件同注册表同契约）
            // 两级部署：用户安装目录（同名优先）> 便携目录（主程序旁 plugins/，随程序分发）
            let mut ext_dirs: Vec<(PathBuf, String)> =
                vec![(db::extplugins_dir(), "用户安装目录 extplugins".into())];
            if let Ok(exe) = std::env::current_exe() {
                if let Some(parent) = exe.parent() {
                    ext_dirs.push((
                        parent.join("plugins"),
                        "便携目录（主程序旁 plugins）".into(),
                    ));
                }
            }
            // 开发期：仓库 plugins/ 即"便携目录"的对照物，直接纳入扫描。
            // 好处有二：① 改完插件不必每次 plugin:install；② backend.kind=none 的
            // 纯前端插件能读到自己的 manifest——权限门控（如 /qr 需 process）与
            // 设置面板的启用/禁用都依赖它。
            #[cfg(debug_assertions)]
            ext_dirs.push((
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"),
                "开发期仓库 plugins/".into(),
            ));
            host.register_external_plugins(&ext_dirs, Arc::clone(&plugin_log));
            let watcher_log = Arc::clone(&plugin_log);
            host.init_all(plugin_log);

            let app_handle = app.handle().clone();

            // 后台剪贴板监听：clip 插件启用时随应用启动，暂停开关实时生效
            host.start_clipboard_watcher(app_handle.clone(), watcher_log);

            // 截图清理不阻塞首屏：启动 10 秒后再扫目录（最多 500 张 / 30 天）
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_secs(10));
                let dir = ll_host::services::default_screenshots_root();
                let (count, bytes) = ll_host::services::prune_screenshots(&dir);
                log_lifecycle(&format!(
                    "screenshots: 清理后 {} 张 / {} KB",
                    count,
                    bytes / 1024
                ));
            });

            // 热键注册：主热键（失败回退 Alt+X）+ 所有 manifest 声明的插件热键。
            // 插件前端只订阅事件，不自己抢注——用户改键后无需重载插件。
            hotkeys::init_main_hotkey(&app_handle, &db_conn);
            hotkeys::init_plugin_hotkeys(&app_handle, &db_conn, host.hotkey_specs());

            // 2. 初始化系统托盘菜单（带安全容错，失败不阻断核心窗口运行）
            let show_item = MenuItem::with_id(app, "show", "显示", true, None::<&str>);
            let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>);
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>);

            if let (Ok(show_item), Ok(settings_item), Ok(quit_item)) =
                (show_item, settings_item, quit_item)
            {
                if let Ok(tray_menu) = Menu::with_items(app, &[&show_item, &settings_item, &quit_item]) {
                    let mut tray_builder = TrayIconBuilder::new()
                        .menu(&tray_menu)
                        .show_menu_on_left_click(false);

                    // 确保托盘图标存在，若 default_window_icon 为空则安全回退到内置图标
                    let tray_icon = app.default_window_icon().cloned().or_else(|| {
                        tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
                            .ok()
                    });
                    if let Some(icon) = tray_icon {
                        tray_builder = tray_builder.icon(icon);
                    }

                    if let Ok(tray) = tray_builder
                        .tooltip("LiteLauncher (快捷键 Alt+Space 或 Alt+X 唤起)")
                        .on_menu_event(move |app, event| match event.id.as_ref() {
                            "show" => {
                                let _ = show_main_window(app.clone());
                            }
                            "settings" => {
                                let app_handle = app.clone();
                                tauri::async_runtime::spawn(async move {
                                    let _ = settings::open_settings_window(app_handle).await;
                                });
                            }
                            "quit" => {
                                std::process::exit(0);
                            }
                            _ => {}
                        })
                        .on_tray_icon_event(|tray, event| {
                            if let TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            } = event
                            {
                                let app = tray.app_handle();
                                let _ = toggle_main_window(app.clone());
                            }
                        })
                        .build(app)
                    {
                        app.manage(tray);
                    }
                }
            }

            // 3. 全局快捷键由 hotkeys 模块统一注册（主热键 + 插件 manifest 热键），
            //    这里不再硬编码 Alt+Space/Alt+X。

            // 4. DevTools 支持由 Cargo `devtools` feature 提供（按 F12 打开），不再启动时自动展开

            // 5. 提醒调度已随 todo 插件化：TodoPlugin::init 内部启动自己的扫描线程

            // 6. 首启展示：非开机自启场景呼出主窗口；开机自启场景保持后台常驻
            let is_autostart =
                std::env::args().any(|arg| arg == "--autostart" || arg == "--silent");
            if !is_autostart {
                let _ = show_main_window(app.handle().clone());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            log_debug(&format!("WindowEvent on {}: {:?}", window.label(), event));
            // 当主窗口收到关闭请求时，仅隐藏窗口而不退出整个程序
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            record_fe_log,
            set_main_window_height,
            hide_main_window,
            show_main_window,
            // 壳层原生剪贴板（插件通用 copy 能力与"粘贴即搜"）
            clipboard_write,
            clipboard_read,
            settings::get_setting,
            settings::set_setting,
            settings::get_app_info,
            settings::open_settings_window,
            settings::open_welcome_window,
            // Python 运行时配置（LLP sidecar 依赖）
            python_env::get_python_env,
            python_env::detect_python_path,
            python_env::set_python_path,
            python_env::pick_python_file,
            history::record_command_usage,
            history::get_recent_commands,
            // 主热键 / 开机自启
            hotkeys::get_main_hotkey,
            hotkeys::set_main_hotkey,
            hotkeys::get_autostart,
            hotkeys::set_autostart,
            // 插件宿主统一通道（插件能力不再逐命令注册）
            ll_host::commands::plugin_call,
            ll_host::commands::plugin_list,
            ll_host::commands::plugin_set_enabled,
            // 插件热键管理（manifest 默认 + 用户覆盖）
            ll_host::commands::plugin_hotkeys,
            ll_host::commands::set_plugin_hotkey,
            ll_host::commands::reset_plugin_hotkey,
            ll_host::commands::set_plugin_hotkey_enabled,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            match &event {
                tauri::RunEvent::ExitRequested { code, api, .. } => {
                    log_lifecycle(&format!("RunEvent::ExitRequested code={:?}", code));
                    // 仅拦截"最后一个窗口被关闭"触发的退出（code=None）：启动器保留托盘常驻。
                    // 对 app.exit(code) 的显式退出（code=Some）不再拦截，保证退出路径可用。
                    if code.is_none() {
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::WindowEvent { label, event, .. } => {
                    log_debug(&format!(
                        "RunEvent::WindowEvent label={} event={:?}",
                        label, event
                    ));
                    // Linux：GTK 首次 configure 时可能把主窗口尺寸提示重新锁死
                    // （resizable:false 的一次性回调，时序上可能晚于我们的解锁），
                    // 每次窗口 Resized 后重申解锁；若高度与前端最近请求不一致
                    // （首次 resize 被夹掉），补发一次直到收敛。
                    #[cfg(target_os = "linux")]
                    if label == "main" {
                        if let tauri::WindowEvent::Resized(_) = event {
                            if let Some(window) = _app_handle.get_webview_window("main") {
                                unlock_main_window_resizing(&window);
                                let last = LAST_REQUESTED_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                                if last > 0 {
                                    let scale = window.scale_factor().unwrap_or(1.0);
                                    let current = (window.inner_size().unwrap_or_default().height as f64 / scale).round() as i32;
                                    if (current - last as i32).abs() > 1 {
                                        let _ = window.set_size(LogicalSize::new(680.0, last as f64));
                                    }
                                }
                            }
                        }
                    }
                }
                tauri::RunEvent::Ready => {
                    log_lifecycle("RunEvent::Ready");
                }
                tauri::RunEvent::Resumed => {
                    log_lifecycle("RunEvent::Resumed");
                }
                _ => {}
            }
        });
}
