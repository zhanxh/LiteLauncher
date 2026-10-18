//! Unix 索引后端：plocate → fd → find（迁移前 `locate.py` 的 Rust 版）。
//!
//! **本文件在所有平台编译**（只用 std + 上文 query 模块），所以在 Windows 上
//! 也能跑它的全部单测——这是我能在没有 Linux 机器的情况下给到的最强验证。
//! 真正只在 Linux 生效的，是 `lib.rs` 里选哪个后端。
//!
//! 为什么不用 fzf：fzf 是终端 TUI 模糊过滤器，要抢终端自己画界面；而且它不提供
//! 候选来源与元数据。真正对标 Everything 的是 plocate 这类 trigram 倒排索引。
//!
//! 分层（越靠前越快）：
//!   1. plocate —— 2700 万文件 0.008s；但库里**只有路径**，体积/时间必须靠 stat 补，
//!      所以只对截断后的前 N 条 stat；
//!   2. fd       —— 并行遍历 + 实时 stat，原生支持 --size / --changed-within；
//!   3. find     —— 全量遍历兜底，慢但哪都有。

use crate::format::Row;
use crate::query::{self, Query};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 全量遍历时的兜底上限，避免把机器拖死
const WALK_HARD_CAP: usize = 20_000;

pub fn label() -> &'static str {
    "plocate"
}

pub fn unavailable_reason() -> String {
    format!("未检测到可用的文件索引（{}）", label())
}

pub fn unavailable_hint() -> &'static str {
    "本插件依赖 plocate 全盘索引（查询毫秒级）。安装并建库：\n\
     Debian/Ubuntu: sudo apt install plocate && sudo updatedb\n\
     Fedora/RHEL:   sudo dnf install plocate && sudo updatedb\n\
     没有索引时会降级为 fd / find 遍历——只搜用户目录、每查一次全扫一遍。"
}

pub fn db_loading_panel() -> Value {
    crate::format::build_unavailable(
        "文件索引库尚未生成",
        "请执行 sudo updatedb 生成索引（首次建库可能需要几分钟）。未建库时插件会自动降级为 fd / find 遍历。",
    )
}

pub fn source_label() -> &'static str {
    "plocate 索引 / 遍历"
}

pub fn usage_syntax() -> &'static str {
    "支持 ext: / size: / dm: / name: / path: / type: 语法"
}

// ── 排序 code 解码（数值与 everything.rs 共用 term::SORT_ALIASES）──
pub fn decode_sort(sort: Option<u32>) -> (Option<&'static str>, bool) {
    let Some(code) = sort else {
        return (None, false);
    };
    let desc = code & crate::term::SORT_DESC_FLAG != 0;
    let low = code & 0xFFFF;
    let field = crate::term::SORT_ALIASES
        .iter()
        .find(|(_, c)| *c == low)
        .map(|(name, _)| *name);
    (field, desc)
}

/// 给 fd 的 `--size` 用的人类写法（`1k` / `1.5g`）；4 位有效数字，去掉尾零
pub fn fd_size_str(num_bytes: i64) -> Option<String> {
    if num_bytes <= 0 {
        return None;
    }
    let mut v = num_bytes as f64;
    for (unit, base) in [
        ("t", 1024f64.powi(4)),
        ("g", 1024f64.powi(3)),
        ("m", 1024f64.powi(2)),
        ("k", 1024f64),
        ("b", 1f64),
    ] {
        if v >= base {
            v /= base;
            return Some(format!("{}{unit}", sig4(v)));
        }
    }
    None
}

/// 4 位有效数字（Rust 没有 `{:.4g}`，这里按数量级选小数位）
fn sig4(v: f64) -> String {
    let decimals = if v < 10.0 {
        3
    } else if v < 100.0 {
        2
    } else {
        1
    };
    let text = format!("{v:.decimals$}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn timeout_for(name: &str) -> Duration {
    Duration::from_secs(match name {
        "plocate" => 5,
        "fd" => 20,
        _ => 25,
    })
}

// ── 后端 ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Backend {
    /// (`plocate`/`mlocate`/`locate`, fd, find 里实际可用的那个)
    name: &'static str,
    bin: PathBuf,
    roots: Vec<PathBuf>,
}

