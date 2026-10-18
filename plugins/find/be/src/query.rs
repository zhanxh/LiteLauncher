//! 搜索表达式解析与本地过滤（迁移前 `query.py` 的 Rust 版）。
//!
//! Windows 上这套只被 `/find where` 之外的场景*间接*用到——Everything 自己认识
//! `ext:` / `size:`；**Linux 上没有 Everything**，表达式必须由插件自己解析、
//! 自己 stat 过滤，所以这里是 Unix 后端的地基，也是唯一被单测全覆盖的部分。
//!
//! 设计原则（与 Python 版一致）：**遇到不认识的 `key:value` 就当普通搜索词**，
//! 绝不静默丢弃用户输入——顺带解决了 `https://x` 这种带冒号的串。
//!
//! 只依赖 std + chrono：不碰文件系统、不 read /proc，所以 Windows 上也能跑全部单测。

use chrono::{Local, TimeZone};
use std::collections::BTreeMap;

/// 只有这些 key 会被当成字段，其余 `xxx:yyy` 一律降级为普通文本
pub const KNOWN_FIELDS: [&str; 8] = ["ext", "size", "dm", "dc", "da", "name", "path", "type"];

/// 时间字段 → StatInfo 上的属性
pub const TIME_FIELDS: [&str; 3] = ["dm", "dc", "da"];

const DAY: i64 = 86_400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WantType {
    Dir,
    File,
}

/// 一次查询的结构化结果：各"必须包含"列表之间是 AND，min/max 之间是闭区间
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query {
    /// 裸词：必须出现在完整路径中（Everything 默认语义）
    pub literals: Vec<String>,
    /// `name:xxx` → 只匹配 basename
    pub name_pats: Vec<String>,
    /// `path:xxx` → 只匹配完整路径
    pub path_pats: Vec<String>,
    /// `ext:rs,py`
    pub exts: Vec<String>,
    pub want_type: Option<WantType>,
    pub size_min: Option<i64>,
    pub size_max: Option<i64>,
    /// `{'dm': (min_ts, max_ts), ...}`，Unix 秒
    pub time_bounds: BTreeMap<String, (Option<i64>, Option<i64>)>,
}

/// stat 的跨平台投影（Windows 上也能构造，便于测试过滤逻辑）
#[derive(Debug, Clone, Copy, Default)]
pub struct StatInfo {
    pub is_dir: bool,
    pub size: i64,
    pub mtime: i64,
    pub ctime: i64,
    pub atime: i64,
}

impl Query {
    /// 是否必须 stat 才知道结果去留（决定候选要抓多宽）
    pub fn needs_stat_filter(&self) -> bool {
        self.size_min.is_some()
            || self.size_max.is_some()
            || !self.time_bounds.is_empty()
            || self.want_type.is_some()
            || !self.exts.is_empty()
    }

    pub fn is_empty(&self) -> bool {
        !self.needs_stat_filter()
            && self.literals.is_empty()
            && self.name_pats.is_empty()
            && self.path_pats.is_empty()
    }

    /// 给 plocate 用的路径子串列表（已按 POSIX ERE 转义）。
    ///
    /// plocate 默认对**完整路径**做正则匹配，所以这里只放"要在路径里找"的词；
    /// `name:` 与 `ext:` 属于 basename 维度，plocate 表达不了，留给 stat 后过滤。
    pub fn locate_patterns(&self) -> Vec<String> {
        self.literals
            .iter()
            .chain(self.path_pats.iter())
            .map(|p| escape_ere(p))
            .collect()
    }

    /// 路径/文件名维度的过滤（大小写不敏感）
    pub fn match_path(&self, path: &str, name: &str) -> bool {
        let low_path = path.to_lowercase();
        let low_name = name.to_lowercase();
        for p in &self.literals {
            if !low_path.contains(&p.to_lowercase()) {
                return false;
            }
        }
        for p in &self.path_pats {
            if !low_path.contains(&p.to_lowercase()) {
                return false;
            }
        }
        for p in &self.name_pats {
            if !low_name.contains(&p.to_lowercase()) {
                return false;
            }
        }
        if !self.exts.is_empty() && !self.exts.contains(&extension_of(name)) {
            return false;
        }
        true
    }

