//! ll-host 统一 IPC 命令（仅有的三个插件通道，§4.3）
//!
//! 命令定义在子模块中（官方插件模式）：tauri 宏会把 `__cmd__*` 包装宏
//! `#[macro_export]` 提升到 crate 根，命令若直接定义在 crate 根会导致
//! 展开尾部的 `pub use` 与提升后的宏同名冲突（E0255）。

use crate::HostState;
use ll_plugin_api::{CoreEvent, PluginError};
use serde_json::{json, Value};
use std::sync::Arc;

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
    // 防止 ll-plugin:// 页面冒用别的插件 id 读其数据库/设置；主窗口（启动器壳层）为可信 UI，放行。
    // 窗口标签约定 = "<pluginId>-<viewId>"（见 services::window_label）。
    let caller = window.label();
    if caller != "main" && !caller.starts_with(&format!("{plugin_id}-")) {
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
        backend.init(ctx).map_err(|e| format!("插件重新初始化失败: {}", e))?;
    } else {
        backend.on_core_event(CoreEvent::Shutdown);
        backend.shutdown();
    }
    Ok(())
}
