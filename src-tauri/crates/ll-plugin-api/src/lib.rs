//! ll-plugin-api —— LiteLauncher 插件标准（LPS-1）的类型定义 crate
//!
//! 只含 trait 与数据结构，零业务实现。所有依赖方向只能指向本 crate：
//! - ll-host 依据 manifest 构造门控 PluginContext 并分发调用
//! - 插件 crate 实现 PluginBackend，仅通过 PluginContext 使用宿主服务

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::sync::Arc;

// ─────────────────────────────────────────────────────────────────────────────
// 错误
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginErrorCode {
    /// 未知方法名（未在插件 call 分发表中注册）
    UnknownMethod,
    /// 参数缺失或类型不符
    BadParams,
    /// 插件已被禁用
    Disabled,
    /// 权限未声明（句柄为 None 时调用对应能力）
    PermissionDenied,
    /// 数据库操作失败
    Db,
    /// 窗口服务失败
    Window,
    /// 通知服务失败
    Notify,
    /// 其他内部错误
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginError {
    pub code: PluginErrorCode,
    pub message: String,
}

impl PluginError {
    pub fn new(code: PluginErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn unknown_method(method: &str) -> Self {
        Self::new(PluginErrorCode::UnknownMethod, format!("未知方法: {}", method))
    }
    pub fn bad_params(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::BadParams, message)
    }
    pub fn disabled() -> Self {
        Self::new(PluginErrorCode::Disabled, "插件已禁用")
    }
    pub fn permission_denied(what: &str) -> Self {
        Self::new(
            PluginErrorCode::PermissionDenied,
            format!("manifest 未声明权限: {}", what),
        )
    }
    pub fn db(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::Db, message)
    }
    pub fn window(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::Window, message)
    }
    pub fn notify(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::Notify, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::Internal, message)
    }
}

impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for PluginError {}

// ─────────────────────────────────────────────────────────────────────────────
// 插件清单（manifest）
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    /// 插件唯一 id（小写，用作 db/目录/窗口标签/设置键命名空间）
    pub id: String,
    pub name: String,
    pub version: String,
    /// 兼容的 LPS 大版本，如 "^1"
    pub api_version: String,
    /// 指令触发前缀，如 "/todo"
    pub trigger: String,
    /// 声明的权限：db / windows / notifications / settings …（§4.5 服务目录）
    #[serde(default)]
    pub permissions: Vec<String>,
    /// 插件可打开的窗口视图
    #[serde(default)]
    pub views: Vec<ViewSpec>,
    /// 插件声明设置项（后续由设置中心自动渲染）
    #[serde(default)]
    pub settings: Vec<SettingSpec>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WindowPosition {
    #[default]
    Center,
    BottomRight,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExistingPolicy {
    #[default]
    Focus,
    Replace,
}

/// 窗口视图规格：宿主 WindowApi 依据它创建窗口（声明式，插件不接触 WebviewWindowBuilder）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewSpec {
    pub id: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub min_width: Option<f64>,
    #[serde(default)]
    pub min_height: Option<f64>,
    #[serde(default = "default_true")]
    pub resizable: bool,
    #[serde(default = "default_true")]
    pub decorated: bool,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub skip_taskbar: bool,
    /// false 时创建窗口不抢焦点
    #[serde(default = "default_true")]
    pub focusable: bool,
    #[serde(default)]
    pub position: WindowPosition,
    /// 多实例向上堆叠（配合 unique_by 的弹窗场景）
    #[serde(default)]
    pub stacked: bool,
    /// 依据该参数值生成每实例唯一窗口标签（如弹窗的 "id"）
    #[serde(default)]
    pub unique_by: Option<String>,
    /// 该参数存在时窗口标题变为 `"<title> - <参数值>"`（如编辑器的 "path"）
    #[serde(default)]
    pub title_param: Option<String>,
    /// 窗口已存在时的策略：focus（管理面板）| replace（提醒弹窗重触发）
    #[serde(default)]
    pub on_existing: ExistingPolicy,
    /// 参数名（单位秒）→ 宿主兜底定时关闭该窗口
    #[serde(default)]
    pub fallback_close_param: Option<String>,
    /// 兜底关闭的额外宽限秒数
    #[serde(default)]
    pub fallback_close_grace_secs: Option<u64>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingSpec {
    /// 插件内键名（宿主自动加 `${pluginId}.` 前缀）
    pub key: String,
    pub label: String,
    /// number / boolean / string
    pub kind: String,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
}

// ─────────────────────────────────────────────────────────────────────────────
// 核心事件
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub enum CoreEvent {
    /// M3 SchedulerService 的统一节拍（当前各插件自持调度线程）
    SchedulerTick,
    /// 宿主即将停用/退出
    Shutdown,
}

// ─────────────────────────────────────────────────────────────────────────────
// 门控服务句柄（ll-host 提供实现；权限未声明则对应字段为 None）
// ─────────────────────────────────────────────────────────────────────────────

/// 插件专属数据库 API（M1 指向核心库，M3 拆分为 plugins/<id>/<id>.db 独立文件）
/// API 面刻意收窄：仅参数化 DML/查询与显式 migrate，禁 ATTACH，路径不可见
pub trait DbApi: Send + Sync {
    /// 建表/迁移：仅 DDL，幂等由插件自理（IF NOT EXISTS / user_version）
    fn migrate(&self, statements: &[&str]) -> Result<(), PluginError>;
    /// 参数化写：仅放行 INSERT/UPDATE/DELETE/REPLACE，返回受影响行数
    fn execute(&self, sql: &str, params: &[JsonValue]) -> Result<u64, PluginError>;
    /// 参数化读：仅放行 SELECT/WITH，返回按列名组织的 JSON 行数组
    fn query(&self, sql: &str, params: &[JsonValue]) -> Result<Vec<JsonValue>, PluginError>;
}

/// 窗口服务：插件打开 manifest 中声明的视图，参数透传为页面查询串
pub trait WindowApi: Send + Sync {
    fn open(&self, view_id: &str, params: &[(String, String)]) -> Result<(), PluginError>;
}

/// 系统通知
pub trait NotifyApi: Send + Sync {
    fn send(&self, title: &str, body: &str) -> Result<(), PluginError>;
}

/// 设置 KV：宿主强制 `${pluginId}.` 前缀隔离（插件无法表达越权键名）
pub trait SettingsApi: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> Result<(), PluginError>;
}

