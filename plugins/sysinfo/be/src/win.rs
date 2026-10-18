//! Windows 采集层：全部走 Win32（迁移前是 ctypes + Toolhelp32）。
//!
//! 与 Python 版本的关键差异：**本插件跑在宿主进程里**，所以"主程序"就是自己，
//! 不需要像 sidecar 那样沿 ppid 链往上爬 8 层找 `LiteLauncher.exe`。
//! 其余（父进程过滤、按名聚合、工作集统计）逐条对齐。

use crate::model::{OsVersion, Proc, Snapshot};
use std::ffi::c_void;

type Bool = i32;
type Handle = *mut c_void;

const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

#[repr(C)]
struct MemoryStatusEx {
    length: u32,
    memory_load: u32,
    total_phys: u64,
    avail_phys: u64,
    total_page_file: u64,
    avail_page_file: u64,
    total_virtual: u64,
    avail_virtual: u64,
    avail_extended_virtual: u64,
}

/// PROCESSENTRY32W（64 位下 sizeof = 568，`size` 字段必须写这个值）
#[repr(C)]
struct ProcessEntry32W {
    size: u32,
    usage: u32,
    pid: u32,
    default_heap_id: usize,
    module_id: u32,
    threads: u32,
    parent_pid: u32,
    pri_class_base: i32,
    flags: u32,
    exe_file: [u16; 260],
}

/// PROCESS_MEMORY_COUNTERS（psapi）
#[repr(C)]
struct ProcessMemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set: usize,
    working_set: usize,
    quota_peak_paged: usize,
    quota_paged: usize,
    quota_peak_nonpaged: usize,
    quota_nonpaged: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
}

#[repr(C)]
struct OsVersionInfoW {
    size: u32,
    major: u32,
    minor: u32,
    build: u32,
    platform_id: u32,
    csd_version: [u16; 128],
}

unsafe extern "system" {
    fn GetTickCount64() -> u64;
    fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> Bool;
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
    fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> Bool;
    fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> Bool;
    fn OpenProcess(access: u32, inherit: Bool, pid: u32) -> Handle;
    fn CloseHandle(handle: Handle) -> Bool;
    fn GetDiskFreeSpaceExW(
        dir: *const u16,
        free_to_caller: *mut u64,
        total: *mut u64,
        total_free: *mut u64,
    ) -> Bool;
    // kernel32 自 Win7 起导出 K32 前缀版本，省掉显式链接 psapi.lib
    #[link_name = "K32GetProcessMemoryInfo"]
    fn get_process_memory_info(handle: Handle, counters: *mut ProcessMemoryCounters, cb: u32) -> Bool;
    // ntdll 的真实版本号（GetVersionExW 在无清单进程上会谎报 6.2）
    fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
}

/// 一条进程记录（rss 为 `None` 表示打不开：权限不足或已退出）
// 形状在 model::Proc，这里只负责采集

pub fn collect() -> Snapshot {
    let os = os_version();
    let uptime_secs = unsafe { GetTickCount64() / 1000 };
    let mem = memory();
    let main_pid = std::process::id();
    let mut procs = processes();
    // 主程序与直接子进程的工作集（打不开的留 None，上层按“跳过”处理）
    fill_rss(&mut procs, main_pid);
    let disk = disk_usage(r"C:\");
    Snapshot { os, release: None, uptime_secs, mem, procs, disk, main_pid }
}

fn os_version() -> Option<OsVersion> {
    let mut info = OsVersionInfoW {
        size: std::mem::size_of::<OsVersionInfoW>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform_id: 0,
        csd_version: [0; 128],
    };
    // RtlGetVersion 返回 NTSTATUS，0 = 成功
    let status = unsafe { RtlGetVersion(&mut info) };
    if status != 0 {
        return None;
    }
    Some(OsVersion { major: info.major, minor: info.minor, build: info.build })
}

fn memory() -> Option<(u64, u64, u64)> {
    let mut st = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        memory_load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    if unsafe { GlobalMemoryStatusEx(&mut st) } == 0 {
        return None;
    }
    Some((st.total_phys, st.total_phys - st.avail_phys, st.avail_phys))
}

fn disk_usage(root: &str) -> Option<(u64, u64, u64)> {
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    let mut free_to_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut total_free: u64 = 0;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_to_caller, &mut total, &mut total_free) };
    if ok == 0 || total == 0 {
        return None;
    }
    Some((total - free_to_caller, total, free_to_caller))
}

fn rss_kb(pid: u32) -> Option<u64> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut counters = ProcessMemoryCounters {
        cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
        page_fault_count: 0,
        peak_working_set: 0,
        working_set: 0,
        quota_peak_paged: 0,
        quota_paged: 0,
        quota_peak_nonpaged: 0,
        quota_nonpaged: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
    };
    let ok = unsafe { get_process_memory_info(handle, &mut counters, counters.cb) };
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return None;
    }
    Some((counters.working_set / 1024) as u64)
}

fn processes() -> Vec<Proc> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    // INVALID_HANDLE_VALUE == -1
    if snapshot as isize == -1 {
        return Vec::new();
    }
    let mut procs = Vec::new();
    let mut entry = ProcessEntry32W {
        size: std::mem::size_of::<ProcessEntry32W>() as u32,
        usage: 0,
        pid: 0,
        default_heap_id: 0,
        module_id: 0,
        threads: 0,
        parent_pid: 0,
        pri_class_base: 0,
        flags: 0,
        exe_file: [0; 260],
    };
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        let end = entry.exe_file.iter().position(|c| *c == 0).unwrap_or(entry.exe_file.len());
        procs.push(Proc {
            pid: entry.pid,
            ppid: entry.parent_pid,
            name: String::from_utf16_lossy(&entry.exe_file[..end]),
            rss_kb: None,
        });
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    procs
}

/// 给主程序与直接子进程补工作集（打不开的进程直接跳过，与迁移前一致）
fn fill_rss(procs: &mut [Proc], main_pid: u32) {
    for proc in procs.iter_mut() {
        if proc.pid == main_pid || proc.ppid == main_pid {
            proc.rss_kb = rss_kb(proc.pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_entry_layout_matches_win32() {
        // dwSize 写错，Process32FirstW 会直接返回 FALSE（静默拿不到任何进程）
        assert_eq!(std::mem::size_of::<ProcessEntry32W>(), 568);
        assert_eq!(std::mem::size_of::<MemoryStatusEx>(), 64);
    }

    #[test]
    fn product_name_switches_on_build() {
        assert_eq!(OsVersion { major: 10, minor: 0, build: 19_045 }.product(), "Windows 10");
        assert_eq!(OsVersion { major: 10, minor: 0, build: 22_631 }.product(), "Windows 11");
        assert_eq!(OsVersion { major: 10, minor: 0, build: 22_631 }.number(), "10.0.22631");
    }
}
