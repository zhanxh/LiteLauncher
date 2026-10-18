//! Windows 索引后端：进程内直接调 Everything64.dll（迁移前是 ctypes）。
//!
//! 为什么不用 Everything 命令行：`es.exe` 每次要起进程，冷启动就是几十毫秒；
//! SDK 走同一份索引库，查询本身 20ms 上下，插件里没有进程边界。
//!
//! ## 线程模型
//! Everything SDK 的搜索状态（搜索词 / 结果游标）是**进程级全局**的，
//! 不是 per-handle。宿主可能从任意线程调 `vtable.call`，所以每次查询都持
//! `lock` 串行执行——迁移前 Python 侧是同一套约定（`find.py` 的 `_query_lock`）。
//!
//! ## 实测踩出来的坑（改代码前先读，都是静默失败）
//! 1. 必须先 `Everything_Reset()` 再 `SetSearchW`，否则沿用上一次的搜索词；
//! 2. 结果索引从 1 开始，真正的上界是 `Everything_GetNumResults()`；
//! 3. 不设 `SetRequestFlags` 则 size/mtime 恒为 0；
//! 4. `GetResultDateModified` 返回 Windows FILETIME（1601 纪元），不是 Unix 秒；
//! 5. `GetResultFullPathNameW` 的缓冲区必须真的递指针，传 NULL 问长度的写法
//!    在部分版本上静默返回 0（这里按「先问长度、再取内容」两步来，留了兜底）；
//! 6. `GetResultFileNameW` / `GetResultHighlightedFileNameW` 实测返回垃圾内存，
//!    文件名一律从完整路径切。

use crate::format::Row;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

unsafe extern "system" {
    fn LoadLibraryW(name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    fn GetModuleHandleExW(flags: u32, name: *const u16, out: *mut *mut c_void) -> Bool;
    fn GetModuleFileNameW(module: *mut c_void, buf: *mut u16, size: u32) -> u32;
}

type Bool = i32;

const REQ_FILE_NAME: u32 = 0x0000_0001;
const REQ_PATH: u32 = 0x0000_0002;
const REQ_SIZE: u32 = 0x0000_0010;
const REQ_DATE_MODIFIED: u32 = 0x0000_0040;
const REQ_ATTRIBUTES: u32 = 0x0000_0100;
const REQ_HIGHLIGHTED_FILE_NAME: u32 = 0x0000_2000;

const ATTR_HIDDEN: u32 = 0x02;
const ATTR_SYSTEM: u32 = 0x04;

/// FILETIME（1601 起点，100ns 单位）→ Unix 毫秒的偏移
const FILETIME_TO_UNIX_MS_OFFSET: i64 = 11_644_473_600_000;

type FnVoid0 = unsafe extern "system" fn();
type FnVoidU32 = unsafe extern "system" fn(u32);
type FnVoidWStr = unsafe extern "system" fn(*const u16);
type FnBool0 = unsafe extern "system" fn() -> Bool;
type FnBoolU32 = unsafe extern "system" fn(u32) -> Bool;
type FnU32_0 = unsafe extern "system" fn() -> u32;
type FnU32WStrU32 = unsafe extern "system" fn(u32, *mut u16, u32) -> u32;
type FnBoolU32U64 = unsafe extern "system" fn(u32, *mut u64) -> Bool;
type FnBoolU32U32 = unsafe extern "system" fn(u32, *mut u32) -> Bool;

/// 引导面板里的后端名（Everything 不可用时的标题括号）
pub fn label() -> &'static str {
    "Everything"
}

/// 索引不可用时的标题行
pub fn unavailable_reason() -> String {
    format!("未检测到可用的文件索引（{}）", label())
}

/// 索引不可用时的引导文案（装什么、放哪里）
pub fn unavailable_hint() -> &'static str {
    "本插件依赖 Everything 的索引。请先安装并运行 Everything（https://www.voidtools.com），\
     再把 SDK 的 Everything64.dll 放到插件的 bin/ 目录（或设 LITE_EVERYTHING_DLL 指向它）。"
}

/// Index DB 还在加载时的提示（Everything 刚启动的几秒）
pub fn db_loading_panel() -> serde_json::Value {
    crate::format::build_unavailable("Everything 数据库仍在加载", "稍等几秒再试")
}

/// 底部统计条的来源标注
pub fn source_label() -> &'static str {
    "Everything 索引"
}

