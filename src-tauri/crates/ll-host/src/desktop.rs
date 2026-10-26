//! 把窗口挂到桌面壁纸层（桌面图标之下）。
//!
//! ## 为什么需要这个
//!
//! 普通 `always_on_top` 窗口浮在**所有**窗口之上——用户切到别的应用它就压在别人脸上，
//! 挡内容；而真正的桌面挂件（Conky / Rainmeter / 番茄钟小挂件）应该待在壁纸层，
//! 被图标和窗口自然遮挡，不干扰任何工作。
//!
//! ## 三平台的机制完全不同，且有一处**做不到**
//!
//! | 平台 | 机制 | 可行 |
//! |---|---|---|
//! | Windows | `SetParent(win, workerw)`：向 Progman 发送 `0x052C` 拿到承载壁纸的 WorkerW 窗口，挂在它下面 | ✅ |
//! | Linux X11 | 设 `_NET_WM_WINDOW_TYPE_DESKTOP`（EWMH atom），交给 WM 归入桌面层 | ✅ |
//! | Linux Wayland | —— | ❌ |
//!
//! **Wayland 下任何应用都无法实现**。这不是缺陷而是 Wayland 的安全设计：
//! 应用不被允许自行指定 z-order / 层级（见 Wayland FAQ "Window Always On Top (z-order) ❌ Not supported"），
//! 层级完全由 compositor 决定。想在 Wayland 上做桌面挂件只能走 compositor 的私有协议
//! （如 GNOME Shell 扩展、Mutter 的 Meta API），那已经不是普通应用层能做的事。
//!
//! 故本模块在 Wayland 下**明确返回失败**，由调用方降级为置顶浮窗——不能假装成功。
//!
//! ## X11 的实现方式
//!
//! 不引入 `x11` crate（那会拖进一大票 Xlib 依赖且在 Wayland-only 机器上编译失败），
//! 而是通过 `xprop` 命令行走 `xdotool` 的路子：先用 `xdotool` 找到窗口 id，
//! 再用 `xprop -set` 设置 EWMH 属性。代价是一次外部进程调用（本场景是用户手动触发，
//! 不是逐帧调用，完全可接受）。
//!
//! 更稳妥的是直接走 `xprop -id <win> -f _NET_WM_WINDOW_TYPE 32a -set _NET_WM_WINDOW_TYPE _NET_WM_WINDOW_TYPE_DESKTOP`。

use ll_plugin_api::{DesktopAttachResult, DesktopAttachStatus as DesktopAttach};

/// 当前桌面会话类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    Windows,
    X11,
    Wayland,
}

/// 探测当前 Linux 图形会话类型。
///
/// `XDG_SESSION_TYPE` 是权威来源，`WAYLAND_DISPLAY` 只作补充。
/// 注意 XWayland 会话里 `WAYLAND_DISPLAY` 往往也有值，但那种情况下应用
/// 跑在 XWayland 里、拿不到原生 xdg-shell surface，挂壁纸层同样不可靠，
/// 故按 Wayland 处理（宁可不挂，也不要给用户一个半失效的挂件）。
pub fn detect_session() -> SessionKind {
    #[cfg(target_os = "windows")]
    {
        return SessionKind::Windows;
    }
    #[cfg(not(target_os = "windows"))]
    {
        if std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
        {
            return SessionKind::Wayland;
        }
        if std::env::var("WAYLAND_DISPLAY").is_ok() {
            return SessionKind::Wayland;
        }
        SessionKind::X11
    }
}

