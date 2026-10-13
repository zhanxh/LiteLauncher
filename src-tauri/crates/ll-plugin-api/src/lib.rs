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
    /// `search` 的防抖毫秒数（缺省 0 = 逐键立即调用）。
    ///
    /// 外部插件走通用 CommandPlugin，壳层同样支持 `queryDebounceMs`；
    /// `/find` 这类"每次按键都要查外部索引"的插件必须声明它，
    /// 否则输入 "Cargo.toml" 会打出 11 次 IPC。
    #[serde(default)]
    pub query_debounce_ms: Option<u32>,
}

impl Default for ExternalCommandSpec {
    fn default() -> Self {
        Self {
            icon: default_command_icon(),
            action_subcommands: Vec::new(),
            hint: None,
            query_debounce_ms: None,
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
    /// 贴屏幕右上角。桌面挂件类小窗常用——用户视线自然落在任务栏附近的角落，
    /// 且右上角通常比右下角少被任务栏图标与托盘干扰。
    TopRight,
    /// 全屏铺满某块显示器（区域框选截图 / 全屏遮罩取色这类"遮罩层"）。
    /// `WindowPosition::Fullscreen(MonitorSelector)` 的序列化形式为字符串。
    Fullscreen(MonitorSelector),
}

/// 是否是"贴边角落"定位（需要建窗后再手动摆位，而不是交给系统）。
///
/// 抽成函数而不是到处 `matches!`：这两个变体在宿主的**两处**分支里都要判断
/// （建窗前设 visible(false) 避免闪烁，建窗后 set_position + show），
/// 漏一处就会出现"窗口在原点闪一下才跳到角落"。
pub fn is_corner_position(pos: WindowPosition) -> bool {
    matches!(pos, WindowPosition::BottomRight | WindowPosition::TopRight)
}

/// 贴边角落的默认边距（逻辑像素）。
pub const CORNER_MARGIN: f64 = 16.0;

/// 算贴边角落窗口的左上角坐标（**逻辑像素**）。
///
/// 抽成纯函数是为了能单测——这段算术一旦写错，症状是"挂件有一半在屏幕外"
/// 或"堆叠的第二个窗口盖住第一个"，都属于真机才能看出来的静默错误。
///
/// `stack_offset` 的方向随角落而变：右下角向上让位（y 减小），右上角向下（y 增大）。
/// 写死正负号会让其中一个角落的堆叠完全错位。
pub fn corner_origin(
    pos: WindowPosition,
    monitor_w: f64,
    monitor_h: f64,
    win_w: f64,
    win_h: f64,
    stack_offset: f64,
) -> Option<(f64, f64)> {
    if !is_corner_position(pos) {
        return None;
    }
    let x = monitor_w - win_w - CORNER_MARGIN;
    let y = match pos {
        WindowPosition::TopRight => CORNER_MARGIN + stack_offset,
        _ => monitor_h - win_h - CORNER_MARGIN - stack_offset,
    };
    Some((x, y))
}

/// 全屏窗口铺在哪块屏
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MonitorSelector {
    /// 主显示器
    Primary,
    /// 光标当前所在的那块屏（多屏用户的本能预期）
    Cursor,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExistingPolicy {
    #[default]
    Focus,
    Replace,
}

/// 桌面层挂载结果（`WindowApi::attach_desktop` 的返回值）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopAttachStatus {
    /// 已挂到壁纸层
    Attached,
    /// 该平台/会话无法实现，调用方应降级为置顶浮窗
    Unsupported {
        /// 面向用户的原因（宿主给出，已含平台名与补救建议）
        reason: String,
    },
    /// 注入失败（外部命令缺失、窗口句柄拿不到等）
    Failed {
        reason: String,
    },
}

/// 桌面层挂载的完整结果。
///
/// `on_wallpaper` 是给 UI 的**唯一判据**：它为 false 时窗口仍会显示
/// （降级为置顶浮窗），但插件必须把"未能贴到壁纸层"如实告知用户，
/// 不能显示成已贴在桌面。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopAttachResult {
    pub status: DesktopAttachStatus,
    #[serde(rename = "onWallpaper")]
    pub on_wallpaper: bool,
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
    /// 窗口背景透明（配合 `position: fullscreen` 做遮罩层）。
    ///
    /// 这是"区域框选截图""全屏遮罩取色"能实现的前提——遮罩层必须能显示
    /// 桌面截图作为底图，否则用户框选时看不到自己框的是哪块内容。
    ///
    /// ⚠️ 使用该声明位的视图窗口，**必须**同步登记到宿主
    /// `src-tauri/capabilities/default.json` 的 `windows` 白名单
    /// （标签 = `<pluginId>-<viewId>`），否则该窗口零权限、
    /// `plugin_call` 被拒、表现为"死窗"。
    #[serde(default)]
    pub transparent: bool,
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

    /// 把已打开的视图窗口挂到桌面壁纸层（桌面小挂件）。
    ///
    /// 与 [`WindowApi::open`] 分开的原因：建窗是**声明式**的（能开哪些窗由
    /// `manifest.views` 限定），而挂壁纸层是对已存在窗口的运行时层级操作，
    /// 两者的风险面不同，插件应能分别表达意图。
    ///
    /// ⚠️ **并非所有平台/会话都支持**，宿主必须如实返回而不能假装成功：
    ///   - Windows：注入 Explorer 的 WorkerW，真壁纸层
    ///   - Linux X11：设 `_NET_WM_WINDOW_TYPE_DESKTOP`
    ///   - **Linux Wayland：做不到**（z-order 由 compositor 独占，应用无权指定）
    ///
    /// 返回 `on_wallpaper=false` 时，插件应降级为置顶浮窗并在 UI 上如实告知用户。
    fn attach_desktop(&self, label: &str) -> Result<DesktopAttachResult, PluginError>;

    /// 当前会话是否支持桌面层（插件可先问，避免白跑一趟并给出预期提示）。
    fn desktop_supported(&self) -> bool;
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
    /// 写入 RGBA 像素图（截图"图片本体"直进剪贴板的主路径）。
    ///
    /// 为什么需要它：文本剪贴板只能塞路径字符串，用户还得自己去文件夹里找图；
    /// 而桌面截图工具的默认交付物是**可直接粘贴的图片**。
    /// 传 RGBA 原始字节而非 PNG/base64，是为了让宿主省掉一次编解码与
    /// 约 33% 的体积膨胀（图像此刻已在内存里，本来就是 RGBA）。
    ///
    /// 与 `write` 一样受 `clipboard:write` 门控——图片同样会覆盖用户剪贴板。
    fn write_image(&self, rgba: &[u8], width: u32, height: u32) -> Result<(), PluginError>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 剪贴板历史（P1 `/clip`）
//
// 设计立场（与 Ditto 的公开结论一致）：这类工具的**价值与风险同源**——
// 救回一小时前命令的工具，同样会保存密码、API token、验证码。
// 因此隐私保护不是可选加分项，而是**功能的前置约束**：
//   - 默认排除密码管理器 / 安全输入类应用（进程名黑名单）
//   - 条数上限 + 过期时间，避免无限累积
//   - 数据只落本地插件库，不出网
//   - 提供"暂停监听"，处理凭据时可临时断开
// ─────────────────────────────────────────────────────────────────────────────

/// 剪贴板历史条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipEntry {
    /// 自增 id
    pub id: i64,
    /// 文本内容（超长会被宿主截断）
    pub text: String,
    /// 毫秒时间戳
    pub ts: i64,
}

/// 剪贴板历史的隐私策略（默认值偏保守）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardPolicy {
    /// 保留条数上限（默认 200；Win+V 只有 25）
    pub max_entries: u32,
    /// 单条最大字节数，超出截断
    pub max_bytes: u32,
    /// 过期天数（默认 7），超期记录不再展示
    pub retention_days: u32,
    /// 进程名黑名单（小写子串匹配），命中的来源应用不记录
    pub excluded_apps: Vec<String>,
    /// 是否用启发式跳过疑似密码/Token 的内容
    pub detect_secrets: bool,
}

