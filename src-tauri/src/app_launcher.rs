use crate::db::DbState;
use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::process::Command;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub icon: String,
    pub description: String,
}

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 启动指定的外部应用程序，并立即隐藏启动器主窗口
#[tauri::command]
pub fn launch_application(app: AppHandle, path: String) -> Result<(), String> {
    let clean_path = path.trim();
    if clean_path.is_empty() {
        return Err("启动路径不能为空".into());
    }

    // 安全校验：防止 Shell 命令注入（禁止管道、重定向、拼接符号）
    let forbidden_chars = ['&', '|', ';', '>', '<', '$', '`', '\n', '\r'];
    if clean_path.chars().any(|c| forbidden_chars.contains(&c)) {
        return Err("启动路径包含不安全的特殊字符".into());
    }

    // 在 Windows 环境下，通过 cmd.exe /c start "" "目标路径" 启动外部应用
    // 这样能确保目标程序以完全独立的进程运行，并支持系统环境变量关联
    Command::new("cmd")
        .args(["/c", "start", "", clean_path])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("启动程序失败: {}", e))?;

    // Launcher 标准行为：启动目标程序后自动隐藏主窗口
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    Ok(())
}

/// 获取已注册的应用快捷列表（支持关键词过滤）
#[tauri::command]
pub fn list_applications(
    state: State<'_, DbState>,
    keyword: Option<String>,
) -> Result<Vec<AppItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let filter = keyword.unwrap_or_default().trim().to_lowercase();
    let query_sql = if filter.is_empty() {
        "SELECT id, name, path FROM app_shortcuts ORDER BY created_at ASC"
    } else {
        "SELECT id, name, path FROM app_shortcuts WHERE LOWER(name) LIKE ?1 OR LOWER(path) LIKE ?1 ORDER BY created_at ASC"
    };

    let mut stmt = conn.prepare(query_sql).map_err(|e| e.to_string())?;
    let like_pattern = format!("%{}%", filter);

    let mapper = |row: &rusqlite::Row| -> rusqlite::Result<AppItem> {
        let id: String = row.get(0)?;
        let name: String = row.get(1)?;
        let path: String = row.get(2)?;
        Ok(AppItem {
            id,
            icon: "🚀".to_string(),
            description: format!("可执行程序: {}", path),
            name,
            path,
        })
    };

    let mut list = Vec::new();
    if filter.is_empty() {
        let rows = stmt.query_map([], mapper).map_err(|e| e.to_string())?;
        for item in rows {
            if let Ok(app) = item {
                list.push(app);
            }
        }
    } else {
        let rows = stmt.query_map([&like_pattern], mapper).map_err(|e| e.to_string())?;
        for item in rows {
            if let Ok(app) = item {
                list.push(app);
            }
        }
    }

    Ok(list)
}

/// 添加自定义应用快捷启动
#[tauri::command]
pub fn add_custom_app(
    state: State<'_, DbState>,
    name: String,
    path: String,
) -> Result<AppItem, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();

    conn.execute(
        "INSERT INTO app_shortcuts (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![&id, &name, &path, now],
    )
    .map_err(|e| format!("添加应用失败: {}", e))?;

    Ok(AppItem {
        id,
        name,
        path: path.clone(),
        icon: "🚀".to_string(),
        description: format!("可执行程序: {}", path),
    })
}
