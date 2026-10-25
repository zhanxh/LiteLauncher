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
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn unknown_method(method: &str) -> Self {
        Self::new(
            PluginErrorCode::UnknownMethod,
            format!("未知方法: {}", method),
        )
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
    /// 全局热键声明（默认值随插件分发；用户覆盖存宿主设置）
    #[serde(default)]
    pub hotkeys: Vec<HotkeySpec>,
}

/// 插件声明的全局热键
///
/// manifest 只存**默认值 + 语义**：用户改键写宿主 `app_settings`，
/// 升级插件不会覆盖用户偏好。`default` 必须同时出现在
/// `permissions` 的 `shortcut:<accel>` 中（最小权限），用户覆盖不受此限。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeySpec {
    /// 插件内唯一、发布后不可改；设置键与事件路由都用它
    pub id: String,
    /// 默认加速键；空串表示"不注册默认键，仅允许用户在设置里绑定"
    #[serde(default)]
    pub default: String,
    /// 人类可读名称（设置页与 /hotkey 展示）
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub description: String,
    /// `main`（默认，只在启动器主窗响应）| `any`（任意窗口）
    #[serde(default = "default_hotkey_scope")]
    pub scope: String,
    /// 是否允许用户改键
    #[serde(default = "default_true")]
    pub editable: bool,
    /// 是否默认启用（可发布"默认关闭"的热键）
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_hotkey_scope() -> String {
    "main".to_string()
}

/// 归一化加速键：去空白、小写、统一 `+` 分隔（"Alt + P" → "alt+p"）
pub fn normalize_accel(raw: &str) -> String {
    raw.split('+')
        .map(|part| part.trim().to_ascii_lowercase())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("+")
}

impl PluginManifest {
    /// 过滤出可用的热键声明：
    /// - id 合法且插件内唯一
    /// - `default` 非空时必须落在 `shortcut:<accel>` 权限白名单内
    /// - scope 只认 main/any，其余回落 main
    ///
    /// 非法条目**静默跳过**而不是拒载插件：一个热键写错不该让整个插件消失，
    /// 宿主会把跳过原因写进生命周期日志（调用方负责）。
    pub fn valid_hotkeys(&self) -> Vec<HotkeySpec> {
        let mut out: Vec<HotkeySpec> = Vec::new();
        for raw in &self.hotkeys {
            let id = raw.id.trim().to_ascii_lowercase();
            let id_ok = !id.is_empty()
                && id.len() <= 32
                && id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            if !id_ok || out.iter().any(|h| h.id == id) {
                continue;
            }

            let mut spec = raw.clone();
            spec.id = id;
            spec.default = normalize_accel(&spec.default);
            if !spec.default.is_empty() {
                let perm = format!("shortcut:{}", spec.default);
                if !self.permissions.iter().any(|p| p == &perm) {
                    continue;
                }
            }
            spec.scope = if spec.scope.eq_ignore_ascii_case("any") {
                "any".to_string()
            } else {
                "main".to_string()
            };
            if spec.label.trim().is_empty() {
                spec.label = spec.id.clone();
            }
            out.push(spec);
        }
        out
    }
}

/// 后端形态声明（M6 LLP：宿主按 entry 启动 sidecar 子进程并经 stdio JSON-RPC 分发）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendSpec {
    /// "builtin"（默认，随宿主编译）| "llp"（外部进程）| "native"（动态库，M1）| "none"（纯前端）
    #[serde(default = "default_backend_kind")]
    pub kind: String,
    /// LLP 启动命令，如 ["python3", "main.py"]；native 为单个动态库文件名如 ["echo.dll"]
    /// （相对插件目录解析）
    #[serde(default)]
    pub entry: Vec<String>,
    /// 完整性校验（M4）：动态库的 sha256，形如 "sha256:<64 位十六进制>"。
    /// 声明后加载时强制校验，不匹配即拒载；未声明 → 允许加载但记一条提醒日志。
    /// 计算对象是 entry 指向的动态库文件字节（源码/资产不参与）。
    #[serde(default)]
    pub integrity: Option<String>,
}

/// 当前平台的 native 动态库后缀（manifest `backend.entry` 按它挑选）
///
/// 为什么不靠 `entry.first()`：同一个插件目录可能同时带 Windows 与 Linux 产物
/// （便携包、双平台 CI），字面名写死哪个平台另一个就加载不了。
pub const fn native_lib_suffix() -> &'static str {
    if cfg!(windows) {
        ".dll"
    } else if cfg!(target_os = "macos") {
        ".dylib"
    } else {
        ".so"
    }
}

