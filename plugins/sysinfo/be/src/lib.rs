//! `/sysinfo` 系统信息后端（M6：从 llp/Python 迁入 native 动态库）。
//!
//! 迁移前是 `sysinfo.py`（412 行：ctypes 声明 + `/proc` 文本解析 + 子进程探测）。
//! 现在同一份信息在宿主进程内直采：Toolhelp32 拿进程树、`GlobalMemoryStatusEx`
//! 拿内存、`GetDiskFreeSpaceExW` 拿磁盘、`K32GetProcessMemoryInfo` 拿工作集。
//!
//! 条目 id / 文案 / 徽标与迁移前逐项对齐，唯一的**有意变化**是最后那条
//! 「sidecar 运行时: Python x.y」——native 形态下它已失去意义，改为如实报告插件形态。

mod model;

// Unix 采集层（读 /proc）与 Windows 采集层（Win32）分平台选用；
// procfs 是纯 std 的，在 Windows 上也编译，好让它的解析单测能跑。
pub mod procfs;
#[cfg(windows)]
mod win;

#[cfg(windows)]
use win as sys;
#[cfg(not(windows))]
use procfs as sys;

use ll_plugin_api::{PluginBackend, PluginContext, PluginError, PluginManifest};
use model::{group_children, Proc, Snapshot};
use serde_json::{json, Value};
use std::sync::Mutex;

/// 面板里最多列几个子进程分组（再多会把系统条目挤下去）
const MAX_CHILD_GROUPS: usize = 6;

pub struct SysinfoPlugin {
    ctx: Mutex<Option<PluginContext>>,
}

impl Default for SysinfoPlugin {
    fn default() -> Self {
        Self::new()
    }
}

/// 一条面板条目（`detail` 进系统通知）
struct Item {
    id: String,
    title: String,
    icon: &'static str,
    description: String,
    detail: String,
}

fn item(id: impl Into<String>, title: String, icon: &'static str, description: String, detail: String) -> Item {
    Item { id: id.into(), title, icon, description, detail }
}

impl Item {
    fn to_value(&self) -> Value {
        json!({
            "id": self.id,
            "title": self.title,
            "icon": self.icon,
            "description": self.description,
            "metadata": { "detail": self.detail },
        })
    }
}

// ── 数字格式化 ────────────────────────────────────────────────────────────

/// 时长：`1 天 1 小时 1 分钟`；不足一分钟回落到秒
pub fn fmt_secs(total: u64) -> String {
    let (d, rem) = (total / 86_400, total % 86_400);
    let (h, rem) = (rem / 3_600, rem % 3_600);
    let (m, s) = (rem / 60, rem % 60);
    let mut parts = Vec::new();
    if d > 0 {
        parts.push(format!("{d} 天"));
    }
    if h > 0 {
        parts.push(format!("{h} 小时"));
    }
    if m > 0 {
        parts.push(format!("{m} 分钟"));
    }
    if parts.is_empty() {
        return format!("{s} 秒");
    }
    parts.join(" ")
}

pub fn fmt_gb(bytes: u64) -> String {
    format!("{:.1}GB", bytes as f64 / 1024.0_f64.powi(3))
}

pub fn fmt_mb(kb: u64) -> String {
    format!("{:.1} MB", kb as f64 / 1024.0)
}

fn arch_label() -> &'static str {
    #[cfg(windows)]
    {
        // 与迁移前 platform.machine() 的写法一致（Python 在 Windows 上给 AMD64）
        match std::env::consts::ARCH {
            "x86_64" => "AMD64",
            other => other,
        }
    }
    #[cfg(not(windows))]
    {
        std::env::consts::ARCH
    }
}

fn kernel_icon() -> &'static str {
    if cfg!(windows) { "🪟" } else { "🐧" }
}

fn child_icon(key: &str) -> &'static str {
    let low = key.to_lowercase();
    if low.contains("python") {
        "🐍"
    } else if low.contains("webkit") || low.contains("webview") {
        "🌐"
    } else {
        "⚙️"
    }
}

