pub mod db;
pub mod app_launcher;
pub mod todo;
pub mod notes;
pub mod history;

use db::DbState;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, LogicalSize, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub fn log_lifecycle(msg: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("F:\\codes\\LiteLauncher\\lifecycle.log")
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

/// 显示并聚焦主窗口
#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    log_lifecycle("IPC: show_main_window called");
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 切换主窗口显隐状态
#[tauri::command]
fn toggle_main_window(app: AppHandle) -> Result<(), String> {
    log_lifecycle("IPC: toggle_main_window called");
    if let Some(window) = app.get_webview_window("main") {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            window.hide().map_err(|e| e.to_string())?;
        } else {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // 1. 初始化 SQLite 数据库并注入应用状态
            match db::init_db() {
                Ok(conn) => {
                    app.manage(DbState(Mutex::new(conn)));
                }
                Err(e) => {
                    let _ = std::fs::write("F:\\codes\\LiteLauncher\\crash.log", format!("DB INIT ERROR: {:?}\n", e));
                }
            }

            let app_handle = app.handle().clone();

            // 2. 初始化系统托盘菜单（带安全容错，失败不阻断核心窗口运行）
            if let Ok(show_item) = MenuItem::with_id(app, "show", "显示 LiteLauncher", true, None::<&str>) {
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

            // 4. 为主窗口开启 DevTools 支持（允许按 F12 调试）
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.open_devtools();
            }

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
            app_launcher::launch_application,
            app_launcher::list_applications,
            app_launcher::add_custom_app,
            todo::create_todo,
            todo::list_todos,
            todo::toggle_todo,
            todo::delete_todo,
            notes::search_notes,
            notes::read_note_content,
            notes::save_note_content,
            notes::open_editor_window,
            history::record_command_usage,
            history::get_recent_commands,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            match &event {
                tauri::RunEvent::ExitRequested { code, api, .. } => {
                    log_lifecycle(&format!("RunEvent::ExitRequested code={:?}", code));
                    api.prevent_exit();
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
