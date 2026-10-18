//! 应用检索的文本归一化：拼音、首字母、来源描述。
//!
//! 为什么在**写入时**算好而不是查询时算：
//! - 每次按键都要查目录，实时转拼音会让逐键检索从"毫秒级"变成"十几毫秒"；
//! - SQLite 的 `LIKE` 可以直接吃预计算列，不需要把全部行拉到 Rust 里过滤；
//! - 名字是低频变更数据（导入/手动添加时写一次），算一次最划算。
//!
//! 拼音只做"检索用途"：不标声调、不处理多音字（"重庆"按默认读音），
//! 目标是让 `wx` / `weixin` 能命中"微信"，不是做词典。

use pinyin::ToPinyin;
use std::path::Path;

/// 全拼列长度上限（防止超长名字把索引撑大；正常应用名远小于此）
const MAX_FULL_CHARS: usize = 64;
/// 首字母列长度上限
const MAX_INITIALS_CHARS: usize = 24;

/// 生成检索用的 (全拼, 首字母)
///
/// - 中文：逐字转拼音，全拼拼接；每个字的首字母都进 initials
/// - 英文/数字：转小写后拼接；initials 只取每个单词的首字符（`Visual Studio Code` → `vsc`）
/// - 空白与标点：视为单词边界
pub fn index_text(name: &str) -> (String, String) {
    let mut full = String::with_capacity(name.len() * 2);
    let mut initials = String::with_capacity(8);
    // 英文单词边界：中文每字自带边界，处理完中文后重置为 true，
    // 让"微信App"这类混排里的 App 也能贡献首字母
    let mut at_word_start = true;

    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            let lower = ch.to_ascii_lowercase();
            push_char(&mut full, lower, MAX_FULL_CHARS);
            if at_word_start {
                push_char(&mut initials, lower, MAX_INITIALS_CHARS);
            }
            at_word_start = false;
            continue;
        }

        if ch.is_ascii() {
            // 空格、连字符、点号等：下一个英文单词重新开始
            at_word_start = true;
            continue;
        }

        // 非 ASCII 交给拼音库；转不出来（日文假名等）就当分隔符
        let mut buf = [0u8; 4];
        let single: &str = ch.encode_utf8(&mut buf);
        match single.to_pinyin().next().flatten() {
            Some(pinyin) => {
                let plain = pinyin.plain();
                push_str(&mut full, plain, MAX_FULL_CHARS);
                if let Some(first) = plain.chars().next() {
                    push_char(&mut initials, first, MAX_INITIALS_CHARS);
                }
                at_word_start = true;
            }
            None => at_word_start = true,
        }
    }

    (full, initials)
}

/// 应用来源标签（列表描述的第一段）
pub fn source_label(source: &str, path: &str) -> &'static str {
    if source == "manual" {
        return "自定义";
    }
    let lower = path.to_ascii_lowercase();
    if lower.contains("\\desktop\\") || lower.contains("/desktop/") {
        "桌面"
    } else if cfg!(target_os = "windows") {
        "开始菜单"
    } else {
        "应用菜单"
    }
}

/// 面板描述：来源 + 所在分组（完整路径仍通过 metadata 交给前端）
///
/// 之前这里直接显示 `可执行程序: C:\...\xx.exe`，一条就占满整行；
/// 用户真正需要的是"它从哪来"，路径留给动作层的"复制路径"。
pub fn short_description(source: &str, path: &str) -> String {
    let label = source_label(source, path);
    let parent = path.rsplit(|c| c == '\\' || c == '/').nth(1).unwrap_or("");
    let parent_lower = parent.to_ascii_lowercase();
    let generic = matches!(
        parent_lower.as_str(),
        "" | "programs" | "start menu" | "desktop" | "applications"
    );
    if generic {
        label.to_string()
    } else {
        format!("{} · {}", label, parent)
    }
}

fn push_char(out: &mut String, ch: char, max: usize) {
    if out.chars().count() < max {
        out.push(ch);
    }
}

