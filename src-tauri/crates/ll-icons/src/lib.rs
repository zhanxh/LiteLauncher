//! 应用图标：把 `ll-icon://` 请求落到磁盘上的 `.exe/.lnk/.url/.ico`，抽成 32×32 PNG。
//!
//! 为什么走自定义协议而不是 base64：
//! - 应用列表逐键查询，base64 会让每次 IPC 多背几十 KB；
//! - 图标是浏览器可直接缓存/懒加载的资源，协议 + `Cache-Control` 让重复查询零成本；
//! - 插件因此不需要引入任何 Win32 依赖（`apps` 插件只回一个 URL）。
//!
//! 安全边界：只接受绝对路径、只认 4 种扩展名、只回 PNG 字节、输出上限 64 KB，
//! 不回传任何文件内容。非 Windows 平台返回 `None`，前端回退 emoji。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// 输出上限：32×32 PNG 正常 1–3 KB，64 KB 是防御性上限
pub const MAX_PNG_BYTES: usize = 64 * 1024;
/// 统一尺寸：与结果面板 `.item-icon` 的 26px 视觉尺寸匹配（高分屏由浏览器缩放）
const ICON_SIZE: u32 = 32;
/// 内存缓存条数上限；超过就整体清空（图标很小，重建成本远低于 LRU 维护）
const MEM_CACHE_MAX: usize = 256;

/// 允许抽图标的扩展名（全部小写）
const ALLOWED_EXTENSIONS: &[&str] = &["exe", "lnk", "url", "ico"];

/// 校验一个路径是否允许作为图标来源
///
/// 只做静态校验（不碰磁盘）：协议层与单测共用。绝对路径限制避免
/// `ll-icon://localhost/../../x` 这类相对路径探测。
pub fn is_supported_icon_path(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return false;
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return false;
    }
    let Some(ext) = p.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    ALLOWED_EXTENSIONS.contains(&ext.as_str())
}

/// 从 `ll-icon://localhost/<percent-encoded path>` 还原出文件路径
///
/// 同时接受 Windows 上 wry 暴露的 `http://ll-icon.localhost/<path>` 形态：
/// `<img>` 子资源不保证经过导航重写，两种入口都认最稳。
pub fn path_from_uri(uri: &str) -> Option<String> {
    let path = if let Some(rest) = uri.strip_prefix("ll-icon://") {
        // rest = "localhost/<path>"
        rest.split_once('/').map(|(_, p)| p)?
    } else if let Some(rest) = uri.strip_prefix("http://ll-icon.localhost/") {
        rest
    } else {
        return None;
    };
    let raw = path.split('?').next().unwrap_or(path);
    if raw.is_empty() {
        return None;
    }
    let decoded = percent_decode(raw);
    if decoded.contains('\0') {
        return None;
    }
    Some(decoded)
}

/// 把绝对路径编码成 URL path 段（斜杠、反斜杠、冒号、中文全部转义）
pub fn percent_encode(input: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(input.len() * 2);
    for &b in input.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
    }
    out
}

/// percent 解码（非法 `%` 序列按原字节保留，避免整条 URL 失败）
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// 图标磁盘 + 内存缓存
pub struct IconCache {
    dir: PathBuf,
    mem: Mutex<HashMap<String, Vec<u8>>>,
}

