//! `/find` 文件搜索后端（M6：从 llp/Python 迁入 native 动态库）。
//!
//! 迁移前是 `find.py` + `everything.py` + `locate.py` + `query.py` + `format.py`
//! 五个文件、一个 Python sidecar；现在同一套行为跑在宿主进程内。
//!
//! 分工：
//!   - [`term`]：控制词剥离（`desc size` / `limit N` / 首个子命令），其余语法原样交给索引；
//!   - [`query`]：`ext:` / `size:` / `dm:` / `name:` / `path:` / `type:` 的解析与本地过滤
//!     （Windows 上交给 Everything，Linux 上靠它自己过滤）；
//!   - [`format`]：面板条目与统计条（纯函数，单测覆盖）；
//!   - [`everything`]：Windows 上直接 FFI 调 Everything64.dll（迁移前是 ctypes）；
//!   - [`locate`]：Linux 上的 plocate → fd → find 三级后端（迁移前是 locate.py）。
//!
//! 宿主能力只用 `process`（打开/定位）与 `settings`（最近目录），与迁移前一致；
//! 行为约定（方法名、返回字段、条目 id）逐字对齐 LLP 版本，前端不需要任何改动。

use ll_plugin_api::{PluginBackend, PluginContext, PluginError, PluginManifest};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

mod format;
// Unix 后端在 Windows 上用不到，但**仍随 crate 编译**：
// 它的逻辑（表达式拼装、排序、行形状）必须能在 CI 的 Windows 机上被单测覆盖。
// 声明为 `pub` 是为了不让“另一个平台的后端”变成 dead_code 警告。
pub mod locate;
pub mod query;
mod term;

// 两个后端都按需编译：everything 只在 Windows 可编译（Win32 FFI），
// locate 是纯 std（在 Windows 上也编译，让它的单测能跑）。
#[cfg(windows)]
mod everything;

#[cfg(windows)]
use everything as backend;
#[cfg(not(windows))]
use locate as backend;

/// 默认返回条数（迁移前 `find.py::DEFAULT_LIMIT`）
pub const DEFAULT_LIMIT: usize = 20;
/// `limit N` 的上限：再多面板也放不下
pub const MAX_LIMIT: usize = 100;
/// 最近打开目录的 settings 键（**与迁移前同名**，老数据直接可用）
const SIDE_KEY: &str = "recent_dirs";
/// 最近目录最多记 10 条
const RECENT_MAX: usize = 10;

const USAGE_HINTS: [&str; 5] = [
    "报告.md",
    "ext:rs clippy",
    "size:>500mb",
    "dm:today",
    "D:\\codes\\ 文件名",
];

pub struct FindPlugin {
    ctx: Mutex<Option<PluginContext>>,
    /// 索引后端：懒加载 + 失败记忆化（迁移前的 `_backend` / `_load_error`）
    backend: Mutex<Option<State>>,
}

enum State {
    Ready(backend::Backend),
    Failed(String),
}

impl Default for FindPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl FindPlugin {
    pub fn new() -> Self {
        Self {
            ctx: Mutex::new(None),
            backend: Mutex::new(None),
        }
    }

    fn ctx(&self) -> Result<PluginContext, PluginError> {
        self.ctx
            .lock()
            .map_err(|_| PluginError::internal("插件上下文锁不可用"))?
            .clone()
            .ok_or_else(|| PluginError::internal("插件尚未初始化"))
    }

    // ── 最近目录（settings 里的 JSON 数组，与迁移前同一键同一形状）────────────
    fn load_recent(&self) -> Vec<String> {
        let Ok(ctx) = self.ctx() else {
            return Vec::new();
        };
        ctx.settings
            .get(SIDE_KEY)
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .unwrap_or_default()
    }

    fn save_recent(&self, items: &[String]) {
        let Ok(ctx) = self.ctx() else {
            return;
        };
        let capped = &items[..items.len().min(RECENT_MAX)];
        if let Ok(text) = serde_json::to_string(capped) {
            let _ = ctx.settings.set(SIDE_KEY, &text);
        }
    }

    fn push_recent(&self, path: &str) {
        let mut items: Vec<String> = self
            .load_recent()
            .into_iter()
            .filter(|p| p != path)
            .collect();
        items.insert(0, path.to_string());
        self.save_recent(&items);
    }

