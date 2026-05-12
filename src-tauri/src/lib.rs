// lib.rs — Tauri application entry point.
//
// Both tauri-plugin-cblite and tauri-plugin-litert expose their full APIs
// through the TypeScript layer via Tauri's IPC invoke() mechanism.
// No additional Rust commands are needed here; the plugins handle everything.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_cblite::init())
        .plugin(tauri_plugin_litert::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
