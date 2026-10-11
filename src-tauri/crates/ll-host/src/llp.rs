//! LLP/1 —— 外部进程插件支持（M6）
//!
//! 形态：`<data>/LiteLauncher/extplugins/<id>/`（manifest.json + 任意语言 sidecar）
//! 协议：stdio 上的 JSON Lines（每行一个 JSON-RPC 2.0 消息）
//!
//! 宿主 → 插件：
//!   {"jsonrpc":"2.0","id":N,"method":"initialize","params":{"protocol":"LLP/1","pluginId":...}}
//!   {"jsonrpc":"2.0","id":N,"method":"call","params":{"method":"...","params":{...}}}
//!   {"jsonrpc":"2.0","method":"shutdown"}                      （通知，无 id）
//! 插件 → 宿主（反向请求，一切能力经宿主代理并受 manifest 权限门控）：
//!   {"jsonrpc":"2.0","id":M,"method":"svc.db.query","params":{...}}
//!
//! 行为要点：
//! - 懒启动：注册不 spawn，首次 call 才启动（R4：外部插件不进启动关键路径）
//! - 崩溃恢复：进程死亡标记 dead，下次调用重新拉起
//! - 前端同构：宿主从 manifest.command 生成通用 CommandPlugin，与内置插件走同一套契约

use crate::services::LogFn;
use crate::HostState;
use ll_plugin_api::{
    PluginBackend, PluginContext, PluginError, PluginManifest,
};
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

const CALL_TIMEOUT_SECS: u64 = 5;
const INIT_TIMEOUT_SECS: u64 = 3;

pub struct LlpBackend {
    manifest: PluginManifest,
    dir: PathBuf,
    ctx: PluginContext,
    proc_state: Mutex<Option<Arc<LlpProc>>>,
    next_id: AtomicU64,
}

struct LlpProc {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, mpsc::SyncSender<Result<JsonValue, String>>>>,
    dead: AtomicBool,
}

impl LlpBackend {
    pub fn new(manifest: PluginManifest, dir: PathBuf, ctx: PluginContext) -> Self {
        Self {
            manifest,
            dir,
            ctx,
            proc_state: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }

    fn write_line(proc: &LlpProc, value: &JsonValue) -> Result<(), PluginError> {
        let mut stdin = proc
            .stdin
            .lock()
            .map_err(|_| PluginError::internal("插件 stdin 锁不可用"))?;
        writeln!(stdin, "{}", value)
            .and_then(|_| stdin.flush())
            .map_err(|e| {
                proc.dead.store(true, Ordering::Relaxed);
                PluginError::internal(format!("向插件进程写入失败: {}", e))
            })
    }

    /// 发起请求并等待响应（共享的请求/等待逻辑，initialize 与 call 共用）
    fn request(
        proc: &Arc<LlpProc>,
        next_id: &AtomicU64,
        method: &str,
        params: JsonValue,
        timeout: Duration,
    ) -> Result<JsonValue, PluginError> {
        let id = next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(1);
        proc.pending.lock().unwrap().insert(id, tx);
        let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(e) = Self::write_line(proc, &req) {
            proc.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(PluginError::internal(message)),
            Err(_) => {
                proc.pending.lock().unwrap().remove(&id);
                Err(PluginError::internal(format!(
                    "插件响应超时（{}s）: {}",
                    timeout.as_secs(),
                    method
                )))
            }
        }
    }

    /// 懒启动：进程不在或已死则重新拉起，并完成 LLP/1 握手
    fn ensure_spawned(&self) -> Result<Arc<LlpProc>, PluginError> {
        let mut guard = self
            .proc_state
            .lock()
            .map_err(|_| PluginError::internal("插件进程状态锁不可用"))?;
        if let Some(p) = guard.as_ref() {
            if !p.dead.load(Ordering::Relaxed) {
                return Ok(Arc::clone(p));
            }
        }

        let id = self.manifest.id.clone();
        let dir = self.dir.clone();
        let (program, args) = self.resolve_entry().map_err(|e| {
            self.ctx.log.log(&id, &format!("启动插件进程失败: {}", e));
            e
        })?;

        let mut child = Command::new(&program)
            .args(&args)
            .current_dir(&dir) // 工作目录 = 插件目录（脚本以相对路径引用自己的资产）
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                PluginError::internal(format!("启动插件进程失败（{}）: {}", program, e))
            })?;

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let proc = Arc::new(LlpProc {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            dead: AtomicBool::new(false),
        });

