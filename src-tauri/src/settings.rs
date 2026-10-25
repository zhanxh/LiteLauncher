use crate::db::DbState;
use rusqlite::{OptionalExtension, params};
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
        // rounded=1：与主窗/插件窗同款圆角机制——前端 App 用 .plugin-window-root
        // 画 4px 圆角面板，四角透出桌面
        WebviewUrl::App("index.html?view=settings&rounded=1".into()),
    )
    .title("LiteLauncher - 设置")
    // 横版布局：左侧竖排分类导航 + 右侧内容区，宽度大于高度才摆得下
    .inner_size(800.0, 560.0)
    .min_inner_size(660.0, 480.0)
    .resizable(true)
    // 无边框窗：标题栏/关闭按钮由前端的通用基窗（PopupFrame）提供，
    // 与日历、插件弹窗保持同一套窗口外观；拖拽走基窗标题栏的 drag-region
    .decorations(false)
    // 圆角窗口：透明 + 去系统投影（投影沿矩形窗口画，会在透明圆角外套方形
    // 阴影/Win11 白边，与插件窗口的处理一致）
    .transparent(true)
    .shadow(false)
    .center()
    .build()
    .map_err(|e| format!("创建设置窗口失败: {}", e))?;

    Ok(())
}

/// 打开欢迎引导窗（首启自动 / 设置里重看）
///
/// `apps` 是主窗口在打开前取到的目录数量：欢迎窗自己没有插件调用权限，
/// 直接显示主窗口算好的数字，避免为"只读一个计数"放宽 plugin_call 的调用者校验。
#[tauri::command]
pub async fn open_welcome_window(app: AppHandle, apps: Option<u32>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("welcome") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = match apps {
        Some(count) => format!("index.html?view=welcome&apps={count}"),
        None => "index.html?view=welcome".to_string(),
    };
    WebviewWindowBuilder::new(&app, "welcome", WebviewUrl::App(url.into()))
        .title("LiteLauncher - 欢迎")
        .inner_size(800.0, 620.0)
        .min_inner_size(720.0, 560.0)
        // 可缩放：用户拉大窗口时布局自适应（内容列限宽居中，见 welcome.css）；
        // 下限锁在原设计尺寸，避免缩得比内容还小
        .resizable(true)
        .decorations(false)
        // 与 todo/pomo 一致：Win11 无边框窗默认带一圈白边，关掉阴影才干净
        .shadow(false)
        // 主窗是 alwaysOnTop；欢迎窗也置顶，避免被其他置于顶层的窗口盖住
        .always_on_top(true)
        .center()
        .build()
        .map_err(|e| format!("创建欢迎窗口失败: {}", e))?;

    Ok(())
}
