// lib.rs — Tauri application entry point.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

// ── Shared HTTP client (cookie store, browser UA) ────────────────────────────

/// Persistent reqwest client shared across all `fetch_url` calls.
/// Using a single client means cookies are retained between requests,
/// so SearXNG session cookies established on the first request are
/// reused on subsequent search requests — just like a browser would.
struct HttpClient(reqwest::Client);

// ── Active download cancellation ─────────────────────────────────────────────

/// Holds a cancellation sender for each in-progress download keyed by model ID.
struct Downloads(Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>);

// ── Event payload ─────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    model_id: String,
    received_bytes: u64,
    total_bytes: u64,
    fraction: f64,
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Download a model file to the app local data directory, emitting
/// `model-download-progress` events as bytes arrive.
/// Returns the absolute path to the saved file.
#[tauri::command]
async fn download_model(
    app: AppHandle,
    downloads: State<'_, Downloads>,
    model_id: String,
    url: String,
    file_name: String,
) -> Result<String, String> {
    // Cancel any existing download for this model.
    {
        let mut map = downloads.0.lock().unwrap();
        if let Some(tx) = map.remove(&model_id) {
            let _ = tx.send(());
        }
        let (tx, _rx) = tokio::sync::oneshot::channel::<()>();
        map.insert(model_id.clone(), tx);
    }

    // Resolve destination: <appLocalDataDir>/models/<file_name>
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    let models_dir = data_dir.join("models");
    tokio::fs::create_dir_all(&models_dir)
        .await
        .map_err(|e| format!("create models dir: {e}"))?;
    let dest = models_dir.join(&file_name);

    // Already fully downloaded — return immediately.
    if dest.exists() {
        downloads.0.lock().unwrap().remove(&model_id);
        return Ok(dest.to_string_lossy().into_owned());
    }

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("fetch {url}: {e}"))?;

    if !response.status().is_success() {
        downloads.0.lock().unwrap().remove(&model_id);
        return Err(format!("HTTP {} for {url}", response.status()));
    }

    let total_bytes = response.content_length().unwrap_or(0);

    // Write to a .part file; rename on completion so a partial download is
    // never mistaken for a complete one.
    let tmp = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("create {}: {e}", tmp.display()))?;

    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut stream = response.bytes_stream();
    let mut received_bytes: u64 = 0;

    loop {
        // Check for cancellation before each chunk.
        let cancelled = { !downloads.0.lock().unwrap().contains_key(&model_id) };
        if cancelled {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err("cancelled".into());
        }

        match stream.next().await {
            None => break,
            Some(Err(e)) => {
                drop(file);
                let _ = tokio::fs::remove_file(&tmp).await;
                downloads.0.lock().unwrap().remove(&model_id);
                return Err(format!("stream error: {e}"));
            }
            Some(Ok(chunk)) => {
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("write: {e}"))?;
                received_bytes += chunk.len() as u64;
                let fraction = if total_bytes > 0 {
                    received_bytes as f64 / total_bytes as f64
                } else {
                    0.0
                };
                let _ = app.emit(
                    "model-download-progress",
                    DownloadProgress {
                        model_id: model_id.clone(),
                        received_bytes,
                        total_bytes,
                        fraction,
                    },
                );
            }
        }
    }

    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    drop(file);
    tokio::fs::rename(&tmp, &dest)
        .await
        .map_err(|e| format!("rename to {}: {e}", dest.display()))?;

    downloads.0.lock().unwrap().remove(&model_id);
    Ok(dest.to_string_lossy().into_owned())
}

/// Cancel an in-progress download.
#[tauri::command]
fn cancel_model_download(downloads: State<'_, Downloads>, model_id: String) {
    let mut map = downloads.0.lock().unwrap();
    if let Some(tx) = map.remove(&model_id) {
        let _ = tx.send(());
    }
}

/// Check whether a model file exists in the app local data dir.
/// Returns the absolute path if present, null otherwise.
#[tauri::command]
async fn get_model_path(app: AppHandle, file_name: String) -> Result<Option<String>, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    let path = data_dir.join("models").join(&file_name);
    Ok(if path.exists() { Some(path.to_string_lossy().into_owned()) } else { None })
}