impl BackendSpec {
    /// 从 `entry` 里挑出当前平台要 dlopen 的文件名。
    ///
    /// 规则：先找**后缀匹配且存在**的（`.dll` / `.so` / `.dylib`），没有就退回第一个存在的。
    /// - 单平台老 manifest（只写 `find.dll`）行为不变——后缀匹配命中就是它；
    /// - 双平台 manifest（`["find.dll", "libfind.so"]`）各自选各的；
    /// - 后缀都不匹配但目录里确实有产物时（开发者跨平台手动拷），也不拦着。
    ///
    /// `exists` 由调用方注入（宿主传“插件目录里该文件存在”），逻辑本身可单测。
    pub fn pick_library(&self, suffix: &str, exists: impl Fn(&str) -> bool) -> Option<&str> {
        self.entry
            .iter()
            .find(|e| e.to_ascii_lowercase().ends_with(suffix) && exists(e))
            .or_else(|| self.entry.iter().find(|e| exists(e)))
            .map(String::as_str)
    }
}

impl Default for BackendSpec {
    fn default() -> Self {
        Self {
            kind: default_backend_kind(),
            entry: Vec::new(),
            integrity: None,
        }
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

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WindowPosition {
    #[default]
    Center,
    BottomRight,
    /// 贴屏幕右上角。桌面挂件类小窗常用——用户视线自然落在任务栏附近的角落，
    /// 且右上角通常比右下角少被任务栏图标与托盘干扰。
    TopRight,
    /// 全屏铺满某块显示器（区域框选截图 / 全屏遮罩取色这类"遮罩层"）。
    /// manifest 里可写成 `"fullscreen"`（缺省取光标所在屏）或
    /// `{"fullscreen":"primary"}`（显式指定）。
    Fullscreen(MonitorSelector),
}

/// 手写 Deserialize：**必须**同时接受 `"fullscreen"` 与 `{"fullscreen":"cursor"}`。
///
/// serde 对 `Fullscreen(MonitorSelector)` 这种带数据的变体，默认只认外部标记形式
/// `{"fullscreen":"cursor"}`；而 manifest 里最自然的写法是裸字符串 `"fullscreen"`
/// （`/shot` 的区域框选遮罩层就是这么写的）。只认前者会让**整份 manifest 解析失败**，
/// 宿主只能把插件静默跳过；运行期再调 `svc.screen.*` 时退回 `shell_safe_manifest`，
/// 用户看到的是一句极具误导性的"manifest 未声明权限: screen"。
impl<'de> Deserialize<'de> for WindowPosition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        /// 裸字符串形态（manifest 的常规写法）
        #[derive(Deserialize)]
        #[serde(rename_all = "kebab-case")]
        enum Bare {
            Center,
            BottomRight,
            TopRight,
            /// 不带选择器 → 铺在光标所在屏（多屏用户的本能预期）
            Fullscreen,
        }

        /// 显式带选择器的形态：`{"fullscreen":"primary"|"cursor"}`
        #[derive(Deserialize)]
        #[serde(rename_all = "kebab-case")]
        enum Tagged {
            Fullscreen(MonitorSelector),
        }

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Bare(Bare),
            Tagged(Tagged),
        }

        Ok(match Repr::deserialize(deserializer)? {
            Repr::Bare(Bare::Center) => WindowPosition::Center,
            Repr::Bare(Bare::BottomRight) => WindowPosition::BottomRight,
            Repr::Bare(Bare::TopRight) => WindowPosition::TopRight,
            Repr::Bare(Bare::Fullscreen) => WindowPosition::Fullscreen(MonitorSelector::Cursor),
            Repr::Tagged(Tagged::Fullscreen(sel)) => WindowPosition::Fullscreen(sel),
        })
    }
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

/// 内容驱动高度窗口的尺寸区间（宿主夹取插件上报高度的唯一依据）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PopupPolicy {
    pub min_h: f64,
    pub max_h: f64,
}

/// 未声明 `min_height` 时，`auto_height` 窗口还能继续往上缩的下限。
///
/// 不能取视图的声明高度：那正是 GTK 200×200 下限修正踩的坑
/// （`ll-host::clamp_gtk_child_min_size` 一旦回退到 `spec.height`，
/// 短内容的窗口在 Linux 上就再也缩不回去了）。
pub const POPUP_MIN_H_FLOOR: f64 = 96.0;

/// 未声明 `max_height` 时的内容增长上限（逻辑像素）
pub const POPUP_MAX_H_DEFAULT: f64 = 720.0;

