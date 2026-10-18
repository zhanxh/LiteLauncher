//! Unix/macOS 采集层：读 `/proc` + `df`（迁移前是 `sysinfo.py` 里的 Python 版本）。
//!
//! **本文件在所有平台编译**（只用 std），所以在 Windows 上也能跑它的全部解析单测——
//! 这是没有 Linux 机器时能做的最强验证。真正只在 Linux 生效的是 `lib.rs` 里选哪个 `sys`。
//!
//! 为什么不用 `sysinfo` crate：插件只要"总量/可用/前几个子进程"这几个数，
//! 手读 `/proc` 是 60 行且字段语义完全可测；引 crate 反而把行为交给第三方版本。

use crate::model::{Proc, Snapshot};
use std::path::Path;

/// 采集入口（Linux / macOS 走这里）
pub fn collect() -> Snapshot {
    Snapshot {
        os: None,
        release: os_release(),
        uptime_secs: uptime_secs().unwrap_or(0),
        mem: mem_info(),
        procs: processes(),
        disk: disk_usage("/"),
        main_pid: std::process::id(),
    }
}

/// Windows 才有"补工作集"这一步（`/proc/<pid>/status` 自带 VmRSS）
pub fn fill_rss(_procs: &mut [Proc], _main_pid: u32) {}

fn read(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

pub fn os_release() -> Option<String> {
    read("/proc/sys/kernel/osrelease")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn uptime_secs() -> Option<u64> {
    parse_uptime(&read("/proc/uptime")?)
}

/// `/proc/uptime` 第一列是开机秒数（带小数）
pub fn parse_uptime(text: &str) -> Option<u64> {
    let first = text.split_whitespace().next()?;
    first.parse::<f64>().ok().map(|v| v.max(0.0) as u64)
}

fn mem_info() -> Option<(u64, u64, u64)> {
    parse_meminfo(&read("/proc/meminfo")?)
}

/// `/proc/meminfo`：字段单位都是 kB。`MemAvailable` 缺失（老内核）时退回 `MemFree`
pub fn parse_meminfo(text: &str) -> Option<(u64, u64, u64)> {
    let mut total_kb = 0u64;
    let mut avail_kb = 0u64;
    let mut free_kb = 0u64;
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let value = rest
            .split_whitespace()
            .next()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        match key.trim() {
            "MemTotal" => total_kb = value,
            "MemAvailable" => avail_kb = value,
            "MemFree" => free_kb = value,
            _ => {}
        }
    }
    if total_kb == 0 {
        return None;
    }
    if avail_kb == 0 {
        avail_kb = free_kb;
    }
    let total = total_kb * 1024;
    let avail = avail_kb * 1024;
    Some((total, total.saturating_sub(avail), avail))
}

fn processes() -> Vec<Proc> {
    processes_in(Path::new("/proc"))
}

/// 全量进程表：读不了的（权限/竞态消失）跳过，与迁移前一致
pub fn processes_in(root: &Path) -> Vec<Proc> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let dir = entry.path();
        let Ok(status) = std::fs::read_to_string(dir.join("status")) else {
            continue;
        };
        let Some((ppid, rss_kb, comm)) = parse_status(&status) else {
            continue;
        };
        let toks = read_cmdline(&dir.join("cmdline"));
        out.push(Proc {
            pid,
            ppid,
            name: proc_name(&toks, &comm),
            rss_kb: Some(rss_kb),
        });
    }
    out
}

/// `/proc/<pid>/status` 只取三列：Name / PPid / VmRSS
pub fn parse_status(text: &str) -> Option<(u32, u64, String)> {
    let mut comm = None;
    let mut ppid = None;
    let mut rss = None;
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let value = rest.trim();
        match key {
            "Name" => comm = Some(value.to_string()),
            "PPid" => ppid = value.parse::<u32>().ok(),
            "VmRSS" => rss = value.split_whitespace().next().and_then(|v| v.parse::<u64>().ok()),
            _ => {}
        }
    }
    Some((ppid?, rss.unwrap_or(0), comm?))
}

fn read_cmdline(path: &Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    bytes
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).to_string())
        .collect()
}