/// Read and remove a JSON config import file.
/// Checks several candidate locations so it works regardless of how Tauri
/// maps app_data_dir on a given platform:
///   1. app_data_dir()/config.json          (internal storage on Android, standard on desktop)
///   2. /sdcard/Android/data/<pkg>/files/config.json  (external files dir on Android)
/// Returns the raw JSON string when found, null when absent.
#[tauri::command]
async fn read_config_import(app: AppHandle) -> Result<Option<String>, String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if let Ok(d) = app.path().app_data_dir() {
        candidates.push(d.join("config.json"));
    }

    // Android external files dir: /sdcard/Android/data/<package>/files/config.json
    // Construct from the bundle identifier so it stays correct across package renames.
    let pkg = app.config().identifier.to_string();
    candidates.push(std::path::PathBuf::from(format!(
        "/sdcard/Android/data/{pkg}/files/config.json"
    )));

    for path in &candidates {
        if path.exists() {
            let contents = tokio::fs::read_to_string(path)
                .await
                .map_err(|e| format!("read {}: {e}", path.display()))?;
            // Remove after reading so it only imports once.
            let _ = tokio::fs::remove_file(path).await;
            return Ok(Some(contents));
        }
    }
    Ok(None)
}

/// Fetch a URL server-side (bypasses WebView CORS restrictions on Android).
/// Uses the shared HTTP client with a persistent cookie store so that
/// session cookies (e.g. from SearXNG) are retained across requests.
/// Returns the response body as a UTF-8 string.
#[tauri::command]
async fn fetch_url(http: State<'_, HttpClient>, url: String) -> Result<String, String> {
    let response = http.0
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.5")
        .header("Accept-Encoding", "gzip, deflate, br")
        .send()
        .await
        .map_err(|e| format!("fetch {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} for {url}", response.status()));
    }
    response.text().await.map_err(|e| format!("read body: {e}"))
}

/// Save a base64-encoded PDF to {app_local_data_dir}/pdfs/<filename>.
/// Returns the absolute path to the saved file.
#[tauri::command]
async fn save_pdf(app: AppHandle, filename: String, data_b64: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let bytes = STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    let pdfs_dir = data_dir.join("pdfs");
    tokio::fs::create_dir_all(&pdfs_dir)
        .await
        .map_err(|e| format!("create pdfs dir: {e}"))?;
    let dest = pdfs_dir.join(&filename);
    tokio::fs::write(&dest, &bytes)
        .await
        .map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Read a file and return its contents as a base64 string.
/// Used by the PDF tools to load stored PDFs for text extraction.
#[tauri::command]
async fn read_pdf_bytes(path: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read {path}: {e}"))?;
    Ok(STANDARD.encode(&bytes))
}

/// Open a PDF file in the system viewer at the specified page (1-based).
/// On Linux tries evince then okular then xdg-open.
/// On macOS uses `open`. On Windows uses `start`.
#[tauri::command]
async fn open_pdf_page(path: String, page: u32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // evince supports --page-label (1-based page number)
        if std::process::Command::new("evince")
            .arg("--page-label")
            .arg(page.to_string())
            .arg(&path)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        // okular supports -p (1-based)
        if std::process::Command::new("okular")
            .arg("-p")
            .arg(page.to_string())
            .arg(&path)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        // Fallback: open without page support
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("xdg-open failed: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = page; // macOS open doesn't easily support page numbers
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        let _ = page;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("start failed: {e}"))?;
    }
    #[cfg(target_os = "android")]
    {
        let _ = (path, page);
        return Err("open_pdf_page not supported on Android".into());
    }
    Ok(())
}

/// Write a text file to a user-accessible location and return the path.
/// On Android: /sdcard/Android/data/<pkg>/files/<filename>  (ADB-accessible)
/// On desktop:  ~/Downloads/<filename>  (falls back to home dir)
#[tauri::command]
async fn write_export_file(app: AppHandle, filename: String, data: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    let dest = {
        let pkg = app.config().identifier.to_string();
        std::path::PathBuf::from(format!("/sdcard/Android/data/{pkg}/files/{filename}"))
    };
    #[cfg(not(target_os = "android"))]
    let dest = {
        let dir = app
            .path()
            .download_dir()
            .or_else(|_| app.path().home_dir())
            .map_err(|e| format!("cannot resolve output dir: {e}"))?;
        dir.join(&filename)
    };

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    tokio::fs::write(&dest, data.as_bytes())
        .await
        .map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Delete a cached model file from the app local data dir.
#[tauri::command]
async fn delete_model_file(app: AppHandle, file_name: String) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    let path = data_dir.join("models").join(&file_name);
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    Ok(())
}

// ── App setup ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http_client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36")
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("failed to build HTTP client");

    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_cblite::init())
        .plugin(tauri_plugin_litert::init())
        .manage(HttpClient(http_client))
        .manage(Downloads(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            download_model,
            cancel_model_download,
            get_model_path,
            delete_model_file,
            read_config_import,
            fetch_url,
            save_pdf,
            read_pdf_bytes,
            open_pdf_page,
            write_export_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