/// 上游 README 里 `/find` 只在 Windows 标了"可用"，Unix 走这条链
pub fn detect() -> Result<Backend, String> {
    let mut errors = Vec::new();
    for (name, probes) in [
        ("plocate", &["plocate", "mlocate", "locate"][..]),
        ("fd", &["fd", "fdfind"][..]),
        ("find", &["find"][..]),
    ] {
        for candidate in probes {
            let Some(bin) = which(candidate) else { continue };
            if name == "plocate" && !probe_plocate(&bin) {
                errors.push(format!("{candidate} 不认 plocate 参数（可能是 GNU locate）"));
                continue;
            }
            return Ok(Backend { name, bin, roots: Vec::new() });
        }
        errors.push(format!("未找到 {name}"));
    }
    Err(errors.join("；"))
}

impl Backend {
    pub fn load() -> Result<Self, String> {
        detect()
    }

    /// 索引库由 updatedb 维护，插件侧没有"未就绪"的概念
    pub fn db_loaded(&self) -> bool {
        true
    }

    pub fn version(&self) -> String {
        let out = Command::new(&self.bin)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::piped())
            .stdout(Stdio::piped())
            .output();
        let line = out
            .ok()
            .map(|o| {
                let text = if o.stdout.is_empty() { o.stderr } else { o.stdout };
                String::from_utf8_lossy(&text)
                    .lines()
                    .next()
                    .unwrap_or("unknown")
                    .chars()
                    .take(32)
                    .collect::<String>()
            })
            .unwrap_or_else(|| "unknown".into());
        // `plocate --version` 的第一行已经是 "plocate 0.16.1"，别拼成 "plocate plocate 0.16.1"
        if line.to_lowercase().starts_with(self.name) {
            line
        } else {
            format!("{} {line}", self.name)
        }
    }

    pub fn search(&self, term: &str, max_results: usize, sort: Option<u32>) -> Result<(u64, Vec<Row>), String> {
        let q = query::parse(term);
        let (field, desc) = decode_sort(sort);
        let limit = max_results.max(1);

        // 按元数据排序时必须先 stat 完才知道谁在前，所以窗口放大
        let need_all = matches!(field, Some("size" | "dm" | "dc" | "da"));
        let window = WALK_HARD_CAP.min(limit * if need_all { 8 } else { 3 });

        let paths = self.candidates(&q, window);
        let mut rows = Vec::new();
        let mut truncated = false;
        for path in paths {
            // lexists 语义：断链的符号链接也算存在（它的名字仍值得被搜到）
            if std::fs::symlink_metadata(&path).is_err() {
                continue;
            }
            let Ok(md) = std::fs::metadata(&path) else { continue };
            let st = stat_of(&md);
            let name = basename(&path).to_string();
            if !q.match_path(&path, &name) || !q.match_stat(&st) {
                continue;
            }
            rows.push(make_row(&path, &st));
            if rows.len() >= window {
                truncated = true;
                break;
            }
        }

        // 相关性排序（用户没写 desc/asc 时）
        if field.is_none() && !q.literals.is_empty() {
            rows.sort_by(|a, b| {
                let ra = query::relevance(&a.path, &a.name, &q.literals);
                let rb = query::relevance(&b.path, &b.name, &q.literals);
                rb.partial_cmp(&ra).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        if let Some(field) = field {
            sort_rows(&mut rows, field, desc);
        }

        let total = if truncated {
            rows.len().max(window) as u64
        } else {
            rows.len() as u64
        };
        Ok((total, rows))
    }

    /// 索引与遍历**叠加**：plocate 库由 updatedb 定时刷新，新建/刚改名的文件
    /// 还不在库里——索引没命中仍要跑一遍遍历，否则用户刚保存的文件就是搜不到。
    fn candidates(&self, q: &Query, cap: usize) -> Vec<String> {
        let mut merged: Vec<String> = Vec::new();
        if self.name == "plocate" {
            if let Some(argv) = plocate_argv(&self.bin, q, cap) {
                let (_, lines) = run_capture(&argv, timeout_for("plocate"), cap);
                merged = lines;
            }
        }

        let mut seen: std::collections::HashSet<String> = merged.iter().cloned().collect();
        for (name, probes) in [("fd", &["fd", "fdfind"][..]), ("find", &["find"][..])] {
            let Some(bin) = probes.iter().find_map(|p| which(p)) else { continue };
            let argv = if name == "fd" {
                fd_argv(&bin, q, cap, &self.roots)
            } else {
                find_argv(&bin, q, &self.roots)
            };
            let (_, lines) = run_capture(&argv, timeout_for(name), cap);
            if lines.is_empty() {
                continue;
            }
            for line in lines {
                if seen.insert(line.clone()) {
                    merged.push(line);
                }
            }
            if merged.len() >= cap || !merged.is_empty() {
                break;
            }
        }
        merged.truncate(cap);
        merged
    }
}

fn sort_rows(rows: &mut [Row], field: &str, desc: bool) {
    let cmp_key = |a: &Row, b: &Row| -> std::cmp::Ordering {
        match field {
            "name" => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            "path" => a.path.to_lowercase().cmp(&b.path.to_lowercase()),
            "ext" => query::extension_of(&a.name).cmp(&query::extension_of(&b.name)),
            "type" => (!a.is_dir, a.name.to_lowercase()).cmp(&(!b.is_dir, b.name.to_lowercase())),
            "size" => (a.is_dir, a.size).cmp(&(b.is_dir, b.size)),
            // dc/da 在索引里拿不到，统一退回 mtime（与迁移前一致）
            _ => (a.is_dir, a.mtime_ms).cmp(&(b.is_dir, b.mtime_ms)),
        }
    };
    rows.sort_by(|a, b| if desc { cmp_key(b, a) } else { cmp_key(a, b) });
}

// ── 命令行拼装（纯函数：单测在这里钉死，脏活交给 run_capture）──────────────

/// plocate 多模式是 AND，mlocate 是 OR；显式 `--all` 统一成 AND。
/// 没有可下推的路径词（只剩 ext:/size:）时返回 None，交给遍历。
pub fn plocate_argv(bin: &Path, q: &Query, cap: usize) -> Option<Vec<String>> {
    let pats = q.locate_patterns();
    if pats.is_empty() {
        return None;
    }
    let mut argv = vec![
        bin.display().to_string(),
        "-i".into(),
        "-l".into(),
        cap.max(1).to_string(),
    ];
    if pats.len() > 1 {
        argv.push("--all".into());
    }
    argv.extend(pats);
    Some(argv)
}

pub fn fd_argv(bin: &Path, q: &Query, cap: usize, roots: &[PathBuf]) -> Vec<String> {
    let mut argv = vec![bin.display().to_string()];
    match q.want_type {
        Some(query::WantType::Dir) => argv.extend(["--type", "d"].map(String::from)),
        Some(query::WantType::File) => argv.extend(["--type", "f"].map(String::from)),
        None => argv.extend(["--type", "f", "--type", "d"].map(String::from)),
    }
    argv.extend(["--absolute-path", "--max-results", &cap.to_string()].map(String::from));
    argv.extend(["--hidden", "--follow"].map(String::from));

    // **不把路径词推给 fd**：fd 的 pattern 是正则，而 Everything 语义是子串匹配，
    // 搜 "a.b" 会被当正则、搜 "a b" 会被当两个 pattern。宁可多列候选交给过滤层。
    for ext in &q.exts {
        argv.push("--extension".into());
        argv.push(ext.clone());
    }
    // 区间体积 fd 表达不了，只在 min==max 时下推
    if q.size_min.is_some() && q.size_min == q.size_max {
        if let Some(size) = fd_size_str(q.size_min.unwrap_or(0)) {
            argv.push("--size".into());
            argv.push(size);
        }
    }
    if let Some((Some(lo), _)) = q.time_bounds.get("dm") {
        let secs = (query::unix_now() - lo).max(1);
        argv.push("--changed-within".into());
        argv.push(format!("{secs}s"));
    }

    if roots.is_empty() {
        argv.push(home_dir());
    } else {
        argv.extend(roots.iter().map(|r| r.display().to_string()));
    }
    argv
}

/// ⚠️ find 的表达式**不支持嵌套括号**：`( -type f ( -name x ) )` 会报
/// "invalid expression"。所以「文件 且 扩展名」必须展平成单层 `-o` 链。
pub fn find_argv(bin: &Path, q: &Query, roots: &[PathBuf]) -> Vec<String> {
    let root = roots
        .first()
        .map(|p| p.display().to_string())
        .unwrap_or_else(home_dir);
    let mut argv = vec![bin.display().to_string(), root];

    if !q.exts.is_empty() {
        argv.push("(".into());
        for (i, ext) in q.exts.iter().enumerate() {
            if i > 0 {
                argv.push("-o".into());
            }
            argv.extend(["-type".into(), "f".into(), "-a".into(), "-name".into(), format!("*.{ext}")]);
        }
        argv.push(")".into());
        argv.push("-print".into());
    } else {
        match q.want_type {
            Some(query::WantType::Dir) => argv.extend(["-type", "d", "-print"].map(String::from)),
            Some(query::WantType::File) => argv.extend(["-type", "f", "-print"].map(String::from)),
            None => argv.extend(
                ["(", "-type", "f", "-o", "-type", "d", ")", "-print"].map(String::from),
            ),
        }
    }
    argv
}

// ── 进程与文件系统 ────────────────────────────────────────────────────

fn which(bin: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(bin))
        .find(|p| p.is_file())
}

/// 真实探测：GNU findutils / MSYS 的 `locate` 也认 `locate` 这个名字，
/// 但它不认 `-i / -l / --all`，实测会静默返回空——必须用 plocate 专属参数试一次。
fn probe_plocate(bin: &Path) -> bool {
    let argv = vec![
        bin.display().to_string(),
        "-i".into(),
        "-l".into(),
        "1".into(),
        "--all".into(),
        "lite-launcher-probe-xyz9q".into(),
    ];
    let (status, _) = run_capture(&argv, Duration::from_secs(5), 1);
    // 0=有结果 1=无结果，两者都说明参数被支持、库可读
    matches!(status, Some(0) | Some(1))
}

/// 起进程、边收输出边等；超时就杀掉，**已吐出的行仍然有效**（大目录遍历的常态）。
fn run_capture(argv: &[String], timeout: Duration, cap: usize) -> (Option<i32>, Vec<String>) {
    let Some((program, args)) = argv.split_first() else {
        return (None, Vec::new());
    };
    let mut child = match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return (None, Vec::new()),
    };
    let Some(stdout) = child.stdout.take() else {
        return (None, Vec::new());
    };
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let mut out = std::io::BufReader::new(stdout);
        let _ = out.read_to_string(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    let mut status = None;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                status = st.code();
                break;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => break,
        }
    }
    let text = reader.join().unwrap_or_default();
    let lines = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .take(cap)
        .map(str::to_string)
        .collect();
    (status, lines)
}

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

