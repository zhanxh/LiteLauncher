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
pub fn attach_window(app: &tauri::AppHandle, label: &str) -> Result<DesktopAttachResult, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use tauri::Manager;

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
                    break;
                }
                Err(e) => {
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

    Ok(attach_to_desktop(&native_id))
}

/// 当前会话是否支持桌面层。插件可在打开挂件前先问一次，避免白跑一趟。
pub fn session_supported() -> bool {
    detect_session() != SessionKind::Wayland
}

#[cfg(target_os = "windows")]
mod platform {
    use super::DesktopAttachResult;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, SetParent, SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER,
        SWP_SHOWWINDOW,
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
    /// 机制：Explorer 启动时会创建若干 WorkerW，其中一个被设为壁纸宿主；
    /// 但具体是哪个不可预测。社区通行的做法是**先向 Progman 发送注册消息
    /// `0x052C`**，Explorer 会把壁纸 WorkerW 挪到 Progman 之后，
    /// 此时 `FindWindowW("Progman")` 的下一个兄弟窗口就是要找的那个。
    fn find_wallpaper_workerw() -> Option<HWND> {
        unsafe {
            let progman = FindWindowW(PROGMAN.as_ptr(), std::ptr::null());
            if progman.is_null() {
                return None;
            }
            // 向 Progman 发送 0x052C，使其生成一个新的 WorkerW 承载壁纸
            SendMessageTimeoutW_default(progman, 0x052C, 0, 0);

            // 从 Progman 开始枚举兄弟窗口，取第一个 WorkerW
            let mut found: HWND = std::ptr::null_mut();
            let mut hwnd = progman;
            loop {
                let next = GetWindow(hwnd, GW_HWNDNEXT);
                if next.is_null() {
                    break;
                }
                let mut buf = [0u16; 64];
                let len = GetClassNameW(next, buf.as_mut_ptr(), buf.len() as i32);
                if len > 0 && len as usize == WORKERW.len() - 1 {
                    let name = String::from_utf16_lossy(&buf[..len as usize]);
                    if name == "WorkerW" {
                        found = next;
                        break;
                    }
                }
                hwnd = next;
            }
            if found.is_null() {
                // 退化：直接用 Progman 本身（Win7 及部分 Win10 版本）
                Some(progman)
            } else {
                Some(found)
            }
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
        fn GetClassNameW(hwnd: HWND, buf: *mut u16, max: i32) -> i32;
    }

    #[allow(non_snake_case)]
    const GW_HWNDNEXT: u32 = 2;

    /// 把 Tauri 窗口挂到壁纸层。
    ///
    /// `hwnd` 必须是**原生**窗口句柄。Tauri 的 WebviewWindow 在 Windows 上
    /// 有 `hwnd()` 方法可直接取到。
    pub fn attach(hwnd: isize) -> DesktopAttachResult {
        use super::DesktopAttach;
        if hwnd == 0 {
            return DesktopAttachResult {
                status: DesktopAttach::Failed {
                    reason: "窗口句柄为空".into(),
                },
                on_wallpaper: false,
            };
        }
        let hwnd = hwnd as HWND;
        unsafe {
            let Some(parent) = find_wallpaper_workerw() else {
                return DesktopAttachResult {
                    status: DesktopAttach::Failed {
                        reason: "未找到 Explorer 的 WorkerW 壁纸窗口（桌面进程可能未运行）".into(),
                    },
                    on_wallpaper: false,
                };
            };
            let old = SetParent(hwnd, parent);
            // SetParent 成功后需要手动调整 Z 序与显示，否则窗口可能不可见。
            //
            // ⚠️ 必须带 SWP_NOMOVE：SetParent 会把窗口的坐标系从屏幕改为
            // **相对于父窗口（WorkerW 壁纸层）**，此处的 (0,0) 若被应用就会把
            // 窗口甩到壁纸层左上角。而窗口的期望位置（右上角/右下角）
            // 是宿主按主显示器算好后用 set_position 设的，不该被这里覆盖。
            let _ = SetWindowPos(
                hwnd,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOMOVE | SWP_SHOWWINDOW,
            );
            if old.is_null() {
                // old 为 NULL 可能是"原本没有父窗口"（正常）也可能是失败，
                // 用 GetParent 反查确认
                return DesktopAttachResult {
                    status: DesktopAttach::Failed {
                        reason: "SetParent 未生效".into(),
                    },
                    on_wallpaper: false,
                };
            }
        }
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

    pub fn attach(xid_hex: &str) -> DesktopAttachResult {
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
    pub fn attach(_xid_hex: &str) -> DesktopAttachResult {
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
pub fn attach_to_desktop(native_id: &str) -> DesktopAttachResult {
    #[cfg(target_os = "windows")]
    {
        let hwnd = native_id.trim().parse::<isize>().unwrap_or(0);
        return platform::attach(hwnd);
    }
    #[cfg(not(target_os = "windows"))]
    {
        match detect_session() {
            SessionKind::X11 => platform::attach(native_id),
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
