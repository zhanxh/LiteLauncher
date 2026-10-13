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
    /// 资源冲突（如全局热键已被其他插件占用）
    Conflict,
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
    /// 功能描述（/help 与指令候选展示；外部插件必填）
    #[serde(default)]
    pub description: String,
    /// 声明的权限：db / windows / notifications / settings / process / fs …（§4.5）
    #[serde(default)]
    pub permissions: Vec<String>,
    /// 插件可打开的窗口视图
    #[serde(default)]
    pub views: Vec<ViewSpec>,
    /// 插件声明设置项（后续由设置中心自动渲染）
    #[serde(default)]
    pub settings: Vec<SettingSpec>,
    /// 后端形态：builtin（编译期内置，默认）| llp（外部进程，M6 动态加载）
    #[serde(default)]
    pub backend: BackendSpec,
    /// 外部插件（kind=llp）的命令声明：宿主据此生成通用前端指令插件
    #[serde(default)]
    pub command: Option<ExternalCommandSpec>,
}

/// 后端形态声明（M6 LLP：宿主按 entry 启动 sidecar 子进程并经 stdio JSON-RPC 分发）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendSpec {
    /// "builtin"（默认，随宿主编译）| "llp"（外部进程）
    #[serde(default = "default_backend_kind")]
    pub kind: String,
    /// LLP 启动命令，如 ["python3", "main.py"]（相对插件目录解析）
    #[serde(default)]
    pub entry: Vec<String>,
}

impl Default for BackendSpec {
    fn default() -> Self {
        Self { kind: default_backend_kind(), entry: Vec::new() }
    }
}

fn default_backend_kind() -> String {
    "builtin".to_string()
}

/// 外部插件的命令声明：宿主前端据此生成通用 CommandPlugin（无自定义 UI 的 MVP 形态）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalCommandSpec {
    /// 指令图标（emoji/字符）
    #[serde(default = "default_command_icon")]
    pub icon: String,
    /// 进入 Action 模式的二级子命令（回车立即执行 execute）
    #[serde(default)]
    pub action_subcommands: Vec<String>,
    /// Action 模式的操作提示（可选）
    #[serde(default)]
    pub hint: Option<String>,
}

impl Default for ExternalCommandSpec {
    fn default() -> Self {
        Self {
            icon: default_command_icon(),
            action_subcommands: Vec::new(),
            hint: None,
        }
    }
}

fn default_command_icon() -> String {
    "🧩".to_string()
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

/// 密钥库（M7）：核心托管的秘密存储（`secret.<pluginId>.<key>` 命名空间），
/// 插件只能读写**自己的**命名空间；宿主侧保证密钥永不进插件库/插件可读配置
pub trait SecretApi: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> Result<(), PluginError>;
    fn delete(&self, key: &str) -> Result<(), PluginError>;
}

/// 事件通道（M7）：插件向前端窗口推送事件。宿主以 Tauri 事件 `plugin-event` 广播，
/// 载荷自动带 pluginId 命名空间——前端按 id 过滤。用于 AI 流式增量等场景
pub trait EventApi: Send + Sync {
    fn emit(&self, event: &str, payload: JsonValue) -> Result<(), PluginError>;
}

/// 剪贴板（M5）：写入与读取**分别授权**（`clipboard:write` / `clipboard:read`）。
/// 读取可能暴露用户隐私（密码、验证码），故与写入拆成两个权限；
/// 无 GUI 会话（如 headless 启动）时宿主返回 Err，插件应自行降级
pub trait ClipboardApi: Send + Sync {
    /// 写入纯文本（覆盖剪贴板当前内容）
    fn write(&self, text: &str) -> Result<(), PluginError>;
    /// 读取纯文本；剪贴板为空或非文本内容 → Ok(None)
    fn read(&self) -> Result<Option<String>, PluginError>;
}

/// HTTP 请求描述（M7）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HttpRequest {
    /// GET / POST / PUT / DELETE
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
}

/// HTTP 代理（M7）：插件无裸 socket，一切网络经宿主代理；
/// manifest 需声明 `net:<host>` 域名白名单（逐域名精确匹配）
pub trait HttpApi: Send + Sync {
    /// 非流式请求，返回响应体文本
    fn send(&self, req: HttpRequest) -> Result<String, PluginError>;
    /// 流式请求（SSE 等）：逐块回调，回调返回 false 中止读取；返回最终状态码
    fn send_stream(
        &self,
        req: HttpRequest,
        on_chunk: &mut dyn FnMut(&str) -> bool,
    ) -> Result<u16, PluginError>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 屏幕捕获（D 组）：截图与取色
//
// 平台 API（xcap / GDI / CGDisplay …）全部关在 ll-host 里，插件只表达
// "要哪块屏幕 / 哪个点"，坐标一律是**桌面全局物理像素**。
// ─────────────────────────────────────────────────────────────────────────────

/// 显示器描述（`x`/`y` 为桌面全局物理坐标，可为负——副屏位于主屏左侧时）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    /// 序号（0 起，与 `capture` 的 `monitor` 参数一致）
    pub index: usize,
    pub name: String,
    pub primary: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
}

