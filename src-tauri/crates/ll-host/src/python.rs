//! Python 运行时解析与配置（LLP sidecar 依赖）
//!
//! `sysinfo` 等 `kind=llp` 外部插件以 Python 作为 sidecar 运行时，而目标机器很可能
//! 既没把 python 加进 PATH、也没在注册表登记（Miniconda/Anaconda 默认不登记 PEP 514，
//! 装在 D:\tools 这类自定义位置更是完全隐形）。本模块集中回答"用哪个解释器"，
//! 并允许用户在设置面板显式指定。
//!
//! 解析优先级（命中即停）：
//!   1. 用户在设置面板配置的路径（`app_settings` 键 `python.path`，进程内缓存镜像）
//!   2. 环境变量 `LLP_PYTHON`（全路径或 PATH 内裸名）
//!   3. manifest `backend.entry` 声明的裸名（python3/python/py）→ PATH 探测
//!   4. Windows 注册表 PEP 514（python.org / conda / uv 等发行版均登记）
//!   5. 常见安装位置（%LOCALAPPDATA%\Programs\Python、Program Files\Python、
//!      C:\Python3xx、用户目录下的 conda、Homebrew、/usr/bin…）
//!   6. 各盘符根目录下的 conda/Python 目录（Miniconda3、Anaconda3、Python3xx…）
//!
//! 全程跳过 Microsoft Store 的 0 字节占位 stub——执行它只会弹商店页，无法承载插件。

use ll_plugin_api::PluginError;
use serde::Serialize;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

/// `app_settings` 中保存用户配置 Python 解释器路径的键
pub const SETTING_KEY: &str = "python.path";

/// 版本探测（`-c` 执行）的超时——用户可能填错路径指向交互式程序，不能无限等
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

// ─────────────────────────────────────────────────────────────────────────────
// 用户配置的进程内缓存（启动时由 app_settings 载入，设置面板写入后即时更新）
// ─────────────────────────────────────────────────────────────────────────────

static CONFIGURED: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn slot() -> &'static RwLock<Option<String>> {
    CONFIGURED.get_or_init(|| RwLock::new(None))
}

/// 当前生效的用户配置（None = 未配置，走自动探测）
pub fn configured() -> Option<String> {
    slot().read().ok().and_then(|g| g.clone())
}

/// 更新用户配置（空串视为清除 → 回落到自动探测）
pub fn set_configured(path: Option<String>) {
    if let Ok(mut g) = slot().write() {
        *g = path
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 探测与校验
// ─────────────────────────────────────────────────────────────────────────────

/// 设置面板展示的解释器候选
#[derive(Debug, Clone, Serialize)]
pub struct PythonCandidate {
    pub path: String,
    /// 形如 "Python 3.13.5"；None = 探测失败（文件不存在/不是解释器/执行超时）
    pub version: Option<String>,
    /// 来源说明，如 "PATH"、"注册表 PEP 514"、"D:\\ 根目录"
    pub source: String,
    pub valid: bool,
}

/// 让子进程**不获得控制台窗口**（仅 Windows 需要）。
///
/// 宿主是 GUI 程序、自身没有控制台，而 python.exe 是控制台程序：默认系统会为它
/// **新建一个控制台窗口**，表现为用户每用一个 LLP 插件就闪出一个黑色命令窗口，
/// 并抢走主窗口输入框的焦点（输入即搜的场景下等于打字丢失）。多插件 = 多窗口。
/// CREATE_NO_WINDOW 让它不再分配控制台，而 stdin/stdout/stderr 管道照常工作。
#[cfg(target_os = "windows")]
fn apply_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// 非 Windows 上子进程本来就不会被分配控制台，空实现即可
#[cfg(not(target_os = "windows"))]
fn apply_no_window(_cmd: &mut Command) {}

pub fn hide_console(mut cmd: Command) -> Command {
    apply_no_window(&mut cmd);
    cmd
}

/// 执行一条命令并取回 stdout（带超时保护，避免误填交互式程序卡死宿主调用线程）
pub fn run_capture(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut child = hide_console(Command::new(program))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 {}: {}", program, e))?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut so) = child.stdout.take() {
                    let _ = so.read_to_string(&mut out);
                }
                if !status.success() {
                    let mut err = String::new();
                    if let Some(mut se) = child.stderr.take() {
                        let _ = se.read_to_string(&mut err);
                    }
                    let hint = err.lines().next().unwrap_or("").trim();
                    return Err(if hint.is_empty() {
                        format!("退出码 {}", status)
                    } else {
                        hint.to_string()
                    });
                }
                return Ok(out.trim().to_string());
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err("执行超时（可能不是可执行的 Python 解释器）".into());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("等待进程失败: {}", e)),
        }
    }
}