/// 空输入时的语法说明
pub fn usage_syntax() -> &'static str {
    "支持 Everything 原生语法"
}

pub struct Backend {
    /// 动态库句柄（HMODULE）：函数指针指向它的代码段，进程存活期只增不减
    _module: *mut c_void,
    reset: FnVoid0,
    set_search: FnVoidWStr,
    set_max: FnVoidU32,
    set_sort: FnVoidU32,
    set_request_flags: FnVoidU32,
    query: FnBoolU32,
    tot_results: FnU32_0,
    num_results: FnU32_0,
    last_error: FnU32_0,
    is_db_loaded: FnBool0,
    major: FnU32_0,
    minor: FnU32_0,
    build: FnU32_0,
    is_folder: FnBoolU32,
    full_path: FnU32WStrU32,
    result_size: FnBoolU32U64,
    result_mtime: FnBoolU32U64,
    result_attrs: FnBoolU32U32,
    /// SDK 搜索状态是进程级全局的：查询必须串行
    lock: Mutex<()>,
}

// 安全依据：HMODULE 与函数指针在进程存活期只读不变（句柄刻意不 FreeLibrary），
// 可变状态只有 SDK 的全局搜索游标、已由 lock 串行化。
unsafe impl Send for Backend {}
unsafe impl Sync for Backend {}

/// 取一个导出函数；名字必须带 NUL 结尾（GetProcAddress 要求 C 字符串）
unsafe fn sym<T: Copy>(module: *mut c_void, name: &'static [u8]) -> Result<T, String> {
    let proc = unsafe { GetProcAddress(module, name.as_ptr()) };
    if proc.is_null() {
        return Err(format!(
            "Everything SDK 缺少符号 {}（版本过旧？）",
            String::from_utf8_lossy(&name[..name.len() - 1])
        ));
    }
    // FARPROC 与函数指针同为指针宽度；transmute_copy 避免泛型 T 的 SizeNotOne 限制
    if std::mem::size_of::<T>() != std::mem::size_of::<*mut c_void>() {
        return Err("函数指针宽度不符".into());
    }
    Ok(unsafe { std::mem::transmute_copy::<*mut c_void, T>(&proc) })
}

impl Backend {
    /// 找不到/加载不了时返回错误文本（`/find where` 会把它显示给用户）
    pub fn load() -> Result<Self, String> {
        let env_dll = std::env::var("LITE_EVERYTHING_DLL")
            .ok()
            .or_else(|| std::env::var("EVERYTHING_DLL").ok())
            .filter(|s| !s.trim().is_empty());
        let cands = candidates_in(module_dir().as_deref(), env_dll);

        let mut last_err = String::new();
        for path in &cands {
            if !path.is_file() {
                continue;
            }
            match unsafe { Self::open(path) } {
                Ok(backend) => return Ok(backend),
                Err(e) => last_err = e,
            }
        }
        Err(if last_err.is_empty() {
            "未找到 Everything64.dll。请安装 Everything（https://www.voidtools.com）\
             并把 SDK 的 Everything64.dll 放到插件的 bin/ 目录。"
                .to_string()
        } else {
            last_err
        })
    }

