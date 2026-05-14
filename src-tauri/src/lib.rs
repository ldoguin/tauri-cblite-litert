// lib.rs — Tauri application entry point.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

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
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_cblite::init())
        .plugin(tauri_plugin_litert::init())
        .manage(Downloads(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            download_model,
            cancel_model_download,
            get_model_path,
            delete_model_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