    /// 体积/类型/时间过滤。目录不参与体积过滤（目录 size 无意义）。
    pub fn match_stat(&self, st: &StatInfo) -> bool {
        if self.want_type == Some(WantType::Dir) && !st.is_dir {
            return false;
        }
        if self.want_type == Some(WantType::File) && st.is_dir {
            return false;
        }
        if !st.is_dir {
            if let Some(min) = self.size_min {
                if st.size < min {
                    return false;
                }
            }
            if let Some(max) = self.size_max {
                if st.size > max {
                    return false;
                }
            }
        }
        for (field, (lo, hi)) in &self.time_bounds {
            let ts = match field.as_str() {
                "dc" => st.ctime,
                "da" => st.atime,
                _ => st.mtime,
            };
            if let Some(lo) = lo {
                if ts < *lo {
                    return false;
                }
            }
            if let Some(hi) = hi {
                if ts > *hi {
                    return false;
                }
            }
        }
        true
    }
}

/// 扩展名：点开头的隐藏文件按"去掉点"处理（`.gitignore` → `gitignore`，
/// 与 Everything 一致；否则 `ext:ignore` 这类搜索会莫名命中/落空）
pub fn extension_of(name: &str) -> String {
    if let Some(rest) = name.strip_prefix('.') {
        return rest.to_lowercase();
    }
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// POSIX ERE 转义：只保留字面量语义，避免 `a.b` 把 `.` 当通配
fn escape_ere(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 4);
    for ch in text.chars() {
        if matches!(
            ch,
            '.' | '^' | '$' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\'
        ) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// `>500mb` / `<1kb` / `100` / `1mb..10mb` → (min, max)，字节。
pub fn parse_size(text: &str) -> Option<(Option<i64>, Option<i64>)> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if let Some((lo_s, hi_s)) = text.split_once("..") {
        let lo = parse_size(lo_s).and_then(|v| v.0);
        let hi = parse_size(hi_s).and_then(|v| v.1);
        return Some((lo, hi));
    }

    let (op, rest) = if let Some(r) = text.strip_prefix(">=") {
        (">=", r)
    } else if let Some(r) = text.strip_prefix("<=") {
        ("<=", r)
    } else if let Some(r) = text.strip_prefix('>') {
        (">", r)
    } else if let Some(r) = text.strip_prefix('<') {
        ("<", r)
    } else if let Some(r) = text.strip_prefix('=') {
        ("=", r)
    } else {
        ("=", text)
    };

    let rest = rest.trim_start();
    let num_end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(rest.len());
    let (num_s, unit_s) = rest.split_at(num_end);
    let num: f64 = num_s.parse().ok()?;
    let unit = unit_s.trim_start().to_lowercase();
    let mult: i64 = match unit.as_str() {
        "" | "b" => 1,
        "k" | "kb" | "kib" => 1024,
        "m" | "mb" | "mib" => 1024 * 1024,
        "g" | "gb" | "gib" => 1024 * 1024 * 1024,
        "t" | "tb" | "tib" => 1024_i64.pow(4),
        _ => return None,
    };
    // 与 Python `int(float(num) * unit)` 同口径：向零截断
    let val = (num * mult as f64) as i64;
    Some(match op {
        ">" => (Some(val + 1), None),
        ">=" => (Some(val), None),
        // `<` / `<=` 是上界（迁移前的实现把两者都吐成下界，语义是反的）
        "<" => (None, Some(val - 1)),
        "<=" => (None, Some(val)),
        _ => (Some(val), Some(val)),
    })
}

/// `today` / `7d` / `>2024-01-01` / `2024-01-01..2024-01-31` → (min, max) Unix 秒
pub fn parse_time(text: &str, now: i64) -> Option<(Option<i64>, Option<i64>)> {
    let text = text.trim().to_lowercase();
    if text.is_empty() {
        return None;
    }
    if text == "today" {
        return Some((Some(midnight_utc(now)), None));
    }
    if text == "yesterday" {
        let today = midnight_utc(now);
        return Some((Some(today - DAY), Some(today - 1)));
    }
    if text == "now" {
        return Some((Some(now - 2), None));
    }
    if let Some((span, unit)) = relative(&text) {
        let secs = span.checked_mul(unit)?;
        return Some((Some(now - secs), None));
    }
    if let Some((lo_s, hi_s)) = text.split_once("..") {
        let lo = if lo_s.trim().is_empty() {
            None
        } else {
            parse_time(lo_s, now).and_then(|v| v.0)
        };
        let hi = if hi_s.trim().is_empty() {
            None
        } else {
            parse_time(hi_s, now).and_then(|v| v.1)
        };
        return Some((lo, hi));
    }
    if let Some((y, m, d)) = iso_date(&text) {
        // 本地时区的当天零点（与迁移前 time.mktime 同口径）
        let base = Local
            .with_ymd_and_hms(y, m, d, 0, 0, 0)
            .single()?
            .timestamp();
        return Some((Some(base), Some(base + DAY - 1)));
    }
    // 比较运算：`>X` 取 X 的起点、`<X` 取 X 的起点再退一秒
    for op in [">=", ">", "<=", "<"] {
        if let Some(rest) = text.strip_prefix(op) {
            let (lo, _) = parse_time(rest, now)?;
            let start = lo?;
            return Some(match op {
                ">" => (Some(start + 1), None),
                ">=" => (Some(start), None),
                "<" => (None, Some(start - 1)),
                _ => (None, Some(start)),
            });
        }
    }
    None
}

fn midnight_utc(ts: i64) -> i64 {
    ts - ts.rem_euclid(DAY)
}

fn relative(text: &str) -> Option<(i64, i64)> {
    let (num, unit) = text.split_at(text.len().checked_sub(1)?);
    if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let span: i64 = num.parse().ok()?;
    let mult = match unit {
        "h" => 3_600,
        "d" => DAY,
        "w" => 604_800,
        "m" => 2_592_000,
        _ => return None,
    };
    Some((span, mult))
}

fn iso_date(text: &str) -> Option<(i32, u32, u32)> {
    let parts: Vec<&str> = text.split('-').collect();
    // 必须是 YYYY-M-D 三段，且年份恰好 4 位数字（否则交给别的分支/当成非法）
    if parts.len() != 3 || parts[0].len() != 4 {
        return None;
    }
    if !parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}

/// 把表达式拆成 Query。不认识的 `key:value` 整体降级为普通搜索词。
pub fn parse(term: &str) -> Query {
    let mut q = Query::default();
    for tok in term.split_whitespace() {
        let Some((key, val)) = tok.split_once(':') else {
            q.literals.push(tok.to_string());
            continue;
        };
        let low = key.to_lowercase();
        if val.is_empty() || !KNOWN_FIELDS.contains(&low.as_str()) {
            q.literals.push(tok.to_string());
            continue;
        }
        match low.as_str() {
            "ext" => {
                q.exts = val
                    .split(',')
                    .map(|e| e.trim().trim_start_matches('.').to_lowercase())
                    .filter(|e| !e.is_empty())
                    .collect();
            }
            "size" => match parse_size(val) {
                Some((min, max)) => {
                    if let Some(min) = min {
                        q.size_min = Some(q.size_min.map_or(min, |cur| cur.max(min)));
                    }
                    if let Some(max) = max {
                        q.size_max = Some(q.size_max.map_or(max, |cur| cur.min(max)));
                    }
                }
                None => q.literals.push(tok.to_string()),
            },
            "dm" | "dc" | "da" => match parse_time(val, unix_now()) {
                Some(bounds) => {
                    q.time_bounds.insert(low, bounds);
                }
                None => q.literals.push(tok.to_string()),
            },
            "name" => q.name_pats.push(val.to_string()),
            "path" => q.path_pats.push(val.to_string()),
            "type" => match val.to_lowercase().as_str() {
                "folder" | "dir" | "directory" => q.want_type = Some(WantType::Dir),
                "file" | "files" => q.want_type = Some(WantType::File),
                _ => q.literals.push(tok.to_string()),
            },
            _ => unreachable!("KNOWN_FIELDS 已收口"),
        }
    }
    q
}

/// 相关性打分：用于没有显式排序时的默认顺序。
///
/// 仿 Everything 的默认行为——文件名命中远重于路径命中，短路径重于长路径。
/// 分不开就返回 0（该候选会被过滤掉）。
pub fn relevance(path: &str, name: &str, literals: &[String]) -> f64 {
    if literals.is_empty() {
        return 1.0;
    }
    let low_path = path.to_lowercase();
    let low_name = name.to_lowercase();
    let mut total = 0.0;
    for raw in literals {
        let p = raw.to_lowercase();
        if p.is_empty() {
            continue;
        }
        let score = if low_name == p {
            100.0
        } else if low_name.starts_with(&p) {
            80.0
        } else if low_name.contains(&p) {
            55.0
        } else if low_path.contains(&p) {
            25.0
        } else {
            return 0.0;
        };
        total += score;
    }
    // 同分时短路径优先（少一层通常更接近用户意图）
    total / literals.len() as f64 - path.len().min(4000) as f64 / 40_000.0
}

pub fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_size（迁移前 TestParseSize）──────────────────────────────
    #[test]
    fn size_units() {
        assert_eq!(parse_size("1kb"), Some((Some(1024), Some(1024))));
        assert_eq!(parse_size("1mb"), Some((Some(1024 * 1024), Some(1024 * 1024))));
        assert_eq!(
            parse_size("2gb"),
            Some((Some(2 * 1024 * 1024 * 1024), Some(2 * 1024 * 1024 * 1024)))
        );
        assert_eq!(parse_size("100"), Some((Some(100), Some(100))));
    }

    #[test]
    fn size_comparison_is_exclusive() {
        // `>500mb` 必须严格大于——用 +1，否则等于边界的文件会被漏掉
        assert_eq!(parse_size(">500mb"), Some((Some(500 * 1024 * 1024 + 1), None)));
        assert_eq!(parse_size("<1kb"), Some((None, Some(1023))));
    }

    #[test]
    fn size_range() {
        assert_eq!(parse_size("1mb..10mb"), Some((Some(1024 * 1024), Some(10 * 1024 * 1024))));
    }

    #[test]
    fn size_invalid() {
        assert_eq!(parse_size("abc"), None);
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_size("1xyz"), None);
    }

    #[test]
    fn bad_size_degrades_to_literal() {
        let q = parse("size:abc");
        assert_eq!(q.size_min, None);
        assert_eq!(q.literals, vec!["size:abc"]);
    }

    // ── parse_time（迁移前 TestParseTime）──────────────────────────────
    const NOW: i64 = 1_700_000_000;

    #[test]
    fn today_is_midnight_based() {
        let (lo, hi) = parse_time("today", NOW).unwrap();
        assert_eq!(lo, Some(NOW - (NOW % DAY)));
        assert_eq!(hi, None);
    }

    #[test]
    fn yesterday_is_a_full_day() {
        let (lo, hi) = parse_time("yesterday", NOW).unwrap();
        assert_eq!(hi, Some(lo.unwrap() + DAY - 1));
    }

    #[test]
    fn relative_days() {
        let (lo, _) = parse_time("7d", NOW).unwrap();
        assert_eq!(lo, Some(NOW - 7 * DAY));
    }

    #[test]
    fn iso_date_is_whole_day() {
        let (lo, hi) = parse_time("2024-01-15", NOW).unwrap();
        assert_eq!(hi.unwrap() - lo.unwrap(), DAY - 1);
    }

    #[test]
    fn range_and_comparison_bounds() {
        let (lo, hi) = parse_time("2024-01-01..2024-01-31", NOW).unwrap();
        assert!(lo < hi);
        let (lo2, hi2) = parse_time(">2024-01-01", NOW).unwrap();
        assert!(hi2.is_none(), "严格大于不该有上界");
        assert!(lo2.unwrap() > lo.unwrap());
        // `<` 是上界：这是迁移前把两者都当下界的修正
        let (lo3, hi3) = parse_time("<2024-01-01", NOW).unwrap();
        assert!(lo3.is_none());
        assert!(hi3.unwrap() < lo.unwrap());
    }

    #[test]
    fn time_invalid() {
        assert_eq!(parse_time("notadate", NOW), None);
    }

    // ── parse（迁移前 TestQueryParse）──────────────────────────────────
    #[test]
    fn bare_word_is_literal() {
        let q = parse("Cargo.toml");
        assert_eq!(q.literals, vec!["Cargo.toml"]);
        assert!(!q.needs_stat_filter());
    }

    #[test]
    fn unknown_field_degrades_to_literal() {
        // 兜住 URL：https://example.com 的 key 是 https，不是字段名
        for term in ["https://example.com", "foo:bar", "a:b:c", "name:", ":"] {
            let q = parse(term);
            assert_eq!(q.literals, vec![term], "{term} 应降级为字面量");
        }
    }

    #[test]
    fn ext_parsing() {
        let q = parse("ext:rs clippy");
        assert_eq!(q.exts, vec!["rs"]);
        assert_eq!(q.literals, vec!["clippy"]);
        assert_eq!(parse("ext:rs,.py").exts, vec!["rs", "py"]);
        assert_eq!(parse("ext:.rs").exts, vec!["rs"]);
    }

    #[test]
    fn size_and_time_fields() {
        let q = parse("size:>500mb dm:today");
        assert_eq!(q.size_min, Some(500 * 1024 * 1024 + 1));
        assert!(q.time_bounds.contains_key("dm"));
        assert!(q.needs_stat_filter());
    }

    #[test]
    fn name_path_type_fields() {
        let q = parse("name:report path:/etc type:dir");
        assert_eq!(q.name_pats, vec!["report"]);
        assert_eq!(q.path_pats, vec!["/etc"]);
        assert_eq!(q.want_type, Some(WantType::Dir));
        // 非法 type 值整体降级
        let bad = parse("type:wat");
        assert_eq!(bad.want_type, None);
        assert_eq!(bad.literals, vec!["type:wat"]);
    }

    // ── match_path（迁移前 TestMatchPath）──────────────────────────────
    #[test]
    fn literal_matches_full_path() {
        let q = parse("codes");
        assert!(q.match_path("/home/me/codes/app.py", "app.py"));
        assert!(!q.match_path("/tmp/other.py", "other.py"));
    }

    #[test]
    fn name_pattern_only_matches_basename() {
        let q = parse("name:report");
        assert!(q.match_path("/a/b/report.md", "report.md"));
        assert!(!q.match_path("/a/report_dir/x.md", "x.md"));
    }

    #[test]
    fn path_pattern_matches_full_path() {
        let q = parse("path:/etc/");
        assert!(q.match_path("/etc/nginx.conf", "nginx.conf"));
        assert!(!q.match_path("/opt/nginx.conf", "nginx.conf"));
    }

    #[test]
    fn ext_is_case_insensitive() {
        let q = parse("ext:rs");
        assert!(q.match_path("/a/b.rs", "b.rs"));
        assert!(q.match_path("/a/b.RS", "b.RS"));
    }

    #[test]
    fn dotfile_extension_drops_the_dot() {
        let q = parse("ext:gitignore");
        assert!(q.match_path("/a/.gitignore", ".gitignore"));
    }

    #[test]
    fn multiple_literals_are_and() {
        let q = parse("alpha beta");
        assert!(q.match_path("/x/alpha/beta.txt", "beta.txt"));
        assert!(!q.match_path("/x/alpha/gamma.txt", "gamma.txt"));
    }

    // ── match_stat（迁移前 TestMatchStat 的纯逻辑版）────────────────────
    #[test]
    fn size_filter_exempts_directories() {
        let q = parse("size:>1000");
        assert!(q.match_stat(&StatInfo { size: 5000, ..Default::default() }));
        assert!(!q.match_stat(&StatInfo { size: 10, ..Default::default() }));
        assert!(
            q.match_stat(&StatInfo { is_dir: true, size: 0, ..Default::default() }),
            "目录应豁免体积过滤"
        );
    }

    #[test]
    fn type_filter() {
        let dir = StatInfo { is_dir: true, ..Default::default() };
        let file = StatInfo::default();
        assert!(parse("type:dir").match_stat(&dir));
        assert!(!parse("type:dir").match_stat(&file));
        assert!(parse("type:file").match_stat(&file));
    }

    #[test]
    fn dm_filter_uses_mtime() {
        let now = unix_now();
        let fresh = StatInfo { mtime: now, ..Default::default() };
        // 2000-01-01；断言选在不同年份，避开本地时区偏移带来的边界抖动
        let old = StatInfo { mtime: 946_684_800, ..Default::default() };
        assert!(parse("dm:today").match_stat(&fresh));
        assert!(!parse("dm:2001-01-01").match_stat(&old));
        assert!(parse("dm:>1999-01-01").match_stat(&old));
    }

    // ── relevance（迁移前 TestRelevance）──────────────────────────────
    fn lit(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn exact_name_beats_substring() {
        let exact = relevance("/a/b/report.md", "report.md", &lit(&["report.md"]));
        let part = relevance("/a/b/report-2024.md", "report-2024.md", &lit(&["report.md"]));
        assert!(exact > part);
    }

    #[test]
    fn basename_hit_beats_path_hit() {
        let base = relevance("/x/config", "config", &lit(&["config"]));
        let deep = relevance("/config/sub/deep", "deep", &lit(&["config"]));
        assert!(base > deep);
    }

    #[test]
    fn no_match_is_zero() {
        assert_eq!(relevance("/a/b.txt", "b.txt", &lit(&["zzz"])), 0.0);
    }

    #[test]
    fn shorter_path_wins_on_tie() {
        let short = relevance("/a/b/report.md", "report.md", &lit(&["report"]));
        let long = relevance("/a/very/deep/tree/of/dirs/report.md", "report.md", &lit(&["report"]));
        assert!(short > long);
    }

    // ── plocate 模式 ─────────────────────────────────────────────────
    #[test]
    fn locate_patterns_are_escaped() {
        let pats = parse("a.b").locate_patterns();
        assert_eq!(pats.len(), 1);
        assert_ne!(pats[0], "a.b", "含点号的模式必须转义");
        assert_eq!(pats[0], r"a\.b");
    }

    #[test]
    fn locate_patterns_skip_basename_fields() {
        let pats = parse("name:report ext:md path:/etc").locate_patterns();
        assert_eq!(pats.len(), 1, "name:/ext: 是 basename 维度，不该进路径模式");
        assert!(pats[0].contains("etc"));
    }
}