/// 结构化日志（M1 透传到宿主生命周期日志）
pub trait LogApi: Send + Sync {
    fn log(&self, level: &str, msg: &str);
}

/// 受控进程服务：宿主执行安全校验与平台启动策略（§4.5 process/opener）
pub trait ProcessApi: Send + Sync {
    /// 启动外部程序/文档/URL：宿主按平台策略决定直接 spawn 或交系统打开器，
    /// 并执行注入校验（禁止管道/重定向等 Shell 元字符）。成功即返回，不等待子进程。
    fn launch(&self, target: &str) -> Result<(), PluginError>;
}

// ─────────────────────────────────────────────────────────────────────────────
// PluginContext 与插件 trait
// ─────────────────────────────────────────────────────────────────────────────

/// 宿主在 init() 时按 manifest 权限注入的服务句柄集合
#[derive(Clone)]
pub struct PluginContext {
    pub db: Option<Arc<dyn DbApi>>,
    pub windows: Option<Arc<dyn WindowApi>>,
    pub notify: Option<Arc<dyn NotifyApi>>,
    pub process: Option<Arc<dyn ProcessApi>>,
    pub settings: Arc<dyn SettingsApi>,
    pub log: Arc<dyn LogApi>,
}

/// 插件后端统一契约（对应设计文档 §4.3）
pub trait PluginBackend: Send + Sync {
    fn manifest(&self) -> PluginManifest;
    /// 宿主启动或重新启用时调用：完成自检、建表、启动内部线程等
    fn init(&self, ctx: PluginContext) -> Result<(), PluginError>;
    /// 统一方法分发入口（前端经 plugin_call 通道到达）
    fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, PluginError>;
    fn on_core_event(&self, _ev: CoreEvent) {}
    /// 宿主停用插件或退出时调用：停内部线程、释放资源
    fn shutdown(&self) {}
}
