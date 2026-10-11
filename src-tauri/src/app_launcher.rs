use crate::db::DbState;
use serde::{Deserialize, Serialize};
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

/// 是否应交给系统默认打开器打开（仅非 Windows 平台）
///
/// - URL、.desktop 桌面项、非可执行文档 → true（xdg-open / open）
/// - 可执行文件（含绝对路径）与裸命令 → false（直接 spawn，走 PATH）
///
/// 注意：可执行文件绝不能交给 xdg-open——桌面环境对 application/x-executable
/// 类型通常没有默认打开方式，会静默失败（GNOME 实测如此）
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
        // Windows：通过 cmd.exe /c start "" "目标路径" 启动，确保目标程序
        // 以完全独立的进程运行，并支持系统环境变量关联；CREATE_NO_WINDOW 隐藏 cmd 窗口
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new("cmd")
            .args(["/c", "start", "", clean_path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    }

    #[cfg(not(target_os = "windows"))]
    {
        // .desktop 桌面项必须用 gio launch / gtk-launch 启动：
        // xdg-open 会把它当作普通文件交给默认程序"打开"（通常是编辑器），
        // 而不是执行其中的 Exec（本机 marker 测试实证）
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
            Command::new(opener).arg(clean_path).spawn()
        } else {
            Command::new(clean_path).spawn()
        }
    }
}

/// 启动 .desktop 桌面项：优先 `gio launch`（GLib ≥ 2.58，接受任意路径），
/// 二进制缺失时回退 `gtk-launch <桌面项ID>`（要求文件位于标准 applications 目录）
#[cfg(not(target_os = "windows"))]
fn spawn_desktop_entry(path: &str) -> std::io::Result<std::process::Child> {
    if let Ok(child) = Command::new("gio").args(["launch", path]).spawn() {
        return Ok(child);
    }

    if let Some(id) = std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
    {
        if let Ok(child) = Command::new("gtk-launch").arg(&id).spawn() {
            return Ok(child);
        }
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "未找到 gio 或 gtk-launch，无法启动桌面项（请安装 glib/gtk 工具）",
    ))
}

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

    spawn_app(clean_path).map_err(|e| format!("启动程序失败: {}", e))?;

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

    // 同一路径只允许添加一次，避免候选列表重复点击造成冗余条目
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM app_shortcuts WHERE path = ?1",
            rusqlite::params![&path],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if exists > 0 {
        return Err(format!("\"{}\" 已在应用列表中，无需重复添加", name));
    }

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

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn opener_decision_by_file_type() {
        let dir = std::env::temp_dir().join(format!("ll-opener-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        // 可执行文件（含绝对路径）→ 直接 spawn
        let exec_file = dir.join("exec-tool");
        fs::write(&exec_file, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(&exec_file, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!should_use_opener(exec_file.to_str().unwrap()));
        assert!(!should_use_opener("/bin/ls"));

        // 文档 → 打开器
        let doc = dir.join("doc.md");
        fs::write(&doc, b"# doc\n").unwrap();
        assert!(should_use_opener(doc.to_str().unwrap()));

        // .desktop 桌面项 → 打开器（即使带可执行位）
        let desktop = dir.join("app.desktop");
        fs::write(&desktop, b"[Desktop Entry]\n").unwrap();
        fs::set_permissions(&desktop, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(should_use_opener(desktop.to_str().unwrap()));

        // URL → 打开器；裸命令（不存在于磁盘）→ 直接 spawn
        assert!(should_use_opener("https://example.com"));
        assert!(should_use_opener("file:///tmp/x.md"));
        assert!(!should_use_opener("gnome-terminal"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn desktop_entry_launch_executes_exec_line() {
        // gio 缺失的环境跳过（如极简容器）
        if Command::new("gio").arg("--version").output().is_err() {
            return;
        }
        let marker = std::env::temp_dir().join(format!("ll-desktop-marker-{}", std::process::id()));
        let _ = fs::remove_file(&marker);
        let desktop = std::env::temp_dir().join(format!("ll-desktop-test-{}.desktop", std::process::id()));
        fs::write(
            &desktop,
            format!(
                "[Desktop Entry]\nType=Application\nName=LL Test\nExec=/bin/touch {}\n",
                marker.to_string_lossy()
            ),
        )
        .unwrap();

        let child = spawn_desktop_entry(desktop.to_str().unwrap());
        assert!(child.is_ok(), "spawn_desktop_entry 失败: {:?}", child.err());

        // gio launch 异步执行 Exec，轮询等待 marker 出现
        let mut launched = false;
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(200));
            if marker.exists() {
                launched = true;
                break;
            }
        }
        assert!(launched, ".desktop 的 Exec 未被执行");
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_file(&desktop);
    }
}
