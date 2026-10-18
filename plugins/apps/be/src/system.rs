use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// 单次返回上限默认值（键入过滤通常很快，前端按需渲染）
pub const DEFAULT_LIMIT: usize = 30;
/// 扫描上限：目录导入要一次拿全（开始菜单常见几百项），但也不能无限
pub const MAX_LIMIT: usize = 2000;
/// 递归扫描深度上限（applications 目录偶有子目录分组）
const MAX_SCAN_DEPTH: u8 = 2;

#[derive(Debug, Serialize, Clone)]
pub struct SystemAppItem {
    /// 展示名（桌面项的 Name[zh_CN] / 可执行文件名 / 快捷方式名）
    pub name: String,
    /// 启动目标（.desktop 绝对路径 / 可执行文件路径 / 开始菜单快捷方式路径）
    pub path: String,
    /// 描述行（Exec 内容或完整路径）
    pub detail: String,
    /// 来源类型：desktop=桌面应用, exec=可执行命令, startmenu=开始菜单项
    pub kind: String,
    /// 是否已在用户快捷列表中
    pub added: bool,
}

/// 扫描系统应用候选（apps 插件 /app add 的候选列表数据源）
///
/// Linux: XDG applications 目录的 .desktop 桌面项 + PATH 可执行命令
/// macOS: /Applications 下的 .app
/// Windows: 开始菜单（全部用户 + 当前用户）的 .lnk/.url
///
/// 返回已按匹配度排序并截断；空关键词仅列出桌面项（PATH 可执行数量过大不做全量罗列）
/// `saved_paths`：已在用户快捷表中的路径（用于 added 徽标）
pub fn search_system_apps(
    keyword: Option<String>,
    limit: Option<usize>,
    saved_paths: &HashSet<String>,
) -> Vec<SystemAppItem> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let kw = keyword.unwrap_or_default().trim().to_lowercase();

    let mut items: Vec<SystemAppItem> = Vec::new();
    #[cfg(target_os = "windows")]
    collect_windows_apps(&kw, limit, &mut items);
    #[cfg(not(target_os = "windows"))]
    collect_unix_apps(&kw, limit, &mut items);

    for item in &mut items {
        item.added = saved_paths.contains(&item.path);
    }

    items
}

/// 名称匹配度：0=完全相等 1=前缀 2=包含（None=不匹配；空关键词视为包含）
fn match_score(text_lower: &str, kw: &str) -> Option<u8> {
    if kw.is_empty() {
        return Some(2);
    }
    if text_lower == kw {
        Some(0)
    } else if text_lower.starts_with(kw) {
        Some(1)
    } else if text_lower.contains(kw) {
        Some(2)
    } else {
        None
    }
}

/// 按匹配度升序、名称降序无关的稳定排序后截断
fn sort_and_truncate(scored: Vec<(u8, SystemAppItem)>, limit: usize) -> Vec<SystemAppItem> {
    let mut scored = scored;
    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));
    scored.truncate(limit);
    scored.into_iter().map(|(_, item)| item).collect()
}

// ============================== Linux / macOS ==============================

#[cfg(not(target_os = "windows"))]
fn collect_unix_apps(kw: &str, limit: usize, out: &mut Vec<SystemAppItem>) {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut scored: Vec<(u8, SystemAppItem)> = Vec::new();

    // 1. 桌面应用（Linux 等价 Windows 开始菜单；macOS 扫描 .app 包）
    for dir in app_entry_dirs() {
        scan_app_dir(&dir, 0, kw, &mut seen, &mut scored);
    }

    // 2. PATH 可执行命令（仅有关键词时扫描，避免无关键词时全量罗列数千命令）
    if !kw.is_empty() {
        scan_path_executables(kw, &mut seen, &mut scored);
    }

    *out = sort_and_truncate(scored, limit);
}

/// 桌面项目录（Linux: XDG applications；macOS: Applications）
#[cfg(not(target_os = "windows"))]
fn app_entry_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/Applications"));
        dirs.push(PathBuf::from("/System/Applications"));
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            dirs.push(home.join(".local/share/applications"));
            dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
        }
        let data_dirs = std::env::var("XDG_DATA_DIRS")
            .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
        for d in data_dirs.split(':').filter(|d| !d.is_empty()) {
            dirs.push(PathBuf::from(d).join("applications"));
        }
        dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    }

    dirs
}