        // 读线程：响应分发 + svc.* 反向请求处理；EOF（进程退出）时清理
        {
            let proc2 = Arc::clone(&proc);
            let ctx = self.ctx.clone();
            let plugin_id = id.clone();
            std::thread::spawn(move || reader_loop(proc2, stdout, ctx, plugin_id));
        }
        // stderr 日志线程（防止管道写满导致插件阻塞）
        {
            let log = Arc::clone(&self.ctx.log);
            let plugin_id = id.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().flatten() {
                    log.log(&plugin_id, &format!("[stderr] {}", line));
                }
            });
        }

        // LLP/1 握手：initialize → 插件回显协议版本
        let ack = Self::request(
            &proc,
            &self.next_id,
            "initialize",
            json!({"protocol": "LLP/1", "pluginId": id, "apiVersion": self.manifest.api_version}),
            Duration::from_secs(INIT_TIMEOUT_SECS),
        );
        match ack {
            Ok(v) if v.get("protocol").and_then(|p| p.as_str()) == Some("LLP/1") => {}
            Ok(_) => {
                Self::kill(&proc);
                return Err(PluginError::internal("插件握手失败：协议版本不匹配"));
            }
            Err(e) => {
                Self::kill(&proc);
                return Err(PluginError::internal(format!("插件握手失败: {}", e)));
            }
        }

        self.ctx.log.log(&id, "进程已启动（LLP/1）");
        *guard = Some(Arc::clone(&proc));
        Ok(proc)
    }

    fn kill(proc: &LlpProc) {
        proc.dead.store(true, Ordering::Relaxed);
        if let Ok(mut child) = proc.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// 解析 backend.entry 的解释器与参数（Windows / 无 PATH 场景友好）：
    /// - `LLP_PYTHON` 环境变量显式指定解释器（最高优先级，可为全路径或 PATH 内裸名）
    /// - 裸名 `python3`/`python`/`py` 依次探测 PATH（跳过 Microsoft Store 的 0 字节占位 stub）
    /// - PATH 无果时探测常见安装位置（LOCALAPPDATA\Programs\Python、Program Files\Python、
    ///   C:\Python3x、anaconda3/miniconda3；Unix：/usr/bin、/usr/local/bin、Homebrew）
    /// 非 Python 裸名与含路径分隔符的条目按原行为交给系统解析。
    fn resolve_entry(&self) -> Result<(String, Vec<String>), PluginError> {
        let (program, args) = self
            .manifest
            .backend
            .entry
            .split_first()
            .ok_or_else(|| PluginError::bad_params("manifest 缺少 backend.entry"))?;
        let program = program.trim();
        let args: Vec<String> = args.to_vec();

        // 含路径分隔符 → 按字面使用（current_dir 已是插件目录，相对路径相对插件目录解析）
        if program.contains('/') || program.contains('\\') {
            return Ok((program.to_string(), args));
        }

        let base = program.trim_end_matches(".exe").to_ascii_lowercase();
        let is_py = matches!(base.as_str(), "python3" | "python" | "py");

        let mut candidates: Vec<String> = Vec::new();
        if let Ok(v) = std::env::var("LLP_PYTHON") {
            let v = v.trim().to_string();
            if !v.is_empty() {
                candidates.push(v);
            }
        }
        candidates.push(program.to_string());
        if is_py {
            for name in ["python3", "python", "py"] {
                if candidates
                    .iter()
                    .all(|c| c.trim_end_matches(".exe").to_ascii_lowercase() != name)
                {
                    candidates.push(name.to_string());
                }
            }
        }

        for cand in &candidates {
            if let Some(path) = resolve_program(cand) {
                let resolved = path.to_string_lossy().to_string();
                if !resolved.eq_ignore_ascii_case(cand.as_str()) {
                    self.ctx
                        .log
                        .log(&self.manifest.id, &format!("解释器解析: {} → {}", cand, resolved));
                }
                return Ok((resolved, args));
            }
        }

        if is_py {
            let mut located: Vec<PathBuf> = common_python_locations();
            located.extend(registry_pythons());
            for path in located {
                self.ctx.log.log(
                    &self.manifest.id,
                    &format!(
                        "解释器解析: {} → {}（常见安装位置）",
                        program,
                        path.display()
                    ),
                );
                return Ok((path.to_string_lossy().to_string(), args));
            }
            return Err(PluginError::internal(format!(
                "未找到 Python 解释器（已探测: {}及常见安装位置）。请安装 Python 3（python.org，安装时勾选 Add python.exe to PATH）或设置环境变量 LLP_PYTHON 指向 python.exe 全路径",
                candidates.join(" → "),
            )));
        }

        // 非 Python 裸名：维持原行为，交给系统 PATH 原生解析
        Ok((program.to_string(), args))
    }
}

