//! 展示层格式化：把索引结果转成面板文案（迁移前 `find.py::format` 的逐字移植）。
//!
//! 全部是纯函数，不碰文件系统也不碰 Everything——结果依赖外部进程，
//! 没法在单测里造，所以展示层单独出来测（单测见文件末尾）。

use serde_json::{json, Value};

pub const KIND_ICON: &str = "📁"; // 目录
pub const FILE_ICON: &str = "📄"; // 文件
pub const HIDDEN_ICON: &str = "👻"; // 隐藏/系统项

/// 一条索引结果（Everything 与 Unix 后端的公共形状，字段名与迁移前 row dict 一致）
#[derive(Debug, Clone, Default)]
pub struct Row {
    pub path: String,
    pub name: String,
    pub parent: String,
    pub is_dir: bool,
    /// 目录为 0（体积对目录无意义）
    pub size: i64,
    /// Unix 毫秒；0 = 未知
    pub mtime_ms: i64,
    pub hidden: bool,
    pub system: bool,
}

/// 人类可读体积。0 / 负数统一显示 `-`（目录与未取到 size 的项）。
pub fn fmt_size(num_bytes: i64) -> String {
    if num_bytes <= 0 {
        return "-".into();
    }
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    let mut v = num_bytes as f64;
    for (i, unit) in UNITS.iter().enumerate() {
        if v < 1024.0 || i == UNITS.len() - 1 {
            // B 不带小数（"512 B"），其余保留一位（"1.0 KB"）
            return if *unit == "B" {
                format!("{} {unit}", v as i64)
            } else {
                format!("{v:.1} {unit}")
            };
        }
        v /= 1024.0;
    }
    unreachable!("UNITS 非空，循环必然返回")
}

/// 相对时间。Everything 的 FILETIME 换算错误时会得到负数/极大值，一律兜成 `-`。
pub fn fmt_mtime(unix_ms: i64, now_ms: i64) -> String {
    if unix_ms <= 0 {
        return "-".into();
    }
    let diff = now_ms - unix_ms;
    if diff < 0 {
        // 索引时间戳异常：宁可说人话，也别显示「56 年后」
        return "未来".into();
    }
    if diff < 60_000 {
        return "刚刚".into();
    }
    let mins = diff / 60_000;
    if mins < 60 {
        return format!("{mins} 分钟前");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours} 小时前");
    }
    let days = hours / 24;
    if days < 30 {
        return format!("{days} 天前");
    }
    let months = days / 30;
    if months < 12 {
        return format!("{months} 个月前");
    }
    format!("{} 年前", days / 365)
}

/// 路径中间按**层级**省略，绝不截断目录名。
///
/// 按字符硬切会把 `averylongdirectoryname` 变成
/// `averylongdirectorynam...e`——半个词既认不出也搜不了，比完整显示更糟。
/// 这里保留盘符 + 前几层 + `...` + 最后两层。
pub fn shorten_middle(text: &str, max_segments: usize) -> String {
    if text.is_empty() {
        return String::new();
    }
    let norm = text.replace('/', "\\");
    let parts: Vec<&str> = norm.split('\\').collect();
    if parts.len() <= max_segments {
        return parts.join("\\");
    }
    let keep_tail = 2;
    let head_end = max_segments.saturating_sub(keep_tail);
    let head = parts[..head_end].join("\\");
    let tail = parts[parts.len() - keep_tail..].join("\\");
    format!("{head}\\...\\{tail}")
}

/// 把一条结果转成面板项
pub fn build_row(r: &Row, now_ms: i64, rank: usize) -> Value {
    let name = if r.name.is_empty() { r.path.clone() } else { r.name.clone() };
    let icon = if r.hidden || r.system {
        HIDDEN_ICON
    } else if r.is_dir {
        KIND_ICON
    } else {
        FILE_ICON
    };

    let mut bits: Vec<String> = Vec::new();
    if !r.is_dir {
        bits.push(fmt_size(r.size));
    }
    bits.push(fmt_mtime(r.mtime_ms, now_ms));
    if !r.parent.is_empty() {
        bits.push(shorten_middle(&r.parent, 4));
    }
    let description = bits
        .into_iter()
        .filter(|b| !b.is_empty())
        .collect::<Vec<_>>()
        .join("  ·  ");

    // 序号比类型图标更能说明「这是第几条」；目录在无序号时才退化成文字徽标
    let badge = if rank > 0 {
        format!("#{rank}")
    } else if r.is_dir {
        "目录".to_string()
    } else {
        FILE_ICON.to_string()
    };

    json!({
        "id": format!("find:item:{}:{}", rank, r.path),
        "title": name,
        "description": description,
        "badge": badge,
        "icon": icon,
        "metadata": {
            "path": r.path,
            "name": name,
            "isDir": r.is_dir,
        },
    })
}