/// 递归扫描桌面项目录：Linux 收集 .desktop，macOS 收集 .app
#[cfg(not(target_os = "windows"))]
fn scan_app_dir(
    dir: &Path,
    depth: u8,
    kw: &str,
    seen: &mut HashSet<PathBuf>,
    scored: &mut Vec<(u8, SystemAppItem)>,
) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_app_dir(&path, depth + 1, kw, seen, scored);
            continue;
        }

        #[cfg(target_os = "macos")]
        {
            if path.extension().map_or(false, |ext| ext == "app") {
                let name = path
                    .file_stem()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let path_str = path.to_string_lossy().to_string();
                if let Some(score) = match_score(&name.to_lowercase(), kw)
                    .or_else(|| match_score(&path_str.to_lowercase(), kw))
                {
                    if seen.insert(path.clone()) {
                        scored.push((
                            score,
                            SystemAppItem {
                                name,
                                path: path_str.clone(),
                                detail: path_str,
                                kind: "desktop".to_string(),
                                added: false,
                            },
                        ));
                    }
                }
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            if path.extension().map_or(false, |ext| ext == "desktop") {
                if let Some((name, exec)) = parse_desktop_file(&path) {
                    let path_str = path.to_string_lossy().to_string();
                    let name_lower = name.to_lowercase();
                    let exec_prog = exec.split_whitespace().next().unwrap_or("").to_lowercase();
                    if let Some(score) =
                        match_score(&name_lower, kw).or_else(|| match_score(&exec_prog, kw))
                    {
                        if seen.insert(path.clone()) {
                            scored.push((
                                score,
                                SystemAppItem {
                                    name,
                                    path: path_str.clone(),
                                    detail: exec,
                                    kind: "desktop".to_string(),
                                    added: false,
                                },
                            ));
                        }
                    }
                }
            }
        }
    }
}

/// 解析 .desktop 主段落：返回 (显示名, Exec)；
/// 跳过 NoDisplay/Hidden 与非 Application 类型；中文名优先
#[cfg(not(target_os = "windows"))]
fn parse_desktop_file(path: &Path) -> Option<(String, String)> {
    let content = fs::read_to_string(path).ok()?;
    let mut name: Option<String> = None;
    let mut name_zh: Option<String> = None;
    let mut exec: Option<String> = None;
    let mut is_application = false;
    let mut skip = false;
    let mut in_main_section = true;

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_main_section = line.eq_ignore_ascii_case("[Desktop Entry]");
            continue;
        }
        if !in_main_section {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim();
            match key {
                "Type" => is_application = value.eq_ignore_ascii_case("application"),
                "NoDisplay" => skip |= value.eq_ignore_ascii_case("true"),
                "Hidden" => skip |= value.eq_ignore_ascii_case("true"),
                "Name" if name.is_none() => name = Some(value.to_string()),
                "Name[zh_CN]" => name_zh = Some(value.to_string()),
                "Exec" if exec.is_none() => exec = Some(value.to_string()),
                _ => {}
            }
        }
    }

    if !is_application || skip {
        return None;
    }
    let name = name_zh
        .or(name)
        .or_else(|| path.file_stem().map(|n| n.to_string_lossy().to_string()))?;
    let exec = exec?
        // 去掉 %f/%u 等字段代码占位
        .split_whitespace()
        .filter(|tok| !tok.starts_with('%'))
        .collect::<Vec<_>>()
        .join(" ");
    Some((name, exec))
}

/// 扫描 $PATH 目录中名称匹配的可执行文件
#[cfg(not(target_os = "windows"))]
fn scan_path_executables(
    kw: &str,
    seen: &mut HashSet<PathBuf>,
    scored: &mut Vec<(u8, SystemAppItem)>,
) {
    use std::os::unix::fs::PermissionsExt;

    let Some(path_var) = std::env::var_os("PATH") else {
        return;
    };
    for dir in std::env::split_paths(&path_var) {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let is_exec = entry
                .metadata()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false);
            if !is_exec {
                continue;
            }
            let name = match path.file_name() {
                Some(n) => n.to_string_lossy().to_string(),
                None => continue,
            };
            if let Some(score) = match_score(&name.to_lowercase(), kw) {
                if seen.insert(path.clone()) {
                    let path_str = path.to_string_lossy().to_string();
                    scored.push((
                        score,
                        SystemAppItem {
                            name,
                            path: path_str.clone(),
                            detail: path_str,
                            kind: "exec".to_string(),
                            added: false,
                        },
                    ));
                }
            }
        }
    }
}

// ================================ Windows ==================================

