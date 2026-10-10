use crate::db::DbState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TodoItem {
    pub id: String,
    pub content: String,
    pub remind_at: Option<String>,
    pub repeat_rule: Option<String>,
    pub completed: bool,
    pub raw_input: String,
    pub created_at: i64,
}

/// 创建新待办事项
#[tauri::command]
pub fn create_todo(
    state: State<'_, DbState>,
    content: String,
    remind_at: Option<String>,
    repeat_rule: Option<String>,
    raw_input: String,
) -> Result<TodoItem, String> {
    let clean_content = content.trim();
    if clean_content.is_empty() {
        return Err("待办内容不能为空".into());
    }

    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();

    conn.execute(
        "INSERT INTO todos (id, content, remind_at, repeat_rule, completed, raw_input, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            &id,
            clean_content,
            &remind_at,
            &repeat_rule,
            0,
            &raw_input,
            now
        ],
    )
    .map_err(|e| format!("写入待办失败: {}", e))?;

    Ok(TodoItem {
        id,
        content: clean_content.to_string(),
        remind_at,
        repeat_rule,
        completed: false,
        raw_input,
        created_at: now,
    })
}

/// 查询待办列表（未完成排在最前，按创建时间倒序）
#[tauri::command]
pub fn list_todos(
    state: State<'_, DbState>,
    keyword: Option<String>,
) -> Result<Vec<TodoItem>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let filter = keyword.unwrap_or_default().trim().to_lowercase();
    let query_sql = if filter.is_empty() {
        "SELECT id, content, remind_at, repeat_rule, completed, raw_input, created_at
         FROM todos ORDER BY completed ASC, created_at DESC"
    } else {
        "SELECT id, content, remind_at, repeat_rule, completed, raw_input, created_at
         FROM todos WHERE LOWER(content) LIKE ?1 ORDER BY completed ASC, created_at DESC"
    };

    let mut stmt = conn.prepare(query_sql).map_err(|e| e.to_string())?;
    let like_pattern = format!("%{}%", filter);

    let mapper = |row: &rusqlite::Row| -> rusqlite::Result<TodoItem> {
        let completed_int: i32 = row.get(4)?;
        Ok(TodoItem {
            id: row.get(0)?,
            content: row.get(1)?,
            remind_at: row.get(2)?,
            repeat_rule: row.get(3)?,
            completed: completed_int != 0,
            raw_input: row.get(5)?,
            created_at: row.get(6)?,
        })
    };

    let mut list = Vec::new();
    if filter.is_empty() {
        let rows = stmt.query_map([], mapper).map_err(|e| e.to_string())?;
        for item in rows {
            if let Ok(todo) = item {
                list.push(todo);
            }
        }
    } else {
        let rows = stmt.query_map([&like_pattern], mapper).map_err(|e| e.to_string())?;
        for item in rows {
            if let Ok(todo) = item {
                list.push(todo);
            }
        }
    }

    Ok(list)
}

/// 切换待办完成状态
#[tauri::command]
pub fn toggle_todo(state: State<'_, DbState>, id: String) -> Result<bool, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let current: i32 = conn
        .query_row(
            "SELECT completed FROM todos WHERE id = ?1",
            rusqlite::params![&id],
            |row| row.get(0),
        )
        .map_err(|e| format!("未找到对应待办: {}", e))?;

    let new_state = if current == 0 { 1 } else { 0 };

    conn.execute(
        "UPDATE todos SET completed = ?1 WHERE id = ?2",
        rusqlite::params![new_state, &id],
    )
    .map_err(|e| format!("更新待办失败: {}", e))?;

    Ok(new_state != 0)
}

/// 删除待办事项
#[tauri::command]
pub fn delete_todo(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM todos WHERE id = ?1", rusqlite::params![&id])
        .map_err(|e| format!("删除待办失败: {}", e))?;
    Ok(())
}
