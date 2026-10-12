//! Python 环境配置 IPC（设置面板「Python 环境」卡片的数据源）
//!
//! sysinfo 等 `kind=llp` 外部插件以 Python 作为 sidecar 运行时。目标机器常常既没把
//! python 加进 PATH、也没在注册表登记（Miniconda 装在 D:\tools 之类位置完全是隐形的），
//! 所以这里提供"用户显式指定解释器"的通道：
//!   - 配置持久化在核心库 `app_settings`（键 `python.path`）
//!   - 保存后即时同步给 ll-host 的进程内缓存，并杀掉已运行的 sidecar
//!     （LLP 懒启动：下次调用自动按新解释器重建，无需重启应用）

use crate::db::DbState;
use ll_host::HostState;
use ll_host::python::{self, PythonCandidate, PythonEnv};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;

/// 读取持久化的用户配置
pub fn read_configured(db: &Arc<Mutex<Connection>>) -> Option<String> {
    let conn = db.lock().ok()?;
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        rusqlite::params![python::SETTING_KEY],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .map(|v| v.trim().to_string())
    .filter(|v| !v.is_empty())
}

/// 写入/清除持久化的用户配置（None = 清除，回落自动探测）
pub fn write_configured(db: &Arc<Mutex<Connection>>, path: Option<&str>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| format!("数据库锁不可用: {}", e))?;
    match path {
        Some(p) => conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![python::SETTING_KEY, p],
        ),
        None => conn.execute(
            "DELETE FROM app_settings WHERE key = ?1",
            rusqlite::params![python::SETTING_KEY],
        ),
    }
    .map_err(|e| format!("保存 Python 路径失败: {}", e))?;
    Ok(())
}

/// 当前 Python 环境状态（设置面板首屏展示）
///
/// 声明为 async：内部要执行解释器取版本，同步命令会占住主线程卡住 UI
#[tauri::command]
pub async fn get_python_env(state: State<'_, DbState>) -> Result<PythonEnv, String> {
    // 以数据库为准同步进程内缓存（多窗口/外部改动也能对齐）
    python::set_configured(read_configured(&state.0));
    Ok(python::current_env())
}

/// 扫描本机可发现的解释器候选（点「自动检测」时调用）
#[tauri::command]
pub async fn detect_python_path() -> Vec<PythonCandidate> {
    python::detect_candidates()
}

/// 设置 / 清除 Python 解释器路径
///
/// 空串表示清除并回落自动探测。路径必须先通过版本探测才落库，避免保存一个
/// 启动即崩的解释器。成功后重启所有 LLP sidecar，使新解释器立即生效。
#[tauri::command]
pub async fn set_python_path(
    state: State<'_, DbState>,
    host: State<'_, HostState>,
    path: String,
) -> Result<PythonEnv, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        write_configured(&state.0, None)?;
        python::set_configured(None);
    } else {
        // 先校验再落库：填错路径时给出可操作的原因，而不是让插件在调用时才炸
        python::probe_version(&trimmed).map_err(|e| format!("{}：{}", e, trimmed))?;
        write_configured(&state.0, Some(&trimmed))?;
        python::set_configured(Some(trimmed));
    }
    let restarted = host.shutdown_llp_plugins();
    if restarted > 0 {
        crate::log_lifecycle(&format!(
            "IPC: python 解释器已更新，重启 {} 个外部插件进程",
            restarted
        ));
    }
    Ok(python::current_env())
}

/// 打开系统文件选择框挑选 python.exe（跨平台兜底：PowerShell / osascript / zenity）
///
/// 返回 None 表示用户取消。失败时不阻断——设置面板仍可手动粘贴路径。
#[tauri::command]
pub async fn pick_python_file() -> Result<Option<String>, String> {
    let out = pick_dialog()?;
    let picked = out
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .last()
        .map(|s| s.to_string());
    Ok(picked.filter(|p| std::path::Path::new(p).is_file()))
}

#[cfg(target_os = "windows")]
fn pick_dialog() -> Result<String, String> {
    const SCRIPT: &str = r#"
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '选择 Python 解释器'
$d.Filter = 'Python (python.exe;python3.exe)|python.exe;python3.exe|所有文件 (*.*)|*.*'
$d.CheckFileExists = $true
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
"#;
    // 选择框停留时间取决于用户，给足超时；-STA 保证 WinForms 对话框能正常模态弹出
    python::run_capture(
        "powershell",
        &["-NoProfile", "-STA", "-Command", SCRIPT],
        Duration::from_secs(180),
    )
}

#[cfg(target_os = "macos")]
fn pick_dialog() -> Result<String, String> {
    python::run_capture(
        "osascript",
        &[
            "-e",
            r#"POSIX path of (choose file with prompt "选择 Python 解释器")"#,
        ],
        Duration::from_secs(180),
    )
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn pick_dialog() -> Result<String, String> {
    // zenity 优先（GTK 桌面常见），回退 kdialog（KDE）
    match python::run_capture(
        "zenity",
        &["--file-selection", "--title=选择 Python 解释器"],
        Duration::from_secs(180),
    ) {
        Ok(p) => Ok(p),
        Err(_) => python::run_capture(
            "kdialog",
            &["--getopenfilename", ".", "python3 python"],
            Duration::from_secs(180),
        ),
    }
}