    fn recent_panel(&self) -> Value {
        let recent = self.load_recent();
        if recent.is_empty() {
            return json!({
                "items": [{
                    "id": "find:recent:empty",
                    "title": "还没有最近目录",
                    "description": "打开搜索结果里的文件夹后会自动记在这里",
                    "badge": "空",
                    "icon": "🕘",
                    "metadata": {},
                }],
                "emptyText": "无最近目录",
            });
        }
        let items: Vec<Value> = recent
            .iter()
            .enumerate()
            .map(|(i, dir)| {
                let trimmed = dir.trim_end_matches(['\\', '/']);
                let name = trimmed
                    .rsplit(['\\', '/'])
                    .next()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(dir.as_str());
                json!({
                    "id": format!("find:recent:{i}"),
                    "title": name,
                    "description": dir,
                    "badge": "最近",
                    "icon": "🕘",
                    "metadata": { "path": dir, "isDir": true },
                })
            })
            .collect();
        json!({ "items": items, "emptyText": "无最近目录" })
    }

    /// 取索引后端；不可用时返回 `None`（调用方出引导面板，而不是报错）
    fn with_backend(&self) -> Result<Result<(), String>, PluginError> {
        let mut slot = self
            .backend
            .lock()
            .map_err(|_| PluginError::internal("索引后端锁不可用"))?;
        if slot.is_none() {
            *slot = Some(match backend::Backend::load() {
                Ok(b) => State::Ready(b),
                Err(e) => State::Failed(e),
            });
        }
        Ok(match slot.as_ref().expect("上一行已填充") {
            State::Ready(_) => Ok(()),
            State::Failed(e) => Err(e.clone()),
        })
    }

    // ── search ────────────────────────────────────────────────────────────
    fn search(&self, params: &Value) -> Result<Value, PluginError> {
        let keyword = str_field(params, "keyword").trim().to_string();
        let sub = str_field(params, "subcommand").trim().to_lowercase();
        let args = str_list(params, "args");

        if keyword.is_empty() && sub.is_empty() {
            return Ok(format::build_usage(&USAGE_HINTS, backend::usage_syntax()));
        }

        // 后端不可用 → 引导面板（不要留空白，用户会以为插件坏了）
        if self.with_backend()?.is_err() {
            return Ok(format::build_unavailable(
                &backend::unavailable_reason(),
                backend::unavailable_hint(),
            ));
        }

        let guard = self
            .backend
            .lock()
            .map_err(|_| PluginError::internal("索引后端锁不可用"))?;
        let index = match guard.as_ref().expect("with_backend 已加载") {
            State::Ready(index) => index,
            State::Failed(_) => unreachable!("上面已判过"),
        };

        if !index.db_loaded() {
            return Ok(backend::db_loading_panel());
        }

        if sub == "recent" {
            return Ok(self.recent_panel());
        }

        let sort = term::resolve_sort(&keyword, &args);
        let limit = term::resolve_limit(&keyword, &args, DEFAULT_LIMIT);
        let term_text = term::parse_term(&keyword);

        let started = Instant::now();
        let (total, rows) = index
            .search(&term_text, limit, sort)
            .map_err(PluginError::internal)?;
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;

        let now = now_ms();
        let mut items: Vec<Value> = rows
            .iter()
            .enumerate()
            .map(|(i, row)| format::build_row(row, now, i + 1))
            .collect();
        items.push(format::build_footer(
            total,
            rows.len(),
            elapsed_ms,
            None,
            backend::source_label(),
        ));
        Ok(json!({
            "items": items,
            "emptyText": format!("没有匹配「{term_text}」的文件"),
        }))
    }

    // ── execute（Action 子命令）───────────────────────────────────────────
    fn execute(&self, params: &Value) -> Result<Value, PluginError> {
        let sub = str_field(params, "subcommand").trim().to_lowercase();
        let args = str_list(params, "args");
        match sub.as_str() {
            "recent" => Ok(json!({ "success": true, "message": "下方列出最近打开的目录" })),
            "where" => match self.with_backend()? {
                Err(e) => Ok(json!({
                    "success": false,
                    "message": format!("{} 不可用：{}", backend::label(), e),
                })),
                Ok(()) => {
                    let guard = self
                        .backend
                        .lock()
                        .map_err(|_| PluginError::internal("索引后端锁不可用"))?;
                    let version = match guard.as_ref() {
                        Some(State::Ready(index)) => index.version(),
                        _ => "unknown".to_string(),
                    };
                    Ok(json!({
                        "success": true,
                        "message": format!("后端 {version} 索引已就绪"),
                    }))
                }
            },
            "open" | "dir" => {
                let Some(target) = args.first() else {
                    return Ok(json!({
                        "success": false,
                        "message": format!("用法：/find {sub} <路径>"),
                    }));
                };
                let ctx = self.ctx()?;
                let process = ctx
                    .process
                    .as_ref()
                    .ok_or_else(|| PluginError::permission_denied("process"))?;
                process
                    .launch(target)
                    .map_err(|e| PluginError::internal(format!("打开失败: {e}")))?;
                Ok(json!({ "success": true, "message": format!("已打开 {target}") }))
            }
            _ => Ok(json!({
                "success": false,
                "message": "支持：recent（最近目录）/ open <路径> / dir <路径> / where（诊断）",
            })),
        }
    }