/// 在 PATH 中探测裸命令（返回命中文件的全路径；含路径分隔符的候选按字面校验存在性）。
/// Windows 下跳过 Microsoft Store 的 0 字节占位 stub（执行只会弹商店页）。
fn resolve_program(name: &str) -> Option<PathBuf> {
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

/// PEP 514：Windows 上 Python 发行版会在注册表登记安装路径（python.org/conda/uv 等均遵守）。
/// 探测 HKCU/HKLM 的 Software\Python\<Brand>\<Tag>\InstallPath，按版本号降序返回 sys\python.exe。
#[cfg(target_os = "windows")]
fn registry_pythons() -> Vec<PathBuf> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};

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
                // PEP 514：安装目录是 InstallPath 子键的默认值；ExecutablePath 在该子键内
                let Ok(install_key) = tag_key.open_subkey_with_flags("InstallPath", KEY_READ) else {
                    continue;
                };
                let dir: String = install_key
                    .get_value::<String, _>("")
                    .unwrap_or_default();
                if dir.trim().is_empty() {
                    continue;
                }
                let install = PathBuf::from(dir.trim_end_matches(['\\', '/']));
                let exe: PathBuf = install_key
                    .get_value::<String, _>("ExecutablePath")
                    .map(|s| PathBuf::from(s.trim()))
                    .unwrap_or_else(|_| install.join("python.exe"));
                if exe.is_file() {
                    out.push((tag.to_ascii_lowercase(), exe));
                }
            }
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0)); // 版本号降序
    out.into_iter().map(|(_, p)| p).collect()
}

#[cfg(not(target_os = "windows"))]
fn registry_pythons() -> Vec<PathBuf> {
    Vec::new()
}

/// 无 PATH 可用时按常见安装位置探测 Python（按新到旧排序，命中即返回）
fn common_python_locations() -> Vec<PathBuf> {
    let mut out = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            // python.org 用户安装：%LOCALAPPDATA%\Programs\Python\Python3xx\（版本号倒序）
            let base = local.join("Programs").join("Python");
            if let Ok(rd) = std::fs::read_dir(&base) {
                let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
                dirs.sort_unstable();
                for d in dirs.into_iter().rev() {
                    push_if_file(&mut out, d.join("python.exe"));
                }
            }
            // Microsoft Store 真实解释器（非 0 字节 stub）
            push_if_file(
                &mut out,
                local
                    .join("Microsoft")
                    .join("WindowsApps")
                    .join("python3.exe"),
            );
        }
        // 系统级安装与固定路径
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
        // 用户目录下的发行版（大小写各命名都试）
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let home = PathBuf::from(home);
            for name in ["miniconda3", "Miniconda3", "anaconda3", "Anaconda3"] {
                push_if_file(&mut out, home.join(name).join("python.exe"));
            }
        }
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
    }

    out
}

impl PluginBackend for LlpBackend {
    fn manifest(&self) -> PluginManifest {
        self.manifest.clone()
    }

    /// 注册即就绪（懒启动：进程延迟到首次调用）
    fn init(&self, _ctx: PluginContext) -> Result<(), PluginError> {
        self.ctx.log.log(
            &self.manifest.id,
            &format!(
                "外部插件已注册（LLP，懒启动）：{}",
                self.manifest.backend.entry.join(" ")
            ),
        );
        Ok(())
    }

    fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, PluginError> {
        let proc = self.ensure_spawned()?;
        Self::request(
            &proc,
            &self.next_id,
            "call",
            json!({"method": method, "params": params}),
            Duration::from_secs(CALL_TIMEOUT_SECS),
        )
    }

    fn shutdown(&self) {
        if let Ok(guard) = self.proc_state.lock() {
            if let Some(proc) = guard.as_ref() {
                let _ = Self::write_line(proc, &json!({"jsonrpc": "2.0", "method": "shutdown"}));
                Self::kill(proc);
            }
        }
    }
}

/// 读线程主体：响应分发到等待者；svc.* 反向请求经宿主门控句柄代执行
fn reader_loop(proc: Arc<LlpProc>, stdout: ChildStdout, ctx: PluginContext, plugin_id: String) {
    // 字节切行 + 损失式 UTF-8 解码：sidecar 若按本地编码输出（如中文 Windows 管道默认 GBK），
    // lines() 的 Err 会被 flatten 静默吞掉导致响应丢失；这里降级为替换符并记录，不再丢行。
    for chunk in BufReader::new(stdout).split(b'\n') {
        let Ok(raw) = chunk else {
            break;
        };
        let line = String::from_utf8_lossy(&raw);
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<JsonValue>(line) else {
            ctx.log.log(&plugin_id, &format!("[非 JSON 行] {}", line));
            continue;
        };

        if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
            let req_id = msg.get("id").cloned().unwrap_or(JsonValue::Null);
            let params = msg.get("params").cloned().unwrap_or(json!({}));
            let response = match handle_svc(&ctx, method, &params) {
                Ok(v) => json!({"jsonrpc": "2.0", "id": req_id, "result": v}),
                Err(e) => json!({"jsonrpc": "2.0", "id": req_id, "error": {"message": e.to_string()}}),
            };
            if let Err(e) = LlpBackend::write_line(&proc, &response) {
                ctx.log.log(&plugin_id, &format!("svc 响应写入失败: {}", e));
            }
        } else if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
            let result = if let Some(res) = msg.get("result") {
                Ok(res.clone())
            } else if let Some(err) = msg.get("error") {
                Err(err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("插件返回未知错误")
                    .to_string())
            } else {
                Err("畸形响应（缺少 result/error）".to_string())
            };
            if let Some(sender) = proc.pending.lock().unwrap().remove(&id) {
                let _ = sender.send(result);
            }
        }
    }

    // 进程退出：置死标记 + 唤醒全部等待者
    proc.dead.store(true, Ordering::Relaxed);
    for (_, tx) in proc.pending.lock().unwrap().drain() {
        let _ = tx.send(Err("插件进程已退出".to_string()));
    }
    ctx.log.log(&plugin_id, "进程已退出");
}

type ChildStdout = std::process::ChildStdout;