/// 校验解释器是否可用并返回版本串（如 "Python 3.13.5"）
pub fn probe_version(exe: &str) -> Result<String, String> {
    let exe = exe.trim();
    if exe.is_empty() {
        return Err("路径为空".into());
    }
    // sidecar 只用标准库，精确到实现没有意义，版本号足够
    let out = run_capture(
        exe,
        &["-c", "import platform;print(platform.python_version())"],
        PROBE_TIMEOUT,
    )?;
    let version = out.lines().next().unwrap_or("").trim();
    if version.is_empty() {
        return Err("未返回版本号，可能不是 Python 解释器".into());
    }
    Ok(format!("Python {}", version))
}

fn is_python_name(program: &str) -> bool {
    matches!(
        program.trim_end_matches(".exe").to_ascii_lowercase().as_str(),
        "python3" | "python" | "py"
    )
}

/// 在 PATH 中探测裸命令（返回命中文件的全路径；含路径分隔符的候选按字面校验存在性）
pub fn resolve_program(name: &str) -> Option<PathBuf> {
    if name.contains('/') || name.contains('\\') {
        let literal = PathBuf::from(name);
        return if literal.is_file() { Some(literal) } else { None };
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let mut candidates: Vec<PathBuf> = Vec::with_capacity(2);
        #[cfg(target_os = "windows")]
        candidates.push(dir.join(format!("{}.exe", name)));
        candidates.push(dir.join(name));
        for file in candidates {
            if file.is_file() && !is_store_stub(&file) {
                return Some(file);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn is_store_stub(path: &Path) -> bool {
    path.to_string_lossy().to_lowercase().contains("windowsapps")
        && std::fs::metadata(path).map(|m| m.len() == 0).unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn is_store_stub(_path: &Path) -> bool {
    false
}

fn push_if_file(out: &mut Vec<PathBuf>, p: PathBuf) {
    if p.is_file() {
        out.push(p);
    }
}

/// PEP 514：Windows 上多数发行版在注册表登记安装路径（python.org/conda/uv 等）
#[cfg(target_os = "windows")]
fn registry_pythons() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let Ok(root) = RegKey::predef(hive).open_subkey_with_flags("Software\\Python", KEY_READ) else {
            continue;
        };
        for brand in root.enum_keys().flatten() {
            let Ok(brand_key) = root.open_subkey_with_flags(&brand, KEY_READ) else {
                continue;
            };
            for tag in brand_key.enum_keys().flatten() {
                let Ok(tag_key) = brand_key.open_subkey_with_flags(&tag, KEY_READ) else {
                    continue;
                };
                let Ok(install_key) = tag_key.open_subkey_with_flags("InstallPath", KEY_READ) else {
                    continue;
                };
                let dir: String = install_key.get_value::<String, _>("").unwrap_or_default();
                if dir.trim().is_empty() {
                    continue;
                }
                let install = PathBuf::from(dir.trim_end_matches(['\\', '/']));
                let exe: PathBuf = install_key
                    .get_value::<String, _>("ExecutablePath")
                    .map(|s| PathBuf::from(s.trim()))
                    .unwrap_or_else(|_| install.join("python.exe"));
                if exe.is_file() {
                    out.push((tag.to_ascii_lowercase(), exe)); // 版本号降序
                }
            }
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, p)| p).collect()
}

#[cfg(not(target_os = "windows"))]
fn registry_pythons() -> Vec<PathBuf> {
    Vec::new()
}

/// 无 PATH 可用时按常见安装位置探测（按新到旧排序）
fn common_python_locations() -> Vec<PathBuf> {
    let mut out = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            let base = local.join("Programs").join("Python");
            if let Ok(rd) = std::fs::read_dir(&base) {
                let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
                dirs.sort_unstable();
                for d in dirs.into_iter().rev() {
                    push_if_file(&mut out, d.join("python.exe"));
                }
            }
            push_if_file(
                &mut out,
                local
                    .join("Microsoft")
                    .join("WindowsApps")
                    .join("python3.exe"),
            );
        }
        for root in [r"C:\Program Files", r"C:\Program Files (x86)"] {
            let base = PathBuf::from(root).join("Python");
            if let Ok(rd) = std::fs::read_dir(&base) {
                let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
                dirs.sort_unstable();
                for d in dirs.into_iter().rev() {
                    push_if_file(&mut out, d.join("python.exe"));
                }
            }
        }
        for v in ["313", "312", "311", "310", "39"] {
            push_if_file(&mut out, PathBuf::from(format!(r"C:\Python{}\python.exe", v)));
        }
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let home = PathBuf::from(home);
            for name in ["miniconda3", "Miniconda3", "anaconda3", "Anaconda3"] {
                push_if_file(&mut out, home.join(name).join("python.exe"));
            }
        }
        // 装在自定义盘符根目录的场景（D:\tools\Miniconda3 等）：只读一层目录，
        // 且仅认名字像 Python 发行版的目录，避免命中某软件自带的嵌入式解释器
        out.extend(drive_root_pythons());
    }

    #[cfg(not(target_os = "windows"))]
    {
        for p in [
            "/usr/local/bin/python3",
            "/usr/bin/python3",
            "/opt/homebrew/bin/python3",
            "/home/linuxbrew/.linuxbrew/bin/python3",
        ] {
            push_if_file(&mut out, PathBuf::from(p));
        }
        // Homebrew / 手动安装的 conda
        for dir in ["/opt", "/usr/local", "/opt/conda", "/opt/miniconda3"] {
            push_if_file(&mut out, PathBuf::from(dir).join("bin").join("python3"));
        }
    }

    out
}