/// 截屏请求
#[derive(Debug, Clone, Default)]
pub struct CaptureRequest {
    /// `None` = 主显示器；`Some(-1)` = 光标所在显示器；`Some(n)` = 第 n 个（0 起）
    pub monitor: Option<i32>,
    /// 目标文件绝对路径（PNG；缺省位置由 `default_screenshot_dir` 决定）
    pub path: std::path::PathBuf,
    /// 为真时宿主先隐藏全部 LiteLauncher 窗口再捕获，收工后复原
    /// （否则启动器自己会被拍进画面——截图工具的基本要求）
    pub hide_windows: bool,
    /// 隐藏后、捕获前的等待毫秒数（让用户收起菜单/移开鼠标），宿主上限 10s
    pub delay_ms: u32,
}

/// 截屏结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureResult {
    /// 落盘路径
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// 实际捕获的显示器序号
    pub monitor: usize,
    /// 文件字节数
    pub bytes: u64,
}

/// 单像素采样（`hex` 为规范大写 `#RRGGBB`）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PixelSample {
    pub x: i32,
    pub y: i32,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    /// `#RRGGBB`（大写）
    pub hex: String,
}

/// 放大镜取样：以 (x, y) 为中心的一片像素方格（行优先）
///
/// 不返回图片而返回颜色数组，是为了让前端用纯 CSS 网格放大——
/// 省掉 PNG 编解码与 base64 往返，且放大后天然是"硬边像素"效果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PixelGrid {
    pub x: i32,
    pub y: i32,
    /// 请求的取样半径（方格边长 = 2r+1，落到屏幕外时会被裁剪）
    pub radius: u32,
    pub cols: u32,
    pub rows: u32,
    /// 行优先的 `#RRGGBB` 数组，长度 = cols * rows
    pub cells: Vec<String>,
    /// 中心像素在 cells 中的下标（= 裁剪后中心所在位置）
    pub center: usize,
}

/// 屏幕捕获（D 组）：manifest 需声明 `screen` 权限。
///
/// 宿主负责多显示器定位、坐标系归一化（物理像素）、PNG 编码落盘与窗口避让；
/// 插件不接触任何平台 API，也无法读取屏幕以外的东西。
pub trait ScreenApi: Send + Sync {
    /// 列出全部显示器（顺序稳定，与 `capture` 的 `monitor` 参数对应）
    fn list_monitors(&self) -> Result<Vec<MonitorInfo>, PluginError>;
    /// 截图并落盘，返回路径与尺寸
    fn capture(&self, req: &CaptureRequest) -> Result<CaptureResult, PluginError>;
    /// 单点取色（x/y 为桌面全局物理坐标）
    fn pixel(&self, x: i32, y: i32) -> Result<PixelSample, PluginError>;
    /// 放大镜取样：以 (x, y) 为中心、边长 2*radius+1 的像素方格
    fn pixel_grid(&self, x: i32, y: i32, radius: u32) -> Result<PixelGrid, PluginError>;
    /// 当前鼠标位置（桌面全局物理坐标）；无 GUI 会话时返回错误
    fn cursor_position(&self) -> Result<(i32, i32), PluginError>;
    /// 本插件截图默认落盘目录（宿主按插件 id 隔离）
    fn default_screenshot_dir(&self) -> std::path::PathBuf;
}

// ─────────────────────────────────────────────────────────────────────────────
// 全局热键（D 组）
//
// 设计文档 §4.5：权限声明为 `shortcut:<accel>`，**逐条白名单、无通配**。
// 热键是"用户在任何界面下都能被唤起"的能力，因此比普通服务更敏感：
// 宿主登记并仲裁冲突（先到先得），触发时以 `plugin-shortcut` 事件回传，
// 由前端 `ctx.shortcuts.on(accel, handler)` 接收——插件拿不到原始按键流。
// ─────────────────────────────────────────────────────────────────────────────

/// 全局热键（注册 / 注销 / 查询）
pub trait ShortcutApi: Send + Sync {
    /// 注册全局热键（accel 形如 `alt+p`；幂等：同一插件重复注册返回 Ok）。
    /// 未在 manifest 声明、或已被其他插件占用 → Err
    fn register(&self, accel: &str) -> Result<(), PluginError>;
    /// 注销本插件注册的热键（未注册则静默成功）
    fn unregister(&self, accel: &str) -> Result<(), PluginError>;
    /// 本插件当前已注册的加速键（规范小写形式）
    fn list(&self) -> Vec<String>;
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
    pub secrets: Option<Arc<dyn SecretApi>>,
    pub http: Option<Arc<dyn HttpApi>>,
    pub clipboard: Option<Arc<dyn ClipboardApi>>,
    /// 屏幕捕获（D 组）：声明 `screen` 权限时才注入
    pub screen: Option<Arc<dyn ScreenApi>>,
    /// 全局热键（D 组）：声明 `shortcut:<accel>` 时才注入
    pub shortcuts: Option<Arc<dyn ShortcutApi>>,
    pub events: Arc<dyn EventApi>,
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
