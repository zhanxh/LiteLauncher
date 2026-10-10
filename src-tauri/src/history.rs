use crate::db::DbState;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommandHistoryItem {
    pub input: String,
    pub plugin_id: String,
    pub used_at: i64,
    pub use_count: i32,
}

/// 记录或累加指令使用历史与频次
#[tauri::command]
pub fn record_command_usage(
    state: State<'_, DbState>,
    input: String,
    plugin_id: String,
) -> Result<(), String> {
    let clean_input = input.trim();
    if clean_input.is_empty() {
        return Ok(());
    }

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp();

    conn.execute(
        "INSERT INTO command_history (input, plugin_id, used_at, use_count)
         VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(input) DO UPDATE SET
            used_at = ?3,
            use_count = command_history.use_count + 1",
        params![clean_input, plugin_id, now],
    )
    .map_err(|e| format!("写入指令历史失败: {}", e))?;

    Ok(())
}

/// 获取高频与最近使用的指令历史
#[tauri::command]
pub fn get_recent_commands(
    state: State<'_, DbState>,
    limit: Option<usize>,
) -> Result<Vec<CommandHistoryItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let max_count = limit.unwrap_or(8);

    let mut stmt = conn
        .prepare(
            "SELECT input, plugin_id, used_at, use_count
             FROM command_history
             ORDER BY use_count DESC, used_at DESC
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![max_count as i64], |row| {
            Ok(CommandHistoryItem {
                input: row.get(0)?,
                plugin_id: row.get(1)?,
                used_at: row.get(2)?,
                use_count: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut list = Vec::new();
    for item in rows.flatten() {
        list.push(item);
    }

    Ok(list)
}