/// 保守的默认策略：这些是"复制即等于泄露"的高危来源
pub fn default_clipboard_policy() -> ClipboardPolicy {
    ClipboardPolicy {
        max_entries: 200,
        max_bytes: 64 * 1024,
        retention_days: 7,
        excluded_apps: vec![
            "1password".into(),
            "bitwarden".into(),
            "keepass".into(),
            "lastpass".into(),
            "enpass".into(),
            "dashlane".into(),
            "logonui".into(),
            "credential".into(),
            "procmon".into(),
        ],
        detect_secrets: true,
    }
}

/// 疑似秘密内容的启发式判定。
///
/// 刻意**宁可漏记也不错记**：只拦形态明确的（私钥头、key=value 凭据、
/// 超长高熵裸串），不做"看起来像乱码就拦"这类过度判定——否则正常的
/// commit hash、base64 片段、UUID 列表会被大量误伤，用户会觉得功能不可用。
pub fn looks_like_secret(text: &str) -> Option<String> {
    let t = text.trim();
    // 过短不可能是凭据；过长多半是文件内容，一律放行（由 max_bytes 兜底截断）
    if t.len() < 8 || t.len() > 512 {
        return None;
    }
    if t.starts_with("-----BEGIN") && t.contains("PRIVATE KEY") {
        return Some("私钥内容".into());
    }
    let lower = t.to_ascii_lowercase();
    for key in ["password", "passwd", "secret", "api_key", "apikey", "token", "pwd"] {
        if lower.contains(&format!("{}=", key)) || lower.contains(&format!("{}:", key)) {
            return Some(format!("疑似 {} 凭据", key));
        }
    }
    // 长随机串：连续 24+ 位字母数字，典型 API key / JWT 片段形态
    if t
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|seg| seg.len() >= 24)
    {
        return Some("疑似长随机串（可能是 API Key / Token）".into());
    }
    None
}

