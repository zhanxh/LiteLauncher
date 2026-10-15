pub mod db;
pub mod migration;
pub mod history;
pub mod python_env;
pub mod settings;

use db::DbState;
use ll_host::{HostState, PluginDbRegistry};
use ll_plugin_apps::AppsPlugin;
use ll_plugin_notes::NotesPlugin;
use ll_plugin_ai::AiPlugin;
use ll_plugin_todo::TodoPlugin;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, LogicalSize, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

fn lifecycle_log_path() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("lifecycle.log")))
        .unwrap_or_else(|| std::path::PathBuf::from("lifecycle.log"))
}

pub fn log_lifecycle(msg: &str) {
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

/// 动态调整启动器主窗口高度
#[tauri::command]
fn set_main_window_height(app: AppHandle, height: f64) -> Result<(), String> {
    log_lifecycle(&format!("IPC: set_main_window_height height={}", height));
    if let Some(window) = app.get_webview_window("main") {
        let clamped_height = height.clamp(70.0, 640.0);
        window
            .set_size(LogicalSize::new(680.0, clamped_height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 接收前端控制台日志并写入生命周期文件
#[tauri::command]
fn record_fe_log(msg: String) {
    log_lifecycle(&format!("FE: {}", msg));
}

/// 隐藏主窗口
#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<(), String> {
    log_lifecycle("IPC: hide_main_window called");
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
    log_lifecycle("IPC: show_main_window called");
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
#[tauri::command]
fn toggle_main_window(app: AppHandle) -> Result<(), String> {
    log_lifecycle("IPC: toggle_main_window called");
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        let is_focused = window.is_focused().unwrap_or(false);
        log_lifecycle(&format!(
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        // 原生剪贴板：插件走 svc.clipboard.*，壳层走 clipboard_write/read
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // 1. 初始化核心 SQLite 数据库（command_history + app_settings）
            let db_conn = match db::init_db() {
                Ok(conn) => Arc::new(Mutex::new(conn)),
                Err(e) => {
                    let _ = std::fs::write("db_init_error.log", format!("DB INIT ERROR: {:?}\n", e));
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

            // 1.7 初始化插件宿主：注册内置插件并按 manifest 权限构造门控上下文
            app.manage(HostState::default());
            let host = app.state::<HostState>();
            host.set_db_registry(Arc::clone(&db_registry));
            host.set_core_db(Arc::clone(&db_conn));
            host.set_app(app.handle().clone());
            host.register(Arc::new(TodoPlugin::new()));
            host.register(Arc::new(AppsPlugin::new()));
            host.register(Arc::new(NotesPlugin::new()));
            host.register(Arc::new(AiPlugin::new()));
            let plugin_log: ll_host::LogFn = Arc::new(|plugin_id, msg| {
                log_lifecycle(&format!("[plugin:{}] {}", plugin_id, msg));
            });

            // 1.8 扫描外部插件目录（LLP/1：拷入即安装，懒启动，与内置插件同注册表同契约）
            // 两级部署：用户安装目录（同名优先）> 便携目录（主程序旁 plugins/，随程序分发）
            let mut ext_dirs: Vec<(PathBuf, String)> =
                vec![(db::extplugins_dir(), "用户安装目录 extplugins".into())];
            if let Ok(exe) = std::env::current_exe() {
                if let Some(parent) = exe.parent() {
                    ext_dirs.push((parent.join("plugins"), "便携目录（主程序旁 plugins）".into()));
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
            host.init_all(plugin_log);

            let app_handle = app.handle().clone();

            // 2. 初始化系统托盘菜单（带安全容错，失败不阻断核心窗口运行）
            if let Ok(show_item) = MenuItem::with_id(app, "show", "显示", true, None::<&str>) {
                if let Ok(quit_item) = MenuItem::with_id(app, "quit", "退出", true, None::<&str>) {
                    if let Ok(tray_menu) = Menu::with_items(app, &[&show_item, &quit_item]) {
                        let mut tray_builder = TrayIconBuilder::new()
                            .menu(&tray_menu)
                            .show_menu_on_left_click(false);

                        // 确保托盘图标存在，若 default_window_icon 为空则安全回退到内置图标
                        let tray_icon = app.default_window_icon().cloned().or_else(|| {
                            tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).ok()
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
            }

            // 3. 注册全局快捷键：优先 Alt+Space，同时注册 Alt+X 作为备选容错（防系统热键冲突）
            for hotkey in &["alt+space", "alt+x"] {
                if let Ok(sc) = hotkey.parse::<Shortcut>() {
                    let handle_for_shortcut = app_handle.clone();
                    let _ = app.global_shortcut().on_shortcut(sc, move |_app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            let _ = toggle_main_window(handle_for_shortcut.clone());
                        }
                    });
                }
            }

            // 4. DevTools 支持由 Cargo `devtools` feature 提供（按 F12 打开），不再启动时自动展开

            // 5. 提醒调度已随 todo 插件化：TodoPlugin::init 内部启动自己的扫描线程

            Ok(())
        })
        .on_window_event(|window, event| {
            log_lifecycle(&format!("WindowEvent on {}: {:?}", window.label(), event));
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
            toggle_main_window,
            // 壳层原生剪贴板（插件通用 copy 能力与"粘贴即搜"）
            clipboard_write,
            clipboard_read,
            settings::get_setting,
            settings::set_setting,
            settings::get_app_info,
            settings::open_settings_window,
            // Python 运行时配置（LLP sidecar 依赖）
            python_env::get_python_env,
            python_env::detect_python_path,
            python_env::set_python_path,
            python_env::pick_python_file,
            history::record_command_usage,
            history::get_recent_commands,
            // 插件宿主统一通道（插件能力不再逐命令注册）
            ll_host::commands::plugin_call,
            ll_host::commands::plugin_list,
            ll_host::commands::plugin_set_enabled,
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
                    log_lifecycle(&format!("RunEvent::WindowEvent label={} event={:?}", label, event));
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