/// 反向服务分发：外部插件没有任何宿主句柄，svc.* 全部经门控 PluginContext 代理
fn handle_svc(ctx: &PluginContext, method: &str, params: &JsonValue) -> Result<JsonValue, PluginError> {
    let p_str = |key: &str| params.get(key).and_then(|v| v.as_str()).map(String::from);
    let p_arr = |key: &str| -> Vec<JsonValue> {
        params.get(key).and_then(|v| v.as_array()).cloned().unwrap_or_default()
    };

    match method {
        "svc.db.execute" => {
            let db = ctx
                .db
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("db"))?;
            let sql = p_str("sql").ok_or_else(|| PluginError::bad_params("缺少 sql"))?;
            let affected = db.execute(&sql, &p_arr("params"))?;
            Ok(json!(affected))
        }
        "svc.db.query" => {
            let db = ctx
                .db
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("db"))?;
            let sql = p_str("sql").ok_or_else(|| PluginError::bad_params("缺少 sql"))?;
            let rows = db.query(&sql, &p_arr("params"))?;
            Ok(JsonValue::Array(rows))
        }
        "svc.notify.send" => {
            let notify = ctx
                .notify
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("notifications"))?;
            let title = p_str("title").ok_or_else(|| PluginError::bad_params("缺少 title"))?;
            let body = p_str("body").ok_or_else(|| PluginError::bad_params("缺少 body"))?;
            notify.send(&title, &body)?;
            Ok(JsonValue::Null)
        }
        "svc.process.launch" => {
            let process = ctx
                .process
                .as_ref()
                .ok_or_else(|| PluginError::permission_denied("process"))?;
            let target = p_str("target").ok_or_else(|| PluginError::bad_params("缺少 target"))?;
            process.launch(&target)?;
            Ok(JsonValue::Null)
        }
        "svc.settings.get" => {
            let key = p_str("key").ok_or_else(|| PluginError::bad_params("缺少 key"))?;
            Ok(match ctx.settings.get(&key) {
                Some(v) => json!(v),
                None => JsonValue::Null,
            })
        }
        "svc.settings.set" => {
            let key = p_str("key").ok_or_else(|| PluginError::bad_params("缺少 key"))?;
            let value = p_str("value").ok_or_else(|| PluginError::bad_params("缺少 value"))?;
            ctx.settings.set(&key, &value)?;
            Ok(JsonValue::Null)
        }
        "svc.log.write" => {
            let level = p_str("level").unwrap_or_else(|| "info".into());
            let message = p_str("message").unwrap_or_default();
            ctx.log.log(&level, &message);
            Ok(JsonValue::Null)
        }
        _ => Err(PluginError::unknown_method(method)),
    }
}

impl HostState {
    /// 扫描外部插件目录列表，把 kind=llp 的注册进宿主（M6/M7 门控模型与内置一致）。
    ///
    /// 支持两级部署（`dirs` 按优先级排序，**先到先得**——调用方应把高优先级放前面）：
    /// 1. 用户安装目录 extplugins/（同名覆盖随程序分发的版本）
    /// 2. 便携目录 <主程序目录>/plugins/（随程序分发，绿色部署）
    /// 返回注册数量。
    pub fn register_external_plugins(&self, dirs: &[(PathBuf, String)], log: LogFn) -> usize {
        let core_db = match self.core_db.read().unwrap().clone() {
            Some(db) => db,
            None => return 0,
        };
        let registry = self.db_registry.read().unwrap().clone();

        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut count = 0;

        for (dir, source_label) in dirs {
            let entries = match std::fs::read_dir(dir) {
                Ok(e) => e,
                Err(_) => continue, // 目录不存在 = 该来源无插件
            };
            for item in entries.flatten() {
                let plugin_dir = item.path();
                let manifest_path = plugin_dir.join("manifest.json");
                if !manifest_path.is_file() {
                    continue;
                }
                let manifest = match std::fs::read_to_string(&manifest_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<PluginManifest>(&s).ok())
                {
                    Some(m) => m,
                    None => {
                        (log)(
                            &plugin_dir
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_default(),
                            &format!("外部插件 manifest.json 解析失败（{}），已跳过", source_label),
                        );
                        continue;
                    }
                };
                if manifest.backend.kind != "llp" {
                    continue; // 内置形态的 manifest 不属于外部插件目录
                }
                // 同 id 去重：高优先级来源先注册，低优先级静默跳过
                if !seen.insert(manifest.id.clone()) {
                    (log)(
                        &manifest.id,
                        &format!("已在更高优先级来源加载，跳过 {} 副本", source_label),
                    );
                    continue;
                }
                if self.plugins.read().unwrap().contains_key(&manifest.id) {
                    (log)(&manifest.id, "外部插件 id 与内置插件冲突，已跳过");
                    continue;
                }

                let plugin_conn = registry.as_ref().and_then(|r| r.cached(&manifest.id).ok());
                let ctx = crate::build_context_from_parts(
                    self.app.read().unwrap().as_ref(),
                    &manifest,
                    plugin_conn,
                    Arc::clone(&core_db),
                    Arc::clone(&log),
                );
                (log)(&manifest.id, &format!("来源: {}", source_label));
                self.register(Arc::new(LlpBackend::new(manifest, plugin_dir, ctx)));
                count += 1;
            }
        }

        if count > 0 {
            (log)("host", &format!("已注册 {} 个外部插件（LLP）", count));
        }
        count
    }
}