/// 按窗口标签把已存在的窗口挂到桌面层。
///
/// ## 为什么用 `raw_window_handle` 而不是 Tauri 的 `window.hwnd()`
///
/// `WebviewWindow::hwnd()` 只在 `cfg(windows)` 下存在（返回 `HWND`），
/// 跨平台编译不过。`raw_window_handle` 是 Tauri 自己用来取句柄的那层：
/// Windows 上 `RawWindowHandle::Win32(h)` 里 `h.hwnd` 就是 HWND；
/// X11 上 `RawWindowHandle::Xlib(h)` / `Xcb(h)` 的 `window_id` 就是 X11 window id。
/// 两者都能直接喂给 [`attach_to_desktop`]。
///
/// 窗口可能正在创建（`window.open` 走主线程异步建窗），故给一段重试窗口期；
/// 拿不到就返回 Failed 并附明确原因，让插件能提示用户而不是静默失败。
pub fn attach_window(
    app: &tauri::AppHandle,
    label: &str,
    log: &dyn Fn(&str),
) -> Result<DesktopAttachResult, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use tauri::Manager;

    log("attach_window: begin");
    // 最多等 ~1.2s 让窗口就绪：20 次 × 60ms。
    // 用 std::thread::sleep 而非 tokio：svc 分发器是同步的，
    // 引入 async 只会让调用链多一层 Future 却拿不到任何收益。
    let mut handle: Option<RawWindowHandle> = None;
    for _ in 0..20 {
        if let Some(w) = app.get_webview_window(label) {
            match HasWindowHandle::window_handle(&w) {
                Ok(h) => {
                    // as_raw() 产出的是拥有句柄的类型，必须先 as_ref 转成
                    // 不带生命周期的 RawWindowHandle 才能带出循环
                    let raw: RawWindowHandle = h.as_raw();
                    handle = Some(raw);
                    log("attach_window: window handle acquired");
                    break;
                }
                Err(e) => {
                    log("attach_window: window_handle() failed");
                    return Ok(DesktopAttachResult {
                        status: DesktopAttach::Failed {
                            reason: format!("取窗口句柄失败: {e}"),
                        },
                        on_wallpaper: false,
                    });
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(60));
    }

    let Some(handle) = handle else {
        return Ok(DesktopAttachResult {
            status: DesktopAttach::Failed {
                reason: format!("窗口 {label} 尚未就绪（可能未打开或已关闭）"),
            },
            on_wallpaper: false,
        });
    };

    let native_id = match handle {
        RawWindowHandle::Win32(h) => format!("{}", h.hwnd.get()),
        // Xlib 与 Xcb 的 window id 字段名虽然一致（都是 window），
        // 但两者是**不同的 Rust 类型**，不能合并成一个 or-pattern
        RawWindowHandle::Xlib(h) => format!("{:x}", h.window),
        RawWindowHandle::Xcb(h) => format!("{:x}", h.window),
        other => {
            return Ok(DesktopAttachResult {
                status: DesktopAttach::Unsupported {
                    reason: format!(
                        "当前窗口后端（{}）不支持桌面层挂载",
                        format!("{other:?}")
                            .split(['(', ' '])
                            .next()
                            .unwrap_or("unknown")
                    ),
                },
                on_wallpaper: false,
            });
        }
    };

    Ok(attach_to_desktop(&native_id, log))
}

/// 当前会话是否支持桌面层。插件可在打开挂件前先问一次，避免白跑一趟。
pub fn session_supported() -> bool {
    detect_session() != SessionKind::Wayland
}

#[cfg(target_os = "windows")]
mod platform {
    use super::DesktopAttachResult;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowW, GetSystemMetrics, GetWindowRect, IsWindowVisible, SetParent,
        SetWindowPos, HWND_TOP, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    };

    /// Progman 与 WorkerW 的窗口类名（Unicode 版）
    const PROGMAN: &[u16] = &[80, 114, 111, 103, 109, 97, 110, 0]; // "Progman"
    const WORKERW: &[u16] = &[87, 111, 114, 107, 101, 114, 119, 0]; // "WorkerW"

    /// 去掉 Windows 11 的窗口边框。
    ///
    /// ## 为什么需要
    ///
    /// `decorations: false` 只去掉标题栏和窗口按钮，**Windows 11 的 DWM 仍会给
    /// 所有顶层窗口画一圈 1px 的系统边框**（浅色主题下就是白色）——用户看到的
    /// 「挂件左右下白色边框」主要就是它。用 `DWMWA_BORDER_COLOR` 设为
    /// `DWMWA_COLOR_NONE` 可彻底去边。
    ///
    /// 该属性是 Win11 (build 22000+) 才有的；Win10 上调用返回错误码，
    /// 无害直接忽略（Win10 的无边框窗口本来就没有这圈边）。
    pub fn remove_window_border(hwnd: isize) {
        use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;

        const DWMWA_BORDER_COLOR: u32 = 34;
        // DWMWA_COLOR_NONE 的文档值
        const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;

        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd as windows_sys::Win32::Foundation::HWND,
                DWMWA_BORDER_COLOR,
                &DWMWA_COLOR_NONE as *const u32 as *const core::ffi::c_void,
                4,
            );
        }
    }

    /// 找承载壁纸的 WorkerW 窗口。
    ///
    /// 经典机制（Win10 / 早期 Win11）：向 Progman 发送注册消息 `0x052C`，
    /// Explorer 会把壁纸 WorkerW 挪到 Progman 的兄弟位置，沿 GW_HWNDNEXT
    /// 走兄弟链第一个 WorkerW 就是它。
    ///
    /// ⚠️ 新版 Win11 上这套假设会失效（2026-10-26 真机：Progman 是 Z 序最底、
    /// 兄弟链里**没有** WorkerW；桌面上另有若干 202×56 的**隐形** WorkerW）。
    /// 选错父窗口（尤其选中隐形小 WorkerW，或回退到 Progman）会让挂件在
    /// SetParent 瞰间塌缩成 0×0 的隐形子窗——用户看到的就是"一闪即逝"。
    /// 所以：① 兄弟链候选 + 全局 EnumWindows 补扫；② 只接受"可见且覆盖整个
    /// 虚拟桌面"的候选；③ 找不到才退回 Progman（attach 里会重申矩形兜底）。
    fn find_wallpaper_workerw(log: &dyn Fn(&str)) -> Option<HWND> {
        unsafe {
            let progman = FindWindowW(PROGMAN.as_ptr(), std::ptr::null());
            if progman.is_null() {
                log("find: Progman not found");
                return None;
            }
            // 向 Progman 发送 0x052C，使其生成一个新的 WorkerW 承载壁纸
            SendMessageTimeoutW_default(progman, 0x052C, 0, 0);

            let vsx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let vsy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let vsw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let vsh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            log(&format!(
                "find: virtual screen=({vsx},{vsy})+{vsw}x{vsh}"
            ));

            // 经典路径：Progman 的兄弟链
            let mut candidates: Vec<HWND> = Vec::new();
            let mut hwnd = progman;
            loop {
                let next = GetWindow(hwnd, GW_HWNDNEXT);
                if next.is_null() {
                    break;
                }
                if class_is_workerw(next) {
                    candidates.push(next);
                }
                hwnd = next;
            }
            log(&format!("find: sibling candidates={}", candidates.len()));

            // 全局补扫：新版 Win11 的壁纸宿主 WorkerW 不在 Progman 的兄弟链里
            let mut extra: Vec<HWND> = Vec::new();
            let ctx = ScanCtx {
                seen: &mut extra,
                skip: &candidates,
            };
            EnumWindows(
                Some(enum_workerw_cb),
                &ctx as *const ScanCtx as LPARAM,
            );
            candidates.append(&mut extra);
            log(&format!("find: total candidates={}", candidates.len()));

            for c in &candidates {
                let r = get_rect(*c);
                let covers = r.left <= vsx
                    && r.top <= vsy
                    && r.right >= vsx + vsw
                    && r.bottom >= vsy + vsh;
                let vis = IsWindowVisible(*c) != 0;
                log(&format!(
                    "find: candidate hwnd={:p} vis={vis} rect=({},{})-({},{}) covers={covers}",
                    *c, r.left, r.top, r.right, r.bottom
                ));
                if vis && covers {
                    return Some(*c);
                }
            }
            log("find: no valid WorkerW, falling back to Progman");
            Some(progman)
        }
    }

    struct ScanCtx<'a> {
        seen: *mut Vec<HWND>,
        skip: &'a Vec<HWND>,
    }

    unsafe extern "system" fn enum_workerw_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let ctx = &*(lparam as *const ScanCtx);
            if class_is_workerw(hwnd) && !ctx.skip.contains(&hwnd) {
                (*ctx.seen).push(hwnd);
            }
        }
        1
    }

    fn class_is_workerw(hwnd: HWND) -> bool {
        unsafe {
            let mut buf = [0u16; 64];
            let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            len > 0
                && len as usize == WORKERW.len() - 1
                && String::from_utf16_lossy(&buf[..len as usize]) == "WorkerW"
        }
    }

    fn get_rect(hwnd: HWND) -> RECT {
        unsafe {
            let mut r = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            GetWindowRect(hwnd, &mut r);
            r
        }
    }

    #[allow(non_snake_case)]
    fn SendMessageTimeoutW_default(hwnd: HWND, msg: u32, wparam: usize, lparam: LPARAM) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, SMTO_ABORTIFHUNG, SMTO_NORMAL,
        };
        let mut result: usize = 0;
        unsafe {
            SendMessageTimeoutW(
                hwnd,
                msg,
                wparam,
                lparam,
                SMTO_ABORTIFHUNG | SMTO_NORMAL,
                1000,
                &mut result as *mut usize as *mut usize,
            );
        }
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetWindow(hwnd: HWND, cmd: u32) -> HWND;
        fn GetParent(hwnd: HWND) -> HWND;
        fn GetClassNameW(hwnd: HWND, buf: *mut u16, max: i32) -> i32;
    }

    #[allow(non_snake_case)]
    const GW_HWNDNEXT: u32 = 2;

    /// 把 Tauri 窗口挂到壁纸层。
    ///
    /// `hwnd` 必须是**原生**窗口句柄。Tauri 的 WebviewWindow 在 Windows 上
    /// 有 `hwnd()` 方法可直接取到。
    pub fn attach(hwnd: isize, log: &dyn Fn(&str)) -> DesktopAttachResult {
        use super::DesktopAttach;
        if hwnd == 0 {
            log("attach: hwnd is 0");
            return DesktopAttachResult {
                status: DesktopAttach::Failed {
                    reason: "窗口句柄为空".into(),
                },
                on_wallpaper: false,
            };
        }
        let hwnd = hwnd as HWND;
        log("attach: finding wallpaper WorkerW");
        unsafe {
            let Some(parent) = find_wallpaper_workerw(log) else {
                log("attach: WorkerW not found");
                return DesktopAttachResult {
                    status: DesktopAttach::Failed {
                        reason: "未找到 Explorer 的 WorkerW 壁纸窗口（桌面进程可能未运行）".into(),
                    },
                    on_wallpaper: false,
                };
            };
            log(&format!("attach: parent picked, hwnd={:p}", parent));
            // SetParent 前先取屏幕矩形：之后坐标系变为父窗口相对，需要用它重申
            let pre = get_rect(hwnd);
            log(&format!(
                "attach: pre-attach rect=({},{})-({},{})",
                pre.left, pre.top, pre.right, pre.bottom
            ));
            let old = SetParent(hwnd, parent);
            log("attach: SetParent returned");
            // SetParent 后**重申完整矩形**，两个原因：
            //   1) 坐标系变为父窗口相对（原点 = GetWindowRect(parent).left/top），
            //      必须把屏幕矩形平移进父坐标系，否则会甩到父窗口左上角；
            //   2) 新版 Win11 上挂到 Progman/WorkerW 的瞬间窗口会塌缩成 0×0
            //      （真机实测：GetWindowRect 变成零大小、挂件不可见），必须把
            //      尺寸顶回来。旧实现只用 SWP_NOMOVE 防“甩位”，防不了塌缩。
            let pr = get_rect(parent);
            let w = pre.right - pre.left;
            let h = pre.bottom - pre.top;
            log(&format!(
                "attach: reassert rect origin=({},{}) size={w}x{h}",
                pr.left, pr.top
            ));
            let _ = SetWindowPos(
                hwnd,
                HWND_TOP,
                pre.left - pr.left,
                pre.top - pr.top,
                w,
                h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
            log("attach: SetWindowPos done");
            // ⚠️ SetParent 会重置创建时设过的 DWM 无边框属性：挂完后系统
            // 重新画上一圈 1-2px 的主题色边框（真机实测：上下左右蓝色线，
            // 用户描述为"下巴/状态栏没隐藏"）。挂载完成后再去一次边。
            remove_window_border(hwnd as isize);
            log("attach: border removed again");
            if old.is_null() {
                // SetParent 对"原本没有父窗口"的顶层窗口成功时也返回 NULL，
                // 不能凭 NULL 判失败——用 GetParent 反查确认真的挂上了没有。
                // 只看返回值会把每次成功都报成失败，插件侧就会错误降级提示。
                if GetParent(hwnd) != parent {
                    log("attach: GetParent check failed → SetParent not effective");
                    return DesktopAttachResult {
                        status: DesktopAttach::Failed {
                            reason: "SetParent 未生效".into(),
                        },
                        on_wallpaper: false,
                    };
                }
                log("attach: old parent was NULL but GetParent confirms attached");
            }
        }
        log("attach: done → attached");
        DesktopAttachResult {
            status: DesktopAttach::Attached,
            on_wallpaper: true,
        }
    }
}

