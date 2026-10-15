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
use crate::{python, HostState};
use ll_plugin_api::{
    PluginBackend, PluginContext, PluginError, PluginManifest,
};
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
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
        // 解释器解析统一在 python 模块：用户配置 > LLP_PYTHON > PATH > 注册表 > 常见位置
        let plugin_log = Arc::clone(&self.ctx.log);
        let (program, args) = python::resolve_entry(
            &self.manifest.backend.entry,
            &id,
            &|plugin, msg| plugin_log.log(plugin, msg),
        )
        .map_err(|e| {
            self.ctx.log.log(&id, &format!("启动插件进程失败: {}", e));
            e
        })?;

        let mut child = python::hide_console(Command::new(&program))
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
            // sidecar 走 stdin 进来，没有"发起调用的窗口"这一说 → caller=None，
            // 依赖窗口身份的 svc 方法（setContentSize）会在宿主侧被明确拒绝
            let response = match crate::services::dispatch_svc(&ctx, method, &params, None) {
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

// ─────────────────────────────────────────────────────────────────────────────
// SvcBackend —— `backend.kind = "none"` 的纯前端插件后端（设计文档 §4.6）
//
// 这类插件没有 Rust crate、也没有 sidecar：它的全部业务逻辑都在 `plugins/<id>/fe`
// 的单文件 TS 里，除了宿主保留方法名空间 `svc.*` 之外不依赖任何后端能力。
// 因此后端只需把 `svc.*` 原样转给统一分发器；非 `svc.*` 方法视为插件作者笔误。
//
// 保留这类后端实体（而不是让 plugin_call 直接短路）的好处：
//   - 与内置/LLP 插件共用同一张注册表 → plugin_list / 设置面板启用禁用天然可用
//   - 权限门控仍由 manifest 声明驱动，不因"没有后端"而放宽
// ─────────────────────────────────────────────────────────────────────────────

pub struct SvcBackend {
    manifest: PluginManifest,
    ctx: PluginContext,
}

impl SvcBackend {
    pub fn new(manifest: PluginManifest, ctx: PluginContext) -> Self {
        Self { manifest, ctx }
    }
}

impl PluginBackend for SvcBackend {
    fn manifest(&self) -> PluginManifest {
        self.manifest.clone()
    }

    fn init(&self, _ctx: PluginContext) -> Result<(), PluginError> {
        self.ctx.log.log(
            &self.manifest.id,
            "纯前端插件已注册（kind=none，逻辑随前端包分发）",
        );
        Ok(())
    }

    fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, PluginError> {
        if !method.starts_with("svc.") {
            return Err(PluginError::unknown_method(method));
        }
        // 纯前端插件的后端只是转发器：调用者是插件自己的 Rust/测试代码而非某个窗口，
        // 所以没有窗口身份可传（caller=None）
        crate::services::dispatch_svc(&self.ctx, method, &params, None)
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
                let is_svc_only = manifest.backend.kind == "none";
                if manifest.backend.kind != "llp" && !is_svc_only {
                    continue; // builtin 形态的 manifest 不属于外部插件目录
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
                if is_svc_only {
                    // 纯前端插件（kind=none）：无 sidecar，逻辑在前端包里，后端只应答 svc.*
                    self.register(Arc::new(SvcBackend::new(manifest, ctx)));
                } else {
                    self.register(Arc::new(LlpBackend::new(manifest, plugin_dir, ctx)));
                }
                count += 1;
            }
        }

        if count > 0 {
            (log)("host", &format!("已注册 {} 个外部插件（LLP）", count));
        }
        count
    }
}