// ── 条目组装 ──────────────────────────────────────────────────────────────

fn os_label() -> &'static str {
    match std::env::consts::OS {
        "linux" => "Linux",
        "macos" => "macOS",
        other => other,
    }
}

fn kernel_item(snap: &Snapshot) -> Item {
    let arch = arch_label();
    // Windows：RtlGetVersion 给的真实版本（build 号能区分 Win10/11）
    if let Some(v) = snap.os {
        return item(
            "kernel",
            format!("内核: {} {} ({arch})", v.product(), v.number()),
            kernel_icon(),
            format!("{} · build {} · {arch}", v.product(), v.build),
            format!("{} {} ({arch})", v.product(), v.number()),
        );
    }
    // Linux：uname 的 release 串（发行版差异在这个字段之后）
    if let Some(release) = snap.release.as_deref() {
        return item(
            "kernel",
            format!("内核: {} {release} ({arch})", os_label()),
            kernel_icon(),
            format!("{} · {arch}", os_label()),
            format!("{} {release} ({arch})", os_label()),
        );
    }
    item(
        "kernel",
        format!("内核: {} ({arch})", os_label()),
        kernel_icon(),
        format!("{} · {arch}", os_label()),
        format!("{} ({arch})", os_label()),
    )
}

fn uptime_source() -> &'static str {
    if cfg!(windows) { "来自 GetTickCount64" } else { "来自 /proc/uptime" }
}

fn mem_item(mem: (u64, u64, u64)) -> Item {
    let (total, used, avail) = mem;
    item(
        "mem",
        format!("内存: {} 总量 / {} 已用", fmt_gb(total), fmt_gb(used)),
        "🧠",
        format!("可用 {}", fmt_gb(avail)),
        format!("total={} used={} avail={}", fmt_gb(total), fmt_gb(used), fmt_gb(avail)),
    )
}

fn disk_label() -> &'static str {
    if cfg!(windows) {
        "系统盘 C:"
    } else {
        "根分区"
    }
}

fn disk_item(disk: (u64, u64, u64)) -> Item {
    let (used, total, free) = disk;
    let pct = used as f64 / total as f64 * 100.0;
    item(
        "disk",
        format!("{}: {} 已用 / {} 总量", disk_label(), fmt_gb(used), fmt_gb(total)),
        "💾",
        format!("剩余 {}（使用率 {pct:.0}%）", fmt_gb(free)),
        format!("used={} size={} avail={} {pct:.0}%", fmt_gb(used), fmt_gb(total), fmt_gb(free)),
    )
}

fn degraded_proc_item(reason: &str) -> Item {
    item(
        "proc-mem",
        format!("进程内存: {reason}"),
        "🫥",
        "主程序与子进程内存占用暂不可用".into(),
        reason.to_string(),
    )
}