#[cfg(target_os = "windows")]
fn collect_windows_apps(kw: &str, limit: usize, out: &mut Vec<SystemAppItem>) {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut scored: Vec<(u8, SystemAppItem)> = Vec::new();

    // 开始菜单 = Windows 的"系统应用列表"：全部用户 + 当前用户两处
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(pd) = std::env::var_os("ProgramData") {
        dirs.push(PathBuf::from(pd).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(ad) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(ad).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    // 桌面快捷方式：不少装机软件只放桌面、不进开始菜单，
    // 只扫开始菜单会漏掉它们（用户输入 `wx` 就找不到微信）
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        dirs.push(PathBuf::from(profile).join("Desktop"));
    }
    if let Some(public) = std::env::var_os("PUBLIC") {
        dirs.push(PathBuf::from(public).join("Desktop"));
    }
    for dir in dirs {
        scan_start_menu(&dir, 0, kw, &mut seen, &mut scored);
    }

    *out = sort_and_truncate(scored, limit);
}

/// 递归扫描开始菜单目录中的 .lnk / .url 快捷方式
#[cfg(target_os = "windows")]
fn scan_start_menu(
    dir: &Path,
    depth: u8,
    kw: &str,
    seen: &mut HashSet<PathBuf>,
    scored: &mut Vec<(u8, SystemAppItem)>,
) {
    if depth > MAX_SCAN_DEPTH + 2 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_start_menu(&path, depth + 1, kw, seen, scored);
            continue;
        }
        let is_shortcut = path
            .extension()
            .map_or(false, |ext| ext == "lnk" || ext == "url");
        if !is_shortcut {
            continue;
        }
        let name = match path.file_stem() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        if let Some(score) = match_score(&name.to_lowercase(), kw) {
            if seen.insert(path.clone()) {
                let path_str = path.to_string_lossy().to_string();
                scored.push((
                    score,
                    SystemAppItem {
                        name,
                        path: path_str.clone(),
                        detail: path_str,
                        kind: "startmenu".to_string(),
                        added: false,
                    },
                ));
            }
        }
    }
}

// ================================= 测试 ====================================

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;

    #[test]
    fn parses_desktop_file_with_zh_name_and_field_codes() {
        let dir = std::env::temp_dir().join(format!("ll-sysapps-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("demo.desktop");
        fs::write(
            &file,
            "[Desktop Entry]\n\
             Type=Application\n\
             Name=Demo Editor\n\
             Name[zh_CN]=示例编辑器\n\
             Exec=demo %F --flag\n\
             Icon=demo\n",
        )
        .unwrap();

        let (name, exec) = parse_desktop_file(&file).unwrap();
        assert_eq!(name, "示例编辑器");
        assert_eq!(exec, "demo --flag");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn skips_nondisplay_and_nonapp_entries() {
        let dir = std::env::temp_dir().join(format!("ll-sysapps-skip-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        let hidden = dir.join("hidden.desktop");
        fs::write(
            &hidden,
            "[Desktop Entry]\nType=Application\nName=Hidden\nExec=x\nNoDisplay=true\n",
        )
        .unwrap();
        assert!(parse_desktop_file(&hidden).is_none());

        let link = dir.join("link.desktop");
        fs::write(
            &link,
            "[Desktop Entry]\nType=Link\nName=URL\nURL=http://x\n",
        )
        .unwrap();
        assert!(parse_desktop_file(&link).is_none());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scans_fixture_dir_and_matches_keyword() {
        let dir = std::env::temp_dir().join(format!("ll-sysapps-scan-{}", std::process::id()));
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(
            dir.join("terminal.desktop"),
            "[Desktop Entry]\nType=Application\nName[zh_CN]=终端\nExec=gnome-terminal\n",
        )
        .unwrap();
        fs::write(
            dir.join("nested").join("browser.desktop"),
            "[Desktop Entry]\nType=Application\nName=Web Browser\nExec=firefox %u\n",
        )
        .unwrap();

        let mut seen = HashSet::new();
        let mut scored = Vec::new();
        scan_app_dir(&dir, 0, "终端", &mut seen, &mut scored);
        let items = sort_and_truncate(scored, 30);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "终端");
        assert_eq!(items[0].kind, "desktop");
        assert!(items[0].path.ends_with("terminal.desktop"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn match_score_ranks_exact_prefix_contains() {
        assert_eq!(match_score("终端", "终端"), Some(0));
        assert_eq!(match_score("terminal-app", "terminal"), Some(1));
        assert_eq!(match_score("gnome-terminal", "terminal"), Some(2));
        assert_eq!(match_score("files", "terminal"), None);
        assert_eq!(match_score("anything", ""), Some(2));
    }

    #[test]
    fn path_scan_finds_real_executable() {
        // /bin/ls 在常规 Linux 一定存在且可执行
        if !Path::new("/bin/ls").exists() {
            return;
        }
        let mut seen = HashSet::new();
        let mut scored = Vec::new();
        scan_path_executables("ls", &mut seen, &mut scored);
        let items = sort_and_truncate(scored, 50);
        assert!(
            items
                .iter()
                .any(|i| i.kind == "exec" && i.path.ends_with("/ls"))
        );
    }
}