/// 剪贴板历史服务（`clipboard:history` 权限）
pub trait ClipboardHistoryApi: Send + Sync {
    /// 当前是否正在监听
    fn is_watching(&self) -> bool;
    /// 开/关监听（关则不再新增条目，已有历史保留）
    fn set_watching(&self, on: bool) -> Result<(), PluginError>;
    /// 读取最近 N 条（按时间倒序）
    fn recent(&self, limit: u32) -> Result<Vec<ClipEntry>, PluginError>;
    /// 按关键词搜索历史（大小写不敏感的子串匹配）
    fn search(&self, keyword: &str, limit: u32) -> Result<Vec<ClipEntry>, PluginError>;
    /// 把某条重新写回剪贴板
    fn recall(&self, id: i64) -> Result<(), PluginError>;
    /// 删除某条
    fn remove(&self, id: i64) -> Result<(), PluginError>;
    /// 清空全部历史
    fn clear(&self) -> Result<(), PluginError>;
    /// 生效的隐私配置（供插件如实展示给用户）
    fn policy(&self) -> ClipboardPolicy;
}

/// 宿主实现需要额外暴露的能力（拉当前剪贴板入库）。
///
/// 单独拆一个 trait 而不是塞进上面的 `ClipboardHistoryApi`：上面的 trait 是
/// **插件可见的契约**（插件自己的 Rust 插件会实现它），而"拉取当前剪贴板并
/// 过滤入库"是纯宿主行为，不该出现在插件契约里。
pub trait ClipboardHistoryApiExt: ClipboardHistoryApi {
    /// 读当前剪贴板文本，按隐私策略过滤后入库，返回是否新增了一条
    fn ingest_current(&self) -> Result<bool, PluginError>;
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
    /// 区域框选：(x, y) 为**桌面全局物理**坐标的左上角，(w, h) 为宽高。
    ///
    /// `None` = 整块显示器。跨显示器的选区会按每块屏的边界切分后分别抓取
    /// （见 `ScreenApi::capture`），因为平台 API 一次只能给一块屏的缓冲。
    pub region: Option<Region>,
    /// 为真时把**图片本体**写入剪贴板（RGBA），而不只是落盘。
    ///
    /// 这是桌面截图工具的默认交付物：用户要的是"立刻粘到聊天窗口/文档"，
    /// 而不是"拿到一个路径再去文件夹里找"。仍受 `clipboard:write` 门控。
    pub to_clipboard: bool,
}

/// 区域框选矩形（桌面全局物理像素）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Region {
    pub fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }
}

/// 截屏结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureResult {
    /// 落盘路径
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// 实际捕获的显示器序号（跨屏选区时为选区左上角所在的那块）
    pub monitor: usize,
    /// 文件字节数
    pub bytes: u64,
    /// 图片本体是否已写入剪贴板
    #[serde(default)]
    pub clipboard_image: bool,
    /// 区域框选实际抓到的范围（全局物理坐标）；整屏捕获为 None
    #[serde(default)]
    pub region: Option<CapturedRegion>,
}