/// 面板底部统计条：让用户知道「总共多少、只显示了前多少」
pub fn build_footer(total: u64, shown: usize, elapsed_ms: f64, extra: Option<&str>, source: &str) -> Value {
    let mut label = if total > shown as u64 {
        format!("共 {total} 项，显示前 {shown} 项")
    } else {
        format!("共 {total} 项")
    };
    if elapsed_ms >= 1.0 {
        label.push_str(&format!("  ·  {elapsed_ms:.0}ms"));
    }
    if let Some(extra) = extra {
        label.push_str(&format!("  ·  {extra}"));
    }
    json!({
        "id": "find:footer",
        "title": label,
        "description": source,
        "badge": "统计",
        "icon": "📊",
        "metadata": { "footer": true, "total": total, "shown": shown },
    })
}

/// 后端不可用时的引导面板（不要留空白，用户会以为插件坏了）
pub fn build_unavailable(reason: &str, hint: &str) -> Value {
    json!({
        "items": [{
            "id": "find:unavailable",
            "title": reason,
            "description": hint,
            "badge": "不可用",
            "icon": "⚠️",
            "metadata": { "unavailable": true },
        }],
        "emptyText": "文件索引不可用",
    })
}

/// 空输入时的语法提示（搜索语法很强大，值得列出来）
pub fn build_usage(hints: &[&str], syntax: &str) -> Value {
    let mut items = vec![json!({
        "id": "find:usage",
        "title": "输入关键词开始搜索",
        "description": syntax,
        "badge": "用法",
        "icon": "🔍",
        "metadata": { "usage": true },
    })];
    for (i, hint) in hints.iter().enumerate() {
        items.push(json!({
            "id": format!("find:usage:{i}"),
            "title": hint,
            "description": syntax,
            "badge": "示例",
            "icon": "·",
            "metadata": { "usage": true, "example": hint },
        }));
    }
    json!({ "items": items, "emptyText": "输入关键词" })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    fn file_row(path: &str, name: &str, parent: &str, size: i64) -> Row {
        Row {
            path: path.into(),
            name: name.into(),
            parent: parent.into(),
            is_dir: false,
            size,
            mtime_ms: NOW - 3_600_000,
            ..Default::default()
        }
    }

    #[test]
    fn size_zero_and_negative_are_dash() {
        assert_eq!(fmt_size(0), "-");
        assert_eq!(fmt_size(-1), "-");
    }

    #[test]
    fn size_units() {
        assert_eq!(fmt_size(512), "512 B");
        assert_eq!(fmt_size(1024), "1.0 KB");
        assert_eq!(fmt_size(1024 * 1024), "1.0 MB");
        assert_eq!(fmt_size(1024_i64.pow(3)), "1.0 GB");
        assert_eq!(fmt_size(1024_i64.pow(4)), "1.0 TB");
    }

    #[test]
    fn mtime_buckets() {
        let ago = |ms: i64| fmt_mtime(NOW - ms, NOW);
        assert_eq!(ago(30_000), "刚刚");
        assert_eq!(ago(5 * 60_000), "5 分钟前");
        assert_eq!(ago(3 * 3_600_000), "3 小时前");
        assert_eq!(ago(5 * 86_400_000), "5 天前");
        assert_eq!(ago(90 * 86_400_000), "3 个月前");
        assert_eq!(ago(800 * 86_400_000), "2 年前");
    }

    #[test]
    fn mtime_degenerate_values() {
        assert_eq!(fmt_mtime(0, NOW), "-");
        assert_eq!(fmt_mtime(-1, NOW), "-");
        assert_eq!(fmt_mtime(NOW + 10_000, NOW), "未来");
    }

    #[test]
    fn short_path_untouched() {
        assert_eq!(shorten_middle("D:\\codes", 4), "D:\\codes");
        assert_eq!(shorten_middle("D:\\a\\b\\c", 4), "D:\\a\\b\\c");
        assert_eq!(shorten_middle("", 4), "");
    }

    #[test]
    fn long_parent_is_shortened_by_segment() {
        let long = format!("C:\\{}\\file.txt", vec!["averylongdirectoryname"; 8].join("\\"));
        let parent = &long[..long.rfind('\\').expect("构造里有分隔符")];
        let row = file_row(&long, "file.txt", parent, 1);
        let desc = build_row(&row, NOW, 1)["description"].as_str().unwrap().to_string();
        assert!(desc.contains("\\...\\"), "{desc}");
        // 目录名必须完整出现，不能出现被截断的半个词
        for seg in desc.replace("\\...\\", "\\").split('\\') {
            if seg.starts_with("averylong") {
                assert_eq!(seg, "averylongdirectoryname", "{desc}");
            }
        }
        assert!(desc.trim_end().ends_with("averylongdirectoryname"), "{desc}");
    }

    #[test]
    fn file_row_shape() {
        let row = file_row("D:\\codes\\a.txt", "a.txt", "D:\\codes", 2048);
        let v = build_row(&row, NOW, 1);
        assert_eq!(v["title"], "a.txt");
        assert_eq!(v["badge"], "#1");
        assert_eq!(v["icon"], "📄");
        assert!(v["description"].as_str().unwrap().contains("2.0 KB"));
        assert!(v["description"].as_str().unwrap().contains("1 小时前"));
        assert_eq!(v["metadata"]["path"], "D:\\codes\\a.txt");
        assert_eq!(v["metadata"]["isDir"], false);
        assert_eq!(v["id"], "find:item:1:D:\\codes\\a.txt");
    }

    #[test]
    fn dir_row_has_no_size() {
        let row = Row {
            path: "D:\\codes".into(),
            name: "codes".into(),
            parent: "D:\\".into(),
            is_dir: true,
            size: 0,
            mtime_ms: NOW - 3_600_000,
            ..Default::default()
        };
        let v = build_row(&row, NOW, 1);
        let desc = v["description"].as_str().unwrap();
        assert_eq!(v["icon"], "📁");
        // 目录不应显示体积，也不该出现 '-' 占位
        assert!(!desc.contains('-'), "{desc}");
        assert!(!desc.contains('B'), "{desc}");
    }

    #[test]
    fn rank_zero_dir_uses_text_badge() {
        let row = Row { is_dir: true, ..file_row("D:\\x", "x", "D:\\", 0) };
        assert_eq!(build_row(&row, NOW, 0)["badge"], "目录");
    }

    #[test]
    fn hidden_and_system_use_ghost_icon() {
        for (hidden, system) in [(true, false), (false, true)] {
            let row = Row { hidden, system, ..file_row("C:\\x", "x", "C:\\", 1) };
            assert_eq!(build_row(&row, NOW, 1)["icon"], "👻");
        }
    }

    #[test]
    fn footer_counts() {
        let f = build_footer(175, 19, 8.4, None, "Everything 索引");
        let title = f["title"].as_str().unwrap();
        assert!(title.contains("共 175 项"), "{title}");
        assert!(title.contains("显示前 19 项"), "{title}");
        assert!(title.contains("8ms"), "{title}");
        assert_eq!(f["metadata"]["footer"], true);
        assert_eq!(f["description"], "Everything 索引");
    }

    #[test]
    fn footer_omits_shown_when_exact() {
        let f = build_footer(5, 5, 1.0, None, "Everything 索引");
        let title = f["title"].as_str().unwrap();
        assert!(title.contains("共 5 项"));
        assert!(!title.contains("显示前"));
    }

    #[test]
    fn footer_skips_sub_millisecond_timing() {
        let f = build_footer(3, 3, 0.4, None, "Everything 索引");
        assert!(!f["title"].as_str().unwrap().contains("ms"));
    }

    #[test]
    fn unavailable_panel_always_has_hint() {
        let r = build_unavailable("未检测到 Everything", "请安装并运行 Everything");
        assert_eq!(r["items"].as_array().unwrap().len(), 1);
        assert!(r["items"][0]["title"].as_str().unwrap().contains("Everything"));
        assert!(!r["items"][0]["description"].as_str().unwrap().is_empty());
        assert_eq!(r["items"][0]["metadata"]["unavailable"], true);
    }

    #[test]
    fn usage_panel_lists_hints() {
        let r = build_usage(&["a.md", "ext:rs"], "支持 Everything 原生语法");
        assert_eq!(r["items"].as_array().unwrap().len(), 3); // 1 条主提示 + 2 条示例
        assert!(r["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["metadata"]["usage"] == true));
    }
}