    unsafe fn open(path: &Path) -> Result<Self, String> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let module = unsafe { LoadLibraryW(wide.as_ptr()) };
        if module.is_null() {
            return Err(format!(
                "加载 {} 失败（{}）",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
        // 句柄刻意不 FreeLibrary：函数指针指进它的代码段，进程存活期必须有效
        let backend = unsafe {
            Self {
                reset: sym(module, b"Everything_Reset\0")?,
                set_search: sym(module, b"Everything_SetSearchW\0")?,
                set_max: sym(module, b"Everything_SetMax\0")?,
                set_sort: sym(module, b"Everything_SetSort\0")?,
                set_request_flags: sym(module, b"Everything_SetRequestFlags\0")?,
                query: sym(module, b"Everything_QueryW\0")?,
                tot_results: sym(module, b"Everything_GetTotResults\0")?,
                num_results: sym(module, b"Everything_GetNumResults\0")?,
                last_error: sym(module, b"Everything_GetLastError\0")?,
                is_db_loaded: sym(module, b"Everything_IsDBLoaded\0")?,
                major: sym(module, b"Everything_GetMajorVersion\0")?,
                minor: sym(module, b"Everything_GetMinorVersion\0")?,
                build: sym(module, b"Everything_GetBuildNumber\0")?,
                is_folder: sym(module, b"Everything_IsFolderResult\0")?,
                full_path: sym(module, b"Everything_GetResultFullPathNameW\0")?,
                result_size: sym(module, b"Everything_GetResultSize\0")?,
                result_mtime: sym(module, b"Everything_GetResultDateModified\0")?,
                result_attrs: sym(module, b"Everything_GetResultAttributes\0")?,
                lock: Mutex::new(()),
                _module: module,
            }
        };
        Ok(backend)
    }

    pub fn db_loaded(&self) -> bool {
        unsafe { (self.is_db_loaded)() != 0 }
    }

    /// 形如 `1 4 1`（major minor build），`/find where` 原样打印
    pub fn version(&self) -> String {
        let (a, b, c) = unsafe { ((self.major)(), (self.minor)(), (self.build)()) };
        format!("{a} {b} {c}")
    }

    /// 执行一次查询：返回（命中总数, 本页结果）。`sort` 为 None 时沿用 Everything 默认排序。
    pub fn search(&self, term: &str, max_results: usize, sort: Option<u32>) -> Result<(u64, Vec<Row>), String> {
        // 串行化：SDK 的搜索词与游标是全局的
        let _guard = self.lock.lock().map_err(|_| "Everything 查询锁不可用".to_string())?;
        let wide: Vec<u16> = term.encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            (self.reset)();
            if !term.is_empty() {
                (self.set_search)(wide.as_ptr());
            }
            (self.set_max)(max_results.max(1) as u32);
            if let Some(code) = sort {
                (self.set_sort)(code);
            }
            // 不设这一组，size/mtime/属性会全部是 0
            (self.set_request_flags)(
                REQ_FILE_NAME
                    | REQ_PATH
                    | REQ_SIZE
                    | REQ_ATTRIBUTES
                    | REQ_DATE_MODIFIED
                    | REQ_HIGHLIGHTED_FILE_NAME,
            );
        }

        if unsafe { (self.query)(1) == 0 } {
            return Err(format!(
                "Everything 查询失败（错误码 {}）",
                unsafe { (self.last_error)() }
            ));
        }

        let total = unsafe { (self.tot_results)() } as u64;
        let n = unsafe { (self.num_results)() };
        let mut rows = Vec::with_capacity(n as usize);
        for idx in 1..=n {
            if let Some(row) = self.read_row(idx) {
                rows.push(row);
            }
        }
        Ok((total, rows))
    }

    fn read_row(&self, idx: u32) -> Option<Row> {
        let mut buf: Vec<u16> = vec![0; 1024];
        let mut written = unsafe { (self.full_path)(idx, buf.as_mut_ptr(), buf.len() as u32) } as usize;
        if written == 0 {
            // 长度不足（路径很长）→ 问一次所需长度再取
            let need = unsafe { (self.full_path)(idx, std::ptr::null_mut(), 0) } as usize;
            if need == 0 {
                return None;
            }
            buf = vec![0; need + 2];
            written = unsafe { (self.full_path)(idx, buf.as_mut_ptr(), buf.len() as u32) } as usize;
            if written == 0 {
                return None;
            }
        }
        let end = buf.iter().position(|c| *c == 0).unwrap_or(written.min(buf.len()));
        let full = String::from_utf16_lossy(&buf[..end]);
        if full.is_empty() {
            return None;
        }

        let mut size: u64 = 0;
        let mut mtime: u64 = 0;
        let mut attrs: u32 = 0;
        unsafe {
            (self.result_size)(idx, &mut size);
            (self.result_mtime)(idx, &mut mtime);
            (self.result_attrs)(idx, &mut attrs);
        }

        let is_dir = unsafe { (self.is_folder)(idx) != 0 };
        let trimmed = full.trim_end_matches(['\\', '/']);
        Some(Row {
            name: basename(trimmed).to_string(),
            parent: parent_dir(trimmed, &full),
            path: full,
            is_dir,
            size: if is_dir { 0 } else { size as i64 },
            // FILETIME → Unix 毫秒；Everything 未给时间时是 0
            mtime_ms: if mtime == 0 {
                0
            } else {
                (mtime / 10_000) as i64 - FILETIME_TO_UNIX_MS_OFFSET
            },
            hidden: attrs & ATTR_HIDDEN != 0,
            system: attrs & ATTR_SYSTEM != 0,
        })
    }
}

fn is_sep(c: char) -> bool {
    c == '\\' || c == '/'
}

fn basename(path: &str) -> &str {
    match path.rfind(is_sep) {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// 父目录（等价于 `os.path.dirname`：根部保留分隔符，`D:` 补成 `D:\`）
fn parent_dir(trimmed: &str, full: &str) -> String {
    match trimmed.rfind(is_sep) {
        None => full.to_string(),
        Some(0) => trimmed[..1].to_string(),
        Some(i) => {
            let head = &trimmed[..i];
            if head.ends_with(':') {
                format!("{head}\\")
            } else {
                head.to_string()
            }
        }
    }
}

/// 当前动态库所在目录：`plugins/find/bin/Everything64.dll` 就挂在它下面。
///
/// 宿主不会把 plugin_dir 传进 ABI（也没这个必要），所以问 Win32 自己：
/// 用 `GetModuleHandleExW(FROM_ADDRESS)` 拿本模块句柄，再取文件名。
fn module_dir() -> Option<PathBuf> {
    const FROM_ADDRESS: u32 = 0x0000_0004;
    const UNCHANGED_REFCOUNT: u32 = 0x0000_0002;

    let mut handle: *mut c_void = std::ptr::null_mut();
    let ok = unsafe {
        GetModuleHandleExW(
            FROM_ADDRESS | UNCHANGED_REFCOUNT,
            module_dir as *const u16,
            &mut handle,
        )
    };
    if ok == 0 {
        return None;
    }
    let mut buf = vec![0u16; 32 * 1024];
    let len = unsafe { GetModuleFileNameW(handle, buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if len == 0 || len >= buf.len() {
        return None;
    }
    let path = PathBuf::from(String::from_utf16_lossy(&buf[..len]));
    path.parent().map(Path::to_path_buf)
}

/// DLL 查找顺序：插件 `bin/` > 环境变量 > 常见安装位置 > 32 位兜底
pub fn candidates_in(plugin_dir: Option<&Path>, env_dll: Option<String>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = plugin_dir {
        out.push(dir.join("bin").join("Everything64.dll"));
    }
    if let Some(env) = env_dll {
        out.push(PathBuf::from(env));
    }
    for base in [
        r"C:\Program Files\Everything",
        r"C:\Program Files (x86)\Everything",
        r"D:\Program Files\Everything",
        r"D:\softs\Everything",
    ] {
        out.push(Path::new(base).join("Everything64.dll"));
    }
    if let Some(dir) = plugin_dir {
        out.push(dir.join("bin").join("Everything32.dll"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_dll_is_the_first_candidate() {
        // 用户放在插件 bin/ 的优先级最高（便携版就靠这一份）
        let dir = Path::new(r"D:\plugins\find");
        let cands = candidates_in(Some(dir), None);
        assert_eq!(cands[0], dir.join("bin").join("Everything64.dll"));
        assert!(cands.last().unwrap().ends_with("Everything32.dll"));
    }

    #[test]
    fn env_comes_second() {
        let dir = Path::new("/p");
        let cands = candidates_in(Some(dir), Some(r"E:\tools\Everything64.dll".into()));
        assert_eq!(cands[1], Path::new(r"E:\tools\Everything64.dll"));
    }

    #[test]
    fn basename_and_parent_follow_win32_shape() {
        assert_eq!(basename(r"D:\codes\a.txt"), "a.txt");
        assert_eq!(parent_dir(r"D:\codes\a.txt", r"D:\codes\a.txt"), r"D:\codes");
        assert_eq!(parent_dir(r"D:\a.txt", r"D:\a.txt"), r"D:\");
        assert_eq!(basename(r"D:\codes"), "codes");
    }

    #[test]
    fn filetime_conversion_matches_unix_epoch() {
        // 1970-01-01T00:00:00Z == 116444736000000000（100ns）
        let filetime: i64 = 116_444_736_000_000_000;
        let unix_ms = (filetime / 10_000) - FILETIME_TO_UNIX_MS_OFFSET;
        assert_eq!(unix_ms, 0);
        // 2023-11-14T22:13:20Z
        let filetime = (1_700_000_000_000 + FILETIME_TO_UNIX_MS_OFFSET) * 10_000;
        assert_eq!((filetime / 10_000) - FILETIME_TO_UNIX_MS_OFFSET, 1_700_000_000_000);
    }
}