/// 归一化 `auto_height` 视图的尺寸区间；非 `auto_height` 返回 `Ok(None)`。
///
/// `Err` 只留给"这两个声明凑不出一个能用的窗口"的组合。区间反向时不报错而是
/// 收敛到上限：`min > max` 的症状是 `set_size` 被 min 夹住、插件看着在缩而窗口不动，
/// 属于静默失效，宁可让窗口"装得下内容"也别留一个夹不动的尺寸。
pub fn popup_policy(spec: &ViewSpec, mon_h: f64) -> Result<Option<PopupPolicy>, String> {
    if !spec.auto_height {
        return Ok(None);
    }
    if matches!(spec.position, WindowPosition::Fullscreen(_)) {
        return Err("auto_height 不能与 position: fullscreen 同时声明".to_string());
    }
    let finite = |v: Option<f64>| v.filter(|n| n.is_finite() && *n > 0.0);
    let screen_cap = (mon_h - 2.0 * CORNER_MARGIN).max(1.0);
    let max_h = finite(spec.max_height)
        .unwrap_or(POPUP_MAX_H_DEFAULT)
        .min(screen_cap);
    let min_h = finite(spec.min_height).unwrap_or(POPUP_MIN_H_FLOOR);
    Ok(Some(PopupPolicy {
        min_h: min_h.min(max_h),
        max_h,
    }))
}

/// 内容尺寸变化后窗口该落在哪儿（四个数与返回值全是**逻辑像素**）。
///
/// 锚的是**当前矩形的边**，不是重算显示器边缘：用户把窗口拖到屏幕中间之后，
/// 按角落公式重算会把它一把拽回角落——这个回归比原来的系统标题栏更糟。
///
/// - 高度：`center` / `top-right` 钉顶边（标题行就是拖拽区，它不能自己跑掉），
///   `bottom-right` 钉底边（提醒卡向上生长才不会顶出屏幕）。
/// - 宽度：角落窗钉右边缘（pomo 挂件向左生长，理由见 `plugins/pomo/fe/src/hover-size.ts`），
///   `center` 钉水平中心。
///
/// 和 [`corner_origin`] 一样留在 `ll-plugin-api` 是为了能单测：这段算术写错的
/// 症状是"窗口跑到屏幕外"或"拖拽区跳走"，只有真机才看得出来。
pub fn popup_rect_after_size(
    pos: WindowPosition,
    mon_w: f64,
    mon_h: f64,
    cur: (f64, f64, f64, f64),
    want: (f64, f64),
    policy: PopupPolicy,
) -> (f64, f64, f64, f64) {
    let (cx, cy, cw, ch) = cur;
    // 任一输入不可信就原样返回：把 NaN 送进 set_size 会留下一个畸形矩形
    if !cx.is_finite()
        || !cy.is_finite()
        || !cw.is_finite()
        || !ch.is_finite()
        || !want.0.is_finite()
        || !want.1.is_finite()
        || !mon_w.is_finite()
        || !mon_h.is_finite()
    {
        return cur;
    }
    let w = want.0.clamp(1.0, (mon_w - 2.0 * CORNER_MARGIN).max(1.0));
    let h = want.1.clamp(policy.min_h, policy.max_h.max(policy.min_h));
    let x = match pos {
        WindowPosition::TopRight | WindowPosition::BottomRight => cx + cw - w,
        WindowPosition::Center => cx + (cw - w) / 2.0,
        WindowPosition::Fullscreen(_) => cx,
    };
    let y = match pos {
        WindowPosition::BottomRight => cy + ch - h,
        _ => cy,
    };
    (
        keep_in_screen(x, w, mon_w),
        keep_in_screen(y, h, mon_h),
        w,
        h,
    )
}

/// 把窗口的一条轴夹回 `[CORNER_MARGIN, 屏 - 尺寸 - CORNER_MARGIN]`。
/// 窗口比屏幕还大时退化为贴边距，而不是产出一个反向区间把坐标推到负值。
fn keep_in_screen(v: f64, size: f64, mon: f64) -> f64 {
    let hi = (mon - size - CORNER_MARGIN).max(CORNER_MARGIN);
    v.clamp(CORNER_MARGIN, hi)
}

/// 视图窗口的标签：`<pluginId>-<viewId>[-<unique 值哈希>]`。
///
/// 建窗和"这个标签归不归这个视图"的校验**必须共用这一个函数**：两边各写一遍，
/// 任何一次格式调整都会让校验放行不该放行的窗口，或者把自己的窗口判成别人的
/// （症状是 `setContentSize` 静默失败，高度再也不跟随内容）。
pub fn window_label(plugin_id: &str, view_id: &str, unique: Option<&str>) -> String {
    match unique {
        Some(v) => format!("{}-{}-{}", plugin_id, view_id, v),
        None => format!("{}-{}", plugin_id, view_id),
    }
}

