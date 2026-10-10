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

/// 动态调整启动器主窗口高度
#[tauri::command]
fn set_main_window_height(app: AppHandle, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let clamped_height = height.clamp(64.0, 640.0);
        let current_size = window.inner_size().map_err(|e| e.to_string())?;
        let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
        let logical_width = current_size.width as f64 / scale_factor;

        window
            .set_size(LogicalSize::new(logical_width, clamped_height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 隐藏主窗口
#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 显示并聚焦主窗口
#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 切换主窗口显隐状态
#[tauri::command]
fn toggle_main_window(app: AppHandle) -> Result<(), String> {
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
            let conn = db::init_db().expect("无法初始化本地 SQLite 数据库");
            app.manage(DbState(Mutex::new(conn)));

            let app_handle = app.handle().clone();

            // 2. 初始化系统托盘菜单
            let show_item = MenuItem::with_id(app, "show", "显示 LiteLauncher", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        let _ = show_main_window(app.clone());
                    }
                    "quit" => {
                        app.exit(0);
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
                .build(app)?;

            // 3. 注册全局快捷键：Alt + Space
            let shortcut: Shortcut = "alt+space".parse().map_err(|e| {
                tauri::Error::from(std::io::Error::new(std::io::ErrorKind::Other, format!("{:?}", e)))
            })?;

            let handle_for_shortcut = app_handle.clone();
            app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = toggle_main_window(handle_for_shortcut.clone());
                }
            })?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