    // ── select（回车执行）──────────────────────────────────────────────────
    fn select(&self, params: &Value) -> Result<Value, PluginError> {
        let md = params.get("metadata").cloned().unwrap_or(Value::Null);
        let path = md.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            // 统计条 / 用法项不是可执行项 —— 必须给反馈，不能是按了没反应的死条目
            let is_footer = md.get("footer").and_then(|v| v.as_bool()).unwrap_or(false);
            return Ok(json!({
                "toast": if is_footer { "统计信息" } else { "请输入关键词后选择结果" },
            }));
        }

        let is_dir = md.get("isDir").and_then(|v| v.as_bool()).unwrap_or(false);
        let name = md.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let action_id = params
            .get("actionId")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let ctx = self.ctx()?;
        let process = ctx
            .process
            .as_ref()
            .ok_or_else(|| PluginError::permission_denied("process"))?;

        if action_id == "copy-path" {
            return Ok(json!({ "copy": path, "toast": "路径已复制" }));
        }
        if action_id == "reveal" {
            process
                .reveal(path)
                .map_err(|e| PluginError::internal(format!("定位失败: {e}")))?;
            return Ok(json!({ "close": true, "toast": "已在文件夹中定位" }));
        }

        if is_dir {
            self.push_recent(path);
        }
        // 文件与目录都走宿主 launch：文件是「用默认程序打开」，目录是「资源管理器打开」
        process
            .launch(path)
            .map_err(|e| PluginError::internal(format!("打开失败: {e}")))?;

        let shown = if name.is_empty() { path } else { name };
        Ok(json!({
            "close": true,
            "toast": format!("已{}：{}", if is_dir { "打开目录" } else { "打开文件" }, shown),
            "copy": path,
        }))
    }
}

impl PluginBackend for FindPlugin {
    fn manifest(&self) -> PluginManifest {
        serde_json::from_str(include_str!("../../manifest.json"))
            .expect("find manifest.json 解析失败")
    }

    fn init(&self, ctx: PluginContext) -> Result<(), PluginError> {
        let mut slot = self
            .ctx
            .lock()
            .map_err(|_| PluginError::internal("插件上下文锁不可用"))?;
        *slot = Some(ctx);
        Ok(())
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, PluginError> {
        match method {
            "search" => self.search(&params),
            "execute" => self.execute(&params),
            "select" => self.select(&params),
            other => Err(PluginError::unknown_method(other)),
        }
    }
}

fn str_field(params: &Value, key: &str) -> String {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn str_list(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(String::from)
                        .unwrap_or_else(|| v.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn string_fields_tolerate_missing_and_null() {
        let p = json!({ "keyword": null, "args": ["a", 1, true] });
        assert_eq!(str_field(&p, "keyword"), "");
        assert_eq!(str_field(&p, "nope"), "");
        assert_eq!(str_list(&p, "args"), vec!["a", "1", "true"]);
        assert!(str_list(&json!({}), "args").is_empty());
    }

    #[test]
    fn footer_item_is_not_a_dead_entry() {
        let plugin = FindPlugin::new();
        let res = plugin
            .select(&json!({ "metadata": { "footer": true, "total": 7 } }))
            .expect("统计条不该报错");
        assert_eq!(res["toast"], "统计信息");
    }

    #[test]
    fn unknown_method_is_reported() {
        let plugin = FindPlugin::new();
        assert!(plugin.call("nope", Value::Null).is_err());
    }

    #[test]
    fn empty_input_gets_usage_panel() {
        let plugin = FindPlugin::new();
        let res = plugin
            .call("search", json!({ "keyword": null }))
            .expect("用法面板");
        assert_eq!(res["emptyText"], "输入关键词");
        assert_eq!(res["items"].as_array().unwrap().len(), 6); // 1 + 5 个示例
    }
}