/// 主程序 + 直接子进程的内存占用（迁移前 `_proc_memory_items` 的移植）
fn proc_items(snap: &Snapshot) -> Vec<Item> {
    let Some(main) = snap.procs.iter().find(|p| p.pid == snap.main_pid) else {
        return vec![degraded_proc_item("未在进程表中找到 LiteLauncher 主程序")];
    };
    let Some(main_rss) = main.rss_kb else {
        return vec![degraded_proc_item(&format!("无法读取主程序内存（pid {}）", main.pid))];
    };

    // 打不开的进程（权限/已退出）直接跳过——宁少一行，也不显示 0 MB
    let children: Vec<Proc> = snap
        .procs
        .iter()
        .filter(|p| p.ppid == snap.main_pid && p.pid != snap.main_pid && p.rss_kb.is_some())
        .cloned()
        .collect();
    let groups = group_children(&children);
    let child_total: u64 = groups.iter().map(|g| g.rss_kb).sum();
    let child_count: usize = groups.iter().map(|g| g.count).sum();

    let mut items = Vec::new();
    let mut child_items = Vec::new();
    for group in groups.iter().take(MAX_CHILD_GROUPS) {
        let multi = if group.count > 1 {
            format!(" ×{}", group.count)
        } else {
            String::new()
        };
        let pids = group.pids.iter().map(u32::to_string).collect::<Vec<_>>();
        child_items.push(item(
            format!("proc-child-{}", group.pids[0]),
            format!("子进程 {}{multi} · {}", group.key, fmt_mb(group.rss_kb)),
            child_icon(&group.key),
            format!("pid {}", pids.join("/")),
            format!("{}{multi}: {}（pid {}）", group.key, fmt_mb(group.rss_kb), pids.join(", ")),
        ));
    }

    let total = main_rss + child_total;
    // 摘要行挂在主程序条目与合计条目上（两处 detail 相同，点哪条都能看到全貌）
    let detail = [
        format!("主程序 {} (pid {}): {}", main.name, main.pid, fmt_mb(main_rss)),
        format!("子进程合计（{child_count} 个）: {}", fmt_mb(child_total)),
        format!("合计: {}", fmt_mb(total)),
    ]
    .join("\n");

    items.push(item(
        "proc-main",
        format!("主程序内存: {} · {} (pid {})", fmt_mb(main_rss), main.name, main.pid),
        "🚀",
        format!("子进程 {child_count} 个，共 {}（含 webview/插件 sidecar）", fmt_mb(child_total)),
        detail.clone(),
    ));
    items.extend(child_items);
    items.push(item(
        "proc-total",
        format!("进程内存合计: {}", fmt_mb(total)),
        "🧮",
        format!(
            "主程序 {} + 子进程 {}（{child_count} 个）",
            fmt_mb(main_rss),
            fmt_mb(child_total)
        ),
        detail,
    ));
    items
}

fn runtime_item() -> Item {
    item(
        "runtime",
        "插件形态: native 动态库（进程内）".into(),
        "⚡",
        "无 sidecar、无 Python 依赖；系统信息由 Win32 直接采集".into(),
        "native 动态库 · 进程内 · Toolhelp32 / GlobalMemoryStatusEx / K32GetProcessMemoryInfo".into(),
    )
}

/// 采集全部条目（顺序与迁移前一致：内核 → 开机时长 → 内存 → 进程内存 → 磁盘 → 运行时）
fn collect_items() -> Vec<Item> {
    let snap = sys::collect();
    let mut items = vec![kernel_item(&snap)];

    if snap.uptime_secs > 0 {
        let text = fmt_secs(snap.uptime_secs);
        items.push(item("uptime", format!("开机时长: {text}"), "⏱️", uptime_source().into(), text));
    }
    if let Some(mem) = snap.mem {
        items.push(mem_item(mem));
    }
    items.extend(proc_items(&snap));
    if let Some(disk) = snap.disk {
        items.push(disk_item(disk));
    }
    items.push(runtime_item());
    items
}

// ── 插件入口 ──────────────────────────────────────────────────────────────

impl SysinfoPlugin {
    pub fn new() -> Self {
        Self { ctx: Mutex::new(None) }
    }

    fn ctx(&self) -> Result<PluginContext, PluginError> {
        self.ctx
            .lock()
            .map_err(|_| PluginError::internal("插件上下文锁不可用"))?
            .clone()
            .ok_or_else(|| PluginError::internal("插件尚未初始化"))
    }

    fn search(&self, params: &Value) -> Result<Value, PluginError> {
        let keyword = params
            .get("keyword")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let items = collect_items();
        let filtered: Vec<Item> = if keyword.is_empty() {
            items
        } else {
            items
                .into_iter()
                .filter(|i| {
                    i.title.to_lowercase().contains(&keyword)
                        || i.description.to_lowercase().contains(&keyword)
                })
                .collect()
        };
        Ok(json!({
            "items": filtered.iter().map(Item::to_value).collect::<Vec<_>>(),
            "emptyText": "未匹配到系统信息条目",
        }))
    }

