//! Windows 专属：主窗口隐藏时挂起 WebView2，唤起前恢复。
//!
//! 通过 `ICoreWebView2_6::TrySuspend / Resume` 实现：挂起后渲染进程停止
//! 全部脚本执行、定时器与合成器工作，内存与 CPU 占用显著下降；Resume 后
//! 毫秒级恢复。对"隐藏是常态"的启动器而言，这是最大的单项内存优化。
//!
//! 注意：挂起期间前端 JS 完全暂停（包括 setTimeout / 事件回调），因此：
//! - 挂起前有 30s 延迟（见 lib.rs 的 SUSPEND_DELAY_SECS），给后台任务
//!   （如启动期的更新检查）留出执行窗口；
//! - 依赖隐藏期间继续运行的逻辑必须放在 Rust 侧（如剪贴板监听已如此）。

/// 直接对指定 webview 执行挂起/恢复，错误只记录不传播
/// （挂起失败最坏情况只是内存没省下来，不应影响窗口行为）
pub fn set_suspended(window: &tauri::WebviewWindow, suspend: bool) {
    let label = window.label().to_string();
    let result = window.with_webview(move |webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Controller, ICoreWebView2_6,
        };
        use windows_core::Interface;
        let controller: ICoreWebView2Controller = webview.controller();
        let Ok(core) = controller.CoreWebView2() else {
            return;
        };
        let Ok(core6) = core.cast::<ICoreWebView2_6>() else {
            return;
        };
        if suspend {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2TrySuspendCompletedHandler;
            let _ = core6.TrySuspend(None::<&ICoreWebView2TrySuspendCompletedHandler>);
        } else {
            let _ = core6.Resume();
        }
    });
    if let Err(e) = result {
        crate::log_debug(&format!("webview suspend({}) {}: {}", suspend, label, e));
    }
}