fn stat_of(md: &std::fs::Metadata) -> query::StatInfo {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        query::StatInfo {
            is_dir: md.is_dir(),
            size: md.len() as i64,
            mtime: md.mtime(),
            ctime: md.ctime(),
            atime: md.atime(),
        }
    }
    #[cfg(not(unix))]
    {
        // Windows 上只为让本模块能编译 + 单测跑起来（生产路径走 everything.rs）
        let secs = |t: std::io::Result<std::time::SystemTime>| {
            t.ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        };
        query::StatInfo {
            is_dir: md.is_dir(),
            size: md.len() as i64,
            mtime: secs(md.modified()),
            ctime: secs(md.created()),
            atime: secs(md.accessed()),
        }
    }
}

fn basename(path: &str) -> &str {
    match path.trim_end_matches('/').rfind('/') {
        Some(i) => &path[i + 1..],
        None => path.trim_end_matches('/'),
    }
}

fn dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => trimmed[..i].to_string(),
        None => "/".to_string(),
    }
}

fn make_row(path: &str, st: &query::StatInfo) -> Row {
    let name = basename(path).to_string();
    Row {
        path: path.to_string(),
        hidden: name.starts_with('.'),
        name,
        parent: dirname(path),
        is_dir: st.is_dir,
        size: if st.is_dir { 0 } else { st.size },
        mtime_ms: st.mtime * 1000,
        system: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::term::SORT_ALIASES;

    fn bin() -> PathBuf {
        PathBuf::from("/usr/bin/plocate")
    }

    #[test]
    fn sort_codes_roundtrip_with_term_aliases() {
        for (alias, code) in SORT_ALIASES {
            let (field, desc) = decode_sort(Some(code));
            assert_eq!(field, Some(alias), "{alias} 的 sort code 对不上");
            assert!(!desc);
        }
        let (field, desc) = decode_sort(Some(3 | crate::term::SORT_DESC_FLAG));
        assert_eq!(field, Some("size"));
        assert!(desc);
        assert_eq!(decode_sort(None), (None, false));
        // 未知 code 不该被当成某个字段
        assert_eq!(decode_sort(Some(99)).0, None);
    }

    #[test]
    fn fd_size_string() {
        assert_eq!(fd_size_str(1024).as_deref(), Some("1k"));
        assert_eq!(fd_size_str(1024 * 1024 * 1024).as_deref(), Some("1g"));
        assert_eq!(fd_size_str(0), None);
    }

    #[test]
    fn plocate_argv_is_and_only_for_multiple_patterns() {
        let q = query::parse("alpha beta");
        let argv = plocate_argv(&bin(), &q, 20).expect("有路径词");
        assert_eq!(&argv[1..5], &["-i", "-l", "20", "--all"]);
        assert_eq!(&argv[5..], &["alpha", "beta"]);

        // 只有一个模式时不带 --all
        let single = plocate_argv(&bin(), &query::parse("alpha"), 5).unwrap();
        assert!(!single.iter().any(|a| a == "--all"));
        assert_eq!(single[3], "5");
    }

    #[test]
    fn plocate_argv_none_when_only_basename_filters() {
        // 只剩 ext: / size: 时索引帮不上忙，交给遍历
        assert!(plocate_argv(&bin(), &query::parse("ext:rs size:>1mb"), 20).is_none());
    }

    #[test]
    fn fd_argv_pushes_only_unambiguous_filters() {
        let q = query::parse("ext:rs size:>1mb type:dir");
        let argv = fd_argv(&PathBuf::from("/usr/bin/fd"), &q, 10, &[]);
        assert!(argv.contains(&"--type".to_string()));
        assert!(argv.contains(&"d".to_string()));
        assert!(argv.contains(&"--extension".to_string()));
        assert!(argv.contains(&"rs".to_string()));
        // 区间体积不下推
        assert!(!argv.contains(&"--size".to_string()));
        // 路径词一律不下推（fd 的 pattern 是正则，语义不同）
        assert!(!argv.iter().any(|a| a == "alpha"));
        // 没有 roots 时退回 HOME
        assert_eq!(argv.last().unwrap(), &home_dir());
    }

    #[test]
    fn fd_argv_pushes_exact_size_and_recent_mtime() {
        let q = query::parse("size:1mb dm:7d");
        let argv = fd_argv(&PathBuf::from("/usr/bin/fd"), &q, 10, &[]);
        assert!(argv.contains(&"--size".to_string()));
        assert!(argv.contains(&"--changed-within".to_string()));
        assert!(argv.iter().any(|a| a.ends_with('s')), "时间窗要带 s 后缀");
    }

    #[test]
    fn find_expression_flattens_extension_chain() {
        // find 不支持嵌套括号：多扩展名必须展平成 -o 链（多个值用逗号写）
        let q = query::parse("ext:rs,py");
        assert_eq!(q.exts, vec!["rs", "py"]);
        let argv = find_argv(&PathBuf::from("/usr/bin/find"), &q, &[PathBuf::from("/tmp")]);
        assert_eq!(argv[1], "/tmp");
        assert_eq!(argv[2], "(");
        assert_eq!(argv.iter().filter(|a| *a == "-o").count(), 1);
        assert!(argv.windows(2).any(|w| w[0] == "-name" && w[1] == "*.rs"));
        assert!(argv.windows(2).any(|w| w[0] == "-name" && w[1] == "*.py"));
        assert_eq!(argv.last().unwrap(), "-print");
        // 绝不能出现嵌套括号
        let opens = argv.iter().filter(|a| *a == "(").count();
        assert_eq!(opens, 1, "只允许一层括号");
    }

    #[test]
    fn find_expression_for_type_filters() {
        let dir = find_argv(&PathBuf::from("find"), &query::parse("type:dir"), &[]);
        assert!(dir.windows(2).any(|w| w[0] == "-type" && w[1] == "d"));
        let file = find_argv(&PathBuf::from("find"), &query::parse("type:file"), &[]);
        assert!(file.windows(2).any(|w| w[0] == "-type" && w[1] == "f"));
        let any = find_argv(&PathBuf::from("find"), &query::parse("alpha"), &[]);
        assert!(any.contains(&"-o".to_string()), "默认同时要文件和目录");
    }

    #[test]
    fn row_shape_matches_everything() {
        let st = query::StatInfo { is_dir: false, size: 42, mtime: 1_700_000_000, ..Default::default() };
        let row = make_row("/home/me/a.txt", &st);
        assert_eq!(row.name, "a.txt");
        assert_eq!(row.parent, "/home/me");
        assert_eq!(row.size, 42);
        assert_eq!(row.mtime_ms, 1_700_000_000_000);
        assert!(!row.hidden);
        assert!(!row.system);
    }

    #[test]
    fn row_detects_hidden_and_dir() {
        let st = query::StatInfo { is_dir: true, ..Default::default() };
        let row = make_row("/a/.secret", &st);
        assert!(row.hidden);
        assert!(row.is_dir);
        assert_eq!(row.size, 0, "目录不报体积");
        assert_eq!(row.parent, "/a");
        // 根目录下的文件
        assert_eq!(make_row("/x", &query::StatInfo::default()).parent, "/");
    }
}
