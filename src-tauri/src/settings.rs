use crate::db::DbState;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// 允许写入设置表的键与校验（防止任意键值滥用）
fn validate_setting(key: &str, value: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 64 {
        return Err("设置键名无效".into());
    }
    if value.len() > 256 {
        return Err("设置值过长".into());
    }
    if key == "theme" && !["light", "dark"].contains(&value) {
        return Err("主题仅支持 light / dark".into());
    }
    Ok(())
}

/// 读取设置项
#[tauri::command]
pub fn get_setting(state: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取设置失败: {}", e))
}

/// 写入设置项
#[tauri::command]
pub fn set_setting(state: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let key = key.trim().to_string();
    validate_setting(&key, &value)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| format!("保存设置失败: {}", e))?;
    Ok(())
}

#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub db_path: String,
}

/// 应用与版本信息（关于面板用）
#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppInfo {
    let pkg = app.package_info();
    AppInfo {
        name: "LiteLauncher".to_string(),
        version: pkg.version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        db_path: crate::db::get_db_path().to_string_lossy().to_string(),
    }
}

/// 打开应用设置面板窗口（/setting）
///
/// 与编辑器/待办面板同理声明为 async，避免同步命令在主线程创建窗口死锁
#[tauri::command]
pub async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("app-settings") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        &app,
        "app-settings",
        WebviewUrl::App("index.html?view=settings".into()),
    )
    .title("LiteLauncher - 设置")
    .inner_size(500.0, 600.0)
    .min_inner_size(440.0, 480.0)
    .resizable(true)
    // 无边框窗：标题栏/关闭按钮由前端的通用基窗（PopupFrame）提供，
    // 与日历、插件弹窗保持同一套窗口外观；拖拽走基窗标题栏的 drag-region
    .decorations(false)
    .center()
    .build()
    .map_err(|e| format!("创建设置窗口失败: {}", e))?;

    Ok(())
}