fn push_str(out: &mut String, value: &str, max: usize) {
    for ch in value.chars() {
        if out.chars().count() >= max {
            break;
        }
        out.push(ch);
    }
}

/// 图标 URL：能被宿主 `ll-icon://` 抽取的路径回 URL，否则回 emoji。
///
/// 这里只做静态判断（绝对路径 + 扩展名），不查文件是否存在：
/// 走 IPC 查盘会让逐键列表变慢，真抽不出来时协议回 404，前端自然回退 emoji。
pub fn icon_url(path: &str) -> String {
    const ICON_EXTENSIONS: &[&str] = &["exe", "lnk", "url", "ico"];
    let trimmed = path.trim();
    let supported = !trimmed.is_empty()
        && Path::new(trimmed).is_absolute()
        && Path::new(trimmed)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| ICON_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
    if !supported {
        return "🚀".to_string();
    }
    format!("ll-icon://localhost/{}", encode_component(trimmed))
}

/// URL path 段编码：非 unreserved 字节全部转义（含 `\`、`:` 与中文）
fn encode_component(input: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(input.len() * 2);
    for &b in input.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_name_supports_full_pinyin_and_initials() {
        let (full, initials) = index_text("微信");
        assert_eq!(full, "weixin");
        assert_eq!(initials, "wx");
    }

    #[test]
    fn english_name_uses_word_initials() {
        let (full, initials) = index_text("Visual Studio Code");
        assert_eq!(full, "visualstudiocode");
        assert_eq!(initials, "vsc");
    }

    #[test]
    fn mixed_name_keeps_both_halves_searchable() {
        let (full, initials) = index_text("QQ音乐");
        // 多音字按默认读音（乐 → le），检索目的下可接受
        assert_eq!(full, "qqyinle");
        assert_eq!(initials, "qyl");
    }

    #[test]
    fn punctuation_is_a_word_boundary() {
        let (full, initials) = index_text("7-Zip");
        assert_eq!(full, "7zip");
        assert_eq!(initials, "7z");
    }

    #[test]
    fn source_labels_cover_manual_desktop_and_menu() {
        assert_eq!(source_label("manual", r"C:\Tools\x.exe"), "自定义");
        assert_eq!(
            source_label("system", r"C:\Users\me\Desktop\微信.lnk"),
            "桌面"
        );
        assert_eq!(
            source_label(
                "system",
                r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\微信.lnk"
            ),
            "开始菜单"
        );
    }

    #[test]
    fn description_prefers_group_folder_over_full_path() {
        let desc = short_description(
            "system",
            r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\腾讯\微信.lnk",
        );
        assert_eq!(desc, "开始菜单 · 腾讯");

        let flat = short_description(
            "system",
            r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\微信.lnk",
        );
        assert_eq!(flat, "开始菜单");
    }

    #[test]
    fn icon_url_only_for_absolute_supported_paths() {
        let exe = std::env::temp_dir().join("demo.exe");
        let url = icon_url(&exe.to_string_lossy());
        assert!(url.starts_with("ll-icon://localhost/"), "实得 {url}");
        assert!(!url.contains('\\'), "反斜杠必须被转义");
        if cfg!(windows) {
            // 盘符冒号必须在 path 段里转义，否则 URL 解析会把它当成 scheme 的一部分
            assert!(url.contains("%3A"), "实得 {url}");
        }

        assert_eq!(icon_url("code.exe"), "🚀", "裸命令不是可抽取的图标路径");
        let txt = std::env::temp_dir().join("notes.txt");
        assert_eq!(icon_url(&txt.to_string_lossy()), "🚀");
    }

    #[test]
    fn icon_url_encodes_chinese_and_spaces() {
        let path = std::env::temp_dir().join("腾讯 微信.lnk");
        let url = icon_url(&path.to_string_lossy());
        // "腾" 的 UTF-8 是 E8 85 BE；只断言编码存在，避免依赖平台路径分隔符
        assert!(url.contains("%E8%85%BE"), "实得 {url}");
        assert!(url.contains("%20"), "空格必须转义");
    }
}