/// 扫描各盘符下的 Python 发行版（Windows conda 常装在 D:\tools\Miniconda3 这类二级目录）
///
/// 只读两层：`<盘符>:\` → 子目录 → 孙目录，且孙目录名须含 conda/anaconda/python，
/// 避免把某个软件自带的嵌入式解释器当成运行时；系统巨目录（Windows/Users…）直接跳过。
#[cfg(target_os = "windows")]
fn drive_root_pythons() -> Vec<PathBuf> {
    const SKIP: [&str; 7] = [
        "windows",
        "program files",
        "program files (x86)",
        "programdata",
        "users",
        "$recycle.bin",
        "system volume information",
    ];
    /// 目录名是否像 Python 发行版（conda 系 / python.org 系）
    fn looks_like_python_dir(name: &str) -> bool {
        let n = name.to_ascii_lowercase();
        n.contains("conda") || n.contains("python") || n.starts_with("py3")
    }
    /// 收下该目录的 python.exe 及其 conda 环境
    fn collect_dir(out: &mut Vec<PathBuf>, dir: &Path) {
        push_if_file(out, dir.join("python.exe"));
        if let Ok(rd) = std::fs::read_dir(dir.join("envs")) {
            for e in rd.flatten() {
                push_if_file(out, e.path().join("python.exe"));
            }
        }
    }

    let mut out = Vec::new();
    for letter in b'C'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\", letter as char));
        if !root.is_dir() {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&root) else {
            continue;
        };
        for mid in rd.flatten().map(|e| e.path()) {
            if !mid.is_dir() {
                continue;
            }
            let mid_name = mid
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if SKIP.contains(&mid_name.as_str()) {
                continue;
            }
            // D:\Miniconda3、D:\Python313 这类直接命中
            if looks_like_python_dir(&mid_name) {
                collect_dir(&mut out, &mid);
                continue;
            }
            // D:\tools\Miniconda3：再往下看一层
            let Ok(rd2) = std::fs::read_dir(&mid) else {
                continue;
            };
            for leaf in rd2.flatten().map(|e| e.path()) {
                if !leaf.is_dir() {
                    continue;
                }
                let leaf_name = leaf
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if looks_like_python_dir(&leaf_name) {
                    collect_dir(&mut out, &leaf);
                }
            }
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析入口
// ─────────────────────────────────────────────────────────────────────────────

/// 有序候选表：(候选路径或裸名, 来源说明)
fn ordered_candidates(program: &str) -> Vec<(String, &'static str)> {
    let mut out: Vec<(String, &'static str)> = Vec::new();
    let mut push = |cand: String, source: &'static str| {
        if cand.trim().is_empty() {
            return;
        }
        let key = cand.trim_end_matches(".exe").to_ascii_lowercase();
        if out.iter().any(|(c, _)| c.trim_end_matches(".exe").to_ascii_lowercase() == key) {
            return;
        }
        out.push((cand, source));
    };

    if let Some(c) = configured() {
        push(c, "用户配置");
    }
    if let Ok(v) = std::env::var("LLP_PYTHON") {
        push(v.trim().to_string(), "环境变量 LLP_PYTHON");
    }
    push(program.to_string(), "PATH");
    for name in ["python3", "python", "py"] {
        push(name.to_string(), "PATH");
    }
    out
}

/// 解析 LLP `backend.entry` 的解释器与参数
///
/// - 含路径分隔符 / 非 Python 裸名 → 按字面交给系统解析（保持通用性，Node/Go sidecar 同样适用）
/// - Python 裸名 → 按「用户配置 → LLP_PYTHON → PATH → 注册表 → 常见位置」探测
pub fn resolve_entry(
    entry: &[String],
    plugin_id: &str,
    log: &dyn Fn(&str, &str),
) -> Result<(String, Vec<String>), PluginError> {
    let (program, args) = entry
        .split_first()
        .ok_or_else(|| PluginError::bad_params("manifest 缺少 backend.entry"))?;
    let program = program.trim();
    let args = args.to_vec();

    if program.contains('/') || program.contains('\\') || !is_python_name(program) {
        return Ok((program.to_string(), args));
    }

    for (cand, source) in ordered_candidates(program) {
        if let Some(path) = resolve_program(&cand) {
            let resolved = path.to_string_lossy().to_string();
            log(
                plugin_id,
                &format!("Python 解释器: {} → {}（{}）", cand, resolved, source),
            );
            return Ok((resolved, args));
        }
    }

    let mut located = registry_pythons();
    located.extend(common_python_locations());
    if let Some(path) = located.into_iter().next() {
        let resolved = path.to_string_lossy().to_string();
        log(
            plugin_id,
            &format!("Python 解释器: {} → {}（本机探测）", program, resolved),
        );
        return Ok((resolved, args));
    }

    Err(PluginError::internal(
        "未找到 Python 解释器。sysinfo 等外部插件需要 Python 3：请在「设置 → Python 环境」\
         填入 python.exe 路径，或安装 Python 3（python.org，勾选 Add python.exe to PATH），\
         也可设置环境变量 LLP_PYTHON。",
    ))
}

/// 列出本机可发现的解释器（设置面板"自动检测"用），已去重并按优先级排序
pub fn detect_candidates() -> Vec<PythonCandidate> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<PythonCandidate> = Vec::new();

    let mut push = |path: PathBuf, source: &str| {
        let p = path.to_string_lossy().to_string();
        if p.trim().is_empty() || !seen.insert(p.to_ascii_lowercase()) {
            return;
        }
        let version = probe_version(&p).ok();
        out.push(PythonCandidate {
            valid: version.is_some(),
            path: p,
            version,
            source: source.to_string(),
        });
    };

    for (cand, source) in ordered_candidates("python3") {
        if let Some(p) = resolve_program(&cand) {
            push(p, source);
        }
    }
    for p in registry_pythons() {
        push(p, "注册表 PEP 514");
    }
    for p in common_python_locations() {
        push(p, "常见安装位置");
    }
    out
}

/// 已配置的路径优先于 PATH/注册表；配置失效时给出原因而不是静默回落
#[cfg(test)]
mod tests {
    use super::*;

    fn no_log() -> impl Fn(&str, &str) {
        |_, _| {}
    }

    #[test]
    fn literal_path_and_non_python_entries_are_used_verbatim() {
        let (prog, args) = resolve_entry(
            &[r"D:\tools\Miniconda3\python.exe".into(), "sysinfo.py".into()],
            "sysinfo",
            &no_log(),
        )
        .unwrap();
        assert_eq!(prog, r"D:\tools\Miniconda3\python.exe");
        assert_eq!(args, vec!["sysinfo.py".to_string()]);

        // 非 Python 裸名（Node/Go sidecar）交给系统 PATH，不做 Python 探测
        let (prog, _) = resolve_entry(&["node".into(), "main.js".into()], "demo", &no_log()).unwrap();
        assert_eq!(prog, "node");
    }

    #[test]
    fn configured_path_wins_and_is_usable() {
        let Some(cand) = detect_candidates().into_iter().find(|c| c.valid) else {
            eprintln!("跳过：本机未发现可用的 Python 解释器");
            return;
        };
        set_configured(Some(cand.path.clone()));
        let (prog, args) =
            resolve_entry(&["python3".into(), "sysinfo.py".into()], "sysinfo", &no_log()).unwrap();
        assert_eq!(prog, cand.path);
        assert_eq!(args, vec!["sysinfo.py".to_string()]);
        assert!(probe_version(&prog).is_ok());

        // 清除配置 → 回落到自动探测，仍应得到可用解释器
        set_configured(None);
        let (prog, _) = resolve_entry(&["python3".into()], "sysinfo", &no_log()).unwrap();
        assert!(probe_version(&prog).is_ok(), "回落解析出的解释器不可用: {}", prog);
    }

    #[test]
    fn probe_rejects_bogus_paths() {
        assert!(probe_version("").is_err());
        assert!(probe_version(r"D:\not-exist\python.exe").is_err());
    }
}

/// 当前生效环境（设置面板状态展示）
#[derive(Debug, Clone, Serialize)]
pub struct PythonEnv {
    /// 用户配置的路径（可能无效）
    pub configured: Option<String>,
    /// 实际会被使用的解释器
    pub path: Option<String>,
    pub version: Option<String>,
    /// 命中来源：用户配置 / 环境变量 LLP_PYTHON / PATH / 注册表 PEP 514 / 常见安装位置
    pub source: String,
    pub available: bool,
    /// 配置路径不可用时的原因
    pub error: Option<String>,
}

/// 解析当前生效的 Python 环境：优先校验用户配置，失败则回落到自动探测
pub fn current_env() -> PythonEnv {
    let configured = configured();
    let mut env = PythonEnv {
        configured: configured.clone(),
        path: None,
        version: None,
        source: "未找到".to_string(),
        available: false,
        error: None,
    };

    if let Some(cfg) = configured {
        match probe_version(&cfg) {
            Ok(v) => {
                env.path = Some(cfg);
                env.version = Some(v);
                env.source = "用户配置".to_string();
                env.available = true;
                return env;
            }
            Err(e) => env.error = Some(format!("配置的解释器不可用：{}", e)),
        }
    }

    for (cand, source) in ordered_candidates("python3") {
        if let Some(p) = resolve_program(&cand) {
            let path = p.to_string_lossy().to_string();
            let version = probe_version(&path).ok();
            env.path = Some(path);
            env.version = version.clone();
            env.source = source.to_string();
            env.available = version.is_some();
            if !env.available {
                env.error = Some("找到的解释器无法执行，请手动指定路径".into());
            }
            return env;
        }
    }

    let mut located = registry_pythons();
    located.extend(common_python_locations());
    for p in located {
        let path = p.to_string_lossy().to_string();
        if let Ok(v) = probe_version(&path) {
            env.path = Some(path);
            env.version = Some(v);
            env.source = "本机探测".to_string();
            env.available = true;
            return env;
        }
    }
    env
}
