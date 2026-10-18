//! ll-host 统一 IPC 命令（仅有的三个插件通道，§4.3）
//!
//! 命令定义在子模块中（官方插件模式）：tauri 宏会把 `__cmd__*` 包装宏
//! `#[macro_export]` 提升到 crate 根，命令若直接定义在 crate 根会导致
//! 展开尾部的 `pub use` 与提升后的宏同名冲突（E0255）。

use crate::HostState;
use ll_plugin_api::{CoreEvent, HotkeySpec, PluginError, PluginManifest};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// 插件方法统一调用入口。async 命令 → 运行于工作线程，DB 操作不阻塞主线程
///
/// `svc.*` 是**宿主保留方法名空间**（设计文档 §4.6）：由宿主统一分发器直接应答，
/// 不进入插件后端分发表。由此"纯前端插件（无 crate / 无 sidecar）"与"带后端插件"
/// 看到的能力完全一致，插件形态与能力集合彻底解耦。
///
/// `window` 是 Tauri 填的**发起这次 IPC 的窗口**，插件侧传不进来也改不了：
/// 只有靠它才能把"改窗口尺寸"限定成"只能改自己那个窗口"。
#[tauri::command]
pub async fn plugin_call(
    state: tauri::State<'_, HostState>,
    window: tauri::WebviewWindow,
    plugin_id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    // 调用者绑定（M2 security boundary）：资产页/第三方窗口只能以自己的插件身份调用后端，
    // 防止 ll-plugin:// 页面冒用别的插件 id 读其数据库/设置；壳层自有窗口为可信 UI，放行。
    // 窗口标签约定 = "<pluginId>-<viewId>"（见 services::window_label）。
    // 可信窗口只有三个：主启动器、设置、欢迎引导——都不承载插件页面。
    const SHELL_WINDOWS: &[&str] = &["main", "app-settings", "welcome"];
    let caller = window.label();
    let trusted_shell = SHELL_WINDOWS.contains(&caller);
    if !trusted_shell && !caller.starts_with(&format!("{plugin_id}-")) {
        return Err(format!(
            "调用被拒绝：窗口 {caller} 不能代表插件 {plugin_id} 调用后端"
        ));
    }

    if method.starts_with("svc.") {
        // 已注册插件仍需尊重启用状态；未注册（纯前端插件）无此概念，直接放行
        {
            let map = state
                .plugins
                .read()
                .map_err(|_| "插件注册表锁不可用".to_string())?;
            if let Some(entry) = map.get(&plugin_id) {
                if !entry.enabled {
                    return Err(format!("插件已禁用: {}", plugin_id));
                }
            }
        }
        let ctx = state.svc_context(&plugin_id)?;
        return crate::services::dispatch_svc(&ctx, &method, &params, Some(window.label()))
            .map_err(|e| e.to_string());
    }

    let backend = {
        let map = state
            .plugins
            .read()
            .map_err(|_| "插件注册表锁不可用".to_string())?;
        let entry = map
            .get(&plugin_id)
            .ok_or_else(|| format!("未知插件: {}", plugin_id))?;
        if !entry.enabled {
            return Err(format!("插件已禁用: {}", plugin_id));
        }
        Arc::clone(&entry.backend)
    };
    backend
        .call(&method, params)
        .map_err(|e: PluginError| e.to_string())
}

