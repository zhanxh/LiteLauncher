#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::Write;
use std::panic;

fn main() {
    panic::set_hook(Box::new(|info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown payload".to_string()
        };
        let msg = format!("PANIC_PAYLOAD: {}\nLOCATION: {:?}\n", payload, info.location());
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open("F:\\codes\\LiteLauncher\\panic_detail.txt")
        {
            let _ = writeln!(file, "{}", msg);
        }
    }));

    tauri_app_lib::log_lifecycle("main() started");
    tauri_app_lib::run();
    tauri_app_lib::log_lifecycle("tauri_app_lib::run() returned!");
}