/// `label` 是否确实由 `plugin_id` 的 `spec` 视图创建（宿主据此拒绝跨窗越权）。
pub fn label_matches_view(plugin_id: &str, spec: &ViewSpec, label: &str) -> bool {
    let exact = window_label(plugin_id, &spec.id, None);
    if label == exact {
        return true;
    }
    // 只有声明了 unique_by 的视图才可能带实例后缀，且后缀必须非空：
    // "todo-detailx" 不能匹配视图 "detail"。
    spec.unique_by.is_some()
        && label.len() > exact.len() + 1
        && label.starts_with(&format!("{exact}-"))
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
    Failed { reason: String },
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

/// [`WindowApi::set_content_size`] 的结果：宿主夹取后**真正落到窗口上**的尺寸。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedSize {
    pub width: f64,
    pub height: f64,
    /// 请求尺寸被 `max_height` 截断 → 内容装不下，视图应启用内部滚动
    pub clamped: bool,
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
    /// `auto_height` 视图的硬上限：内容再长也只长到这里，之后由视图内部滚动。
    /// 未声明时取 `POPUP_MAX_H_DEFAULT`，且始终不超过可用屏高。
    #[serde(default)]
    pub max_height: Option<f64>,
    #[serde(default = "default_true")]
    pub resizable: bool,
    #[serde(default = "default_true")]
    pub decorated: bool,
    /// 视图前端来源（M2：native 插件自带前端）。
    /// 缺省 = 宿主内置 SPA（`index.html?view=...`，插件 fe 包静态编译进应用包）；
    /// `"assets"` = 插件目录下的 `fe/` 静态资产，经自定义协议
    /// `ll-plugin://localhost/<pluginId>/index.html?view=...` 加载，
    /// 建窗时注入 `window.__llBridge`（与 plugin_call 同一条权限管线）。
    #[serde(default)]
    pub frontend: Option<String>,
    /// 无边框窗口是否保留系统投影（Windows 上即 tao 的 MARKER_UNDECORATED_SHADOW）。
    ///
    /// Win11 给"带投影的无边框窗口"外圈保留一圈非客户区 insets（DWM 画阴影/边框用），
    /// 并画 1px 浅色系统边框——桌面常驻挂件上就是用户看到的「白色边框」，
    /// 且外框尺寸 ≠ 客户区尺寸。`false` 彻底去掉非客户区（窗口矩形 = 客户区），
    /// 白边与几何歧义一起消失；代价是没有系统投影与系统圆角（窗口为直角）。
    /// 装饰窗上无效果；未声明时取 true 保持既有外观。
    #[serde(default)]
    pub shadow: Option<bool>,
    /// 窗口高度由内容决定（弹出式基窗）。
    ///
    /// 声明它等于把三件事交给宿主：建窗时强制 `resizable(false)`（用户拖框会和
    /// `set_size` 打架）、首帧隐藏到内容量完为止（否则是"空白大窗闪一下才收缩"）、
    /// 以及按 [`popup_rect_after_size`] 的边锚定来改尺寸。
    /// 代价要讲明白：**用户不能再拖边框改大小**，长内容只能靠内部滚动。
    #[serde(default)]
    pub auto_height: bool,
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
    /// 圆角窗口（默认 true）：宿主把窗口设为透明、去掉系统投影，并在 URL 上
    /// 加 `rounded=1`——前端据此用 `var(--radius-window)` 圆角面板填充窗口矩形，
    /// 与 main 启动器同款观感（圆角外透出桌面）。自带前端的 assets 视图需要
    /// 自己给根元素画圆角底（页面读不到宿主的 `rounded=1` 之外的任何约定）。
    /// 全屏遮罩（`transparent: true`）自动忽略本位——铺满屏幕的遮罩圆角没有
    /// 意义；直角常驻挂件（如 pomo）显式声明 `false` 保持整幅直角窗口。
    #[serde(default = "default_true")]
    pub rounded: bool,
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

    /// 把**发起这次调用的那个窗口自己**改成内容尺寸。
    ///
    /// `None` 表示该轴保持不变（pomo 挂件只改宽度、弹出式基窗只改高度）。
    /// 夹取（[`popup_policy`]）、按边锚定（[`popup_rect_after_size`]）、
    /// 物理↔逻辑像素换算全在宿主侧，插件既看不到也改不了别的窗口——
    /// `caller_label` 由 IPC 层从请求里取，不是插件自报的参数。
    ///
    /// 返回的是**实际生效**的尺寸：`clamped == true` 说明内容被上限截断了，
    /// 视图该转而给自己开内部滚动，而不是继续上报更大的高度。
    fn set_content_size(
        &self,
        caller_label: &str,
        width: Option<f64>,
        height: Option<f64>,
    ) -> Result<AppliedSize, PluginError>;

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

    /// 在系统文件管理器中显示目标（定位并选中文件/文件夹）：
    /// Windows `explorer /select`、macOS `open -R`、Linux 打开父目录。
    /// 目标必须已存在；成功即返回，不等待子进程。
    fn reveal(&self, path: &str) -> Result<(), PluginError>;
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
    /// 来源进程 exe 名（小写；旧数据可能为空）
    pub source_app: Option<String>,
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
    for key in [
        "password", "passwd", "secret", "api_key", "apikey", "token", "pwd",
    ] {
        if lower.contains(&format!("{}=", key)) || lower.contains(&format!("{}:", key)) {
            return Some(format!("疑似 {} 凭据", key));
        }
    }
    // 长随机串：连续 24+ 位字母数字，典型 API key / JWT 片段形态
    if t.split(|c: char| !c.is_ascii_alphanumeric())
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
    /// 为真时在结果里带上 `data_url`（`data:image/png;base64,…`）。
    ///
    /// 用途：**前端要立刻把这张图显示出来**（区域框选底图、标注层底图）。
    /// 别指望页面自己 `fetch('file:///…')` 读刚落盘的文件：本地文件对页面是
    /// 跨源资源，WebView2/Chromium 一律拒绝，症状是"遮罩层一片黑、底图永远出不来"。
    /// 把字节顺着这条 IPC 一起带回去，最省事也最不容易踩平台差异。
    pub inline: bool,
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
    /// `inline: true` 时的 PNG data URL（前端可直接塞进 `<img src>`）；未请求则不出现
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
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
    /// 读回本插件截图目录里的 PNG，转成 data URL。
    ///
    /// 为什么不让前端自己读：WebView2 把 `file:///…` 当跨源本地资源，
    /// 页面 fetch 一律失败（症状是底图永远空白）。宿主代读还能顺带把路径
    /// 限制在本插件截图目录内——这不是通用文件读接口。
    fn read_png_data_url(&self, path: &str) -> Result<String, PluginError>;
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

/// 全局热键（注册 / 注销 / 查询 / manifest 声明）
pub trait ShortcutApi: Send + Sync {
    /// 注册全局热键（accel 形如 `alt+p`；幂等：同一插件重复注册返回 Ok）。
    /// 未在 manifest 声明、或已被其他插件占用 → Err
    fn register(&self, accel: &str) -> Result<(), PluginError>;
    /// 注销本插件注册的热键（未注册则静默成功）
    fn unregister(&self, accel: &str) -> Result<(), PluginError>;
    /// 本插件当前已注册的加速键（规范小写形式）
    fn list(&self) -> Vec<String>;

    /// manifest 声明的热键目录（含 effective accel / 注册状态），供 `/hotkey` 读取。
    ///
    /// 默认实现返回空：老宿主/扩展实现不必立刻跟进；壳层会回退到插件自报。
    fn catalog(&self) -> Vec<PluginHotkeyInfo> {
        Vec::new()
    }

    /// 某个 manifest 热键的 effective accel（用户覆盖 > 默认值）。
    fn effective(&self, _hotkey_id: &str) -> Result<String, PluginError> {
        Err(PluginError::unknown_method("shortcut.effective"))
    }
}

/// `/hotkey` 与设置页共用的一行热键信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginHotkeyInfo {
    pub id: String,
    pub label: String,
    pub description: String,
    pub default: String,
    pub accel: String,
    pub scope: String,
    pub enabled: bool,
    pub registered: bool,
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
        let (x, y) = corner_origin(WindowPosition::BottomRight, MON_W, MON_H, WIN_W, WIN_H, 0.0)
            .expect("bottom-right 应参与定位");
        // 右边留 16px 边距，下边留 16px
        assert_eq!(x, MON_W - WIN_W - CORNER_MARGIN);
        assert_eq!(y, MON_H - WIN_H - CORNER_MARGIN);
    }

    #[test]
    fn top_right_sticks_to_top() {
        let (x, y) = corner_origin(WindowPosition::TopRight, MON_W, MON_H, WIN_W, WIN_H, 0.0)
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

        let (_, top1) =
            corner_origin(WindowPosition::TopRight, MON_W, MON_H, WIN_W, WIN_H, step).unwrap();
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

    #[test]
    fn fullscreen_position_accepts_string_and_tagged_forms() {
        // `/shot` 的遮罩层写的是 `"position": "fullscreen"`：只认外部标记形式
        // 会让整份 manifest 解析失败、插件被静默跳过，运行期报"未声明权限: screen"。
        let bare: WindowPosition = serde_json::from_str("\"fullscreen\"").unwrap();
        assert_eq!(bare, WindowPosition::Fullscreen(MonitorSelector::Cursor));

        let tagged: WindowPosition = serde_json::from_str(r#"{"fullscreen":"primary"}"#).unwrap();
        assert_eq!(tagged, WindowPosition::Fullscreen(MonitorSelector::Primary));
    }

    /// 仓库里的真实 manifest 必须全部能解析：manifest 是插件的唯一真相，
    /// 一个认不出的字段值就会让宿主把整个插件静默跳过（用户只看到一句
    /// "manifest 未声明权限: xxx"，排查成本极高）。
    #[test]
    fn repo_plugin_manifests_all_parse() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../plugins");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return; // 脱离仓库的构建环境没有 plugins/，跳过
        };

        let mut bad = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path().join("manifest.json");
            if !path.is_file() {
                continue;
            }
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(e) => {
                    bad.push(format!("{}: 读取失败 {e}", path.display()));
                    continue;
                }
            };
            if let Err(e) = serde_json::from_str::<PluginManifest>(&text) {
                bad.push(format!("{}: {e}", path.display()));
            }
        }

        assert!(
            bad.is_empty(),
            "以下 manifest 解析失败:\n{}",
            bad.join("\n")
        );
    }

    /// 按平台挑动态库：双平台 manifest 各自选各的，单平台老 manifest 行为不变。
    #[test]
    fn pick_library_by_platform_suffix() {
        let spec = |entries: &[&str]| BackendSpec {
            kind: "native".into(),
            entry: entries.iter().map(|s| s.to_string()).collect(),
            integrity: None,
        };
        let exists = |names: &'static [&'static str]| move |e: &str| names.contains(&e);

        // Windows：只拷了 dll
        let dual = spec(&["find.dll", "libfind.so"]);
        assert_eq!(
            dual.pick_library(".dll", exists(&["find.dll"])),
            Some("find.dll")
        );
        // Linux：只拷了 so
        assert_eq!(
            dual.pick_library(".so", exists(&["libfind.so"])),
            Some("libfind.so")
        );
        // 两个都在：各取各的，不靠顺序
        let both = exists(&["find.dll", "libfind.so"]);
        assert_eq!(dual.pick_library(".so", both), Some("libfind.so"));
        assert_eq!(dual.pick_library(".dll", both), Some("find.dll"));
        // 单平台老 manifest
        let old = spec(&["find.dll"]);
        assert_eq!(
            old.pick_library(".dll", exists(&["find.dll"])),
            Some("find.dll")
        );
        // 后缀不匹配但确实有产物（开发者跨平台手拷）：不拦着
        assert_eq!(
            old.pick_library(".so", exists(&["find.dll"])),
            Some("find.dll")
        );
        // 一个都没有
        assert_eq!(dual.pick_library(".dll", exists(&[])), None);
        assert_eq!(spec(&[]).pick_library(".dll", exists(&[])), None);
    }

    /// 后缀常量必须能被 manifest 实际写出来的名字命中（大小写无关，且不依赖顺序）。
    #[test]
    fn suffix_constant_is_what_manifests_declare() {
        let suffix = native_lib_suffix();
        assert!([".dll", ".so", ".dylib"].contains(&suffix));
        let real = format!("libx{}", suffix.to_uppercase());
        let spec = BackendSpec {
            kind: "native".into(),
            entry: vec!["other.bin".into(), real.clone()],
            integrity: None,
        };
        assert_eq!(spec.pick_library(suffix, |_| true), Some(real.as_str()));
    }

    /// 按 manifest 的真实形状造 ViewSpec：字段名一改，这里就红
    fn view(json: &str) -> ViewSpec {
        serde_json::from_str(json).expect("视图声明应能解析")
    }

    const POPUP: &str = r#"{"id":"detail","title":"详情","width":488,"height":420,
        "min_width":420,"min_height":160,"max_height":720,
        "resizable":false,"decorated":false,"auto_height":true}"#;

    #[test]
    fn minimal_view_keeps_old_defaults() {
        // 老 manifest 一个字没改也必须保持原行为，否则是全局回归
        let spec = view(r#"{"id":"a","title":"t","width":100,"height":100}"#);
        assert!(!spec.auto_height, "auto_height 默认关");
        assert!(spec.max_height.is_none(), "max_height 默认无");
        assert!(spec.decorated && spec.resizable);
        assert_eq!(popup_policy(&spec, MON_H).unwrap(), None);
    }

    #[test]
    fn auto_height_policy_uses_declared_band_and_caps_to_screen() {
        let p = popup_policy(&view(POPUP), MON_H).unwrap().expect("已声明");
        assert_eq!((p.min_h, p.max_h), (160.0, 720.0));

        // 未声明 max_height：取默认上限；小屏时以屏高为准，别长出屏幕
        let small = view(r#"{"id":"a","title":"t","width":100,"height":100,"auto_height":true}"#);
        let p = popup_policy(&small, MON_H).unwrap().unwrap();
        assert_eq!((p.min_h, p.max_h), (POPUP_MIN_H_FLOOR, POPUP_MAX_H_DEFAULT));
        let p = popup_policy(&small, 500.0).unwrap().unwrap();
        assert_eq!(p.max_h, 500.0 - 2.0 * CORNER_MARGIN);
        assert_eq!(p.min_h, POPUP_MIN_H_FLOOR);
    }

    #[test]
    fn inverted_min_max_band_collapses_to_max() {
        // min > max 的静默失效是"set_size 被 min 夹住、插件看着在缩而窗口不动"，
        // 所以宁可收敛到上限，也绝不产出反向区间
        let spec = view(
            r#"{"id":"a","title":"t","width":100,"height":100,"auto_height":true,
                "min_height":900,"max_height":300}"#,
        );
        let p = popup_policy(&spec, MON_H).unwrap().unwrap();
        assert!(p.min_h <= p.max_h, "反向区间：{p:?}");
        assert_eq!(p.max_h, 300.0);
        assert_eq!(p.min_h, 300.0);
    }

    #[test]
    fn auto_height_rejects_fullscreen() {
        let spec = view(
            r#"{"id":"a","title":"t","width":100,"height":100,"auto_height":true,
                "position":{"fullscreen":"primary"}}"#,
        );
        assert!(popup_policy(&spec, MON_H).is_err(), "遮罩层不该走内容高度");
    }

    #[test]
    fn center_and_top_right_pin_top_edge() {
        let p = PopupPolicy {
            min_h: 96.0,
            max_h: 720.0,
        };
        for pos in [WindowPosition::Center, WindowPosition::TopRight] {
            let (_, y, _, h) = popup_rect_after_size(
                pos,
                MON_W,
                MON_H,
                (400.0, 200.0, 488.0, 300.0),
                (488.0, 460.0),
                p,
            );
            assert_eq!(y, 200.0, "{pos:?} 长高时顶边（= 拖拽区）不能跑");
            assert_eq!(h, 460.0);
        }
    }

    #[test]
    fn bottom_right_pins_bottom_edge() {
        let p = PopupPolicy {
            min_h: 96.0,
            max_h: 720.0,
        };
        let (x, y, w, h) = popup_rect_after_size(
            WindowPosition::BottomRight,
            MON_W,
            MON_H,
            (1544.0, 842.0, 360.0, 182.0),
            (360.0, 300.0),
            p,
        );
        assert_eq!(y + h, 842.0 + 182.0, "右下角卡片应向上生长，底边不动");
        assert_eq!(x + w, 1544.0 + 360.0, "右边缘也不动");
    }

    #[test]
    fn top_right_width_growth_pins_right_edge() {
        // pomo 挂件悬停加宽：右边缘距屏边只有 CORNER_MARGIN，向左生长才不出屏
        let p = PopupPolicy {
            min_h: 88.0,
            max_h: 88.0,
        };
        let (x, _, w, h) = popup_rect_after_size(
            WindowPosition::TopRight,
            MON_W,
            MON_H,
            (1658.0, 16.0, 246.0, 88.0),
            (340.0, 88.0),
            p,
        );
        assert_eq!(x + w, 1658.0 + 246.0);
        assert_eq!(h, 88.0, "只改宽度时高度原样保留");
    }

    #[test]
    fn rect_stays_on_screen_when_growing_downward() {
        let p = PopupPolicy {
            min_h: 96.0,
            max_h: 720.0,
        };
        // 顶边钉住一路长到贴底：越界时整块回收到边距内，而不是留半个窗口在外
        let (_, y, _, h) = popup_rect_after_size(
            WindowPosition::Center,
            MON_W,
            MON_H,
            (700.0, 900.0, 488.0, 100.0),
            (488.0, 300.0),
            p,
        );
        assert!(y >= 0.0 && y + h <= MON_H, "窗口长出屏幕：y={y} h={h}");
    }

    #[test]
    fn non_finite_input_is_a_noop() {
        let p = PopupPolicy {
            min_h: 96.0,
            max_h: 720.0,
        };
        let cur = (400.0, 200.0, 488.0, 300.0);
        // NaN 进 set_size 会留下畸形矩形，必须在算之前就挡掉
        assert_eq!(
            popup_rect_after_size(
                WindowPosition::Center,
                MON_W,
                MON_H,
                cur,
                (f64::NAN, 400.0),
                p
            ),
            cur
        );
        assert_eq!(
            popup_rect_after_size(
                WindowPosition::Center,
                MON_W,
                MON_H,
                cur,
                (488.0, f64::INFINITY),
                p
            ),
            cur
        );
    }

    #[test]
    fn height_is_clamped_to_policy() {
        let p = PopupPolicy {
            min_h: 160.0,
            max_h: 720.0,
        };
        let (_, _, _, h) = popup_rect_after_size(
            WindowPosition::Center,
            MON_W,
            MON_H,
            (400.0, 200.0, 488.0, 300.0),
            (488.0, 5000.0),
            p,
        );
        assert_eq!(h, 720.0, "内容再长也停在 max_height，之后交给内部滚动");
    }

    #[test]
    fn window_label_roundtrips_with_label_matches_view() {
        let spec =
            view(r#"{"id":"detail","title":"t","width":100,"height":100,"unique_by":"event"}"#);
        let plain = window_label("todo", "detail", None);
        assert_eq!(plain, "todo-detail");
        assert_eq!(
            window_label("todo", "detail", Some("abc123")),
            "todo-detail-abc123"
        );
        assert!(label_matches_view("todo", &spec, &plain));
        assert!(label_matches_view(
            "todo",
            &spec,
            &window_label("todo", "detail", Some("abc123"))
        ));
        // 前缀相邻但不同视图的标签必须被拒——这是"改到别人窗口"的唯一入口
        assert!(!label_matches_view("todo", &spec, "todo-detailx"));
        assert!(
            !label_matches_view("todo", &spec, "todo-detail-"),
            "空实例后缀不算"
        );
        assert!(!label_matches_view("notes", &spec, "todo-detail"));
        // 没声明 unique_by 的视图不接受任何带后缀的标签
        let single = view(r#"{"id":"panel","title":"t","width":100,"height":100}"#);
        assert!(label_matches_view("pick", &single, "pick-panel"));
        assert!(!label_matches_view("pick", &single, "pick-panel-1"));
    }

    #[test]
    fn manifest_hotkeys_are_normalized_and_permission_gated() {
        let manifest: PluginManifest = serde_json::from_str(
            r#"{
                "id": "pick",
                "name": "取色器",
                "version": "0.1.0",
                "api_version": "^1",
                "trigger": "/pick",
                "permissions": ["shortcut:alt+p"],
                "hotkeys": [
                    { "id": "pick", "default": "Alt + P", "label": "光标处取色" },
                    { "id": "hidden", "default": "ctrl+q", "label": "没声明权限" },
                    { "id": "bad id", "default": "alt+x" },
                    { "id": "pick", "default": "alt+o", "label": "重复 id" }
                ],
                "backend": { "kind": "none" }
            }"#,
        )
        .expect("manifest 解析");

        let valid = manifest.valid_hotkeys();
        assert_eq!(valid.len(), 1, "只保留 id 合法、唯一且权限声明的条目");
        assert_eq!(valid[0].id, "pick");
        assert_eq!(valid[0].default, "alt+p", "默认值必须归一化");
        assert_eq!(valid[0].scope, "main");
        assert!(valid[0].editable);
        assert!(valid[0].enabled);
    }

    #[test]
    fn manifest_hotkey_allows_empty_default_and_scope_fallback() {
        let manifest: PluginManifest = serde_json::from_str(
            r#"{
                "id": "clip",
                "name": "剪贴板",
                "version": "0.1.0",
                "api_version": "^1",
                "trigger": "/clip",
                "hotkeys": [
                    { "id": "open", "default": "", "label": "打开历史", "scope": "weird" }
                ],
                "backend": { "kind": "none" }
            }"#,
        )
        .expect("manifest 解析");

        let valid = manifest.valid_hotkeys();
        assert_eq!(valid.len(), 1);
        assert!(
            valid[0].default.is_empty(),
            "空默认值合法（只允许用户绑定）"
        );
        assert_eq!(valid[0].scope, "main", "未知 scope 回落 main");
    }
}
