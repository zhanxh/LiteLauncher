//! `ll-plugin://` 自定义协议（M2）：把插件目录的 `fe/` 静态资产作为窗口页面提供。
//!
//! 这是 native/llp 插件「自带前端」的承载通道（方案 docs/plugin-native-dylib-design.md §6.2）：
//! - 插件 manifest 的视图声明 `frontend: "assets"` → 宿主建窗时导航到
//!   `ll-plugin://localhost/<pluginId>/index.html?view=...&<params>`；
//! - 本模块按 URL 解析出插件 id 与相对路径，在各插件根目录（extplugins → 便携 → 开发期仓库）
//!   的 `<id>/fe/` 下定位文件并回包；
//! - 建窗时注入的 `window.__llBridge`（见 ll-host services.rs）是页面触达宿主的唯一通道，
//!   与 `plugin_call` 同一条 IPC 管线，权限按 manifest 门控——页面没有第二条信任路径。
//!
//! ## Windows 形态
//! WebView2 不原生支持自定义 scheme，wry 会把导航 `ll-plugin://localhost/<path>`
//! 重写为 `http://ll-plugin.localhost/<path>`，并在交给协议 handler 前还原回
//! `ll-plugin://localhost/<path>`（wry custom_protocol_workaround）。
//! 因此**约定 host 固定为 localhost、插件 id 放在 path 首段**，三端一致。

use std::path::PathBuf;

/// 资产根目录候选（优先级递减，先命中先用），与外部插件扫描目录一致：
/// 用户安装目录 extplugins → 便携目录（主程序旁 plugins）→ 开发期仓库 plugins
pub fn asset_roots() -> Vec<PathBuf> {
    let mut roots = vec![crate::db::extplugins_dir()];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("plugins"));
        }
    }
    #[cfg(debug_assertions)]
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"));
    roots
}

/// 协议入口：解析 URI → 定位 `<roots[i]>/<id>/fe/<rel>` → 回包
pub fn serve_plugin_asset(roots: &[PathBuf], uri: &str) -> tauri::http::Response<Vec<u8>> {
    let not_found = |msg: &str| plain_response(404, msg);

    let Some(rest) = uri.strip_prefix("ll-plugin://") else {
        return not_found("仅支持 ll-plugin:// scheme");
    };
    let (host, path_after_host) = match rest.split_once('/') {
        Some((h, p)) => (h, p),
        None => return not_found("URI 缺少路径"),
    };

    // 约定 host=localhost（三端一致）；容忍 host 直接是插件 id 的写法（macOS/Linux 原生 scheme）
    let (plugin_id, rel) = if host.eq_ignore_ascii_case("localhost") {
        match path_after_host.split_once('/') {
            Some((id, r)) => (id, r),
            None => return not_found("URI 缺少插件 id 段"),
        }
    } else {
        (host, path_after_host)
    };

    // 插件 id 白名单字符（与 manifest.id 的小写约定一致），杜绝 id 段携带路径成分
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty()
        || !plugin_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return not_found("非法插件 id");
    }

    // 去掉 query、做 percent 解码（浏览器会把非 ASCII 文件名编码进 URL）
    let rel = rel.split('?').next().unwrap_or(rel);
    let rel = percent_decode(rel);
    let rel = rel.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    // 路径穿越硬拒绝（canonicalize 兜底在下面，这里是快速失败）
    if rel.split(['/', '\\']).any(|seg| seg == "..") {
        return plain_response(403, "路径越界");
    }

    for root in roots {
        let fe_root = root.join(plugin_id).join("fe");
        if !fe_root.is_dir() {
            continue;
        }
        let target = fe_root.join(&rel);
        let (Ok(root_canon), Ok(target_canon)) = (fe_root.canonicalize(), target.canonicalize())
        else {
            continue;
        };
        // canonicalize 兜底：符号链接/Windows 大小写归一后仍必须在 fe/ 根内
        if !target_canon.starts_with(&root_canon) {
            return plain_response(403, "路径越界");
        }
        if !target_canon.is_file() {
            continue;
        }
        match std::fs::read(&target_canon) {
            Ok(bytes) => {
                let mime = mime_of(&rel);
                return bytes_response(200, mime, bytes);
            }
            Err(_) => continue,
        }
    }
    not_found(&format!("未找到资产: {plugin_id}/{rel}"))
}

fn plain_response(status: u16, msg: &str) -> tauri::http::Response<Vec<u8>> {
    bytes_response(status, "text/plain; charset=utf-8", msg.as_bytes().to_vec())
}

fn bytes_response(
    status: u16,
    content_type: &str,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-cache")
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::builder().status(500).body(Vec::new()).unwrap())
}

/// 按扩展名给 MIME（够用的白名单，未知类型按字节流）
fn mime_of(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// 极简 percent 解码（%XX；'+' 不转空格——那是 query 的约定，路径不带）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let hex = |b: u8| -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    };
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_utf8_and_keeps_plain() {
        assert_eq!(percent_decode("%E4%BD%A0%E5%A5%BD"), "你好");
        assert_eq!(percent_decode("index.html"), "index.html");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("bad%ZZ"), "bad%ZZ");
    }
}
