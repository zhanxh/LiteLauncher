//! 主热键与开机自启（WP-04）
//!
//! 主热键和插件热键共用 `ll-host` 的同一张注册表：谁先占用谁赢，
//! 冲突信息能直接告诉用户"被哪个插件占了"。插件热键的 manifest 声明与
//! 用户覆盖在 ll-host 侧解析，这里只负责启动期注册与主热键/自启命令。

use crate::db::DbState;
use crate::log_lifecycle;
use ll_plugin_api::HotkeySpec;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

pub const DEFAULT_MAIN_HOTKEY: &str = "alt+space";
pub const FALLBACK_MAIN_HOTKEY: &str = "alt+x";
const MAIN_KEY: &str = "hotkey.main";

fn setting_get(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn setting_set(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| format!("保存设置失败: {}", e))?;
    Ok(())
}

fn configured(db: &Arc<Mutex<rusqlite::Connection>>) -> String {
    let stored = db.lock().ok().and_then(|conn| setting_get(&conn, MAIN_KEY));
    stored
        .map(|v| ll_host::services::normalize_accel(&v))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_MAIN_HOTKEY.to_string())
}

fn active_core_accel() -> Option<String> {
    ll_host::services::shortcut_all()
        .into_iter()
        .find(|(_, owner)| owner.is_owned_by("core", None))
        .map(|(accel, _)| accel)
}

fn register_main(app: &AppHandle, accel: &str) -> Result<(), String> {
    let handle = app.clone();
    ll_host::services::register_core_shortcut(app, accel, move || {
        let _ = crate::toggle_main_window(handle.clone());
    })
}

/// 启动时注册主热键：配置值失败则回退 Alt+X，并在日志里写清原因
pub fn init_main_hotkey(app: &AppHandle, db: &Arc<Mutex<rusqlite::Connection>>) {
    let wanted = configured(db);
    match register_main(app, &wanted) {
        Ok(()) => log_lifecycle(&format!("hotkey: 主热键已注册 {}", wanted)),
        Err(e) => {
            log_lifecycle(&format!("hotkey: 主热键 {} 注册失败: {}", wanted, e));
            if wanted != FALLBACK_MAIN_HOTKEY {
                match register_main(app, FALLBACK_MAIN_HOTKEY) {
                    Ok(()) => log_lifecycle(&format!(
                        "hotkey: 已回退到备用热键 {}",
                        FALLBACK_MAIN_HOTKEY
                    )),
                    Err(e2) => log_lifecycle(&format!(
                        "hotkey: 备用热键 {} 也注册失败: {}",
                        FALLBACK_MAIN_HOTKEY, e2
                    )),
                }
            }
        }
    }
}

fn effective_for(
    db: &Arc<Mutex<rusqlite::Connection>>,
    plugin_id: &str,
    spec: &HotkeySpec,
) -> String {
    let stored = db
        .lock()
        .ok()
        .and_then(|conn| setting_get(&conn, &format!("{}.hotkey.{}", plugin_id, spec.id)));
    stored
        .map(|v| ll_host::services::normalize_accel(&v))
        .unwrap_or_else(|| spec.default.clone())
}

fn enabled_for(db: &Arc<Mutex<rusqlite::Connection>>, plugin_id: &str, spec: &HotkeySpec) -> bool {
    let stored = db
        .lock()
        .ok()
        .and_then(|conn| setting_get(&conn, &format!("{}.hotkey.{}.enabled", plugin_id, spec.id)));
    stored.map(|v| v != "false").unwrap_or(spec.enabled)
}

/// 启动时批量注册 manifest 声明的插件热键（插件前端只负责订阅事件）
pub fn init_plugin_hotkeys(
    app: &AppHandle,
    db: &Arc<Mutex<rusqlite::Connection>>,
    specs: Vec<(String, bool, Vec<HotkeySpec>)>,
) {
    for (plugin_id, enabled, hotkeys) in specs {
        if !enabled {
            continue;
        }
        for spec in hotkeys {
            if !enabled_for(db, &plugin_id, &spec) {
                continue;
            }
            let accel = effective_for(db, &plugin_id, &spec);
            if accel.is_empty() {
                continue;
            }
            match ll_host::services::register_plugin_hotkey(
                app,
                &accel,
                &plugin_id,
                &spec.id,
                &spec.label,
            ) {
                Ok(()) => log_lifecycle(&format!(
                    "hotkey: 插件 {} / {} 已注册 {}",
                    plugin_id, spec.label, accel
                )),
                Err(e) => log_lifecycle(&format!(
                    "hotkey: 插件 {} / {} 注册 {} 失败: {}",
                    plugin_id, spec.label, accel, e
                )),
            }
        }
    }
}

/// 主热键状态：`accel` 是配置值，`active` 是实际生效值（可能是回退键）
#[tauri::command]
pub fn get_main_hotkey(state: State<'_, DbState>) -> Value {
    let accel = configured(&state.0);
    let active = active_core_accel().unwrap_or_default();
    json!({
        "accel": accel,
        "active": active,
        "ok": !active.is_empty(),
        "fallback": active != accel && !active.is_empty(),
    })
}

/// 改主热键：先注册新键成功，再持久化并退旧键；失败时旧键保持可用
#[tauri::command]
pub fn set_main_hotkey(
    app: AppHandle,
    state: State<'_, DbState>,
    accel: String,
) -> Result<Value, String> {
    let new_accel = ll_host::services::normalize_accel(&accel);
    if new_accel.is_empty() {
        return Err("热键不能为空".to_string());
    }
    let old_active = active_core_accel();

    register_main(&app, &new_accel)?;

    {
        let conn = state.0.lock().map_err(|_| "数据库锁不可用".to_string())?;
        if let Err(e) = setting_set(&conn, MAIN_KEY, &new_accel) {
            drop(conn);
            ll_host::services::unregister_core_shortcut(&app, &new_accel);
            return Err(e);
        }
    }

    if let Some(old) = old_active {
        if old != new_accel {
            ll_host::services::unregister_core_shortcut(&app, &old);
        }
    }
    log_lifecycle(&format!("hotkey: 主热键已改为 {}", new_accel));
    Ok(json!({ "accel": new_accel, "active": new_accel, "ok": true }))
}

#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Value {
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    json!({ "enabled": enabled })
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<Value, String> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| format!("设置开机自启失败: {}", e))?;
    let actual = manager.is_enabled().unwrap_or(enabled);
    log_lifecycle(&format!("autostart: enabled={}", actual));
    Ok(json!({ "enabled": actual }))
}