    fn execute(&self, params: &Value) -> Result<Value, PluginError> {
        let sub = params.get("subcommand").and_then(|v| v.as_str()).unwrap_or("");
        if sub != "open" {
            return Ok(json!({
                "success": false,
                "message": "支持的子命令：open（打开系统监视器）",
            }));
        }
        let target = monitor_target();
        let Some(target) = target else {
            return Ok(json!({
                "success": false,
                "message": format!("暂不支持在 {} 上打开系统监视器", std::env::consts::OS),
            }));
        };
        let ctx = self.ctx()?;
        let process = ctx
            .process
            .as_ref()
            .ok_or_else(|| PluginError::permission_denied("process"))?;
        process
            .launch(target)
            .map_err(|e| PluginError::internal(format!("打开系统监视器失败: {e}")))?;
        Ok(json!({ "success": true, "message": "已打开系统监视器" }))
    }

    fn select(&self, params: &Value) -> Result<Value, PluginError> {
        let detail = params
            .get("metadata")
            .and_then(|m| m.get("detail"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let ctx = self.ctx()?;
        let notify = ctx
            .notify
            .as_ref()
            .ok_or_else(|| PluginError::permission_denied("notifications"))?;
        notify
            .send("系统信息", if detail.is_empty() { "（无详情）" } else { detail })
            .map_err(|e| PluginError::internal(format!("发送通知失败: {e}")))?;
        Ok(json!({ "toast": "详情已发送至系统通知" }))
    }
}

fn monitor_target() -> Option<&'static str> {
    #[cfg(windows)]
    {
        Some("taskmgr.exe")
    }
    #[cfg(target_os = "linux")]
    {
        Some("gnome-system-monitor")
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        None
    }
}

impl PluginBackend for SysinfoPlugin {
    fn manifest(&self) -> PluginManifest {
        serde_json::from_str(include_str!("../../manifest.json"))
            .expect("sysinfo manifest.json 解析失败")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seconds_format_matches_python() {
        assert_eq!(fmt_secs(0), "0 秒");
        assert_eq!(fmt_secs(45), "45 秒");
        assert_eq!(fmt_secs(90), "1 分钟");
        assert_eq!(fmt_secs(3_661), "1 小时 1 分钟");
        assert_eq!(fmt_secs(90_061), "1 天 1 小时 1 分钟");
    }

    #[test]
    fn byte_formats_keep_one_decimal() {
        assert_eq!(fmt_gb(1024_u64.pow(3)), "1.0GB");
        assert_eq!(fmt_mb(2048), "2.0 MB");
    }

    #[test]
    fn items_have_stable_ids_and_order() {
        let items = collect_items();
        assert_eq!(items.first().expect("至少内核条目").id, "kernel");
        assert_eq!(items.last().expect("运行时条目收尾").id, "runtime");
        // 进程内存条目必有一席（成功是 proc-main，失败是带原因的 proc-mem）
        assert!(items.iter().any(|i| i.id == "proc-main" || i.id == "proc-mem"));
        // 每条都要有 detail：点回车是把 detail 推到系统通知
        assert!(items.iter().all(|i| !i.detail.is_empty()));
    }

    #[test]
    fn keyword_filters_title_and_description() {
        let plugin = SysinfoPlugin::new();
        let res = plugin
            .search(&json!({ "keyword": "内存" }))
            .expect("search 不应失败");
        let items = res["items"].as_array().expect("items 数组");
        assert!(!items.is_empty());
        assert!(items.iter().all(|i| {
            let title = i["title"].as_str().unwrap_or("").to_lowercase();
            let desc = i["description"].as_str().unwrap_or("").to_lowercase();
            title.contains("内存") || desc.contains("内存")
        }));
    }

    #[test]
    fn unknown_subcommand_is_explained() {
        let plugin = SysinfoPlugin::new();
        let res = plugin
            .execute(&json!({ "subcommand": "nope" }))
            .expect("execute 不应失败");
        assert_eq!(res["success"], false);
        assert!(res["message"].as_str().unwrap().contains("open"));
    }

    #[test]
    fn unknown_method_is_reported() {
        let plugin = SysinfoPlugin::new();
        assert!(plugin.call("nope", Value::Null).is_err());
    }
}