#[cfg(all(not(target_os = "windows"), target_os = "linux"))]
mod platform {
    use super::{DesktopAttachResult, DesktopAttach};
    use std::process::{Command, Stdio};

    /// 取窗口的 X11 window id（十进制十六进制字符串）。
    fn x11_window_id(xid_hex: &str) -> Option<u64> {
        u64::from_str_radix(xid_hex.trim(), 16).ok()
    }

    /// 通过 xprop 设置 `_NET_WM_WINDOW_TYPE`。
    ///
    /// xprop 的 -set 语法要求先用 -f 声明属性类型为 32 位 atom，
    /// 直接 -set 会因类型不匹配而失败（静默返回非零码）。
    fn set_window_type(xid: u64, atom: &str) -> Result<(), String> {
        let out = Command::new("xprop")
            .args([
                "-id",
                &format!("0x{xid:x}"),
                "-f",
                "_NET_WM_WINDOW_TYPE",
                "32a",
                "-set",
                "_NET_WM_WINDOW_TYPE",
                atom,
            ])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("xprop 执行失败（未安装 x11-utils？）: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "xprop 返回错误: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }

    pub fn attach(xid_hex: &str, _log: &dyn Fn(&str)) -> DesktopAttachResult {
        let Some(xid) = x11_window_id(xid_hex) else {
            return DesktopAttachResult {
                status: DesktopAttach::Failed {
                    reason: format!("无法解析 X11 窗口 id: {xid_hex}"),
                },
                on_wallpaper: false,
            };
        };
        match set_window_type(xid, "_NET_WM_WINDOW_TYPE_DESKTOP") {
            Ok(()) => DesktopAttachResult {
                status: DesktopAttach::Attached,
                on_wallpaper: true,
            },
            Err(e) => DesktopAttachResult {
                status: DesktopAttach::Failed { reason: e },
                on_wallpaper: false,
            },
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{DesktopAttach, DesktopAttachResult};

    /// macOS 没有可用的"桌面层"概念（桌面由 Desktop/Dock 进程托管，
    /// 普通应用挂不进去），且本项目当前不作为主要目标平台。
    pub fn attach(_xid_hex: &str, _log: &dyn Fn(&str)) -> DesktopAttachResult {
        DesktopAttachResult {
            status: DesktopAttach::Unsupported {
                reason: "macOS 不支持将窗口挂到桌面层".into(),
            },
            on_wallpaper: false,
        }
    }
}

/// 去掉 Windows 11 的 DWM 窗口边框（平台无关入口，非 Windows 无操作）。
///
/// `decorations: false` 只去掉标题栏，Win11 的 DWM 仍给顶层窗口画一圈 1px
/// 系统边框（浅色主题下是白色）——桌面挂件类小窗上非常扎眼。
/// 见 [`platform::remove_window_border`] 的详细说明。
pub fn remove_window_border(_hwnd: isize) {
    #[cfg(target_os = "windows")]
    platform::remove_window_border(_hwnd);
}

/// 平台无关入口。
///
/// - Windows：传原生 HWND（十进制字符串或整数）
/// - Linux X11：传 X11 window id 的**十六进制字符串**（Tauri 的 `window.hwnd()` 在 Linux 上返回的正是这个）
/// - Wayland / macOS：直接返回 Unsupported，调用方降级
///
/// 各分支用 `cfg` 剔除而非运行时匹配：同一平台只会编译进对应的那一个 `platform::attach`
/// 签名（Windows 收 isize、Linux 收 &str），不剔除会出现类型不匹配。
pub fn attach_to_desktop(native_id: &str, log: &dyn Fn(&str)) -> DesktopAttachResult {
    #[cfg(target_os = "windows")]
    {
        let hwnd = native_id.trim().parse::<isize>().unwrap_or(0);
        return platform::attach(hwnd, log);
    }
    #[cfg(not(target_os = "windows"))]
    {
        match detect_session() {
            SessionKind::X11 => platform::attach(native_id, log),
            SessionKind::Wayland => DesktopAttachResult {
                status: DesktopAttach::Unsupported {
                    reason: "Wayland 不允许应用指定窗口层级（z-order 完全由 compositor 独占管理），\
                             无法挂到桌面层；请改用 X11 会话"
                        .into(),
                },
                on_wallpaper: false,
            },
            // Windows 分支不会编译到这里；保留臂以穷尽匹配
            SessionKind::Windows => DesktopAttachResult {
                status: DesktopAttach::Unsupported {
                    reason: "当前不是 Windows 平台".into(),
                },
                on_wallpaper: false,
            },
        }
    }
}