/// 已捕获的区域（回传让插件能确认"框到的到底是哪块"）
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CapturedRegion {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// `ScreenApi::save_png` 的结果（前端合成图片的落盘回执）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedImage {
    /// 落盘绝对路径
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// 文件字节数
    pub bytes: u64,
    /// 图片本体是否已进剪贴板（失败时为 false，图片仍在磁盘上）
    pub clipboard_image: bool,
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
    /// 保存一段 PNG 字节到本插件的截图目录，并按需写入图片剪贴板。
    ///
    /// 为什么需要它：前端 Canvas 合成（截图标注、拼图、加水印）的产物是
    /// PNG 字节，而落盘/上剪贴板必须走宿主（插件无文件系统写权限）。
    /// 这是**通用**能力，不专属于截图标注——任何"前端合成图片"场景都能用。
    ///
    /// `to_clipboard` 为真时同时把图片本体写进剪贴板（用户可直接粘贴）。
    fn save_png(&self, png: &[u8], to_clipboard: bool) -> Result<SavedImage, PluginError>;
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
    /// 剪贴板历史（P1 `/clip`）：声明 `clipboard:history` 时才注入。
    /// 与 `clipboard:read` 分开——后者是"读当前一次"，这个是"持续留存全部历史"，
    /// 隐私风险高一个量级，不该用同一个权限蒙混过关。
    ///
    /// 存宿主扩展 trait 而非纯契约 trait：分发器需要调用 `ingest_current`
    ///（插件契约之外的方法），只持 `Arc<dyn ClipboardHistoryApi>` 就得写
    /// unsafe 向下转型——这里刻意不为此牺牲类型安全。
    pub clipboard_history: Option<Arc<dyn ClipboardHistoryApiExt>>,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 1920×1080 主屏，262×88 的挂件，典型场景。
    const MON_W: f64 = 1920.0;
    const MON_H: f64 = 1080.0;
    const WIN_W: f64 = 262.0;
    const WIN_H: f64 = 88.0;

    #[test]
    fn bottom_right_sticks_to_corner() {
        let (x, y) = corner_origin(
            WindowPosition::BottomRight,
            MON_W,
            MON_H,
            WIN_W,
            WIN_H,
            0.0,
        )
        .expect("bottom-right 应参与定位");
        // 右边留 16px 边距，下边留 16px
        assert_eq!(x, MON_W - WIN_W - CORNER_MARGIN);
        assert_eq!(y, MON_H - WIN_H - CORNER_MARGIN);
    }

    #[test]
    fn top_right_sticks_to_top() {
        let (x, y) =
            corner_origin(WindowPosition::TopRight, MON_W, MON_H, WIN_W, WIN_H, 0.0)
                .expect("top-right 应参与定位");
        assert_eq!(x, MON_W - WIN_W - CORNER_MARGIN, "右侧仍应留边距");
        assert_eq!(y, CORNER_MARGIN, "顶部应留边距");
    }

    #[test]
    fn corner_right_edge_is_never_outside_monitor() {
        for pos in [WindowPosition::TopRight, WindowPosition::BottomRight] {
            let (x, _) = corner_origin(pos, MON_W, MON_H, WIN_W, WIN_H, 0.0).unwrap();
            assert!(
                x + WIN_W <= MON_W,
                "{pos:?} 的右边缘超出屏幕：x={x} w={WIN_W} monitor={MON_W}"
            );
            assert!(x >= 0.0, "{pos:?} 的 x 为负：{x}");
        }
    }

    #[test]
    fn stack_offset_moves_down_from_top_and_up_from_bottom() {
        let step = WIN_H + 8.0;

        let (_, top1) = corner_origin(
            WindowPosition::TopRight,
            MON_W,
            MON_H,
            WIN_W,
            WIN_H,
            step,
        )
        .unwrap();
        let (_, top2) = corner_origin(
            WindowPosition::TopRight,
            MON_W,
            MON_H,
            WIN_W,
            WIN_H,
            step * 2.0,
        )
        .unwrap();
        assert!(top2 > top1, "右上角堆叠应向下让位（y 增大）");

        let (_, bot1) = corner_origin(
            WindowPosition::BottomRight,
            MON_W,
            MON_H,
            WIN_W,
            WIN_H,
            step,
        )
        .unwrap();
        let (_, bot2) = corner_origin(
            WindowPosition::BottomRight,
            MON_W,
            MON_H,
            WIN_W,
            WIN_H,
            step * 2.0,
        )
        .unwrap();
        assert!(bot2 < bot1, "右下角堆叠应向上让位（y 减小）");
    }

    #[test]
    fn non_corner_positions_are_not_positioned() {
        // Center / Fullscreen 交给系统或各自的分支，不能被角落逻辑接管
        assert!(corner_origin(WindowPosition::Center, MON_W, MON_H, WIN_W, WIN_H, 0.0).is_none());
        assert!(!is_corner_position(WindowPosition::Center));
    }

    #[test]
    fn position_serializes_as_expected() {
        // manifest 里写的是 kebab-case 字符串，改了枚举名会静默失效
        let json = serde_json::to_string(&WindowPosition::TopRight).unwrap();
        assert_eq!(json, "\"top-right\"");
        let json = serde_json::to_string(&WindowPosition::BottomRight).unwrap();
        assert_eq!(json, "\"bottom-right\"");
        let back: WindowPosition = serde_json::from_str("\"top-right\"").unwrap();
        assert_eq!(back, WindowPosition::TopRight);
    }
}