impl IconCache {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            mem: Mutex::new(HashMap::new()),
        }
    }

    /// 取图标 PNG；不支持/抽取失败/超出上限都返回 `None`（调用方回 404，前端回退 emoji）
    pub fn png_for_path(&self, path: &str) -> Option<Vec<u8>> {
        if !is_supported_icon_path(path) {
            return None;
        }
        let meta = std::fs::metadata(path).ok()?;
        if !meta.is_file() {
            return None;
        }

        let key = cache_key(path, &meta);
        if let Some(hit) = self.mem.lock().ok()?.get(&key) {
            return Some(hit.clone());
        }

        let cached = self.dir.join(format!("{key}.png"));
        if let Ok(bytes) = std::fs::read(&cached) {
            if bytes.len() <= MAX_PNG_BYTES {
                self.remember(key, &bytes);
                return Some(bytes);
            }
        }

        let png = extract_png(path)?;
        if png.is_empty() || png.len() > MAX_PNG_BYTES {
            return None;
        }
        let _ = std::fs::create_dir_all(&self.dir);
        let _ = std::fs::write(&cached, &png);
        self.remember(key, &png);
        Some(png)
    }

    fn remember(&self, key: String, bytes: &[u8]) {
        if let Ok(mut mem) = self.mem.lock() {
            if mem.len() >= MEM_CACHE_MAX {
                mem.clear();
            }
            mem.insert(key, bytes.to_vec());
        }
    }
}

/// 缓存键 = 路径（小写）+ 修改时间：文件被替换后自动失效，不做显式失效逻辑
fn cache_key(path: &str, meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hash = 0xcbf29ce484222325u64;
    for b in path.to_ascii_lowercase().as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    for b in mtime.to_le_bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(windows)]
fn extract_png(path: &str) -> Option<Vec<u8>> {
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGetFileInfoW};
    use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

    unsafe {
        let wide: Vec<u16> = std::ffi::OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut info: SHFILEINFOW = zeroed();
        let ok = SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut info,
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if ok == 0 || info.hIcon.is_null() {
            return None;
        }

        let rgba = icon_to_rgba(info.hIcon);
        DestroyIcon(info.hIcon);
        let (w, h, pixels) = rgba?;

        let image = image::RgbaImage::from_raw(w, h, pixels)?;
        let image = if (w, h) == (ICON_SIZE, ICON_SIZE) {
            image
        } else {
            image::imageops::resize(
                &image,
                ICON_SIZE,
                ICON_SIZE,
                image::imageops::FilterType::Lanczos3,
            )
        };
        let mut out = Vec::new();
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgba8,
            )
            .ok()?;
        Some(out)
    }
}

/// HICON → (宽, 高, RGBA)。调用方负责 DestroyIcon。
#[cfg(windows)]
unsafe fn icon_to_rgba(
    icon: windows_sys::Win32::UI::WindowsAndMessaging::HICON,
) -> Option<(u32, u32, Vec<u8>)> {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Graphics::Gdi::{
        BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits,
        GetObjectW, HGDIOBJ, ReleaseDC,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    unsafe {
        let mut ii: ICONINFO = zeroed();
        if GetIconInfo(icon, &mut ii) == 0 {
            return None;
        }
        let color = ii.hbmColor;
        let mask = ii.hbmMask;

        let result = (|| {
            if color.is_null() {
                return None;
            }
            let mut bmp: BITMAP = zeroed();
            if GetObjectW(
                color as HGDIOBJ,
                size_of::<BITMAP>() as i32,
                &mut bmp as *mut BITMAP as *mut c_void,
            ) == 0
            {
                return None;
            }
            let width = bmp.bmWidth.max(0) as u32;
            let height = bmp.bmHeight.max(0) as u32;
            if width == 0 || height == 0 || width > 1024 || height > 1024 {
                return None;
            }

            let mut bi: BITMAPINFO = zeroed();
            bi.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
            bi.bmiHeader.biWidth = width as i32;
            // 负高度 = 自上而下的行序，省一次垂直翻转
            bi.bmiHeader.biHeight = -(height as i32);
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            bi.bmiHeader.biCompression = DIB_RGB_COLORS;

            let mut pixels = vec![0u8; (width * height * 4) as usize];
            let hdc = GetDC(std::ptr::null_mut());
            if hdc.is_null() {
                return None;
            }
            let lines = GetDIBits(
                hdc,
                color,
                0,
                height,
                pixels.as_mut_ptr() as *mut c_void,
                &mut bi,
                DIB_RGB_COLORS,
            );
            ReleaseDC(std::ptr::null_mut(), hdc);
            if lines == 0 {
                return None;
            }

            // BGRA → RGBA；部分图标没有 alpha 通道，此时把整张图视为不透明
            let mut has_alpha = false;
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2);
                if px[3] != 0 {
                    has_alpha = true;
                }
            }
            if !has_alpha {
                for px in pixels.chunks_exact_mut(4) {
                    px[3] = 255;
                }
            }
            Some((width, height, pixels))
        })();

        if !color.is_null() {
            DeleteObject(color as HGDIOBJ);
        }
        if !mask.is_null() {
            DeleteObject(mask as HGDIOBJ);
        }
        result
    }
}