fn basename(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// 进程的展示名：优先 cmdline 的 argv0（`comm` 被内核截到 15 字符，
/// `WebKitWebProcess` 会变成 `WebKitWebProces`），python sidecar 再补脚本名。
///
/// 补脚本名不是装饰：迁移前 `/sysinfo` 就是靠 `python3 · sysinfo.py` 把不同插件的
/// sidecar 分开统计的，否则所有 Python 插件会并成一行。
pub fn proc_name(toks: &[String], comm: &str) -> String {
    let name = toks
        .first()
        .map(|argv0| basename(argv0).to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| comm.to_string());
    match (toks.last(), toks.first()) {
        (Some(last), Some(first))
            if toks.len() > 1 && first.to_lowercase().contains("python") =>
        {
            format!("{name} · {}", basename(last))
        }
        _ => name,
    }
}

fn disk_usage(mount: &str) -> Option<(u64, u64, u64)> {
    let out = std::process::Command::new("df")
        .args(["-kP", mount])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_df(&String::from_utf8_lossy(&out.stdout))
}

/// `df -kP` 第二行的 1024 块数：total / used / available
pub fn parse_df(text: &str) -> Option<(u64, u64, u64)> {
    let line = text.lines().nth(1)?;
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 4 {
        return None;
    }
    let total_kb: u64 = fields[1].parse().ok()?;
    let used_kb: u64 = fields[2].parse().ok()?;
    let free_kb: u64 = fields[3].parse().ok()?;
    if total_kb == 0 {
        return None;
    }
    Some((used_kb * 1024, total_kb * 1024, free_kb * 1024))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uptime_parses_first_column() {
        assert_eq!(parse_uptime("12345.67 89012.34\n"), Some(12_345));
        assert_eq!(parse_uptime(""), None);
        assert_eq!(parse_uptime("garbage"), None);
    }

    #[test]
    fn meminfo_uses_available_and_falls_back_to_free() {
        let text = "MemTotal:       32780524 kB\nMemFree:         1234567 kB\nMemAvailable:   21876543 kB\nBuffers:          123456 kB\n";
        let (total, used, avail) = parse_meminfo(text).expect("应解析成功");
        assert_eq!(total, 32_780_524 * 1024);
        assert_eq!(avail, 21_876_543 * 1024);
        assert_eq!(used, total - avail);

        // 老内核没有 MemAvailable → 退回 MemFree
        let old = "MemTotal:       1000 kB\nMemFree:         400 kB\n";
        let (total, used, avail) = parse_meminfo(old).unwrap();
        assert_eq!((total, avail, used), (1000 * 1024, 400 * 1024, 600 * 1024));

        assert_eq!(parse_meminfo("no fields here"), None);
    }

    #[test]
    fn status_reads_name_ppid_and_rss() {
        let text = "Name:\tpython3\nState:\tS (sleeping)\nPid:\t4242\nPPid:\t1000\nVmPeak:\t  200000 kB\nVmRSS:\t   12345 kB\nThreads:\t3\n";
        let (ppid, rss, comm) = parse_status(text).expect("应解析成功");
        assert_eq!(ppid, 1000);
        assert_eq!(rss, 12_345);
        assert_eq!(comm, "python3");
        // 缺 PPid 的条目（内核线程早期状态）视为不可用，跳过
        assert!(parse_status("Name:\tkthreadd\nVmRSS:\t0 kB\n").is_none());
    }

    #[test]
    fn proc_name_prefers_argv0_and_appends_python_script() {
        let python = vec![
            "/usr/bin/python3".to_string(),
            "/home/u/.local/share/LiteLauncher/extplugins/cost/cost.py".to_string(),
        ];
        assert_eq!(proc_name(&python, "python3"), "python3 · cost.py");

        // 非 python 不补脚本名
        let node = vec!["/usr/bin/node".to_string(), "/srv/app.js".to_string()];
        assert_eq!(proc_name(&node, "node"), "node");

        // cmdline 读不到（权限/僵尸进程）时退回 comm
        assert_eq!(proc_name(&[], "WebKitWebProces"), "WebKitWebProces");

        // 单个 token 的 python（-c 之类）不补脚本名
        let one = vec!["/usr/bin/python3".to_string()];
        assert_eq!(proc_name(&one, "python3"), "python3");
    }

    #[test]
    fn df_line_is_parsed_in_kilobytes() {
        let text = "Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/nvme0n1p2   479578112 201326592 253893376      45% /\n";
        let (used, total, free) = parse_df(text).expect("应解析成功");
        assert_eq!(total, 479_578_112 * 1024);
        assert_eq!(used, 201_326_592 * 1024);
        assert_eq!(free, 253_893_376 * 1024);
        assert_eq!(parse_df("only one line"), None);
    }

    #[test]
    fn missing_procfs_degrades_instead_of_panicking() {
        // Windows 上 /proc 不存在：必须优雅返回空表，不能 panic
        assert!(processes_in(Path::new("/definitely/not/here")).is_empty());
    }
}
