//! 采集结果的公共形状：平台层（win / unix）只负责填数据，条目组装在 lib.rs。

/// 一条进程记录（`rss_kb` 为 `None` 表示打不开：权限不足或已退出）
#[derive(Debug, Clone)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub rss_kb: Option<u64>,
}

/// 系统版本（Windows：build ≥ 22000 即 Windows 11）
#[derive(Debug, Clone, Copy)]
pub struct OsVersion {
    pub major: u32,
    pub minor: u32,
    pub build: u32,
}

impl OsVersion {
    pub fn product(&self) -> &'static str {
        if self.build >= 22_000 {
            "Windows 11"
        } else {
            "Windows 10"
        }
    }
    /// `10.0.22631`
    pub fn number(&self) -> String {
        format!("{}.{}.{}", self.major, self.minor, self.build)
    }
}

pub struct Snapshot {
    pub os: Option<OsVersion>,
    /// 内核版本串（Linux：`/proc/sys/kernel/osrelease`；Windows：不用这个字段）
    pub release: Option<String>,
    pub uptime_secs: u64,
    /// (total, used, avail) 字节
    pub mem: Option<(u64, u64, u64)>,
    pub procs: Vec<Proc>,
    /// (used, total, free) 字节
    pub disk: Option<(u64, u64, u64)>,
    /// 当前进程（native 插件与主程序同进程，这就是宿主）
    pub main_pid: u32,
}

/// 子进程按名称聚合后的分组（`pids` 升序，`rss_kb` 为组内求和）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub key: String,
    pub count: usize,
    pub rss_kb: u64,
    pub pids: Vec<u32>,
}

/// 按名称聚合：内存降序，便于一眼看到谁最占
pub fn group_children(children: &[Proc]) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    for child in children {
        match groups.iter_mut().find(|g| g.key == child.name) {
            Some(g) => {
                g.count += 1;
                g.rss_kb += child.rss_kb.unwrap_or(0);
                g.pids.push(child.pid);
            }
            None => groups.push(Group {
                key: child.name.clone(),
                count: 1,
                rss_kb: child.rss_kb.unwrap_or(0),
                pids: vec![child.pid],
            }),
        }
    }
    for g in &mut groups {
        g.pids.sort_unstable();
    }
    groups.sort_by(|a, b| b.rss_kb.cmp(&a.rss_kb));
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, name: &str, rss: Option<u64>) -> Proc {
        Proc { pid, ppid: 1, name: name.into(), rss_kb: rss }
    }

    #[test]
    fn groups_aggregate_by_name_and_sum_rss() {
        let children = vec![
            proc(10, "msedgewebview2.exe", Some(100)),
            proc(11, "msedgewebview2.exe", Some(50)),
            proc(12, "python.exe", Some(300)),
        ];
        let groups = group_children(&children);
        assert_eq!(groups.len(), 2);
        // 内存降序：python 单进程更占
        assert_eq!(groups[0].key, "python.exe");
        assert_eq!(groups[1].count, 2);
        assert_eq!(groups[1].rss_kb, 150);
        assert_eq!(groups[1].pids, vec![10, 11]);
    }

    #[test]
    fn missing_rss_counts_as_zero_but_keeps_the_process() {
        let groups = group_children(&[proc(7, "x.exe", None)]);
        assert_eq!(groups[0].count, 1);
        assert_eq!(groups[0].rss_kb, 0);
    }
}