/// 列出全部插件及其 manifest 信息（/plugins 管理页数据源）
#[tauri::command]
pub fn plugin_list(state: tauri::State<'_, HostState>) -> Vec<Value> {
    let map = match state.plugins.read() {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    map.values()
        .map(|entry| {
            let m = entry.backend.manifest();
            json!({
                "id": m.id,
                "name": m.name,
                "version": m.version,
                "apiVersion": m.api_version,
                "trigger": m.trigger,
                "description": m.description,
                "enabled": entry.enabled,
                "permissions": m.permissions,
                "views": m.views,
                "settings": m.settings,
                "backend": { "kind": m.backend.kind, "entry": m.backend.entry },
                "command": m.command.map(|c| json!({
                    "icon": c.icon,
                    "actionSubcommands": c.action_subcommands,
                    "hint": c.hint,
                    // 外部插件同样支持防抖：不透传的话 /find 会逐键打 IPC
                    "queryDebounceMs": c.query_debounce_ms,
                })),
            })
        })
        .collect()
}

/// 启用/禁用插件：持久化到 app_settings + 立即 init()/shutdown()
#[tauri::command]
pub fn plugin_set_enabled(
    state: tauri::State<'_, HostState>,
    app: AppHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<(), String> {
    let db = state
        .core_db
        .read()
        .map_err(|_| "数据库句柄锁不可用".to_string())?
        .clone()
        .ok_or("数据库未初始化")?;

    // 1. 持久化启用状态
    {
        let conn = db.lock().map_err(|_| "数据库锁不可用".to_string())?;
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![format!("plugin.{}.enabled", plugin_id), enabled.to_string()],
        )
        .map_err(|e| format!("保存插件状态失败: {}", e))?;
    }

    // 2. 运行时切换
    let (manifest, backend) = {
        let mut map = state
            .plugins
            .write()
            .map_err(|_| "插件注册表锁不可用".to_string())?;
        let entry = map
            .get_mut(&plugin_id)
            .ok_or_else(|| format!("未知插件: {}", plugin_id))?;
        entry.enabled = enabled;
        let backend = Arc::clone(&entry.backend);
        (backend.manifest(), backend)
    };

    if enabled {
        let log: crate::LogFn = Arc::new(|_, _| {});
        let plugin_conn = state
            .db_registry
            .read()
            .unwrap()
            .as_ref()
            .and_then(|r| r.cached(&plugin_id).ok());
        let core_db = state
            .core_db
            .read()
            .map_err(|_| "数据库句柄锁不可用".to_string())?
            .clone()
            .ok_or("数据库未初始化")?;
        let ctx = crate::build_context_from_parts(
            state.app.read().unwrap().as_ref(),
            &manifest,
            plugin_conn,
            core_db,
            log,
        );
        backend
            .init(ctx)
            .map_err(|e| format!("插件重新初始化失败: {}", e))?;

        // 插件重新启用后补注册它的热键（manifest 默认值 / 用户覆盖）
        for spec in manifest.valid_hotkeys() {
            if !hotkey_enabled(&db, &plugin_id, &spec) {
                continue;
            }
            let accel = effective_hotkey(&db, &plugin_id, &spec);
            if accel.is_empty() {
                continue;
            }
            // 单个热键冲突不影响插件启用，设置页会显示冲突状态
            let _ = crate::services::register_plugin_hotkey(
                &app,
                &accel,
                &plugin_id,
                &spec.id,
                &spec.label,
            );
        }
    } else {
        // 先退热键再停插件：避免停用后热键还挂在系统里
        for spec in manifest.valid_hotkeys() {
            let accel = effective_hotkey(&db, &plugin_id, &spec);
            if !accel.is_empty() {
                crate::services::unregister_plugin_hotkey(&app, &accel, &plugin_id, &spec.id);
            }
        }
        backend.on_core_event(CoreEvent::Shutdown);
        backend.shutdown();
    }
    // 剪贴板监听跟随插件启用状态：禁用立即停采，启用可按需拉起线程
    if plugin_id == "clip" {
        state.set_clipboard_watcher_enabled(enabled);
        if enabled {
            let log: crate::LogFn = Arc::new(|_, _| {});
            state.start_clipboard_watcher(app.clone(), log);
        }
    }
    emit_changed(&app);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件热键管理（WP-04b）：manifest 声明默认值，用户覆盖存 app_settings
// ─────────────────────────────────────────────────────────────────────────────

fn core_db(state: &HostState) -> Result<Arc<Mutex<rusqlite::Connection>>, String> {
    state
        .core_db
        .read()
        .map_err(|_| "数据库句柄锁不可用".to_string())?
        .clone()
        .ok_or_else(|| "数据库未初始化".to_string())
}

fn setting_get(db: &Arc<Mutex<rusqlite::Connection>>, key: &str) -> Option<String> {
    let conn = db.lock().ok()?;
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn setting_set(
    db: &Arc<Mutex<rusqlite::Connection>>,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let conn = db.lock().map_err(|_| "数据库锁不可用".to_string())?;
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| format!("保存设置失败: {}", e))?;
    Ok(())
}

fn setting_delete(db: &Arc<Mutex<rusqlite::Connection>>, key: &str) -> Result<(), String> {
    let conn = db.lock().map_err(|_| "数据库锁不可用".to_string())?;
    conn.execute(
        "DELETE FROM app_settings WHERE key = ?1",
        rusqlite::params![key],
    )
    .map_err(|e| format!("删除设置失败: {}", e))?;
    Ok(())
}

fn hotkey_enabled(
    db: &Arc<Mutex<rusqlite::Connection>>,
    plugin_id: &str,
    spec: &HotkeySpec,
) -> bool {
    setting_get(db, &format!("{}.hotkey.{}.enabled", plugin_id, spec.id))
        .map(|v| v != "false")
        .unwrap_or(spec.enabled)
}

fn effective_hotkey(
    db: &Arc<Mutex<rusqlite::Connection>>,
    plugin_id: &str,
    spec: &HotkeySpec,
) -> String {
    setting_get(db, &format!("{}.hotkey.{}", plugin_id, spec.id))
        .map(|v| crate::services::normalize_accel(&v))
        .unwrap_or_else(|| spec.default.clone())
}

fn manifest_of(state: &HostState, plugin_id: &str) -> Option<(PluginManifest, bool)> {
    let plugins = state.plugins.read().ok()?;
    plugins
        .get(plugin_id)
        .map(|entry| (entry.backend.manifest(), entry.enabled))
}

fn find_spec(manifest: &PluginManifest, hotkey_id: &str) -> Option<HotkeySpec> {
    manifest
        .valid_hotkeys()
        .into_iter()
        .find(|spec| spec.id == hotkey_id)
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit("hotkey-changed", json!({}));
}

/// 设置页的插件热键目录（含 effective/注册状态/冲突信息）
#[tauri::command]
pub fn plugin_hotkeys(state: tauri::State<'_, HostState>) -> Vec<Value> {
    let db = match core_db(&state) {
        Ok(db) => db,
        Err(_) => return Vec::new(),
    };
    let entries: Vec<(PluginManifest, bool)> = {
        let Ok(plugins) = state.plugins.read() else {
            return Vec::new();
        };
        plugins
            .values()
            .map(|entry| (entry.backend.manifest(), entry.enabled))
            .collect()
    };

    let mut out = Vec::new();
    for (manifest, plugin_enabled) in entries {
        for spec in manifest.valid_hotkeys() {
            let accel = effective_hotkey(&db, &manifest.id, &spec);
            let enabled = plugin_enabled && hotkey_enabled(&db, &manifest.id, &spec);
            let owner = if accel.is_empty() {
                None
            } else {
                crate::services::shortcut_owner(&accel)
            };
            let registered = owner
                .as_ref()
                .map(|o| o.is_owned_by(&manifest.id, Some(&spec.id)))
                .unwrap_or(false);
            let conflict = owner
                .as_ref()
                .filter(|o| !o.is_owned_by(&manifest.id, Some(&spec.id)))
                .map(|o| o.label.clone());
            let status = if !enabled {
                "disabled"
            } else if conflict.is_some() {
                "conflict"
            } else if registered {
                "ok"
            } else if accel.is_empty() {
                "unset"
            } else {
                "idle"
            };
            let overridden = !accel.is_empty() && accel != spec.default;
            out.push(json!({
                "pluginId": manifest.id,
                "pluginName": manifest.name,
                "hotkeyId": spec.id,
                "label": spec.label,
                "description": spec.description,
                "default": spec.default,
                "accel": accel,
                "scope": spec.scope,
                "editable": spec.editable,
                "enabled": enabled,
                "overridden": overridden,
                "registered": registered,
                "status": status,
                "conflictWith": conflict,
            }));
        }
    }
    out.sort_by(|a, b| {
        let ka = format!(
            "{}:{}",
            a["pluginName"].as_str().unwrap_or(""),
            a["label"].as_str().unwrap_or("")
        );
        let kb = format!(
            "{}:{}",
            b["pluginName"].as_str().unwrap_or(""),
            b["label"].as_str().unwrap_or("")
        );
        ka.cmp(&kb)
    });
    out
}

/// 应用一个插件热键：先注册新键，成功后再持久化并退旧键
fn apply_plugin_hotkey(
    state: &HostState,
    app: &AppHandle,
    plugin_id: &str,
    hotkey_id: &str,
    accel: &str,
) -> Result<Value, String> {
    let (manifest, plugin_enabled) =
        manifest_of(state, plugin_id).ok_or_else(|| format!("未知插件: {}", plugin_id))?;
    let spec = find_spec(&manifest, hotkey_id)
        .ok_or_else(|| format!("插件 {} 未声明热键 {}", plugin_id, hotkey_id))?;
    if !spec.editable {
        return Err(format!("热键 {} 不允许修改", spec.label));
    }
    let new_accel = crate::services::normalize_accel(accel);
    if new_accel.is_empty() {
        return Err("热键不能为空".to_string());
    }

    let db = core_db(state)?;
    let old_accel = effective_hotkey(&db, plugin_id, &spec);
    let was_enabled = hotkey_enabled(&db, plugin_id, &spec);
    let should_register = plugin_enabled && was_enabled;

    if should_register {
        // 新键先占位：失败时旧键仍然可用
        crate::services::register_plugin_hotkey(app, &new_accel, plugin_id, &spec.id, &spec.label)
            .map_err(|e| e.to_string())?;
    }

    let key = format!("{}.hotkey.{}", plugin_id, spec.id);
    if let Err(e) = setting_set(&db, &key, &new_accel) {
        if should_register {
            crate::services::unregister_plugin_hotkey(app, &new_accel, plugin_id, &spec.id);
        }
        return Err(e);
    }

    if should_register && !old_accel.is_empty() && old_accel != new_accel {
        crate::services::unregister_plugin_hotkey(app, &old_accel, plugin_id, &spec.id);
    }

    emit_changed(app);
    Ok(json!({ "accel": new_accel, "enabled": was_enabled }))
}

#[tauri::command]
pub fn set_plugin_hotkey(
    state: tauri::State<'_, HostState>,
    app: AppHandle,
    plugin_id: String,
    hotkey_id: String,
    accel: String,
) -> Result<Value, String> {
    apply_plugin_hotkey(&state, &app, &plugin_id, &hotkey_id, &accel)
}

#[tauri::command]
pub fn reset_plugin_hotkey(
    state: tauri::State<'_, HostState>,
    app: AppHandle,
    plugin_id: String,
    hotkey_id: String,
) -> Result<Value, String> {
    let (manifest, _) =
        manifest_of(&state, &plugin_id).ok_or_else(|| format!("未知插件: {}", plugin_id))?;
    let spec = find_spec(&manifest, &hotkey_id)
        .ok_or_else(|| format!("插件 {} 未声明热键 {}", plugin_id, hotkey_id))?;
    let db = core_db(&state)?;
    let key = format!("{}.hotkey.{}", plugin_id, spec.id);

    if spec.default.is_empty() {
        let old = effective_hotkey(&db, &plugin_id, &spec);
        if !old.is_empty() {
            crate::services::unregister_plugin_hotkey(&app, &old, &plugin_id, &spec.id);
        }
        setting_delete(&db, &key)?;
        emit_changed(&app);
        return Ok(json!({ "accel": "" }));
    }

    apply_plugin_hotkey(&state, &app, &plugin_id, &hotkey_id, &spec.default)
}

#[tauri::command]
pub fn set_plugin_hotkey_enabled(
    state: tauri::State<'_, HostState>,
    app: AppHandle,
    plugin_id: String,
    hotkey_id: String,
    enabled: bool,
) -> Result<Value, String> {
    let (manifest, plugin_enabled) =
        manifest_of(&state, &plugin_id).ok_or_else(|| format!("未知插件: {}", plugin_id))?;
    let spec = find_spec(&manifest, &hotkey_id)
        .ok_or_else(|| format!("插件 {} 未声明热键 {}", plugin_id, hotkey_id))?;
    let db = core_db(&state)?;
    let accel = effective_hotkey(&db, &plugin_id, &spec);

    if enabled && plugin_enabled && !accel.is_empty() {
        crate::services::register_plugin_hotkey(&app, &accel, &plugin_id, &spec.id, &spec.label)
            .map_err(|e| e.to_string())?;
    }
    if !enabled && !accel.is_empty() {
        crate::services::unregister_plugin_hotkey(&app, &accel, &plugin_id, &spec.id);
    }

    setting_set(
        &db,
        &format!("{}.hotkey.{}.enabled", plugin_id, spec.id),
        if enabled { "true" } else { "false" },
    )?;
    emit_changed(&app);
    Ok(json!({ "enabled": enabled }))
}