#[cfg(not(windows))]
fn extract_png(_path: &str) -> Option<Vec<u8>> {
    // 非 Windows 暂不实现（Linux 需要 icon theme 查询），前端回退 emoji
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_windows_path_through_uri_encoding() {
        let path = r"C:\Program Files\腾讯\微信.lnk";
        let uri = format!("ll-icon://localhost/{}", percent_encode(path));
        assert_eq!(path_from_uri(&uri).as_deref(), Some(path));
        assert!(uri.contains("%20"));
        assert!(!uri.contains('\\'));
    }

    #[test]
    fn decodes_query_and_rejects_empty_path() {
        let uri = "ll-icon://localhost/C%3A%5CApps%5CWeChat.lnk?v=1";
        assert_eq!(path_from_uri(uri).as_deref(), Some(r"C:\Apps\WeChat.lnk"));
        assert_eq!(path_from_uri("ll-icon://localhost/"), None);
        assert_eq!(path_from_uri("https://example.com/x.png"), None);
    }

    #[test]
    fn accepts_windows_http_localhost_form() {
        let uri = "http://ll-icon.localhost/C%3A%5CApps%5CWeChat.exe";
        assert_eq!(path_from_uri(uri).as_deref(), Some(r"C:\Apps\WeChat.exe"));
    }

    #[test]
    fn only_allows_absolute_known_extensions() {
        assert!(is_supported_icon_path(r"C:\Apps\WeChat.exe"));
        assert!(is_supported_icon_path(r"C:\Apps\WeChat.lnk"));
        assert!(!is_supported_icon_path("code.exe"));
        assert!(!is_supported_icon_path(r"C:\Apps\notes.txt"));
        assert!(!is_supported_icon_path(
            "/usr/share/applications/code.desktop"
        ));
    }

    #[test]
    fn rejects_nul_and_overlong_paths() {
        assert!(!is_supported_icon_path("C:\\Apps\\a\0.exe"));
        let long = format!("C:\\{}.exe", "a".repeat(5000));
        assert!(!is_supported_icon_path(&long));
    }

    /// 真机抽取一次系统自带程序图标：验证 SHGetFileInfo/GetDIBits/PNG 整条链路，
    /// 而不是只验证路径字符串。非 Windows 平台没有该实现，跳过。
    #[cfg(windows)]
    #[test]
    fn extracts_system_icon_and_caches_it() {
        let Ok(root) = std::env::var("SystemRoot") else {
            return;
        };
        let exe = format!(r"{root}\System32\notepad.exe");
        if !std::path::Path::new(&exe).is_file() {
            return;
        }

        let png = extract_png(&exe).expect("notepad 图标应能抽取");
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']), "必须输出 PNG");
        assert!(png.len() <= MAX_PNG_BYTES);

        let dir = std::env::temp_dir().join(format!("ll-icons-test-{}", std::process::id()));
        let cache = IconCache::new(dir.clone());
        let first = cache.png_for_path(&exe).expect("首次抽取");
        let second = cache.png_for_path(&exe).expect("缓存命中");
        assert_eq!(first, second);
        assert!(dir.read_dir().map(|it| it.count() > 0).unwrap_or(false));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
